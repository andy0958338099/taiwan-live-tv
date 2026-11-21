#!/usr/bin/env node
/**
 * probe-backup-segments.mjs — 量測「備援來源的 segment 實際可用性」
 *
 * ## 為什麼需要這個
 *
 * `repair-dead-backups.mjs` 只用 **manifest** 判斷 host 生死：
 * HTTP 200 + `#EXTM3U` 就當作「活的」。
 *
 * 但實測發現一批 host 的 manifest 正常、**segment 卻是死的或慢到不可用**：
 *
 *   · `61.136.172.236:9901` → manifest 200，segment 只有 14 KB/s（60 秒下不完整）
 *   · `36.136.38.87:9901`   → manifest 200，segment 只有 404 B/s（等同死）
 *
 * 這類備援比沒有備援更糟：failover 會先撞上它，
 * 使用者必須等滿 hls.js 的 `fragLoadingTimeOut`（90 秒）
 * 或播放器的載入 watchdog（60 秒）才換到下一個。
 *
 * ## 判準
 *
 * 對每個 (host, path) 實際抓 **一個 segment**，量：
 *   · 是否下載完成（沒有被 timeout 砍斷）
 *   · 位元組是否 >= 1 KB
 *   · 首 byte 是否 0x47（MPEG-TS 同步位元組）
 *   · 下載速度（B/s）
 *
 * 然後把每個 host 的所有 path 依結果分類：
 *   · `dead`      —— 全部 path 的 segment 都失敗 → 整台不可用
 *   · `segment-dead` —— manifest 活但 segment 死 → 對「可播」沒用
 *   · `slow`      —— segment 可用但速度 < 50 KB/s → 可播但很慢
 *   · `ok`        —— 正常
 *
 * 用法：node scripts/probe-backup-segments.mjs [--conc 8] [--timeout 45000] [--dry-run]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHANNELS_PATH = join(ROOT, 'shared', 'channels.json');
const OUT_PATH = join(ROOT, 'shared', 'backup-segment-probe.json');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const CONC = parseInt(arg('conc', '8'), 10);
const TIMEOUT_MS = parseInt(arg('timeout', '45000'), 10);
const DRY_RUN = process.argv.includes('--dry-run');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/** 慢速門檻（B/s）—— 低於此值使用者要等很久 */
const SLOW_BPS = 50_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, ms = TIMEOUT_MS) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: c.signal,
      redirect: 'follow',
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

/**
 * 完整驗證一個候選網址：manifest → segment。
 * 回傳 { ok, reason, bytes, ms, bps, manifestOk }
 */
async function probe(url) {
  let res;
  try {
    res = await get(url, 20000);
  } catch (e) {
    return {
      ok: false,
      manifestOk: false,
      reason: e.name === 'AbortError' ? 'manifest 逾時' : `manifest ${e.name}`,
    };
  }
  if (!res.ok) {
    return { ok: false, manifestOk: false, reason: `manifest HTTP ${res.status}` };
  }
  let text;
  try {
    text = await res.text();
  } catch (e) {
    return { ok: false, manifestOk: false, reason: 'manifest 讀取失敗' };
  }
  if (!text.trimStart().startsWith('#EXTM3U')) {
    return { ok: false, manifestOk: false, reason: '非 m3u8' };
  }
  if (text.includes('#EXT-X-ENDLIST')) {
    return { ok: false, manifestOk: true, reason: 'VOD' };
  }

  const segs = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (!segs.length) return { ok: false, manifestOk: true, reason: '無 segment' };

  let target = new URL(segs[0], url).href;
  if (!/\.(ts|m4s|mp4|aac|cmfv|cmfa)(\?|$)/i.test(segs[0])) {
    let cres;
    try {
      cres = await get(target, 20000);
    } catch (e) {
      return { ok: false, manifestOk: true, reason: 'child manifest 逾時' };
    }
    if (!cres.ok) {
      return { ok: false, manifestOk: true, reason: `child HTTP ${cres.status}` };
    }
    let ctext;
    try {
      ctext = await cres.text();
    } catch {
      return { ok: false, manifestOk: true, reason: 'child 讀取失敗' };
    }
    const csegs = ctext
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (!csegs.length) {
      return { ok: false, manifestOk: true, reason: 'child 無 segment' };
    }
    target = new URL(csegs[0], target).href;
  }

  const t0 = Date.now();
  let sres;
  try {
    sres = await get(target, TIMEOUT_MS);
  } catch (e) {
    return {
      ok: false,
      manifestOk: true,
      reason: e.name === 'AbortError' ? 'segment 逾時' : `segment ${e.name}`,
    };
  }
  if (!sres.ok) {
    return { ok: false, manifestOk: true, reason: `segment HTTP ${sres.status}` };
  }
  let buf;
  try {
    buf = Buffer.from(await sres.arrayBuffer());
  } catch (e) {
    return { ok: false, manifestOk: true, reason: 'segment 讀取失敗' };
  }
  const ms = Date.now() - t0;
  if (buf.length < 1024) {
    return { ok: false, manifestOk: true, reason: `segment 過短 ${buf.length}B`, bytes: buf.length, ms };
  }
  const isTs = buf[0] === 0x47;
  const isFmp4 =
    buf.length > 8 &&
    buf[4] === 0x66 &&
    buf[5] === 0x74 &&
    buf[6] === 0x79 &&
    buf[7] === 0x70;
  if (!isTs && !isFmp4) {
    return { ok: false, manifestOk: true, reason: 'segment 位元組不是串流內容', bytes: buf.length, ms };
  }
  return {
    ok: true,
    manifestOk: true,
    reason: null,
    bytes: buf.length,
    ms,
    bps: Math.round(buf.length / (ms / 1000)),
    kind: isTs ? 'mpegts' : 'fmp4',
  };
}

