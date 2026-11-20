#!/usr/bin/env node
/**
 * normalize-channel-ids.mjs — 把舊的、會撞號的 channel_id 改成明確的 ASCII id
 *
 * 背景：中國頻道的 channel_id 早期是用「中文 key 轉 ASCII」的方式產生，
 *   `cn-${key.replace(/[^a-zA-Z0-9]+/g, '-')}` 會把所有中文都折成單一破折號。
 *   結果是 34 個省衛視全部撞成 `cn--`，
 *   `鳳凰衛視` 也變成 `cn--`（跟省衛視共用同一個 id）。
 *
 * 本腳本把這些 id 改成名稱明確、唯一的形式：
 *   cn--            → cn-fh          （鳳凰衛視）
 *   cn-cctv5-       → cn-cctv5plus   （央視-5+）
 *   cn-cctv5p       → cn-cctv5plus
 *
 * 用法：node scripts/normalize-channel-ids.mjs [--dry-run]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHANNELS_PATH = join(__dirname, '..', 'shared', 'channels.json');
const DRY_RUN = process.argv.includes('--dry-run');

/** 舊 id → 新 id */
const ID_RENAMES = {
  'cn--': 'cn-fh',
  'cn-cctv5-': 'cn-cctv5plus',
  'cn-cctv5p': 'cn-cctv5plus',
};

const catalog = JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'));

const seen = new Set();
let renamed = 0;
let deduped = 0;

for (const c of catalog.channels) {
  const newId = ID_RENAMES[c.channel_id];
  if (newId) {
    console.log(`  ↻ ${c.channel_id} → ${newId}  (${c.channel_name})`);
    c.channel_id = newId;
    renamed++;
  }
}

// 撞號處理：若新 id 已被占用，保留先出現的那個（後面的加流水號）
for (const c of catalog.channels) {
  if (seen.has(c.channel_id)) {
    let n = 2;
    let candidate = `${c.channel_id}-${n}`;
    while (seen.has(candidate)) candidate = `${c.channel_id}-${++n}`;
    console.log(`  ! id 撞號 ${c.channel_id} → ${candidate}  (${c.channel_name})`);
    c.channel_id = candidate;
    deduped++;
  }
  seen.add(c.channel_id);
}

console.log('');
console.log(`改名 ${renamed} 個｜撞號處理 ${deduped} 個｜總頻道 ${catalog.channels.length}`);

if (DRY_RUN) {
  console.log('\n(dry-run 模式，未寫入檔案)');
  process.exit(0);
}

catalog.updated_at = new Date().toISOString();
writeFileSync(CHANNELS_PATH, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
console.log(`\n已寫入 ${CHANNELS_PATH}`);
