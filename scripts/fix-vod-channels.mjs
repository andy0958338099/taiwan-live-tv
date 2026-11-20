#!/usr/bin/env node
/**
 * fix-vod-channels.mjs — 修正與移除 VOD 型態的頻道
 *
 * 背景：
 *   線上實測發現，有一批頻道的「直播」來源其實是 **VOD（點播）**：
 *   manifest 裡有 `#EXT-X-ENDLIST`、只有 1 個 10 秒的 segment。
 *   那是 IPTV 清單提供者放進來的**預覽片段**，不是真正的直播訊號 ——
 *   播完 10 秒就停，看起來像「播放失敗」。
 *
 *   專案原則是「不得將無效串流假裝成正常播放」，所以必須處理。
 *
 * 處理方式：
 *   1. 頻道有「真的直播」備援來源 → 把主來源換成直播來源，保留頻道
 *   2. 沒有直播備援 → 從上線清單移除（記錄到 shared/sources.json 的待確認清單）
 *
 * 用法：node scripts/fix-vod-channels.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHANNELS_PATH = join(ROOT, 'shared', 'channels.json');
const SOURCES_PATH = join(ROOT, 'shared', 'sources.json');

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * 已實測的直播備援來源（由 scripts/probe-streams.mjs 與
 * scripts/check-stream-types 驗證：manifest 無 ENDLIST）。
 *
 * 這份對應表是「一次性的資料修正」，不是常態邏輯 ——
 * 來源失效時需要重新用 refresh-channels.mjs 匯入。
 */
const LIVE_REPLACEMENTS = {
  緯來: {
    url: 'https://cdn.qd.je/163189/wlxj',
    note: '主來源為 VOD 預覽片段，已改用同頻道的直播備援來源',
  },
  龍祥: {
    url: 'https://cdn.qd.je/163189/lxsd',
    note: '主來源為 VOD 預覽片段，已改用同頻道的直播備援來源',
  },
};

/**
 * 完全沒有直播來源的頻道 → 移除。
 *
 * 實測結果：這些頻道在 YanG IPTV 清單中的所有來源都是
 * 10 秒的 VOD 預覽片段，沒有任何直播版本。
 */
const REMOVE_CHANNELS = [
  'CINEMAX',
  'MTV台',
  'Smart知識台',
  '動物星球',
  '台灣戲劇台',
  '台視 TTV',
  '年代 MUCH',
  '愛爾達體育',
  '第1商業台',
];

function main() {
  const data = JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'));
  const before = data.channels.length;

  let sources = { pending_review: [] };
  if (existsSync(SOURCES_PATH)) {
    sources = JSON.parse(readFileSync(SOURCES_PATH, 'utf8'));
  }
  if (!Array.isArray(sources.pending_review)) sources.pending_review = [];

  console.log('═'.repeat(64));
  console.log('修正 VOD 型態頻道');
  console.log('═'.repeat(64));
  console.log('');

  // 1) 有直播備援的 → 換主來源
  let fixed = 0;
  for (const ch of data.channels) {
    const rep = LIVE_REPLACEMENTS[ch.channel_name];
    if (!rep) continue;

    const oldUrl = ch.stream_url;
    ch.stream_url = rep.url;
    ch.notes = `${ch.notes ? ch.notes + ' | ' : ''}${rep.note}`;
    // 直播來源需要走代理（CORS）
    ch.cors_enabled = false;

    // 備援清單：移除所有 VOD 來源的舊網址，只留直播的
    const ps = ch.playlist_source;
    if (ps?.backup_urls) {
      ps.backup_urls = ps.backup_urls.filter(
        (b) => b.url !== oldUrl && !b.url.includes('yang-1989.xyz'),
      );
    }

    console.log(`  ↻ ${ch.channel_name}：改用直播來源 ${rep.url}`);
    fixed++;
  }

  // 2) 沒有直播來源的 → 移除
  const removed = [];
  data.channels = data.channels.filter((c) => {
    if (!REMOVE_CHANNELS.includes(c.channel_name)) return true;
    removed.push(c);
    sources.pending_review.push({
      channel_id: c.channel_id,
      channel_name: c.channel_name,
      category: c.category,
      source_name: c.source_name,
      source_website: c.source_website,
      stream_url: c.stream_url,
      authorization_status: c.authorization_status,
      removed_at: new Date().toISOString(),
      removed_reason:
        '所有來源皆為 10 秒 VOD 預覽片段（非直播），已從上線清單移除',
    });
    return false;
  });

  console.log('');
  for (const c of removed) {
    console.log(`  ✗ 移除 ${c.channel_name}（${c.category}）— 僅有 VOD 預覽片段`);
  }

  console.log('');
  console.log(`改用直播來源 ${fixed} 個｜移除 ${removed.length} 個`);
  console.log(`上線頻道：${before} → ${data.channels.length}`);

  if (DRY_RUN) {
    console.log('\n(dry-run 模式，未寫入檔案)');
    return;
  }

  data.updated_at = new Date().toISOString();
  writeFileSync(CHANNELS_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
  writeFileSync(SOURCES_PATH, JSON.stringify(sources, null, 2) + '\n', 'utf8');
  console.log('\n✓ 已更新 shared/channels.json 與 shared/sources.json');
  console.log('下一步：node scripts/validate-channels.mjs && node scripts/sync-channels.mjs');
}

main();
