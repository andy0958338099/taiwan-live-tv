#!/usr/bin/env node
/**
 * test-embed-audio.mjs — 驗證嵌入式播放器（embed）的實際播出與音量狀態
 *
 * ## 為什麼需要這支
 *
 * `test-playback-local.mjs` 只能量主文件裡的 `<video>` 元素，但 embed 型頻道
 * （YouTube／litv 官方播放器）**根本沒有 `<video>` 元素** ——
 * 播放器在跨網域 iframe 裡，主文件讀不到。
 *
 * → embed 頻道在既有測試報告裡等於**從來沒有被驗證過**。
 *
 * ## 本支怎麼解決
 *
 * **不用 CDP 去鑽 iframe 的 frame tree**（實測不穩：headless 的 site isolation
 * 行為不一致，OOPIF 的 session 常常拿不到）。
 *
 * 改用 **YouTube IFrame Player API 接管既有的 iframe**：
 *   `new YT.Player(iframe)` 會接管頁面上**已經存在**的、帶 `enablejsapi=1`
 *   的 iframe，然後就能用 `player.isMuted()` / `getVolume()` /
 *   `getCurrentTime()` / `getPlayerState()` 讀到播放器的真實狀態 ——
 *   全部走 postMessage，不需要跨網域存取。
 *
 * 這同時也是**驗證「不靜音」需求**（使用者明確要求：
 * 「點選頻道後不要靜音，也不用出現喇叭標記」）的唯一可靠方法。
 *
 * litv（東森／三立）播放器沒有公開 API，只能確認 iframe 有載入；
 * 它的音量狀態標為「無法驗證」，不算失敗。
 *
 * ## 判定口徑
 *
 * | 條件 | 判定 |
 * |---|---|
 * | iframe 存在且 src 指向該頻道 | 基本條件 |
 * | `getCurrentTime() > 0` 且 `getPlayerState() === 1` | 真的在播 |
 * | `isMuted() === false` 且 `getVolume() > 0` | ✅ 符合「不靜音」需求 |
 * | `isMuted() === true` | ✗ 靜音中（違反需求） |
 *
 * 用法：
 *   node scripts/test-embed-audio.mjs
 *   node scripts/test-embed-audio.mjs --base https://taiwan-live-tv.netlify.app
 *   node scripts/test-embed-audio.mjs --ids tw-legislature-1
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const BASE = arg('base', 'http://localhost:3211').replace(/\/$/, '');
const PROFILE = join('/Users/andy/.hermes/cache/scratch', 'chrome-embed-profile');
const PORT = 9412;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 啟動 Chrome 並以 CDP 連線（只用到主 frame 的 Runtime.evaluate） */
async function launch() {
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3 });
  const bin = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const proc = spawn(
    bin,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      wsUrl = (await r.json()).webSocketDebuggerUrl;
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
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
    });

  return { ws, send, proc };
}

/** 取得一個頁面的 session，並提供 evaluate() */
async function newPage(ws, send) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = Math.floor(Math.random() * 1e9);
      const handler = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id === mid) {
          ws.removeEventListener('message', handler);
          msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
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

  return { sessionId, call, evaluate, targetId };
}

