#!/usr/bin/env node
/**
 * probe-wcetv-broad.mjs — 廣泛探測 WCETV（中華電視）CDN 上的台灣頻道 HLS
 *
 * 已知可行的命名樣式：
 *   https://live.wcetv.com/hls/master-<代號>.m3u8   → master（多碼率）
 *   https://live.wcetv.com/hls/m3u8/<代號>.m3u8      → media playlist
 *   https://live.wcetv.com/hls/<代號>.m3u8           → 直連 media playlist
 *   https://h5cul1yar48um3t.wcetv.com/hls/<代號>.m3u8 → 另一個 host
 *
 * 目標：為「只有官方 embed」的台灣頻道（華視新聞／中天新聞／鏡新聞／中視新聞／
 * 東森新聞／三立新聞／客家／大愛／寰宇／公視）找官方 HLS。
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const HOSTS = ['https://live.wcetv.com', 'https://h5cul1yar48um3t.wcetv.com'];

/** 廣播商／頻道代號候選（英文代碼） */
const CODES = [
  // 台視
  'ttv', 'ttvnews', 'ttvhd',
  // 華視
  'cts', 'ctsnews', 'ctsnews2', 'ctshd',
  // 中天
  'cti', 'ctinews', 'ctihd', 'cti1', 'cti2',
  // 中視
  'ctv', 'ctvnews', 'ctvhd',
  // 東森
  'ebc', 'ebcnews', 'ebcfinance', 'ebctv', 'ebchd',
  // 三立
  'setn', 'setnews', 'settv', 'setnhd',
  // 鏡新聞
  'mnews', 'mirror', 'mirrortv',
  // 客家
  'hakka', 'hakkatv', 'hakka2',
  // 大愛
  'daai', 'daai1', 'daai2', 'daaihd',
  // 寰宇
  'ftv', 'ftvnews', 'formosa', 'globalnews',
  // 公視
  'pts', 'ptsnews', 'ptshd',
  // 民視
  'ftv2', 'ftvone',
  // 其他
  'goodtv', 'tvb', 'hoy', 'taiwanplus',
];

const PATTERNS = [
  (h, c) => `${h}/hls/master-${c}.m3u8`,
  (h, c) => `${h}/hls/m3u8/${c}.m3u8`,
  (h, c) => `${h}/hls/${c}.m3u8`,
  (h, c) => `${h}/hls/${c}/index.m3u8`,
];

async function head(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Origin: 'https://taiwan-live-tv.netlify.app' },
      redirect: 'follow',
      signal: AbortSignal.timeout(9000),
    });
    if (res.status !== 200) return { status: res.status, isManifest: false };
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    return {
      status: res.status,
      isManifest: text.trimStart().startsWith('#EXTM3U'),
      bytes: buf.length,
      cors: res.headers.get('access-control-allow-origin'),
      seq: (text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m) || [])[1] ?? null,
      endlist: text.includes('#EXT-X-ENDLIST'),
    };
  } catch (e) {
    return { status: 0, isManifest: false, error: e.name ?? e.message };
  }
}

const hits = [];
let checked = 0;
for (const host of HOSTS) {
  for (const code of CODES) {
    for (const pat of PATTERNS) {
      const url = pat(host, code);
      checked++;
      const r = await head(url);
      if (r.isManifest && !r.endlist) {
        hits.push({ url, code, host, ...r });
        console.log(`★ ${url}  seq=${r.seq} cors=${r.cors} bytes=${r.bytes}`);
      }
    }
  }
}

console.log('─'.repeat(78));
console.log(`已探測 ${checked} 個組合，命中 ${hits.length} 個 manifest`);
console.log(JSON.stringify(hits, null, 2));
