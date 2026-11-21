#!/usr/bin/env node
/**
 * 回歸測試：備援來源必須指向**同一個頻道**。
 *
 * ## 為什麼需要這個測試
 *
 * 實測（2026-11-21）照片顯示：播放器 failover 到「備援來源 3/7」，
 * 畫面卻是**龍華日韓台**，但 UI 的頻道名稱仍是「龍華電視」。
 *
 * 根因：`import-playlists.mjs` 用 `clean.includes(key)` 模糊配對，
 * 把同家族的其他頻道當成了備援。
 *
 * 後果：**使用者會看到錯誤的頻道內容**，而且 UI 完全不會警告。
 *
 * ## 判斷依據
 *
 * 用 `lib/channel-identity.mjs` 解析每個來源的 **(命名空間, 代碼)**：
 *   · 直接路徑型 `/{數字}/{代碼}` → 不需網路即可解析
 *   · 轉址型 → 抓 manifest 追到 segment
 *
 * 與主來源身分不同 → **FAIL**。
 *
 * 離線來源跳過（不算失敗），因為那是來源波動不是資料錯誤。
 *
 * 用法：`node scripts/test-backup-same-channel.mjs`
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveChannelRef, sameRef, parseChannelRef } from './lib/channel-identity.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'shared', 'channels.json');

const catalog = JSON.parse(readFileSync(SRC, 'utf8'));

console.log('════ 測試：備援來源必須是同一個頻道 ════\n');

const failures = [];
let checked = 0;
let unreachable = 0;

for (const ch of catalog.channels) {
  const backups = ch.playlist_source?.backup_urls ?? [];
  if (!backups.length) continue;

  const mainRef = parseChannelRef(ch.stream_url);
  if (!mainRef) continue;

  for (const b of backups) {
    checked++;

    // 先試不需網路的解析
    let ref = parseChannelRef(b.url);
    if (!ref) {
      // 轉址型 → 抓 manifest
      ref = await resolveChannelRef(b.url);
      if (!ref) {
        unreachable++;
        continue;
      }
    }

    if (!sameRef(ref, mainRef)) {
      failures.push({
        channel: ch.channel_name,
        main: `${mainRef.ns}/${mainRef.code}`,
        backup: `${ref.ns}/${ref.code}`,
        url: b.url,
      });
    }
  }
}

console.log(`  檢查備援：${checked} 個`);
console.log(`  離線跳過：${unreachable} 個`);
console.log(`  錯配：${failures.length} 個\n`);

if (failures.length) {
  for (const f of failures) {
    console.log(`  ✗ ${f.channel}：主來源 ${f.main}，備援卻是 ${f.backup}`);
    console.log(`     ${f.url}`);
  }
  console.log('\n  ❌ FAIL — 有備援指向別的頻道，使用者會看到錯誤內容');
  console.log('     執行 `node scripts/fix-wrong-backups.mjs` 修復');
  process.exit(1);
}

console.log('  ✅ PASS — 所有備援都指向同一個頻道');
