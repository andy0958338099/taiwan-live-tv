#!/usr/bin/env node
/**
 * probe-38-namespace.mjs — 掃 `38.64.72.148/hls/modn/list/<id>/` 命名空間
 *
 * 已知（reysc/M3U8 live2024.m3u 的名稱↔網址配對）：
 *   4005 → TVBS Asia
 *   4012 → 民視新聞
 *   4013 → 台視新聞
 *
 * 目標：找出**台灣主台**（台視綜合台、中天綜合台、民視台灣台…）的獨立來源。
 * 只列出 manifest 可讀且序號在動的 id，後續再逐一做嚴格驗證。
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const HOST = 'http://38.64.72.148';
const RANGE = [4000, 4060];

const hits = [];

for (let id = RANGE[0]; id <= RANGE[1]; id++) {
  for (const leaf of ['chunklist0.m3u8', 'chunklist1.m3u8', 'playlist.m3u8']) {
    const url = `${HOST}/hls/modn/list/${id}/${leaf}`;
    let r;
    try {
      r = await fetch(url, {
        headers: { 'User-Agent': UA, Origin: 'https://taiwan-live-tv.netlify.app' },
        redirect: 'follow',
        signal: AbortSignal.timeout(9000),
      });
    } catch {
      continue;
    }
    if (r.status !== 200) continue;
    let text;
    try {
      text = await r.text();
    } catch {
      continue;
    }
    if (!text.trimStart().startsWith('#EXTM3U')) continue;
    if (text.includes('#EXT-X-ENDLIST')) continue;
    const seq = (text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m) || [])[1] ?? null;
    const cors = r.headers.get('access-control-allow-origin');
    hits.push({ id, leaf, url, seq, cors });
    console.log(
      `★ id=${id} ${leaf.padEnd(18)} seq=${seq} cors=${cors} bytes=${text.length}`,
    );
    break; // 同一 id 找到一個就夠了
  }
}

console.log('─'.repeat(70));
console.log(`命中 ${hits.length} 個`);
console.log(JSON.stringify(hits, null, 2));
