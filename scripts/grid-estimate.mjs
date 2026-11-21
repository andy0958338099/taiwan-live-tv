#!/usr/bin/env node
/**
 * grid-estimate.mjs — 在真實量測資料上搜尋最佳取樣參數
 *
 * 目標：找到一組 (minBytes, maxWait, 速率取樣方式) 使得
 *   · 誤殺 = 0（健康來源絕不能被回 502）
 *   · 漏殺 = 0（太慢來源要能被抓到，否則平台截斷 → 壞內容被 CDN 快取 5 分鐘）
 *   · 等待時間盡量短（等待是使用者感受到的延遲）
 *
 * 輸入：shared/gt-estimator.json
 * 用法：node scripts/grid-estimate.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const THRESHOLD = 22_000;

const gt = JSON.parse(readFileSync(join(ROOT, 'shared/gt-estimator.json'), 'utf8'));
const rows = gt.results
  .filter((r) => r.chunks.length >= 2 && r.total > 0)
  .map((r) => ({
    ...r,
    chunks: r.chunks.map((c) => ({ at: c[0], size: c[1] })),
  }));
const healthy = rows.filter((r) => r.complete && r.elapsed <= THRESHOLD);
const slow = rows.filter((r) => !r.complete || r.elapsed > THRESHOLD);

/**
 * 速率取樣方式：
 *   'avg'    → 樣本期間的平均速率
 *   'recent' → 樣本「後半段」的速率（抓「先快後慢」）
 */
const RATE_MODES = ['avg', 'recent'];

/** 模擬代理取樣 */
const sample = (chunks, minBytes, maxWait) => {
  const first = chunks[0];
  const ttfb = first.at;
  let bytes = 0;
  let at = first.at;
  let acc = 0;
  const marks = [];
  for (let i = 1; i < chunks.length; i++) {
    const c = chunks[i];
    bytes += c.size;
    at = c.at;
    acc += c.size;
    marks.push({ at: c.at, acc });
    if (bytes >= minBytes || c.at - ttfb >= maxWait) break;
  }
  return { ttfb, bytes, at, marks };
};

/** 估算剩餘時間 */
const estimate = (chunks, total, minBytes, maxWait, mode) => {
  const s = sample(chunks, minBytes, maxWait);
  const postBytes = s.bytes;
  const postMs = Math.max(1, s.at - s.ttfb);
  if (postBytes <= 0) return { projected: 0, waited: 0 };

  let rate;
  if (mode === 'avg') {
    rate = postBytes / postMs;
  } else {
    // 後半段：從「樣本位元組的 50% 處」到最後
    const cutBytes = s.bytes * 0.5;
    let cutAt = s.ttfb;
    let acc = 0;
    for (const m of s.marks) {
      acc = m.acc;
      if (acc >= cutBytes) {
        cutAt = m.at;
        break;
      }
    }
    // 後半段的位元組數 = 樣本總數 − 截止點的累積數
    let cutAcc = 0;
    for (const m of s.marks) {
      cutAcc = m.acc;
      if (m.at >= cutAt) break;
    }
    const windowBytes = Math.max(1, s.bytes - cutAcc);
    const windowMs = Math.max(1, s.at - cutAt);
    rate = windowBytes / windowMs;
    if (!Number.isFinite(rate) || rate <= 0) rate = postBytes / postMs;
  }
  const remaining = Math.max(0, total - postBytes);
  return { projected: s.ttfb + remaining / rate, waited: postMs };
};

const results = [];
for (const minBytes of [64 * 1024, 128 * 1024, 256 * 1024, 512 * 1024, 1024 * 1024]) {
  for (const maxWait of [500, 800, 1500, 3000, 6000]) {
    for (const mode of RATE_MODES) {
      const fk = [];
      const mk = [];
      const waits = [];
      for (const r of rows) {
        const e = estimate(r.chunks, r.total, minBytes, maxWait, mode);
        waits.push(e.waited);
        const killed = e.projected > THRESHOLD;
        const isSlow = slow.includes(r);
        if (!isSlow && killed) fk.push(r.name);
        if (isSlow && !killed) mk.push(r.name);
      }
      waits.sort((a, b) => a - b);
      results.push({
        minBytes,
        maxWait,
        mode,
        fk: fk.length,
        mk: mk.length,
        fkNames: fk,
        mkNames: mk,
        median: waits[Math.floor(waits.length / 2)],
        p90: waits[Math.floor(waits.length * 0.9)],
      });
    }
  }
}

// 排序：先看誤殺，再看漏殺，再看等待時間
results.sort(
  (a, b) =>
    a.fk - b.fk || a.mk - b.mk || a.median - b.median || a.p90 - b.p90,
);

console.log('minBytes  maxWait  mode     誤殺  漏殺  等待中位  p90');
console.log('─'.repeat(66));
for (const r of results.slice(0, 22)) {
  console.log(
    `${String(r.minBytes / 1024).padStart(6)}K  ${String(r.maxWait).padStart(6)}ms  ` +
      `${r.mode.padEnd(7)}  ${String(r.fk).padStart(2)}   ${String(r.mk).padStart(2)}   ` +
      `${String(Math.round(r.median)).padStart(7)}ms ${String(Math.round(r.p90)).padStart(6)}ms` +
      (r.fkNames.length ? `  [誤殺: ${r.fkNames.join('、')}]` : '') +
      (r.mkNames.length ? `  [漏殺: ${r.mkNames.join('、')}]` : ''),
  );
}
