#!/usr/bin/env node
/**
 * test-sustained-playback.mjs — 量測「播放中 currentTime 是否持續前進」
 *
 * ## 為什麼需要這個測試
 *
 * `test-playback-local.mjs` 的判定條件是 `currentTime > 0.5 && !paused`。
 * 這對**停播來源**是**假通過**：
 *
 *   來源的 live playlist 停在某個序號不動（編碼器停擺）
 *   → 清單裡那幾段舊 segment 還下載得到
 *   → 播放器把舊內容播完，看起來「播放成功」
 *   → 緩衝耗盡後 currentTime 停在原地，或畫面凍結
 *
 * 實測（2026-11-22）：龍華電視 / Now TV 的序號 100 秒完全不動，
 * 但 `test-playback-local.mjs` 回報 currentTime=34.3「播放成功」。
 *
 * 本腳本改成**持續觀察**：每 N 秒取樣 currentTime，
 * 判定「有沒有持續前進」以及「有沒有卡在原地」。
 *
 * 用法：node scripts/test-sustained-playback.mjs [--ids a,b] [--base https://...] [--duration 120] [--interval 6]
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const BASE = arg('base', 'https://taiwan-live-tv.netlify.app');
const IDS = arg('ids', '').split(',').filter(Boolean);
const DURATION_MS = Number(arg('duration', '120')) * 1000;
const INTERVAL_MS = Number(arg('interval', '6')) * 1000;
const PORT = 9334;
const PROFILE = '/Users/andy/.hermes/cache/scratch/chrome-sustained-profile';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('═'.repeat(74));
  console.log('持續播放實測（currentTime 是否持續前進）');
  console.log('═'.repeat(74));
  console.log(`站點：${BASE}　觀察：${DURATION_MS / 1000}s　間隔：${INTERVAL_MS / 1000}s\n`);

  const cat = await (await fetch(`${BASE}/channels.json`)).json();
  const DEFAULT_IDS = [
    'playlist-龍華-龍華電視',
    'playlist-Now-now-tv',
    'tw-goodtv-ch1',
    'iptvorg-dalitv-tw-sd',
  ];
  const ids = IDS.length ? IDS : DEFAULT_IDS;
  const targets = ids
    .map((id) => cat.channels.find((c) => c.channel_id === id))
    .filter(Boolean);

  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });

  const chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1600,1000',
      'about:blank',
    ],
    { detached: true, stdio: 'ignore' },
  );

  let wsUrl = null;
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      wsUrl = (await r.json()).webSocketDebuggerUrl;
      break;
    } catch {
      await sleep(500);
    }
  }
  if (!wsUrl) {
    console.error('✗ Chrome 無法啟動');
    process.exit(1);
  }
  console.log('✓ Chrome 已啟動\n');

  const { default: WS } = await import('ws').catch(() => ({ default: null }));
  if (!WS) {
    console.error('✗ 需要 ws 套件');
    process.exit(1);
  }

  const ws = new WS(wsUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });

  let msgId = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (method, params) => send(method, params, sessionId);
  await s('Page.enable');
  await s('Runtime.enable');

  const results = [];

  for (const ch of targets) {
    console.log(`▶ ${ch.channel_name} (${ch.channel_id})`);
    await s('Page.navigate', { url: `${BASE}/` });
    await sleep(3000);

    // 打開抽屜並選頻道（用真實滑鼠事件，才能取得使用者啟動權限）
    const opened = await s('Runtime.evaluate', {
      expression: `(() => {
        const h = document.querySelector('button[aria-label="選擇頻道"]');
        if (!h) return 'no-handle';
        const r = h.getBoundingClientRect();
        return { x: r.left + r.width/2, y: r.top + r.height/2 };
      })()`,
      returnByValue: true,
    });
    const o = opened.result.value;
    if (typeof o !== 'object') {
      console.log('  ✗ 找不到把手');
      continue;
    }
    await s('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: o.x, y: o.y, button: 'left', clickCount: 1,
    });
    await s('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: o.x, y: o.y, button: 'left', clickCount: 1,
    });
    await sleep(900);

    const pos = await s('Runtime.evaluate', {
      expression: `(() => {
        const want = ${JSON.stringify(ch.channel_name)};
        const b = [...document.querySelectorAll('button[data-channel-name]')]
          .find(x => x.getAttribute('data-channel-name') === want);
        if (!b) return null;
        b.scrollIntoView();
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width/2, y: r.top + r.height/2 };
      })()`,
      returnByValue: true,
    });
    if (!pos.result.value) {
      console.log(`  ✗ 找不到頻道卡片「${ch.channel_name}」`);
      results.push({ id: ch.channel_id, name: ch.channel_name, verdict: 'no-card' });
      continue;
    }
    const p = pos.result.value;
    await s('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1,
    });
    await s('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1,
    });

    const samples = [];
    const start = Date.now();
    while (Date.now() - start < DURATION_MS) {
      await sleep(INTERVAL_MS);
      const r = await s('Runtime.evaluate', {
        expression: `(() => {
          const v = document.querySelector('video');
          if (!v) return { found: false };
          const b = v.buffered;
          let ahead = 0;
          for (let i = 0; i < b.length; i++) {
            if (v.currentTime >= b.start(i) - 0.5 && v.currentTime <= b.end(i)) {
              ahead = b.end(i) - v.currentTime;
            }
          }
          return {
            found: true,
            t: v.currentTime,
            rs: v.readyState,
            paused: v.paused,
            muted: v.muted,
            w: v.videoWidth,
            h: v.videoHeight,
            ahead: Math.round(ahead * 10) / 10,
            err: v.error ? v.error.code : null,
          };
        })()`,
        returnByValue: true,
      });
      const v = r.result.value;
      samples.push(v);
      console.log(
        `   t=${v.t?.toFixed?.(1) ?? '—'} ahead=${v.ahead ?? '—'}s ` +
          `rs=${v.rs} paused=${v.paused} ${v.w}x${v.h} muted=${v.muted}` +
          (v.err ? ` err=${v.err}` : ''),
      );
    }

    const errText = await s('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector('[role="alert"], .error, .errorMessage');
        return el ? el.textContent.trim().slice(0, 200) : null;
      })()`,
      returnByValue: true,
    });

    const times = samples.map((x) => x.t).filter((t) => typeof t === 'number');
    const first = times[0] ?? 0;
    const last = times[times.length - 1] ?? 0;
    const advanced = last - first;
    // 卡住：連續 3 次取樣 currentTime 幾乎沒動
    let stuck = 0;
    for (let i = 1; i < times.length; i += 1) {
      if (times[i] - times[i - 1] < 0.5) stuck += 1;
      else stuck = 0;
    }

    let verdict;
    if (!times.length) verdict = '✗ 找不到 video 元素';
    else if (advanced < DURATION_MS / 1000 * 0.4) {
      verdict = '✗ 停滯（currentTime 沒有持續前進）→ 來源停播';
    } else if (stuck >= 3) verdict = '✗ 中途卡住（連續 3 次取樣 currentTime 不動）';
    else verdict = `✓ 持續前進（${first.toFixed(1)}s → ${last.toFixed(1)}s）`;

    console.log(`   判定：${verdict}`);
    if (errText.result.value) console.log(`   頁面錯誤訊息：${errText.result.value}`);
    console.log('');

    results.push({
      id: ch.channel_id,
      name: ch.channel_name,
      verdict,
      advanced,
      samples: samples.length,
      error_text: errText.result.value,
    });

    await s('Runtime.evaluate', {
      expression: `(() => { const v=document.querySelector('video'); if(v){v.pause(); v.src='';} })()`,
    });
    await sleep(800);
  }

  console.log('═'.repeat(74));
  console.log('總結');
  console.log('═'.repeat(74));
  for (const r of results) console.log(`  ${r.verdict.startsWith('✓') ? '✓' : '✗'} ${r.name.padEnd(18)} ${r.verdict}`);
  writeFileSync(
    '/Users/andy/.hermes/cache/scratch/sustained-playback.json',
    JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 2),
  );
  console.log('');
  const bad = results.filter((r) => !r.verdict.startsWith('✓'));
  console.log(bad.length === 0 ? '結果：✓ 全部持續前進' : `結果：✗ ${bad.length}/${results.length} 個頻道停滯`);
  try { ws.close(); } catch {}
  try { process.kill(-chrome.pid); } catch {}
  process.exit(bad.length === 0 ? 0 : 1);
}

main();
