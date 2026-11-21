#!/usr/bin/env node
/**
 * debug-select-and-play.mjs — 確認「點擊 → 選到頻道 → 播放器狀態」的完整鏈路
 *
 * 用途：區分兩種失敗
 *   A. 點擊沒選到頻道（UI 層問題）
 *   B. 選到了但播放器起不來（來源問題）
 *
 * 用法：node scripts/debug-select-and-play.mjs --ids playlist-龍華-龍華電視 --seconds 45
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const BASE = arg('base', 'https://taiwan-live-tv.netlify.app');
const IDS = arg('ids', 'playlist-龍華-龍華電視').split(',').filter(Boolean);
const SECONDS = Number(arg('seconds', '45'));
const PORT = 9336;
const PROFILE = '/Users/andy/.hermes/cache/scratch/chrome-debug-profile';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
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
      logs.push(
        `[${m.params.type}] ` +
          (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '),
      );
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push(`[exception] ${m.params.exceptionDetails.text} ${m.params.exceptionDetails.exception?.description ?? ''}`);
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

  for (const ch of targets) {
    console.log('═'.repeat(70));
    console.log(`▶ ${ch.channel_name} (${ch.channel_id})`);
    console.log('═'.repeat(70));
    await s('Page.navigate', { url: `${BASE}/` });
    await sleep(3500);

    const before = await s('Runtime.evaluate', {
      expression: `(() => ({
        hasVideo: !!document.querySelector('video'),
        videoCount: document.querySelectorAll('video').length,
        hasIframe: !!document.querySelector('iframe'),
        drawerCards: document.querySelectorAll('button[data-channel-name]').length,
        handleRect: (() => { const b=document.querySelector('button[aria-label="選擇頻道"]'); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height}; })(),
        selectedLabel: document.querySelector('h1, h2, [data-current-channel]')?.textContent?.trim().slice(0,60) ?? null,
      }))()`,
      returnByValue: true,
    });
    console.log('  點擊前：', JSON.stringify(before.result.value));

    // 開抽屜
    const h = before.result.value.handleRect;
    if (!h) {
      console.log('  ✗ 沒有把手');
      continue;
    }
    for (const type of ['mousePressed', 'mouseReleased']) {
      await s('Input.dispatchMouseEvent', { type, x: h.x, y: h.y, button: 'left', clickCount: 1 });
    }
    await sleep(1200);

    const drawerOpen = await s('Runtime.evaluate', {
      expression: `(() => {
        const btns = [...document.querySelectorAll('button[data-channel-name]')];
        const b = btns.find(x => x.getAttribute('data-channel-name') === ${JSON.stringify(ch.channel_name)});
        if (!b) return { found: false, total: btns.length, names: btns.slice(0,8).map(x=>x.getAttribute('data-channel-name')) };
        b.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = b.getBoundingClientRect();
        return { found: true, x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height,
                 inViewport: r.top >= 0 && r.bottom <= window.innerHeight };
      })()`,
      returnByValue: true,
    });
    console.log('  抽屜：', JSON.stringify(drawerOpen.result.value));

    if (!drawerOpen.result.value.found) {
      console.log('  ✗ 找不到卡片 → UI 選取有問題');
      continue;
    }
    // ⚠️ 滾動後必須等一幀，讓 getBoundingClientRect 反映新位置
    await sleep(500);
    const rect2 = await s('Runtime.evaluate', {
      expression: `(() => {
        const b = [...document.querySelectorAll('button[data-channel-name]')]
          .find(x => x.getAttribute('data-channel-name') === ${JSON.stringify(ch.channel_name)});
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width/2, y: r.top + r.height/2,
                 inViewport: r.top >= 0 && r.bottom <= window.innerHeight };
      })()`,
      returnByValue: true,
    });
    const c = rect2.result.value;
    if (!c || !c.inViewport) {
      console.log(`  ✗ 卡片不在視窗內（y=${c?.y}）→ 略過`);
      continue;
    }
    console.log(`  點擊位置：x=${c.x.toFixed(0)} y=${c.y.toFixed(0)}`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await s('Input.dispatchMouseEvent', { type, x: c.x, y: c.y, button: 'left', clickCount: 1 });
    }
    await sleep(2000);

    const after = await s('Runtime.evaluate', {
      expression: `(() => ({
        videoCount: document.querySelectorAll('video').length,
        hasVideo: !!document.querySelector('video'),
        v: (() => { const v=document.querySelector('video'); return v ? {t:v.currentTime, rs:v.readyState, paused:v.paused, w:v.videoWidth, h:v.videoHeight, src:(v.currentSrc||'').slice(0,110), err:v.error?v.error.code:null} : null; })(),
        pageError: document.querySelector('[role="alert"], .error, .errorMessage')?.textContent?.trim().slice(0,220) ?? null,
        bodyText: document.body.innerText.replace(/\\s+/g,' ').slice(0, 400),
      }))()`,
      returnByValue: true,
    });
    console.log('  點擊後（2 秒）：', JSON.stringify(after.result.value));

    await sleep(SECONDS * 1000);
    const later = await s('Runtime.evaluate', {
      expression: `(() => ({
        v: (() => { const v=document.querySelector('video'); return v ? {t:v.currentTime, rs:v.readyState, paused:v.paused, w:v.videoWidth, h:v.videoHeight, err:v.error?v.error.code:null} : null; })(),
        pageError: document.querySelector('[role="alert"], .error, .errorMessage')?.textContent?.trim().slice(0,220) ?? null,
      }))()`,
      returnByValue: true,
    });
    console.log(`  ${SECONDS} 秒後：`, JSON.stringify(later.result.value));

    console.log('  console（最後 20 筆）：');
    for (const l of logs.slice(-20)) console.log('   ', l.slice(0, 200));
    console.log('');

    await s('Runtime.evaluate', {
      expression: `(() => { const v=document.querySelector('video'); if(v){v.pause(); v.src='';} })()`,
    });
    await sleep(500);
  }

  try { ws.close(); } catch {}
  try { process.kill(-chrome.pid); } catch {}
}

main();
