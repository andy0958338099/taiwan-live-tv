#!/usr/bin/env node
/**
 * test-playback-local.mjs — 用系統 Chrome 實測播放
 *
 * Headless Chromium 無法解碼媒體，所以用系統安裝的 Google Chrome
 * 以 CDP 模式啟動，實際載入頁面、點擊頻道、等待播放，
 * 再讀取 <video> 的 currentTime / readyState / paused / muted。
 *
 * 用法：node scripts/test-playback-local.mjs [--ids id1,id2] [--base http://localhost:3210]
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const BASE = arg('base', 'http://localhost:3210');
const IDS = arg('ids', '').split(',').filter(Boolean);
const PORT = 9333;
const PROFILE = '/Users/andy/.hermes/cache/scratch/chrome-playback-profile';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJSON(url) {
  const res = await fetch(url);
  return res.json();
}

async function main() {
  console.log('═'.repeat(70));
  console.log('播放實測（系統 Chrome + CDP）');
  console.log('═'.repeat(70));

  const catalog = await fetchJSON(`${BASE}/channels.json`);

  // 挑選要測的頻道
  let targets;
  if (IDS.length) {
    targets = catalog.channels.filter((c) => IDS.includes(c.channel_id));
  } else {
    // 預設：抽樣各類型
    const pick = [
      'playlist-龍華-龍華電視',
      'playlist-TVBS-tvbs',
      'cn-cctv1',
      'cn-hn',
      'cn-gd',
      'cn-cgtn',
      'cn-fhzw',
      'cts-news-52',
    ];
    targets = pick
      .map((id) => catalog.channels.find((c) => c.channel_id === id))
      .filter(Boolean);
  }

  console.log(`測試目標 ${targets.length} 個\n`);

  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });

  const chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1600,1000',
      'about:blank',
    ],
    { detached: true, stdio: 'ignore' },
  );

  // 等 Chrome 起來
  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await r.json();
      wsUrl = j.webSocketDebuggerUrl;
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
  const events = [];

  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    } else if (m.method) {
      events.push(m);
    }
  });

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  // 建立 target
  const { targetId } = await send('Target.createTarget', {
    url: 'about:blank',
  });
  const { sessionId } = await send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });

  const s = (method, params) => send(method, params, sessionId);

  await s('Page.enable');
  await s('Runtime.enable');

  const results = [];

  for (const ch of targets) {
    console.log(`▶ ${ch.channel_name} (${ch.channel_id})`);

    // 開新頁面
    await s('Page.navigate', { url: `${BASE}/` });
    await sleep(3000);

    // 找到目標頻道的卡片按鈕並點擊
    // 頻道卡片是 button，其內含 .cardName（channel_name）。
    // 點擊後 handleSelect 會 setSelected，播放器隨即載入該頻道。
    const clicked = await s('Runtime.evaluate', {
      expression: `(() => {
        const want = ${JSON.stringify(ch.channel_name)};
        const btns = [...document.querySelectorAll('button')];
        const hit = btns.find(b => {
          const n = b.querySelector('[class*="cardName"]');
          return n && (n.textContent || '').trim() === want;
        });
        if (hit) { hit.scrollIntoView(); hit.click(); return want; }
        return null;
      })()`,
      returnByValue: true,
    });
    if (!clicked.result.value) {
      console.log(`  ✗ 找不到頻道卡片「${ch.channel_name}」`);
      results.push({
        channel_id: ch.channel_id,
        channel_name: ch.channel_name,
        ok: false,
        error_text: '找不到頻道卡片',
      });
      continue;
    }

    // 等播放
    let stat = null;
    for (let i = 0; i < 14; i++) {
      await sleep(2000);
      const r = await s('Runtime.evaluate', {
        expression: `(() => {
          const v = document.querySelector('video');
          if (!v) return { found: false };
          return {
            found: true,
            currentTime: v.currentTime,
            readyState: v.readyState,
            paused: v.paused,
            muted: v.muted,
            videoWidth: v.videoWidth,
            videoHeight: v.videoHeight,
            src: (v.currentSrc || v.src || '').slice(0, 90),
            error: v.error ? v.error.code : null,
          };
        })()`,
        returnByValue: true,
      });
      stat = r.result.value;
      if (stat?.found && stat.currentTime > 0.5 && !stat.paused) break;
    }

    // 讀取頁面上的錯誤訊息
    const errText = await s('Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector('[role="alert"], .error, .errorMessage');
        return el ? el.textContent.trim().slice(0, 160) : null;
      })()`,
      returnByValue: true,
    });

    const ok = stat?.found && !stat.paused && stat.currentTime > 0.5;
    const label = ok ? '✓' : '✗';
    console.log(
      `  ${label} currentTime=${stat?.currentTime?.toFixed?.(2) ?? '—'} ` +
        `paused=${stat?.paused} muted=${stat?.muted} ` +
        `size=${stat?.videoWidth}x${stat?.videoHeight} err=${stat?.error ?? '—'}`,
    );
    if (stat?.src) console.log(`     src: ${stat.src}`);
    if (errText.result.value) console.log(`     錯誤: ${errText.result.value}`);

    results.push({
      channel_id: ch.channel_id,
      channel_name: ch.channel_name,
      ok,
      ...stat,
      error_text: errText.result.value,
    });

    // 停止播放
    await s('Runtime.evaluate', {
      expression: `(() => { const v=document.querySelector('video'); if(v){v.pause(); v.src='';} })()`,
    });
    await sleep(800);
  }

  console.log('');
  console.log('═'.repeat(70));
  const passed = results.filter((r) => r.ok).length;
  console.log(`結果：${passed}/${results.length} 個頻道播放成功`);
  console.log('═'.repeat(70));
  for (const r of results) {
    console.log(
      `  ${r.ok ? '✓' : '✗'} ${r.channel_name.padEnd(20)} ` +
        `t=${r.currentTime?.toFixed?.(1) ?? '—'} ${r.videoWidth}x${r.videoHeight}`,
    );
  }

  writeFileSync(
    '/Users/andy/.hermes/cache/scratch/playback-local.json',
    JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 2),
  );

  try {
    ws.close();
  } catch {}
  try {
    process.kill(-chrome.pid);
  } catch {}
  process.exit(passed === results.length ? 0 : 1);
}

main();
