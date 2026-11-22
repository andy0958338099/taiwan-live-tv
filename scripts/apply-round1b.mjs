#!/usr/bin/env node
/**
 * apply-round1b.mjs — 第 1 輪的第二批處置：鳳凰衛視三頻道換源
 *
 * 背景（第 1 輪「內容雜湊」判定結果）：
 *   · 鳳凰衛視       （php.jdshipin.com?id=fhzw）→ 序號停在 3315441、雜湊 30 秒不變
 *   · 鳳凰衛視中文台 （cdn.qd.je/163189/fhzw）  → 同上
 *   · 鳳凰衛視資訊台 （cdn.qd.je/163189/fhzx）  → 序號停在 4578902、雜湊不變
 *   三者的備援（cdn6.cc.cd）回的是同一個序號 → 整組停播。
 *
 * 替代來源（itvlist 清單的「名稱↔網址配對」確認同一頻道）：
 *   · 鳳凰衛視中文台 ← http://120.198.95.220:9901/tsfile/live/1036_1.m3u8?key=txiptv&playlive=1&down=1
 *     （itvlist.m3u：「凤凰中文」↔ 該網址；序號 2035045 → 2035050 前進，雜湊遞變）
 *   · 鳳凰衛視資訊台 ← http://120.198.95.220:9901/tsfile/live/1037_1.m3u8?key=txiptv&playlive=1&down=1
 *     （itvlist.m3u：「凤凰资讯」↔ 該網址；序號 2035050 → 2035055 前進，雜湊遞變）
 *   · 鳳凰衛視       ← 原本的 php.jdshipin.com?id=fhzw 實際就是 fhzw（鳳凰衛視中文台）
 *     → 同一個上游 feed，一併換成 1036_1（與「鳳凰衛視中文台」共用來源）
 *
 * 註：不是「用 1036_1 當 1037_1 的備援」這種跨頻道替代 ——
 *     1036_1 對應「凤凰中文」、1037_1 對應「凤凰资讯」，
 *     兩者在**同一份上游清單**裡各有名稱↔網址配對。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHANNELS_PATH = join(ROOT, 'shared', 'channels.json');

const NOW = new Date().toISOString();

const SWAPS = [
  {
    name: '鳳凰衛視中文台',
    newPrimary: 'http://120.198.95.220:9901/tsfile/live/1036_1.m3u8?key=txiptv&playlive=1&down=1',
    provider: 'itvlist',
    label: 'itvlist 聚合源',
    rawName: '凤凰中文',
    desc: '鳳凰衛視中文台（itvlist 聚合源）。已驗證序號持續前進（2035045→2035050）、segment 為 MPEG-TS。',
  },
  {
    name: '鳳凰衛視資訊台',
    newPrimary: 'http://120.198.95.220:9901/tsfile/live/1037_1.m3u8?key=txiptv&playlive=1&down=1',
    provider: 'itvlist',
    label: 'itvlist 聚合源',
    rawName: '凤凰资讯',
    desc: '鳳凰衛視資訊台（itvlist 聚合源）。已驗證序號持續前進（2035050→2035055）、segment 為 MPEG-TS。',
  },
  {
    name: '鳳凰衛視',
    newPrimary: 'http://120.198.95.220:9901/tsfile/live/1036_1.m3u8?key=txiptv&playlive=1&down=1',
    provider: 'itvlist',
    label: 'itvlist 聚合源',
    rawName: '凤凰中文',
    desc: '鳳凰衛視（itvlist 聚合源）。原來源 php.jdshipin.com?id=fhzw 實際上游即 fhzw，已停播（序號停在 3315441），改用可播的同頻道來源。',
  },
];

function main() {
  const catalog = JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'));
  const byName = new Map(catalog.channels.map((c) => [c.channel_name, c]));
  const log = [];

  for (const s of SWAPS) {
    const ch = byName.get(s.name);
    if (!ch) {
      log.push(`略過 ${s.name} — 頻道不存在`);
      continue;
    }
    const old = ch.stream_url;
    if (old === s.newPrimary) continue;

    const backups = ch.playlist_source?.backup_urls ?? [];
    ch.playlist_source.backup_urls = [
      {
        url: old,
        source: '原主來源（已停播：序號停滯、segment 雜湊不變）',
        cors: ch.cors_enabled ?? false,
      },
      ...backups.filter((b) => b.url !== old),
    ];
    ch.stream_url = s.newPrimary;
    ch.last_checked = NOW;
    ch.description = s.desc;
    ch.playlist_source.provider = s.provider;
    ch.playlist_source.provider_label = s.label;
    ch.playlist_source.provider_url = 'https://bit.ly/itvlist';
    ch.playlist_source.raw_channel_name = s.rawName;
    ch.source_name = `${ch.channel_name}（經 ${s.label} 轉載）`;
    ch.source_website = 'https://bit.ly/itvlist';
    log.push(`換源 ${s.name}：${old} → ${s.newPrimary}`);
  }

  catalog.updated_at = NOW;

  console.log('處置明細：');
  for (const l of log) console.log('  · ' + l);

  writeFileSync(CHANNELS_PATH, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  console.log(`\n已寫入 ${CHANNELS_PATH}`);
  console.log(`頻道總數：${catalog.channels.length}`);
}

main();
