#!/usr/bin/env node
/**
 * apply-round2.mjs — 第 2 輪巡檢的資料處置（可重播，附實測依據）
 *
 * ## 處置一：換源（1 個）
 *
 * 東方衛視 `cn-df`
 *   舊主來源 `http://bp-resource-dfl.bestv.cn/155/3/video.m3u8`
 *     → 直連 HTTP 0（DNS 解析到 117.163.54.6/8/9，但 TCP 連線失敗）
 *     → 代理路徑 HTTP 502「代理失敗：fetch failed」
 *     → 兩個路徑同時失效，屬真死。
 *   新主來源 `http://121.19.134.149:808/tsfile/live/1026_1.m3u8?key=txiptv&playlive=1&authid=0`
 *     身分證據（同一份上游清單 itvlist，`https://bit.ly/itvlist` 第 364–365 行）：
 *       `#EXTINF:-1 tvg-name="东方卫视" … ,东方卫视`
 *       `http://121.19.134.149:808/tsfile/live/1026_1.m3u8?key=txiptv&playlive=1&authid=0`
 *       ⚠️ 代碼是 host-namespaced：`121.19.134.33:808` + `1026_1` 是「卡酷动画」，
 *          不是東方衛視 → 必須比對 (host, code) 整組，不能只比代碼。
 *     實測：master HTTP 200、segment 4/4 全部 HTTP 206 + 首位 0x47（MPEG-TS）
 *     停播檢查：MEDIA-SEQUENCE 26075922 → 26075923 → 26075925（持續前進）
 *
 * ## 處置二：新增（4 個）
 *
 * 全部來自上游清單的「名稱↔網址配對」，且逐條通過嚴格驗證
 * （manifest #EXTM3U、無 ENDLIST、segment 首位 0x47、CORS `*`、序號前進）。
 *
 * | 頻道 | 來源網址 | 身分證據 | 實測 |
 * |---|---|---|---|
 * | 民視新聞台 | `http://38.64.72.148/hls/modn/list/4012/chunklist0.m3u8` | reysc/M3U8 live2024.m3u 第 924–925 行「民视新闻」 | 4/4 segment 206 + 0x47；CORS `*`；seq 11178→ |
 * | 台視新聞台 | `http://38.64.72.148/hls/modn/list/4013/chunklist0.m3u8` | reysc/M3U8 live2024.m3u 第 930–931 行「台视新闻」 | 4/4 segment 206 + 0x47；CORS `*` |
 * | 國會頻道 1 台 | `http://61.58.60.230:9319/live/123.m3u8` | peakzheng1112/iptv2025 第 45–46 行「國會頻道1台」 | 4/4 segment 206 + 0x47；CORS `*`；seq 80536 |
 * | 國會頻道 2 台 | `http://61.58.60.230:9319/live/124.m3u8` | peakzheng1112/iptv2025 第 47–48 行「國會頻道2台」 | 4/4 segment 206 + 0x47；CORS `*`；seq 3208 |
 *
 * 授權狀態：全部 `user_provided`（第三方 IPTV 清單轉載，非廣播商官方 CDN）。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHANNELS_PATH = join(ROOT, 'shared', 'channels.json');

const NOW = new Date().toISOString();

const data = JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'));
const byId = new Map(data.channels.map((c) => [c.channel_id, c]));
const changes = [];

// ─────────────────────────────────────────────────────────────
// 處置一：東方衛視 換源
// ─────────────────────────────────────────────────────────────
{
  const c = byId.get('cn-df');
  if (!c) {
    console.error('✗ 找不到 cn-df（東方衛視）');
    process.exit(1);
  }
  const OLD = 'http://bp-resource-dfl.bestv.cn/155/3/video.m3u8';
  const NEW = 'http://121.19.134.149:808/tsfile/live/1026_1.m3u8?key=txiptv&playlive=1&authid=0';

  if (c.stream_url !== OLD) {
    console.log(`• 東方衛視主來源已是 ${c.stream_url}，跳過換源`);
  } else {
    c.stream_url = NEW;
    c.cors_enabled = false;
    c.last_checked = NOW;
    c.description =
      '東方衛視 — 中國大陸頻道。2026-11-22 第 2 輪換源：舊來源 bp-resource-dfl.bestv.cn ' +
      '直連與代理路徑同時失效（HTTP 0／代理 502 fetch failed），改用 itvlist 上游清單中' +
      '「东方卫视」↔`121.19.134.149:808/tsfile/live/1026_1.m3u8` 的配對。';
    c.notes =
      '轉載自第三方 IPTV 清單（非廣播商官方來源），授權狀態為使用者提供。' +
      '身分證據取自同一份上游清單（https://bit.ly/itvlist 第 364–365 行）的名稱↔網址配對；' +
      '代碼為 host-namespaced（121.19.134.33:808 + 1026_1 = 卡酷动画，非東方衛視）。';
    c.playlist_source = {
      provider: 'itvlist',
      provider_label: 'itvlist 聚合源',
      provider_url: 'https://bit.ly/itvlist',
      raw_channel_name: '东方卫视',
      backup_urls: [
        { url: OLD, source: '原主來源（2026-11-22 直連與代理路徑皆失效）', cors: true },
        { url: 'https://yshipin.pages.dev/play/dfws', source: '褲佬 清單', cors: true },
        { url: 'http://61.136.172.236:9901/tsfile/live/0107_1.m3u8?key=txiptv&playlive=1&authid=0', source: 'itvlist 聚合源', cors: false },
        { url: 'http://222.134.245.16:9901/tsfile/live/0107_1.m3u8?key=txiptv&playlive=1&authid=0', source: 'itvlist 聚合源', cors: false },
      ],
    };
    changes.push(`換源：東方衛視 → ${NEW}`);
  }
}

// ─────────────────────────────────────────────────────────────
// 處置二：新增 4 個頻道
// ─────────────────────────────────────────────────────────────
const NEW_CHANNELS = [
  {
    channel_id: 'tw-ftv-news',
    channel_name: '民視新聞台',
    name_en: 'FTV News',
    category: 'news',
    channel_number: null,
    logo: 'https://i.imgur.com/p108I5g.png',
    stream_url: 'http://38.64.72.148/hls/modn/list/4012/chunklist0.m3u8',
    stream_type: 'hls',
    source_name: '民視新聞台（經 IPTV 清單轉載）',
    source_website: 'https://github.com/reysc/M3U8/blob/master/live2024.m3u',
    authorization_status: 'user_provided',
    is_active: true,
    last_checked: NOW,
    description:
      '民視新聞台。2026-11-22 第 2 輪新增：HLS 來源取代原本只有 embed 的狀態。' +
      'segment 首位 0x47（MPEG-TS），來源回傳 Access-Control-Allow-Origin: *。',
    tags: ['台灣', '民視', 'FTV', '新聞', 'iptv'],
    region: '台灣',
    cors_enabled: true,
    http_referrer: null,
    notes:
      '身分證據取自同一份上游清單（reysc/M3U8 live2024.m3u 第 924–925 行）的名稱↔網址配對：' +
      '「民视新闻」↔`38.64.72.148/hls/modn/list/4012/chunklist0.m3u8`。',
    playlist_source: {
      provider: 'reysc/M3U8',
      provider_label: 'IPTV 公開清單',
      provider_url: 'https://github.com/reysc/M3U8/blob/master/live2024.m3u',
      raw_channel_name: '民视新闻',
      backup_urls: [],
    },
  },
  {
    channel_id: 'tw-ttv-news',
    channel_name: '台視新聞台',
    name_en: 'TTV News',
    category: 'news',
    channel_number: null,
    logo: 'https://i.imgur.com/V1EVtRm.png',
    stream_url: 'http://38.64.72.148/hls/modn/list/4013/chunklist0.m3u8',
    stream_type: 'hls',
    source_name: '台視新聞台（經 IPTV 清單轉載）',
    source_website: 'https://github.com/reysc/M3U8/blob/master/live2024.m3u',
    authorization_status: 'user_provided',
    is_active: true,
    last_checked: NOW,
    description:
      '台視新聞台。2026-11-22 第 2 輪新增：HLS 來源。' +
      'segment 首位 0x47（MPEG-TS），來源回傳 Access-Control-Allow-Origin: *。',
    tags: ['台灣', '台視', 'TTV', '新聞', 'iptv'],
    region: '台灣',
    cors_enabled: true,
    http_referrer: null,
    notes:
      '身分證據取自同一份上游清單（reysc/M3U8 live2024.m3u 第 930–931 行）的名稱↔網址配對：' +
      '「台视新闻」↔`38.64.72.148/hls/modn/list/4013/chunklist0.m3u8`。',
    playlist_source: {
      provider: 'reysc/M3U8',
      provider_label: 'IPTV 公開清單',
      provider_url: 'https://github.com/reysc/M3U8/blob/master/live2024.m3u',
      raw_channel_name: '台视新闻',
      backup_urls: [],
    },
  },
  {
    channel_id: 'tw-legislature-1',
    channel_name: '國會頻道 1 台',
    name_en: 'Legislature Channel 1',
    category: 'public',
    channel_number: null,
    logo: null,
    stream_url: 'http://61.58.60.230:9319/live/123.m3u8',
    stream_type: 'hls',
    source_name: '國會頻道 1 台（經 IPTV 清單轉載）',
    source_website: 'https://github.com/peakzheng1112/iptv2025/blob/main/iptv.m3u',
    authorization_status: 'user_provided',
    is_active: true,
    last_checked: NOW,
    description:
      '國會議事轉播頻道 1。2026-11-22 第 2 輪新增。' +
      'segment 首位 0x47（MPEG-TS），來源回傳 Access-Control-Allow-Origin: *。',
    tags: ['台灣', '國會', '立法院', '公共', 'iptv'],
    region: '台灣',
    cors_enabled: true,
    http_referrer: null,
    notes:
      '身分證據取自同一份上游清單（peakzheng1112/iptv2025 第 45–46 行）的名稱↔網址配對：' +
      '「國會頻道1台」↔`61.58.60.230:9319/live/123.m3u8`。',
    playlist_source: {
      provider: 'iptv2025',
      provider_label: 'IPTV 公開清單',
      provider_url: 'https://github.com/peakzheng1112/iptv2025/blob/main/iptv.m3u',
      raw_channel_name: '國會頻道1台',
      backup_urls: [],
    },
  },
  {
    channel_id: 'tw-legislature-2',
    channel_name: '國會頻道 2 台',
    name_en: 'Legislature Channel 2',
    category: 'public',
    channel_number: null,
    logo: null,
    stream_url: 'http://61.58.60.230:9319/live/124.m3u8',
    stream_type: 'hls',
    source_name: '國會頻道 2 台（經 IPTV 清單轉載）',
    source_website: 'https://github.com/peakzheng1112/iptv2025/blob/main/iptv.m3u',
    authorization_status: 'user_provided',
    is_active: true,
    last_checked: NOW,
    description:
      '國會議事轉播頻道 2。2026-11-22 第 2 輪新增。' +
      'segment 首位 0x47（MPEG-TS），來源回傳 Access-Control-Allow-Origin: *。',
    tags: ['台灣', '國會', '立法院', '公共', 'iptv'],
    region: '台灣',
    cors_enabled: true,
    http_referrer: null,
    notes:
      '身分證據取自同一份上游清單（peakzheng1112/iptv2025 第 47–48 行）的名稱↔網址配對：' +
      '「國會頻道2台」↔`61.58.60.230:9319/live/124.m3u8`。',
    playlist_source: {
      provider: 'iptv2025',
      provider_label: 'IPTV 公開清單',
      provider_url: 'https://github.com/peakzheng1112/iptv2025/blob/main/iptv.m3u',
      raw_channel_name: '國會頻道2台',
      backup_urls: [],
    },
  },
];

for (const nc of NEW_CHANNELS) {
  if (byId.has(nc.channel_id)) {
    console.log(`• ${nc.channel_name}（${nc.channel_id}）已存在，跳過新增`);
    continue;
  }
  if (data.channels.some((c) => c.channel_name === nc.channel_name)) {
    console.log(`• ${nc.channel_name} 已存在同名頻道，跳過新增`);
    continue;
  }
  data.channels.push(nc);
  byId.set(nc.channel_id, nc);
  changes.push(`新增：${nc.channel_name} → ${nc.stream_url}`);
}

data.updated_at = NOW;

writeFileSync(CHANNELS_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
console.log('已完成處置：');
for (const c of changes) console.log('  · ' + c);
console.log(`頻道總數：${data.channels.length}`);
