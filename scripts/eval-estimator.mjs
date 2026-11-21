#!/usr/bin/env node
/**
 * eval-estimator.mjs — 用 ground truth 離線評估候選估算公式
 *
 * 輸入：shared/gt-estimator.json（真實 chunk 時序 + 真實完成時間）
 * 輸出：每個公式的「誤殺 / 漏殺 / 額外等待」
 *
 * 誤殺 = 健康來源被回 502（使用者看到切台而不是繼續播放）
 * 漏殺 = 真正太慢的來源放行 → 平台 30 秒切斷 → 截斷內容被 CDN 快取 5 分鐘
 *
 * 用法：node scripts/eval-estimator.mjs [--file shared/gt-estimator.json]
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

const FILE = arg('file', 'shared/gt-estimator.json');
const THRESHOLD = 22_000;
const BUDGET = 25_000;

const gt = JSON.parse(readFileSync(join(ROOT, FILE), 'utf8'));
const rows = gt.results
  .filter((r) => r.chunks.length >= 2 && r.total > 0)
  .map((r) => ({
    ...r,
    chunks: r.chunks.map((c) => ({ at: c[0], size: c[1] })),
  }));

/**
 * 候選公式。皆回傳 { projectedMs, waitedMs, sampleBytes }
 *
 * 共同前提：TTFB（headers 到第一個 chunk）是固定延遲，不消耗頻寬，
 *   所以速率要用「扣掉 TTFB」的部分來算。
 */
const FORMULAS = {
  /** 現行（HEAD）：單一 chunk 外推 */
  A_single: (c, total) => {
    const f = c[0];
    return {
      projectedMs: f.size > 0 && f.at > 0 ? total / (f.size / f.at) : Infinity,
      waitedMs: 0,
      sampleBytes: f.size,
    };
  },
  /** HEAD 的第二版：兩個 chunk 累計 */
  B_two: (c, total) => {
    const b = c[0].size + c[1].size;
    return {
      projectedMs: b > 0 && c[1].at > 0 ? total / (b / c[1].at) : Infinity,
      waitedMs: c[1].at - c[0].at,
      sampleBytes: b,
    };
  },
  /** 累計到 minBytes 的平均速率（含 TTFB） */
  C_avg: (c, total, minBytes, maxWait) => {
    const r = sample(c, minBytes, maxWait);
    const rate = r.bytes / Math.max(1, r.at);
    return {
      projectedMs: rate > 0 ? total / rate : Infinity,
      waitedMs: r.at - c[0].at,
      sampleBytes: r.bytes,
    };
  },
  /** 扣掉 TTFB 的邊際速率（本輪候選） */
  D_marginal: (c, total, minBytes, maxWait) => {
    const r = sample(c, minBytes, maxWait);
    const ttfb = c[0].at;
    const postBytes = r.bytes - c[0].size;
    const postMs = Math.max(1, r.at - ttfb);
    if (postBytes <= 0) return { projectedMs: Infinity, waitedMs: 0, sampleBytes: r.bytes };
    const rate = postBytes / postMs;
    const remaining = Math.max(0, total - r.bytes);
    return {
      projectedMs: ttfb + remaining / rate,
      waitedMs: r.at - ttfb,
      sampleBytes: r.bytes,
    };
  },
  /**
   * D 的改良版：先扣 TTFB，再用「最近 25% 樣本」的速率（抓「先快後慢」）
   * 央視來源的典型行為是開頭 burst 很快、之後大幅變慢 ——
   * 用整體平均會高估速率，用最近區段才抓得到真實狀況。
   */
  E_recent: (c, total, minBytes, maxWait) => {
    const r = sample(c, minBytes, maxWait);
    const ttfb = c[0].at;
    // 找到「最近 25% 位元組」的起點
    const cut = r.bytes * 0.75;
    let acc = 0;
    let cutAt = ttfb;
    for (const ch of c) {
      acc += ch.size;
      if (acc >= cut) {
        cutAt = ch.at;
        break;
      }
    }
    const postBytes = r.bytes - c[0].size;
    const postMs = Math.max(1, r.at - ttfb);
    const avgRate = postBytes / postMs;
    // 最近區段速率（以 cutAt 為基準）
    let acc2 = 0;
    let recentBytes = 0;
    let recentMs = 0;
    let started = false;
    for (const ch of c) {
      acc2 += ch.size;
      if (!started && ch.at >= cutAt) {
        started = true;
        recentMs = ch.at - cutAt;
      }
      if (started) recentBytes += ch.size;
    }
    const recentRate = recentMs > 0 ? recentBytes / recentMs : avgRate;
    // 取兩者中較慢的（保守）
    const rate = Math.min(avgRate, recentRate);
    const remaining = Math.max(0, total - r.bytes);
    return {
      projectedMs: ttfb + remaining / rate,
      waitedMs: r.at - ttfb,
      sampleBytes: r.bytes,
    };
  },
};

