#!/usr/bin/env node
/**
 * verify-channel-visually.mjs — 用真實瀏覽器播放候選頻道並截圖，**目視確認頻道身分**
 *
 * ## 為什麼需要這一步
 *
 * 專案規則：備援來源必須是「同一個頻道」。
 * 但很多來源在不同命名空間裡用不同代碼（例如 `163189/fhhk` vs `120.198.95.220:9901/1036_1`），
 * **無法只靠代碼判定是不是同一個台**。
 *
 * 唯一可靠的驗證方式是**播出來看台標**。
 * 這支腳本會：
 *   1. 在本機 HTTP 頁面（避免混合內容）用 hls.js 播來源
 *   2. 等到真的有畫面（videoWidth > 0 且 currentTime 前進）
 *   3. 截圖 video 元素 → 存成 PNG
 *   4. 印出結果，讓人（或 vision model）目視比對台標
 *
 * 用法：node scripts/verify-channel-visually.mjs [--out <dir>]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const OUT_DIR = arg('out', '/Users/andy/.hermes/cache/scratch/channel-verify');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9381;
const PAGE_PORT = 9382;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 待目視驗證的候選。
 *
 * `expect` 是我們預期的頻道名；`why` 說明為什麼需要目視確認
 * （例如：不同命名空間的代碼無法直接判定同一性）。
 */
const ONLY = (arg('only', '') || '').split(',').filter(Boolean);
const TARGETS = [
  {
    id: 'fhzw-rjdshipin-yDoTN',
    expect: '鳳凰衛視中文台 / 香港台',
    why: 'Guovin 清單標「凤凰香港」，URL 代碼 fhhk 與現有 fhzw 不同（不同命名空間）',
    url: 'http://r.jdshipin.com/yDoTN',
  },
  {
    id: 'fhzw-epg-pw-5f16',
    expect: '鳳凰衛視中文台 / 香港台',
    why: 'epg.pw 雜湊網址，清單標「凤凰香港」',
    url: 'https://epg.pw/stream/5f16dc7fc8aaaed3205516c63e4a8c24bca9dbba1181684244729cf574505b0e.m3u8',
  },
  {
    id: 'fhzw-rjdshipin-NfC0f',
    expect: '鳳凰衛視中文台 / 香港台',
    why: 'jdshipin 的第二個代碼',
    url: 'http://r.jdshipin.com/NfC0f',
  },
  {
    id: 'fhzx-rjdshipin-0Rp07',
    expect: '鳳凰衛視資訊台',
    why: 'URL 代碼 fhzx 與現有頻道相同，但仍需確認畫面',
    url: 'http://r.jdshipin.com/0Rp07',
  },
  {
    id: 'wl-sports-epg-pw-8855',
    expect: '緯來體育',
    why: 'epg.pw 雜湊網址，清單標「纬来体育」',
    url: 'https://epg.pw/stream/8855a9936e37e608a0ec8a014cce1673dee9c5d68d560da376cc92e5edef2b25.m3u8',
  },
  {
    id: 'wl-sports-epg-pw-ab6d',
    expect: '緯來體育',
    why: 'epg.pw 雜湊網址（第二個來源）',
    url: 'https://epg.pw/stream/ab6df63b64d0cc44a1f4f029ed847a26fa54a7aebd455578fb05a63f02c22f4b.m3u8',
  },
  {
    id: 'etv-super-38.64.72.148',
    expect: '東森超視',
    why: '清單代碼 2013，tvg-id「东森超视」',
    url: 'http://38.64.72.148:80/hls/modn/list/2013/chunklist1.m3u8',
  },
  {
    id: 'hlj-kids-qingting',
    expect: '黑龍江少兒',
    why: 'ls.qingting.fm 純數字頻道 ID，無名稱線索',
    url: 'https://ls.qingting.fm/live/4972/64k.m3u8',
  },
  {
    id: 'hlj-news-qingting',
    expect: '黑龍江新聞',
    why: 'ls.qingting.fm 純數字頻道 ID，無名稱線索',
    url: 'https://ls.qingting.fm/live/4974/64k.m3u8',
  },
  {
    id: 'cctv-billiards',
    expect: '央視台球',
    why: 'txiptv 代碼 ystq（央視台球）',
    url: 'http://107.150.60.122/live/ystq.m3u8',
  },
  {
    id: 'gzzh-tencentplay',
    expect: '廣州綜合台',
    why: '廣州電視台官方 tencentplay.gztv.com',
    url: 'https://tencentplaybusiness.gztv.com/live/zonghes.m3u8',
  },
  {
    id: 'hb-hebtv-official',
    expect: '河北衛視',
    why: '河北衛視官方 event.pull.hebtv.com',
    url: 'https://event.pull.hebtv.com/live/live101.m3u8',
  },
  {
    id: 'nm-nmtv-official',
    expect: '內蒙古衛視',
    why: '內蒙古衛視官方 play1-qk.nmtv.cn',
    url: 'http://play1-qk.nmtv.cn/live/1769652018126032.m3u8',
  },
];

