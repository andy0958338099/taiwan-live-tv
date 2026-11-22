#!/usr/bin/env node
/**
 * probe-distinct-batch.mjs — 為兩個「重複內容」頻道找獨立來源（第 4 輪）
 *
 * 1. **台視**（`iptvorg-ttvnews-tw-sd`，channel_number 29）
 *    現況：`https://live.wcetv.com/hls/master-ttvnews.m3u8`
 *    → 這個網址上游名稱是 **TTV News**（台視新聞台），
 *      而 `tw-ttv-news`（台視新聞台）用的是同一個頻道的另一個轉載源
 *      （`38.64.72.148/hls/modn/list/4013`）。
 *    → 兩個頻道都是台視新聞台。真正的台視綜合台（`TTV.tw`）來源已死。
 *
 * 2. **鳳凰衛視**（`cn-fh`）
 *    現況：與 `cn-fhzw`（鳳凰衛視中文台）**stream_url 完全相同**。
 *    上游 itvlist：`120.198.95.220:9901` + `1036_1` = **凤凰中文**。
 *    → 鳳凰衛視沒有自己的來源。
 *
 * 本支只做「候選存在性 + manifest 檢查」，完整驗證交給 sample-verify-strict。
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const CANDIDATES = [
  // ── 台視綜合台（TTV main）────────────────────────────────────
  ['38.64.72.148 list/4013', 'http://38.64.72.148/hls/modn/list/4013/chunklist0.m3u8'],
  ['38.64.72.148 list/4014', 'http://38.64.72.148/hls/modn/list/4014/chunklist0.m3u8'],
  ['38.64.72.148 list/4011', 'http://38.64.72.148/hls/modn/list/4011/chunklist0.m3u8'],
  ['38.64.72.148 list/4012', 'http://38.64.72.148/hls/modn/list/4012/chunklist0.m3u8'],
  ['38.64.72.148 list/4005', 'http://38.64.72.148/hls/modn/list/4005/playlist.m3u8'],
  ['WCETV h5 master-hakkatv', 'https://h5cul1yar48um3t.wcetv.com/hls/master-hakkatv.m3u8'],
  ['WCETV h5 m3u8 hakkatv', 'https://h5cul1yar48um3t.wcetv.com/hls/m3u8/hakkatv.m3u8'],
  ['WCETV live m3u8 ttvnews', 'https://live.wcetv.com/hls/m3u8/ttvnews.m3u8'],
  ['WCETV live master hakkatv', 'https://live.wcetv.com/hls/master-hakkatv.m3u8'],

  // ── 鳳凰衛視（綜合台 / Phoenix main）─────────────────────────
  ['kkitv 凤凰卫视', 'http://api.kkitv.itv888.vip:8080/streams/vny1wblsnch/index.m3u8'],
  ['jdshipin cCCzW（中文）', 'http://r.jdshipin.com/cCCzW'],
  ['jdshipin yDoTN（香港）', 'http://r.jdshipin.com/yDoTN'],
  ['ifeng main master', 'http://playtv-live.ifeng.com/live/06OLEGEGM4G.m3u8'],
  ['ifeng zhixun master', 'http://playtv-live.ifeng.com/live/06OLEEWQKN4.m3u8'],
  ['itvlist 120.198 1036（中文）', 'http://120.198.95.220:9901/tsfile/live/1036_1.m3u8?key=txiptv&playlive=1&down=1'],
  ['itvlist 120.198 1037（資訊）', 'http://120.198.95.220:9901/tsfile/live/1037_1.m3u8?key=txiptv&playlive=1&down=1'],
  ['qd.je fhzw', 'https://cdn.qd.je/163189/fhzw'],
  ['qd.je fhzx', 'https://cdn.qd.je/163189/fhzx'],
  ['qd.je fhhk', 'https://cdn.qd.je/163189/fhhk'],
  ['cdn6 fhzw', 'https://cdn6.cc.cd/163189/fhzw'],
  ['cdn6 fhzx', 'https://cdn6.cc.cd/163189/fhzx'],
  ['cdn6 fhhk', 'https://cdn6.cc.cd/163189/fhhk'],
];

async function probe(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Origin: 'https://taiwan-live-tv.netlify.app' },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    return {
      status: res.status,
      isManifest: text.trimStart().startsWith('#EXTM3U'),
      bytes: buf.length,
      cors: res.headers.get('access-control-allow-origin'),
      seq: (text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m) || [])[1] ?? null,
      final: res.url,
    };
  } catch (e) {
    return { status: 0, isManifest: false, error: e.name ?? e.message };
  }
}

for (const [name, url] of CANDIDATES) {
  const r = await probe(url);
  console.log(
    `${r.isManifest ? '★' : ' '} ${name.padEnd(30)} ${String(r.status).padEnd(4)} ` +
      `${r.isManifest ? `MANIFEST seq=${r.seq} cors=${r.cors}` : (r.error ?? '')}` +
      (r.final && r.final !== url ? `\n     → ${r.final}` : ''),
  );
}
