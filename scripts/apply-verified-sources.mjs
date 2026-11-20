#!/usr/bin/env node
/**
 * apply-verified-sources.mjs — 套用深度探測結果，修復並擴充頻道清單
 *
 * 背景：
 *   這批 IPTV 來源是「manifest → child manifest → segment」三層結構。
 *   同一批 path 的上游 host 會整批失效（例如 smt.1678520.xyz 全部 502），
 *   導致 manifest 本身讀得到、但實際播不出來。
 *
 * 本腳本做三件事：
 *   1. **移除完全失效的頻道** —— 探測結果顯示上游已死的，直接下架
 *   2. **更新主／備援網址** —— 改用探測驗證過的 child manifest
 *   3. **補上先前漏掉的頻道** —— cdn-paths 中已驗證可播但不在清單內的
 *
 * 用法：node scripts/apply-verified-sources.mjs [--dry-run]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHANNELS_PATH = join(ROOT, 'shared', 'channels.json');
const PROBE_PATH = join(ROOT, 'shared', 'cdn-paths.json');

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * 需要移除的頻道 —— 探測確認上游已完全失效。
 *
 * 緯來（wlxj / wlty）與 龍祥（lxsd）的 child host 是 smt.1678520.xyz，
 * 該 host 全部回 502，且已確認沒有其他可用的替代 host。
 */
const REMOVE_CHANNEL_IDS = new Set([
  'playlist-緯來-緯來',
  'playlist-龍祥-龍祥',
]);

/**
 * cdn-paths 中額外納入的頻道。
 *
 * 這些都經過 deep probe（manifest → child → segment 位元組驗證），
 * 且是正規的電視台直播，不是 VOD 預覽片段。
 */
const EXTRA_CHANNELS = [
  {
    path: 'fhhk',
    channel_id: 'cn-fhhk',
    channel_name: '鳳凰衛視香港台',
    category: 'general',
    region: '中國香港',
    description: '鳳凰衛視香港台 — 中國香港頻道，來源為使用者提供的 IPTV 清單轉載',
  },
  {
    path: 'fhzw',
    channel_id: 'cn-fhzw',
    channel_name: '鳳凰衛視中文台',
    category: 'general',
    region: '中國香港',
    description: '鳳凰衛視中文台 — 中國香港頻道，來源為使用者提供的 IPTV 清單轉載',
  },
  {
    path: 'fhzx',
    channel_id: 'cn-fhzx',
    channel_name: '鳳凰衛視資訊台',
    category: 'news',
    region: '中國香港',
    description: '鳳凰衛視資訊台 — 中國香港頻道，來源為使用者提供的 IPTV 清單轉載',
  },
  {
    path: 'gdty',
    channel_id: 'cn-gdty',
    channel_name: '廣東體育台',
    category: 'entertainment',
    region: '中國廣東',
    description: '廣東體育台 — 中國廣東頻道，來源為使用者提供的 IPTV 清單轉載',
  },
  {
    path: 'gdzj',
    channel_id: 'cn-gdzj',
    channel_name: '廣東珠江台',
    category: 'general',
    region: '中國廣東',
    description: '廣東珠江台 — 中國廣東頻道，來源為使用者提供的 IPTV 清單轉載',
  },
  {
    path: 'gzzh',
    channel_id: 'cn-gzzh',
    channel_name: '廣州綜合台',
    category: 'local',
    region: '中國廣東',
    description: '廣州綜合台 — 中國廣州頻道，來源為使用者提供的 IPTV 清單轉載',
  },
  {
    path: 'gzxw',
    channel_id: 'cn-gzxw',
    channel_name: '廣州新聞台',
    category: 'news',
    region: '中國廣東',
    description: '廣州新聞台 — 中國廣州頻道，來源為使用者提供的 IPTV 清單轉載',
  },
  {
    path: 'ngds',
    channel_id: 'cn-ngds',
    channel_name: '廣州南國都市台',
    category: 'local',
    region: '中國廣東',
    description: '廣州南國都市台 — 中國廣州頻道，來源為使用者提供的 IPTV 清單轉載',
  },
  {
    path: 'hxws',
    channel_id: 'cn-hxws',
    channel_name: '海峽衛視',
    category: 'local',
    region: '中國福建',
    description: '海峽衛視 — 中國福建頻道，來源為使用者提供的 IPTV 清單轉載',
  },
];

