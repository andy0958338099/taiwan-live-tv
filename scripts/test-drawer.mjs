#!/usr/bin/env node
/**
 * test-drawer.mjs — 驗證 Web 版「可隱藏式頻道選擇抽屜」
 *
 * 驗證三件事：
 *   1. 預設狀態下，抽屜是**隱藏**的（觀看時不佔畫面）
 *   2. 點擊把手 → 抽屜展開，頻道清單可見
 *   3. 選好頻道 → 抽屜**自動收起**
 *
 * 用真實滑鼠事件（CDP Input.dispatchMouseEvent），
 * 因為 `HTMLElement.click()` 不會授予使用者啟動權限，
 * 而「點擊展開」正是本測試要驗證的互動。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE =
  (() => {
    const i = process.argv.indexOf('--base');
    return i >= 0 ? process.argv[i + 1] : 'http://localhost:3211';
  })() ?? 'http://localhost:3211';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9355;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'drawer-test-'));
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
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) return { error: r.exceptionDetails.text };
    return { value: r.result?.value };
  };
  return { send, evalJs };
}

/** 用真實滑鼠事件點擊符合條件的元素 */
async function realClick(cdp, selectorExpr, label) {
  const box = await cdp.evalJs(`(() => {
    const el = ${selectorExpr};
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2,
             text: (el.textContent||'').trim().slice(0,24) };
  })()`);
  if (!box.value) return null;
  await sleep(250);
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
  return box.value.text;
}

/** 抽屜狀態 */
const drawerState = (cdp) =>
  cdp.evalJs(`(() => {
    const aside = document.querySelector('aside[aria-label="頻道選擇"]');
    if (!aside) return { none: true };
    const r = aside.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    // 抽屜以 translate 移到畫面外。判斷方式：
    //   下方抽屜（手機）→ 完全跑到視窗下方之外 = 隱藏
    //   右側抽屜（桌機）→ 完全跑到視窗右方之外 = 隱藏
    const offBottom = r.top >= vh - 5;
    const offRight  = r.left >= vw - 5;
    const handle = document.querySelector('button[aria-label="選擇頻道"]');
    const channelCards = aside.querySelectorAll('button[class*="drawerCard"]');
    return {
      hidden: offBottom || offRight,
      rect: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width) },
      handleVisible: handle ? !handle.className.includes('Hidden') : false,
      channelCards: channelCards.length,
      // 頁面上「不屬於抽屜」的頻道卡片數量（應該是 0 —— 全部收在抽屜裡）
      //
      // ⚠️ 這裡必須用 data-channel-name，不能用 [class*="channelCard"]。
      // 抽屜重設計（commit 8095269）把 .channelCard 改成 .drawerCard，
      // 舊選擇器永遠匹配 0 個 → 這個檢查**永遠回報 0（假通過）**，
      // 就算真的有頻道卡片漏在抽屜外也抓不到。
      cardsOutsideDrawer: Array.from(
        document.querySelectorAll('main > section button[data-channel-name]'),
      ).length,
    };
  })()`);

async function main() {
  console.log('═'.repeat(62));
  console.log('驗證：可隱藏式頻道選擇抽屜');
  console.log('═'.repeat(62));
  console.log(`測試站點：${BASE}\n`);

  const cdp = await connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: `${BASE}/?t=${Date.now()}` });

  // 等待抽屜把手出現（代表頁面已載入）
  let ready = { value: null };
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    ready = await cdp.evalJs(
      `!!document.querySelector('button[aria-label="選擇頻道"]')`,
    );
    if (ready.value) break;
  }
  if (!ready.value) {
    console.log('✗ 找不到抽屜把手');
    process.exit(1);
  }
  console.log('頁面載入完成，抽屜把手存在\n');

  // ── 步驟 1：預設應為隱藏 ──
  console.log('[1] 預設狀態（觀看中）');
  const s1 = await drawerState(cdp);
  console.log(`    抽屜隱藏：${s1.value?.hidden ? '是 ✓' : '否 ✗'}  (rect ${JSON.stringify(s1.value?.rect)})`);
  console.log(`    把手可見：${s1.value?.handleVisible ? '是 ✓' : '否 ✗'}`);
  console.log(`    抽屜內頻道數：${s1.value?.channelCards ?? '?'}`);
  console.log(
    `    抽屜外的頻道卡片：${s1.value?.cardsOutsideDrawer ?? '?'}  ${s1.value?.cardsOutsideDrawer === 0 ? '✓ 全部收在抽屜裡' : '✗'}`,
  );

  // ── 步驟 2：點把手展開 ──
  console.log('\n[2] 點擊「選擇頻道」把手');
  const handleText = await realClick(cdp, `document.querySelector('button[aria-label="選擇頻道"]')`, 'handle');
  console.log(`    點擊：${handleText}`);
  await sleep(900);
  const s2 = await drawerState(cdp);
  console.log(`    抽屜隱藏：${s2.value?.hidden ? '是 ✗' : '否 ✓（已滑入）'}  (rect ${JSON.stringify(s2.value?.rect)})`);
  console.log(`    把手可見：${s2.value?.handleVisible ? '是' : '否 ✓（已淡出）'}`);
  console.log(`    抽屜內頻道數：${s2.value?.channelCards ?? '?'}`);

  // ── 步驟 3：選頻道後自動收起 ──
  console.log('\n[3] 點選抽屜內的一個頻道');
  const picked = await realClick(
    cdp,
    `document.querySelector('aside[aria-label="頻道選擇"] button[class*="drawerCard"]')`,
    'channel',
  );
  console.log(`    點選：${picked}`);
  await sleep(1200);
  const s3 = await drawerState(cdp);
  console.log(`    抽屜隱藏：${s3.value?.hidden ? '是 ✓（已自動收起）' : '否 ✗'}  (rect ${JSON.stringify(s3.value?.rect)})`);
  console.log(`    把手可見：${s3.value?.handleVisible ? '是 ✓' : '否 ✗'}`);

  const pass =
    s1.value?.hidden &&
    s1.value?.handleVisible &&
    s1.value?.cardsOutsideDrawer === 0 &&
    !s2.value?.hidden &&
    !s2.value?.handleVisible &&
    s3.value?.hidden &&
    s3.value?.handleVisible;

  console.log('\n判定：');
  console.log(`  ${pass ? '✓ 全部通過' : '✗ 有項目未通過'}`);
  console.log('\n結果：' + (pass ? '✓ 通過' : '✗ 未通過'));
  process.exit(pass ? 0 : 1);
}

try {
  await main();
} catch (e) {
  console.error('測試失敗：', e.message);
  process.exit(1);
}
