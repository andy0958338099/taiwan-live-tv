#!/usr/bin/env node
/**
 * probe-litv-unmute.mjs — 試出 litv 播放器能不能被程式解除靜音
 *
 * ## 背景
 *
 * 使用者明確要求：「點選頻道後不要靜音，也不用出現喇叭標記」。
 *
 * 實測（2026-11-22）：
 *   · YouTube embed（7 個頻道）→ 可以解除靜音，muted=false volume=1 ✓
 *   · litv embed（東森 CH51、三立 CH54）→ **靜音中**，畫面上有 🔇 圖示 ✗
 *   · 4gTV embed（客家電視台）→ 畫面全黑，完全不播 ✗
 *
 * 問題在 litv：`player.svc.litv.tv/v3/ppnif.html` 是跨網域 iframe，
 * 父頁拿不到它的 DOM。但有兩條路可能走得通：
 *
 *   A. **postMessage 命令** —— litv 的播放器有沒有公開的訊息協定？
 *   B. **點擊播放器內的靜音鈕** —— 用 CDP 發真實滑鼠事件點那個 🔇 圖示
 *      （真實事件帶 user activation，瀏覽器允許解除靜音）
 *
 * ## 本支做什麼
 *
 * 對同一個 litv 頻道，依序試 A 的各種訊息格式；每次之後讀 iframe 內
 * `<video>.muted`。全部失敗再試 B。
 *
 * 用法：
 *   node scripts/probe-litv-unmute.mjs --base https://taiwan-live-tv.netlify.app
 *   node scripts/probe-litv-unmute.mjs --id ebc-news-51
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const BASE = arg('base', 'http://localhost:3211').replace(/\/$/, '');
const CHANNEL_ID = arg('id', 'ebc-news-51');
const PROFILE = join('/Users/andy/.hermes/cache/scratch', 'chrome-litv-profile');
const PORT = 9413;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3 });
  const bin = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  spawn(
    bin,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      `--window-size=1440,900`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try {
      wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json())
        .webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch {
      /* 還沒起來 */
    }
  }
  if (!wsUrl) throw new Error('Chrome 啟動失敗');

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
    });
  return { ws, send };
}

