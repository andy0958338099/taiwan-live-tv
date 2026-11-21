#!/usr/bin/env node
/**
 * probe-estimator.mjs — 驗證「新的 segment 速度估算方式」不會誤殺健康來源
 *
 * 背景（2026-11-21 線上實測）：
 *   TVB翡翠台被代理回 502「預估 34855ms」，但同一個 segment 實際下載只要 2.7 秒。
 *   hls.js 收到 502 → 換源 → 使用者看到「切台」而不是「繼續播放」。
 *
 * 根因：上游把 segment 切成**極小的 chunk**（實測 1369B / 8192B 一塊），
 *   所以「第一個 chunk 的速率」外推會得到離譜的結果。
 *
 * 這個腳本比較四種估算方式，並用真實的 segment 驗證：
 *   A. 單一 chunk 外推（現行）
 *   B. 兩個 chunk 累計（上一輪未提交的版本）
 *   C. 累計到 256KB 後估算（候選）
 *   D. 累計到 256KB 或 1 秒後估算，並用「後段」的邊際速率（候選）
 *
 * 用法：node scripts/probe-estimator.mjs [channel_id ...]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const THRESHOLD = 22000;
const MIN_BYTES = 256 * 1024;
const MAX_WAIT_MS = 1000;

const data = JSON.parse(readFileSync(join(ROOT, 'shared/channels.json'), 'utf8'));
const ids = process.argv.slice(2);
const targets = ids.length
  ? data.channels.filter((c) => ids.includes(c.channel_id))
  : data.channels.filter((c) => c.is_active).slice(0, 12);

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

let pass = 0;
let fail = 0;
const rows = [];

for (const ch of targets) {
  let segUrl = null;
  let td = 0;
  try {
    const r = await resolveSegment(ch.stream_url);
    segUrl = r.segUrl;
    td = r.targetDuration;
  } catch {
    continue;
  }
  if (!segUrl) continue;

  const t0 = Date.now();
  let res;
  try {
    res = await fetch(segUrl, { headers: { 'User-Agent': UA, Range: 'bytes=0-' } });
  } catch {
    continue;
  }
  const total = Number(res.headers.get('content-length') || 0);
  const reader = res.body.getReader();

  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push({ at: Date.now() - t0, size: value.byteLength });
    bytes += value.byteLength;
  }
  const elapsed = Date.now() - t0;
  if (chunks.length < 2) continue;

  const proj = (b, ms) => (b > 0 && ms > 0 ? total / (b / ms) : Infinity);

  // A: 單一 chunk
  const a = proj(chunks[0].size, chunks[0].at);
  // B: 兩 chunk 累計
  const b = proj(chunks[0].size + chunks[1].size, chunks[1].at);
  // C: 累計到 256KB
  let c = Infinity;
  let cAt = 0;
  let acc = 0;
  for (const ch2 of chunks) {
    acc += ch2.size;
    if (acc >= MIN_BYTES) {
      c = proj(acc, ch2.at);
      cAt = ch2.at;
      break;
    }
  }
  // D: 累計 256KB 或 1 秒後，用「從第一個 chunk 之後」的邊際速率
  let d = Infinity;
  let dAt = 0;
  let dAcc = 0;
  let dBase = 0;
  for (const ch2 of chunks) {
    dAcc += ch2.size;
    const t = ch2.at;
    if (dAcc >= MIN_BYTES || t >= MAX_WAIT_MS) {
      const dt = Math.max(1, t - chunks[0].at);
      const db = Math.max(1, dAcc - chunks[0].size);
      d = proj(db, dt);
      dAt = t;
      break;
    }
  }

  const row = {
    name: ch.channel_name,
    td,
    total,
    real: elapsed,
    A: Math.round(a),
    B: Math.round(b),
    C: Math.round(c),
    D: Math.round(d),
    waitC: cAt,
    waitD: dAt,
  };
  rows.push(row);
  if (d <= THRESHOLD) pass++;
  else fail++;
}

console.log(
  '\n' +
    'channel'.padEnd(18) +
    'td'.padEnd(4) +
    '真實ms'.padStart(8) +
    'A單chunk'.padStart(12) +
    'B兩chunk'.padStart(12) +
    'C累256KB'.padStart(11) +
    'D邊際'.padStart(10) +
    'D等待ms'.padStart(9),
);
console.log('─'.repeat(96));
for (const r of rows) {
  const mark = (v) => (v > THRESHOLD ? `${v}✗` : `${v}✓`);
  console.log(
    r.name.slice(0, 16).padEnd(18) +
      `${r.td}s`.padEnd(4) +
      String(r.real).padStart(8) +
      mark(r.A).padStart(12) +
      mark(r.B).padStart(12) +
      mark(r.C).padStart(11) +
      mark(r.D).padStart(10) +
      String(r.waitD).padStart(9),
  );
}
console.log(`\n門檻 ${THRESHOLD}ms　D 方案：通過 ${pass} / 誤殺 ${fail}`);
console.log('（D 等待時間已含在「D等待ms」欄；C 的等待時間是 D 的子集）');
