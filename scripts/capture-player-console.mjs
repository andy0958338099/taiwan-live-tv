#!/usr/bin/env node
/**
 * capture-player-console.mjs — 擷取播放器在瀏覽器裡的 console 訊息與 hls.js 事件
 *
 * ## 為什麼需要
 *
 * 量測發現「停播來源」的行為不一致：
 *   · 龍華 → 完全沒起來（rs=0、paused=true、currentTime=0）
 *   · 部分頻道 → 會把舊內容播完，然後卡住
 *
 * 要分辨是哪一種，必須看瀏覽器實際發生了什麼（hls.js 的 ERROR 事件明細）。
 * 這是「用實際執行結果佐證」而不是「憑印象猜」。
 *
 * 用法：node scripts/capture-player-console.mjs [--ids a,b] [--base https://...] [--seconds 90]
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const BASE = arg('base', 'https://taiwan-live-tv.netlify.app');
const IDS = arg('ids', 'playlist-龍華-龍華電視,playlist-Now-now-tv,tw-goodtv-ch1').split(',').filter(Boolean);
const SECONDS = Number(arg('seconds', '90'));
const PORT = 9335;
const PROFILE = '/Users/andy/.hermes/cache/scratch/chrome-console-profile';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('═'.repeat(74));
  console.log('擷取播放器 console 訊息');
  console.log('═'.repeat(74));

  const cat = await (await fetch(`${BASE}/channels.json`)).json();
  const targets = IDS.map((id) => cat.channels.find((c) => c.channel_id === id)).filter(Boolean);

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
  const ws = new WS(wsUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });

  let msgId = 0;
  const pending = new Map();
  const logs = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args ?? [])
        .map((a) => a.value ?? a.description ?? a.unserializableValue ?? '')
        .join(' ');
      logs.push({ kind: m.params.type, text });
    } else if (m.method === 'Log.entryAdded') {
      logs.push({ kind: 'log:' + m.params.entry.level, text: m.params.entry.text });
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
  await s('Log.enable');

  const results = [];

  for (const ch of targets) {
    logs.length = 0;
    console.log(`▶ ${ch.channel_name} (${ch.channel_id})`);
    await s('Page.navigate', { url: `${BASE}/` });
    await sleep(3000);

    // 打開抽屜（真實滑鼠事件）
    const h = await s('Runtime.evaluate', {
      expression: `(() => {
        const b = document.querySelector('button[aria-label="選擇頻道"]');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width/2, y: r.top + r.height/2 };
      })()`,
      returnByValue: true,
    });
    if (!h.result.value) {
      console.log('  ✗ 找不到把手');
      continue;
    }
    for (const type of ['mousePressed', 'mouseReleased']) {
      await s('Input.dispatchMouseEvent', {
        type, x: h.result.value.x, y: h.result.value.y, button: 'left', clickCount: 1,
      });
    }
    await sleep(900);

    const p = await s('Runtime.evaluate', {
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
    if (!p.result.value) {
      console.log(`  ✗ 找不到「${ch.channel_name}」`);
      continue;
    }
    for (const type of ['mousePressed', 'mouseReleased']) {
      await s('Input.dispatchMouseEvent', {
        type, x: p.result.value.x, y: p.result.value.y, button: 'left', clickCount: 1,
      });
    }

    console.log(`  觀察 ${SECONDS} 秒…`);
    await sleep(SECONDS * 1000);

    const stat = await s('Runtime.evaluate', {
      expression: `(() => {
        const v = document.querySelector('video');
        const el = document.querySelector('[role="alert"], .error, .errorMessage');
        return {
          t: v ? v.currentTime : null,
          rs: v ? v.readyState : null,
          paused: v ? v.paused : null,
          w: v ? v.videoWidth : null,
          h: v ? v.videoHeight : null,
          err: v && v.error ? v.error.code : null,
          pageError: el ? el.textContent.trim().slice(0, 200) : null,
        };
      })()`,
      returnByValue: true,
    });

    console.log(`  狀態：${JSON.stringify(stat.result.value)}`);
    const interesting = logs.filter(
      (l) => /播放器|hls\.js|error|ERROR|fail|timeout|stall|buffer/i.test(l.text),
    );
    console.log(`  關鍵 console（${interesting.length} 筆）：`);
    for (const l of interesting.slice(-25)) console.log(`    [${l.kind}] ${l.text.slice(0, 190)}`);
    console.log('');

    results.push({
      id: ch.channel_id,
      name: ch.channel_name,
      stat: stat.result.value,
      logs: interesting.map((l) => `[${l.kind}] ${l.text}`),
    });

    await s('Runtime.evaluate', {
      expression: `(() => { const v=document.querySelector('video'); if(v){v.pause(); v.src='';} })()`,
    });
    await sleep(500);
  }

  writeFileSync(
    '/Users/andy/.hermes/cache/scratch/player-console.json',
    JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 2),
  );
  console.log('已寫入 /Users/andy/.hermes/cache/scratch/player-console.json');
  try { ws.close(); } catch {}
  try { process.kill(-chrome.pid); } catch {}
}

main();
