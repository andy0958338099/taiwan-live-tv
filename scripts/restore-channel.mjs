#!/usr/bin/env node
/**
 * restore-channel.mjs — 還原被誤刪的頻道
 *
 * 背景：`cleanup-channels.mjs` 依據 `verify-channel-sources.mjs` 的結果
 * 移除「所有來源皆失效」的頻道。但驗證當下若上游偶發壅塞
 * （segment 逾時），就會把可用的頻道誤殺。
 *
 * 實測：廣東體育台在清理時被移除，但事後重測 3 次
 * `https://2.fast.hidns.vip/163189/gdty` 全部回 200（4.8 KB manifest），
 * 確認是當時的偶發逾時，不是真的失效。
 *
 * 本腳本從 git 歷史把指定頻道還原回來（保留當前資料庫的其他變更）。
 *
 * 用法：node scripts/restore-channel.mjs <channel_id> [--from <commit>]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHANNELS_PATH = join(ROOT, 'shared', 'channels.json');

const channelId = process.argv[2];
if (!channelId) {
  console.error('用法：node scripts/restore-channel.mjs <channel_id> [--from <commit>]');
  process.exit(1);
}

const fromIdx = process.argv.indexOf('--from');
const fromCommit = fromIdx >= 0 ? process.argv[fromIdx + 1] : 'HEAD';

function gitShow(ref, path) {
  return execSync(`git show ${ref}:${path}`, { cwd: ROOT, encoding: 'utf8' });
}

console.log('═'.repeat(70));
console.log('還原頻道');
console.log('═'.repeat(70));

const catalog = JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'));

if (catalog.channels.some((c) => c.channel_id === channelId)) {
  console.log(`頻道 ${channelId} 已在清單中，無需還原`);
  process.exit(0);
}

console.log(`從 ${fromCommit} 找尋 ${channelId} …`);

// 往前找，最多看 40 個 commit
const log = execSync(`git log --format=%H -40 -- ${CHANNELS_PATH}`, {
  cwd: ROOT,
  encoding: 'utf8',
})
  .trim()
  .split('\n');

let restored = null;
for (const commit of log) {
  try {
    const raw = gitShow(commit, 'shared/channels.json');
    const data = JSON.parse(raw);
    const found = data.channels.find((c) => c.channel_id === channelId);
    if (found) {
      restored = found;
      console.log(`  ✓ 找到於 commit ${commit.slice(0, 8)}`);
      break;
    }
  } catch {
    // 該 commit 的檔案格式不同或不存在，略過
  }
}

if (!restored) {
  console.error(`✗ 在 git 歷史中找不到 ${channelId}`);
  process.exit(1);
}

// 插回原本的位置（依 region / category 分組順序）
const insertAt = catalog.channels.findIndex(
  (c) => c.channel_id.startsWith('cn-') && c.channel_id > channelId,
);
const idx = insertAt >= 0 ? insertAt : catalog.channels.length;
catalog.channels.splice(idx, 0, restored);

catalog.updated_at = new Date().toISOString();
writeFileSync(CHANNELS_PATH, JSON.stringify(catalog, null, 2) + '\n', 'utf8');

console.log(`\n✓ 已還原「${restored.channel_name}」`);
console.log(`  網址: ${restored.stream_url}`);
console.log(`  位置: 第 ${idx + 1} 個`);
console.log(`  頻道總數: ${catalog.channels.length}`);
