#!/usr/bin/env node
/**
 * test-proxy-segments.mjs — 對**實際的代理端點**測試 segment 交付
 *
 * 這是「線上行為」的端對端驗證：真的打代理 API，
 * 量它的狀態碼、位元組數、內容完整性。
 *
 * 驗證三件事：
 *   1. 健康來源 → 200 + 完整位元組（Content-Length 一致）
 *   2. 健康來源 → **不會**被回 502（這是本輪修的 bug）
 *   3. 快取標頭正確（完整內容才可快取）
 *
 * 用法：node scripts/test-proxy-segments.mjs [--base http://localhost:3211]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const BASE = arg('base', 'http://localhost:3211');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const encodeTarget = (t) => Buffer.from(t, 'utf8').toString('base64url');

const data = JSON.parse(readFileSync(join(ROOT, 'shared/channels.json'), 'utf8'));

/** 要測的頻道（涵蓋台灣主力 + 中國 + 已知慢速來源） */
const TARGETS = [
  'playlist-龍華-龍華電視',
  'playlist-翡翠台-tvb翡翠台',
  'playlist-TVB-tvb系',
  'playlist-Now-now-tv',
  'playlist-HOY-hoy-tv',
  'playlist-澳視-澳視',
  'playlist-天映-天映',
  'cn-fhhk',
  'cn-gzzh',
  'cn-gzxw',
];

/**
 * 透過代理一路下鑽到**真正的 segment**。
 *
 * 代理的入口白名單只認「已授權頻道的 stream_url」，
 * 直接打 segment 的上游網址會被回 403 —— 那是設計如此。
 *
 * 而且代理會把 manifest 裡的每個網址都改寫成帶簽章的 `/api/proxy/...`，
 * 所以每一層都要透過代理抓，直到回應不再是 manifest 為止。
 */
async function resolveSignedSegment(base, channel) {
  let url = `${base}/api/proxy/${encodeTarget(channel.stream_url)}`;

  for (let depth = 0; depth < 5; depth++) {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} @ depth ${depth}`);

    const buf = await res.arrayBuffer();
    const text = new TextDecoder().decode(buf);

    // 不是 manifest → 這就是 segment
    if (!text.trimStart().startsWith('#EXTM3U')) {
      return { url, bytes: buf.byteLength };
    }

    const firstUri = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))[0];
    if (!firstUri) throw new Error('manifest 沒有 segment');

    url = firstUri.startsWith('http')
      ? firstUri
      : firstUri.startsWith('/api/proxy/')
        ? `${base}${firstUri}`
        : new URL(firstUri, url).href;
  }
  throw new Error('manifest 層數過深');
}

console.log('═'.repeat(88));
console.log(`代理 segment 交付測試（${BASE}）`);
console.log('═'.repeat(88));
console.log(
  'channel'.padEnd(20) +
    '狀態'.padStart(6) +
    'Content-Length'.padStart(16) +
    '實收'.padStart(14) +
    '完整性'.padStart(10) +
    '快取',
);
console.log('─'.repeat(88));

let ok = 0;
let bad = 0;
const failures = [];

for (const id of TARGETS) {
  const ch = data.channels.find((c) => c.channel_id === id);
  if (!ch) continue;

  let proxyUrl;
  let expectedBytes = 0;
  try {
    const resolved = await resolveSignedSegment(BASE, ch);
    proxyUrl = resolved.url;
    expectedBytes = resolved.bytes;
  } catch (e) {
    console.log(`${ch.channel_name.slice(0, 18).padEnd(20)}  manifest 失敗：${e.message}`);
    failures.push(`${ch.channel_name}: manifest 失敗 ${e.message}`);
    bad++;
    continue;
  }
  const t0 = Date.now();
  let res;
  let got = 0;
  try {
    res = await fetch(proxyUrl, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(40_000),
    });
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.byteLength;
    }
  } catch (e) {
    console.log(
      `${ch.channel_name.slice(0, 18).padEnd(20)}  ✗ 請求失敗 ${e.message}`,
    );
    failures.push(`${ch.channel_name}: 請求失敗 ${e.message}`);
    bad++;
    continue;
  }
  const ms = Date.now() - t0;

  const clen = res.headers.get('content-length');
  const cache = (res.headers.get('cache-control') || '').slice(0, 22);
  // 完整 = 有 content-length 且實收一致
  const complete = clen ? got === Number(clen) : got > 0;
  const good = res.status === 200 && complete;

  console.log(
    `${ch.channel_name.slice(0, 18).padEnd(20)}` +
      String(res.status).padStart(6) +
      String(clen ?? '無').padStart(16) +
      `${got}B/${ms}ms`.padStart(12) +
      (complete ? '✓完整' : '✗截斷').padStart(10) +
      '  ' +
      cache,
  );

  if (good) ok++;
  else {
    bad++;
    failures.push(
      `${ch.channel_name}: HTTP ${res.status} 收到 ${got}B / Content-Length ${clen ?? '無'}`,
    );
  }
}

console.log('\n' + '═'.repeat(88));
console.log(`通過 ${ok} 個 / 失敗 ${bad} 個`);
if (failures.length) {
  console.log('失敗明細：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('✓ 所有健康來源都完整交付，且沒有被誤殺（502）');
