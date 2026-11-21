#!/usr/bin/env node
/**
 * test-channel-switch-unmute.mjs — 驗證「頻道更換後立即解除靜音」
 *
 * 為什麼需要這個測試：
 *   「切換頻道後是否有聲」是個**手勢時序**問題，
 *   單看程式碼看不出來 —— useEffect 在 paint 之後才跑，
 *   Chrome 的使用者手勢屆時可能已失效。
 *   必須用真實的滑鼠點擊（CDP Input.dispatchMouseEvent）
 *   才能驗證到手勢是否落在正確的時間窗內。
 *
 * 測試流程：
 *   1. 開啟頁面，等頻道清單載入
 *   2. 用真實滑鼠點擊第 1 個頻道 → 等播放 → 記錄 muted
 *   3. 用真實滑鼠點擊第 2 個頻道 → **在 playing 事件之前**就取樣 muted
 *      （這是關鍵：若程式是「等 playing 才解除靜音」，
 *        這裡就會捕捉到 muted=true）
 *   4. 判定：切換後應立即 muted=false
 *
 * 用法：node scripts/test-channel-switch-unmute.mjs [--base http://localhost:3211]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE =
  (() => {
    const i = process.argv.indexOf('--base');
    return i >= 0 ? process.argv[i + 1] : 'http://localhost:3211';
  })() ?? 'http://localhost:3211';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
const WAIT_MS = parseInt(process.env.WAIT_MS ?? '20000', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 啟動 Chrome（獨立 profile，含 --autoplay-policy 與無手勢旗標）──
const profile = mkdtempSync(join(tmpdir(), 'unmute-test-'));
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--headless=new',
    '--disable-gpu',
    // ⚠️ **刻意不設** `--autoplay-policy=no-user-gesture-required`。
    //   本測試要驗證的正是「Chrome 真實的自動播放政策」下，
    //   頻道切換後能否立即有聲。
    //   若設了這個旗標，政策會被完全放棄，測試就毫無意義。
    'about:blank',
  ],
  { stdio: 'ignore' },
);

process.on('exit', () => {
  try {
    chrome.kill('SIGKILL');
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function fetchJson(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {
      /* retry */
    }
    await sleep(300);
  }
  throw new Error(`無法連到 ${url}`);
}

/** 極簡 CDP 用戶端 */
async function connect() {
  const targets = await fetchJson(`http://127.0.0.1:${PORT}/json`);
  const page = targets.find((t) => t.type === 'page');
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl, {
    maxPayload: 256 * 1024 * 1024,
  });
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) return { error: r.exceptionDetails.text };
    return { value: r.result?.value };
  };
  return { send, evalJs, ws };
}

