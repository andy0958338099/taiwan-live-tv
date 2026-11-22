#!/usr/bin/env node
/**
 * probe-daaiplus.mjs — 大愛官方 CDN（pull.daaiplus.com）頻道探測
 *
 * 已知可用：`https://pull.daaiplus.com/live-DAAIPLUS/live-DAAIPLUS_HD.m3u8`
 * （大愛電視（全球），CORS * → Web 版免代理）
 *
 * 命名樣式推測：`live-<頻道代號>/live-<頻道代號>_HD.m3u8`
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const CODES = [
  'DAAIPLUS', 'DAAI1', 'DAAI2', 'DAAI3', 'DAAI4',
  'DAAI1HD', 'DAAI2HD',
  'DA1', 'DA2', 'DA3',
  'DAAITV1', 'DAAITV2', 'DAAITV3',
  'DAAIEAST', 'DAAINORTH',
];

const SUFFIX = ['_HD', '', '_FHD'];

async function probe(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Origin: 'https://taiwan-live-tv.netlify.app' },
      redirect: 'follow',
      signal: AbortSignal.timeout(9000),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    return {
      url,
      status: res.status,
      isManifest: text.trimStart().startsWith('#EXTM3U'),
      bytes: buf.length,
      cors: res.headers.get('access-control-allow-origin'),
      seq: (text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m) || [])[1] ?? null,
    };
  } catch (e) {
    return { url, status: 0, isManifest: false, error: e.name ?? e.message };
  }
}

const hits = [];
let n = 0;
for (const code of CODES) {
  for (const suf of SUFFIX) {
    const url = `https://pull.daaiplus.com/live-${code}/live-${code}${suf}.m3u8`;
    n++;
    const r = await probe(url);
    if (r.isManifest) {
      hits.push(r);
      console.log(`★ ${url}  seq=${r.seq} cors=${r.cors}`);
    }
  }
}
console.log('─'.repeat(70));
console.log(`探測 ${n} 個，命中 ${hits.length}`);
console.log(JSON.stringify(hits, null, 2));
