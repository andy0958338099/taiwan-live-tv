#!/usr/bin/env node
/**
 * sync-channels.mjs — 把 shared/channels.json 同步到 Android assets 與 Web public
 *
 * 這是「兩個平台共用同一份頻道資料」這個需求的實作核心。
 * 兩個平台的產物都由同一份來源產生，因此結構上不可能不一致。
 *
 * 產物：
 *   android/app/src/main/assets/channels.json   （APK 離線備援清單）
 *   web/public/channels.json                     （Web 版 fetch 的靜態 JSON）
 *
 * 用法：
 *   node scripts/sync-channels.mjs           # 驗證 + 同步
 *   node scripts/sync-channels.mjs --force   # 跳過驗證（僅限開發中除錯）
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'shared', 'channels.json');

const FORCE = process.argv.includes('--force');

const TARGETS = [
  {
    label: 'Android assets',
    path: join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'channels.json'),
  },
  {
    label: 'Web public',
    path: join(ROOT, 'web', 'public', 'channels.json'),
  },
];

// --- 驗證（除非 --force）---
if (!FORCE) {
  console.log('▶ 驗證頻道資料…');
  try {
    execFileSync(process.execPath, [join(__dirname, 'validate-channels.mjs')], {
      stdio: 'inherit',
    });
  } catch {
    console.error('\n✗ 驗證失敗，未同步任何檔案。');
    console.error('  請修正 shared/channels.json 後重試，或以 --force 強制同步（僅限開發除錯）。');
    process.exit(1);
  }
} else {
  console.warn('⚠ --force：已跳過驗證，僅供開發除錯使用。');
}

// --- 讀取並正規化 ---
const data = JSON.parse(readFileSync(SRC, 'utf8'));
data.updated_at = new Date().toISOString();

// 同步回寫 shared/channels.json 的 updated_at —— 讓來源檔本身記錄「上次同步時間」。
// 這讓 test-channel-consistency.mjs 能驗證三份檔案是同一次同步的產物。
writeFileSync(SRC, JSON.stringify(data, null, 2) + '\n', 'utf8');

// 只同步啟用中的頻道到前端產物。未授權頻道保留在 shared/ 供日後確認，
// 但絕不進入 APK 或網頁的公開清單。
const payload = {
  schema_version: data.schema_version,
  updated_at: data.updated_at,
  categories: data.categories,
  channels: (data.channels || []).filter((c) => c.is_active),
};

const serialized = JSON.stringify(payload, null, 2) + '\n';

console.log('');
console.log('▶ 同步頻道資料：');
for (const t of TARGETS) {
  if (!existsSync(dirname(t.path))) {
    mkdirSync(dirname(t.path), { recursive: true });
  }
  writeFileSync(t.path, serialized, 'utf8');
  console.log(`  ✓ ${t.label.padEnd(16)} → ${t.path.replace(ROOT + '/', '')}`);
}

const total = (data.channels || []).length;
const active = payload.channels.length;
console.log('');
console.log(`  頻道總數 ${total} → 上線 ${active}（${total - active} 筆因授權狀態或停用而不發佈）`);
console.log(`  schema_version: ${payload.schema_version}  updated_at: ${payload.updated_at}`);
