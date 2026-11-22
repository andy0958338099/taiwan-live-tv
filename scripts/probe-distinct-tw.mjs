#!/usr/bin/env node
/**
 * probe-distinct-tw.mjs — 為「重複內容的頻道」找獨立來源
 *
 * 2026-11-22 第 4 輪巡檢發現兩個「兩個頻道指向同一個來源」的問題：
 *
 * 1. **台視**(iptvorg-ttvnews-tw-sd) 的來源其實是 `master-ttvnews.m3u8`
 *    = **TTV News**（台視新聞台），不是台視綜合台。
 *    而 `tw-ttv-news`（台視新聞台）用的是同一個頻道的另一個轉載源。
 *    → 兩個頻道都是台視新聞台，其中一個名字是錯的。
 *    真正的台視綜合台在 iptv-org 清單裡是 `TTV.tw` ↔ `162.19.247.76:22222`（已死）。
 *
 * 2. **鳳凰衛視**(cn-fh) 與 **鳳凰衛視中文台**(cn-fhzw) 的 stream_url
 *    **完全相同**（`120.198.95.220:9901/tsfile/live/1036_1.m3u8`）。
 *    上游 itvlist 的名稱↔網址配對顯示 `1036_1` = **凤凰中文**（=中文台），
 *    → 鳳凰衛視這個頻道沒有自己的來源。
 *
 * 這支探測「真正台視綜合台」與「鳳凰衛視（綜合台）」的獨立來源。
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const CANDIDATES = [
  // ── 台視綜合台（TTV main / TTV.tw）────────────────────────────
  ['TTV.tw 162.19.247.76', 'http://162.19.247.76:22222/live/taishi/index.m3u8'],
  ['TTV taishi alt', 'http://162.19.247.76:22222/live/taishi/chunklist.m3u8'],
  ['WCETV ttv', 'https://live.wcetv.com/hls/master-ttv.m3u8'],
  ['WCETV m3u8 ttv', 'https://live.wcetv.com/hls/m3u8/ttv.m3u8'],
  ['WCETV hls ttv', 'https://live.wcetv.com/hls/ttv.m3u8'],
  ['WCETV h5 ttv', 'https://h5cul1yar48um3t.wcetv.com/hls/ttv.m3u8'],
  ['WCETV h5 master ttv', 'https://h5cul1yar48um3t.wcetv.com/hls/master-ttv.m3u8'],
  ['WCETV h5 m3u8 ttv', 'https://h5cul1yar48um3t.wcetv.com/hls/m3u8/ttv.m3u8'],
  ['WCETV ttvnews2', 'https://live.wcetv.com/hls/master-ttvnews2.m3u8'],

  // ── 鳳凰衛視（綜合台 / Phoenix main）─────────────────────────
  ['qd.je fhzw', 'https://cdn.qd.je/163189/fhzw'],
  ['qd.je fhzx', 'https://cdn.qd.je/163189/fhzx'],
  ['hidns fhzw', 'https://10.fast.hidns.vip/163189/fhzw/video/index.php'],
  ['hidns fhtv', 'https://10.fast.hidns.vip/163189/fhtv/video/index.php'],
  ['hidns fh', 'https://10.fast.hidns.vip/163189/fh/video/index.php'],
  ['jdshipin fhzw', 'http://r.jdshipin.com/yDoTN'],
  ['jdshipin fhzx', 'http://r.jdshipin.com/0Rp07'],
  ['jdshipin TVOD fhzw', 'http://php.jdshipin.com/TVOD/iptv.php?id=fhzw'],
  ['cn6 fhzw', 'https://cdn6.cc.cd/163189/fhzw'],
  ['itvlist 120.198 1035', 'http://120.198.95.220:9901/tsfile/live/1035_1.m3u8?key=txiptv&playlive=1&down=1'],
  ['itvlist 120.198 1034', 'http://120.198.95.220:9901/tsfile/live/1034_1.m3u8?key=txiptv&playlive=1&down=1'],
  ['itvlist 222.134 1036', 'http://222.134.245.16:9901/tsfile/live/1036_1.m3u8?key=txiptv&playlive=1&authid=0'],
  ['itvlist 222.134 1035', 'http://222.134.245.16:9901/tsfile/live/1035_1.m3u8?key=txiptv&playlive=1&authid=0'],
];

async function probe(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Origin: 'https://taiwan-live-tv.netlify.app' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    return {
      status: res.status,
      isManifest: text.trimStart().startsWith('#EXTM3U'),
      bytes: buf.length,
      cors: res.headers.get('access-control-allow-origin'),
      final: res.url,
      seq: (text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m) || [])[1] ?? null,
      endlist: text.includes('#EXT-X-ENDLIST'),
    };
  } catch (e) {
    return { status: 0, isManifest: false, error: e.name ?? e.message };
  }
}

for (const [name, url] of CANDIDATES) {
  const r = await probe(url);
  console.log(
    `${r.isManifest && !r.endlist ? '★' : ' '} ${name.padEnd(24)} ${String(r.status).padEnd(4)}` +
      ` ${r.isManifest ? `MANIFEST seq=${r.seq} cors=${r.cors}` : (r.error ?? '')}` +
      (r.final && r.final !== url ? `\n     final=${r.final}` : ''),
  );
}
