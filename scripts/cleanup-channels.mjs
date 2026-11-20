#!/usr/bin/env node
/**
 * cleanup-channels.mjs — 依驗證結果清理頻道清單
 *
 * 輸入：shared/source-verification.json
 *   （由 scripts/verify-channel-sources.mjs 產生，
 *     對每個頻道的主來源與備援做完整 manifest → child → segment 驗證）
 *
 * 處理：
 *   1. **完全失效**（主來源與所有備援都失敗）→ 從清單中移除
 *   2. **主來源失效但備援可用** → 把可用的備援升為主來源
 *   3. 更新 last_checked
 *
 * 用法：node scripts/cleanup-channels.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHANNELS_PATH = join(ROOT, 'shared', 'channels.json');
const VERIFY_PATH = join(ROOT, 'shared', 'source-verification.json');

const DRY_RUN = process.argv.includes('--dry-run');

function main() {
  console.log('═'.repeat(70));
  console.log('依驗證結果清理頻道清單');
  console.log('═'.repeat(70));

  if (!existsSync(VERIFY_PATH)) {
    console.error('✗ 找不到 shared/source-verification.json');
    console.error('  請先執行：node scripts/verify-channel-sources.mjs');
    process.exit(1);
  }

  const verify = JSON.parse(readFileSync(VERIFY_PATH, 'utf8'));
  const catalog = JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'));

  console.log(`驗證時間：${verify.verified_at}`);
  console.log(`驗證頻道數：${verify.results.length}\n`);

  const byId = new Map(verify.results.map((r) => [r.channel_id, r]));
  const now = new Date().toISOString();

  const removed = [];
  const promoted = [];
  const kept = [];

  catalog.channels = catalog.channels.filter((ch) => {
    const v = byId.get(ch.channel_id);

    // 沒被驗證到的頻道（例如 embed 類型沒有 stream_url）→ 保留
    if (!v) {
      kept.push(ch);
      return true;
    }

    // 完全失效：主來源與所有備援都無法播放
    if (!v.working_url) {
      removed.push({ name: ch.channel_name, id: ch.channel_id, reason: v.primary_reason });
      return false;
    }

    // 主來源失效但備援可用 → 升級
    if (v.needs_swap) {
      const oldPrimary = ch.stream_url;
      ch.stream_url = v.working_url;

      // 原本的壞主來源降為備援（放最後）
      const backups = ch.playlist_source?.backup_urls ?? [];
      ch.playlist_source = {
        ...(ch.playlist_source ?? {}),
        backup_urls: [
          ...backups.filter((b) => b.url !== v.working_url),
          ...(oldPrimary !== v.working_url
            ? [{ url: oldPrimary, source: '原主來源（已失效）', cors: false }]
            : []),
        ],
      };

      promoted.push({
        name: ch.channel_name,
        old: oldPrimary,
        new: v.working_url,
      });
    }

    ch.last_checked = now;
    kept.push(ch);
    return true;
  });

  console.log(`移除 ${removed.length} 個｜升級備援 ${promoted.length} 個｜保留 ${kept.length} 個`);
  console.log(`頻道總數：${catalog.channels.length}`);

  if (removed.length) {
    console.log('\n移除（所有來源皆失效）：');
    for (const r of removed) {
      console.log(`  ✗ ${r.name} (${r.id}) — ${r.reason}`);
    }
  }

  if (promoted.length) {
    console.log('\n升級為可用備援：');
    for (const p of promoted) {
      console.log(`  ↻ ${p.name}`);
      console.log(`      舊: ${p.old.slice(0, 76)}`);
      console.log(`      新: ${p.new.slice(0, 76)}`);
    }
  }

  if (DRY_RUN) {
    console.log('\n(dry-run 模式，未寫入檔案)');
    return;
  }

  catalog.updated_at = now;
  writeFileSync(CHANNELS_PATH, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  console.log(`\n已寫入 ${CHANNELS_PATH}`);
  console.log('\n下一步：node scripts/validate-channels.mjs && node scripts/sync-channels.mjs');
}

main();