/** 累積到 minBytes 或 maxWait（以先到者為準） */
function sample(chunks, minBytes, maxWait) {
  const first = chunks[0];
  let bytes = first.size;
  let at = first.at;
  for (let i = 1; i < chunks.length; i++) {
    const c = chunks[i];
    bytes += c.size;
    at = c.at;
    if (bytes >= minBytes || c.at - first.at >= maxWait) break;
  }
  return { bytes, at };
}

const CONFIGS = [
  { minBytes: 64 * 1024, maxWait: 800 },
  { minBytes: 128 * 1024, maxWait: 800 },
  { minBytes: 256 * 1024, maxWait: 800 },
  { minBytes: 256 * 1024, maxWait: 1500 },
  { minBytes: 512 * 1024, maxWait: 1500 },
];

console.log(
  'channel'.padEnd(18) +
    'td'.padEnd(4) +
    '真實ms'.padStart(8) +
    '真實態'.padStart(8) +
    'A'.padStart(11) +
    'B'.padStart(11) +
    'D(256K/800)'.padStart(12) +
    'E(256K/800)'.padStart(12),
);
console.log('─'.repeat(90));
for (const r of rows) {
  const slow = !r.complete || r.elapsed > THRESHOLD;
  const mark = (v) => (v > THRESHOLD ? `${Math.round(v)}✗` : `${Math.round(v)}✓`);
  const A = FORMULAS.A_single(r.chunks, r.total).projectedMs;
  const B = FORMULAS.B_two(r.chunks, r.total).projectedMs;
  const D = FORMULAS.D_marginal(r.chunks, r.total, 256 * 1024, 800).projectedMs;
  const E = FORMULAS.E_recent(r.chunks, r.total, 256 * 1024, 800).projectedMs;
  console.log(
    r.name.slice(0, 16).padEnd(18) +
      `${r.td}s`.padEnd(4) +
      String(r.elapsed).padStart(8) +
      (slow ? '太慢' : '健康').padStart(8) +
      mark(A).padStart(11) +
      mark(B).padStart(11) +
      mark(D).padStart(12) +
      mark(E).padStart(12),
  );
}

console.log('\n' + '═'.repeat(90));
const healthy = rows.filter((r) => r.complete && r.elapsed <= THRESHOLD);
const slow = rows.filter((r) => !r.complete || r.elapsed > THRESHOLD);
console.log(`健康 ${healthy.length} 個 / 太慢 ${slow.length} 個（門檻 ${THRESHOLD}ms，預算 ${BUDGET}ms）\n`);

const evaluate = (label, fn) => {
  const fk = healthy.filter((r) => fn(r).projectedMs > THRESHOLD);
  const mk = slow.filter((r) => fn(r).projectedMs <= THRESHOLD);
  const waits = rows.map((r) => fn(r).waitedMs).sort((a, b) => a - b);
  const med = waits[Math.floor(waits.length / 2)] ?? 0;
  const p90 = waits[Math.floor(waits.length * 0.9)] ?? 0;
  console.log(
    `${label.padEnd(28)} 誤殺 ${String(fk.length).padStart(2)}  漏殺 ${String(mk.length).padStart(2)}  ` +
      `等待中位 ${String(med).padStart(5)}ms  p90 ${String(p90).padStart(5)}ms` +
      (fk.length ? `  [${fk.map((r) => r.name).join('、')}]` : ''),
  );
};

evaluate('A 單一 chunk（HEAD 現行）', (r) => FORMULAS.A_single(r.chunks, r.total));
evaluate('B 兩 chunk 累計（HEAD 第二版）', (r) => FORMULAS.B_two(r.chunks, r.total));
for (const cfg of CONFIGS) {
  evaluate(
    `C 平均 ${cfg.minBytes / 1024}K/${cfg.maxWait}ms`,
    (r) => FORMULAS.C_avg(r.chunks, r.total, cfg.minBytes, cfg.maxWait),
  );
}
for (const cfg of CONFIGS) {
  evaluate(
    `D 邊際 ${cfg.minBytes / 1024}K/${cfg.maxWait}ms`,
    (r) => FORMULAS.D_marginal(r.chunks, r.total, cfg.minBytes, cfg.maxWait),
  );
}
for (const cfg of CONFIGS) {
  evaluate(
    `E 最近區段 ${cfg.minBytes / 1024}K/${cfg.maxWait}ms`,
    (r) => FORMULAS.E_recent(r.chunks, r.total, cfg.minBytes, cfg.maxWait),
  );
}
