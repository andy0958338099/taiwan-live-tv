#!/usr/bin/env node
/**
 * probe-daaiplus-paths.mjs — 大愛官方 CDN 路徑廣泛探測
 *
 * 已知可用：`pull.daaiplus.com/live-DAAIPLUS/live-DAAIPLUS_HD.m3u8`（大愛電視全球）
 * 目標：找大愛一 / 大愛二 / 大愛三（不需 Referer 的路徑）
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const PATHS = [
  '/live-DAAIPLUS/live-DAAIPLUS_HD.m3u8',
  '/live-DAAIPLUS/live-DAAIPLUS.m3u8',
  '/live-DAAIPLUS1/live-DAAIPLUS1_HD.m3u8',
  '/live-DAAIPLUS1/live-DAAIPLUS1.m3u8',
  '/live-DAAIPLUS2/live-DAAIPLUS2_HD.m3u8',
  '/live-DAAIPLUS2/live-DAAIPLUS2.m3u8',
  '/live-DAAIPLUS3/live-DAAIPLUS3_HD.m3u8',
  '/live-DAAIPLUS4/live-DAAIPLUS4_HD.m3u8',
  '/live-DAAI/live-DAAI_HD.m3u8',
  '/live-DAAI1/live-DAAI1_HD.m3u8',
  '/live-DAAI2/live-DAAI2_HD.m3u8',
  '/live-DA/live-DA_HD.m3u8',
  '/live-DA1/live-DA1_HD.m3u8',
  '/live-DA2/live-DA2_HD.m3u8',
  '/live-DAAITV/live-DAAITV_HD.m3u8',
  '/live-1/live-1_HD.m3u8',
  '/live-2/live-2_HD.m3u8',
  '/live-3/live-3_HD.m3u8',
  '/live-DAAIPLUS/live-DAAIPLUS_SD.m3u8',
  '/live-DAAIPLUS/live-DAAIPLUS_FHD.m3u8',
  '/live-DAAIPLUS/live-DAAIPLUS_LIVE.m3u8',
  '/live-DAAIPLUS/playlist.m3u8',
  '/live-DAAIPLUS/index.m3u8',
  '/playlist.m3u8',
  '/index.m3u8',
];

const HOSTS = ['https://pull.daaiplus.com', 'https://pull2.daaiplus.com', 'https://drt.daaiplus.com'];

const hits = [];
for (const host of HOSTS) {
  for (const p of PATHS) {
    const url = `${host}${p}`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Origin: 'https://taiwan-live-tv.netlify.app' },
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
      });
      if (res.status !== 200) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const text = buf.toString('utf8');
      if (!text.trimStart().startsWith('#EXTM3U')) continue;
      hits.push({
        url,
        cors: res.headers.get('access-control-allow-origin'),
        seq: (text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m) || [])[1] ?? null,
        bytes: buf.length,
      });
      console.log(`★ ${url}  seq=${hits.at(-1).seq} cors=${hits.at(-1).cors}`);
    } catch {
      /* 略過 */
    }
  }
}
console.log('─'.repeat(70));
console.log(`命中 ${hits.length}`);
console.log(JSON.stringify(hits, null, 2));
