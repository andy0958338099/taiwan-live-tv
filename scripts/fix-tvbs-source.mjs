#!/usr/bin/env node
/**
 * fix-tvbs-source.mjs — 把 TVBS 的主來源改成驗證過的 HTTPS 來源
 *
 * 問題：TVBS 的主來源 `http://38.64.72.148/...` 是 **純 HTTP**。
 *   站台本身是 HTTPS，瀏覽器會以「混合內容（mixed content）」直接封鎖，
 *   連錯誤訊息都不會顯示 —— 使用者只會看到畫面一片空白。
 *
 * 解法：把已經 deep probe 驗證過的 HTTPS 來源升為主來源：
 *   `https://d2jc41c1shgcol.cloudfront.net/live/tvbsnewsqt/playlist.m3u8`
 *   （HTTP 200 + CORS + LIVE + segment 2.6MB MPEG-TS）
 * 原本的 HTTP 來源保留為備援 —— 走代理後仍可使用。
 *
 * 用法：node scripts/fix-tvbs-source.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHANNELS_PATH = join(__dirname, '..', 'shared', 'channels.json');

/** 已驗證可播的 HTTPS 主來源 */
const NEW_PRIMARY = {
  url: 'https://d2jc41c1shgcol.cloudfront.net/live/tvbsnewsqt/playlist.m3u8',
  source: 'TVBS CloudFront（官方 CDN）',
  cors: true,
};

const TARGET_ID = 'playlist-TVBS-tvbs';

const catalog = JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'));
const ch = catalog.channels.find((c) => c.channel_id === TARGET_ID);

if (!ch) {
  console.error(`找不到頻道 ${TARGET_ID}`);
  process.exit(1);
}

const oldPrimary = ch.stream_url;
if (oldPrimary === NEW_PRIMARY.url) {
  console.log('TVBS 主來源已是 HTTPS 版本，無需變更');
  process.exit(0);
}

// 原本的主來源降為備援（去掉重複）
const backups = (ch.playlist_source?.backup_urls ?? []).filter(
  (b) => b.url !== NEW_PRIMARY.url,
);
if (!backups.some((b) => b.url === oldPrimary)) {
  backups.unshift({ url: oldPrimary, source: 'TVBS（純 HTTP，經代理）', cors: true });
}

ch.stream_url = NEW_PRIMARY.url;
ch.cors_enabled = true;
ch.last_checked = new Date().toISOString();
ch.playlist_source.backup_urls = backups;

catalog.updated_at = new Date().toISOString();
writeFileSync(CHANNELS_PATH, JSON.stringify(catalog, null, 2) + '\n', 'utf8');

console.log('✓ TVBS 主來源已改為 HTTPS：');
console.log(`  舊: ${oldPrimary}`);
console.log(`  新: ${ch.stream_url}`);
console.log(`  備援: ${backups.length} 個`);
