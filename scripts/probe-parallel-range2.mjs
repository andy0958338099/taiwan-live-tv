#!/usr/bin/env node
/**
 * probe-parallel-range2.mjs — 用**新鮮的** segment 測試平行 Range 下載
 *
 * ## 為什麼要重測
 *
 * 直播 segment 只活約 30 秒。第一版測試先做了「單線完整下載」（75–140 秒），
 * 等到要做平行測試時 segment 早就過期 → 上游回 163 bytes 的 HTML 錯誤頁
 * → 測出來的「平行只要 200ms」是假的。
 *
 * 這個教訓很重要：**每次測平行下載都必須重新抓 manifest 拿新鮮 segment**，
 * 而且兩種下載要**各自**用不同的 manifest 實例（否則前一次測試會讓 segment 過期）。
 *
 * ## 這個測試決定代理的架構
 *
 *   · 若平行 N 段能達到 N 倍速度 → 代理可以在 30 秒內組出完整 segment，
 *     使用者就能拿到**完整**的影片，而不是被截斷的。
 *   · 若總頻寬固定 → 平行無效，只能讓代理「快速失敗 + 讓播放器換源」。
 *
 * 用法：node scripts/probe-parallel-range2.mjs [--sizes 4,8,16]
 */

import { fileURLToPath } from 'node:url';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const UPSTREAMS = [
  {
    name: '央視-7 國防軍事',
    manifest:
      'http://121.19.134.149:808/tsfile/live/0007_1.m3u8?key=txiptv&playlive=1&authid=0',
  },
  {
    name: '央視-1 綜合',
    manifest:
      'http://121.19.134.149:808/tsfile/live/0001_1.m3u8?key=txiptv&playlive=1&authid=0',
  },
];

const SIZES = arg('sizes', '4,8,16')
  .split(',')
  .map((s) => parseInt(s, 10))
  .filter(Boolean);

async function freshSegment(manifestUrl) {
  const res = await fetch(manifestUrl, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  const seg = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))[0];
  if (!seg) throw new Error('manifest 無 segment');
  return new URL(seg, manifestUrl).href;
}

async function totalLength(segUrl) {
  const res = await fetch(segUrl, {
    headers: { 'User-Agent': UA, Range: 'bytes=0-' },
    signal: AbortSignal.timeout(15_000),
  });
  const cr = res.headers.get('content-range');
  const total = cr ? Number(cr.split('/')[1]) : Number(res.headers.get('content-length'));
  await res.body?.cancel();
  return total;
}

async function parallelDownload(segUrl, total, n) {
  const part = Math.ceil(total / n);
  const t0 = Date.now();
  const lens = await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const s = i * part;
      const e = Math.min(total - 1, (i + 1) * part - 1);
      const r = await fetch(segUrl, {
        headers: { 'User-Agent': UA, Range: `bytes=${s}-${e}` },
        signal: AbortSignal.timeout(60_000),
      });
      const b = await r.arrayBuffer();
      return b.byteLength;
    }),
  );
  const ms = Date.now() - t0;
  const got = lens.reduce((a, b) => a + b, 0);
  return { got, ms, bps: Math.round(got / (ms / 1000)) };
}

async function main() {
  console.log('═'.repeat(72));
  console.log('平行 Range 下載（每次都用新鮮 segment）');
  console.log('═'.repeat(72));

  for (const c of UPSTREAMS) {
    console.log(`\n▶ ${c.name}`);

    for (const n of SIZES) {
      // ⚠️ 每個 N 都重新抓 manifest → 一定是還沒過期的 segment
      const segUrl = await freshSegment(c.manifest);
      const total = await totalLength(segUrl);
      const r = await parallelDownload(segUrl, total, n);
      const complete = r.got === total;
      console.log(
        `  平行 ${String(n).padStart(2)}：${r.got}/${total} bytes  ` +
          `${String(r.ms).padStart(6)}ms  ${String(r.bps).padStart(7)} B/s  ` +
          `${complete ? '✓ 完整' : '✗ 不完整（segment 已過期？）'}  ` +
          `${r.ms < 30_400 ? '✓ 30 秒內可完成' : '✗ 超過平台時限'}`,
      );
    }
  }
}

await main();
