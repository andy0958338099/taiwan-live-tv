#!/usr/bin/env node
/**
 * probe-ui-regressions.mjs —— 診斷 test-ui-improvements.mjs 的 6 個失敗項目。
 *
 * 目的：區分「實作真的有 bug」與「測試腳本的期待過時 / 前置狀態錯誤」。
 * 每個項目獨立驗證，不依賴其他項目的狀態。
 *
 * 用法：node scripts/probe-ui-regressions.mjs [--base http://localhost:3211]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE =
  (() => {
    const i = process.argv.indexOf('--base');
    return i !== -1 ? process.argv[i + 1] : 'http://localhost:3211';
  })() ?? 'http://localhost:3211';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9361;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'probe-ui-'));
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--headless=new',
    '--disable-gpu',
    '--window-size=1440,900',
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
  const list = await fetchJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const mid = ++id;
      pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text };
    return { value: r.result?.result?.value };
  };
  return { send, evalJs };
}

async function realClick(cdp, selectorExpr) {
  const box = await cdp.evalJs(`(() => {
    const el = ${selectorExpr};
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2 };
  })()`);
  if (!box.value) return null;
  await sleep(200);
  const { x, y } = box.value;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1,
  });
  await sleep(40);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
  });
  await sleep(400);
  return true;
}

async function realDrag(cdp, from, to, steps = 12) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1,
  });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      button: 'left',
      buttons: 1,
    });
    await sleep(30);
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: to.x, y: to.y, button: 'left',
  });
  await sleep(500);
}

async function main() {
  console.log('═'.repeat(66));
  console.log('診斷：test-ui-improvements.mjs 的 6 個失敗項目');
  console.log('═'.repeat(66));
  console.log(`測試站點：${BASE}\n`);

  const cdp = await connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.send('Page.navigate', { url: `${BASE}/?t=${Date.now()}` });
  await sleep(3500);

  // ─────────────────────────────────────────────────────────────
  // 前置狀態：確認抽屜是開還是關
  // ─────────────────────────────────────────────────────────────
  const drawerState = () =>
    cdp.evalJs(`(() => {
      const a = document.querySelector('aside[aria-label="頻道選擇"]');
      if (!a) return { none: true };
      return {
        h: Math.round(a.getBoundingClientRect().height),
        ariaHidden: a.getAttribute('aria-hidden'),
      };
    })()`);

  console.log('【前置】抽屜初始狀態：', JSON.stringify((await drawerState()).value));

  // ─────────────────────────────────────────────────────────────
  // 項目 A：往下拖 → peek（從 half 往下拖，不是從 full）
  // ─────────────────────────────────────────────────────────────
  console.log('\n【A】往下拖 → peek（吸附語意檢查）');
  await realClick(cdp, `document.querySelector('header button[aria-label="選擇頻道"]')`);
  await sleep(700);
  const halfState = await drawerState();
  console.log(`  開啟後高度：${halfState.value?.h}px`);

  const grip = await cdp.evalJs(`(() => {
    const g = document.querySelector('button[aria-label="調整抽屜高度"]');
    const r = g.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2 };
  })()`);
  // 從 half（405px）往下拖 300px → 105px → 應該吸附到 peek(148px)
  await realDrag(
    cdp,
    { x: grip.value.x, y: grip.value.y },
    { x: grip.value.x, y: Math.min(880, grip.value.y + 300) },
  );
  const afterDown = await drawerState();
  const pctAfterDown = Math.round(((afterDown.value?.h ?? 0) / 900) * 100);
  console.log(`  從 half 往下拖 300px → ${afterDown.value?.h}px (${pctAfterDown}%)`);
  console.log(
    `  判定：${pctAfterDown <= 30 ? '✓ peek 可達（吸附正常）' : '✗ 未吸附到 peek'}`,
  );

  // 完整吸附表：從 half 往上拖到 full，再往下拖回
  console.log('\n  完整吸附路徑（half → full → half → peek → closed）：');
  const stages = [];
  const gripNow = async () => {
    const g = await cdp.evalJs(`(() => {
      const el = document.querySelector('button[aria-label="調整抽屜高度"]');
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2 };
    })()`);
    return g.value;
  };
  const g1 = await gripNow();
  await realDrag(cdp, { x: g1.x, y: g1.y }, { x: g1.x, y: Math.max(10, g1.y - 420) });
  stages.push(['往上拖 420px', (await drawerState()).value?.h]);
  const g2 = await gripNow();
  await realDrag(cdp, { x: g2.x, y: g2.y }, { x: g2.x, y: Math.min(880, g2.y + 300) });
  stages.push(['往下拖 300px', (await drawerState()).value?.h]);
  const g3 = await gripNow();
  await realDrag(cdp, { x: g3.x, y: g3.y }, { x: g3.x, y: Math.min(880, g3.y + 300) });
  stages.push(['再往下拖 300px', (await drawerState()).value?.h]);
  for (const [label, h] of stages) {
    console.log(`    ${label} → ${h}px (${Math.round(((h ?? 0) / 900) * 100)}%)`);
  }

  // ─────────────────────────────────────────────────────────────
  // 項目 B：把手陰影 —— 計算樣式不含 "shadow" 字樣
  // ─────────────────────────────────────────────────────────────
  console.log('\n【B】把手陰影（computed boxShadow 的真實內容）');
  const shadow = await cdp.evalJs(`(() => {
    const g = document.querySelector('button[aria-label="調整抽屜高度"]');
    const bar = g.querySelector('span');
    return {
      barShadow: getComputedStyle(bar).boxShadow,
      gripShadow: getComputedStyle(g).boxShadow,
      containsWordShadow: /shadow/.test(getComputedStyle(bar).boxShadow),
    };
  })()`);
  console.log(`  條 boxShadow：${shadow.value?.barShadow}`);
  console.log(`  橫幅 boxShadow：${shadow.value?.gripShadow}`);
  console.log(
    `  判定：${(shadow.value?.barShadow ?? 'none') !== 'none' ? '✓ 有陰影（測試的正則 /shadow/ 誤判）' : '✗ 真的沒陰影'}`,
  );

  // ─────────────────────────────────────────────────────────────
  // 項目 C：收藏 localStorage 的真實 key
  // ─────────────────────────────────────────────────────────────
  console.log('\n【C】收藏寫入 localStorage 的真實 key');
  const fav = await cdp.evalJs(`(() => {
    const card = document.querySelector('button[data-channel-name]');
    if (!card) return { noCard: true };
    const star = card.parentElement.querySelector('button[aria-label*="收藏"]');
    const before = star.getAttribute('aria-pressed');
    star.click();
    const keys = Object.keys(localStorage);
    const values = {};
    for (const k of keys) values[k] = localStorage.getItem(k);
    return { before, keys, values };
  })()`);
  await sleep(400);
  console.log(`  star aria-pressed（點前）：${fav.value?.before}`);
  console.log(`  localStorage keys：${JSON.stringify(fav.value?.keys)}`);
  console.log(`  localStorage 內容：${JSON.stringify(fav.value?.values)}`);
  const favKeys = (fav.value?.keys ?? []).filter((k) => /fav/i.test(k));
  console.log(
    `  判定：${favKeys.length ? '✓ 有寫入（測試查錯 key）' : '✗ 沒寫入任何 favorites key'}`,
  );

  // ─────────────────────────────────────────────────────────────
  // 項目 D/E：抽屜**開著**時點卡片 → 藍框 + LIVE
  // ─────────────────────────────────────────────────────────────
  console.log('\n【D/E】抽屜開啟狀態下點卡片 → 藍框 + LIVE 小標');
  // 先確保抽屜是開的
  const openNow = (await drawerState()).value?.h ?? 0;
  if (openNow < 50) {
    await realClick(cdp, `document.querySelector('header button[aria-label="選擇頻道"]')`);
    await sleep(700);
  }
  console.log(`  點卡片前抽屜高度：${(await drawerState()).value?.h}px`);

  await realClick(cdp, `document.querySelector('button[data-channel-name]')`);
  await sleep(1200);
  const active = await cdp.evalJs(`(() => {
    const a = document.querySelector('button[data-channel-name][aria-pressed="true"]');
    if (!a) return { none: true, cardCount: document.querySelectorAll('button[data-channel-name]').length };
    const cs = getComputedStyle(a);
    const live = a.querySelector('[class*="LiveBadge"], [class*="liveBadge"]');
    return {
      borderColor: cs.borderColor,
      borderWidth: cs.borderWidth,
      boxShadow: cs.boxShadow.slice(0, 60),
      hasLive: !!live,
      liveText: live ? live.textContent.trim() : null,
      name: a.getAttribute('data-channel-name'),
    };
  })()`);
  console.log(`  找到 active 卡片：${!active.value?.none}`);
  console.log(`  border：${active.value?.borderWidth} ${active.value?.borderColor}`);
  console.log(`  boxShadow：${active.value?.boxShadow}`);
  console.log(`  LIVE 小標：${active.value?.hasLive} 「${active.value?.liveText}」`);
  console.log(
    `  判定：${active.value?.hasLive ? '✓ LIVE 小標存在' : '✗ LIVE 小標缺失'}`,
  );
  console.log(
    `  藍框判定：${/rgb\((\d+), ?(\d+), ?(\d+)\)/.test(active.value?.borderColor ?? '') ? '✓ 有 rgb 邊框色' : '✗ 無邊框色'}`,
  );

  // ─────────────────────────────────────────────────────────────
  // 項目 F：下拉可展開並列出選項
  // ─────────────────────────────────────────────────────────────
  console.log('\n【F】SegmentedSelect 下拉展開');
  const drawerH = (await drawerState()).value?.h ?? 0;
  if (drawerH < 50) {
    await realClick(cdp, `document.querySelector('header button[aria-label="選擇頻道"]')`);
    await sleep(700);
  }
  const trigCount = await cdp.evalJs(
    `document.querySelectorAll('button[aria-haspopup="listbox"]').length`,
  );
  console.log(`  下拉觸發器數量：${trigCount.value}`);
  await realClick(cdp, `document.querySelectorAll('button[aria-haspopup="listbox"]')[0]`);
  await sleep(500);
  const menu = await cdp.evalJs(`(() => {
    const m = document.querySelector('[role="listbox"]');
    if (!m) return { open: false, items: 0 };
    return {
      open: true,
      items: m.querySelectorAll('[role="option"]').length,
      first3: [...m.querySelectorAll('[role="option"]')].slice(0,3).map(o => o.textContent.trim()),
    };
  })()`);
  console.log(`  listbox 開啟：${menu.value?.open}`);
  console.log(`  選項數：${menu.value?.items}`);
  console.log(`  前 3 項：${JSON.stringify(menu.value?.first3)}`);
  console.log(
    `  判定：${(menu.value?.items ?? 0) > 1 ? '✓ 下拉可展開' : '✗ 下拉未展開'}`,
  );

  console.log('\n' + '═'.repeat(66));
}

main().catch((e) => {
  console.error('診斷失敗：', e);
  process.exit(1);
});
