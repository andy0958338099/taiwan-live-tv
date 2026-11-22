#!/usr/bin/env node
/**
 * verify-supertv-candidates.mjs — 驗證候選來源（含官方 CDN 升級）
 *
 * 兩類候選：
 *   A. **官方 CDN 升級** —— 現有目錄裡的央視／衛視用的是第三方轉載
 *      （散布權不明 → authorization_status 只能標 user_provided）。
 *      這裡找出同一個頻道的**廣播商官方 CDN**，可以把來源分級升級。
 *   B. **新台灣頻道** —— 緯來體育、東森超視（SuperTV 專案帶出來的）
 *   C. **新中國頻道** —— 黑龍江少兒／新聞、央視台球
 *
 * 每個候選都檢查：
 *   · manifest 是否是直播（無 #EXT-X-ENDLIST）
 *   · segment 位元組是否正確（MPEG-TS 0x47 / fMP4 ftyp）
 *   · 有沒有 CORS（決定要不要走自家 proxy）
 *   · 身分線索（manifest 裡的 tvg-name / 頻道名稱）
 *
 * 用法：node scripts/verify-supertv-candidates.mjs
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'shared', 'supertv-candidates.json');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/**
 * 候選清單。
 *
 * `group` 說明這是「替代來源」「新頻道」還是「官方升級」。
 * `expect` 是我們**預期**的頻道名，用來對照 manifest 裡的線索。
 */
const CANDIDATES = [
  // ── A. 台灣：既有頻道的新備援（來源家族此前未使用過）──
  { group: 'TW-existing', expect: '鳳凰衛視資訊台', url: 'http://r.jdshipin.com/0Rp07' },
  { group: 'TW-existing', expect: '鳳凰衛視資訊台', url: 'http://php.jdshipin.com/TVOD/iptv.php?id=fhzx' },
  { group: 'TW-existing', expect: '鳳凰衛視香港台', url: 'http://r.jdshipin.com/yDoTN' },
  { group: 'TW-existing', expect: '鳳凰衛視香港台', url: 'http://r.jdshipin.com/NfC0f' },
  { group: 'TW-existing', expect: '鳳凰衛視香港台', url: 'http://php.jdshipin.com/TVOD/iptv.php?id=fhhk' },
  { group: 'TW-existing', expect: '鳳凰衛視香港台', url: 'https://epg.pw/stream/5f16dc7fc8aaaed3205516c63e4a8c24bca9dbba1181684244729cf574505b0e.m3u8' },

  // ── B. 台灣：新頻道 ──
  { group: 'TW-new', expect: '緯來體育', url: 'https://epg.pw/stream/8855a9936e37e608a0ec8a014cce1673dee9c5d68d560da376cc92e5edef2b25.m3u8' },
  { group: 'TW-new', expect: '緯來體育', url: 'https://epg.pw/stream/ab6df63b64d0cc44a1f4f029ed847a26fa54a7aebd455578fb05a63f02c22f4b.m3u8' },
  { group: 'TW-new', expect: '緯來體育', url: 'https://epg.pw/stream/4f18dfe0593db5c686eb64ae8edaf2a9202d4d46bdc9bbde2cee27708e12ea01.m3u8' },
  { group: 'TW-new', expect: '東森超視', url: 'http://38.64.72.148:80/hls/modn/list/2013/chunklist1.m3u8' },
  { group: 'TW-existing', expect: 'TVBS Asia', url: 'http://38.64.72.148:80/hls/modn/list/4005/playlist.m3u8' },
  { group: 'TW-existing', expect: 'TVBS Asia', url: 'http://38.64.72.148/hls/modn/list/4005/chunklist0.m3u8' },

  // ── C. 中國：廣播商官方 CDN（合法性分級可升級）──
  { group: 'CN-official', expect: '浙江衛視', url: 'https://ali-m-l.cztv.com/channels/lantian/channel001/1080p.m3u8' },
  { group: 'CN-official', expect: '湖南衛視', url: 'http://hlsal-ldvt.qing.mgtv.com/nn_live/nn_x64/dWlwPTEyNy4wLjAuMSZ1aWQ9cWluZy1jbXMmbm5fd' },
  { group: 'CN-official', expect: '河北衛視', url: 'https://event.pull.hebtv.com/live/live101.m3u8' },
  { group: 'CN-official', expect: '內蒙古衛視', url: 'http://play1-qk.nmtv.cn/live/1769652018126032.m3u8' },
  { group: 'CN-official', expect: '廣州綜合台', url: 'https://tencentplaybusiness.gztv.com/live/zonghes.m3u8' },

  // ── D. 中國：新頻道 ──
  { group: 'CN-new', expect: '黑龍江少兒', url: 'https://ls.qingting.fm/live/4972/64k.m3u8' },
  { group: 'CN-new', expect: '黑龍江新聞', url: 'https://ls.qingting.fm/live/4974/64k.m3u8' },
  { group: 'CN-new', expect: '央視台球', url: 'http://107.150.60.122/live/ystq.m3u8' },
];

