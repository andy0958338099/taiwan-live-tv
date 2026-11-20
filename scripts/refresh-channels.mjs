#!/usr/bin/env node
/**
 * refresh-channels.mjs — 定期重新抓取播放清單並更新頻道資料
 *
 * 用途：IPTV 清單是會持續變動的（來源換網址、頻道上下架），
 * 需要定期重新抓取與探測，否則已匯入的頻道會逐漸失效。
 *
 * 流程：
 *   1. 呼叫 import-playlists.mjs（實際寫入模式）更新 shared/channels.json
 *   2. 驗證 + 同步到兩端產物
 *   3. 輸出摘要
 *
 * 用法：
 *   node scripts/refresh-channels.mjs
 *   node scripts/refresh-channels.mjs --skip-probe   # 跳過探測（較快，但會納入失效來源）
 *
 * 建議以 cron 每日執行一次（見 docs/04-build-and-install.md）。
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SKIP_PROBE = process.argv.includes('--skip-probe');

function run(script, args = []) {
  return execFileSync(process.execPath, [join(__dirname, script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function fail(msg, err) {
  console.error(`\n✗ ${msg}`);
  if (err) {
    const out = (err.stdout || '') + (err.stderr || '');
    console.error(out.split('\n').slice(-15).join('\n'));
  }
  process.exit(1);
}

console.log('═'.repeat(64));
console.log('頻道資料定期更新');
console.log(`時間：${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
console.log('═'.repeat(64));
console.log('');

// 1. 匯入
console.log('▶ 步驟 1/3：重新抓取播放清單');
try {
  const out = run('import-playlists.mjs', SKIP_PROBE ? ['--no-probe'] : []);
  const added = out.match(/新增 (\d+) 個/);
  const updated = out.match(/更新 (\d+) 個/);
  const skipped = out.match(/略過 (\d+) 個/);
  console.log(
    `  ✓ 匯入完成：新增 ${added?.[1] ?? '?'}｜更新 ${updated?.[1] ?? '?'}｜略過 ${skipped?.[1] ?? '?'}`,
  );
} catch (e) {
  fail('匯入失敗', e);
}

// 2. 驗證
console.log('\n▶ 步驟 2/3：驗證授權狀態');
try {
  const out = run('validate-channels.mjs');
  const m = out.match(/總頻道數\s*:\s*(\d+)/);
  const a = out.match(/啟用中\s*:\s*(\d+)/);
  console.log(`  ✓ 驗證通過：總計 ${m?.[1] ?? '?'} 個頻道，其中啟用 ${a?.[1] ?? '?'} 個`);
} catch (e) {
  fail('驗證失敗 — 資料有問題，未同步', e);
}

// 3. 同步
console.log('\n▶ 步驟 3/3：同步到 Android 與 Web');
try {
  const out = run('sync-channels.mjs');
  const m = out.match(/頻道總數 (\d+) → 上線 (\d+)/);
  console.log(`  ✓ 同步完成：${m?.[1] ?? '?'} 個頻道 → 上線 ${m?.[2] ?? '?'} 個`);
} catch (e) {
  fail('同步失敗', e);
}

// 4. 一致性
console.log('\n▶ 附加：兩端資料一致性');
try {
  run('test-channel-consistency.mjs');
  console.log('  ✓ 兩端資料一致');
} catch (e) {
  fail('一致性檢查失敗', e);
}

// 摘要
const channels = JSON.parse(readFileSync(join(ROOT, 'shared', 'channels.json'), 'utf8'));
const byCat = {};
let corsOk = 0;
for (const c of channels.channels) {
  if (!c.is_active) continue;
  byCat[c.category] = (byCat[c.category] || 0) + 1;
  if (c.cors_enabled) corsOk++;
}

console.log('\n' + '═'.repeat(64));
console.log('更新摘要');
console.log('═'.repeat(64));
console.log(`  上線頻道數    : ${Object.values(byCat).reduce((a, b) => a + b, 0)}`);
console.log(`  支援 CORS     : ${corsOk}（其餘僅 Android TV 版可播）`);
console.log('  分類分布      :');
const catNames = {
  news: '新聞台', general: '綜合台', entertainment: '娛樂台',
  finance: '財經台', public: '公共電視', life: '生活資訊',
  education: '教育文化', local: '地方及其他頻道',
};
for (const [k, v] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
  console.log(`     ${(catNames[k] || k).padEnd(14)} ${v}`);
}
console.log('═'.repeat(64));
console.log('\n✓ 完成。若 APK 需要一併更新，執行：');
console.log('  cd android && ./gradlew assembleDebug');
