#!/usr/bin/env node
/**
 * probe-taiwan-sources.mjs — 深度探測候選台灣來源
 *
 * 判斷一個來源是否為「可播的直播」：
 *   1. manifest 可讀且以 #EXTM3U 開頭
 *   2. **不含** #EXT-X-ENDLIST（那就是 VOD，不是直播）
 *   3. 能解析出 segment 路徑（可能是 child manifest）
 *   4. segment 真的下載得到，且首 2 bytes 是 MPEG-TS 同步位元組 0x47
 *      或 fMP4 的 'ftyp' box
 *   5. 量出下載耗時 → 用來排序（最快的優先）
 *
 * 用法：node scripts/probe-taiwan-sources.mjs <清單檔> [--conc 8]
 */

import { readFileSync } from 'node:fs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const file = process.argv[2];
const conc = parseInt(
  (() => {
    const i = process.argv.indexOf('--conc');
    return i >= 0 ? process.argv[i + 1] : '8';
  })(),
  10,
);

async function get(url, ms = 25000) {
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

async function probe(url) {
  let res;
  try {
    res = await get(url);
  } catch (e) {
    return { ok: false, reason: e.name };
  }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };

  let text;
  try {
    text = await res.text();
  } catch {
    return { ok: false, reason: '讀取失敗' };
  }
  if (!text.trimStart().startsWith('#EXTM3U')) {
    return { ok: false, reason: '非 m3u8' };
  }
  if (text.includes('#EXT-X-ENDLIST')) return { ok: false, reason: 'VOD（非直播）' };

  const segs = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (segs.length === 0) return { ok: false, reason: '無 segment' };

  let target = new URL(segs[0], url).href;

  // child manifest（只有路徑沒有副檔名的情況）
  if (!/\.(ts|m4s|mp4|aac|cmfv|cmfa)(\?|$)/i.test(segs[0])) {
    let cres;
    try {
      cres = await get(target);
    } catch {
      return { ok: false, reason: 'child 失敗' };
    }
    if (!cres.ok) return { ok: false, reason: `child HTTP ${cres.status}` };
    let ctext;
    try {
      ctext = await cres.text();
    } catch {
      return { ok: false, reason: 'child 讀取失敗' };
    }
    const csegs = ctext
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (csegs.length === 0) return { ok: false, reason: 'child 無 segment' };
    target = new URL(csegs[0], target).href;
  }

  const t0 = Date.now();
  let sres;
  try {
    sres = await get(target, 30000);
  } catch {
    return { ok: false, reason: 'segment 逾時' };
  }
  const ms = Date.now() - t0;
  if (!sres.ok && sres.status !== 206) {
    return { ok: false, reason: `segment HTTP ${sres.status}` };
  }

  let buf;
  try {
    buf = Buffer.from(await sres.arrayBuffer());
  } catch {
    return { ok: false, reason: 'segment 讀取失敗' };
  }
  if (buf.length < 1024) return { ok: false, reason: `segment 過短 (${buf.length}B)` };

  // 驗證位元組格式
  const isTS = buf[0] === 0x47;
  const isFmp4 = buf.slice(4, 8).toString('ascii') === 'ftyp';
  if (!isTS && !isFmp4) {
    return { ok: false, reason: `位元組格式不符 (0x${buf[0].toString(16)})` };
  }

  return {
    ok: true,
    ms,
    bytes: buf.length,
    format: isTS ? 'mpegts' : 'fmp4',
    cors: res.headers.get('access-control-allow-origin') ? true : false,
  };
}

/** 解析 m3u / 純文字清單 */
function parseList(text) {
  const out = [];
  const lines = text.split('\n');
  let pendingName = null;
  let pendingLogo = null;
  let pendingGroup = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const name = line.split(',').slice(1).join(',').trim();
      pendingName = name;
      const logo = line.match(/tvg-logo="([^"]+)"/);
      pendingLogo = logo ? logo[1] : null;
      const grp = line.match(/group-title="([^"]+)"/);
      pendingGroup = grp ? grp[1] : null;
      continue;
    }
    if (line.startsWith('#')) continue;
    if (!/^https?:\/\//i.test(line)) {
      // 純文字格式：名稱,網址
      const m = line.match(/^(.+?)\s*,\s*(https?:\/\/\S+)$/);
      if (m) {
        out.push({ name: m[1].trim(), url: m[2].trim(), logo: null, group: null });
      }
      continue;
    }
    out.push({ name: pendingName ?? '', url: line, logo: pendingLogo, group: pendingGroup });
    pendingName = null;
    pendingLogo = null;
    pendingGroup = null;
  }
  return out;
}

async function main() {
  const text = readFileSync(file, 'utf8');
  const items = parseList(text);
  console.log(`解析 ${items.length} 個來源，併行 ${conc}\n`);

  const results = new Array(items.length);
  let done = 0;

  async function worker() {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) return;
      const it = items[idx];
      const r = await probe(it.url);
      results[idx] = { ...it, ...r };
      done++;
      if (done % 3 === 0) process.stdout.write(`  探測中 ${done}/${items.length}\r`);
    }
  }
  let nextIndex = 0;
  await Promise.all(Array.from({ length: conc }, () => worker()));
  process.stdout.write(' '.repeat(40) + '\r');

  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);

  console.log('═'.repeat(72));
  console.log(`可播 ${ok.length}/${results.length}\n`);

  console.log('【可播】依下載速度排序：');
  ok
    .sort((a, b) => a.ms - b.ms)
    .forEach((r) =>
      console.log(
        `  ✓ ${r.name.padEnd(28)} ${String(r.format).padEnd(7)} ${(r.bytes / 1048576).toFixed(1)}MB ${String(r.ms).padStart(6)}ms ${r.cors ? 'CORS✓' : '需代理'}`,
      ),
    );

  console.log('\n【不可播】');
  bad.forEach((r) => console.log(`  ✗ ${r.name.padEnd(28)} ${r.reason}`));

  console.log('═'.repeat(72));
}

await main();
