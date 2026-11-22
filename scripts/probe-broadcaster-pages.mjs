#!/usr/bin/env node
/**
 * probe-broadcaster-pages.mjs — 從廣播商官方網站找 HLS（第 3 輪新增）
 *
 * 目標：為「只有官方 embed、沒有 HLS 源」的 10 個台灣頻道找官方 HLS：
 *   華視新聞 CH52、中天新聞 CH52、鏡新聞 24H、中視新聞台、
 *   東森新聞 CH51、三立新聞台 CH54、客家電視台、大愛電視（全球）、
 *   寰宇新聞台灣台、公視網路直播
 *
 * 做法：抓官方網站 / 播放器頁的 HTML， regex 找 `.m3u8`，
 * 再用嚴格口徑驗證（sample-verify-strict 的邏輯）。
 */

import { writeFileSync } from 'node:fs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const PAGES = [
  ['華視新聞', 'https://news.cts.com.tw/'],
  ['華視', 'https://www.cts.com.tw/'],
  ['中天新聞', 'https://news.cti.com.tw/'],
  ['中天', 'https://www.cti.com.tw/'],
  ['中視新聞', 'https://news.ctv.com.tw/'],
  ['中視', 'https://www.ctv.com.tw/'],
  ['東森新聞', 'https://news.ebc.net.tw/'],
  ['東森', 'https://www.ebc.net.tw/'],
  ['三立新聞', 'https://news.setn.com/'],
  ['三立', 'https://www.setn.com/'],
  ['鏡新聞', 'https://www.mnews.com.tw/'],
  ['寰宇', 'https://www.ftv.com.tw/'],
  ['寰宇 IHK', 'https://www.ihk.com.tw/'],
  ['公視', 'https://www.pts.org.tw/'],
  ['公視新聞', 'https://news.pts.org.tw/'],
  ['客家', 'https://www.hakkatv.org.tw/'],
  ['大愛', 'https://www.daai.tv/'],
  ['TVBS', 'https://news.tvbs.com.tw/'],
  ['民視', 'https://www.ftv.com.tw/live/'],
];

const M3U8_RE = /https?:\/\/[^\s"'<>\\)]+?\.m3u8(?:\?[^\s"'<>\\)]*)?/gi;

async function grabHtml(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-TW,zh;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    return { status: res.status, text, final: res.url };
  } catch (e) {
    return { status: 0, text: '', error: e.name ?? e.message };
  }
}

const found = new Map();

for (const [name, url] of PAGES) {
  const r = await grabHtml(url);
  if (!r.text) {
    console.log(`✗ ${name.padEnd(12)} ${url} → ${r.error ?? r.status}`);
    continue;
  }
  const hits = [...new Set(r.text.match(M3U8_RE) ?? [])];
  // 同一頁的 HLS 常是同一頻道的多碼率版本；保留前 4 個
  const keep = hits.slice(0, 4);
  console.log(`· ${name.padEnd(12)} ${url} → HTTP ${r.status}, ${hits.length} 個 m3u8`);
  for (const h of keep) {
    console.log(`    ${h}`);
    if (!found.has(h)) found.set(h, name);
  }
}

writeFileSync(
  '/Users/andy/.hermes/cache/scratch/broadcaster-m3u8.json',
  JSON.stringify([...found].map(([url, name]) => ({ url, name })), null, 2) + '\n',
  'utf8',
);
console.log(`\n合計 ${found.size} 個不重複 m3u8 網址`);
console.log('寫入 /Users/andy/.hermes/cache/scratch/broadcaster-m3u8.json');
