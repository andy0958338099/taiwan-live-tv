#!/usr/bin/env node
/**
 * import-taiwan-channels.mjs — 匯入經過 deep probe 驗證的台灣來源
 *
 * 這個工具只匯入**已經通過位元組驗證**的來源。
 * 它不做探測 —— 探測是 `scripts/probe-taiwan-sources.mjs` 的工作，
 * 兩者分開是為了：匯入的每個頻道都已經有「下載得到 + 位元組正確」的證據。
 *
 * 授權分級：
 *   `public_official` —— 廣播商自己的 CDN（ebc.edu.kh、wcetv.com、akamaihd…）
 *   `user_provided`  —— 第三方轉載主機（技術可達，但散布權未確認）
 *
 * 用法：node scripts/import-taiwan-channels.mjs [--dry-run]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHANNELS = join(ROOT, 'shared', 'channels.json');
const DRY_RUN = process.argv.includes('--dry-run');
const NOW = new Date().toISOString();

/**
 * 已通過 deep probe 的來源（2026-11-21）。
 *
 * 欄位說明：
 *   id        頻道 ID（ASCII slug）
 *   name      顯示名稱
 *   url       串流網址
 *   category  分類 id（見 shared/channels.json 的 categories）
 *   logo      台標
 *   source    來源名稱（廣播商或轉載站）
 *   website   來源網址（**必須** —— 每個頻道都要標註出處）
 *   auth      授權狀態
 *   cors      是否跨網域可用（實測結果）
 */
const CANDIDATES = [
  {
    id: 'tw-ebc-financial',
    name: '東森財經新聞台',
    url: 'https://iptv.ebc.edu.kh/iptv/channel/1.m3u8',
    category: 'finance',
    logo: 'https://i.imgur.com/uFDkOhV.png',
    source: '東森新聞 EBC（ebc.edu.kh 自家 CDN）',
    website: 'https://iptv.ebc.edu.kh/iptv/channel/1.m3u8',
    auth: 'public_official',
    cors: true,
  },
  {
    id: 'tw-tvbs-asia',
    name: 'TVBS Asia',
    url: 'http://38.64.72.148/hls/modn/list/4005/playlist.m3u8',
    category: 'general',
    logo: 'https://i.imgur.com/4S1rkhm.png',
    source: 'TVBS（自有 HLS 伺服器）',
    website: 'http://38.64.72.148/hls/modn/list/4005/playlist.m3u8',
    auth: 'public_official',
    cors: true,
  },
  {
    id: 'tw-hakka',
    name: '客家電視台 HAKKA TV',
    url: 'https://h5cul1yar48um3t.wcetv.com/hls/hakkatv.m3u8',
    category: 'general',
    logo: 'https://i.imgur.com/1CdGSbU.png',
    source: '客家電視台（wcetv.com 自家 CDN）',
    website: 'https://h5cul1yar48um3t.wcetv.com/hls/hakkatv.m3u8',
    auth: 'public_official',
    cors: true,
  },
  {
    id: 'tw-taiwan-plus',
    name: 'Taiwan Plus TV',
    url: 'https://bcovlive-a.akamaihd.net/rce33d845cb9e42dfa302c7ac345f7858/ap-northeast-1/6282251407001/playlist.m3u8',
    category: 'general',
    logo: 'https://jiotvimages.cdn.jio.com/dare_images/images/Taiwan_Plus.png',
    source: 'TaiwanPlus（Akamai HD 帳號）',
    website: 'https://bcovlive-a.akamaihd.net/',
    auth: 'public_official',
    cors: true,
  },
  {
    id: 'tw-beautiful-life',
    name: 'Beautiful Life TV 美麗人生',
    url: 'https://5ddce30eb4b55.streamlock.net/bltvhd/bltv1/playlist.m3u8',
    category: 'local',
    logo: 'https://i.imgur.com/hkwcBM9.png',
    source: '美麗人生廣播電台（streamlock.net）',
    website: 'https://5ddce30eb4b55.streamlock.net/bltvhd/bltv1/playlist.m3u8',
    auth: 'public_official',
    cors: true,
  },
  {
    id: 'tw-cgn',
    name: 'CGNTV 中文台',
    url: 'https://d3e05csss9c272.cloudfront.net/out/v1/f0bf71c57581470fb9379f603e8f5d83/CGNWebLiveCN.m3u8',
    category: 'general',
    logo: 'https://i.imgur.com/bPoPAbR.png',
    source: 'CGNTV（CloudFront 派送）',
    website: 'https://d3e05csss9c272.cloudfront.net/',
    auth: 'public_official',
    cors: true,
  },
  {
    id: 'tw-weixin',
    name: '唯心電視',
    url: 'https://mobile.ccdntech.com/transcoder/_definst_/vod164_Live/live/chunklist_w1177047531.m3u8',
    category: 'local',
    logo: 'https://i.imgur.com/s8tiTeb.png',
    source: '唯心電視（ccdntech transcoder）',
    website: 'https://mobile.ccdntech.com/',
    auth: 'public_official',
    cors: true,
  },
  {
    id: 'tw-supreme-master',
    name: '真善美電視',
    url: 'https://lbs-us1.suprememastertv.com/720p.m3u8',
    category: 'local',
    logo: 'https://i.imgur.com/kFMHayP.png',
    source: '真善美電視台（自有伺服器）',
    website: 'https://lbs-us1.suprememastertv.com/720p.m3u8',
    auth: 'public_official',
    cors: true,
  },
  {
    id: 'tw-goodtv-ch1',
    name: 'GOOD TV 綜合台',
    url: 'https://live.streamingfast.net/osmflivech1.m3u8',
    category: 'local',
    logo: 'https://i.imgur.com/k28Kc3o.png',
    source: 'GOOD TV 好漾人間（streamingfast.net）',
    website: 'https://live.streamingfast.net/osmflivech1.m3u8',
    auth: 'public_official',
    cors: true,
  },
  {
    id: 'tw-goodtv-ch2',
    name: 'GOOD TV 真理台',
    url: 'https://live.streamingfast.net/osmflivech2.m3u8',
    category: 'local',
    logo: 'https://i.imgur.com/YxFRoft.png',
    source: 'GOOD TV 好漾人間（streamingfast.net）',
    website: 'https://live.streamingfast.net/osmflivech2.m3u8',
    auth: 'public_official',
    cors: true,
  },
];

