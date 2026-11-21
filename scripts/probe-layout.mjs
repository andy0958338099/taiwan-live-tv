#!/usr/bin/env node
/**
 * probe-layout.mjs —— 傾印 App shell 的版面結構與各區塊矩形。
 *
 * 用途：決定 Netlify 徽章要放哪裡才不會壓到內容。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE =
  (() => {
    const i = process.argv.indexOf('--base');
    return i !== -1 ? process.argv[i + 1] : 'http://localhost:3212';
  })() ?? 'http://localhost:3212';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9391;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'layout-'));
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
  await sleep(4000);

  const dump = async (label) => {
    const r = await cdp.evalJs(`(() => {
      const out = [];
      const walk = (el, depth) => {
        if (depth > 3) return;
        const b = el.getBoundingClientRect();
        out.push({
          d: depth,
          tag: el.tagName.toLowerCase(),
          cls: (typeof el.className === 'string' ? el.className : '').slice(0, 34),
          rect: { y: Math.round(b.top), h: Math.round(b.height), w: Math.round(b.width) },
          pos: getComputedStyle(el).position,
          z: getComputedStyle(el).zIndex,
          overflowY: getComputedStyle(el).overflowY,
        });
        for (const c of el.children) walk(c, depth + 1);
      };
      const main = document.querySelector('main');
      if (main) walk(main, 0);
      const b = document.querySelector('iframe[data-nl-ready]');
      const br = b ? b.getBoundingClientRect() : null;
      return {
        vh: innerHeight,
        drawerH: getComputedStyle(document.documentElement).getPropertyValue('--drawer-h'),
        badge: br ? { y: Math.round(br.top), h: Math.round(br.height), w: Math.round(br.width) } : null,
        tree: out,
      };
    })()`);
    console.log(`\n【${label}】vh=${r.value?.vh}  --drawer-h=${r.value?.drawerH}`);
    console.log(`  徽章：${JSON.stringify(r.value?.badge)}`);
    for (const n of r.value?.tree ?? []) {
      console.log(
        `  ${'  '.repeat(n.d)}<${n.tag}> ${n.cls} rect(y=${n.rect.y} h=${n.rect.h}) pos=${n.pos} z=${n.z} ovf=${n.overflowY}`,
      );
    }
  };

  await dump('抽屜關閉');
  await cdp.evalJs(`document.querySelector('header button[aria-label="選擇頻道"]')?.click()`);
  await sleep(1200);
  await dump('抽屜開啟（half）');
}

main().catch((e) => {
  console.error('失敗：', e);
  process.exit(1);
});
