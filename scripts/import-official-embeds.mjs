#!/usr/bin/env node
/**
 * import-official-embeds.mjs — 匯入「官方明確允許嵌入」的來源
 *
 * 這些來源經過實際查證（見 docs/06-official-sources-research.md）：
 *   - 官方直播頁本身就是以 iframe 內嵌該播放器
 *   - 該播放器端點回應「無 X-Frame-Options」「無 CSP frame-ancestors 限制」
 *   → 等同官方已默許第三方嵌入，屬授權狀態 A（public_official）
 *
 * 與 import-playlists.mjs 的差異：
 *   - 這裡的來源是「官方自有」而非第三方轉載清單
 *   - 播放方式是 iframe 嵌入，不是直接抓 HLS
 *
 * 用法：node scripts/import-official-embeds.mjs [--dry-run]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHANNELS_PATH = join(ROOT, 'shared', 'channels.json');

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * 官方嵌入來源清單。
 *
 * 每筆都必須有查證依據（見 docs/06-official-sources-research.md 的「第三節」）。
 * 授權狀態一律為 public_official。
 *
 * 注意：YouTube 直播 ID 會隨直播場次輪替，實作時應於執行期從
 * 各台官方 YouTube 頻道的 /streams 分頁取當前 ID，不應寫死舊 ID。
 * 這裡記錄的是 2026-11-19 查證當日的實測值。
 *
 * `supersedes` 對應到播放清單匯入的同名頻道 —— 官方嵌入來源優先，
 * 因為它是業者自有且明��允許嵌入，授權狀態優於第三方轉載清單。
 */
const OFFICIAL_EMBEDS = [
  {
    channel_id: 'cts-news-52',
    channel_name: '華視新聞 CH52',
    category: 'news',
    embed_url: 'https://www.youtube.com/embed/wM0g8EoUZ_E?rel=0&autoplay=1&mute=1',
    source_name: '華視新聞網（官方直播頁以 YouTube 播放器嵌入）',
    source_website: 'https://news.cts.com.tw/live',
    description: '華視新聞 CH52 24 小時直播。官方直播頁即以此 iframe 呈現。',
    tags: ['華視', 'CTS', '新聞', 'youtube-embed'],
    notes:
      '官方頁面本身有 x-frame-options: SAMEORIGIN，但內嵌的 YouTube 播放器可用（playableInEmbed=true）。直播 ID 會隨場次輪替。',
  },
  {
    channel_id: 'cti-news-52',
    channel_name: '中天新聞 CH52',
    category: 'news',
    embed_url: 'https://www.youtube.com/embed/vr3XyVCR4T0?rel=0&autoplay=1&mute=1',
    source_name: '中天電視（官方首頁以 YouTube 播放器嵌入）',
    source_website: 'https://www.ctitv.com.tw/',
    description: '中天新聞 24 小時直播。ctitv.com.tw 首頁即以此 iframe 呈現。',
    tags: ['中天', 'CTI', '新聞', 'youtube-embed'],
    supersedes: ['中天 CTI'],
    notes: 'playableInEmbed=true。直播 ID 會隨場次輪替。',
  },
  {
    channel_id: 'mnews-24h',
    channel_name: '鏡新聞 24H',
    category: 'news',
    embed_url: 'https://www.youtube.com/embed/5n0y6b0Q25o?rel=0&autoplay=1&mute=1',
    source_name: '鏡新聞（官方首頁以 YouTube 播放器嵌入）',
    source_website: 'https://www.mnews.tw/',
    description: '鏡新聞 24 小時直播。mnews.tw 首頁即以此 iframe 呈現。',
    tags: ['鏡新聞', '新聞', 'youtube-embed'],
    notes: 'playableInEmbed=true。直播 ID 會隨場次輪替。',
  },
  {
    channel_id: 'ctv-news',
    channel_name: '中視新聞台',
    category: 'news',
    embed_url: 'https://www.youtube.com/embed/TCnaIE_SAtM?rel=0&autoplay=1&mute=1',
    source_name: '中視新聞網（官方 YT 頻道 @twctvnews 現行直播）',
    source_website: 'https://www.ctv.com.tw/',
    description: '中視新聞台直播。取自中視官方 YouTube 頻道目前直播場次。',
    tags: ['中視', 'CTV', '新聞', 'youtube-embed'],
    notes: 'playableInEmbed=true。直播 ID 會隨場次輪替，應於執行期更新。',
  },
  {
    channel_id: 'ebc-news-51',
    channel_name: '東森新聞 CH51',
    category: 'news',
    embed_url:
      'https://player.svc.litv.tv/v3/ppnif.html?s=ZWJjbmV3c2NoX2hvbWVfd2Vi&ap=1',
    source_name: '東森新聞 CH51（官方頁以 litv 播放器嵌入，並以 embedUrl 宣告）',
    source_website: 'https://news.ebc.net.tw/video',
    description: '東森新聞 51 頻道 24 小時線上直播。官方頁面以 schema.org embedUrl 宣告此播放器。',
    tags: ['東森', 'ETTV', '新聞', 'litv-embed'],
    supersedes: ['東森 ETTV'],
    notes:
      'litv 播放器端點無 X-Frame-Options、無 CSP frame-ancestors 限制，等同官方默許嵌入。',
  },
  {
    channel_id: 'setn-news-54',
    channel_name: '三立新聞台 CH54',
    category: 'news',
    embed_url:
      'https://player.svc.litv.tv/v3/ppnif.html?s=c2V0bmNoX3dlYg==&c=setnewsrtmp&t=CH54%E4%B8%89%E7%AB%8B%E6%96%B0%E8%81%9E%E5%8F%B0%E7%9B%B4%E6%92%AD',
    source_name: '三立新聞台 CH54（官方首頁以 litv 播放器嵌入）',
    source_website: 'https://www.setn.com/',
    description: 'CH54 三立新聞台直播。setn.com 首頁即以此 iframe 呈現。',
    tags: ['三立', 'SET', '新聞', 'litv-embed'],
    supersedes: ['三立 SET'],
    notes: 'litv 播放器端點無 frame 限制。',
  },
  {
    channel_id: 'hakka-tv',
    channel_name: '客家電視台',
    category: 'public',
    embed_url: 'https://embed.4gtv.tv/hakka/hakkatv.html',
    source_name: '客家電視（官方直播頁以 4gTV 播放器嵌入）',
    source_website: 'https://www.hakkatv.org.tw/live',
    description: '客家電視台直播。官方直播頁即以此 iframe 呈現。',
    tags: ['客家', '公共', '4gtv-embed'],
    notes:
      '4gTV 服務條款禁止商業轉載，僅限非商業個人使用；embed 端點 ACAO:* 且無 frame 限制。',
  },
  {
    channel_id: 'daai-tv-global',
    channel_name: '大愛電視（全球）',
    category: 'education',
    embed_url: 'https://www.youtube.com/embed/MIqUplvSRWA?rel=0&autoplay=1&mute=1',
    source_name: '大愛電視（官方頁以 YouTube 播放器嵌入）',
    source_website: 'https://m.daai.tv/v3/live',
    description: '大愛電視全球直播。官方頁面即以 YouTube iframe 呈現。',
    tags: ['大愛', '教育', 'youtube-embed'],
    notes:
      'playableInEmbed=true。另有台灣專用 ID（oV_i3Hsl_zg），大愛 HLS manifest 另有 referer 白名單限制。',
  },
  {
    channel_id: 'globalnews-taiwan',
    channel_name: '寰宇新聞台灣台',
    category: 'education',
    embed_url: 'https://www.youtube.com/embed/w87VGpgd90U?rel=0&autoplay=1&mute=1',
    source_name: '寰宇新聞（官方 YT 直播）',
    source_website: 'https://globalnewstv.com.tw/',
    description: '寰宇新聞台灣台直播。',
    tags: ['寰宇', '教育', 'youtube-embed'],
    notes: 'playableInEmbed=true。直播 ID 會隨場次輪替。',
  },
  {
    channel_id: 'pts-network-live',
    channel_name: '公視網路直播',
    category: 'public',
    embed_url: 'https://www.youtube.com/embed/C6gYqSHLRw4?rel=0&autoplay=1&mute=1',
    source_name: '公共電視（官方 YouTube 頻道「公視 網路直播頻道」）',
    source_website: 'https://www.pts.org.tw/',
    description: '公視網路直播頻道（YouTube 官方直播）。',
    tags: ['公視', 'PTS', '公共', 'youtube-embed'],
    supersedes: ['公共電視 PTS'],
    notes:
      'ptsplus.tv 站內直播需登入且服務條款禁止未經同意的公開播送；改用官方 YouTube 頻道。playableInEmbed=true。',
  },
];

