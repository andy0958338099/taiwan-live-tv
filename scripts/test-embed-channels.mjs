#!/usr/bin/env node
/**
 * test-embed-channels.mjs — 驗證 iframe（embed）型頻道是否真的能播
 *
 * ## 為什麼需要這個測試
 *
 * 專案的 90 個頻道裡有 10 個是 `stream_type: "embed"`（官方播放器嵌入）：
 * 7 個 YouTube 直播、2 個 litv、1 個 4gTV。
 *
 * 這 10 個頻道：
 *   · `verify-channel-sources.mjs` **完全略過**（沒有 stream_url 可探測）
 *   · `test-playback-local.mjs` **無法驗證**（它找的是 `<video>` 元素，
 *     但 embed 模式渲染的是 `<iframe>`，元素不存在 → 一律報「✗」）
 *
 * 結果是：**11% 的頻道沒有任何自動化驗證**。
 * 而它們的 YouTube 直播 ID 會隨場次輪替（見 shared/channels.json 的 notes），
 * ID 一旦失效就是靜默的、可預期的線上故障 —— 而且沒有任何告警。
 *
 * ## 技術重點：怎麼讀跨網域 iframe 裡的 `<video>`
 *
 * 直接在主頁面下 `document.querySelector('video')` **讀不到** ——
 * 那只會找到主頁面自己的 video 元素（embed 模式下根本沒有）。
 * 而 `iframe.contentDocument` 會因為同源政策而丟出例外。
 *
 * 正確做法（CDP）：
 *   1. `Target.getTargets` → 找出 youtube.com / litv.tv 的 **OOPIF target**
 *      （跨網域 iframe 在 Chrome 會跑在獨立 process，所以是獨立 target）
 *   2. `Target.attachToTarget` → 取得該 process 的 session
 *   3. `Page.createIsolatedWorld` → 在該 frame 建立 isolated world
 *      （JS 環境獨立，但**共用同一份 DOM** → 可以繞過同源限制讀到 `<video>`）
 *   4. 在該 context 讀 `currentTime` / `paused` / `videoWidth`
 *
 * ⚠️ 另一個陷阱：**不要用 `Page.navigate` 直接開 `youtube.com/embed/...`**。
 * 那會得到「影片播放器設定錯誤 錯誤 153」——
 * 因為 YouTube 的嵌入播放器要求有正確的 Referer/Origin，
 * 直接開啟等於沒有嵌入者，YouTube 會拒絕。
 * 必須真的把 iframe 放進頁面裡。
 *
 * 用法：
 *   node scripts/test-embed-channels.mjs [--base https://taiwan-live-tv.netlify.app] [--wait 22]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const BASE = arg('base', 'http://localhost:3211');
const WAIT = parseInt(arg('wait', '22'), 10);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9366;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 站台上的 embed 型頻道清單（由 /channels.json 取得，不寫死） */
async function fetchEmbedChannels(base) {
  const res = await fetch(`${base}/channels.json`);
  const data = await res.json();
  return (data.channels ?? []).filter((c) => c.stream_type === 'embed');
}

