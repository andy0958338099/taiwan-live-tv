#!/usr/bin/env node
/**
 * import-supertv-candidates.mjs — 匯入「經目視驗證」的候選來源
 *
 * ## 為什麼要目視驗證
 *
 * 位元組層級驗證（MPEG-TS 0x47 / fMP4 ftyp）**不足以**判定一個來源可用。
 *
 * 實測（2026-11-22）：`epg.pw` 的多個來源（緯來體育、鳳凰衛視中文台）
 * 通過了全部位元組檢查、manifest 也是活的，**但畫面是 IPTV App 的
 * 「NO SIGNAL 佔位畫面」** —— 使用者看到的是一張藍底插畫，不是節目。
 *
 * 這正是專案原則「不得將無效串流假裝成正常播放」要擋的情況。
 * 所以本匯入器只接受**真的播出畫面、且台標與頻道名相符**的來源。
 *
 * 目視驗證：`scripts/verify-channel-visually.mjs`（會截圖）
 *
 * ## 用法
 *
 *   node scripts/import-supertv-candidates.mjs            # 套用
 *   node scripts/import-supertv-candidates.mjs --dry-run  # 只看差異
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DRY = process.argv.includes('--dry-run');

const CATALOG_PATH = join(ROOT, 'shared', 'channels.json');

/**
 * 已目視驗證通過的新頻道。
 *
 * `verified` 欄位記錄驗證方式與結果，讓後續維護者知道這些不是「猜的」。
 */
const NEW_CHANNELS = [
  {
    channel_id: 'tw-etv-super',
    channel_name: '東森超視',
    category: 'general',
    channel_number: 32,           // 32 是目前台灣區最小的空號
    logo: 'https://www.xn--rgv465a.top/tvlogo/%E4%B8%9C%E6%A3%AE%E8%B6%85%E8%A7%86.png',
    stream_url: 'http://38.64.72.148:80/hls/modn/list/2013/chunklist1.m3u8',
    source_name: '東森超視（自有 HLS 伺服器）',
    source_website: 'http://38.64.72.148:80/hls/modn/list/2013/chunklist1.m3u8',
    authorization_status: 'public_official',
    region: '台灣',
    cors_enabled: true,
    tags: ['台灣', 'official', '東森'],
    description: '東森超視（ETTV 超視 945）。目視驗證：畫面右上角台標為「超視 945」，內容為實際節目。',
    notes:
      '來源為廣播商自己的 HLS 伺服器（同一台 38.64.72.148 也提供 TVBS Asia）。' +
      '目視驗證 2026-11-22：1920x1080，台標「超視 945」。',
    verified: '2026-11-22 目視驗證：台標「超視 945」✓',
  },
  {
    channel_id: 'cn-cctv-billiards',
    channel_name: '央視台球',
    // 沒有 sports 類別；體育類頻道在專案裡一律歸 entertainment
    // （見 央視-5 體育、廣東體育台）。分類是使用者找頻道的依據，
    // 跟既有慣例一致比新增一個分類好。
    category: 'entertainment',
    channel_number: 155,          // 中國區目前空號
    logo: null,
    stream_url: 'http://107.150.60.122/live/ystq.m3u8',
    source_name: '央視台球（IPTV 轉載）',
    source_website: 'http://107.150.60.122/live/ystq.m3u8',
    authorization_status: 'user_provided',
    region: '中國',
    cors_enabled: false,
    tags: ['中國', '央視', '體育'],
    description: '央視台球（CCTV 央視台球）。目視驗證：左上角台標「CCTV 央視台球」，內容為斯諾克／桌球賽事。',
    notes:
      '第三方 IPTV 轉載（非央視官方 CDN），散布權未確認 → user_provided。' +
      '目視驗證 2026-11-22：1920x1080，台標「CCTV 央視台球」✓。',
    verified: '2026-11-22 目視驗證：台標「CCTV 央視台球」✓',
  },
];

/**
 * 要附加到**既有頻道**的備援來源。
 *
 * ⚠️ 每個都必須是「同一個頻道」，且已目視驗證台標相符。
 */
const NEW_BACKUPS = [
  {
    channel_name: '鳳凰衛視資訊台',
    url: 'http://r.jdshipin.com/0Rp07',
    source: 'jdshipin 轉載（目視驗證：Phoenix HD 台標 + 鳳凰衛視資訊台天氣預報）',
    cors: false,
  },
  {
    channel_name: '鳳凰衛視中文台',
    url: 'http://r.jdshipin.com/yDoTN',
    source: 'jdshipin 轉載（目視驗證：台標「香港台」+ 軍情室新聞節目）',
    cors: false,
  },
  {
    channel_name: '內蒙古衛視',
    url: 'http://play1-qk.nmtv.cn/live/1769652018126032.m3u8',
    source: '內蒙古電視台官方 CDN（NNTV，目視驗證：台標「NNTV 內蒙」）',
    cors: true,
  },
];

/**
 * **拒絕**的來源（附原因，留在程式裡避免日後重蹈覆轍）。
 */
