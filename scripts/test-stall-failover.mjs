#!/usr/bin/env node
/**
 * test-stall-failover.mjs — 驗證「來源供應不足時會自動改用備援來源」
 *
 * ## 為什麼需要這個測試
 *
 * 播放器有兩條「換源」路徑：
 *
 *   1. **錯誤路徑** —— hls.js 丟出 fatal error（FRAG_LOAD_ERROR 等）→ failover
 *   2. **卡頓路徑** —— 緩衝耗盡（`waiting` 事件）持續 N 秒 → failover
 *
 * 第 2 條是給「上游還活著、但供應速度跟不上消耗速度」用的
 * （實測央視來源的 segment 是 5.2 MB / 6 秒內容，而上游只有約 480 KB/s）。
 * 沒有它的話，使用者會盯著凍結的畫面，**永遠不會自動換源**。
 *
 * ## 怎麼製造「卡頓但不報錯」
 *
 * 用 CDP 的 `Fetch` 網域**攔截**代理的 segment 請求，延遲後再放行：
 *
 *   · 延遲 < hls.js 的 `maxTimeToFirstByteMs`（30 秒）
 *     → hls.js 不會判定失敗 → 不會走錯誤路徑
 *   · 延遲 > 卡頓 watchdog（25 秒）
 *     → `waiting` 事件持續觸發 → 應該走卡頓路徑
 *
 * 這樣兩條路徑就被分開了，可以單獨驗證卡頓路徑有沒有生效。
 *
 * ## 怎麼觀察「有沒有換源」
 *
 * 不看內部 React state（會隨版本變動），而是看**網路層**：
 * 代理路徑是 `/api/proxy/<base64url(上游網址)>`，
 * 解碼後就知道播放器當下在跟哪個上游要資料。
 * 出現**備援上游**的請求 = 確實換源了。
 *
 * 用法：
 *   node scripts/test-stall-failover.mjs --base https://taiwan-live-tv.netlify.app
 *   node scripts/test-stall-failover.mjs --channel cn-cctv1 --delay-ms 26000
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/* ---------- 參數 ---------- */
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const BASE = String(arg('base', 'https://taiwan-live-tv.netlify.app')).replace(/\/$/, '');
const CHANNEL = String(arg('channel', 'cn-cctv1'));
const DELAY_MS = Number(arg('delay-ms', 26_000));
/**
 * 延遲 segment 的起始時間點（毫秒，自測試開始算起）。
 *
 * · 不指定 → 從第一個 segment 就開始延遲 → 測的是「**載入**路徑」
 *   （manifest 有回應但第一個 segment 不來 → 載入 watchdog 應在 60 秒換源）
 *
 * · 指定（例如 20000）→ 先讓前 20 秒正常播放，之後才延遲
 *   → 測的是「**卡頓**路徑」（已經有畫面，之後緩衝耗盡 → 卡頓 watchdog 應在 25 秒換源）
 */
const DELAY_AFTER_MS = Number(arg('delay-after-ms', 0));
const TOTAL_WAIT = Number(arg('wait', 90));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9371;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 頻道資料 ---------- */
const catalog = JSON.parse(readFileSync(join(ROOT, 'shared', 'channels.json'), 'utf8'));
const ch = catalog.channels.find((c) => c.channel_id === CHANNEL);
if (!ch) {
  console.error(`✗ 找不到頻道 ${CHANNEL}`);
  process.exit(1);
}
const backups = ch.playlist_source?.backup_urls ?? [];
if (backups.length === 0) {
  console.error(`✗ 頻道 ${CHANNEL} 沒有備援來源，無法驗證 failover`);
  process.exit(1);
}
const primaryHost = new URL(ch.stream_url).host;
const backupHosts = backups.map((b) => new URL(b.url).host);