async function main() {
  console.log('═'.repeat(70));
  console.log('驗證：embed（iframe）型頻道能否實際播放');
  console.log('═'.repeat(70));
  console.log(`測試站點：${BASE}`);

  const targets = await fetchEmbedChannels(BASE);
  if (!targets.length) {
    console.log('（沒有 embed 型頻道）');
    return;
  }
  console.log(`embed 頻道：${targets.length} 個\n`);

  const profile = mkdtempSync(join(tmpdir(), 'embed-test-'));
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

  await sleep(2500);

  const list = await (
    await fetch(`http://127.0.0.1:${PORT}/json/list`)
  ).json();
  const wsUrl = list.find((t) => t.type === 'page').webSocketDebuggerUrl;

  const { default: WS } = await import('ws');
  const ws = new WS(wsUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });

  let msgId = 0;
  const pending = new Map();

  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  const s = (m, p) => send(m, p, sessionId);

  await s('Page.enable');
  await s('Runtime.enable');

  const results = [];

  for (const ch of targets) {
    console.log(`▶ ${ch.channel_name} (${ch.channel_id})`);

    await s('Page.navigate', { url: `${BASE}/` });
    await sleep(3000);

    // 開抽屜 —— 頻道卡片收在抽屜裡，預設收合（translate 到畫面外），
    // 不打開的話卡片座標在視窗外，滑鼠事件點不到。
    const handleBox = await s('Runtime.evaluate', {
      expression: `(() => {
        const h = document.querySelector('button[aria-label="選擇頻道"]');
        if (!h) return null;
        h.scrollIntoView({ block: 'center' });
        const r = h.getBoundingClientRect();
        return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
      })()`,
      returnByValue: true,
    });
    const hb = handleBox.result.value;
    if (hb) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await s('Input.dispatchMouseEvent', {
          type, x: hb.x, y: hb.y, button: 'left', clickCount: 1,
        });
      }
      await sleep(800);
    }

    // 點擊頻道卡片 —— 用真實滑鼠事件（CDP Input.dispatchMouseEvent）
    const clicked = await s('Runtime.evaluate', {
      expression: `(() => {
        const want = ${JSON.stringify(ch.channel_name)};
        const aside = document.querySelector('aside[aria-label="頻道選擇"]');
        const root = aside || document;
        // ⭐ 用 data-channel-name 找卡片，不要用 [class*="cardName"]。
        //
        // CSS module 會把 .drawerCardName 編譯成 <hash>_drawerCardName，
        // 而且類別名一改選擇器就跟著失效（實測 2026-11-22：
        // 抽屜重設計把 .cardName 改名成 .drawerCardName，
        // 大小寫不同 → [class*="cardName"] 匹配 0 個，
        // 這個測試於是 10/10 全數誤判為失敗）。
        // data-* 屬性不受 CSS 改名影響。
        const btns = [...root.querySelectorAll('button[data-channel-name]')];
        const hit = btns.find(b => b.getAttribute('data-channel-name') === want);
        if (!hit) return { err: 'no card', found: btns.length };
        hit.scrollIntoView({ block: 'center' });
        const r = hit.getBoundingClientRect();
        return {
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
        };
      })()`,
      returnByValue: true,
    });

    const pt = clicked.result.value;
    if (!pt || pt.err) {
      console.log('  ✗ 找不到頻道卡片');
      results.push({ channel_id: ch.channel_id, ok: false, reason: '找不到卡片' });
      continue;
    }

    for (const type of ['mousePressed', 'mouseReleased']) {
      await s('Input.dispatchMouseEvent', {
        type, x: pt.x, y: pt.y, button: 'left', clickCount: 1,
      });
    }

    // 等待 iframe 掛載 + 開始播放
    const deadline = Date.now() + WAIT * 1000;
    let best = null;
    let iframeSrc = null;
    let sawFrame = false;

    while (Date.now() < deadline) {
      await sleep(2500);

      // 站台頁面上的 iframe（確認 embed 播放器有掛載）
      const hostInfo = await s('Runtime.evaluate', {
        expression: `(() => {
          const ifr = [...document.querySelectorAll('iframe')].find(f => f.clientWidth > 100);
          return ifr ? { src: (ifr.getAttribute('src')||'').slice(0,140), w: ifr.clientWidth, h: ifr.clientHeight } : null;
        })()`,
        returnByValue: true,
      });
      if (hostInfo.result.value) iframeSrc = hostInfo.result.value.src;

      // 找出 embed 的 OOPIF target（跨網域 iframe 跑在獨立 process）
      const tg = await send('Target.getTargets');
      const frames = tg.targetInfos.filter(
        (t) =>
          t.type === 'iframe' &&
          /youtube\.com|player\.svc\.litv\.tv|embed\.4gtv\.tv/.test(t.url),
      );
      if (!frames.length) continue;
      sawFrame = true;

      for (const f of frames) {
        let sid;
        try {
          const att = await send('Target.attachToTarget', {
            targetId: f.targetId,
            flatten: true,
          });
          sid = att.sessionId;
          await send('Page.enable', {}, sid);
          await send('Runtime.enable', {}, sid);
          await sleep(400);

          const ft = await send('Page.getFrameTree', {}, sid);
          const all = [];
          const walk = (n) => {
            all.push(n.frame);
            (n.childFrames || []).forEach(walk);
          };
          walk(ft.frameTree);

          for (const fr of all) {
            const w = await send(
              'Page.createIsolatedWorld',
              { frameId: fr.id, worldName: 'embedProbe', grantUniveralAccess: true },
              sid,
            );
            const r = await send(
              'Runtime.evaluate',
              {
                expression: `(() => {
                  const v = document.querySelector('video');
                  return {
                    text: (document.body && document.body.innerText || '').replace(/\\s+/g,' ').slice(0,160),
                    hasVideo: !!v,
                    t: v ? v.currentTime : null,
                    w: v ? v.videoWidth : null,
                    h: v ? v.videoHeight : null,
                    paused: v ? v.paused : null,
                    muted: v ? v.muted : null,
                    readyState: v ? v.readyState : null,
                  };
                })()`,
                contextId: w.executionContextId,
                returnByValue: true,
              },
              sid,
            );
            const st = r.result.value;
            if (!st) continue;
            if (!best || (st.t ?? 0) > (best.video.t ?? 0)) {
              best = { frameUrl: f.url, video: st };
            }
          }
        } catch {
          /* target 可能已銷毀 */
        }
      }

      if (best && best.video.t > 0.5 && !best.video.paused) break;
    }

    const ok = !!(
      best &&
      best.video.hasVideo &&
      best.video.t > 0.5 &&
      !best.video.paused &&
      best.video.w > 0
    );

    if (ok) {
      console.log(
        `  ✓ 播放中 t=${best.video.t.toFixed(1)}s ${best.video.w}x${best.video.h} ` +
          `paused=${best.video.paused} muted=${best.video.muted}`,
      );
    } else if (sawFrame) {
      console.log('  ✗ embed iframe 已載入但未偵測到播放');
      if (best) {
        console.log(
          `     ${JSON.stringify(best.video).slice(0, 220)}\n     frame: ${best.frameUrl.slice(0, 110)}`,
        );
      }
    } else {
      console.log('  ✗ 找不到 embed iframe target（播放器未載入）');
      if (iframeSrc) console.log(`     站台上的 iframe src: ${iframeSrc}`);
    }

    results.push({
      channel_id: ch.channel_id,
      channel_name: ch.channel_name,
      ok,
      iframe: iframeSrc,
      video: best?.video ?? null,
    });
  }

  const passed = results.filter((r) => r.ok).length;
  console.log('');
  console.log('═'.repeat(70));
  console.log(`結果：${passed}/${results.length} 個 embed 頻道播放成功`);
  console.log('═'.repeat(70));
  for (const r of results) {
    console.log(
      `  ${r.ok ? '✓' : '✗'} ${(r.channel_name || '').padEnd(18)} ` +
        `t=${r.video?.t !== undefined && r.video.t !== null ? r.video.t.toFixed(1) : '—'}` +
        (r.ok ? '' : '  （未偵測到播放）'),
    );
  }

  writeFileSync(
    '/Users/andy/.hermes/cache/scratch/embed-channels.json',
    JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 2),
  );

  try {
    ws.close();
  } catch {}
  try {
    process.kill(-chrome.pid);
  } catch {}
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}

  process.exit(passed === results.length ? 0 : 1);
}

main();
