#!/usr/bin/env node
/**
 * 測試慢來源的緩衝可行性。
 *
 * 核心問題：加大 hls.js 的 maxBufferLength 有沒有用？
 *
 * 直播 segment 是「固定大小、覆蓋固定秒數」的。
 * 關鍵是算：**下載一個 segment 的時間 vs 它的播放時長**。
 *
 *   · 下載時間 < 播放時長 → 緩衝會「賺」，加大緩衝有效
 *   · 下載時間 > 播放時長 → 緩衝持續流失，加大緩衝只是延後卡頓
 *
 * 所以要先量出真實數字。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BASE = 'https://taiwan-live-tv.netlify.app';

function encodeProxyTarget(url) {
  return Buffer.from(url, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  return res.text();
}

/** 解析 manifest → { targetDuration, segments[] } */
function parseM3u8(text, baseUrl) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  let targetDuration = 0;
  const segs = [];
  for (const line of lines) {
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseFloat(line.split(':')[1]) || 0;
      continue;
    }
    if (line.startsWith('#')) continue;
    segs.push(line.startsWith('http') ? line : new URL(line, baseUrl).href);
  }
  return { targetDuration, segs };
}

/** 下載並量測一個 segment */
async function measureSegment(url) {
  const t0 = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const reader = res.body.getReader();
  let bytes = 0;
  let firstByteMs = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstByteMs === null) firstByteMs = Date.now() - t0;
    bytes += value.length;
  }
  return {
    totalMs: Date.now() - t0,
    firstByteMs,
    bytes,
    age: res.headers.get('age'),
    cc: res.headers.get('cache-control'),
  };
}

async function analyzeChannel(ch) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`📺 ${ch.channel_name}`);
  console.log(`   ${ch.stream_url.slice(0, 80)}`);

  const proxyManifest = `${BASE}/api/proxy/${encodeProxyTarget(ch.stream_url)}`;
  let text = await fetchText(proxyManifest);
  let { targetDuration, segs } = parseM3u8(text, proxyManifest);

  // master manifest → 跟隨子 manifest
  if (segs.length > 0 && !/\.(ts|m4s|mp4|aac)(\?|$)/i.test(segs[0])) {
    const subText = await fetchText(segs[0]);
    const sub = parseM3u8(subText, segs[0]);
    if (sub.segs.length > 0) {
      targetDuration = sub.targetDuration || targetDuration;
      segs = sub.segs;
    }
  }

  if (!segs.length) {
    console.log('   ✗ 解析不到 segment');
    return;
  }

  console.log(`   TARGETDURATION=${targetDuration}s  segment 數=${segs.length}`);

  // 量測 3 個連續 segment（模擬實際播放時的連續下載）
  const picks = segs.slice(-3).reverse();
  const results = [];
  for (const seg of picks) {
    const r = await measureSegment(seg);
    results.push(r);
    if (r.error) {
      console.log(`   ✗ ${r.error}`);
      continue;
    }
    const mb = (r.bytes / 1024 / 1024).toFixed(2);
    const speed = r.totalMs > 0 ? (r.bytes / 1024 / 1024 / (r.totalMs / 1000)) : 0;
    console.log(
      `   ├ ${mb}MB  ${String(r.totalMs).padStart(6)}ms  ` +
        `first=${String(r.firstByteMs ?? '-').padStart(6)}ms  ` +
        `${speed.toFixed(2)} MB/s  age=${r.age ?? '-'}`,
    );
  }

  const ok = results.filter((r) => !r.error);
  if (!ok.length) return;

  const avgMs = ok.reduce((s, r) => s + r.totalMs, 0) / ok.length;
  const avgMB = ok.reduce((s, r) => s + r.bytes, 0) / ok.length / 1024 / 1024;
  const speedMbps = (avgMB / (avgMs / 1000)) * 8;

  console.log(`   → 平均 ${avgMB.toFixed(2)}MB / ${avgMs.toFixed(0)}ms = ${speedMbps.toFixed(2)} Mbps`);

  if (targetDuration > 0) {
    const ratio = avgMs / 1000 / targetDuration;
    const verdict =
      ratio < 0.8 ? '✅ 緩衝會賺 —— 加大 maxBufferLength 有效'
      : ratio < 1.0 ? '⚠️ 剛好持平 —— 加大緩衝只是延後卡頓'
      : '❌ 供不應求 —— 緩衝持續流失，加大沒用';
    console.log(`   → 下載一個 segment 需 ${(avgMs / 1000).toFixed(1)}s，內容長 ${targetDuration}s`);
    console.log(`   → 倍率 ${ratio.toFixed(2)}x  ${verdict}`);
    console.log(`   → 需要位元率 ${((avgMB * 8) / targetDuration).toFixed(2)} Mbps（上游提供 ${speedMbps.toFixed(2)} Mbps）`);
  }
}

const channels = JSON.parse(readFileSync(join(ROOT, 'shared', 'channels.json'), 'utf8'));
const ids = process.argv.slice(2);
const targets = ids.length
  ? ids.map((id) => channels.channels.find((c) => c.channel_id === id)).filter(Boolean)
  : channels.channels.filter((c) => /清單|轉載/.test(c.source_name || '')).slice(0, 3);

for (const ch of targets) await analyzeChannel(ch);
