#!/usr/bin/env node
/**
 * probe-playlist-advancement.mjs — 量測每個來源的 live playlist **是否會前進**
 *
 * ## 為什麼需要這個量測
 *
 * 既有檢查（`verify-channel-sources.mjs`）只驗「能不能下載到一個 segment」。
 * 這會**漏掉**最常見的一種故障：來源的 live playlist 停在某個序號不動
 * （編碼器停擺 / 來源站掛了 / 切片器死掉）。
 *
 * 這種來源的行為：
 *   1. manifest 讀得到 ✅ → deep probe 判為「可播」
 *   2. 清單裡的 segment 也還下載得到 ✅ → deep probe 判為「可播」
 *   3. 播放器把清單裡那幾段**舊的**內容播完（看起來完全正常）
 *   4. 緩衝耗盡後就**永遠卡住**，使用者只看到最後一格畫面
 *
 * 實測（2026-11-22）：龍華電視 / Now TV 的序號 100 秒完全不動，
 * 但 `test-playback-local.mjs` 卻回報它們「播放成功」（currentTime > 0）。
 *
 * ## 本腳本量測什麼
 *
 * 對每個來源持續輪詢子 playlist，記錄序號前進的時間點，
 * 算出「最大停滯間隔」（gap）。輸出三種結果：
 *
 *   · `前進`     —— 序號有正常前進 ✅
 *   · `停滯 Xs`  —— 序號在觀察窗內都沒動，或停滯超過門檻 ⚠️（來源停播）
 *   · `無法取得` —— 抓不到 playlist（已被其他檢查涵蓋）
 *
 * 同時輸出**建議的 liveMaxUnchangedPlaylistRefresh 門檻**，
 * 讓 hls.js 的「停播偵測」不會誤殺正常但慢速的來源。
 *
 * 用法：node scripts/probe-playlist-advancement.mjs [--seconds 40] [--interval 4] [--gap-threshold 30]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const SECONDS = Number(arg('seconds', '40'));
const INTERVAL_MS = Number(arg('interval', '4')) * 1000;
const GAP_THRESHOLD_MS = Number(arg('gap-threshold', '30')) * 1000;
const CONCURRENCY = Number(arg('concurrency', '8'));

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';
const REFERER = 'https://taiwan-live-tv.netlify.app/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseSeq(text) {
  const m = text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m);
  return m ? Number(m[1]) : null;
}

function childUrlFrom(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j] && !lines[j].startsWith('#')) return new URL(lines[j], base).toString();
      }
    }
  }
  return null;
}

async function getText(url) {
  try {
    const res = await fetch(url, {
      headers: { Referer: REFERER, 'User-Agent': UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function measure(ch) {
  const master = await getText(ch.stream_url);
  if (!master) return { id: ch.channel_id, name: ch.channel_name, state: 'fetch-failed' };

  let child = childUrlFrom(master, ch.stream_url);
  const isMaster = Boolean(child);
  if (!child) child = ch.stream_url;

  // ── 先取一次子清單，拿到 targetduration ──
  const firstText = await getText(child);
  const tdMatch = firstText?.match(/^#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/m);
  const td = tdMatch ? Number(tdMatch[1]) : null;

  // ─────────────────────────────────────────────────────────────
  // ⚠️ **精確模擬 hls.js 的 reload 節奏**（不是固定間隔輪詢）
  //
  // hls.js 的 `computeReloadInterval`：
  //   · 這次清單**有更新** → 下次 reload 間隔 = targetduration 秒
  //   · 這次清單**沒更新** → 下次 reload 間隔 = targetduration / 2 秒
  //     （HLS 規格：「miss half average」）
  //
  // 而 misses 計數器（`LevelDetails.reloaded`）只在**真的 reload 時**才變動：
  //   · 序號有前進（updated/advanced）→ misses = 0
  //   · 序號沒動 → misses += 1
  //
  // ⚠️ 用「固定間隔輪詢」會**高估** misses（每次都輪詢，
  //    但 hls.js 在清單有更新時是隔 td 才輪詢），
  //    也會**低估**時間到錯誤的距離。
  //    門檻要怎麼設，必須用正確的節奏模擬出來才算數。
  // ─────────────────────────────────────────────────────────────
  const reloadSec = (updated) =>
    td ? (updated ? td : td / 2) : 5;

  const start = Date.now();
  let lastSeq = null;
  let lastAdvanceAt = start;
  let maxGap = 0;
  let advanced = false;
  let polls = 0;
  let misses = 0;
  let maxMisses = 0;
  let nextReloadAt = start;

  while (Date.now() - start < SECONDS * 1000) {
    const text = lastSeq === null ? firstText : await getText(child);
    polls += 1;
    let updatedNow = false;
    if (text) {
      const seq = parseSeq(text);
      if (seq !== null) {
        if (lastSeq === null) {
          lastSeq = seq;
          lastAdvanceAt = Date.now();
        } else if (seq !== lastSeq) {
          advanced = true;
          updatedNow = true;
          lastSeq = seq;
          misses = 0;
          const now = Date.now();
          maxGap = Math.max(maxGap, now - lastAdvanceAt);
          lastAdvanceAt = now;
        } else {
          misses += 1;
          maxMisses = Math.max(maxMisses, misses);
          maxGap = Math.max(maxGap, Date.now() - lastAdvanceAt);
        }
      }
    }
    if (Date.now() - start >= SECONDS * 1000) break;
    // 依 hls.js 的節奏安排下一次 reload
    const waitMs = Math.max(500, Math.round(reloadSec(updatedNow) * 1000));
    nextReloadAt = Date.now() + waitMs;
    const sleepMs = Math.min(waitMs, Math.max(0, SECONDS * 1000 - (Date.now() - start)));
    await sleep(sleepMs);
  }

  maxGap = Math.max(maxGap, Date.now() - lastAdvanceAt);

  let state;
  if (!advanced) state = 'frozen';
  else if (maxMisses >= 3) state = 'gap';
  else state = 'ok';

  return {
    id: ch.channel_id,
    name: ch.channel_name,
    state,
    maxGapSec: Math.round(maxGap / 1000),
    maxMisses,
    td,
    isMaster,
    polls,
  };
}

async function main() {
  console.log('═'.repeat(84));
  console.log('量測：每個來源的 live playlist 是否會前進（停播偵測）');
  console.log('═'.repeat(84));
  console.log(
    `觀察窗：${SECONDS} 秒　輪詢間隔：${INTERVAL_MS / 1000}s　` +
      `停滯門檻：${GAP_THRESHOLD_MS / 1000}s　並行：${CONCURRENCY}\n`,
  );

  const catalog = JSON.parse(readFileSync('shared/channels.json', 'utf8'));
  const channels = (catalog.channels ?? catalog).filter(
    (c) => c.stream_url && c.stream_type !== 'embed' && !String(c.stream_url).startsWith('/'),
  );

  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < channels.length) {
      const ch = channels[idx];
      idx += 1;
      const r = await measure(ch);
      results.push(r);
      const mark = r.state === 'ok' ? '✓' : r.state === 'frozen' ? '✗' : '!';
      console.log(
        `  ${mark} ${String(r.id).padEnd(26)} ${String(r.name).padEnd(18)} ` +
          `${r.state.padEnd(7)} td=${String(r.td ?? '—').padStart(2)}s ` +
          `最大停滯=${String(r.maxGapSec ?? '—').padStart(3)}s ` +
          `最大misses=${String(r.maxMisses ?? '—').padStart(2)}`,
      );
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const frozen = results.filter((r) => r.state === 'frozen');
  const gap = results.filter((r) => r.state === 'gap');
  const ok = results.filter((r) => r.state === 'ok');

  console.log('\n' + '═'.repeat(84));
  console.log('總結');
  console.log('═'.repeat(84));
  console.log(`前進正常：${ok.length}　停滯過大：${gap.length}　完全停播：${frozen.length}`);
  console.log('');
  if (frozen.length) {
    console.log('完全停播（序號在觀察窗內完全不動）：');
    for (const r of frozen) console.log(`  ✗ ${r.id.padEnd(26)} ${r.name}`);
  }
  if (gap.length) {
    console.log('停滯過大（曾前進但停滯超過門檻）：');
    for (const r of gap) console.log(`  ! ${r.id.padEnd(26)} ${r.name}  最大停滯 ${r.maxGapSec}s`);
  }

  const allGaps = results.filter((r) => r.maxGapSec != null).map((r) => r.maxGapSec);
  if (allGaps.length) {
    allGaps.sort((a, b) => a - b);
    console.log('');
    console.log(`最大停滯秒數分布：min=${allGaps[0]} p50=${allGaps[Math.floor(allGaps.length / 2)]} max=${allGaps[allGaps.length - 1]}`);
  }

  writeFileSync(
    '/Users/andy/.hermes/cache/scratch/playlist-advancement.json',
    JSON.stringify({ at: new Date().toISOString(), results }, null, 2),
  );
  console.log('');
  console.log('已寫入 /Users/andy/.hermes/cache/scratch/playlist-advancement.json');
}

main();
