#!/usr/bin/env node
/**
 * compare-estimators.mjs — 比較四種「segment 速度估算」在真實資料上的表現
 *
 * 背景（2026-11-21 線上實測）：
 *   代理回 502「預估 34855ms」，但同一個 segment 實際下載只要 1.3–2.7 秒。
 *   根因：上游把 segment 切成極小 chunk（實測 1369B / 8192B），
 *   所以「單一 chunk 外推」會得到離譜的結果 → 健康來源被誤殺。
 *
 * 本腳本記錄每個 segment 的完整 chunk 時序，然後**離線**比較四種估算：
 *   A. 單一 chunk 外推（現行做法）
 *   B. 兩 chunk 累計（HEAD 做法）
 *   C. 累計 N bytes 後的平均速率
 *   D. **扣除 TTFB 後的邊際速率**（本輪候選）
 *
 * D 的理由：TTFB（第一個 chunk 前的等待）是固定的延遲，不是頻寬限制。
 *   把它算進分母會低估速率；而上游常有「TCP 慢啟動」，
 *   所以又不能只看最後一小段。要用「扣掉 TTFB 後的平均速率」。
 *
 * 用法：node scripts/compare-estimators.mjs [--ids id1,id2] [--fast-only]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const IDS = arg('ids', '').split(',').filter(Boolean);
const FAST_ONLY = process.argv.includes('--fast-only');

const THRESHOLD = 22_000;
const MIN_BYTES = 256 * 1024;
const MAX_WAIT = 1200;

const data = JSON.parse(readFileSync(join(ROOT, 'shared/channels.json'), 'utf8'));
let targets = IDS.length
  ? data.channels.filter((c) => IDS.includes(c.channel_id))
  : data.channels.filter((c) => c.is_active);
if (FAST_ONLY) targets = targets.filter((c) => !/央視|衛視|電視台$/.test(c.channel_name) || /台視/.test(c.channel_name));

const resolveSegment = async (url, depth = 0) => {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  const text = await res.text();
  let td = 0;
  let firstUri = null;
  let isMaster = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-TARGETDURATION:')) td = parseFloat(line.split(':')[1]) || 0;
    if (line.startsWith('#EXT-X-STREAM-INF')) isMaster = true;
    if (!line.startsWith('#')) {
      firstUri = line.startsWith('http') ? line : new URL(line, url).href;
      break;
    }
  }
  if (!firstUri) return { segUrl: null, targetDuration: td };
  if (depth < 3 && (isMaster || firstUri.endsWith('.m3u8') || firstUri.endsWith('.m3u'))) {
    return resolveSegment(firstUri, depth + 1);
  }
  return { segUrl: firstUri, targetDuration: td };
};

/** 記錄 chunk 時序，並算出四種估算 */
const measure = async (ch) => {
  let segUrl = null;
  let td = 0;
  try {
    const r = await resolveSegment(ch.stream_url);
    segUrl = r.segUrl;
    td = r.targetDuration;
  } catch {
    return null;
  }
  if (!segUrl) return null;

  const t0 = Date.now();
  let res;
  try {
    res = await fetch(segUrl, {
      headers: { 'User-Agent': UA, Range: 'bytes=0-' },
      signal: AbortSignal.timeout(28_000),
    });
  } catch {
    return null;
  }
  const total = Number(res.headers.get('content-length') || 0);
  const reader = res.body.getReader();
  const chunks = [];
  let bytes = 0;
  let complete = true;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push({ at: Date.now() - t0, size: value.byteLength });
      bytes += value.byteLength;
    }
  } catch {
    complete = false;
  }
  const elapsed = Date.now() - t0;
  if (chunks.length < 2 || total <= 0) return null;

  const first = chunks[0];
  const proj = (b, ms) => (b > 0 && ms > 0 ? total / (b / ms) : Infinity);

  // 找到「累計到 MIN_BYTES 或 MAX_WAIT」的測量點
  let acc = first.size;
  let measAt = first.at;
  let measAcc = acc;
  for (let i = 1; i < chunks.length; i++) {
    const c = chunks[i];
    acc += c.size;
    if (acc >= MIN_BYTES || c.at - first.at >= MAX_WAIT) {
      measAt = c.at;
      measAcc = acc;
      break;
    }
    measAt = c.at;
    measAcc = acc;
  }

  // A: 單一 chunk
  const A = proj(first.size, first.at);
  // B: 兩 chunk 累計
  const B = proj(first.size + chunks[1].size, chunks[1].at);
  // C: 累計到 MIN_BYTES 的平均速率
  const C = proj(measAcc, measAt);
  // D: 扣掉 TTFB 後的邊際速率
  const ttfb = first.at;
  const postBytes = measAcc - first.size;
  const postMs = Math.max(1, measAt - ttfb);
  const D = postBytes > 0 ? ttfb + (total - measAcc) / (postBytes / postMs) : Infinity;

  return {
    name: ch.channel_name,
    td,
    total,
    real: elapsed,
    complete,
    A: Math.round(A),
    B: Math.round(B),
    C: Math.round(C),
    D: Math.round(D),
    wait: measAt - ttfb,
    sampleBytes: measAcc,
  };
};

const rows = [];
for (const ch of targets) {
  const r = await measure(ch);
  if (!r) continue;
  rows.push(r);
  const mark = (v) => (v > THRESHOLD ? '殺' : '過');
  console.log(
    `${r.name.slice(0, 14).padEnd(16)} td=${String(r.td).padStart(2)}s 實${String(r.real).padStart(6)}ms ` +
      `A:${mark(r.A).padStart(2)}(${r.A}) B:${mark(r.B).padStart(2)}(${r.B}) ` +
      `C:${mark(r.C).padStart(2)}(${r.C}) D:${mark(r.D).padStart(2)}(${r.D})  等${String(r.wait).padStart(5)}ms`,
  );
}

console.log('\n' + '═'.repeat(96));
const complete = rows.filter((r) => r.complete);
// 「真正太慢」= 下載沒完成，或完成但超過門檻
const trulySlow = complete.filter((r) => r.real > THRESHOLD);
console.log(`量到 ${rows.length} 個（完整 ${complete.length}），其中真正太慢 ${trulySlow.length} 個`);
console.log('');
for (const k of ['A', 'B', 'C', 'D']) {
  const fk = complete.filter((r) => !trulySlow.includes(r) && r[k] > THRESHOLD);
  const mk = trulySlow.filter((r) => r[k] <= THRESHOLD);
  console.log(
    `${k}: 誤殺 ${String(fk.length).padStart(2)}  漏殺 ${String(mk.length).padStart(2)}` +
      (fk.length ? `   誤殺名單: ${fk.map((r) => `${r.name}(實${r.real}/預${r[k]})`).join('、')}` : ''),
  );
}
const waits = rows.map((r) => r.wait).sort((a, b) => a - b);
console.log(`\nD 方案額外等待：中位數 ${waits[Math.floor(waits.length / 2)]}ms  p90 ${waits[Math.floor(waits.length * 0.9)]}ms`);