function main() {
  const catalog = JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'));
  const probe = JSON.parse(readFileSync(PROBE_PATH, 'utf8'));

  const byPath = new Map(probe.paths.map((p) => [p.path, p]));
  const failedByPath = new Map(probe.failed.map((f) => [f.path, f]));

  console.log('═'.repeat(70));
  console.log('套用深度探測結果');
  console.log('═'.repeat(70));

  // ---- 步驟 1：移除失效頻道 ----
  let removed = 0;
  catalog.channels = catalog.channels.filter((c) => {
    if (REMOVE_CHANNEL_IDS.has(c.channel_id)) {
      console.log(`  ✗ 移除 ${c.channel_name}（${c.channel_id}）— 上游已完全失效`);
      removed++;
      return false;
    }
    return true;
  });

  // ---- 步驟 2：更新主／備援網址 ----
  let repaired = 0;
  let stillBroken = [];

  for (const c of catalog.channels) {
    const m = c.stream_url?.match(/\/163189\/([a-zA-Z0-9]+)/);
    if (!m) continue;
    const path = m[1];

    const good = byPath.get(path);
    const bad = failedByPath.get(path);

    if (good) {
      // 主來源改用驗證過的 child manifest
      // 為什麼要改：cdn.qd.je 的 manifest 本身指向 child host，
      // 若 child host 換了（例如此前的 smt.1678520.xyz 掛掉），
      // 直接用驗證過的 child 網址最穩定。
      const childUrl = good.child_url;
      if (c.stream_url !== childUrl) {
        c.stream_url = childUrl;
        repaired++;
      }
      c.last_checked = probe.probed_at;
      c.cors_enabled = good.cors;
      // 備援：同 path 在其他 host 的可用版本（目前資料集沒有，先保留原有的）
      if (!c.playlist_source) {
        c.playlist_source = {
          provider: 'yang',
          provider_label: 'YanG IPTV 清單',
          provider_url: 'https://iptv.yang-1989.xyz/playlist.m3u',
          raw_channel_name: good.name,
          backup_urls: [],
        };
      }
    } else if (bad) {
      stillBroken.push({
        id: c.channel_id,
        name: c.channel_name,
        path,
        reason: `${bad.stage}:${bad.reason}`,
      });
    }
  }

  if (repaired) console.log(`  ↻ 更新 ${repaired} 個頻道的主來源網址`);

  if (stillBroken.length) {
    console.log(`\n  仍然失效（準備移除）：`);
    for (const s of stillBroken) {
      console.log(`    ✗ ${s.name} (${s.path}) — ${s.reason}`);
    }
    const deadIds = new Set(stillBroken.map((s) => s.id));
    catalog.channels = catalog.channels.filter((c) => !deadIds.has(c.channel_id));
    console.log(`  移除 ${stillBroken.length} 個失效頻道`);
  }

  // ---- 步驟 3：補上漏掉的頻道 ----
  const existingIds = new Set(catalog.channels.map((c) => c.channel_id));
  let added = 0;

  for (const extra of EXTRA_CHANNELS) {
    if (existingIds.has(extra.channel_id)) continue;
    const good = byPath.get(extra.path);
    if (!good) {
      console.log(`  ⚠️ 略過 ${extra.channel_name}（探測結果中找不到 ${extra.path}）`);
      continue;
    }

    catalog.channels.push({
      channel_id: extra.channel_id,
      channel_name: extra.channel_name,
      name_en: null,
      category: extra.category,
      channel_number: null,
      logo: null,
      stream_url: good.child_url,
      stream_type: 'hls',
      source_name: `${extra.channel_name}（經 YanG IPTV 清單轉載）`,
      source_website: 'https://iptv.yang-1989.xyz/playlist.m3u',
      authorization_status: 'user_provided',
      is_active: true,
      last_checked: probe.probed_at,
      description: extra.description,
      tags: ['中國', 'iptv', 'yang'],
      region: extra.region,
      cors_enabled: good.cors,
      http_user_agent: null,
      http_referrer: null,
      notes: '轉載自第三方 IPTV 清單（非廣播商官方來源），授權狀態為使用者提供。',
      playlist_source: {
        provider: 'yang',
        provider_label: 'YanG IPTV 清單',
        provider_url: 'https://iptv.yang-1989.xyz/playlist.m3u',
        raw_channel_name: good.name,
        backup_urls: [
          {
            url: good.url,
            source: 'Yang IPTV 清單（上游入口）',
            cors: good.cors,
          },
        ],
      },
    });
    added++;
    console.log(`  + 新增 ${extra.channel_name}（${good.kind}, ${(good.bytes / 1048576).toFixed(1)}MB）`);
  }

  catalog.updated_at = new Date().toISOString();

  console.log('');
  console.log(`移除 ${removed + stillBroken.length} 個｜更新 ${repaired} 個｜新增 ${added} 個`);
  console.log(`頻道總數：${catalog.channels.length}`);

  if (DRY_RUN) {
    console.log('\n(dry-run 模式，未寫入檔案)');
    return;
  }

  writeFileSync(CHANNELS_PATH, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  console.log(`\n已寫入 ${CHANNELS_PATH}`);
}

main();
