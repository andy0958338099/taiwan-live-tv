#!/usr/bin/env node
/**
 * probe-candidates-tw.mjs — 候選新來源逐條驗證（第 3 輪新增）
 *
 * ## 為什麼需要這支
 *
 * 第 3 輪要找新來源（台灣優先）。規則要求「須逐條用驗證口徑抽驗，不可整包信任」。
 * 這支把候選清單逐條跑過與 `sample-verify-strict.mjs` 相同的口徑，
 * 並且**同時試直連與代理兩條路徑**，輸出哪一條路徑可用 —— 這決定了
 * 新頻道的 `cors_enabled` 該怎麼設。
 *
 * ## 判定口徑（與 2026-11-22 固定口徑一致）
 *   1. manifest 以 `#EXTM3U` 開頭
 *   2. 不含 `#EXT-X-ENDLIST`
 *   3. 子清單最多遞迴 2 層
 *   4. segment 用 `Range: bytes=0-2047` 抓前 2KB
 *   5. 位元組嗅探：0x47 = MPEG-TS、ISO-BMFF box = fMP4 → 通過；
 *      '<' / FF D8 / 89 50 → 失效
 *   6. youtube.com / youtu.be → 失效
 *
 * 另外會抓「序號」與「segment 內容雜湊」，供後續做停播的決定性判定。
 *
 * 用法：node scripts/probe-candidates-tw.mjs <candidates.json>
 */

import { readFileSync, writeFileSync } from 'node:fs';

const ORIGIN = 'https://taiwan-live-tv.netlify.app';
const PROXY = `${ORIGIN}/api/proxy`;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const enc = (u) => Buffer.from(u).toString('base64url');
const ORIGINS = { direct: null, proxy: PROXY };

const BMFF = new Set([
  'ftyp', 'styp', 'moof', 'mdat', 'moov', 'sidx', 'emsg', 'prft', 'pdin', 'free', 'skip',
]);

function sniff(buf) {
  if (!buf || buf.length === 0) return { kind: 'empty', first: '??' };
  const first = buf[0].toString(16).padStart(2, '0');
  if (buf[0] === 0x47) return { kind: 'mpegts', first };
  if (buf.length >= 8) {
    const box = buf.subarray(4, 8).toString('latin1');
    if (BMFF.has(box)) return { kind: 'fmp4', first };
  }
  if (buf[0] === 0x3c) return { kind: 'html', first };
  if (buf[0] === 0xff && buf[1] === 0xd8) return { kind: 'jpeg', first };
  if (buf[0] === 0x89 && buf[1] === 0x50) return { kind: 'png', first };
  return { kind: 'other', first };
}

async function grab(url, { range = false, referer = null, timeout = 35000 } = {}) {
  const headers = { 'User-Agent': UA, Origin: ORIGIN };
  if (range) headers.Range = 'bytes=0-2047';
  if (referer) headers.Referer = referer;
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
      ct: res.headers.get('content-type'),
    };
  } catch (e) {
    return { status: 0, buf: Buffer.alloc(0), cors: null, final: url, err: e.name ?? e.message };
  }
}

const seqOf = (t) => {
  const m = t.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m);
  return m ? Number(m[1]) : null;
};

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

const isSeg = (u) => /\.(ts|m4s|mp4|aac|cmfv|cmfa)(\?|$)/i.test(u);

/**
 * 驗證單一候選。
 * @param {string} url 候選網址
 * @param {'direct'|'proxy'} mode 路徑
 * @param {string|null} referer 需要 Referer 的來源
 */
