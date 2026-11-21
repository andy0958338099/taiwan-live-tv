#!/usr/bin/env node
/**
 * test-speed-estimate.mjs — 用真實量測資料驗證 segment 速度估算
 *
 * 這是**回歸測試**：確保代理的估算不會再誤殺健康來源。
 *
 * 背景：2026-11-21 線上實測，代理把 TVB翡翠台的 segment 判成
 * 「預估 34855ms」而回 502，但同一個 segment 實際下載只要 1.3 秒。
 * hls.js 收到 502 就換源 → 使用者看到「切台」而不是「繼續播放」。
 *
 * 資料來源：shared/gt-estimator.json（`scripts/gt-estimator.mjs` 產生）
 *   記錄每個 segment 的完整 chunk 時序 + 真實完成時間。
 *
 * 用法：node scripts/test-speed-estimate.mjs [--file shared/gt-estimator.json]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const FILE = arg('file', 'shared/gt-estimator.json');

/** 代理的門檻（必須與 route.ts 一致） */
const THRESHOLD = 22_000;

/**
 * 估算邏輯寫在 TypeScript（web/src/lib/proxySpeedEstimate.ts），
 * 這裡用 tsc 編譯後載入 —— 確保測試跑的**就是**線上實際使用的程式碼。
 */
const OUT_DIR = join(ROOT, 'web/.next/speed-estimate-test');
execFileSync(
  'npx',
  [
    'tsc',
    join(ROOT, 'web/src/lib/proxySpeedEstimate.ts'),
    '--outDir',
    OUT_DIR,
    '--module',
    'commonjs',
    '--target',
    'es2022',
    '--moduleResolution',
    'node',
  ],
  { cwd: join(ROOT, 'web'), stdio: 'pipe' },
);

const { estimateSegmentTransferMs, SAMPLE_MIN_BYTES, SAMPLE_MAX_WAIT_MS } = await import(
  pathToFileURL(join(OUT_DIR, 'proxySpeedEstimate.js')).href
);

const gt = JSON.parse(readFileSync(join(ROOT, FILE), 'utf8'));
// chunk 時序存成 [at, size] 配對陣列 → 轉回物件方便使用
const rows = gt.results
  .filter((r) => r.chunks.length >= 2 && r.total > 0)
  .map((r) => ({
    ...r,
    chunks: r.chunks.map((c) => ({ at: c[0], size: c[1] })),
  }));

if (rows.length === 0) {
  console.error(`✗ ${FILE} 沒有可用的實測資料`);
  process.exit(1);
}

/**
 * 重現代理的取樣過程：
 * 從第一個 chunk 之後開始累積，累積到 SAMPLE_MIN_BYTES 或 SAMPLE_MAX_WAIT_MS 為止。
 */
const sampleLikeProxy = (chunks) => {
  const first = chunks[0];
  const ttfbMs = first.at; // headers → 第一個 chunk
  let sampleBytes = 0;
  let sampleMs = 0;
  for (let i = 1; i < chunks.length; i++) {
    const c = chunks[i];
    sampleBytes += c.size;
    sampleMs = c.at - first.at;
    if (sampleBytes >= SAMPLE_MIN_BYTES || sampleMs >= SAMPLE_MAX_WAIT_MS) break;
  }
  return { sampleBytes, sampleMs, ttfbMs };
};

console.log('═'.repeat(96));
console.log('segment 速度估算回歸測試');
console.log('═'.repeat(96));
console.log(
  `資料：${FILE}（${rows.length} 筆）　門檻：${THRESHOLD}ms　` +
    `取樣：${SAMPLE_MIN_BYTES / 1024}KB / ${SAMPLE_MAX_WAIT_MS}ms\n`,
);

const healthy = rows.filter((r) => r.complete && r.elapsed <= THRESHOLD);
const slow = rows.filter((r) => !r.complete || r.elapsed > THRESHOLD);

let failed = 0;
const falseKills = [];
const missed = [];

console.log(
  'channel'.padEnd(20) +
    '真實ms'.padStart(8) +
    '狀態'.padStart(8) +
    '預估ms'.padStart(11) +
    '取樣KB'.padStart(9) +
    '等待ms'.padStart(9) +
    '  判定',
);
console.log('─'.repeat(96));

for (const r of rows) {
  const s = sampleLikeProxy(r.chunks);
  const projected = estimateSegmentTransferMs({
    totalBytes: r.total,
    sampleBytes: s.sampleBytes,
    sampleMs: s.sampleMs,
    ttfbMs: s.ttfbMs,
  });
  const isSlow = slow.includes(r);
  const killed = projected > THRESHOLD;
  const verdict = isSlow
    ? killed
      ? '✓ 正確拒絕'
      : '✗ 漏殺（太慢卻放行）'
    : killed
      ? '✗ 誤殺（健康卻拒絕）'
      : '✓ 正確放行';
  if (!isSlow && killed) falseKills.push(r);
  if (isSlow && !killed) missed.push(r);
  if (verdict.startsWith('✗')) failed++;

  console.log(
    r.name.slice(0, 18).padEnd(20) +
      String(r.elapsed).padStart(8) +
      (isSlow ? '太慢' : '健康').padStart(8) +
      String(Math.round(projected)).padStart(11) +
      String(Math.round(s.sampleBytes / 1024)).padStart(9) +
      String(Math.round(s.sampleMs)).padStart(9) +
      '  ' +
      verdict,
  );
}

console.log('\n' + '═'.repeat(96));
console.log(`健康 ${healthy.length} 個 / 太慢 ${slow.length} 個`);
console.log(`誤殺 ${falseKills.length} 個　漏殺 ${missed.length} 個`);
if (falseKills.length) {
  console.log(`  誤殺名單：${falseKills.map((r) => r.name).join('、')}`);
}
if (missed.length) {
  console.log(`  漏殺名單：${missed.map((r) => r.name).join('、')}`);
}

// 漏殺的後果：平台截斷 → 截斷內容被 CDN 快取 5 分鐘
// 所以漏殺必須明確列出，不能默默帶過
if (missed.length > 0) {
  console.log('\n⚠️  漏殺的來源會被放行，平台可能在 30 秒切斷 → 截斷內容被快取 5 分鐘。');
  console.log('    這是刻意取捨：誤殺會讓使用者立刻看到「切台」，漏殺只是該頻道短暫不穩。');
}

if (falseKills.length > 0) {
  console.error(`\n✗ 失敗：有 ${falseKills.length} 個健康來源被誤殺`);
  process.exit(1);
}
console.log('\n✓ 通過：沒有任何健康來源被誤殺');
