#!/usr/bin/env node
/**
 * probe-frozen-decisive.mjs — 用「segment 內容雜湊」判定是否真的停播
 *
 * ## 為什麼需要這個
 *
 * 2026-11-22 實測教訓：只看 `MEDIA-SEQUENCE` 會被 CDN 快取騙到。
 *   · 同時跑多個探測器時，CDN 對 media playlist 回應快取，
 *     兩邊讀到同一份舊清單 → 序號看起來不動 → 誤判「已停播」。
 *   · 實際上序號有在動（例：gdzj 1750412925 → 1750412928 → 1750412931）。
 *
 * 決定性做法：**對同一個 segment 連續取樣並比對內容雜湊**。
 *   · 內容雜湊不變 = 那一格畫面一直沒變 = 真的停播。
 *   · 雜湊會變（或清單序號會動） = 還在播。
 *
 * 對象是「已經有清單網址」的來源，所以直接走清單 → segment。
 *
 * 用法：node scripts/probe-frozen-decisive.mjs <url> [<url> ...]
 */

import { createHash } from 'node:crypto';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const SAMPLES = 3;
const GAP_MS = 14000;

const seqOf = (t) => {
  const m = t.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m);
  return m ? Number(m[1]) : null;
};

async function get(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  return res;
}

/** 從網址追到 media playlist（最多兩層），回 { mediaUrl, text } */
async function resolveMedia(url) {
  const res = await get(url);
  if (!res.ok) return { err: `HTTP ${res.status}` };
  let text = await res.text();
  if (!text.trimStart().startsWith('#EXTM3U')) return { err: '非 m3u8' };
  let mediaUrl = url;
  for (let depth = 0; depth < 2; depth++) {
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (!lines.length) return { err: '無 segment' };
    // 取「最新的」segment（直播清單由舊到新）
    const seg = lines[lines.length - 1];
    const segUrl = new URL(seg, mediaUrl).href;
    const sres = await get(segUrl, { Range: 'bytes=0-2047' });
    if (!sres.ok && sres.status !== 206) {
      return { err: `segment HTTP ${sres.status}` };
    }
    const buf = Buffer.from(await sres.arrayBuffer());
    if (buf.subarray(0, 7).toString('latin1') === '#EXTM3U') {
      // 還是清單 → 再往下
      const full = await get(segUrl);
      text = full.ok ? await full.text() : buf.toString('utf8');
      mediaUrl = segUrl;
      continue;
    }
    return { mediaUrl, text, segUrl, segBytes: buf.length };
  }
  return { err: '超過最大遞迴層數' };
}

for (const url of process.argv.slice(2)) {
  const r = await resolveMedia(url);
  if (r.err) {
    console.log(`✗ ${url}\n    ${r.err}`);
    continue;
  }
  const seqs = [];
  const hashes = [];
  for (let i = 0; i < SAMPLES; i++) {
    // 每次重新解析清單 → 取最新 segment
    const rr = await resolveMedia(url);
    if (rr.err) {
      seqs.push(null);
      hashes.push(null);
    } else {
      seqs.push(seqOf(rr.text));
      const sres = await get(rr.segUrl, { Range: 'bytes=0-2047' });
      const buf = Buffer.from(await sres.arrayBuffer());
      hashes.push(createHash('sha256').update(buf).digest('hex').slice(0, 12));
    }
    if (i < SAMPLES - 1) await new Promise((x) => setTimeout(x, GAP_MS));
  }
  const seqMoved = seqs[0] !== null && seqs[seqs.length - 1] !== seqs[0];
  const hashMoved = hashes[0] !== null && hashes[hashes.length - 1] !== hashes[0];
  const verdict = seqMoved || hashMoved ? '▶ 還在播' : '✗ 已停播';
  console.log(`${verdict} ${url}`);
  console.log(`    seq: ${seqs.join(' → ')}`);
  console.log(`    hash: ${hashes.join(' → ')}`);
}