function main() {
  const data = JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'));
  const existing = new Set(data.channels.map((c) => c.channel_id));

  let added = 0;
  let skipped = 0;
  let superseded = 0;

  console.log('═'.repeat(64));
  console.log('匯入官方允許嵌入的來源');
  console.log('═'.repeat(64));
  console.log('');

  // 先處理 supersedes：移除被官方嵌入來源取代的播放清單版本
  for (const e of OFFICIAL_EMBEDS) {
    if (!e.supersedes) continue;
    const before = data.channels.length;
    data.channels = data.channels.filter((c) => !e.supersedes.includes(c.channel_name));
    const removed = before - data.channels.length;
    if (removed > 0) {
      console.log(`  ⇄ 取代 ${e.supersedes.join('、')}（第三方轉載 → 官方嵌入）`);
      superseded += removed;
    }
  }

  for (const e of OFFICIAL_EMBEDS) {
    if (existing.has(e.channel_id)) {
      console.log(`  ↻ 已存在：${e.channel_name}`);
      skipped++;
      continue;
    }

    const channel = {
      channel_id: e.channel_id,
      channel_name: e.channel_name,
      name_en: null,
      category: e.category,
      channel_number: null,
      logo: null,
      // 這類來源以 iframe 嵌入官方播放器，stream_url 保留為空字串
      // （validate-channels.mjs 允許 embed_url 形式的來源）
      stream_url: '',
      stream_type: 'embed',
      source_name: e.source_name,
      source_website: e.source_website,
      authorization_status: 'public_official',
      is_active: true,
      last_checked: new Date().toISOString(),
      description: e.description,
      tags: e.tags,
      region: '台灣',
      cors_enabled: true,
      http_referrer: null,
      notes: e.notes,
      embed_url: e.embed_url,
    };

    data.channels.push(channel);
    existing.add(e.channel_id);
    added++;
    console.log(`  + ${e.channel_name}（${e.category}）`);
  }

  console.log('');
  console.log(
    `新增 ${added} 個｜取代 ${superseded} 個｜已存在 ${skipped} 個｜總頻道 ${data.channels.length}`,
  );

  if (DRY_RUN) {
    console.log('\n(dry-run 模式，未寫入檔案)');
    return;
  }

  data.updated_at = new Date().toISOString();
  writeFileSync(CHANNELS_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`\n✓ 已寫入 ${CHANNELS_PATH}`);
  console.log('\n下一步：node scripts/validate-channels.mjs && node scripts/sync-channels.mjs');
}

main();
