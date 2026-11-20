#!/usr/bin/env node
/**
 * register-live-sources.mjs — 把新的直播聚合源註冊到 shared/sources.json
 *
 * 新增的來源是「主播直播間」型態（抖音／斗魚／B站／虎牙／歪歪／SOOP／Twitch），
 * 不是電視台。這類來源的性質與 IPTV 電視台清單不同：
 *
 *   - 隨時會離線（主播沒開播）
 *   - 沒有固定頻道清單，是「誰在播誰就出現在清單裡」
 *   - 因此不適合放進共用頻道資料（APK 與 Web 讀同一份），
 *     應該獨立成一份「直播清單」，由專門的機制更新
 *
 * 本腳本只做「註冊」：把來源與其性質記錄下來，
 * 讓 scripts/probe-live-sources.mjs 之後可以依此定期重新探測。
 *
 * 用法：node scripts/register-live-sources.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCES_PATH = join(__dirname, '..', 'shared', 'sources.json');

/** 新增的直播聚合源 */
const NEW_SOURCES = [
  {
    id: 'yang-live',
    label: 'YanG 直播聚合源',
    url: 'https://live.yang-1989.eu.org/Live.m3u',
    enabled: true,
    priority: 6,
    kind: 'live_streams',
    notes:
      '抖音／斗魚／B站／YY／SOOP／Twitch 聚合。840 筆，含提示用的 .mp4 需排除。',
  },
  {
    id: 'huya',
    label: 'Kimentanm 虎牙源',
    url: 'https://cdn.jsdelivr.net/gh/Kimentanm/aptv@master/m3u/ya.m3u',
    enabled: true,
    priority: 7,
    kind: 'live_streams',
    notes: '虎牙直播清單，約 5000 筆，全部經同一個轉載代理節點。',
  },
  {
    id: 'huya-yqk',
    label: 'Kimentanm 虎牙一起看',
    url: 'https://cdn.jsdelivr.net/gh/Kimentanm/aptv@refs/heads/master/m3u/yqk.m3u',
    enabled: true,
    priority: 8,
    kind: 'live_streams',
    notes: '虎牙「一起看」房間清單，約 810 筆。',
  },
  {
    id: 'douyu',
    label: 'Kimentanm 斗魚源',
    url: 'https://cdn.jsdelivr.net/gh/Kimentanm/aptv@master/m3u/yu.m3u',
    enabled: true,
    priority: 9,
    kind: 'live_streams',
    notes: '斗魚直播清單，約 5000 筆。',
  },
  {
    id: 'bilibili',
    label: 'Kimentanm B站源',
    url: 'https://cdn.jsdelivr.net/gh/Kimentanm/aptv@master/m3u/bi.m3u',
    enabled: true,
    priority: 10,
    kind: 'live_streams',
    notes: 'Bilibili 直播清單，約 5000 筆。',
  },
];

const sources = JSON.parse(readFileSync(SOURCES_PATH, 'utf8'));
const existing = new Set(sources.sources.map((s) => s.id));

let added = 0;
for (const s of NEW_SOURCES) {
  if (existing.has(s.id)) {
    console.log(`  ↻ 已存在，略過 ${s.id}`);
    continue;
  }
  sources.sources.push(s);
  console.log(`  + 註冊 ${s.label} (${s.id})`);
  added++;
}

// 註冊表的欄位說明
sources.source_kinds = {
  ...(sources.source_kinds ?? {}),
  iptv_channels:
    'IPTV 電視台清單 —— 頻道固定存在，適合放進 shared/channels.json（APK 與 Web 共用）。',
  live_streams:
    '主播直播間清單 —— 隨時離線、數量浮動，不適合放進共用頻道資料；' +
    '由 scripts/probe-live-sources.mjs 定期深層探測後另外維護。',
};

sources.updated_at = new Date().toISOString();
writeFileSync(SOURCES_PATH, JSON.stringify(sources, null, 2) + '\n', 'utf8');

console.log('');
console.log(`新增 ${added} 個來源｜來源總數 ${sources.sources.length}`);
console.log(`\n已寫入 ${SOURCES_PATH}`);
