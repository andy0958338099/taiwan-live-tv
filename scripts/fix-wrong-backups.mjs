#!/usr/bin/env node
/**
 * 清理「備援來源指向別的頻道」的錯誤。
 *
 * ## 問題（實測 2026-11-21）
 *
 * 照片顯示播放器 failover 到「備援來源 3/7」，畫面卻是**龍華日韓台**，
 * 但 UI 顯示「龍華電視」。使用者看到的是**錯誤的頻道內容**。
 *
 * 根因：`import-playlists.mjs` 用 `clean.includes(key)` 模糊配對頻道，
 * 「龍華電視」因此匹配到「龍華偶像台」「龍華日韓台」等同家族頻道，
 * 它們被當成「龍華電視」的備援來源。
 *
 * ## 修法
 *
 * 用 `lib/channel-identity.mjs` 解析每個來源的 **(命名空間, 代碼)**：
 *   · 直接路徑型 `/{數字}/{代碼}` → 不需網路即可解析
 *   · 轉址型 → 抓 manifest 追到 segment
 *
 * 與主來源身分不同 → 移除該備援。
 *
 * ## 為什麼要比對命名空間
 *
 * 代碼只在來源站自己的命名空間內有意義。`163189/lhjd`（龍華電視）
 * 與 `4005/xxx`（另一套來源）不能只比代碼，必須比對整組。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveChannelRef, sameRef, parseChannelRef } from './lib/channel-identity.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'shared', 'channels.json');

const catalog = JSON.parse(readFileSync(SRC, 'utf8'));

console.log('════ 清理指向別個頻道的備援 ════\n');

const toFix = [];
let checked = 0;
let unresolvable = 0;

for (const ch of catalog.channels) {
  const ps = ch.playlist_source;
  if (!ps?.backup_urls?.length) continue;

  const mainRef = parseChannelRef(ch.stream_url);
  // 主來源解析不出來 → 這個頻道無法用本方法判定
  if (!mainRef) continue;

  const wrong = [];
  for (const b of ps.backup_urls) {
    checked++;

    // 先試不需網路的解析
    let ref = parseChannelRef(b.url);
    if (!ref) {
      // 轉址型 → 抓 manifest
      ref = await resolveChannelRef(b.url);
      if (!ref) {
        unresolvable++;
        continue; // 離線或解析不出 → 保留（來源波動 ≠ 資料錯誤）
      }
    }

    if (!sameRef(ref, mainRef)) {
      wrong.push({ ...b, ref: `${ref.ns}/${ref.code}` });
    }
  }

  if (wrong.length) {
    toFix.push({ ch, wrong, mainRef });
    console.log(
      `  ✗ ${ch.channel_name}（主 ${mainRef.ns}/${mainRef.code}）` +
        `→ ${wrong.length} 個備援是別的頻道：${wrong.map((w) => w.ref).join(', ')}`,
    );
  }
}

console.log(`\n  檢查備援：${checked} 個`);
console.log(`  無法解析（來源離線）：${unresolvable} 個`);
console.log(`  需修正的頻道：${toFix.length}`);

if (toFix.length && !process.argv.includes('--dry-run')) {
  console.log('');
  for (const { ch, wrong } of toFix) {
    const wrongUrls = new Set(wrong.map((w) => w.url));
    const before = ch.playlist_source.backup_urls.length;
    ch.playlist_source.backup_urls = ch.playlist_source.backup_urls.filter(
      (b) => !wrongUrls.has(b.url),
    );
    console.log(
      `  ✓ ${ch.channel_name}：移除 ${before - ch.playlist_source.backup_urls.length} 個，` +
        `保留 ${ch.playlist_source.backup_urls.length} 個`,
    );
  }
  catalog.updated_at = new Date().toISOString();
  writeFileSync(SRC, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  console.log('\n已更新 shared/channels.json');
}