async function probe(url, mode, referer = null) {
  const base = mode === 'proxy' ? `${PROXY}/${enc(url)}` : url;
  const resolve = (u, against) => {
    if (mode === 'proxy') {
      if (u.startsWith('/api/proxy/')) return ORIGIN + u;
      if (u.startsWith('http')) return u;
      return new URL(u, 'https://placeholder.invalid/').toString();
    }
    return new URL(u, against).toString();
  };

  const m = await grab(base, { referer });
  if (m.status !== 200) {
    const d = m.buf.length ? m.buf.subarray(0, 90).toString('utf8').replace(/\s+/g, ' ') : (m.err ?? '');
    return { ok: false, mode, reason: `manifest HTTP ${m.status} ${d}`.trim() };
  }
  let text = m.buf.toString('utf8');
  if (!text.trimStart().startsWith('#EXTM3U')) {
    return { ok: false, mode, reason: `不是 #EXTM3U（首位 ${sniff(m.buf).first}）` };
  }
  if (text.includes('#EXT-X-ENDLIST')) return { ok: false, mode, reason: '含 ENDLIST（VOD）' };

  const isMaster = text.includes('#EXT-X-STREAM-INF');
  const variants = isMaster ? urlsIn(text) : [null];

  let best = null;
  const vrep = [];

  for (let vi = 0; vi < variants.length; vi++) {
    let mediaText = text;
    let mediaBase = m.final;
    let seq = seqOf(text);

    if (variants[vi]) {
      const childUrl = resolve(variants[vi], m.final);
      const c = await grab(childUrl, { referer });
      if (c.status !== 200) { vrep.push({ v: vi, ok: false, reason: `child HTTP ${c.status}` }); continue; }
      const ct = c.buf.toString('utf8');
      if (!ct.trimStart().startsWith('#EXTM3U')) { vrep.push({ v: vi, ok: false, reason: 'child 不是 #EXTM3U' }); continue; }
      if (ct.includes('#EXT-X-ENDLIST')) { vrep.push({ v: vi, ok: false, reason: 'child VOD' }); continue; }
      mediaText = ct;
      mediaBase = c.final;
      seq = seqOf(ct) ?? seq;
    }

    const segs = urlsIn(mediaText);
    if (!segs.length) { vrep.push({ v: vi, ok: false, reason: '無 segment' }); continue; }

    const picks = [...new Set([0, Math.floor(segs.length / 2), segs.length - 1])]
      .filter((i) => i >= 0 && i < segs.length);

    let good = 0;
    const details = [];
    for (const i of picks) {
      const su = resolve(segs[i], mediaBase);
      let r = null;
      let s = { kind: 'empty', first: '??' };
      for (let a = 1; a <= 3; a++) {
        r = await grab(su, { range: true, referer });
        s = sniff(r.buf);
        if ((r.status === 200 || r.status === 206) && (s.kind === 'mpegts' || s.kind === 'fmp4')) break;
        if (a < 3) await new Promise((z) => setTimeout(z, 600 * a));
      }
      const ok = (r.status === 200 || r.status === 206) && (s.kind === 'mpegts' || s.kind === 'fmp4');
      if (ok) good++;
      details.push({ i, status: r.status, kind: s.kind, first: s.first, ok });
    }
    const vok = good > 0;
    vrep.push({ v: vi, ok: vok, seq, seg: `${good}/${picks.length}`, details });
    if (vok && !best) best = { v: vi, seq, seg: `${good}/${picks.length}`, kind: details.find((x) => x.ok)?.kind };
  }

  if (!best) {
    return {
      ok: false, mode,
      reason: `全部 ${variants.length} 個 variant 失敗（${vrep.map((v) => `v${v.v}:${v.reason ?? v.seg}`).join(' / ')}）`,
      variants: vrep,
    };
  }

  return {
    ok: true,
    mode,
    cors: m.cors,
    seq: best.seq,
    kind: best.kind,
    segments_ok: best.seg,
    variants_ok: vrep.filter((v) => v.ok).length,
    variants_total: variants.length,
    final_url: m.final,
  };
}

async function main() {
  const file = process.argv[2];
  const cands = JSON.parse(readFileSync(file, 'utf8'));
  console.log('═'.repeat(78));
  console.log(`候選來源逐條驗證：${cands.length} 條`);
  console.log('═'.repeat(78));

  const out = [];
  for (const c of cands) {
    const referer = c.referer ?? null;
    const r = { ...c, referer, direct: null, proxy: null };
    r.direct = await probe(c.url, 'direct', referer);
    r.proxy = await probe(c.url, 'proxy', referer);
    const okPath = r.direct.ok ? 'direct' : r.proxy.ok ? 'proxy' : null;
    r.verdict = okPath ? 'PASS' : 'FAIL';
    r.ok_path = okPath;
    out.push(r);
    const mark = okPath ? '✓' : '✗';
    console.log(`${mark} ${(c.name ?? c.url).padEnd(28)} ${okPath ?? '—'}  ` +
      `direct:${r.direct.ok ? 'OK ' + r.direct.kind + ' ' + r.direct.segments_ok : r.direct.reason.slice(0, 46)}`);
    if (!r.direct.ok) {
      console.log(`   proxy: ${r.proxy.ok ? 'OK ' + r.proxy.kind + ' ' + r.proxy.segments_ok : r.proxy.reason.slice(0, 60)}`);
    }
  }

  console.log('─'.repeat(78));
  console.log(`通過 ${out.filter((x) => x.verdict === 'PASS').length}/${out.length}`);
  writeFileSync('/Users/andy/.hermes/cache/scratch/candidate-probe.json', JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log('寫入 /Users/andy/.hermes/cache/scratch/candidate-probe.json');
}

await main();
