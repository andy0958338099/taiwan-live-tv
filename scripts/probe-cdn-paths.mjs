#!/usr/bin/env node
/**
 * probe-cdn-paths.mjs — 深度探測 cdn.qd.je/163189/<path> 底下的所有頻道路徑
 *
 * 這批來源有一層「child manifest」：
 *   cdn.qd.je/163189/xxx  →  實際串流在 fast.hidns.vip / cdn6.cc.cd / smt.1678520.xyz
 * 而且不同 path 對應不同的上游 host，有些上游整批掛掉（502）。
 *
 * 本腳本會對每個 path 做完整 deep probe：
 *   manifest → child manifest → segment → 驗證 MPEG-TS/fMP4 位元組
 * 最後列出「真正能播」的路徑，並自動產生修正後的頻道資料。
 *
 * 用法：node scripts/probe-cdn-paths.mjs [--host cdn.qd.je] [--out <json>]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const HOST = arg('host', 'cdn.qd.je');
const OUT = arg('out', join(ROOT, 'shared', 'cdn-paths.json'));
const PLAYLIST = '/Users/andy/.hermes/cache/scratch/playlists/yang.m3u';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

async function get(url, ms = 12000) {
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

function segLines(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/**
 * 完整 deep probe。
 * 回傳 { ok, stage, childUrl, kind, bytes, cors }
 */
async function deepProbe(url) {
  let res;
  try {
    res = await get(url);
  } catch (e) {
    return { ok: false, stage: 'manifest', reason: e.name };
  }
  if (!res.ok) return { ok: false, stage: 'manifest', reason: `HTTP ${res.status}` };

  const cors = res.headers.get('access-control-allow-origin') !== null;
  const text = await res.text();
  if (!text.trimStart().startsWith('#EXTM3U')) {
    return { ok: false, stage: 'manifest', reason: '非 m3u8' };
  }
  if (text.includes('#EXT-X-ENDLIST')) {
    return { ok: false, stage: 'manifest', reason: 'VOD' };
  }

  const segs = segLines(text);
  if (segs.length === 0) {
    return { ok: false, stage: 'manifest', reason: '無 segment' };
  }

  // 第一個 segment 可能是子 manifest
  const childUrl = new URL(segs[0], url).href;
  let target = childUrl;
  let childText = text;

  if (!/\.(ts|m4s|mp4|aac|cmfv|cmfa)(\?|$)/i.test(segs[0])) {
    // 判定為子 manifest
    let cres;
    try {
      cres = await get(childUrl);
    } catch (e) {
      return { ok: false, stage: 'child', childUrl, reason: e.name };
    }
    if (!cres.ok) {
      return { ok: false, stage: 'child', childUrl, reason: `HTTP ${cres.status}` };
    }
    childText = await cres.text();
    if (childText.includes('#EXT-X-ENDLIST')) {
      return { ok: false, stage: 'child', childUrl, reason: 'VOD' };
    }
    const csegs = segLines(childText);
    if (csegs.length === 0) {
      return { ok: false, stage: 'child', childUrl, reason: '無 segment' };
    }
    target = new URL(csegs[0], childUrl).href;
  }

  // 驗證 segment 位元組
  let sres;
  try {
    sres = await get(target);
  } catch (e) {
    return { ok: false, stage: 'segment', childUrl, reason: e.name };
  }
  if (!sres.ok) {
    return { ok: false, stage: 'segment', childUrl, reason: `HTTP ${sres.status}` };
  }
  const buf = Buffer.from(await sres.arrayBuffer());
  if (buf.length < 1024) {
    return { ok: false, stage: 'segment', childUrl, reason: `過短 ${buf.length}B` };
  }

  const isTs = buf[0] === 0x47;
  const isFmp4 =
    buf.length > 8 &&
    buf[4] === 0x66 &&
    buf[5] === 0x74 &&
    buf[6] === 0x79 &&
    buf[7] === 0x70;
  const kind = isTs ? 'mpegts' : isFmp4 ? 'fmp4' : 'unknown';

  return {
    ok: true,
    stage: 'ok',
    childUrl,
    segmentUrl: target,
    kind,
    bytes: buf.length,
    cors: cors || false,
    childCors:
      res.headers.get('access-control-allow-origin') !== null,
  };
}

async function main() {
  console.log('═'.repeat(70));
  console.log(`深度探測 ${HOST}/163189/*`);
  console.log('═'.repeat(70));

  // 從 yang.m3u 抓出 path → 名稱對應
  const text = readFileSync(PLAYLIST, 'utf8');
  const lines = text.split('\n');
  const pathName = new Map();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXTINF')) continue;
    const next = lines[i + 1]?.trim();
    if (!next || !next.startsWith('http')) continue;
    const m = next.match(new RegExp(`/${HOST}/163189/([a-zA-Z0-9]+)`));
    if (!m) continue;
    const name = lines[i].split(',').slice(1).join(',').trim();
    const group = (lines[i].match(/group-title="([^"]*)"/) || [])[1] || '';
    if (!pathName.has(m[1])) pathName.set(m[1], { name, group });
  }

  const paths = [...pathName.keys()];
  console.log(`找到 ${paths.length} 個路徑\n`);

  const CONC = 10;
  const queue = [...paths];
  const results = [];

  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      const r = await deepProbe(`https://${HOST}/163189/${p}`);
      results.push({ path: p, ...pathName.get(p), ...r });
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  const ok = results.filter((r) => r.ok).sort((a, b) => a.path.localeCompare(b.path));
  const bad = results.filter((r) => !r.ok);

  console.log(`✓ 可播 ${ok.length}/${results.length}\n`);
  console.log('可播路徑：');
  for (const r of ok) {
    const host = new URL(r.childUrl).host;
    console.log(
      `  ${r.path.padEnd(12)} ${(r.name || '').slice(0, 22).padEnd(24)} ` +
        `${host.padEnd(24)} ${r.kind} ${(r.bytes / 1024 / 1024).toFixed(1)}MB`,
    );
  }

  console.log(`\n失效（${bad.length}）：`);
  const byReason = {};
  for (const r of bad) {
    const k = `${r.stage}:${r.reason}`;
    byReason[k] = (byReason[k] || 0) + 1;
  }
  for (const [k, c] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.toString().padStart(3)}  ${k}`);
  }

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        probed_at: new Date().toISOString(),
        host: HOST,
        total: results.length,
        working: ok.length,
        paths: ok.map((r) => ({
          path: r.path,
          name: r.name,
          group: r.group,
          url: `https://${HOST}/163189/${r.path}`,
          child_url: r.childUrl,
          kind: r.kind,
          bytes: r.bytes,
          cors: r.cors,
        })),
        failed: bad.map((r) => ({
          path: r.path,
          name: r.name,
          stage: r.stage,
          reason: r.reason,
        })),
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  console.log(`\n已寫入 ${OUT}`);
}

main();
