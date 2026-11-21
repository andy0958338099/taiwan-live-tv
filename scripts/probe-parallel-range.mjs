#!/usr/bin/env node
/**
 * probe-parallel-range.mjs — 測試「平行 Range 下載」能否塞進平台的回應時限
 *
 * 背景（2026-11-21 線上實測）：
 *   央視來源的 segment 是 5.4 MB，從 Netlify edge 下載只有 38–100 KB/s
 *   → 單線需要 54–140 秒，但平台在 ~30.4 秒就切斷回應，
 *     導致代理送出 `HTTP 200` + **被截斷的 segment**，
 *     而且因為帶 `Cache-Control: max-age=300`，**壞內容被 CDN 快取 5 分鐘**。
 *
 * 本腳本回答一個問題：**上游是「每連線限速」還是「總頻寬限速」？**
 *   · 若平行 N 段能達到 N 倍速度 → 代理可以用平行 Range 把它壓進時限內
 *   · 若總頻寬固定 → 平行無效，只能靠「快速失敗 + failover」
 *
 * 用法：node scripts/probe-parallel-range.mjs [--urls 2] [--sizes 8,16,24]
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

const SIZES = arg('sizes', '8,16,24')
  .split(',')
  .map((s) => parseInt(s, 10))
  .filter(Boolean);

async function firstSegment(manifestUrl) {
  const res = await fetch(manifestUrl, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20_000),
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
    signal: AbortSignal.timeout(20_000),
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
        signal: AbortSignal.timeout(120_000),
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
  console.log('平行 Range 下載 vs 平台 30 秒回應時限');
  console.log('═'.repeat(72));

  for (const c of UPSTREAMS) {
    console.log(`\n▶ ${c.name}`);
    const segUrl = await firstSegment(c.manifest);
    const total = await totalLength(segUrl);
    console.log(`  segment 總長：${total} bytes（${(total / 1048576).toFixed(1)} MB）`);

    // 單線基準
    const t0 = Date.now();
    let singleBytes = 0;
    try {
      const r = await fetch(segUrl, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(150_000),
      });
      singleBytes = (await r.arrayBuffer()).byteLength;
    } catch (e) {
      console.log(`  單線下載失敗：${e.name}`);
    }
    const singleMs = Date.now() - t0;
    console.log(
      `  單線：${singleBytes} bytes  ${singleMs}ms  ` +
        `${Math.round(singleBytes / (singleMs / 1000))} B/s` +
        `${singleMs > 30_400 ? '  ⚠ 超過 30 秒平台時限' : ''}`,
    );

    for (const n of SIZES) {
      const r = await parallelDownload(segUrl, total, n);
      const complete = r.got === total;
      console.log(
        `  平行 ${String(n).padStart(2)}：${r.got}/${total} bytes  ` +
          `${r.ms}ms  ${r.bps} B/s  ` +
          `${complete ? '✓ 完整' : '✗ 不完整'}  ` +
          `${r.ms < 30_400 ? '✓ 可塞進平台時限' : '✗ 仍超時'}`,
      );
    }
  }
}

await main();