async function main() {
  const catalog = JSON.parse(
    readFileSync(new URL('../shared/channels.json', import.meta.url), 'utf8'),
  );
  const ch = catalog.channels.find((c) => c.channel_id === CHANNEL_ID);
  if (!ch) throw new Error(`找不到頻道 ${CHANNEL_ID}`);
  if (!ch.embed_url?.includes('litv')) {
    console.log(`⚠️ ${CHANNEL_ID} 不是 litv embed（${ch.embed_url}）`);
  }

  console.log(`═══ 試出 litv 播放器解除靜音的方法 ═══\n`);
  console.log(`頻道：${ch.channel_name} (${ch.channel_id})`);
  console.log(`網址：${ch.embed_url}\n`);

  const { ws, send } = await launch();
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

  const call = (method, params = {}, sid = sessionId) =>
    new Promise((resolve, reject) => {
      const mid = Math.floor(Math.random() * 1e9);
      const handler = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id === mid) {
          ws.removeEventListener('message', handler);
          msg.error
            ? reject(new Error(JSON.stringify(msg.error)))
            : resolve(msg.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id: mid, method, params, sessionId: sid }));
    });

  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'evaluate 失敗');
    return r.result.value;
  };

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Network.enable');
  await call('Network.setUserAgentOverride', { userAgent: UA });
  await call('Page.navigate', { url: `${BASE}/` });
  await sleep(4500);

  await evaluate(`(() => {
    const h = document.querySelector('button[aria-label="選擇頻道"]');
    if (h) h.click(); return true; })()`);
  await sleep(1300);

  const clicked = await evaluate(`(() => {
    const want = ${JSON.stringify(ch.channel_name)};
    const b = [...document.querySelectorAll('button[data-channel-name]')]
      .find(x => x.getAttribute('data-channel-name') === want);
    if (!b) return 'not-found';
    b.scrollIntoView(); b.click(); return 'clicked'; })()`);
  console.log(`點擊頻道：${clicked}`);
  await sleep(10000);

  // 找出 litv 的 iframe target
  const targets = await send('Target.getTargets');
  const litvTarget = targets.targetInfos.find(
    (t) => t.type === 'iframe' && t.url.includes('litv'),
  );
  if (!litvTarget) {
    console.log('✗ 找不到 litv iframe target');
    process.exit(1);
  }
  const { sessionId: pSid } = await send('Target.attachToTarget', {
    targetId: litvTarget.targetId,
    flatten: true,
  });

  const readState = async () => {
    try {
      const r = await call(
        'Runtime.evaluate',
        {
          expression: `(() => {
            const v = document.querySelector('video');
            if (!v) return { noVideo: true };
            return { muted: v.muted, volume: v.volume, currentTime: v.currentTime,
                     paused: v.paused, readyState: v.readyState,
                     videoWidth: v.videoWidth, videoHeight: v.videoHeight };
          })()`,
          returnByValue: true,
        },
        pSid,
      );
      return r.result.value;
    } catch (e) {
      return { err: String(e.message) };
    }
  };

  console.log('── 初始狀態 ──');
  console.log(' ', JSON.stringify(await readState()));

  // ── 方式 A：postMessage 各種命令格式 ──
  const MESSAGES = [
    ['{type:"unmute"}', { type: 'unmute' }],
    ['{command:"unmute"}', { command: 'unmute' }],
    ['{type:"setVolume",volume:100}', { type: 'setVolume', volume: 100 }],
    ['{event:"command",func:"unMute"}', { event: 'command', func: 'unMute' }],
    ['{type:"unMute"}', { type: 'unMute' }],
    ['{action:"mute",value:false}', { action: 'mute', value: false }],
    ['{type:"player",method:"unmute"}', { type: 'player', method: 'unmute' }],
    ['{event:"unmute"}', { event: 'unmute' }],
  ];

  console.log('\n── 方式 A：postMessage 命令 ──');
  let solved = false;
  for (const [label, payload] of MESSAGES) {
    await evaluate(`(() => {
      const f = [...document.querySelectorAll('iframe')].find(x => x.src && x.src.includes('litv'));
      if (!f) return false;
      try { f.contentWindow.postMessage(${JSON.stringify(payload)}, '*'); } catch (e) {}
      return true;
    })()`);
    await sleep(1200);
    const st = await readState();
    const ok = st.muted === false;
    console.log(`  ${ok ? '✓' : ' '} ${label.padEnd(36)} muted=${st.muted} volume=${st.volume}`);
    if (ok) {
      solved = true;
      break;
    }
  }

  // ── 方式 B：點擊播放器內的靜音鈕 ──
  if (!solved) {
    console.log('\n── 方式 B：點擊播放器內的靜音鈕（真實滑鼠事件）──');
    // 靜音鈕通常在播放器左上角
    const pos = await evaluate(`(() => {
      const f = [...document.querySelectorAll('iframe')].find(x => x.src && x.src.includes('litv'));
      if (!f) return null;
      const r = f.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2,
               left: r.left, top: r.top, w: r.width, h: r.height };
    })()`);
    if (pos) {
      // 截圖找出靜音鈕位置
      const shot = await call('Page.captureScreenshot', { format: 'png' });
      mkdirSync('/Users/andy/.hermes/cache/scratch/embed-verify', { recursive: true });
      const p = `/Users/andy/.hermes/cache/scratch/embed-verify/litv-${CHANNEL_ID}.png`;
      writeFileSync(p, Buffer.from(shot.data, 'base64'));
      console.log(`  截圖：${p}`);

      // 嘗試幾個候選位置：左上角、播放鈕、中心
      const candidates = [
        ['左上角（靜音鈕常見位置）', pos.left + 30, pos.top + 30],
        ['左下角', pos.left + 30, pos.top + pos.h - 30],
        ['播放器中心', pos.x, pos.y],
      ];
      for (const [label, x, y] of candidates) {
        await call('Input.dispatchMouseEvent', {
          type: 'mousePressed', x, y, button: 'left', clickCount: 1,
        });
        await call('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
        });
        await sleep(2500);
        const st = await readState();
        const ok = st.muted === false;
        console.log(
          `  ${ok ? '✓' : ' '} ${label.padEnd(36)} (${Math.round(x)},${Math.round(y)}) muted=${st.muted} volume=${st.volume}`,
        );
        if (ok) {
          solved = true;
          break;
        }
      }
    }
  }

  console.log('\n' + '═'.repeat(66));
  console.log(
    solved
      ? '✓ 找到可行的解除靜音方式'
      : '✗ 沒有任何方式能解除 litv 的靜音（受限於跨網域限制）',
  );
  console.log('═'.repeat(66));
  process.exit(solved ? 0 : 1);
}

await main();