async function fetchRes(url, opts = {}) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeout ?? 15000),
    headers: { 'user-agent': UA, ...(opts.headers ?? {}) },
  });
  return res;
}

function byteKind(buf) {
  if (buf.length >= 1 && buf[0] === 0x47) return 'mpegts';
  if (buf.length >= 12 && buf.slice(4, 8).toString('latin1') === 'ftyp') return 'fmp4';
  if (buf.length >= 5 && buf.slice(0, 5).toString('latin1') === '<html') return 'html';
  return 'unknown';
}

/** manifest → 第一個 segment（多變位要追一層 child） */
async function resolveSegment(text, baseUrl, depth = 0) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let pendingVariant = false;
  const segs = [];
  for (const l of lines) {
    if (l.startsWith('#')) {
      if (/^#EXT-X-STREAM-INF/i.test(l)) pendingVariant = true;
      continue;
    }
    if (pendingVariant) {
      const vurl = new URL(l, baseUrl).href;
      if (depth >= 2) return { url: vurl, kind: 'variant' };
      try {
        const cres = await fetchRes(vurl);
        const ctext = await cres.text();
        if (ctext.includes('#EXTM3U')) {
          const inner = await resolveSegment(ctext, vurl, depth + 1);
          if (inner) return inner;
        }
      } catch { /* 抓不到就退回 */ }
      return { url: vurl, kind: 'variant' };
    }
    segs.push(l);
  }
  return segs.length ? { url: new URL(segs[0], baseUrl).href, kind: 'media' } : null;
}

async function check(c) {
  const r = {
    group: c.group, expect: c.expect, url: c.url,
    ok: false, reason: '', isLive: null, byteKind: null,
    cors: null, segUrl: null, segHost: null, nameHints: [],
  };
  try {
    const res = await fetchRes(c.url);
    if (!res.ok) { r.reason = `HTTP ${res.status}`; return r; }
    r.cors = res.headers.get('access-control-allow-origin');
    const text = await res.text();
    if (!text.includes('#EXTM3U')) { r.reason = '非 m3u8'; return r; }
    r.isLive = !text.includes('#EXT-X-ENDLIST');

    // 名稱線索：#EXTINF 的 tvg-name / #EXT-X-CUSTOM-NAME / channel id
    for (const m of text.matchAll(/tvg-name="([^"]*)"/g)) r.nameHints.push(m[1]);
    for (const m of text.matchAll(/#EXT-X-CUSTOM-NAME:([^\r\n]*)/g)) r.nameHints.push(m[1].trim());
    for (const m of text.matchAll(/<title[^>]*>([^<]*)<\/title>/gi)) r.nameHints.push(m[1]);
    r.nameHints = [...new Set(r.nameHints)].slice(0, 4);

    const seg = await resolveSegment(text, res.url || c.url);
    if (!seg) { r.reason = '無 segment'; return r; }
    r.segUrl = seg.url;
    try { r.segHost = new URL(seg.url).host; } catch {}

    const sres = await fetchRes(seg.url, { headers: { range: 'bytes=0-8191' }, timeout: 20000 });
    if (!sres.ok) { r.reason = `segment HTTP ${sres.status}`; return r; }
    const buf = Buffer.from(await sres.arrayBuffer());
    r.byteKind = byteKind(buf);
    if (r.byteKind === 'mpegts' || r.byteKind === 'fmp4') {
      r.ok = true;
      r.reason = r.isLive ? '直播 OK' : '可播但 VOD';
    } else if (r.byteKind === 'html') {
      r.reason = 'segment 回 HTML（錯誤頁）';
    } else {
      r.reason = `位元組不明(${r.byteKind}, ${buf.length}B)`;
    }
    return r;
  } catch (e) {
    r.reason = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message);
    return r;
  }
}

console.log(`═══ 驗證 ${CANDIDATES.length} 個候選來源 ═══\n`);
const results = [];
const CONC = 8;
for (let i = 0; i < CANDIDATES.length; i += CONC) {
  const batch = CANDIDATES.slice(i, i + CONC);
  const rs = await Promise.all(batch.map(check));
  results.push(...rs);
  for (const r of rs) {
    console.log(
      `  ${r.ok ? '✓' : '✗'} [${r.group.padEnd(13)}] ${r.expect.padEnd(14)} ` +
        `${String(r.reason).padEnd(24)} cors=${r.cors ?? '-'}` +
        `${r.nameHints.length ? ' 名稱=' + r.nameHints.join('/') : ''}`,
    );
  }
}

const groups = {};
for (const r of results) {
  groups[r.group] ??= { total: 0, ok: 0, live: 0 };
  groups[r.group].total++;
  if (r.ok) { groups[r.group].ok++; if (r.isLive) groups[r.group].live++; }
}
console.log('\n═══ 分組統計 ═══');
for (const [k, v] of Object.entries(groups)) {
  console.log(`  ${k.padEnd(14)} ${v.ok}/${v.total} 可播（直播 ${v.live}）`);
}

writeFileSync(OUT, JSON.stringify({ checked_at: new Date().toISOString(), results }, null, 2));
console.log(`\n  結果已存：${OUT}`);
