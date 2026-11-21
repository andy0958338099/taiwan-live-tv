#!/usr/bin/env node
/**
 * 測試代理 segment 的 CDN 快取是否命中。
 *
 * 問題：直播播放卡頓時，hls.js 會重試同一個 segment。
 *   · 若 CDN 有快取 → 重試是瞬間的（0.1s）
 *   · 若沒有 → 重試要重新下載整個 5MB segment（可能 100+ 秒）
 *
 * 這是「緩衝做大」能不能真的改善卡頓的關鍵。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BASE = 'https://taiwan-live-tv.netlify.app';

function encodeProxyTarget(url) {
  const binary = Buffer.from(url, 'utf8').toString('binary');
  return Buffer.from(binary, 'binary').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 取回 manifest，解析出 segment 清單（需處理 master → media）。
 */
async function fetchManifest(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const text = await res.text();
  if (!text.includes('#EXTM3U')) return null;
  return text;
}

function parseSegments(m3u8, baseUrl) {
  const lines = m3u8.split('\n').map((l) => l.trim()).filter(Boolean);
  const segs = [];
  for (const line of lines) {
    if (line.startsWith('#')) continue;
    if (line.startsWith('http')) segs.push(line);
    else segs.push(new URL(line, baseUrl).href);
  }
  return segs;
}

/** 判斷是 manifest 還是 segment */
function isManifest(text) {
  return text.trimStart().startsWith('#EXTM3U');
}

async function timedFetch(url, label) {
  const t0 = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const reader = res.body?.getReader();
  let bytes = 0;
  let firstByte = null;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByte === null) firstByte = Date.now() - t0;
      bytes += value.length;
    }
  }
  const total = Date.now() - t0;
  const age = res.headers.get('age');
  const cc = res.headers.get('cache-control');
  console.log(
    `  ${label.padEnd(22)} ${String(total).padStart(6)}ms  ` +
      `first=${String(firstByte ?? '-').padStart(6)}ms  ` +
      `${(bytes / 1024 / 1024).toFixed(2)}MB  age=${age ?? '-'}  cc=${cc ?? '-'}`,
  );
  return { total, firstByte, bytes, age, cc, status: res.status };
}

async function main() {
  const channels = JSON.parse(
    readFileSync(join(ROOT, 'shared', 'channels.json'), 'utf8'),
  );
  const test = channels.channels.find((c) => c.channel_id === 'tw-taiwan-plus')
    || channels.channels[0];

  console.log(`測試頻道: ${test.channel_name}`);
  console.log(`上游: ${test.stream_url}\n`);

  const proxyManifest = `${BASE}/api/proxy/${encodeProxyTarget(test.stream_url)}`;
  console.log('=== 1. 取得代理 manifest ===');
  const t0 = Date.now();
  const res = await fetch(proxyManifest, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const text = await res.text();
  console.log(`  HTTP ${res.status}  ${Date.now() - t0}ms  ${text.length}B`);
  console.log(`  age=${res.headers.get('age')}  cc=${res.headers.get('cache-control')}`);

  let segs = parseSegments(text, proxyManifest);
  console.log(`  解析出 ${segs.length} 個 segment URL`);

  // 如果是 master manifest，跟隨到 media manifest
  if (isManifest(text) && segs.length > 0 && !segs[0].includes('.ts')) {
    console.log('  → 跟隨子 manifest');
    const sub = await fetch(segs[0], { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const subText = await sub.text();
    segs = parseSegments(subText, segs[0]);
    console.log(`  解析出 ${segs.length} 個 segment URL`);
  }

  if (segs.length === 0) {
    console.log('  沒有 segment，無法測試');
    return;
  }

  const target = segs[Math.min(1, segs.length - 1)];
  console.log(`\n=== 2. 同一個 segment 下載三次 ===`);
  console.log(`  目標: ${target.slice(0, 100)}...`);
  const r1 = await timedFetch(target, '第 1 次（冷）');
  const r2 = await timedFetch(target, '第 2 次');
  const r3 = await timedFetch(target, '第 3 次');

  console.log(`\n=== 3. 判斷 CDN 快取 ===`);
  const cached = r2.age !== null && r2.age !== undefined;
  if (cached) {
    console.log(`  ✓ CDN 有快取（age=${r2.age}）`);
    console.log(`    冷啟 ${r1.total}ms → 命中 ${r2.total}ms（快 ${(r1.total / Math.max(1, r2.total)).toFixed(1)}x）`);
  } else {
    console.log('  ✗ CDN 沒有快取 —— 重試會重新下載整個 segment');
    console.log(`    age 標頭: ${r2.age}`);
  }
  console.log(`  第 2/3 次是否一致: ${r2.total === r3.total ? '是' : '否（' + r2.total + ' vs ' + r3.total + '）'}`);
}

await main();