async function main() {
  console.log('═'.repeat(72));
  console.log('備援來源 segment 可用性量測');
  console.log('═'.repeat(72));
  console.log(`segment 下載逾時上限：${TIMEOUT_MS / 1000}s｜並行 ${CONC}\n`);

  const catalog = JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'));

  // 收集所有不重複的網址（主來源 + 備援）
  const urls = new Set();
  for (const c of catalog.channels) {
    if (c.stream_url) urls.add(c.stream_url);
    for (const b of c.playlist_source?.backup_urls ?? []) if (b.url) urls.add(b.url);
  }

  // 依 host 分組（同一 host 的多個 path 一併判斷）
  const byHost = new Map();
  for (const u of urls) {
    let parsed;
    try {
      parsed = new URL(u);
    } catch {
      continue;
    }
    if (!byHost.has(parsed.host)) byHost.set(parsed.host, []);
    byHost.get(parsed.host).push(u);
  }

  const total = urls.size;
  let done = 0;
  const results = new Map();

  const list = [...urls];
  let idx = 0;
  async function worker() {
    while (idx < list.length) {
      const u = list[idx++];
      let r;
      try {
        r = await probe(u);
      } catch (e) {
        r = { ok: false, manifestOk: false, reason: `例外 ${e.name}` };
      }
      results.set(u, r);
      done++;
      if (done % 5 === 0) {
        process.stdout.write(`  量測中 ${done}/${total}\r`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  process.stdout.write(' '.repeat(40) + '\r');

  // ── 依 host 分類 ──
  const hostStatus = new Map();
  for (const [host, list2] of byHost) {
    const rs = list2.map((u) => results.get(u));
    const anyOk = rs.some((r) => r.ok);
    const anyManifest = rs.some((r) => r.manifestOk);
    const allSegFail = rs.every((r) => !r.ok);
    let status;
    if (!anyManifest) status = 'dead';
    else if (allSegFail) status = 'segment-dead';
    else if (!anyOk) status = 'segment-dead';
    else {
      const bestBps = Math.max(...rs.filter((r) => r.ok).map((r) => r.bps));
      status = bestBps < SLOW_BPS ? 'slow' : 'ok';
    }
    hostStatus.set(host, { status, paths: list2.length, bestBps: Math.max(0, ...rs.filter(r=>r.ok).map(r=>r.bps)) });
  }

  console.log('host 分類：');
  const grouped = new Map();
  for (const [host, st] of hostStatus) {
    if (!grouped.has(st.status)) grouped.set(st.status, []);
    grouped.get(st.status).push(host);
  }
  for (const status of ['dead', 'segment-dead', 'slow', 'ok']) {
    const hs = grouped.get(status) ?? [];
    console.log(`  ${status.padEnd(13)} ${String(hs.length).padStart(3)} 個 host`);
    if (status !== 'ok') {
      for (const h of hs.slice(0, 40)) {
        const st = hostStatus.get(h);
        console.log(`      ${h.padEnd(26)} ${st.paths} 個 path  最佳 ${st.bestBps} B/s`);
      }
    }
  }

  // ── 找出受影響的頻道 ──
  const affected = [];
  for (const c of catalog.channels) {
    const backups = c.playlist_source?.backup_urls ?? [];
    const bad = backups.filter((b) => {
      try {
        const st = hostStatus.get(new URL(b.url).host);
        return st && (st.status === 'dead' || st.status === 'segment-dead');
      } catch {
        return false;
      }
    });
    if (bad.length) {
      affected.push({
        channel_id: c.channel_id,
        channel_name: c.channel_name,
        primary_status: (() => {
          try {
            return hostStatus.get(new URL(c.stream_url).host)?.status ?? '?';
          } catch {
            return '?';
          }
        })(),
        bad_backups: bad.map((b) => ({ url: b.url, source: b.source })),
      });
    }
  }

  console.log(`\n受影響頻道（備援含 segment 不可用的 host）：${affected.length} 個`);
  for (const a of affected) {
    console.log(`  ${a.channel_name.padEnd(18)} 主來源=${a.primary_status}  壞備援 ${a.bad_backups.length} 個`);
    for (const b of a.bad_backups) console.log(`      ${b.url}`);
  }

  const payload = {
    probed_at: new Date().toISOString(),
    timeout_ms: TIMEOUT_MS,
    slow_bps_threshold: SLOW_BPS,
    host_status: Object.fromEntries(
      [...hostStatus.entries()].map(([h, s]) => [h, s]),
    ),
    url_results: Object.fromEntries(
      [...results.entries()].map(([u, r]) => [
        u,
        {
          ok: r.ok,
          manifest_ok: r.manifestOk,
          reason: r.reason,
          bytes: r.bytes ?? null,
          ms: r.ms ?? null,
          bps: r.bps ?? null,
        },
      ]),
    ),
    affected_channels: affected,
  };

  if (DRY_RUN) {
    console.log('\n(dry-run 模式，未寫入檔案)');
    return;
  }
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`\n已寫入 ${OUT_PATH}`);
}

await main();
