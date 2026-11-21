#!/usr/bin/env node
/**
 * fetch-epg.mjs — 擷取各頻道的官方節目表（EPG）
 *
 * ## 為什麼需要
 *
 * 業界的 TV app（Apple HIG 的 Live-Viewing Apps、YouTube TV、Tellyfin、
 * Plex）幾乎都有「現在在播」資訊 —— 那是使用者選台時最需要的資訊，
 * 也是電視與網頁版最大的體感差距。
 *
 * ## 資料來源策略
 *
 * 台灣各台的官方 API 差異很大：
 *   · Taiwan Plus 的 `/api/live/live-schedule-today` 需要特殊 security
 *     header（回 403「Missing required security headers」），
 *     **但直播頁的 SSR payload 已經內含節目表** → 抓頁面就取得。
 *   · 其他電視台的頁面結構各不相同，逐一台硬寫解析器維護成本高。
 *
 * 因此本工具採「統一介面 + 站台專屬擷取器」架構：
 * 每個站台一個函式，抓不到就跳過（不影響其他站台）。
 *
 * ## 輸出
 *
 * `shared/epg.json` — 供 scripts/sync-channels.mjs 併入 channels.json，
 * 讓 APK 與 Web 共用同一份資料。
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractPrograms, toNowNext } from './decode-nuxt-payload.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'shared', 'epg.json');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/**
 * 站台專屬擷取器。
 *
 * 每個函式回傳 `{ channelIds: string[], programs: [...] }`，
 * channelIds 是「這個節目表涵蓋哪些 channel_id」。
 */
const FETCHERS = [
  {
    name: 'Taiwan Plus 官方直播頁',
    async fetch() {
      const url = 'https://www.taiwanplus.com/live';
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const programs = extractPrograms(html);
      if (!programs.length) throw new Error('payload 中找不到節目');

      // Taiwan Plus 在我們的清單裡是哪些 channel_id
      const catalog = JSON.parse(
        (await import('node:fs')).readFileSync(
          join(ROOT, 'shared', 'channels.json'),
          'utf8',
        ),
      );
      const ids = catalog.channels
        .filter((c) => /taiwanplus|taiwan plus/i.test(c.source_website + ' ' + c.source_name))
        .map((c) => c.channel_id);

      return {
        channelIds: ids.length ? ids : ['tw-taiwan-plus'],
        programs,
      };
    },
  },
];

async function main() {
  const out = {
    schema_version: 1,
    updated_at: new Date().toISOString(),
    /** channel_id → 節目清單 */
    channels: {},
  };

  for (const f of FETCHERS) {
    process.stdout.write(`  ${f.name} … `);
    try {
      const { channelIds, programs } = await f.fetch();
      const { current, upcoming } = toNowNext(programs);
      for (const id of channelIds) {
        out.channels[id] = {
          source: f.name,
          current: current
            ? {
                title: current.title,
                start: current.dateTime,
                end: current.end ? formatTime(current.end) : null,
                description: current.shortDescription ?? current.description ?? '',
                age_rating: current.ageRating ?? null,
              }
            : null,
          upcoming: upcoming.slice(0, 6).map((u) => ({
            title: u.title,
            start: u.dateTime,
          })),
        };
      }
      console.log(
        `✓ ${programs.length} 個節目 → ${channelIds.join(', ')}` +
          (current ? `（現在：${current.title}）` : ''),
      );
    } catch (err) {
      console.log(`✗ ${err.message}`);
    }
  }

  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
  const n = Object.keys(out.channels).length;
  console.log(`\n已寫入 ${OUT}（${n} 個頻道有節目表）`);
}

function formatTime(d) {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

await main();
