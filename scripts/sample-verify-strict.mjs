#!/usr/bin/env node
/**
 * sample-verify-strict.mjs — 抽樣獨立複驗（第 3 輪新增）
 *
 * ## 為什麼需要這支
 *
 * `audit-all-user-path.mjs` 與 `verify-channel-sources.mjs` 都是專案既有的探針。
 * 第 1、2 輪實測證明：探針本身會有系統性假陽性／假陰性，
 * 所以「探針說可播」不能直接當結論 —— 必須用**獨立實作**再抽樣複驗。
 *
 * ## 本支的差異
 *
 *  · 不複用任何既有探針的程式碼（避免「同一個 bug 一起錯」）
 *  · 判定完全照 2026-11-22 固定的五條口徑：
 *      1. manifest 以 `#EXTM3U` 開頭
 *      2. 不含 `#EXT-X-ENDLIST`
 *      3. 子清單最多遞迴 2 層
 *      4. segment 用 `Range: bytes=0-2047` 抓前 2KB
 *      5. 位元組嗅探：首位 0x47 = MPEG-TS、ISO-BMFF box = fMP4 → 通過；
 *         開頭 '<'（HTML）/ FF D8（JPEG）/ 89 50（PNG）→ 失效
 *      6. 網址含 youtube.com / youtu.be → 失效
 *  · 走**使用者實際路徑**（與 `web/src/lib/useHlsPlayer.ts` 的
 *    `needsProxy()` 對齊）：cors_enabled=false 或 http:// → 代理，
 *    否則直連
 *  · 每個 variant 都試；每個 child 取頭／中／尾多個 segment 位置
 *  · 記錄第一個 segment 的**內容雜湊**，供後續做停播的決定性判定
 *
 * 用法：
 *   node scripts/sample-verify-strict.mjs                 # 隨機抽 20 個
 *   node scripts/sample-verify-strict.mjs --n 30
 *   node scripts/sample-verify-strict.mjs --ids a,b,c
 *   node scripts/sample-verify-strict.mjs --all
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHANNELS_PATH = join(ROOT, 'shared', 'channels.json');

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);

const N = parseInt(arg('n', '20'), 10);
const ONLY = (arg('ids', '') || '').split(',').filter(Boolean);
const ALL = flag('all');
const OUT = arg('out', '/Users/andy/.hermes/cache/scratch/sample-verify-strict.json');

const ORIGIN = 'https://taiwan-live-tv.netlify.app';
const PROXY = `${ORIGIN}/api/proxy`;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const enc = (u) => Buffer.from(u).toString('base64url');

/** 與 useHlsPlayer.ts 的 needsProxy() 對齊 */
function needsProxy(ch) {
  if (ch.cors_enabled === false) return true;
  if (!ch.stream_url) return false;
  if (ch.stream_url.startsWith('http://')) return true;
  return false;
}

const BMFF_BOXES = new Set([
  'ftyp', 'styp', 'moof', 'mdat', 'moov', 'sidx', 'emsg', 'prft', 'pdin', 'free', 'skip',
]);

function sniff(buf) {
  if (!buf || buf.length === 0) return { kind: 'empty', first: '??' };
  const first = buf[0].toString(16).padStart(2, '0');
  if (buf[0] === 0x47) return { kind: 'mpegts', first };
  if (buf.length >= 8) {
    const box = buf.subarray(4, 8).toString('latin1');
    if (BMFF_BOXES.has(box)) return { kind: 'fmp4', first };
  }
  if (buf[0] === 0x3c) return { kind: 'html', first };
  if (buf[0] === 0xff && buf[1] === 0xd8) return { kind: 'jpeg', first };
  if (buf[0] === 0x89 && buf[1] === 0x50) return { kind: 'png', first };
  return { kind: 'other', first };
}

async function grab(url, { range = false, timeout = 40000 } = {}) {
  const headers = { 'User-Agent': UA, Origin: ORIGIN };
  if (range) headers.Range = 'bytes=0-2047';
  try {
    const res = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      buf,
      cors: res.headers.get('access-control-allow-origin'),
      final: res.url,
    };
  } catch (e) {
    return { status: 0, buf: Buffer.alloc(0), cors: null, final: url, err: e.name ?? e.message };
  }
}

const seqOf = (t) => {
  const m = t.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m);
  return m ? Number(m[1]) : null;
};

