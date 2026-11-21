#!/usr/bin/env node
/**
 * capture-ui.mjs —— 產生 1440 與 390 寬度的介面截圖。
 *
 * 兩種寬度各拍三張：
 *   · closed —— 抽屜收起的觀看畫面
 *   · half  —— 抽屜半屏（預設 45vh）
 *   · full  —— 抽屜全屏
 *
 * 用法：node scripts/capture-ui.mjs [--base http://localhost:3211] [--out <dir>]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : dflt;
};

const BASE = arg('base', 'http://localhost:3211');
const OUT = arg('out', '/Users/andy/.hermes/cache/scratch');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9361;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SIZES = [
  { name: '1440', width: 1440, height: 900, mobile: false },
  { name: '390', width: 390, height: 844, mobile: true },
];

const profile = mkdtempSync(join(tmpdir(), 'capture-ui-'));
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--headless=new',
    '--disable-gpu',
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
      pending.set(mid, (m) =>
        m.error ? reject(new Error(m.error.message)) : resolve(m.result),
      );
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) return { error: r.exceptionDetails.text };
    return { value: r.result?.value };
  };
  return { send, evalJs };
}

async function shot(cdp, file) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

const cdp = await connect();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
mkdirSync(OUT, { recursive: true });

console.log('════ 介面截圖 ════\n');

for (const size of SIZES) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: size.width,
    height: size.height,
    deviceScaleFactor: 1,
    mobile: size.mobile,
  });
  await cdp.send('Page.navigate', { url: `${BASE}/?t=${Date.now()}` });

  /**
   * 等頁面**真的**載入完成再截圖。
   *
   * ⚠️ 固定 sleep 不可靠 —— 頻道資料是 client-side fetch，
   * 慢一點就會拍到「載入中…」的空白畫面（實測拍到 6 張全空白）。
   *
   * 判斷依據：頁首的「頻道 ▾」按鈕出現 = 資料已載入、React 已 render。
   */
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const r = await cdp.evalJs(`(() => {
      const btn = document.querySelector('header button[aria-label="選擇頻道"]');
      const loading = document.body.innerText.includes('載入中');
      return JSON.stringify({ ok: !!btn && !loading });
    })()`);
    if (r.value && String(r.value).includes('"ok":true')) {
      ready = true;
      break;
    }
  }
  if (!ready) console.log(`  ⚠️ ${size.name} 寬度：頁面未在時限內就緒，仍繼續截圖`);
  await sleep(600);

  // ── 1. 抽屜收起 ──
  const closed = await shot(cdp, join(OUT, `ui-${size.name}-closed.png`));
  console.log(`  ✓ ${closed}`);

  // ── 2. 半屏 ──
  await cdp.evalJs(`(() => {
    const b = document.querySelector('header button[aria-label="選擇頻道"]');
    if (b) b.click();
  })()`);
  await sleep(900);
  const half = await shot(cdp, join(OUT, `ui-${size.name}-half.png`));
  console.log(`  ✓ ${half}`);

  // ── 3. 全屏（把把手往上拖）──
  //
  // ⚠️ 必須用 CDP 的真實滑鼠事件（Input.dispatchMouseEvent）。
  // 用 `new PointerEvent()` 合成事件不行 —— React 的 pointer handler
  // 依賴真實的 pointer capture 與座標，合成事件不會觸發拖曳邏輯
  // （實測：合成事件拖了 400px，抽屜高度完全不變）。
  const gripBox = await cdp.evalJs(`(() => {
    const g = document.querySelector('button[aria-label="調整抽屜高度"]');
    if (!g) return null;
    const r = g.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (gripBox.value) {
    const gx = gripBox.value.x;
    const gy = gripBox.value.y;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: gx, y: gy,
    });
    await sleep(60);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: gx, y: gy, button: 'left', clickCount: 1,
    });
    // 往上拖 40 步，每步 22px（總計 440px，足以從 45vh 拉到 88vh）
    for (let i = 1; i <= 20; i++) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: gx, y: Math.max(8, gy - i * 22),
        button: 'left', buttons: 1,
      });
      await sleep(25);
    }
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: gx, y: Math.max(8, gy - 440),
      button: 'left', clickCount: 1,
    });
    await sleep(800);
  }
  const full = await shot(cdp, join(OUT, `ui-${size.name}-full.png`));
  console.log(`  ✓ ${full}`);

  // 順便記錄狀態
  const state = await cdp.evalJs(`(() => {
    const a = document.querySelector('aside[aria-label="頻道選擇"]');
    const v = document.querySelector('video');
    if (!a || !v) return 'no-elements';
    const vr = v.getBoundingClientRect();
    const ar = a.getBoundingClientRect();
    return JSON.stringify({
      drawerPct: Math.round(ar.height / innerHeight * 100),
      videoVisible: vr.bottom <= ar.top + 1,
      videoSize: Math.round(vr.width) + 'x' + Math.round(vr.height),
    });
  })()`);
  console.log(`     全屏狀態：${state.value}`);
}

console.log('\n完成');
process.exit(0);
