#!/usr/bin/env node
/**
 * audit-ref-sources.mjs — 對「需要 Referer」的來源做完整驗證
 *
 * 背景：某些廣播商 CDN（如大愛電視 pulltv1.wanfudaluye.com）會對
 * 沒有正確 Referer 的請求回 403，所以必須帶 Referer 才能驗證。
 * 這裡把 Referer 納入所有層級（manifest / child / segment）。
 */
import { readFileSync } from 'node:fs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const TARGETS = process.argv.slice(2).filter((a) => !a.startsWith('--'));

function sniff(buf) {
  if (!buf || !buf.length) return { kind: 'empty' };
  if (buf[0] === 0x47) return { kind: 'mpegts' };
  if (buf[0] === 0x3c) return { kind: 'html' };
  if (buf[0] === 0xff && buf[1] === 0xd8) return { kind: 'jpeg' };
  if (buf[0] === 0x89 && buf[1] === 0x50) return { kind: 'png' };
  if (buf.length > 8) {
    const b = buf.subarray(4, 8).toString('latin1');
    if (['ftyp', 'styp', 'moof', 'mdat'].includes(b)) return { kind: 'fmp4' };
  }
  const p = buf.subarray(0, 64).toString('latin1');
  if (p.includes('ftyp') || p.includes('moof') || p.includes('mdat')) {
    return { kind: 'fmp4' };
  }
  return { kind: 'unknown', first: buf[0].toString(16) };
}

async function get(url, referer) {
  return fetch(url, {
    headers: { 'User-Agent': UA, Referer: referer, Origin: referer },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
}

async function audit(url, referer) {
  const res = await get(url, referer);
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, url };
  const cors = res.headers.get('access-control-allow-origin');
  const text = await res.text();
  if (!text.trimStart().startsWith('#EXTM3U')) {
    return { ok: false, reason: '非 m3u8', url };
  }
  if (text.includes('#EXT-X-ENDLIST')) {
    return { ok: false, reason: 'VOD', url };
  }
  const seqM = text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m);
  const seq = seqM ? Number(seqM[1]) : null;
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return { ok: false, reason: '無 segment', url };

  let mediaUrl = url;
  let mediaText = text;
  let segs = lines;
  if (!/\.(ts|m4s|mp4|aac)(\?|$)/i.test(lines[0])) {
    const childUrl = new URL(lines[0], url).href;
    const cres = await get(childUrl, referer);
    if (!cres.ok) return { ok: false, reason: `child HTTP ${cres.status}`, url };
    const ctext = await cres.text();
    if (!ctext.trimStart().startsWith('#EXTM3U')) {
      return { ok: false, reason: 'child 非 m3u8', url };
    }
    if (ctext.includes('#EXT-X-ENDLIST')) {
      return { ok: false, reason: 'child VOD', url };
    }
    const cl = ctext
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (!cl.length) return { ok: false, reason: 'child 無 segment', url };
    const cseq = ctext.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m);
    mediaUrl = childUrl;
    mediaText = ctext;
    segs = cl;
  }

  const ordered = [segs[0], ...[...segs].reverse().filter((s) => s !== segs[0]).slice(0, 3)];
  let lastReason = '無 segment';
  for (const seg of ordered) {
    const segUrl = new URL(seg, mediaUrl).href;
    const t0 = Date.now();
    let sres;
    try {
      sres = await get(segUrl, referer);
    } catch (e) {
      lastReason = `segment 失敗 ${e.name}`;
      continue;
    }
    const ms = Date.now() - t0;
    if (!sres.ok) {
      lastReason = `segment HTTP ${sres.status}`;
      continue;
    }
    const buf = Buffer.from(await sres.arrayBuffer());
    const s = sniff(buf);
    if (s.kind !== 'mpegts' && s.kind !== 'fmp4') {
      return { ok: false, reason: `位元組不符：${s.kind} 首位 ${s.first}`, url };
    }
    // 停播檢查
    let frozen = false;
    if (seq !== null) {
      const tdM = mediaText.match(/^#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/m);
      const td = tdM ? Number(tdM[1]) : 6;
      await new Promise((r) => setTimeout(r, Math.min(td * 1000 + 1500, 20000)));
      const again = await get(mediaUrl, referer);
      const t2 = again.ok ? await again.text() : '';
      const m2 = t2.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m);
      if (m2 && Number(m2[1]) === seq) frozen = true;
    }
    return {
      ok: !frozen,
      reason: frozen ? `已停播（序號停在 ${seq}）` : '',
      kind: s.kind,
      bytes: buf.length,
      ms,
      seq,
      cors,
      url,
    };
  }
  return { ok: false, reason: lastReason, url };
}

const results = [];
for (const t of TARGETS) {
  const [url, referer] = t.split('|');
  let r;
  try {
    r = await audit(url, referer ?? 'https://www.daai.tv/');
  } catch (e) {
    r = { ok: false, reason: `例外 ${e.name ?? e.message}`, url };
  }
  results.push(r);
  console.log(
    `${r.ok ? '✓' : '✗'} ${url}\n    ${r.reason || `${r.kind} ${r.bytes}B ${r.ms}ms seq=${r.seq} CORS=${r.cors}`}\n    referer: ${referer}`,
  );
}
console.log(`\n通過 ${results.filter((r) => r.ok).length}/${results.length}`);
