#!/usr/bin/env node
/**
 * probe-slow-segment.mjs — 診斷慢速 segment 的兩件事
 *
 * [1] 代理回應是否被截斷（拿上游 Content-Length 當基準）
 * [2] 上游是否支援「平行 Range」→ 若支援，就能把 90 秒的單線下載壓到 30 秒內
 *
 * 用法：node scripts/probe-slow-segment.mjs [--base https://taiwan-live-tv.netlify.app]
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const BASE = arg('base', 'https://taiwan-live-tv.netlify.app');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const encodeTarget = (t) => Buffer.from(t, 'utf8').toString('base64url');

const UPSTREAMS = [
  {
    name: '央視-7 國防軍事',
    upstream:
      'http://121.19.134.149:808/tsfile/live/0007_1.m3u8?key=txiptv&playlive=1&authid=0',
  },
  {
    name: '央視-1 綜合',
    upstream:
      'http://121.19.134.149:808/tsfile/live/0001_1.m3u8?key=txiptv&playlive=1&authid=0',
  },
];

async function readAll(res) {
  const t0 = Date.now();
  let n = 0;
  const rd = res.body?.getReader();
  if (!rd) return { bytes: 0, ms: 0 };
  try {
    while (true) {
      const { done, value } = await rd.read();
      if (done) break;
      n += value.length;
    }
  } catch {
    /* 中斷 */
  }
  return { bytes: n, ms: Date.now() - t0 };
}

async function main() {
  console.log('═'.repeat(70));
  console.log('慢速 segment 診斷');
  console.log('═'.repeat(70));

  for (const c of UPSTREAMS) {
    console.log(`\n▶ ${c.name}`);

    // ── 取得上游 manifest 的第一個 segment ──
    const mres = await fetch(c.upstream, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(20_000),
    });
    const mtext = await mres.text();
    const segRel = mtext
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))[0];
    if (!segRel) {
      console.log('  manifest 無 segment');
      continue;
    }
    const segUrl = new URL(segRel, c.upstream).href;

    // ── 上游的總長（用 Range: bytes=0- 取得 Content-Range）──
    const hres = await fetch(segUrl, {
      headers: { 'User-Agent': UA, Range: 'bytes=0-' },
      signal: AbortSignal.timeout(20_000),
    });
    const cr = hres.headers.get('content-range');
    const total = cr ? Number(cr.split('/')[1]) : Number(hres.headers.get('content-length'));
    const clHeader = hres.headers.get('content-length');
    await hres.body?.cancel();
    console.log(`  上游 segment 總長：${total} bytes（Content-Length: ${clHeader}）`);
    if (!total || total < 10000) {
      console.log('  （segment 已過期或太小，改用 manifest 裡下一個）');
      continue;
    }

    // ── [1] 透過代理：實際收到多少 bytes ──
    const t0 = Date.now();
    const pres = await fetch(`${BASE}/api/proxy/${encodeTarget(segUrl)}`, {
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity' },
      signal: AbortSignal.timeout(120_000),
    });
    const via = await readAll(pres);
    console.log(
      `  [1] 透過代理：bytes=${via.bytes}/${total} ` +
        `(${((via.bytes / total) * 100).toFixed(1)}%)  耗時=${via.ms}ms  ` +
        `HTTP ${pres.status}  cc=${pres.headers.get('cache-control')}`,
    );
    console.log(
      `      age=${pres.headers.get('age') ?? '-'}  ` +
        `cache-status=${(pres.headers.get('cache-status') ?? '-').slice(0, 80)}`,
    );

    // ── [2] 平行 Range：能否壓到 30 秒內 ──
    const N = 8;
    const part = Math.ceil(total / N);
    const t1 = Date.now();
    const parts = await Promise.all(
      Array.from({ length: N }, async (_, i) => {
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
    const got = parts.reduce((a, b) => a + b, 0);
    const parMs = Date.now() - t1;
    console.log(
      `  [2] 平行 ${N} 段 Range：${got}/${total} bytes  耗時=${parMs}ms  ` +
        `平均=${Math.round(got / (parMs / 1000))} B/s`,
    );
    console.log(
      `      單線串流實測約需 90–140 秒 → 平行後 ${parMs}ms` +
        `${parMs < 25000 ? ' ✓ 可塞進 30 秒上限' : ' ✗ 仍超時'}`,
    );
  }
}

await main();
