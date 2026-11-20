#!/usr/bin/env node
/**
 * verify-channel-sources.mjs — 驗證每個頻道的主來源與備援是否真的能播
 *
 * 為什麼需要這個：
 *   匯入腳本選主來源的依據是「manifest 可讀 + 有 CORS」，
 *   但實際上有三種問題會讓頻道在網頁版播不出來：
 *
 *   1. 主來源是 PHP 轉址頁或需要特定參數 → 回 404
 *   2. 上游速度太慢 → segment 下載超過 hls.js 逾時
 *   3. segment 太大（>5 MB）→ 代理緩衝時觸發 function 逾時
 *
 * 本腳本對每個候選網址做完整驗證（manifest → child → segment），
 * 並量測 segment 下載時間，讓後續能把「慢速來源」排到備援、
 * 把「壞掉的主來源」替換掉。
 *
 * 用法：node scripts/verify-channel-sources.mjs [--ids id1,id2] [--conc 8]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHANNELS_PATH = join(ROOT, 'shared', 'channels.json');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const IDS = arg('ids', '').split(',').filter(Boolean);
const CONC = parseInt(arg('conc', '8'), 10);

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

async function get(url, ms = 20000) {
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
 * 完整驗證：manifest → child → segment
 * 回傳 { ok, cors, segBytes, segMs, kind, reason }
 */
async function verify(url) {
  let res;
  try {
    res = await get(url);
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? '逾時' : e.name };
  }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };

  const cors = res.headers.get('access-control-allow-origin') !== null;
  const text = await res.text();
  if (!text.trimStart().startsWith('#EXTM3U')) {
    return { ok: false, reason: '非 m3u8' };
  }
  if (text.includes('#EXT-X-ENDLIST')) return { ok: false, reason: 'VOD' };

  const segs = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (segs.length === 0) return { ok: false, reason: '無 segment' };

  // child manifest？
  let target = new URL(segs[0], url).href;
  if (!/\.(ts|m4s|mp4|aac|cmfv|cmfa)(\?|$)/i.test(segs[0])) {
    let cres;
    try {
      cres = await get(target);
    } catch (e) {
      return { ok: false, reason: `child ${e.name}` };
    }
    if (!cres.ok) return { ok: false, reason: `child HTTP ${cres.status}` };
    const ctext = await cres.text();
    if (ctext.includes('#EXT-X-ENDLIST')) return { ok: false, reason: 'child VOD' };
    const csegs = ctext
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (csegs.length === 0) return { ok: false, reason: 'child 無 segment' };
    target = new URL(csegs[0], target).href;
  }

  // segment 位元組 + 耗時
  const t0 = Date.now();
  let sres;
  try {
    sres = await get(target, 45000);
  } catch (e) {
    return { ok: false, reason: `segment ${e.name === 'AbortError' ? '逾時' : e.name}` };
  }
  const segMs = Date.now() - t0;
  if (!sres.ok) return { ok: false, reason: `segment HTTP ${sres.status}` };

  const buf = Buffer.from(await sres.arrayBuffer());
  if (buf.length < 1024) return { ok: false, reason: `segment 過短 ${buf.length}B` };

  const isTs = buf[0] === 0x47;
  const isFmp4 =
    buf.length > 8 &&
    buf[4] === 0x66 &&
    buf[5] === 0x74 &&
    buf[6] === 0x79 &&
    buf[7] === 0x70;

  return {
    ok: true,
    cors,
    segBytes: buf.length,
    segMs,
    kind: isTs ? 'mpegts' : isFmp4 ? 'fmp4' : 'unknown',
  };
}

async function main() {
  const catalog = JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'));
  let targets = catalog.channels;
  if (IDS.length) targets = targets.filter((c) => IDS.includes(c.channel_id));

  console.log('═'.repeat(78));
  console.log('頻道來源驗證（manifest → child → segment，含耗時）');
  console.log('═'.repeat(78));
  console.log(`檢查 ${targets.length} 個頻道\n`);

  const results = [];

  for (const ch of targets) {
    const candidates = [
      { url: ch.stream_url, kind: 'primary' },
      ...(ch.playlist_source?.backup_urls ?? []).map((b) => ({
        url: b.url,
        kind: 'backup',
      })),
    ];

    const found = [];
    for (const cand of candidates) {
      if (!cand.url) continue;
      const r = await verify(cand.url);
      found.push({ ...cand, ...r });
      if (r.ok) break; // 找到可用的就停
    }

    const primary = found[0];
    const working = found.find((f) => f.ok);

    const status = working ? '✓' : '✗';
    const detail = working
      ? `${working.kind} ${(working.segBytes / 1048576).toFixed(1)}MB ` +
        `${(working.segMs / 1000).toFixed(1)}s ${working.cors ? 'CORS' : '需代理'}`
      : `主來源 ${primary?.reason ?? '無'}`;

    console.log(
      `  ${status} ${ch.channel_name.padEnd(18)} ` +
        `${working && working !== primary ? '備援可用 ' : ''}${detail}`,
    );

    results.push({
      channel_id: ch.channel_id,
      channel_name: ch.channel_name,
      primary_url: ch.stream_url,
      primary_ok: primary?.ok ?? false,
      primary_reason: primary?.reason ?? null,
      primary_cors: primary?.cors ?? null,
      working_url: working?.url ?? null,
      working_kind: working?.kind ?? null,
      working_ms: working?.segMs ?? null,
      working_bytes: working?.segBytes ?? null,
      needs_swap: !!(working && working.kind === 'backup'),
    });
  }

  const ok = results.filter((r) => r.working_url).length;
  const needSwap = results.filter((r) => r.needs_swap).length;
  const dead = results.filter((r) => !r.working_url);

  console.log('');
  console.log('═'.repeat(78));
  console.log(`可播 ${ok}/${results.length}｜需改用備援 ${needSwap}｜完全失效 ${dead.length}`);
  if (dead.length) {
    console.log('\n完全失效：');
    for (const d of dead) console.log(`  ✗ ${d.channel_name} — ${d.primary_reason}`);
  }
  if (needSwap) {
    console.log('\n主來源壞掉但備援可用（建議置換）：');
    for (const s of results.filter((r) => r.needs_swap)) {
      console.log(`  ! ${s.channel_name}`);
      console.log(`      舊: ${s.primary_url.slice(0, 78)}`);
      console.log(`      新: ${s.working_url.slice(0, 78)}`);
    }
  }
  console.log('═'.repeat(78));

  writeFileSync(
    join(ROOT, 'shared', 'source-verification.json'),
    JSON.stringify(
      { verified_at: new Date().toISOString(), results },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  console.log('\n已寫入 shared/source-verification.json');
}

main();