async function main() {
  console.log('═'.repeat(66));
  console.log('驗證：頻道更換後立即解除靜音');
  console.log('═'.repeat(66));
  console.log(`測試站點：${BASE}\n`);

  const cdp = await connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  await cdp.send('Page.navigate', { url: `${BASE}/?t=${Date.now()}` });

  // 等待頻道清單渲染完成（Next.js 需 hydration + 資料載入）
  let ready = { value: null };
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    ready = await cdp.evalJs(`(() => {
      const btns = [...document.querySelectorAll('button[data-channel-name]')];
      return { total: btns.length, channelButtons: btns.length,
               loading: document.body.innerText.includes('載入中') };
    })()`);
    if (ready.value?.channelButtons) break;
  }
  console.log(`頁面載入：按鈕 ${ready.value?.total ?? '?'} 個，頻道按鈕 ${ready.value?.channelButtons ?? '?'} 個`);

  if (!ready.value?.channelButtons) {
    console.log('✗ 找不到頻道按鈕');
    process.exit(1);
  }

  /**
   * 點擊第 n 個頻道按鈕（**真實滑鼠事件**）。
   *
   * 為什麼不能用 `element.click()`：
   *   Chrome 的 `HTMLElement.click()` **不會授予使用者啟動權限**
   *   （user activation），所以自動播放政策會把它當成「沒有手勢」。
   *   只有真實的輸入事件（Input.dispatchMouseEvent）才會授予。
   *   這個差異正是本測試要驗證的東西，所以必須用真實滑鼠事件。
   */
  async function clickChannel(index) {
    const box = await cdp.evalJs(`(() => {
      // ⭐ 用 data-channel-name，不要用 [class*="cardName"]。
      // CSS module 改名後子字串選擇器會匹配不到（見 test-embed-channels.mjs 的說明）。
      const btns = [...document.querySelectorAll('button[data-channel-name]')];
      const b = btns[${index}];
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2,
               name: (b.getAttribute('data-channel-name')||'').trim().slice(0,20) };
    })()`);
    if (!box.value) return null;
    await sleep(200); // 等 scrollIntoView 生效
    const { x, y } = box.value;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(60);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1,
    });
    await sleep(50);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
    });
    return box.value.name;
  }

  /** 讀取影片狀態 */
  const readState = () =>
    cdp.evalJs(`(() => {
      const v = document.querySelector('video');
      if (!v) return { none: true };
      return {
        muted: v.muted, paused: v.paused, t: v.currentTime,
        readyState: v.readyState, w: v.videoWidth, h: v.videoHeight,
      };
    })()`);

  // ── 步驟 1：點第一個頻道 ──
  console.log('\n[1] 點擊第 1 個頻道');
  const name1 = await clickChannel(0);
  console.log(`    頻道：${name1}`);
  await sleep(1200);
  const early1 = await readState();
  console.log(`    點擊後 1.2 秒：muted=${early1.value?.muted} paused=${early1.value?.paused} t=${(early1.value?.t ?? 0).toFixed(1)}`);

  // ── 步驟 2：切換到第二個頻道，在 playing 之前取樣 ──
  console.log('\n[2] 點擊第 2 個頻道（切換）');
  const name2 = await clickChannel(1);
  console.log(`    頻道：${name2}`);

  // 密集取樣：捕捉「切換後、playing 之前」的 muted 狀態
  const samples = [];
  for (let i = 0; i < 14; i++) {
    await sleep(400);
    const s = await readState();
    if (!s.value?.none) {
      samples.push({
        at: (i + 1) * 0.4,
        muted: s.value.muted,
        paused: s.value.paused,
        t: Number(s.value.t?.toFixed(1) ?? 0),
        rs: s.value.readyState,
      });
    }
  }

  console.log('\n    切換後的時間序列（muted / paused / currentTime）：');
  for (const s of samples) {
    console.log(
      `      ${String(s.at).padStart(4)}s  muted=${String(s.muted).padEnd(5)} paused=${String(s.paused).padEnd(5)} t=${s.t}`,
    );
  }

  const everMutedAfterSwitch = samples.some((s) => s.muted);
  const unmutedAt = samples.find((s) => !s.muted);

  console.log('\n判定：');
  if (unmutedAt) {
    console.log(`  ✓ 切換後 ${unmutedAt.at} 秒內即為有聲（muted=false）`);
  } else {
    console.log('  ✗ 切換後從未變成有聲');
  }
  if (everMutedAfterSwitch) {
    console.log('  ✗ 切換後曾出現 muted=true —— 未立即解除靜音');
  } else {
    console.log('  ✓ 切換後沒有任何一瞬間是靜音');
  }

  const final = await readState();
  console.log(
    `\n最終狀態：muted=${final.value?.muted} paused=${final.value?.paused} t=${(final.value?.t ?? 0).toFixed(1)} ${final.value?.w}x${final.value?.h}`,
  );

  const pass = !!unmutedAt && !everMutedAfterSwitch;
  console.log(`\n結果：${pass ? '✓ 通過' : '✗ 未通過'}`);

  writeFileSync(
    join(tmpdir(), 'unmute-result.json'),
    JSON.stringify({ pass, samples, name1, name2 }, null, 2),
  );
  process.exit(pass ? 0 : 1);
}

try {
  await main();
} catch (e) {
  console.error('測試失敗：', e.message);
  process.exit(1);
}
