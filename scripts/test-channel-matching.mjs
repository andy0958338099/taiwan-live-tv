#!/usr/bin/env node
/**
 * 測試：頻道配對不會誤吃同家族頻道。
 *
 * ## 為什麼需要這個測試
 *
 * 實測（2026-11-21）：播放器 failover 到「備援來源 3/7」，
 * 畫面卻是**龍華日韓台**，但 UI 顯示「龍華電視」。
 *
 * 根因：`matchChannel` 用 `clean.includes(key)`，
 * 「龍華電視」會匹配到「龍華偶像台」「龍華日韓台」「龍華戲劇台」
 * 「龍華洋片台」「龍華卡通台」—— 全部被當成「龍華電視」的備援。
 *
 * 用法：`node scripts/test-channel-matching.mjs`
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { matchChannel } from './lib/channel-match.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// 用真實的 import_rules 測試
const sourcesCfg = JSON.parse(
  readFileSync(join(ROOT, 'shared', 'sources.json'), 'utf8'),
);
const rules = sourcesCfg.import_rules;

console.log('════ 測試：頻道配對不會誤吃同家族頻道 ════\n');

/**
 * [原始名稱, 應該匹配到哪個 map key 或 null, 說明]
 *
 * 期待 null 的意思是「這個名稱不該被匹配到任何 map key」——
 * 因於它代表清單裡的另一個頻道，被誤配就會造成錯誤的備援。
 *
 * 案例取自真實 M3U 清單（`scripts/dump-m3u-matches.mjs` 傾印）。
 *
 * ## 兩層防護的分工
 *
 * 名稱層擋掉**明確無歧義**的兄弟頻道（龍華日韓台 → 龍華電視絕對不對）。
 * 剩下的模糊情形（「東森新聞台」是東森 ETTV 還是東森財經？）
 * 交給 **URL 層**判定 —— 它比對來源站的頻道代碼，才是權威。
 * 名稱層在這裡刻意「放行」，因為寧可讓 URL 層去確認，
 * 也不要用猜的規則擋掉合法的備援。
 */
const CASES = [
  // ── 同家族兄弟頻道：名稱層擋下 ──
  ['龍華日韓台', null, '龍華家族的另一頻道'],
  ['龍華偶像台', null, '龍華家族的另一頻道'],
  ['龍華經典台', null, '龍華家族的另一頻道'],
  ['龍華電影台', null, '龍華家族的另一頻道'],
  ['龍華卡通台', null, '龍華家族的另一頻道'],
  ['三立戲劇台', null, '三立家族的另一頻道'],
  ['華麗翡翠台新加坡', null, '翡翠台的另一區域版本'],
  ['天映經典', null, '天映家族的另一頻道'],
  ['HOY資訊台', null, 'HOY 家族的另一頻道'],
  ['HOY國際財經台', null, 'HOY 家族的另一頻道'],
  ['三立新聞', '三立', '三立新聞（URL 層會確認代碼）'],

  // ── 主頻道與其合法變體：必須匹配 ──
  ['龍華電視', '龍華', '龍華主頻道'],
  ['三立電視', '三立', '三立主頻道'],
  ['東森', '東森', '東森主頻道'],
  ['東森新聞台', '東森', '東森新聞台（URL 層會確認代碼）'],
  ['中天新聞台', '中天', '中天新聞台（URL 層會確認代碼）'],
  ['華視', '華視', '華視'],
  ['公視台', '公視', '公視（「台」不是兄弟標記）'],
  ['TVB翡翠台', '翡翠台', 'TVB 翡翠台（比 TVB 更具體）'],
  ['翡翠台4K字幕', '翡翠台', '同頻道的畫質／字幕版本'],
  ['翡翠台(WebVTT字幕)', '翡翠台', '同頻道的字幕版本'],
  ['TVB1', 'TVB', 'TVB 系'],
  ['HOY TV', 'HOY', 'HOY TV'],
  ['天映', '天映', '天映'],
  ['台視', '台視', '台視'],
  ['鏡新聞', '鏡新聞', '鏡新聞'],
];

let failed = 0;
for (const [raw, expect, why] of CASES) {
  const r = matchChannel({ name: raw, group: '台灣' }, rules);
  const got = r ? r.id : null;
  const ok = got === expect;
  if (!ok) failed++;
  console.log(
    `  ${ok ? '✓' : '✗'} ${raw.padEnd(18)} → ${String(got).padEnd(10)} ${why}`,
  );
}

console.log('');
if (failed) {
  console.log(`  ❌ FAIL — ${failed} / ${CASES.length} 個案例不符`);
  process.exit(1);
}
console.log(`  ✅ PASS — 全部 ${CASES.length} 個案例都正確`);