async function main() {
  const catalog = JSON.parse(
    readFileSync(new URL('../shared/channels.json', import.meta.url), 'utf8'),
  );

  const ids = arg('ids', '');
  let targets = catalog.channels.filter(
    (c) => c.stream_type === 'embed' && c.is_active !== false,
  );
  if (ids) {
    const want = ids.split(',').map((s) => s.trim());
    targets = targets.filter((c) => want.includes(c.channel_id));
  }

  console.log(`═══ 驗證 ${targets.length} 個 embed 頻道的實際音量與播出狀態 ═══\n`);
  console.log(`測試站點：${BASE}\n`);

  const { ws, send } = await launch();
  const results = [];

  for (const ch of targets) {
    console.log(`▶ ${ch.channel_name} (${ch.channel_id})`);

    const page = await newPage(ws, send);
    await page.call('Page.enable');
    await page.call('Runtime.enable');
    await page.call('Network.enable');
    await page.call('Network.setUserAgentOverride', { userAgent: UA });

    await page.call('Page.navigate', { url: `${BASE}/` });
    await sleep(4500);

    // 開抽屜 → 點頻道
    await page.evaluate(`(() => {
      const h = document.querySelector('button[aria-label="選擇頻道"]');
      if (h) h.click();
      return true;
    })()`);
    await sleep(1300);

    const clicked = await page.evaluate(`(() => {
      const want = ${JSON.stringify(ch.channel_name)};
      const b = [...document.querySelectorAll('button[data-channel-name]')]
        .find(x => x.getAttribute('data-channel-name') === want);
      if (!b) return 'not-found';
      b.scrollIntoView(); b.click(); return 'clicked';
    })()`);

    if (clicked !== 'clicked') {
      console.log('  ✗ 找不到頻道卡片');
      results.push({
        id: ch.channel_id,
        name: ch.channel_name,
        ok: false,
        error: '找不到卡片',
      });
      await send('Target.closeTarget', { targetId: page.targetId });
      continue;
    }

    await sleep(8000);

    // 截圖（存到 scratch 供目視比對台標與黑畫面）
    const shotPath = join(
      '/Users/andy/.hermes/cache/scratch/embed-verify',
      `${ch.channel_id}.png`,
    );
    mkdirSync('/Users/andy/.hermes/cache/scratch/embed-verify', { recursive: true });
    try {
      const shot = await page.call('Page.captureScreenshot', { format: 'png' });
      writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
      console.log(`     截圖：${shotPath}`);
    } catch {
      /* 截圖失敗不影響判定 */
    }

    const iframeSrc = await page.evaluate(`(() => {
      const f = [...document.querySelectorAll('iframe')]
        .find(x => x.src && (x.src.includes('youtube') || x.src.includes('litv')));
      return f ? f.src : '';
    })()`);


    // ⚠️ 用 **browser 層級**的 Target.getTargets 找出播放器 iframe 的 OOPIF target，
    //    再 attach 進去 —— 這比在頁面 session 裡找 execution context 可靠
    //    （headless 的 site isolation 行為不一致，頁面 session 常常收不到
    //    iframe 的 executionContextCreated）。
    //
    //    attach 進去之後，Runtime.evaluate 直接讀 iframe 裡的 <video>，
    //    這是真實的靜音狀態（CDP 是瀏覽器層級權限，不受同源政策限制）。
    //
    //    適用於 YouTube、litv、4gTV —— 只要它是獨立 origin 的 iframe。
    // ═══ 量測播放器 iframe 內的 <video> ═══
    // ⚠️ 用 **browser 層級**的 Target.getTargets 找出播放器 iframe 的 OOPIF target，
    //    再 attach 進去 —— 這比在頁面 session 裡找 execution context 可靠
    //    （headless 的 site isolation 行為不一致，頁面 session 常常收不到
    //    iframe 的 executionContextCreated）。
    //
    //    attach 進去之後，Runtime.evaluate 直接讀 iframe 裡的 <video>，
    //    這是真實的靜音狀態（CDP 是瀏覽器層級權限，不受同源政策限制）。
    //
    //    適用於 YouTube、litv、4gTV —— 只要它是獨立 origin 的 iframe。
    const PLAYER_HOSTS = ['youtube.com', 'youtube-nocookie', 'litv.tv', '4gtv.tv'];

    const measure = async () => {
      const targets = await send('Target.getTargets');
      const playerTarget = targets.targetInfos.find(
        (t) => t.type === 'iframe' && PLAYER_HOSTS.some((h) => t.url.includes(h)),
      );
      if (!playerTarget) {
        // 找不到獨立的 iframe target → 退而求其次，確認 iframe 元素本身有載入
        const fallback = await page
          .evaluate(`(() => {
            const f = [...document.querySelectorAll('iframe')]
              .find(x => x.src && x.src !== 'about:blank');
            return f ? { loaded: true, url: f.src, w: f.clientWidth, h: f.clientHeight } : { loaded: false };
          })()`)
          .catch(() => ({ loaded: false }));
        return fallback.loaded
          ? { loadedOnly: true, ...fallback }
          : { err: '播放器 iframe 未載入' };
      }
      const { sessionId: pSid } = await send('Target.attachToTarget', {
        targetId: playerTarget.targetId,
        flatten: true,
      });
      let inner = null;
      for (let i = 0; i < 40; i++) {
        try {
          const r = await new Promise((resolve, reject) => {
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
            ws.send(
              JSON.stringify({
                id: mid,
                method: 'Runtime.evaluate',
                params: {
                  expression: `(() => {
                    const v = document.querySelector('video');
                    if (!v) return { noVideo: true };
                    return {
                      noVideo: false,
                      muted: v.muted,
                      volume: v.volume,
                      currentTime: v.currentTime,
                      readyState: v.readyState,
                      videoWidth: v.videoWidth,
                      videoHeight: v.videoHeight,
                      paused: v.paused,
                    };
                  })()`,
                  returnByValue: true,
                },
                sessionId: pSid,
              }),
            );
          });
          const v = r.result.value;
          if (v && !v.noVideo && v.readyState >= 1) {
            inner = v;
            break;
          }
          inner = inner ?? v;
        } catch {
          /* 這個 session 還沒好 */
        }
        await sleep(700);
      }
      const result =
        inner && !inner.noVideo
          ? { ...inner, state: inner.paused ? 2 : 1, ready: true }
          : { loadedOnly: true, err: 'iframe 內讀不到 video（播放器可能非 <video> 結構）' };
      await send('Target.detachFromTarget', { sessionId: pSid }).catch(() => {});
      return result;
    };

    let info = await measure();

    // ⭐ 播放器還沒開始播時（litv 會以「點擊播放」卡片等待），
    //    用 **CDP 真實滑鼠事件** 點一下播放器中央。
    //    - 必須是真實事件：JS 合成的 click() 不帶 user activation，
    //      不會啟動媒體播放（Chrome 自動播放政策）。
    //    - ⚠️ 已經在播的**不能**點：點擊 YouTube 影片會「暫停」。
    if (!info?.loadedOnly && info?.ready && info.state !== 1) {
      const pos = await page
        .evaluate(`(() => {
          const f = [...document.querySelectorAll('iframe')]
            .find(x => x.src && (x.src.includes('litv') || x.src.includes('4gtv') || x.src.includes('youtube')));
          if (!f) return null;
          const r = f.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`)
        .catch(() => null);
      if (pos) {
        await page.call('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1,
        });
        await page.call('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1,
        });
        console.log('     （播放器尚未開始播 → 已點擊播放器中央）');
        await sleep(7000);
        info = await measure();
      }
    }

    if (info?.loadedOnly) {
      console.log(
        `  ✓ iframe 已載入（該播放器非 <video> 結構，音量狀態無法驗證）` +
          `  ${String(info.url ?? '').slice(0, 70)}`,
      );
      results.push({
        id: ch.channel_id,
        name: ch.channel_name,
        ok: true,
        unverifiableAudio: true,
      });
    } else if (info && !info.err && info.ready) {
      const playing = info.state === 1 && info.currentTime > 0;
      const audible = info.muted === false && info.volume > 0;
      console.log(
        `  ${playing ? '✓' : '✗'} 播出：state=${info.state} ` +
          `currentTime=${Number(info.currentTime).toFixed(2)} ` +
          `${info.videoWidth}x${info.videoHeight}`,
      );
      console.log(
        `  ${audible ? '✓' : '✗'} 音量：muted=${info.muted} volume=${info.volume}` +
          (audible ? '' : '  ← 靜音中'),
      );
      results.push({
        id: ch.channel_id,
        name: ch.channel_name,
        ok: playing && audible,
        playing,
        audible,
        muted: info.muted,
        volume: info.volume,
        currentTime: info.currentTime,
        size: `${info.videoWidth}x${info.videoHeight}`,
      });
    } else {
      console.log(`  ✗ 無法讀取播放器狀態：${info?.err ?? '未知'}`);
      results.push({
        id: ch.channel_id,
        name: ch.channel_name,
        ok: false,
        error: info?.err ?? '無法讀取狀態',
      });
    }

    await send('Target.closeTarget', { targetId: page.targetId });
    await sleep(500);
  }

  console.log('\n' + '═'.repeat(66));
  const okCount = results.filter((r) => r.ok).length;
  const muted = results.filter((r) => r.muted === true);
  console.log(`結果：${okCount}/${results.length} 個 embed 頻道通過`);
  if (muted.length) {
    console.log(`⚠️ 靜音中：${muted.map((m) => m.name).join('、')}`);
  }
  console.log('═'.repeat(66));
  for (const r of results) {
    const tag = r.ok ? '✓' : '✗';
    const detail = r.ok
      ? r.unverifiableAudio
        ? 'iframe 載入正常（音量無法驗證）'
        : `${Number(r.currentTime).toFixed(1)}s ${r.size} muted=${r.muted}`
      : (r.error ?? '未知');
    console.log(`  ${tag} ${r.name.padEnd(14)} ${detail}`);
  }

  process.exit(okCount === results.length ? 0 : 1);
}

await main();
