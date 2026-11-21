#!/usr/bin/env node
/**
 * probe-netlify-badge.mjs —— 診斷 Netlify 徽章到底壓到什麼。
 *
 * 問題：正式站注入 `<iframe data-nl-ready="1">`，預設 fixed 在右下角，
 * 會壓在內容上。globals.css 已降 opacity + 設 z-index，
 * 但 test-ui-improvements 仍判定「與內容重疊=true」。
 *
 * 這個腳本把「重疊的元素」全部列出來（含是否真的有可見文字/控制項），
 * 才能分辨是「真的蓋到可讀內容」還是「只是蓋到空的容器」。
 *
 * 用法：node scripts/probe-netlify-badge.mjs [--base https://taiwan-live-tv.netlify.app]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE =
  (() => {
    const i = process.argv.indexOf('--base');
    return i !== -1 ? process.argv[i + 1] : 'https://taiwan-live-tv.netlify.app';
  })() ?? 'https://taiwan-live-tv.netlify.app';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9371;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'badge-probe-'));
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

const OVERLAP_JS = `(() => {
  const b = document.querySelector('iframe[data-nl-ready]');
  if (!b) return { none: true };
  const cs = getComputedStyle(b);
  const r = b.getBoundingClientRect();
  const items = [];
  for (const el of document.querySelectorAll('main *')) {
    if (el.closest('footer')) continue;
    const er = el.getBoundingClientRect();
    if (er.width === 0 || er.height === 0) continue;
    if (er.right < r.left || er.left > r.right || er.bottom < r.top || er.top > r.bottom) continue;
    // 這個元素是不是「容器」？—— 有沒有自己的可見文字或控制項
    const ownText = [...el.childNodes]
      .filter(n => n.nodeType === 3)
      .map(n => n.textContent.trim())
      .filter(Boolean)
      .join(' ')
      .slice(0, 40);
    const interactive = !!el.querySelector('button, a, input, img');
    const leaf = el.children.length === 0;
    items.push({
      tag: el.tagName.toLowerCase(),
      cls: (el.className && typeof el.className === 'string' ? el.className : '').slice(0, 46),
      ownText,
      interactive,
      leaf,
      rect: { x: Math.round(er.left), y: Math.round(er.top), w: Math.round(er.width), h: Math.round(er.height) },
      z: getComputedStyle(el).zIndex,
      pos: getComputedStyle(el).position,
    });
  }
  return {
    badge: { pos: cs.position, z: cs.zIndex, opacity: cs.opacity,
             rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } },
    items,
  };
})()`;

async function main() {
  console.log('═'.repeat(66));
  console.log('診斷：Netlify 徽章壓到什麼');
  console.log('═'.repeat(66));
  console.log(`站點：${BASE}\n`);

  const cdp = await connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.send('Page.navigate', { url: `${BASE}/?t=${Date.now()}` });
  await sleep(4000);

  const res = await cdp.evalJs(OVERLAP_JS);
  if (res.value?.none) {
    console.log('本機站沒有注入徽章（線上才有）');
    return;
  }

  // 抽屜「開著」才是真實情況 —— 底部抽屜是主要互動區，
  // 徽章若壓到頻道卡片就真的有問題。
  const openDrawer = await cdp.evalJs(`(() => {
    const b = document.querySelector('header button[aria-label="選擇頻道"]');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(1200);

  const res2 = await cdp.evalJs(OVERLAP_JS);
  const items = res2.value?.items ?? [];

  console.log('徽章：', JSON.stringify(res2.value?.badge));
  console.log(`\n重疊元素（抽屜開啟時，${items.length} 個）：`);
  for (const it of items) {
    const kind = it.leaf ? '葉節點' : it.interactive ? '含控制項' : '容器';
    console.log(
      `  · <${it.tag}> [${it.cls}] ${kind}` +
        (it.ownText ? ` 文字「${it.ownText}」` : '') +
        ` pos=${it.pos} z=${it.z} rect=${JSON.stringify(it.rect)}`,
    );
  }
  const meaningful = items.filter((it) => it.ownText || it.interactive || it.leaf);
  console.log(
    `\n有可見文字／控制項的重疊：${meaningful.length} 個 → ` +
      (meaningful.length ? '⚠️ 真的蓋到內容' : '✓ 只蓋到空容器，視覺無害'),
  );
}

main().catch((e) => {
  console.error('診斷失敗：', e);
  process.exit(1);
});