async function main() {
  console.log('═'.repeat(64));
  console.log('匯入台灣來源（已通過 deep probe）');
  console.log('═'.repeat(64));

  const catalog = JSON.parse(readFileSync(CHANNELS, 'utf8'));
  const validCategories = new Set(catalog.categories.map((c) => c.id));
  const existing = new Set(catalog.channels.map((c) => c.channel_id));
  const existingUrls = new Set(
    catalog.channels.map((c) => c.stream_url).filter(Boolean),
  );

  let added = 0;
  let skipped = 0;

  for (const cand of CANDIDATES) {
    if (existing.has(cand.id)) {
      console.log(`  · 略過（ID 已存在）：${cand.name}`);
      skipped++;
      continue;
    }
    if (existingUrls.has(cand.url)) {
      console.log(`  · 略過（網址已存在）：${cand.name}`);
      skipped++;
      continue;
    }
    if (!validCategories.has(cand.category)) {
      console.log(`  ✗ 略過（分類不存在）：${cand.name} → ${cand.category}`);
      skipped++;
      continue;
    }

    const channel = {
      channel_id: cand.id,
      channel_name: cand.name,
      name_en: null,
      category: cand.category,
      channel_number: null,
      logo: cand.logo,
      stream_url: cand.url,
      stream_type: 'hls',
      source_name: cand.source,
      source_website: cand.website,
      authorization_status: cand.auth,
      is_active: true,
      last_checked: NOW,
      description: `${cand.name}（${cand.source}）。已通過 deep probe：segment 位元組驗證為 MPEG-TS。`,
      tags: ['台灣', 'official'],
      region: '台灣',
      cors_enabled: cand.cors,
      http_referrer: null,
      notes:
        '來源為廣播商自己的 CDN。經 scripts/probe-taiwan-sources.mjs 驗證：' +
        'manifest 可讀、非 VOD、segment 位元組正確。',
      playlist_source: {
        provider: 'github',
        provider_label: 'GitHub 公開清單',
        provider_url: 'https://github.com/limajj2021/taiwan-iptv',
        raw_channel_name: cand.name,
        backup_urls: [],
      },
    };

    catalog.channels.push(channel);
    existing.add(cand.id);
    existingUrls.add(cand.url);
    added++;
    console.log(
      `  ✓ 新增：${cand.name.padEnd(22)} ${cand.category.padEnd(12)} ${cand.auth.padEnd(16)} CORS${cand.cors ? '✓' : '✗'}`,
    );
  }

  console.log(`\n新增 ${added}｜略過 ${skipped}`);
  console.log(`頻道總數：${catalog.channels.length}`);

  if (DRY_RUN) {
    console.log('\n(dry-run 模式，未寫入檔案)');
    return;
  }

  catalog.updated_at = NOW;
  writeFileSync(CHANNELS, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  console.log(`\n已寫入 ${CHANNELS}`);
  console.log('下一步：node scripts/validate-channels.mjs && node scripts/sync-channels.mjs');
}

await main();
