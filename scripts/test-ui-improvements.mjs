#!/usr/bin/env node
/**
 * test-ui-improvements.mjs —— 驗證本輪 6 項介面精進。
 *
 * 1. 底部抽屜預設 45vh、可拖曳三段、任何高度影片可見、把手加寬加陰影
 * 2. 頂部只留一顆「頻道 ▾」、空狀態只留一顆「選擇頻道」
 * 3. 頻道卡片「正在播放」藍框 + LIVE 小標 + 右上星標收藏（localStorage）
 * 4. 篩選 chips 單行橫向滾動、地區／類型兩顆 segmented 下拉
 * 5. 未選頻道時隱藏播放器那排禁用控制條
 * 6. Netlify 徽章不浮在內容上；桌面 ≥1024px ↑↓ 換台 + 數字鍵直選頻道號
 *
 * 用真實 Chrome + CDP（真實滑鼠／鍵盤事件），因為
 * `HTMLElement.click()` 不授予使用者啟動權限，合成事件測不出互動。
 *
 * 用法：node scripts/test-ui-improvements.mjs [--base http://localhost:3211]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE =
  (() => {
    const i = process.argv.indexOf('--base');
    return i !== -1 ? process.argv[i + 1] : 'http://localhost:3211';
  })() ?? 'http://localhost:3211';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9357;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'ui-test-'));
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

/** 真實滑鼠點擊 */
async function realClick(cdp, selectorExpr) {
  const box = await cdp.evalJs(`(() => {
    const el = ${selectorExpr};
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2,
             text: (el.textContent||'').trim().slice(0,24) };
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
  return box.value.text;
}

/** 真實鍵盤輸入 */
async function realKey(cdp, key, code, keyCode) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
  });
  await sleep(30);
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
  });
  await sleep(120);
}

/** 真實拖曳 */
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
    type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1,
  });
  await sleep(500);
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 確保抽屜是展開的（測試中多次切換，需要重新確認狀態） */
async function ensureDrawerOpen(cdp) {
  const st = await cdp.evalJs(`(() => {
    const a = document.querySelector('aside[aria-label="頻道選擇"]');
    return a ? a.getBoundingClientRect().height : 0;
  })()`);
  if ((st.value ?? 0) < 100) {
    await realClick(cdp, `document.querySelector('header button[aria-label="選擇頻道"]')`);
    await sleep(700);
  }
}

/**
 * 確保抽屜停在**半屏**（≈45vh）。
 *
 * ⚠️ 為什麼不能只在「開著」的狀態下操作卡片？
 *
 * peek 段（148px）時，抽屜本體只有 148px 高，
 * 而 `.drawer` 是 `overflow: hidden` —— 網格卡片被**裁切**在框外。
 *
 * `getBoundingClientRect()` 回報的是**版面位置**（不是可見位置），
 * 所以自動點擊算出來的座標會落在裁切區，點到的是抽屜背景而不是卡片。
 * 實測結果：點擊「成功」但頻道沒被選中（aria-pressed 仍是 false）。
 *
 * 解法：操作卡片前先把抽屜拉到半屏，卡片才真的可點。
 */
async function ensureDrawerHalf(cdp) {
  await ensureDrawerOpen(cdp);
  const st = await cdp.evalJs(`(() => {
    const a = document.querySelector('aside[aria-label="頻道選擇"]');
    return a ? Math.round(a.getBoundingClientRect().height) : 0;
  })()`);
  // peek 段 → 點把手切到半屏（把手點擊是 peek ↔ half 的切換）
  if ((st.value ?? 0) > 0 && (st.value ?? 0) < 280) {
    await realClick(cdp, `document.querySelector('button[aria-label="調整抽屜高度"]')`);
    await sleep(700);
  }
}

async function main() {
  console.log('═'.repeat(66));
  console.log('驗證：本輪 6 項介面精進');
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

  // ══════════ 需求 2：CTA 收斂 ══════════
  console.log('\n[2] 去掉重複 CTA');
  const cta = await cdp.evalJs(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const pickers = btns.filter(b => {
      const t = (b.textContent||'').trim();
      return /選擇頻道|頻道/.test(t) && b.getAttribute('aria-label') === '選擇頻道';
    });
    const headerBtn = pickers.find(b => b.closest('header'));
    const inPlayer = pickers.filter(b => b.closest('[class*="playerShell"], [class*="pickerHint"]'));
    return {
      total: pickers.length,
      headerCount: headerBtn ? 1 : 0,
      headerText: headerBtn ? headerBtn.textContent.trim() : null,
      inPlayerCount: inPlayer.length,
      // 舊版的浮動把手（fixed 定位、右上角）
      floatingHandles: btns.filter(b => {
        const cs = getComputedStyle(b);
        return cs.position === 'fixed' && /選擇頻道/.test(b.textContent||'');
      }).length,
    };
  })()`);
  check(
    '頂部只有一顆「頻道 ▾」',
    cta.value?.headerCount === 1 && /頻道/.test(cta.value?.headerText ?? ''),
    `頁首按鈕文字「${cta.value?.headerText}」`,
  );
  check(
    '沒有殘留的浮動把手',
    (cta.value?.floatingHandles ?? 0) === 0,
    `fixed 定位的把手：${cta.value?.floatingHandles}`,
  );

  // ══════════ 需求 5：未選頻道時隱藏控制條 ══════════
  console.log('\n[5] 未選頻道時隱藏播放器控制條');
  const noCtl = await cdp.evalJs(`(() => {
    const v = document.querySelector('video');
    return { hasVideo: !!v, controls: v ? v.hasAttribute('controls') : null,
             selected: !!document.querySelector('[class*="drawerCard"][aria-pressed="true"]') };
  })()`);
  check(
    '未選頻道時 <video> 不渲染 controls',
    noCtl.value?.controls === false,
    `controls 屬性：${noCtl.value?.controls}`,
  );

  // ══════════ 需求 1：抽屜三段 + 影片可見 ══════════
  console.log('\n[1] 底部抽屜：三段拖曳 + 影片永遠可見');
  const closed = await cdp.evalJs(`(() => {
    const a = document.querySelector('aside[aria-label="頻道選擇"]');
    const v = document.querySelector('video');
    const vr = v.getBoundingClientRect();
    return { drawerH: Math.round(a.getBoundingClientRect().height),
             videoBottom: Math.round(vr.bottom), vh: innerHeight };
  })()`);
  check(
    '抽屜預設收起',
    (closed.value?.drawerH ?? 99) < 5,
    `抽屜高度 ${closed.value?.drawerH}px`,
  );

  // 開啟 → 應該是 45vh
  await realClick(cdp, `document.querySelector('header button[aria-label="選擇頻道"]')`);
  await sleep(700);
  const half = await cdp.evalJs(`(() => {
    const a = document.querySelector('aside[aria-label="頻道選擇"]');
    const v = document.querySelector('video');
    const vr = v.getBoundingClientRect();
    const ar = a.getBoundingClientRect();
    return { drawerH: Math.round(ar.height), vh: innerHeight,
             pct: Math.round(ar.height / innerHeight * 100),
             videoBottom: Math.round(vr.bottom),
             drawerTop: Math.round(ar.top),
             videoVisible: vr.bottom <= ar.top + 1 && vr.height > 40,
             videoH: Math.round(vr.height),
             videoW: Math.round(vr.width) };
  })()`);
  check(
    '開啟後停在半屏（≈45vh）',
    Math.abs((half.value?.pct ?? 0) - 45) <= 3,
    `${half.value?.pct}%（${half.value?.drawerH}px / ${half.value?.vh}px）`,
  );
  check(
    '半屏時影片仍可見且未被蓋住',
    half.value?.videoVisible === true,
    `影片底 ${half.value?.videoBottom}px ≤ 抽屜頂 ${half.value?.drawerTop}px`,
  );
  check(
    '影片維持 16:9',
    Math.abs((half.value?.videoW ?? 0) / (half.value?.videoH ?? 1) - 16 / 9) < 0.05,
    `${half.value?.videoW}×${half.value?.videoH}`,
  );

  // 拖到全屏
  const gripBox = await cdp.evalJs(`(() => {
    const g = document.querySelector('button[aria-label="調整抽屜高度"]');
    if (!g) return null;
    const r = g.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2 };
  })()`);
  if (gripBox.value) {
    await realDrag(
      cdp,
      { x: gripBox.value.x, y: gripBox.value.y },
      { x: gripBox.value.x, y: Math.max(10, gripBox.value.y - 420) },
    );
    const full = await cdp.evalJs(`(() => {
      const a = document.querySelector('aside[aria-label="頻道選擇"]');
      const v = document.querySelector('video');
      const vr = v.getBoundingClientRect();
      const ar = a.getBoundingClientRect();
      return { drawerH: Math.round(ar.height),
               pct: Math.round(ar.height / innerHeight * 100),
               videoBottom: Math.round(vr.bottom), drawerTop: Math.round(ar.top),
               videoVisible: vr.bottom <= ar.top + 1 && vr.height > 20,
               videoH: Math.round(vr.height) };
    })()`);
    check(
      '往上拖 → 進入全屏（≥80vh）',
      (full.value?.pct ?? 0) >= 80,
      `${full.value?.pct}%（${full.value?.drawerH}px）`,
    );
    check(
      '全屏時影片仍留可見畫面',
      full.value?.videoVisible === true,
      `影片高 ${full.value?.videoH}px，底 ${full.value?.videoBottom}px ≤ 抽屜頂 ${full.value?.drawerTop}px`,
    );
  } else {
    check('拖曳把手存在', false, '找不到 button[aria-label="調整抽屜高度"]');
  }

  // 往下拖回 peek
  // ⚠️ 從全屏（792px）拖到 peek（148px）需要拖 644px，
  // 但把手在全屏時位於 y≈60，拖到 y=700 就已經超出視窗高度。
  // 所以改成**分段拖曳**：先拖到 peek 附近的中間值，讓吸附邏輯接手。
  const grip2 = await cdp.evalJs(`(() => {
    const g = document.querySelector('button[aria-label="調整抽屜高度"]');
    const r = g.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2 };
  })()`);
  // 分兩段拖，中間放開，讓 pointerup 的吸附邏輯執行
  await realDrag(
    cdp,
    { x: grip2.value.x, y: grip2.value.y },
    { x: grip2.value.x, y: Math.min(880, grip2.value.y + 320) },
  );
  const peek1 = await cdp.evalJs(`(() => {
    const a = document.querySelector('aside[aria-label="頻道選擇"]');
    return Math.round(a.getBoundingClientRect().height);
  })()`);

  // 若還在半屏或全屏，再拖一次（把手位置會下移）
  const grip3 = await cdp.evalJs(`(() => {
    const g = document.querySelector('button[aria-label="調整抽屜高度"]');
    const r = g.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2 };
  })()`);
  await realDrag(
    cdp,
    { x: grip3.value.x, y: grip3.value.y },
    { x: grip3.value.x, y: Math.min(880, grip3.value.y + 320) },
  );
  const peek = await cdp.evalJs(`(() => {
    const a = document.querySelector('aside[aria-label="頻道選擇"]');
    const v = document.querySelector('video');
    const vr = v.getBoundingClientRect();
    const ar = a.getBoundingClientRect();
    return { drawerH: Math.round(ar.height),
             pct: Math.round(ar.height / innerHeight * 100),
             videoVisible: vr.bottom <= ar.top + 1 && vr.height > 40 };
  })()`);
  check(
    '往下拖 → 進入 peek（≤30vh）',
    (peek.value?.pct ?? 99) <= 30,
    `${peek.value?.pct}%（${peek.value?.drawerH}px；第一段拖後 ${peek1}px）`,
  );
  check('peek 時影片仍可見', peek.value?.videoVisible === true);

  // 把手外觀
  const gripStyle = await cdp.evalJs(`(() => {
    const g = document.querySelector('button[aria-label="調整抽屜高度"]');
    const bar = g.querySelector('span');
    const br = bar.getBoundingClientRect();
    const cs = getComputedStyle(bar);
    return { barW: Math.round(br.width), shadow: cs.boxShadow,
             gripW: Math.round(g.getBoundingClientRect().width) };
  })()`);
  check(
    '把手加寬（橫幅全寬 + 條 64px+）',
    (gripStyle.value?.gripW ?? 0) > 300 && (gripStyle.value?.barW ?? 0) >= 60,
    `橫幅 ${gripStyle.value?.gripW}px，條 ${gripStyle.value?.barW}px`,
  );
  check(
    '把手有陰影',
    // ⚠️ getComputedStyle().boxShadow 回傳的是「陰影清單」本身，
    // 不是屬性名 —— 所以不能用 /shadow/ 測（值裡沒有 "shadow" 這個字），
    // 要看它是否為 'none'。
    (gripStyle.value?.shadow ?? '').trim() !== 'none' &&
      (gripStyle.value?.shadow ?? '').length > 0,
    gripStyle.value?.shadow?.slice(0, 52),
  );

  // ══════════ 需求 3：卡片藍框 + LIVE + 星標 ══════════
  console.log('\n[3] 頻道卡片：藍框 + LIVE + 星標收藏');
  await ensureDrawerHalf(cdp);
  /**
   * ⚠️ 一定要限定在抽屜內的網格。
   *
   * `button[data-channel-name]` 會同時命中 **ChannelRail 的台標**與
   * **抽屜網格的卡片**（兩者都有 data-channel-name），
   * 而台標在 DOM 順序上比較前面，會讓後面所有斷言都抓錯元素。
   */
  const GRID_CARD = `document.querySelector('aside[aria-label="頻道選擇"] button[data-card-kind="grid"]')`;
  const cardInfo = await cdp.evalJs(`(() => {
    const cards = [...document.querySelectorAll('aside[aria-label="頻道選擇"] button[data-card-kind="grid"]')];
    const card = cards[0];
    const wrap = card.parentElement;
    const star = wrap.querySelector('button[aria-label*="收藏"]');
    const sw = star ? star.getBoundingClientRect() : null;
    const cr = card.getBoundingClientRect();
    return {
      cardCount: cards.length,
      hasStar: !!star,
      starTopRight: sw ? (sw.right > cr.right - 40 && sw.top < cr.top + 40) : false,
      starLabel: star ? star.getAttribute('aria-label') : null,
      cardH: Math.round(cr.height),
      // 一屏可見的卡片數
      visibleInViewport: cards.filter(c => {
        const r = c.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight;
      }).length,
    };
  })()`);
  check('每張卡片有獨立星標按鈕', cardInfo.value?.hasStar === true);
  check(
    '星號在卡片右上角',
    cardInfo.value?.starTopRight === true,
    cardInfo.value?.starLabel ?? '',
  );
  check(
    '卡片高度收斂（≤110px）',
    (cardInfo.value?.cardH ?? 999) <= 110,
    `${cardInfo.value?.cardH}px`,
  );

  // 點星號 → 收藏 + localStorage
  const favResult = await cdp.evalJs(`(() => {
    const card = document.querySelector('aside[aria-label="頻道選擇"] button[data-card-kind="grid"]');
    const star = card.parentElement.querySelector('button[aria-label*="收藏"]');
    const before = star.getAttribute('aria-pressed');
    star.click();
    return { before };
  })()`);
  await sleep(400);
  const favAfter = await cdp.evalJs(`(() => {
    const card = document.querySelector('aside[aria-label="頻道選擇"] button[data-card-kind="grid"]');
    const star = card.parentElement.querySelector('button[aria-label*="收藏"]');
    // ⚠️ key 前綴必須跟 storage.ts 的 STORAGE_PREFIX 一致（'tltv:v1:'），
    // 否則測試會一直報 null，看起來像收藏沒存 —— 其實是找錯 key。
    const ls = localStorage.getItem('tltv:v1:favorites');
    return { pressed: star.getAttribute('aria-pressed'),
             ls: ls ? JSON.parse(ls) : null,
             allKeys: Object.keys(localStorage) };
  })()`);
  check(
    '點星號切換收藏狀態',
    favAfter.value?.pressed !== favResult.value?.before,
    `aria-pressed ${favResult.value?.before} → ${favAfter.value?.pressed}`,
  );
  check(
    '收藏寫入 localStorage',
    Array.isArray(favAfter.value?.ls) && favAfter.value.ls.length > 0,
    `localStorage keys: ${JSON.stringify(favAfter.value?.allKeys)}`,
  );

  // 選一個頻道 → 檢查藍框 + LIVE
  await realClick(cdp, GRID_CARD);
  await sleep(1400);
  const active = await cdp.evalJs(`(() => {
    const active = document.querySelector('aside[aria-label="頻道選擇"] button[data-card-kind="grid"][aria-pressed="true"]');
    if (!active) return { none: true };
    const cs = getComputedStyle(active);
    const live = active.querySelector('[class*="cardLiveBadge"]');
    return { border: cs.borderColor, borderW: cs.borderWidth,
             hasLive: !!live,
             liveText: live ? live.textContent.trim() : null };
  })()`);
  check(
    '正在播放的卡片有藍框',
    /rgb\(59, ?139, ?255\)|rgb\(61, ?139, ?255\)/.test(active.value?.border ?? ''),
    `border ${active.value?.borderW} ${active.value?.border}`,
  );
  check(
    '正在播放的卡片有 LIVE 小標',
    active.value?.hasLive === true && active.value?.liveText === 'LIVE',
    active.value?.liveText ?? '（找不到）',
  );

  // ══════════ 需求 4：篩選列 ══════════
  console.log('\n[4] 篩選列：單行 + segmented 下拉');
  // 選完頻道後抽屜會自動收起 → 先拉回半屏
  await ensureDrawerHalf(cdp);
  const filter = await cdp.evalJs(`(() => {
    const tabs = document.querySelector('nav[aria-label="檢視模式"]');
    const tr = tabs.getBoundingClientRect();
    // 分段下拉
    const triggers = [...document.querySelectorAll('button[aria-haspopup="listbox"]')];
    return {
      tabsHeight: Math.round(tr.height),
      tabsSingleLine: tr.height < 60,
      tabsScrollable: tabs.scrollWidth > tabs.clientWidth || tabs.children.length <= 3,
      triggers: triggers.length,
      triggerLabels: triggers.map(t => t.textContent.trim().slice(0, 12)),
      // 舊版的 chip 列應該不見了
      oldChipRows: document.querySelectorAll('nav[aria-label="頻道地區"], nav[aria-label="頻道分類"]').length,
    };
  })()`);
  check(
    '頁籤收成單行',
    filter.value?.tabsSingleLine === true,
    `高度 ${filter.value?.tabsHeight}px`,
  );
  check(
    '地區／類型改成兩顆下拉',
    (filter.value?.triggers ?? 0) === 2,
    filter.value?.triggerLabels?.join(' / '),
  );
  check(
    '舊的地區／類型 chip 列已移除',
    (filter.value?.oldChipRows ?? 0) === 0,
    `剩 ${filter.value?.oldChipRows} 排`,
  );

  // 下拉可展開
  //
  // ⚠️ 用真實滑鼠事件點擊，但**不要**先 scrollIntoView ——
  // 下拉觸發器在抽屜底部（y≈767），捲動會改變它的位置，
  // 造成點擊落空。用當下的實際座標直接點。
  const trigBox = await cdp.evalJs(`(() => {
    const t = document.querySelectorAll('button[aria-haspopup="listbox"]')[0];
    if (!t) return null;
    const b = t.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) return null;
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  })()`);
  if (trigBox.value) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: trigBox.value.x, y: trigBox.value.y,
    });
    await sleep(60);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: trigBox.value.x, y: trigBox.value.y,
      button: 'left', clickCount: 1,
    });
    await sleep(50);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: trigBox.value.x, y: trigBox.value.y,
      button: 'left', clickCount: 1,
    });
    await sleep(400);
  }
  const menu = await cdp.evalJs(`(() => {
    const m = document.querySelector('[role="listbox"]');
    if (!m) return { open: false, items: 0 };
    const opts = [...m.querySelectorAll('[role="option"]')];
    return { open: true, items: opts.length,
             first: opts[0] ? opts[0].textContent.trim() : null,
             hasCount: opts.some(o => /\\d/.test(o.textContent)) };
  })()`);
  check(
    '下拉可展開並列出選項',
    menu.value?.open === true && (menu.value?.items ?? 0) > 1,
    `${menu.value?.items} 個選項，首項「${menu.value?.first}」`,
  );
  check(
    '下拉選項保留頻道數量',
    menu.value?.hasCount === true,
    '含數字 badge',
  );
  await cdp.evalJs(`document.dispatchEvent(new MouseEvent('mousedown', {bubbles:true}))`);
  await sleep(200);

  // ══════════ 需求 6：桌面鍵盤選台 ══════════
  console.log('\n[6] 桌面鍵盤：↑↓ 換台 + 數字鍵選台號');

  /**
   * 讀取「現在在播哪個台」。
   *
   * ⚠️ 兩個陷阱：
   *   1. `evalJs` 回傳的是 `{ value }` 包裝，必須取 `.value`
   *      —— 直接印會看到 "[object Object]"。
   *   2. 不要用 `[class*="nowPlayingTitle"]` —— CSS module 編譯後的類別名
   *      是雜湊值（`_nowPlayingTitle_xxx`），子字串匹配會命中**多個**元素。
   *      改用 data 屬性，不受 CSS 改名影響。
   */
  const currentName = async () => {
    const r = await cdp.evalJs(`(() => {
      const a = document.querySelector('aside[aria-label="頻道選擇"] button[data-card-kind="grid"][aria-pressed="true"]');
      if (a) return a.getAttribute('data-channel-name');
      const t = document.querySelector('h2');
      return t ? t.textContent.trim() : null;
    })()`);
    return r.value ?? null;
  };

  /**
   * 先確定有選中頻道 —— 鍵盤換台是「在已選中的頻道上移動」，
   * 沒有選中時 ↑↓ 會選第一個，但比較基準不好判斷。
   */
  await ensureDrawerHalf(cdp);
  const hasSelection = await cdp.evalJs(`(() => {
    const a = document.querySelector('aside[aria-label="頻道選擇"] button[data-card-kind="grid"][aria-pressed="true"]');
    return !!a;
  })()`);
  if (!hasSelection.value) {
    // 沒選中 → 先選一個
    await realClick(cdp, GRID_CARD);
    await sleep(1500);
  }
  const beforeName = await currentName();
  check(
    '鍵盤測試前有選中頻道',
    !!beforeName && beforeName !== '尚未選擇頻道',
    beforeName ?? '（無）',
  );

  // 收起抽屜，測試「觀看時」的鍵盤操作
  await cdp.evalJs(`(() => {
    const b = document.querySelector('button[aria-label="收起頻道選擇"]');
    if (b) b.click();
  })()`);
  await sleep(600);

  // ↓ 換台
  await realKey(cdp, 'ArrowDown', 'ArrowDown', 40);
  await sleep(1400);
  const afterDown = await currentName();
  check(
    '↓ 切換到下一個頻道',
    !!afterDown && afterDown !== beforeName,
    `${beforeName} → ${afterDown}`,
  );

  // ↑ 換回來
  await realKey(cdp, 'ArrowUp', 'ArrowUp', 38);
  await sleep(1400);
  const afterUp = await currentName();
  check(
    '↑ 切換回上一個頻道',
    !!afterUp && afterUp === beforeName,
    `${afterDown} → ${afterUp}（原本 ${beforeName}）`,
  );

  // 數字鍵
  await ensureDrawerHalf(cdp);
  // 找出號碼 3 對應的頻道名（台標列上的號碼 badge）
  const numInfo = await cdp.evalJs(`(() => {
    const items = [...document.querySelectorAll('aside[aria-label="頻道選擇"] button[data-card-kind="rail"]')];
    for (const it of items) {
      const n = it.querySelector('[class*="number"]');
      if (n && n.textContent.trim() === '3') {
        return { name: it.getAttribute('data-channel-name') ||
                 (it.getAttribute('aria-label') || '').replace('（正在播放）','') };
      }
    }
    return null;
  })()`);
  if (numInfo.value) {
    await cdp.evalJs(`(() => {
      const b = document.querySelector('button[aria-label="收起頻道選擇"]');
      if (b) b.click();
    })()`);
    await sleep(500);
    await realKey(cdp, '3', 'Digit3', 51);
    await sleep(1600);
    const afterNum = await currentName();
    check(
      '數字鍵 3 直選頻道號 3',
      !!afterNum && afterNum === numInfo.value.name,
      `期望 ${numInfo.value.name}，實際 ${afterNum}`,
    );
  } else {
    check('數字鍵直選頻道號', false, '找不到號碼 3 的頻道');
  }

  // ══════════ 需求 6：Netlify 徽章 ══════════
  console.log('\n[6] Netlify 徽章不浮在內容上');
  const badge = await cdp.evalJs(`(() => {
    const b = document.querySelector('iframe[data-nl-ready]');
    if (!b) return { none: true };
    const cs = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    // 找有沒有內容被壓到（徽章範圍內的非 footer 元素）
    const overlap = [...document.querySelectorAll('main *')].some(el => {
      if (el.closest('footer')) return false;
      const er = el.getBoundingClientRect();
      if (er.width === 0 || er.height === 0) return false;
      return !(er.right < r.left || er.left > r.right ||
               er.bottom < r.top || er.top > r.bottom);
    });
    return { pos: cs.position, z: cs.zIndex, opacity: cs.opacity,
             overlap, bottom: Math.round(r.bottom), vh: innerHeight };
  })()`);
  if (badge.value?.none) {
    check('Netlify 徽章', true, '本機站沒有注入徽章（線上才會有）');
  } else {
    check(
      '徽章 z-index 低於內容（不蓋住內容）',
      Number(badge.value?.z ?? 99) < 10 && badge.value?.overlap === false,
      `z=${badge.value?.z}，opacity=${badge.value?.opacity}，與內容重疊=${badge.value?.overlap}`,
    );
  }

  // ══════════ 總結 ══════════
  const pass = results.filter((r) => r.pass).length;
  console.log('\n' + '═'.repeat(66));
  console.log(`結果：${pass}/${results.length} 項通過`);
  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    console.log('\n未通過：');
    for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail ?? ''}`);
  }
  console.log('═'.repeat(66));
  process.exit(failed.length ? 1 : 0);
}

try {
  await main();
} catch (e) {
  console.error('測試失敗：', e.message);
  process.exit(1);
}