const REJECTED = [
  {
    url: 'https://epg.pw/stream/…',
    reason:
      '通過位元組驗證但畫面是「NO SIGNAL」佔位畫面（IPTV App 的插圖）。' +
      '緯來體育、鳳凰衛視中文台都屬於這一類 → 不可上線。',
  },
  {
    url: 'https://files.catbox.moe/zyat7k.m3u',
    reason:
      'LITV-GO 中繼：manifest 是活的，但 segment 指向 ntd-tgc.cdn.hinet.net，' +
      '該主機名在公共 DNS 全部 NXDOMAIN → segment 無法下載。',
  },
  {
    url: 'http://220.134.196.147:*/…',
    reason: 'SuperTV 內嵌的 74 個頻道，主機所有 port 都 ECONNREFUSED。',
  },
  {
    url: 'https://tencentplay.gztv.com/live/zonghes.m3u8',
    reason: '廣州電視台官方，但 Chrome 播出後只有黑畫面（decode error）。',
  },
  {
    url: 'https://event.pull.hebtv.com/live/live101.m3u8',
    reason: '河北衛視官方，但 3840x2160 串流在 Chrome 只出黑畫面（decode error）。',
  },
  {
    url: 'http://hlsal-ldvt.qing.mgtv.com/…',
    reason: '湖南衛視官方（Mango TV），但 token 已過期 → HTTP 403。',
  },
  {
    url: 'https://smart.pendy.dpdns.org/Smart.php?id=…',
    reason: 'Judy 直播源的中繼主機，連線失敗（HTTP 000）。',
  },
  {
    url: 'https://ls.qingting.fm/live/4972|4974/64k.m3u8',
    reason:
      '蜻蜓FM 的黑龍江少兒／新聞：segment 位元組正確，但 URL 是「協定相對」的' +
      '（//ls-hw-ot.qtfm.cn/…），hls.js 載入後回「no supported source was found」→ 播不出。',
  },
  {
    url: 'http://r.jdshipin.com/NfC0f',
    reason: '未通過目視驗證（同家族其他代碼已通過），先不匯入。',
  },
];

// ── 執行 ──
const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
const channels = catalog.channels;
const now = new Date().toISOString();

const byName = new Map(channels.map((c) => [c.channel_name, c]));
let added = 0;
let backupAdded = 0;

console.log('═══ 新增頻道 ═══');
for (const n of NEW_CHANNELS) {
  if (byName.has(n.channel_name)) {
    console.log(`  ⓘ 已存在，略過：${n.channel_name}`);
    continue;
  }
  if (channels.some((c) => c.channel_number === n.channel_number)) {
    console.log(`  ✗ 號碼 ${n.channel_number} 已被占用，略過：${n.channel_name}`);
    continue;
  }
  const entry = {
    channel_id: n.channel_id,
    channel_name: n.channel_name,
    name_en: null,
    category: n.category,
    channel_number: n.channel_number,
    logo: n.logo,
    stream_url: n.stream_url,
    stream_type: 'hls',
    source_name: n.source_name,
    source_website: n.source_website,
    authorization_status: n.authorization_status,
    is_active: true,
    last_checked: now,
    description: n.description,
    tags: n.tags,
    region: n.region,
    cors_enabled: n.cors_enabled,
    http_referrer: null,
    notes: n.notes,
    playlist_source: {
      provider: 'guovin',
      provider_label: 'Guovin/iptv-api（GitHub 公開清單）',
      provider_url: 'https://raw.githubusercontent.com/Guovin/iptv-api/gd/output/result.m3u',
      raw_channel_name: n.channel_name,
      backup_urls: [],
    },
  };
  if (!DRY) channels.push(entry);
  byName.set(n.channel_name, entry);
  added++;
  console.log(`  ✓ ${n.channel_name.padEnd(12)} #${n.channel_number}  ${n.stream_url}`);
  console.log(`      ${n.verified}`);
}

console.log('\n═══ 附加備援來源 ═══');
for (const b of NEW_BACKUPS) {
  const ch = byName.get(b.channel_name);
  if (!ch) {
    console.log(`  ✗ 找不到頻道：${b.channel_name}`);
    continue;
  }
  const ps = (ch.playlist_source ??= { provider: '', provider_label: '', provider_url: '', raw_channel_name: ch.channel_name, backup_urls: [] });
  ps.backup_urls ??= [];
  if (ps.backup_urls.some((x) => x.url === b.url)) {
    console.log(`  ⓘ 已存在：${b.channel_name} ← ${b.url}`);
    continue;
  }
  if (!DRY) ps.backup_urls.push({ url: b.url, source: b.source, cors: b.cors });
  backupAdded++;
  console.log(`  ✓ ${b.channel_name.padEnd(12)} ← ${b.url}`);
  console.log(`      ${b.source}`);
}

console.log('\n═══ 已拒絕的來源（記錄原因，避免日後重蹈覆轍）═══');
for (const r of REJECTED) console.log(`  ✗ ${r.url}\n      ${r.reason}`);

if (!DRY) {
  catalog.updated_at = now;
  writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + '\n');
  console.log(`\n✅ 已寫入 ${CATALOG_PATH}`);
  console.log(`   新增頻道 ${added} 個、附加備援 ${backupAdded} 個、總頻道 ${channels.length} 個`);
} else {
  console.log(`\n（dry-run，未寫入）新增頻道 ${added} 個、附加備援 ${backupAdded} 個`);
}
