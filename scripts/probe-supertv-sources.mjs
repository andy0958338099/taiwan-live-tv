#!/usr/bin/env node
/**
 * probe-supertv-sources.mjs — 深層探測 SuperTV 舊專案的頻道來源
 *
 * 背景：使用者先前的 SuperTV 專案（Downloads/SuperTV-1050…）內嵌了一份
 * 74 個頻道的播放清單，來源是一組「中華電信 MOD 轉載」的中繼站
 * （http://220.134.196.147:PORT/http/61.219.99.20:8081/hls/…）。
 * 這批 URL 與 taiwan-live-tv 現有的 90 個頻道**完全沒有重疊**。
 *
 * 探測流程（與本專案其他 probe 一致）：
 *   manifest → 檢查是直播（無 #EXT-X-ENDLIST）→ 取第一個 segment
 *   → 驗證位元組（MPEG-TS 首 byte = 0x47 / fMP4 = ftyp）
 *   → 量測首包時間
 *
 * 用法：node scripts/probe-supertv-sources.mjs [--out <json>]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= -1 ? (i >= 0 ? process.argv[i + 1] : d) : d;
};
const OUT = arg('out', join(__dirname, '..', 'shared', 'supertv-source-probe.json'));
const SOURCE_FILE =
  '/Users/andy/Downloads/SuperTV-1050可在地播HBO拷貝/channels.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/** 從 SuperTV 的 channels.js 挖出內嵌播放清單 */
function loadSuperTVChannels() {
  const src = readFileSync(SOURCE_FILE, 'utf8');
  const m = src.match(/playlistText\s*\|\|\s*`([^`]*)`/);
  if (!m) throw new Error('在 channels.js 找不到內嵌播放清單');
  const out = [];
  for (const line of m[1].split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf(',');
    if (i === -1) continue;
    const name = t.slice(0, i).trim();
    const url = t.slice(i + 1).trim();
    if (!/^https?:\/\//i.test(url)) continue;
    out.push({ name, url });
  }
  return out;
}

/** 取 manifest 裡第一個 segment（處理 child manifest 與相對路徑） */
function firstSegment(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let child = null;
  const segs = [];
  for (const l of lines) {
    if (l.startsWith('#')) {
      if (/^#EXT-X-STREAM-INF/i.test(l)) child = 'PENDING';
      continue;
    }
    if (child === 'PENDING') {
      child = l;           // 這是 master manifest 的 variant
      continue;
    }
    if (!l.startsWith('#')) segs.push(l);
  }
  if (child) return { url: new URL(child, baseUrl).href, kind: 'variant' };
  if (segs.length) return { url: new URL(segs[0], baseUrl).href, kind: 'media' };
  return null;
}

/** 驗證 segment 位元組格式 */
function byteKind(buf) {
  if (buf.length >= 1 && buf[0] === 0x47) return 'mpegts';
  if (buf.length >= 12) {
    const brand = buf.slice(4, 8).toString('latin1');
    if (brand === 'ftyp') return 'fmp4';
  }
  if (buf.length >= 5 && buf.slice(0, 5).toString('latin1') === '<html') return 'html';
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return 'gzip';
  return 'unknown';
}

async function fetchWithTimeout(url, { timeout = 12000, headers = {}, method = 'GET' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': UA, ...headers },
    });
    const ttfb = Date.now() - t0;
    return { res, ttfb };
  } finally {
    clearTimeout(timer);
  }
}

async function probe(ch) {
  const result = {
    name: ch.name,
    url: ch.url,
    ok: false,
    reason: '',
    ttfbManifest: null,
    ttfbSegment: null,
    segmentBytes: null,
    byteKind: null,
    isLive: null,
  };
  try {
    const { res, ttfb } = await fetchWithTimeout(ch.url);
    result.ttfbManifest = ttfb;
    if (!res.ok) {
      result.reason = `manifest HTTP ${res.status}`;
      return result;
    }
    const text = await res.text();
    if (!text.includes('#EXTM3U')) {
      result.reason = '不是 m3u8';
      return result;
    }
    result.isLive = !text.includes('#EXT-X-ENDLIST');

    const seg = firstSegment(text, res.url || ch.url);
    if (!seg) {
      result.reason = 'manifest 裡找不到 segment';
      return result;
    }
    // 只抓前 4KB 就夠驗型別
    const { res: sres, ttfb: sttfb } = await fetchWithTimeout(seg.url, {
      headers: { range: 'bytes=0-4095' },
      timeout: 15000,
    });
    result.ttfbSegment = sttfb;
    if (!sres.ok) {
      result.reason = `segment HTTP ${sres.status}`;
      return result;
    }
    const buf = Buffer.from(await sres.arrayBuffer());
    result.segmentBytes = buf.length;
    result.byteKind = byteKind(buf);
    if (result.byteKind === 'mpegts' || result.byteKind === 'fmp4') {
      result.ok = true;
      result.reason = result.isLive ? '直播 OK' : '可播但 manifest 有 ENDLIST（VOD）';
    } else if (result.byteKind === 'html') {
      result.reason = 'segment 回 HTML（錯誤頁）';
    } else {
      result.reason = `segment 位元組不明（${result.byteKind}）`;
    }
    return result;
  } catch (err) {
    result.reason = err.name === 'AbortError' ? 'timeout' : err.message;
    return result;
  }
}

// ── 主流程 ──
const channels = loadSuperTVChannels();
console.log(`═══ 深層探測 SuperTV 的 ${channels.length} 個來源 ═══\n`);

const results = [];
const CONCURRENCY = 8;
for (let i = 0; i < channels.length; i += CONCURRENCY) {
  const batch = channels.slice(i, i + CONCURRENCY);
  const rs = await Promise.all(batch.map(probe));
  results.push(...rs);
  for (const r of rs) {
    const mark = r.ok ? '✓' : '✗';
    const live = r.isLive === false ? ' [VOD]' : '';
    console.log(
      `  ${mark} ${r.name.padEnd(20)} ${String(r.reason).padEnd(34)}` +
        `ttfb=${r.ttfbManifest}ms seg=${r.ttfbSegment}ms ${r.byteKind ?? '-'}${live}`,
    );
  }
  process.stdout.write(`  …${Math.min(i + CONCURRENCY, channels.length)}/${channels.length}\n`);
}

const okLive = results.filter((r) => r.ok && r.isLive);
const okVod = results.filter((r) => r.ok && !r.isLive);
const fail = results.filter((r) => !r.ok);

console.log(`\n═══ 結果 ═══`);
console.log(`  直播可播：${okLive.length}`);
console.log(`  可播但 VOD：${okVod.length}`);
console.log(`  失敗：${fail.length}`);
if (okLive.length) {
  console.log(`\n  可用清單：`);
  for (const r of okLive) console.log(`    ${r.name.padEnd(20)} ${r.url}`);
}
if (okVod.length) {
  console.log(`\n  ⚠️ VOD（不可當直播上線）：`);
  for (const r of okVod) console.log(`    ${r.name.padEnd(20)} ${r.url}`);
}
console.log(`\n  失敗原因統計：`);
const byReason = {};
for (const r of fail) byReason[r.reason] = (byReason[r.reason] || 0) + 1;
for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(v).padStart(3)} × ${k}`);
}

writeFileSync(OUT, JSON.stringify({ probed_at: new Date().toISOString(), results }, null, 2));
console.log(`\n  結果已存：${OUT}`);
