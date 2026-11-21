#!/usr/bin/env node
/**
 * assign-channel-numbers.mjs — 為頻道指派頻道號碼
 *
 * ## 為什麼需要
 *
 * 傳統電視的選台方式是「按遙控器上的數字鍵」，
 * 業界 TV app 也普遍顯示頻道號碼（YouTube TV、Plex、Roku 都有）。
 * 目前我們的 `channel_number` 欄位全部是 null，UI 上完全看不到號碼。
 *
 * ## 指派規則
 *
 * 1. **台灣頻道優先**，依現有清單順序（龍華 → TVBS → 中視 → 華視 → …）
 *    這符合台灣觀眾的既有習慣（收訊器上的號碼）。
 * 2. 中國／香港頻道接續在後，從 101 開始 —— 讓兩群號碼不衝突，
 *    也讓「100 以下是台灣、100 以上是境外」這個規則一眼可辨。
 * 3. **保留已有的手動號碼** —— 已經指派過的不覆蓋。
 *
 * 執行後會寫回 shared/channels.json，再跑 sync-channels.mjs 同步到
 * APK 與 Web。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'shared', 'channels.json');

const TAIWAN_MAX = 100;

const data = JSON.parse(readFileSync(SRC, 'utf8'));
const channels = data.channels ?? [];

// 台灣的分類 id（依實際資料判斷）
const isTaiwan = (c) => {
  const cat = String(c.category ?? '');
  return (
    cat.includes('台灣') ||
    cat.includes('臺灣') ||
    c.region === '台灣' ||
    /tw[-_]/.test(c.channel_id ?? '')
  );
};

// 保留既有號碼
const assigned = new Map();
for (const c of channels) {
  if (c.channel_number != null) assigned.set(c.channel_id, c.channel_number);
}

let nextTaiwan = 1;
let nextForeign = 101;
let changed = 0;

for (const c of channels) {
  if (c.channel_number != null) continue;
  const num = isTaiwan(c) ? nextTaiwan++ : nextForeign++;
  c.channel_number = num;
  changed++;
}

writeFileSync(SRC, JSON.stringify(data, null, 2) + '\n', 'utf8');

const tw = channels.filter(isTaiwan);
console.log(`已指派 ${changed} 個頻道號碼`);
console.log(`  台灣：1–${tw.length}`);
console.log(`  境外：101–${channels.length - tw.length}`);
console.log('\n台灣頻道號碼對照：');
for (const c of tw) {
  console.log(`  ${String(c.channel_number).padStart(3)}  ${c.channel_name}`);
}
