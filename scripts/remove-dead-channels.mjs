#!/usr/bin/env node
/**
 * remove-dead-channels.mjs — 移除實測無法播放的頻道
 *
 * 輸入：一份「實測失敗清單」（JSON，格式為 {"failed": ["頻道名", ...]}）
 * 輸出：把這些頻道從 shared/channels.json 移除，並同步到兩端產物
 *
 * 為什麼要移除而不是停用：
 *   專案原則是「不得將無效串流假裝成正常播放」。
 *   一個會讓使用者按下播放卻得不到畫面的頻道，留著只會造成困惑。
 *   停用（is_active=false）仍然會出現在資料檔裡被誤認為「只是暫時失效」，
 *   所以直接從上線清單移除，只保留在待確認清單中（shared/sources.json）。
 *
 * 用法：node scripts/remove-dead-channels.mjs <結果檔.json> [--dry-run]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHANNELS_PATH = join(ROOT, 'shared', 'channels.json');
const SOURCES_PATH = join(ROOT, 'shared', 'sources.json');

const DRY_RUN = process.argv.includes('--dry-run');
const resultPath = process.argv.find((a) => a.endsWith('.json'));

if (!resultPath || !existsSync(resultPath)) {
  console.error('用法：node scripts/remove-dead-channels.mjs <實測結果.json> [--dry-run]');
  process.exit(1);
}

const result = JSON.parse(readFileSync(resultPath, 'utf8'));
const deadNames = new Set(result.failed ?? []);

if (deadNames.size === 0) {
  console.log('沒有需要移除的頻道。');
  process.exit(0);
}

console.log('═'.repeat(64));
console.log(`移除實測無法播放的頻道：${deadNames.size} 個`);
console.log('═'.repeat(64));
console.log('');

const data = JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'));
const before = data.channels.length;

// 記錄被移除的頻道到待確認清單（保留來源資訊，方便日後恢復）
let sources = { pending_review: [] };
if (existsSync(SOURCES_PATH)) {
  sources = JSON.parse(readFileSync(SOURCES_PATH, 'utf8'));
}
if (!Array.isArray(sources.pending_review)) sources.pending_review = [];

const removed = [];
data.channels = data.channels.filter((c) => {
  if (!deadNames.has(c.channel_name)) return true;
  removed.push(c);
  sources.pending_review.push({
    channel_id: c.channel_id,
    channel_name: c.channel_name,
    category: c.category,
    source_name: c.source_name,
    source_website: c.source_website,
    stream_url: c.stream_url,
    embed_url: c.embed_url ?? null,
    authorization_status: c.authorization_status,
    removed_at: new Date().toISOString(),
    removed_reason: '線上實測無法播放（無畫面），已從上線清單移除',
  });
  return false;
});

console.log('被移除的頻道：');
for (const c of removed) {
  console.log(`  ✗ ${c.channel_name}（${c.category}）— ${c.source_name}`);
}

console.log('');
console.log(`上線頻道：${before} → ${data.channels.length}`);

if (DRY_RUN) {
  console.log('\n(dry-run 模式，未寫入檔案)');
  process.exit(0);
}

data.updated_at = new Date().toISOString();
writeFileSync(CHANNELS_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
writeFileSync(SOURCES_PATH, JSON.stringify(sources, null, 2) + '\n', 'utf8');
console.log(`\n✓ 已更新 shared/channels.json 與 shared/sources.json`);
console.log('\n下一步：node scripts/validate-channels.mjs && node scripts/sync-channels.mjs');
