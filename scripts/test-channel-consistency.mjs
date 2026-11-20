#!/usr/bin/env node
/**
 * 頻道資料一致性測試
 *
 * 驗證 Android APK 內的 assets/channels.json 與 Web 版的 public/channels.json
 * 來自同一份 shared/channels.json，且授權守門一致。
 *
 * 用法：node scripts/test-channel-consistency.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const SHARED = join(ROOT, 'shared', 'channels.json');
const ANDROID_ASSETS = join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'channels.json');
const WEB_PUBLIC = join(ROOT, 'web', 'public', 'channels.json');

const ALLOWED = new Set(['authorized', 'public_official', 'user_provided']);

let failures = 0;
let checks = 0;

function check(name, condition, detail = '') {
  checks++;
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function readJSON(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

console.log('─'.repeat(60));
console.log('頻道資料一致性測試');
console.log('─'.repeat(60));

const shared = readJSON(SHARED);
const android = readJSON(ANDROID_ASSETS);
const web = readJSON(WEB_PUBLIC);

console.log('\n[1] 檔案存在性');
check('shared/channels.json 存在且可解析', shared !== null);
check('android assets/channels.json 存在且可解析', android !== null);
check('web public/channels.json 存在且可解析', web !== null);

if (!shared || !android || !web) {
  console.log('\n缺少檔案，請先執行：node scripts/sync-channels.mjs');
  process.exit(1);
}

console.log('\n[2] 兩端內容一致');
const androidIds = android.channels.map((c) => c.channel_id).sort();
const webIds = web.channels.map((c) => c.channel_id).sort();
check(
  'APK 與 Web 的頻道 id 清單完全相同',
  JSON.stringify(androidIds) === JSON.stringify(webIds),
  `APK=${androidIds.join(',')} WEB=${webIds.join(',')}`,
);

const keyFields = (list) =>
  JSON.stringify(
    list.map((c) => ({
      id: c.channel_id,
      url: c.stream_url,
      embed: c.embed_url ?? null,
      type: c.stream_type,
      auth: c.authorization_status,
      src: c.source_name,
    })),
  );
check(
  'APK 與 Web 的頻道關鍵欄位（網址/類型/授權/來源）完全相同',
  keyFields(android.channels) === keyFields(web.channels),
);

console.log('\n[3] 授權守門');
const sharedActive = shared.channels.filter((c) => c.is_active);
const publishedIds = new Set(android.channels.map((c) => c.channel_id));
const improperlyPublished = sharedActive.filter(
  (c) => !ALLOWED.has(c.authorization_status) && publishedIds.has(c.channel_id),
);
check(
  '沒有任何未授權頻道出現在發佈產物中',
  improperlyPublished.length === 0,
  improperlyPublished.map((c) => c.channel_id).join(', '),
);

const missingSource = android.channels.filter((c) => !c.source_name || !c.source_website);
check('每個已發佈頻道都有來源名稱與官方網址', missingSource.length === 0);

/**
 * 播放網址檢查。
 *
 * 兩種合法的播放方式：
 *   - `stream_url`：直接播放的串流網址（http/https）
 *   - `embed_url`：官方嵌入播放器網址（http/https）
 *     授權狀態 A（public_official）的來源以 iframe 嵌入官方播放器，
 *     stream_url 會是空字串。
 *
 * 兩者至少要有一個，且都必須是 http(s)。
 */
const invalidUrl = android.channels.filter((c) => {
  const stream = c.stream_url || '';
  const embed = c.embed_url || '';
  if (!stream && !embed) return true;
  if (stream && !/^https?:\/\//.test(stream)) return true;
  if (embed && !/^https?:\/\//.test(embed)) return true;
  return false;
});
check(
  '每個已發佈頻道都有 http(s) 的播放網址（stream_url 或 embed_url）',
  invalidUrl.length === 0,
);

console.log('\n[4] 資料結構');
check(
  '所有頻道的 category 都存在於 categories 定義',
  android.channels.every((c) => android.categories.some((cat) => cat.id === c.category)),
);
const dupIds = androidIds.filter((id, i) => androidIds.indexOf(id) !== i);
check('沒有重複的 channel_id', dupIds.length === 0, dupIds.join(', '));

console.log('\n[5] 同步狀態');
check(
  '產物時間戳與 shared 一致（表示已執行 sync）',
  android.updated_at === shared.updated_at && web.updated_at === shared.updated_at,
  `shared=${shared.updated_at} android=${android.updated_at} web=${web.updated_at}`,
);

console.log('\n' + '─'.repeat(60));
if (failures > 0) {
  console.log(`✗ ${failures} / ${checks} 項檢查失敗`);
  console.log('─'.repeat(60));
  process.exit(1);
}
console.log(`✓ 全部 ${checks} 項檢查通過`);
console.log(`  發佈頻道數：${android.channels.length}`);
console.log('─'.repeat(60));