/** 從代理路徑還原上游網址 */
function decodeProxied(url) {
  const m = /\/api\/proxy\/([^?]+)/.exec(url);
  if (!m) return null;
  try {
    return Buffer.from(m[1], 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/* ---------- Chrome ---------- */
const profile = mkdtempSync(join(tmpdir(), 'stall-test-'));
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
    //   本測試要驗證的是「真實的自動播放政策下，卡頓是否會自動換源」。
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

async function main() {
  console.log('═'.repeat(70));
  console.log('驗證：來源供應不足（卡頓）時會自動改用備援來源');
  console.log('═'.repeat(70));
  console.log(`測試站點：${BASE}`);
  console.log(`頻道：${ch.channel_name} (${CHANNEL})`);
  console.log(`主來源 host：${primaryHost}`);
  console.log(`備援 host：${backupHosts.join(', ')}`);
  console.log(`segment 延遲：${DELAY_MS / 1000} 秒（卡頓 watchdog = 25 秒）\n`);

  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
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

  const ws = new WS(wsUrl, { perMessageOrder: true, maxPayload: 256 * 1024 * 1024 });
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });

  let msgId = 0;
  const pending = new Map();
  const listeners = new Set();

  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const { resolve: res, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : res(m.result);
      return;
    }
    if (m.method) {
      for (const fn of listeners) fn(m);
    }
  });

  const send = (method, params = {}, sessionId) =>
    new Promise((res, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve: res, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  const s = (method, params) => send(method, params, sessionId);

  await s('Page.enable');
  await s('Runtime.enable');
  await s('Network.enable');
  await s('Log.enable');
  await s('Fetch.enable', {
    patterns: [{ urlPattern: `${BASE}/api/proxy/*` }],
  });

  /* ---------- 攔截代理請求 ---------- */
  const timeline = [];
  const requestedHosts = [];
  let stalled = false;
  let failoverAt = null;
  let primaryRequestAfterStall = false;
  /** 測試開始的時間（用來判斷「現在才開始延遲」） */
  const testStart = Date.now();
  /**
   * 播放器的 console 訊息。
   *
   * 用途：**分辨是哪一條換源路徑生效**。
   *   · 「緩衝持續耗盡」 → **卡頓 watchdog**（播放中卡住）
   *   · 「來源失敗」／「逾時」 → **載入 watchdog** 或 hls.js 的錯誤路徑
   *
   * 兩條路徑的行為不同，必須分開驗證。
   */
  const playerLogs = [];

  listeners.add((m) => {
    if (m.sessionId !== sessionId) return;

    // 播放器的 console 訊息（分辨換源路徑）
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args ?? [])
        .map((a) => a.value ?? a.description ?? '')
        .join(' ');
      if (text.includes('[播放器]')) {
        playerLogs.push({ t: Date.now(), text: text.slice(0, 200) });
      }
      return;
    }
    if (m.method === 'Log.entryAdded') {
      const text = m.params.entry?.text ?? '';
      if (text.includes('[播放器]')) {
        playerLogs.push({ t: Date.now(), text: text.slice(0, 200) });
      }
      return;
    }

    if (m.method === 'Fetch.requestPaused') {
      const url = m.params.request.url;
      const upstream = decodeProxied(url);
      const host = upstream ? new URL(upstream).host : null;

      // 只延遲「主來源的 segment」（.ts / .m4s），manifest 與備援照常放行
      const isSegment = /\.ts(\?|$)|\.m4s(\?|$)/.test(upstream ?? '');
      const isPrimary = host === primaryHost;
      // 已過「延遲起始時間」才開始拖慢（用來製造「先播、後卡」的情境）
      const delayActive = Date.now() - testStart >= DELAY_AFTER_MS;

      if (isSegment && isPrimary && delayActive) {
        stalled = true;
        setTimeout(() => {
          send('Fetch.continueRequest', { requestId: m.params.requestId }, sessionId).catch(
            () => {},
          );
        }, DELAY_MS);
      } else {
        send('Fetch.continueRequest', { requestId: m.params.requestId }, sessionId).catch(
          () => {},
        );
      }
      return;
    }

    if (m.method === 'Network.requestWillBeSent') {
      const url = m.params.request.url;
      const upstream = decodeProxied(url);
      if (!upstream) return;
      const host = new URL(upstream).host;
      requestedHosts.push(host);
      timeline.push({
        t: Date.now(),
        host,
        isPrimary: host === primaryHost,
        isBackup: backupHosts.includes(host),
        file: upstream.split('/').pop()?.slice(0, 40),
      });
      if (stalled && host === primaryHost) primaryRequestAfterStall = true;
      if (stalled && backupHosts.includes(host) && failoverAt === null) {
        failoverAt = Date.now();
      }
    }
  });

  /* ---------- 開頁面 ---------- */
  await s('Page.navigate', { url: `${BASE}/?t=${Date.now()}` });
  await sleep(3000);

  // 等抽屜把手
  let ready = false;
  for (let i = 0; i < 30; i++) {
    const r = await s('Runtime.evaluate', {
      expression: `!!document.querySelector('button[aria-label="選擇頻道"]')`,
      returnByValue: true,
    });
    if (r.result?.value) {
      ready = true;
      break;
    }
    await sleep(1000);
  }
  if (!ready) {
    console.error('✗ 頁面未載入');
    process.exit(1);
  }

  /* ---------- 真實滑鼠點擊（不能用 element.click()） ---------- */
  const realClick = async (selectorExpr) => {
    const box = await s('Runtime.evaluate', {
      expression: `(() => {
        const el = ${selectorExpr};
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width/2, y: r.top + r.height/2 };
      })()`,
      returnByValue: true,
    });
    const b = box.result?.value;
    if (!b) return null;
    await sleep(250);
    await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y });
    await sleep(60);
    await s('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1,
    });
    await sleep(50);
    await s('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1,
    });
    return b;
  };

  // 展開抽屜
  await realClick(`document.querySelector('button[aria-label="選擇頻道"]')`);
  await sleep(900);

  // 點選目標頻道
  const picked = await s('Runtime.evaluate', {
    expression: `(() => {
      const want = ${JSON.stringify(ch.channel_name)};
      // ⭐ 用 data-channel-name，不要用 [class*="channelCard"] / [class*="cardName"]。
      // 抽屜重設計（commit 8095269）把 .channelCard / .cardName 改成
      // .drawerCard / .drawerCardName（大小寫也不同），
      // 舊的子字串選擇器從此匹配 0 個元素 → 測試永遠失敗。
      // data-* 屬性不受 CSS 改名影響。
      const btns = [...document.querySelectorAll('aside[aria-label="頻道選擇"] button[data-channel-name]')];
      const hit = btns.find(b => b.getAttribute('data-channel-name') === want);
      if (!hit) return null;
      // ⚠️ **必須先 scrollIntoView**：抽屜是獨立捲動容器，
      // 目標頻道卡可能在視窗外（實測 y=1637 > 視窗高 633），
      // 直接用 getBoundingClientRect 算出來的座標會點到別的地方。
      hit.scrollIntoView({ block: 'center' });
      const r = hit.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2 };
    })()`,
    returnByValue: true,
  });
  if (!picked.result?.value) {
    console.error(`✗ 抽屜內找不到頻道「${ch.channel_name}」`);
    process.exit(1);
  }
  {
    const { x, y } = picked.result.value;
    await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(60);
    await s('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1,
    });
    await sleep(50);
    await s('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
    });
  }
  console.log(`▶ 已點選頻道「${ch.channel_name}」（真實滑鼠事件）\n`);

  /* ---------- 掛上事件記錄器 ---------- */
  //
  // 記錄 video 元素的關鍵事件，讓報告能回答：
  //   · `waiting` 到底有沒有觸發？（卡頓路徑的觸發條件）
  //   · `playing` 有沒有觸發？（恢復的訊號）
  //   · `stalled` 有沒有觸發？
  //
  // 用 `addEventListener` 直接掛在元素上（不是改程式碼），
  // 所以可以在不改動線上程式的前提下觀察真實行為。
  await s('Runtime.evaluate', {
    expression: `(() => {
      window.__ev = [];
      const attach = () => {
        const v = document.querySelector('video');
        if (!v) return false;
        if (v.__instrumented) return true;
        v.__instrumented = true;
        for (const type of ['waiting','playing','stalled','suspend','pause','play','emptied','error']) {
          v.addEventListener(type, () => {
            window.__ev.push({
              t: Math.round(performance.now()/1000),
              type,
              readyState: v.readyState,
              paused: v.paused,
              currentTime: Number(v.currentTime.toFixed(2)),
            });
          });
        }
        return true;
      };
      window.__attach = attach;
      attach();
      // video 元素會在 HLS/iframe 模式切換時被替換 → 用 MutationObserver 重新掛
      new MutationObserver(() => { attach(); }).observe(document.body, { childList: true, subtree: true });
      return true;
    })()`,
    returnByValue: true,
  });

  /* ---------- 觀察 ---------- */
  const started = Date.now();
  let stalledAt = null;
  let videoState = {};
  const states = [];

  while ((Date.now() - started) / 1000 < TOTAL_WAIT) {
    await sleep(1000);
    const r = await s('Runtime.evaluate', {
      expression: `(() => {
        const v = document.querySelector('video');
        if (!v) return { found: false };
        return {
          found: true,
          currentTime: Number(v.currentTime.toFixed(2)),
          readyState: v.readyState,
          paused: v.paused,
          muted: v.muted,
          w: v.videoWidth,
          h: v.videoHeight,
          err: v.error ? v.error.code : null,
          overlay: (document.querySelector('[role="status"]')?.textContent || '').trim().slice(0, 60),
        };
      })()`,
      returnByValue: true,
    });
    videoState = r.result?.value ?? {};
    states.push({ t: Math.round((Date.now() - started) / 1000), ...videoState });
    if (stalled && stalledAt === null) {
      stalledAt = Date.now();
      console.log(`  ⏱️  segment 開始被延遲（t=${Math.round((stalledAt - started) / 1000)}s）`);
    }
    if (failoverAt !== null) {
      console.log(
        `  ✅ t=${Math.round((failoverAt - started) / 1000)}s 偵測到改用備援上游`,
      );
      break;
    }
  }

  /* ---------- 報告 ---------- */
  console.log('\n── 影片狀態時間線 ──');
  for (const st of states) {
    if (!st.found) continue;
    console.log(
      `  t=${String(st.t).padStart(3)}s  t=${String(st.currentTime).padStart(7)}  ` +
        `readyState=${st.readyState}  paused=${st.paused}  ${st.w}x${st.h}` +
        (st.overlay ? `  「${st.overlay}」` : ''),
    );
  }

  console.log('\n── 播放器 console（分辨換源路徑）──');
  if (playerLogs.length === 0) {
    console.log('  （沒有播放器訊息）');
  } else {
    for (const l of playerLogs) {
      console.log(`  ${String(Math.round((l.t - started) / 1000)).padStart(3)}s  ${l.text}`);
    }
  }
  const stallPathFired = playerLogs.some((l) => l.text.includes('緩衝持續耗盡'));
  const loadPathFired = playerLogs.some((l) => l.text.includes('逾時'));
  console.log(`  → 卡頓路徑（緩衝持續耗盡）：${stallPathFired ? '有觸發 ✓' : '未觸發'}`);
  console.log(`  → 載入路徑（逾時）：${loadPathFired ? '有觸發 ✓' : '未觸發'}`);

  console.log('\n── video 事件時間線 ──');
  const evs = await s('Runtime.evaluate', {
    expression: `JSON.stringify(window.__ev || [])`,
    returnByValue: true,
  });
  let eventList = [];
  try {
    eventList = JSON.parse(evs.result?.value ?? '[]');
  } catch {
    /* ignore */
  }
  if (eventList.length === 0) {
    console.log('  （沒有記錄到事件）');
  } else {
    for (const e of eventList) {
      console.log(
        `  ${String(e.t).padStart(4)}s  ${e.type.padEnd(9)} readyState=${e.readyState} ` +
          `paused=${e.paused} currentTime=${e.currentTime}`,
      );
    }
  }
  const waitingCount = eventList.filter((e) => e.type === 'waiting').length;
  console.log(`  → waiting 事件次數：${waitingCount}`);

  console.log('\n── 上游請求紀錄（解碼代理路徑）──');
  for (const e of timeline) {
    const tag = e.isPrimary ? '主' : e.isBackup ? '備援' : '其他';
    console.log(
      `  ${String(Math.round((e.t - started) / 1000)).padStart(3)}s  [${tag}] ${e.host}  ${e.file}`,
    );
  }

  const sawBackup = requestedHosts.some((h) => backupHosts.includes(h));
  // ⚠️ `stalledAt` 與 timeline 的 `t` 都是**毫秒**，單位必須一致
  const sawBackupAfterStall = timeline.some(
    (e) => e.isBackup && e.t >= (stalledAt ?? 0),
  );

  console.log('\n' + '═'.repeat(70));
  console.log('判定：');
  console.log(`  卡頓是否真的發生（segment 被延遲）：${stalled ? '是 ✓' : '否 ✗'}`);
  console.log(`  是否曾向備援上游要資料：${sawBackup ? '是 ✓' : '否 ✗'}`);
  console.log(`  卡頓之後是否改用備援：${sawBackupAfterStall ? '是 ✓' : '否 ✗'}`);
  if (stalledAt !== null) {
    console.log(`  卡頓發生於 t=${Math.round((stalledAt - started) / 1000)}s`);
  }
  if (failoverAt !== null) {
    console.log(
      `  改用備援發生於 t=${Math.round((failoverAt - started) / 1000)}s` +
        `（卡頓後 ${Math.round((failoverAt - stalledAt) / 1000)}s）`,
    );
  }
  const pass = stalled && sawBackupAfterStall;
  console.log(`\n結果：${pass ? '✓ 通過（卡頓會自動換源）' : '✗ 未通過（卡頓不會自動換源）'}`);
  console.log('═'.repeat(70));

  try {
    ws.close();
  } catch {}
  try {
    process.kill(-chrome.pid);
  } catch {}
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('測試失敗：', e.message);
  try {
    chrome.kill('SIGKILL');
  } catch {}
  process.exit(1);
});
