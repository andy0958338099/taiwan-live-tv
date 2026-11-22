#!/usr/bin/env node
/**
 * probe-official-tw.mjs — 台灣廣播商自家 CDN 的 HLS 探測（第 3 輪新增）
 *
 * 目標：為「只有官方 embed、沒有 HLS 源」的 10 個台灣頻道找可播的 HLS。
 * 優先打廣播商**自家 CDN**（官方授權 → authorization_status 可用 public_official）。
 *
 * 探測方式：對每個候選網址直接 GET，判斷是否 #EXTM3U 開頭。
 * 回 200 且是 manifest → 再進 sample-verify-strict 做完整驗證。
 */

import { writeFileSync } from 'node:fs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const CANDIDATES = [
  // ── WCETV（中華電視）master 清單猜測 ──────────────────────────
  ['WCETV 華視新聞', 'https://live.wcetv.com/hls/master-ctsnews.m3u8'],
  ['WCETV 華視', 'https://live.wcetv.com/hls/master-cts.m3u8'],
  ['WCETV 中天', 'https://live.wcetv.com/hls/master-cti.m3u8'],
  ['WCETV 東森', 'https://live.wcetv.com/hls/master-ebc.m3u8'],
  ['WCETV 三立', 'https://live.wcetv.com/hls/master-setn.m3u8'],
  ['WCETV 客家', 'https://live.wcetv.com/hls/master-hakka.m3u8'],
  ['WCETV 公視', 'https://live.wcetv.com/hls/master-pts.m3u8'],
  ['WCETV 鏡新聞', 'https://live.wcetv.com/hls/master-mnews.m3u8'],
  ['WCETV 中視', 'https://live.wcetv.com/hls/master-ctv.m3u8'],
  ['WCETV 寰宇', 'https://live.wcetv.com/hls/master-ftv.m3u8'],
  ['WCETV TVBS', 'https://live.wcetv.com/hls/master-tvbs.m3u8'],
  ['WCETV 大愛', 'https://live.wcetv.com/hls/master-daai.m3u8'],

  // ── WCETV 直連 media playlist（不經 master）──────────────────
  ['WCETV hakka 直連', 'https://h5cul1yar48um3t.wcetv.com/hls/hakkatv.m3u8'],
  ['WCETV titv 直連', 'https://h5cul1yar48um3t.wcetv.com/hls/titv.m3u8'],
  ['WCETV ttvnews 直連', 'https://live.wcetv.com/hls/m3u8/ttvnews.m3u8'],

  // ── 公視 PTS ─────────────────────────────────────────────────
  ['PTS 公視直播', 'https://live.pts.org.tw/live/hls/news.m3u8'],
  ['PTS 公視', 'https://live.pts.org.tw/hls/live/pts.m3u8'],
  ['PTS 風雲', 'https://live.pts.org.tw/hls/live/fengyun.m3u8'],
  ['PTS 人生劇展', 'https://live.pts.org.tw/hls/live/rensheng.m3u8'],

  // ── 鏡新聞 ───────────────────────────────────────────────────
  ['鏡新聞 mnews', 'https://lcdn.mnews.com.tw/live/CH1_HD.m3u8'],
  ['鏡新聞 mnews2', 'https://lcdn.mnews.com.tw/live/CH1_SD.m3u8'],

  // ── 寰宇 ─────────────────────────────────────────────────────
  ['寰宇新聞', 'https://live.ihk.com.tw/live/FTV.m3u8'],
  ['寰宇 HLS', 'https://hls.cdn.happyweb.com.tw/live/ftv.m3u8'],

  // ── 東森 ─────────────────────────────────────────────────────
  ['東森新聞 HLS', 'https://ebc.cdn.happyweb.com.tw/ebcnews/index.m3u8'],
  ['東森財經 HLS', 'https://ebc.cdn.happyweb.com.tw/ebcfinance/index.m3u8'],

  // ── 三立 ─────────────────────────────────────────────────────
  ['三立新聞 HLS', 'https://setn.cdn.happyweb.com.tw/setnnews/index.m3u8'],
  ['三立台 HLS', 'https://setn.cdn.happyweb.com.tw/settv/index.m3u8'],

  // ── 中天 / 中視 ──────────────────────────────────────────────
  ['中天新聞 HLS', 'https://news.cdn.happyweb.com.tw/cti-news/index.m3u8'],
  ['中視新聞 HLS', 'https://news.cdn.happyweb.com.tw/ctv-news/index.m3u8'],
  ['中天一台 HLS', 'https://news.cdn.happyweb.com.tw/cti/index.m3u8'],

  // ── 華視 ─────────────────────────────────────────────────────
  ['華視新聞 HLS', 'https://news.cdn.happyweb.com.tw/cts-news/index.m3u8'],
  ['華視台 HLS', 'https://news.cdn.happyweb.com.tw/cts/index.m3u8'],

  // ── 台視 / 公視台 ────────────────────────────────────────────
  ['台視新聞 HLS2', 'https://news.cdn.happyweb.com.tw/ttv-news/index.m3u8'],
  ['公視台 HLS', 'https://news.cdn.happyweb.com.tw/pts/index.m3u8'],
];

async function probe(name, url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Origin: 'https://taiwan-live-tv.netlify.app' },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    const isM3u = text.trimStart().startsWith('#EXTM3U');
    return {
      name,
      url,
      status: res.status,
      isManifest: isM3u,
      bytes: buf.length,
      cors: res.headers.get('access-control-allow-origin'),
      head: isM3u ? text.split('\n').slice(0, 4).join(' | ') : text.slice(0, 60).replace(/\s+/g, ' '),
    };
  } catch (e) {
    return { name, url, status: 0, isManifest: false, bytes: 0, error: e.name ?? e.message };
  }
}

const out = [];
console.log('═'.repeat(80));
console.log('台灣廣播商官方 CDN HLS 探測');
console.log('═'.repeat(80));
for (const [name, url] of CANDIDATES) {
  const r = await probe(name, url);
  out.push(r);
  const mark = r.isManifest ? '★' : ' ';
  console.log(`${mark} ${name.padEnd(22)} ${String(r.status).padEnd(4)} ${r.isManifest ? 'MANIFEST' : ''} ${r.error ?? r.head}`);
}
writeFileSync('/Users/andy/.hermes/cache/scratch/official-tw-probe.json', JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`\n命中 manifest：${out.filter((r) => r.isManifest).length}/${out.length}`);
console.log('寫入 /Users/andy/.hermes/cache/scratch/official-tw-probe.json');
