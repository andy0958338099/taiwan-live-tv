#!/usr/bin/env node
/**
 * apply-round1.mjs — 套用第 1 輪巡檢的實測結論
 *
 * 本輪（2026-11-22 09:xx CST）的關鍵實測發現：
 *
 * ## ⭐ 本機直連 ≠ 來源已死（最重要的教訓）
 *
 * 客家電視台 HAKKA TV 的主機 `h5cul1yar48um3t.wcetv.com`：
 *   · 本機直連 → TCP 443 連線逾時（nc 443 FAIL、curl 連續 5 次逾時）
 *   · 正式站代理（Netlify egress IP）→ HTTP 200，序號 525250 → 525468 持續前進
 *
 * 也就是說「本機連不上」只是**我的 IP 被該 CDN 限流**。
 * 若照本機直連結果下架，會把還在播的頻道誤殺。
 * → 因此本輪的判定一律以**正式站代理路徑**為準（那是使用者實際走的路徑）。
 *
 * ## 1. 換源（浙江衛視）
 *    主來源 `http://ali-m-l.cztv.com/channels/lantian/channel001/1080p.m3u8`
 *    序號停在 359977910（已停播，內容雜湊 30 秒不變）。
 *    改用同上游清單（itvlist）名稱↔網址配對確認的同頻道來源：
 *      `http://121.19.134.149:808/tsfile/live/1011_1.m3u8?key=txiptv&playlive=1&authid=0`
 *    （itvlist.m3u 中「浙江卫视」↔ 該網址；代理路徑實測 seq 26072880 前進）
 *
 * ## 2. 換源（天映）
 *    主來源 `https://cdn.qd.je/163189/ccm`（上游名「天映經典『新加坡』」）
 *    序號停在 703、內容雜湊不變 → 已停播。
 *    itvlist 清單中「天映」↔ `http://120.198.95.220:9901/tsfile/live/1043_1.m3u8`
 *    （seq 2034426 → 2034434 前進；與稽核紀錄既有的
 *      「1043_1@120.198.95.220 = 天映」一致）。
 *
 * ## 3. 換源（大愛電視（全球））
 *    原為 YouTube embed。改用大愛官方 CDN：
 *      `https://pull.daaiplus.com/live-DAAIPLUS/live-DAAIPLUS_HD.m3u8`
 *    （daaiplus.com 標題「DAAI+ | Streaming Application」；
 *      CORS `access-control-allow-origin: *` → Web 版免代理；
 *      實測 mpegts / HTTP 206 / seq 1795296065 前進）
 *
 * ## 4. 移除（天映頻道、天映經典）
 *    `typd2` / `ccm2` 回 HTTP 404；同頻道替代（typd / ccm / cdn3 / cdn10 鏡像）
 *    序號全部停滯或逾時 —— 整組無可播來源。
 *
 * ## 5. 移除（龍華電視、Now TV、鳳凰衛視香港台）
 *    主來源與所有備援序號皆停滯（lhjd 21860、now 478282、fhhk 668032），
 *    segment 內容雜湊 30 秒內完全不變（確認不是快取假象，是真的停播）。
 *    找遍 yang / kuliao / suxuang / itvlist / jackTV / guovin / BigBigGrandG
 *    七份上游清單皆無可用替代。
 *
 * ## 6. 保留（客家電視台 HAKKA TV）
 *    本機直連逾時是 IP 限流，代理路徑實測正常前進 → **不移除**。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHANNELS_PATH = join(ROOT, 'shared', 'channels.json');

const NOW = new Date().toISOString();

const ZJ_NEW_PRIMARY =
  'http://121.19.134.149:808/tsfile/live/1011_1.m3u8?key=txiptv&playlive=1&authid=0';
const DAAI_GLOBAL_HLS = 'https://pull.daaiplus.com/live-DAAIPLUS/live-DAAIPLUS_HD.m3u8';
const TIANYING_PRIMARY =
  'http://120.198.95.220:9901/tsfile/live/1043_1.m3u8?key=txiptv&playlive=1&down=1';

const REMOVE = [
  ['天映頻道', 'typd2 回 HTTP 404；同頻道替代（typd / cdn3 / cdn10 鏡像）序號全部停滯或逾時'],
  ['天映經典', 'ccm2 回 HTTP 404；同頻道替代（ccm / cdn3 / cdn10 鏡像）序號全部停滯或逾時'],
  ['龍華電視', '主來源與全部備援序號停在 21860，segment 雜湊 30 秒不變（真的停播）；七份上游清單無替代'],
  ['Now TV', '主來源與全部備援序號停在 478282，segment 雜湊 30 秒不變；七份上游清單無替代'],
  ['鳳凰衛視香港台', '主來源與全部備援序號停在 668032，segment 雜湊 30 秒不變；七份上游清單無替代'],
];

function main() {
  const catalog = JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'));
  const byName = new Map(catalog.channels.map((c) => [c.channel_name, c]));
  const log = [];

  // ---- 1. 浙江衛視換源 ----
  const zj = byName.get('浙江衛視');
  if (zj) {
    const old = zj.stream_url;
    if (old !== ZJ_NEW_PRIMARY) {
      const backups = zj.playlist_source?.backup_urls ?? [];
      zj.playlist_source.backup_urls = [
        {
          url: old,
          source: '原主來源（已停播：序號停在 359977910）',
          cors: zj.cors_enabled ?? false,
        },
        ...backups.filter((b) => b.url !== ZJ_NEW_PRIMARY && b.url !== old),
      ];
      zj.stream_url = ZJ_NEW_PRIMARY;
      zj.last_checked = NOW;
      log.push(`換源 浙江衛視：${old} → ${ZJ_NEW_PRIMARY}`);
    }
    const zj2 = 'http://61.136.172.236:9901/tsfile/live/0124_1.m3u8?key=txiptv&playlive=1&authid=0';
    const backups = zj.playlist_source?.backup_urls ?? [];
    if (!backups.some((b) => b.url === zj2)) {
      backups.push({ url: zj2, source: 'itvlist 聚合源', cors: false });
      zj.playlist_source.backup_urls = backups;
      log.push(`補備援 浙江衛視：${zj2}`);
    }
  }

  // ---- 2. 北京衛視 / 廣東衛視：主來源實測正常，只補備援 ----
  const EXTRAS = [
    ['北京衛視', 'http://121.19.134.149:808/tsfile/live/1015_1.m3u8?key=txiptv&playlive=1&authid=0'],
    ['廣東衛視', 'http://222.134.245.16:9901/tsfile/live/0125_1.m3u8?key=txiptv&playlive=1&authid=0'],
  ];
  for (const [name, extra] of EXTRAS) {
    const ch = byName.get(name);
    if (!ch) continue;
    const backups = ch.playlist_source?.backup_urls ?? [];
    if (!backups.some((b) => b.url === extra)) {
      backups.push({ url: extra, source: 'itvlist 聚合源', cors: false });
      ch.playlist_source.backup_urls = backups;
      ch.last_checked = NOW;
      log.push(`補備援 ${name}：${extra}`);
    }
  }

  // ---- 3. 天映換源（itvlist「天映」）----
  const ty = byName.get('天映');
  if (ty) {
    const old = ty.stream_url;
    const backups = ty.playlist_source?.backup_urls ?? [];
    ty.playlist_source.backup_urls = [
      {
        url: old,
        source: '原主來源（已停播：序號停在 703，上游名「天映經典『新加坡』」）',
        cors: ty.cors_enabled ?? false,
      },
      ...backups.filter((b) => b.url !== old),
    ];
    ty.stream_url = TIANYING_PRIMARY;
    ty.last_checked = NOW;
    ty.description =
      '天映（itvlist 聚合源）。已驗證序號持續前進（2034426→2034434）、segment 為 MPEG-TS。';
    ty.playlist_source.provider = 'itvlist';
    ty.playlist_source.provider_label = 'itvlist 聚合源';
    ty.playlist_source.provider_url = 'https://bit.ly/itvlist';
    ty.playlist_source.raw_channel_name = '天映';
    ty.source_name = '天映（經 itvlist 聚合源 轉載）';
    ty.source_website = 'https://bit.ly/itvlist';
    log.push(`換源 天映：${old} → ${TIANYING_PRIMARY}`);
  }

  // ---- 4. 大愛電視（全球）：YouTube embed → 官方 HLS ----
  const daai = byName.get('大愛電視（全球）');
  if (daai) {
    daai.stream_url = DAAI_GLOBAL_HLS;
    daai.stream_type = 'hls';
    daai.cors_enabled = true;
    daai.source_name = '大愛電視官方 DAAI+ CDN';
    daai.source_website = 'https://www.daaiplus.com/';
    daai.last_checked = NOW;
    daai.description = '大愛電視全球直播（官方 DAAI+ HLS，CORS * → Web 版免代理）。';
    daai.notes =
      '來源為大愛官方 CDN pull.daaiplus.com（daaiplus.com 標題「DAAI+ | Streaming Application」）。' +
      '實測：mpegts、HTTP 206、序號持續前進。取代原 YouTube embed（embed 僅能看不能播 HLS，且無 24/7 保證）。';
    delete daai.embed_url;
    log.push(`換源 大愛電視（全球）：YouTube embed → ${DAAI_GLOBAL_HLS}`);
  }

  // ---- 5. 移除 ----
  const removeNames = new Set(REMOVE.map((r) => r[0]));
  const before = catalog.channels.length;
  catalog.channels = catalog.channels.filter((c) => !removeNames.has(c.channel_name));
  const removed = before - catalog.channels.length;
  for (const [name, reason] of REMOVE) {
    log.push(`移除 ${name} — ${reason}`);
  }
  console.log(`移除 ${removed} 個頻道（原本 ${before}）`);

  catalog.updated_at = NOW;

  console.log('\n處置明細：');
  for (const l of log) console.log('  · ' + l);

  writeFileSync(CHANNELS_PATH, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  console.log(`\n已寫入 ${CHANNELS_PATH}`);
  console.log(`頻道總數：${catalog.channels.length}`);
}

main();
