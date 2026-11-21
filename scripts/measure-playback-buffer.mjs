import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 實測播放時的緩衝累積量與卡頓次數。
 *
 * 這是「緩衝做大有沒有用」的唯一可信驗證方式 ——
 * 直接從 <video> 元素的 buffered 範圍讀出實際緩衝秒數。
 */
const BASE = process.argv[2] || 'http://localhost:3211';
const CHANNEL = process.argv[3] || '龍華電視';
const WATCH_SECONDS = Number(process.argv[4] || 75);

const profile = mkdtempSync(join(tmpdir(), 'buf-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--remote-debugging-port=9453', `--user-data-dir=${profile}`,
  '--no-first-run', '--headless=new', '--disable-gpu',
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: 'ignore' });

const { WebSocket } = await import('ws');
let targets = null;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try { const r = await fetch('http://127.0.0.1:9453/json'); if (r.ok) { targets = await r.json(); break; } } catch {}
}
if (!targets) { console.log('Chrome 沒起來'); process.exit(1); }

const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((r) => ws.once('open', r));
let id = 0; const pend = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id;
  pend.set(mid, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.value;

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: BASE });
await sleep(2500);

// 開抽屜並選頻道
await evaluate(`document.querySelector('button[aria-label="選擇頻道"]')?.click()`);
await sleep(1200);
const clicked = await evaluate(`(() => {
  // ⭐ 用 data-channel-name，不要用 [class*="drawerCardName"]。
  // CSS module 改名後子字串選擇器會匹配不到（見 test-embed-channels.mjs 的說明）。
  const btns = [...document.querySelectorAll('button[data-channel-name]')];
  const hit = btns.find(b => b.getAttribute('data-channel-name') === ${JSON.stringify(CHANNEL)});
  if (!hit) return 'not-found';
  hit.click();
  return 'clicked';
})()`);
console.log(`選台 ${CHANNEL}: ${clicked}`);

// 安裝觀測器：記錄 waiting/playing 事件與緩衝量
await evaluate(`(() => {
  window.__buf = { waits: 0, plays: 0, samples: [], lastCT: -1, stallPeriods: [] };
  const v = document.querySelector('video');
  if (!v) return 'no-video';
  v.addEventListener('waiting', () => { window.__buf.waits++; window.__buf.stallStart = performance.now(); });
  v.addEventListener('playing', () => {
    window.__buf.plays++;
    if (window.__buf.stallStart) {
      window.__buf.stallPeriods.push(Math.round(performance.now() - window.__buf.stallStart));
      window.__buf.stallStart = null;
    }
  });
  return 'ok';
})()`);

// 等待播放開始
console.log(`觀察 ${WATCH_SECONDS} 秒…`);
const samples = [];
const t0 = Date.now();
while (Date.now() - t0 < WATCH_SECONDS * 1000) {
  await sleep(5000);
  const s = await evaluate(`(() => {
    const v = document.querySelector('video');
    if (!v) return null;
    const b = v.buffered;
    let ahead = 0;
    for (let i = 0; i < b.length; i++) {
      if (v.currentTime >= b.start(i) - 1 && v.currentTime <= b.end(i)) {
        ahead = b.end(i) - v.currentTime;
      }
    }
    return {
      t: Math.round((performance.now())/1000),
      ct: +v.currentTime.toFixed(1),
      ahead: +ahead.toFixed(1),
      readyState: v.readyState,
      paused: v.paused,
      w: window.__buf ? window.__buf.waits : -1,
      p: window.__buf ? window.__buf.plays : -1,
    };
  })()`);
  if (s) {
    samples.push(s);
    console.log(
      `  t=${String(Math.round((Date.now()-t0)/1000)).padStart(3)}s  ` +
      `currentTime=${String(s.ct).padStart(7)}  緩衝 ahead=${String(s.ahead).padStart(6)}s  ` +
      `readyState=${s.readyState}  卡頓=${s.w}  恢復=${s.p}`,
    );
  }
}

const final = await evaluate(`(() => {
  const v = document.querySelector('video');
  return {
    waits: window.__buf.waits,
    plays: window.__buf.plays,
    stallPeriods: window.__buf.stallPeriods,
    maxAhead: Math.max(...${JSON.stringify(samples.map(s => s.ahead))}),
  };
})()`);

console.log('\n════ 結果 ════');
console.log(`  卡頓（waiting）次數: ${final.waits}`);
console.log(`  恢復（playing）次數: ${final.plays}`);
console.log(`  最大緩衝 ahead: ${final.maxAhead.toFixed(1)} 秒`);
if (final.stallPeriods.length) {
  console.log(`  各次卡頓持續: ${final.stallPeriods.join(', ')} ms`);
}

chrome.kill('SIGKILL');
try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
