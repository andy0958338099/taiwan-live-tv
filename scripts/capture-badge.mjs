#!/usr/bin/env node
/**
 * capture-badge.mjs —— 拍下 Netlify 徽章壓住頻道卡片的畫面（線上）。
 *
 * 用途：把「徽章蓋到內容」做成視覺證據（存檔 + 截圖），
 * 而不是只有數字（重疊元素清單）。
 *
 * 用法：node scripts/capture-badge.mjs [--base https://taiwan-live-tv.netlify.app]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE =
  (() => {
    const i = process.argv.indexOf('--base');
    return i !== -1 ? process.argv[i + 1] : 'https://taiwan-live-tv.netlify.app';
  })() ?? 'https://taiwan-live-tv.netlify.app';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9381;
const OUT = '/Users/andy/.hermes/cache/scratch';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'badge-cap-'));
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
    return { value: r.result?.result?.value };
  };
  return { send, evalJs };
}

async function main() {
  console.log(`站點：${BASE}`);
  const cdp = await connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.send('Page.navigate', { url: `${BASE}/?t=${Date.now()}` });
  await sleep(4500);

  // 開抽屜 + 捲到最下面，讓徽章正好壓在頻道卡片上
  await cdp.evalJs(`document.querySelector('header button[aria-label="選擇頻道"]')?.click()`);
  await sleep(1200);
  await cdp.evalJs(`(() => {
    const g = document.querySelector('aside[aria-label="頻道選擇"] .Xh1xWG_drawerBody, aside[aria-label="頻道選擇"] div');
    if (g && g.scrollHeight > g.clientHeight) g.scrollTop = g.scrollHeight;
  })()`);
  await sleep(800);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const data = shot?.result?.data ?? shot?.data;
  if (!data) throw new Error(`captureScreenshot 沒有回傳資料：${JSON.stringify(shot).slice(0, 300)}`);
  const file = join(OUT, 'badge-overlap.png');
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`已輸出：${file}`);
}

main().catch((e) => {
  console.error('失敗：', e);
  process.exit(1);
});
