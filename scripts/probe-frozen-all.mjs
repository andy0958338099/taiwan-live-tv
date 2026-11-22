#!/usr/bin/env node
/**
 * probe-frozen-all.mjs — 對清單裡所有 HLS 頻道做「內容雜湊」式的停播判定
 *
 * 這是 `probe-frozen-decisive.mjs` 的並行版本，處理整份 channels.json。
 *
 * 判定標準（決定性）：
 *   · 連續 N 次取樣，取最新 segment 的 sha256
 *   · 雜湊不變 → 真的停播（畫面凍結）
 *   · 雜湊會變 → 還在播
 *
 * 同時也記錄 MEDIA-SEQUENCE 供對照（序號是必要但不充分條件 —— 會被 CDN 快取騙到）。
 *
 * 用法：node scripts/probe-frozen-all.mjs [--conc 6] [--samples 3] [--gap 12000]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const CONC = parseInt(arg('conc', '6'), 10);
const SAMPLES = parseInt(arg('samples', '3'), 10);
const GAP_MS = parseInt(arg('gap', '12000'), 10);

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const get = (url, headers = {}) =>
  fetch(url, {
    headers: { 'User-Agent': UA, ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });

const seqOf = (t) => {
  const m = t.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m);
  return m ? Number(m[1]) : null;
};

/** 追到 media playlist 的最新 segment */
async function latestSegment(url) {
  const res = await get(url);
  if (!res.ok) return { err: `HTTP ${res.status}` };
  let text = await res.text();
  if (!text.trimStart().startsWith('#EXTM3U')) return { err: '非 m3u8' };
  if (text.includes('#EXT-X-ENDLIST')) return { err: 'VOD' };
  let mediaUrl = url;

  for (let depth = 0; depth < 2; depth++) {
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (!lines.length) return { err: '無 segment' };
    const segUrl = new URL(lines[lines.length - 1], mediaUrl).href;
    const sres = await get(segUrl, { Range: 'bytes=0-2047' });
    if (!sres.ok && sres.status !== 206) {
      return { err: `segment HTTP ${sres.status}` };
    }
    const buf = Buffer.from(await sres.arrayBuffer());
    if (buf.subarray(0, 7).toString('latin1') === '#EXTM3U') {
      const full = await get(segUrl);
      text = full.ok ? await full.text() : buf.toString('utf8');
      mediaUrl = segUrl;
      continue;
    }
    return {
      seq: seqOf(text),
      hash: createHash('sha256').update(buf).digest('hex').slice(0, 12),
      bytes: buf.length,
      first: buf[0],
    };
  }
  return { err: '超過最大遞迴層數' };
}

const catalog = JSON.parse(readFileSync(join(ROOT, 'shared', 'channels.json'), 'utf8'));
const targets = catalog.channels.filter((c) => !c.embed_url && c.stream_url);

console.log(`對 ${targets.length} 個 HLS 頻道做內容雜湊判定（${SAMPLES} 次取樣，間隔 ${GAP_MS}ms）`);
console.log('═'.repeat(78));

const results = [];
const queue = [...targets];
let done = 0;

async function worker() {
  while (queue.length) {
    const ch = queue.shift();
    const seqs = [];
    const hashes = [];
    let err = null;
    for (let i = 0; i < SAMPLES; i++) {
      try {
        const r = await latestSegment(ch.stream_url);
        if (r.err) {
          err = r.err;
          seqs.push(null);
          hashes.push(null);
        } else {
          seqs.push(r.seq);
          hashes.push(r.hash);
          err = null;
        }
      } catch (e) {
        err = `例外 ${e.name ?? e.message}`;
        seqs.push(null);
        hashes.push(null);
      }
      if (i < SAMPLES - 1) await new Promise((x) => setTimeout(x, GAP_MS));
    }
    const hashMoved = hashes[0] != null && hashes[hashes.length - 1] !== hashes[0];
    const seqMoved = seqs[0] != null && seqs[seqs.length - 1] !== seqs[0];
    const status = hashMoved || seqMoved ? 'live' : err ? 'error' : 'frozen';
    results.push({
      channel_id: ch.channel_id,
      channel_name: ch.channel_name,
      region: ch.region,
      stream_url: ch.stream_url,
      status,
      seqs,
      hashes,
      error: err,
    });
    done++;
    process.stdout.write(`  ${done}/${targets.length}\r`);
  }
}

await Promise.all(Array.from({ length: CONC }, worker));
process.stdout.write(' '.repeat(30) + '\r');

const order = new Map(targets.map((c, i) => [c.channel_id, i]));
results.sort((a, b) => (order.get(a.channel_id) ?? 0) - (order.get(b.channel_id) ?? 0));

console.log('');
console.log('停播（序號與內容雜湊都不動 —— 使用者只會看到畫面凍結）：');
for (const r of results.filter((x) => x.status === 'frozen')) {
  console.log(`  ✗ ${r.channel_name.padEnd(20)} seq ${r.seqs[0]} | ${r.stream_url}`);
}
console.log('');
console.log('錯誤：');
for (const r of results.filter((x) => x.status === 'error')) {
  console.log(`  ✗ ${r.channel_name.padEnd(20)} ${r.error} | ${r.stream_url}`);
}
console.log('─'.repeat(78));
console.log(
  `還在播 ${results.filter((r) => r.status === 'live').length}｜停播 ${
    results.filter((r) => r.status === 'frozen').length
  }｜錯誤 ${results.filter((r) => r.status === 'error').length}`,
);

writeFileSync(
  '/Users/andy/.hermes/cache/scratch/frozen-all.json',
  JSON.stringify({ at: new Date().toISOString(), results }, null, 2) + '\n',
  'utf8',
);
console.log('已寫入 /Users/andy/.hermes/cache/scratch/frozen-all.json');