/** 清單裡的網址列（含 URI="..." 屬性） */
function urlsIn(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const m = line.match(/URI="([^"]+)"/);
      if (m) out.push(m[1]);
      continue;
    }
    out.push(line);
  }
  return out;
}

const isSegLine = (u) => /\.(ts|m4s|mp4|aac|cmfv|cmfa)(\?|$)/i.test(u);

async function audit(ch) {
  const url = ch.stream_url;
  const useProxy = needsProxy(ch);

  if (/youtube\.com|youtu\.be/i.test(url)) {
    return { ok: false, path: useProxy ? 'proxy' : 'direct', reason: 'YouTube 網址，非 HLS 源' };
  }

  const entry = useProxy ? `${PROXY}/${enc(url)}` : url;

  // ── 層 0：master（或本身就是 media playlist）──────────────────
  const m = await grab(entry);
  if (m.status !== 200) {
    const d = m.buf.length ? m.buf.subarray(0, 100).toString('utf8').replace(/\s+/g, ' ') : (m.err ?? '');
    return { ok: false, path: useProxy ? 'proxy' : 'direct', reason: `master HTTP ${m.status} ${d}`.trim() };
  }
  let text = m.buf.toString('utf8');
  if (!text.trimStart().startsWith('#EXTM3U')) {
    return { ok: false, path: useProxy ? 'proxy' : 'direct', reason: `master 不是 #EXTM3U（首位 ${sniff(m.buf).first}）` };
  }
  if (text.includes('#EXT-X-ENDLIST')) {
    return { ok: false, path: useProxy ? 'proxy' : 'direct', reason: 'master 含 #EXT-X-ENDLIST（VOD）' };
  }

  const isMaster = text.includes('#EXT-X-STREAM-INF');
  const variants = isMaster ? urlsIn(text) : [null];

  const variantReports = [];
  let best = null;

  for (let vi = 0; vi < variants.length; vi++) {
    // ── 層 1：child manifest（最多再遞迴 1 層，合計 2 層）────────
    let mediaText = text;
    let mediaBase = m.final;
    let mediaSeq = seqOf(text);

    if (variants[vi]) {
      const childUrl = useProxy
        ? variants[vi].startsWith('/') ? ORIGIN + variants[vi] : variants[vi]
        : new URL(variants[vi], m.final).toString();
      const c = await grab(childUrl);
      if (c.status !== 200) {
        variantReports.push({ v: vi, ok: false, reason: `child HTTP ${c.status}` });
        continue;
      }
      const ct = c.buf.toString('utf8');
      if (!ct.trimStart().startsWith('#EXTM3U')) {
        variantReports.push({ v: vi, ok: false, reason: 'child 不是 #EXTM3U' });
        continue;
      }
      if (ct.includes('#EXT-X-ENDLIST')) {
        variantReports.push({ v: vi, ok: false, reason: 'child 含 ENDLIST（VOD）' });
        continue;
      }
      // 層 2：child 本身又指向 child（再遞迴 1 層即止）
      if (ct.includes('#EXT-X-STREAM-INF')) {
        const g = urlsIn(ct).filter((u) => !isSegLine(u));
        if (g.length) {
          const gUrl = useProxy
            ? g[0].startsWith('/') ? ORIGIN + g[0] : g[0]
            : new URL(g[0], c.final).toString();
          const gc = await grab(gUrl);
          if (gc.status === 200) {
            const gt = gc.buf.toString('utf8');
            if (gt.trimStart().startsWith('#EXTM3U') && !gt.includes('#EXT-X-ENDLIST')) {
              mediaText = gt;
              mediaBase = gc.final;
              mediaSeq = seqOf(gt) ?? mediaSeq;
            }
          }
        }
      }
      if (mediaText === text) {
        mediaText = ct;
        mediaBase = c.final;
        mediaSeq = seqOf(ct) ?? mediaSeq;
      }
    }

    const segs = urlsIn(mediaText).filter((u) => !/^#/.test(u));
    if (!segs.length) {
      variantReports.push({ v: vi, ok: false, reason: '沒有 segment' });
      continue;
    }

    // ── 層 3：多個位置的 segment（頭／中／尾／尾-1）──────────────
    const picks = [...new Set([0, Math.floor(segs.length / 2), segs.length - 1, segs.length - 2])]
      .filter((i) => i >= 0 && i < segs.length);

    let good = 0;
    const details = [];
    let firstHash = null;
    for (const i of picks) {
      const su = useProxy
        ? (segs[i].startsWith('/') ? ORIGIN + segs[i] : segs[i])
        : new URL(segs[i], mediaBase).toString();
      let r = null;
      let s = { kind: 'empty', first: '??' };
      for (let a = 1; a <= 3; a++) {
        r = await grab(su, { range: true });
        s = sniff(r.buf);
        if ((r.status === 200 || r.status === 206) && (s.kind === 'mpegts' || s.kind === 'fmp4')) break;
        if (a < 3) await new Promise((z) => setTimeout(z, 500 * a));
      }
      const ok = (r.status === 200 || r.status === 206) && (s.kind === 'mpegts' || s.kind === 'fmp4');
      if (ok) {
        good++;
        if (!firstHash) firstHash = createHash('sha256').update(r.buf).digest('hex').slice(0, 12);
      }
      details.push({ i, status: r.status, kind: s.kind, first: s.first, ok });
    }

    const variantOk = good > 0;
    variantReports.push({ v: vi, ok: variantOk, seq: mediaSeq, seg: `${good}/${picks.length}`, details });
    if (variantOk && !best) {
      best = { v: vi, seq: mediaSeq, seg: `${good}/${picks.length}`, kind: details.find((x) => x.ok)?.kind, hash: firstHash };
    }
  }

  if (!best) {
    return {
      ok: false,
      path: useProxy ? 'proxy' : 'direct',
      reason: `全部 ${variants.length} 個 variant 失敗（${variantReports.map((v) => `v${v.v}:${v.reason ?? v.seg}`).join(' / ')}）`,
      variants: variantReports,
    };
  }

  return {
    ok: true,
    path: useProxy ? 'proxy' : 'direct',
    variants_ok: variantReports.filter((v) => v.ok).length,
    variants_total: variants.length,
    seq: best.seq,
    kind: best.kind,
    segments_ok: best.seg,
    seg_hash: best.hash,
    variants: variantReports,
  };
}

async function main() {
  const catalog = JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'));
  let targets = catalog.channels.filter((c) => !c.embed_url && c.stream_url);
  if (ONLY.length) {
    targets = targets.filter((c) => ONLY.includes(c.channel_id));
  } else if (!ALL) {
    // 隨機抽樣（固定亂數種子 → 可重播）
    let s = 20261122;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pool = [...targets];
    const picked = [];
    while (picked.length < Math.min(N, pool.length)) {
      const i = Math.floor(rnd() * pool.length);
      picked.push(pool.splice(i, 1)[0]);
    }
    targets = picked;
  }

  console.log('═'.repeat(78));
  console.log(`嚴格口徑抽樣複驗 ${targets.length} 個 HLS 頻道`);
  console.log('═'.repeat(78));

  const results = [];
  const queue = [...targets];
  let done = 0;
  async function worker() {
    while (queue.length) {
      const ch = queue.shift();
      let r;
      try {
        r = await audit(ch);
      } catch (e) {
        r = { ok: false, reason: `例外 ${e.name ?? e.message}` };
      }
      results.push({
        channel_id: ch.channel_id,
        channel_name: ch.channel_name,
        region: ch.region,
        stream_url: ch.stream_url,
        ...r,
      });
      done++;
      process.stdout.write(`  驗證中 ${done}/${targets.length}\r`);
    }
  }
  await Promise.all(Array.from({ length: 4 }, () => worker()));
  process.stdout.write(' '.repeat(40) + '\r');

  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  console.log('\n不通過：');
  for (const r of bad) {
    console.log(`  ✗ ${r.channel_name} [${r.path ?? '-'}] ${r.reason}`);
    console.log(`      ${r.stream_url}`);
  }
  console.log('─'.repeat(78));
  console.log(`通過 ${ok.length}/${results.length}｜不通過 ${bad.length}`);
  console.log('通過明細：');
  for (const r of ok) {
    console.log(`  ✓ ${r.channel_name.padEnd(18)} [${r.path}] ${r.kind} seq=${r.seq} seg=${r.segments_ok} hash=${r.seg_hash}`);
  }

  writeFileSync(OUT, JSON.stringify({ audited_at: new Date().toISOString(), results }, null, 2) + '\n', 'utf8');
  console.log(`寫入 ${OUT}`);
}

await main();