// ── 本機頁面（http，避免 mixed content）──
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>verify</title>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.7.4/dist/hls.min.js"></script>
<style>body{margin:0;background:#000}video{width:960px;height:540px;display:block}</style>
</head><body><video id="v" muted autoplay playsinline></video>
<script>
window.__state = { status:'init', error:null, t:0, w:0, h:0 };
const v = document.getElementById('v');
const url = new URLSearchParams(location.search).get('u');
function fail(e){ window.__state.status='error'; window.__state.error=String(e && e.message || e); }
v.addEventListener('error', ()=> fail(v.error));
if (!url) { fail('no url'); }
else if (v.canPlayType('application/vnd.apple.mpegurl')) {
  v.src = url; v.play().catch(fail);
} else if (window.Hls && Hls.isSupported()) {
  const hls = new Hls({ enableWorker:true, lowLatencyMode:false });
  hls.loadSource(url); hls.attachMedia(v);
  hls.on(Hls.Events.MANIFEST_PARSED, ()=> v.play().catch(()=>{}));
  hls.on(Hls.Events.ERROR, (e,d)=>{ if (d && d.fatal) fail(d.details); });
} else { fail('no engine'); }
setInterval(()=>{ window.__state.t=v.currentTime; window.__state.w=v.videoWidth; window.__state.h=v.videoHeight;
  if (v.currentTime>0.5 && v.videoWidth>0) window.__state.status='playing'; }, 250);
</script></body></html>`;

// ── 啟動 ──
mkdirSync(OUT_DIR, { recursive: true });
const pageDir = mkdtempSync(join(tmpdir(), 'cvpage-'));
writeFileSync(join(pageDir, 'index.html'), PAGE);

const pageServer = spawn('python3', ['-m', 'http.server', String(PAGE_PORT), '--bind', '127.0.0.1'], {
  cwd: pageDir, stdio: 'ignore',
});
const profile = mkdtempSync(join(tmpdir(), 'cvchrome-'));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--headless=new',
  '--disable-gpu', '--autoplay-policy=no-user-gesture-required',
  '--window-size=1000,600', 'about:blank',
], { stdio: 'ignore' });
const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch {}
  try { pageServer.kill('SIGKILL'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  try { rmSync(pageDir, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

async function fetchJson(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch {}
    await sleep(300);
  }
  throw new Error('CDP 連不上');
}
async function connect() {
  const targets = await fetchJson(`http://127.0.0.1:${PORT}/json`);
  const page = targets.find((t) => t.type === 'page');
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let id = 0; const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id; pending.set(mid, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { error: r.exceptionDetails.text };
    return { value: r.result?.value };
  };
  return { send, evalJs };
}

const cdp = await connect();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

const TARGETS_FILTERED = ONLY.length ? TARGETS.filter((t) => ONLY.includes(t.id)) : TARGETS;
console.log(`═══ 目視驗證 ${TARGETS_FILTERED.length} 個候選 ═══\n`);
const results = [];

for (const t of TARGETS_FILTERED) {
  const pageUrl = `http://127.0.0.1:${PAGE_PORT}/?u=${encodeURIComponent(t.url)}`;
  await cdp.send('Page.navigate', { url: pageUrl });
  await sleep(1500);

  // 等畫面
  let st = null;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const r = await cdp.evalJs('JSON.stringify(window.__state||{})');
    try { st = JSON.parse(r.value || '{}'); } catch { st = {}; }
    if (st.status === 'playing' && st.t > 6) break;
    if (st.status === 'error') break;
  }

  if (st?.status === 'playing') await sleep(2500);
  const file = join(OUT_DIR, `${t.id}.png`);
  let shotOk = false;
  if (st?.status === 'playing') {
    const box = await cdp.evalJs(`(() => {
      const v = document.getElementById('v');
      const r = v.getBoundingClientRect();
      return JSON.stringify({x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)});
    })()`);
    try {
      const b = JSON.parse(box.value);
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: b.x, y: b.y, width: b.w, height: b.h, scale: 1 },
      });
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
      shotOk = true;
    } catch (e) { st.shotError = e.message; }
  }

  const ok = st?.status === 'playing' && shotOk;
  console.log(
    `  ${ok ? '✓' : '✗'} ${t.id.padEnd(26)} 期望=${t.expect.padEnd(22)} ` +
      `status=${st?.status} t=${st?.t?.toFixed?.(1)} ${st?.w}x${st?.h} ${st?.error ?? ''}`,
  );
  if (ok) console.log(`      → ${file}`);
  results.push({ ...t, ok, state: st, file: ok ? file : null });
}

console.log('\n═══ 總結 ═══');
const okN = results.filter((r) => r.ok).length;
console.log(`  播出成功並截圖：${okN}/${results.length}`);
console.log('\n  截圖檔案（請目視比對台標）：');
for (const r of results.filter((x) => x.ok)) console.log(`    ${r.file}\n        期望：${r.expect}`);

writeFileSync(join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));
cleanup();
process.exit(0);
