#!/usr/bin/env node
/**
 * probe-hinet-koyeb.mjs — 深層探測 SuperTV「秒開直播源」背後的 Hinet 官方 CDN 來源
 *
 * 為什麼值得單獨探：
 *   taiwan-live-tv 目前的台灣頻道來源幾乎都是**第三方轉載**
 *   （YanG / TVAPP / iptv-org），散布權不明 → 只能標 user_provided。
 *   而 SuperTV 的「秒開直播源」指向
 *     http://breezy-audrie-zspace-7524863c.koyeb.app/sub?token=…&id=<tvg-id>
 *   它回傳的 manifest 指向
 *     https://ntd-tgc.cdn.hinet.net/live/pool/<tvg-id>/litv-pc/<tvg-id>-….ts
 *   —— **中華電信 Hinet 的官方 CDN**，也就是原始廣播商的來源。
 *
 * 這代表這批頻道有可能從「轉載」升級成「官方公開來源」。
 *
 * 探測：manifest（是否直播）→ segment（位元組驗證）→ CORS 標頭 → 首包時間
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const LIST_URL = arg('list', 'https://files.catbox.moe/zyat7k.m3u');
const OUT = arg('out', join(__dirname, '..', 'shared', 'hinet-koyeb-probe.json'));

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const TW_KEYS = [
  '台视', '中视', '华视', '民视', '公视', '三立', '八大', '纬来', '东森', '中天',
  'TVBS', '年代', '非凡', '壹', '寰宇', '镜', '龙华', '博斯', 'MUCH', '超视',
  '人间', '好消息', 'GOOD', '大爱', 'MOMO', 'momo', '客家', 'Hakka', 'Taiwan',
  '寰宇', '东风', 'SET', '凤凰', '鳯凰', '幼幼', 'HBO', 'AXN', 'CINEMAX', 'DAZN',
  'Trace', '台視', '中視', '華視', '民視', '公視', '三立', '八大', '緯來', '東森',
  '中天', '年代', '非凡', '壹電視', '寰宇', '鏡新聞', '龍華', '博斯', '超視',
  '人間衛視', '好消息', '大愛', 'MOMO', '客家', '東風', '鳳凰', '鳯凰', '緯來',
];

function parseM3U(text) {
  const out = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const t = line.match(/,(.*)$/);
      const idm = line.match(/tvg-id="([^"]*)"/);
      cur = { name: t ? t[1].trim() : '', tvg_id: idm ? idm[1] : '' };
      continue;
    }
    if (line.startsWith('#')) continue;
    if (/^https?:\/\//i.test(line) && cur) {
      out.push({ ...cur, url: line });
      cur = null;
    }
  }
  return out;
}

function byteKind(buf) {
  if (buf.length >= 1 && buf[0] === 0x47) return 'mpegts';
  if (buf.length >= 12 && buf.slice(4, 8).toString('latin1') === 'ftyp') return 'fmp4';
  if (buf.length >= 5 && buf.slice(0, 5).toString('latin1') === '<html') return 'html';
  return 'unknown';
}

async function probe(ch) {
  const r = {
    name: ch.name,
    tvg_id: ch.tvg_id,
    relay_url: ch.url,
    ok: false,
    reason: '',
    isLive: null,
    byteKind: null,
    cdn_host: null,
    cdn_url: null,
    cors: null,
    ttfb: null,
  };
  try {
    const t0 = Date.now();
    const res = await fetch(ch.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
      headers: { 'user-agent': UA },
    });
    r.ttfb = Date.now() - t0;
    if (!res.ok) { r.reason = `relay HTTP ${res.status}`; return r; }
    const text = await res.text();
    if (!text.includes('#EXTM3U')) { r.reason = 'relay 未回 m3u8'; return r; }
    r.isLive = !text.includes('#EXT-X-ENDLIST');

    const segLine = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    if (!segLine) { r.reason = '無 segment'; return r; }
    r.cdn_url = segLine;
    try { r.cdn_host = new URL(segLine).host; } catch {}

    // segment 首包 + 位元組驗證 + CORS 標頭
    const sres = await fetch(segLine, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: { 'user-agent': UA, range: 'bytes=0-8191' },
    });
    r.cors = sres.headers.get('access-control-allow-origin');
    if (!sres.ok) { r.reason = `segment HTTP ${sres.status}`; return r; }
    const buf = Buffer.from(await sres.arrayBuffer());
    r.byteKind = byteKind(buf);
    if (r.byteKind === 'mpegts' || r.byteKind === 'fmp4') {
      r.ok = true;
      r.reason = r.isLive ? '直播 OK' : '可播但 VOD';
    } else if (r.byteKind === 'html') {
      r.reason = 'segment 回 HTML';
    } else {
      r.reason = `位元組不明(${r.byteKind}, ${buf.length}B)`;
    }
    return r;
  } catch (e) {
    r.reason = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message);
    return r;
  }
}

// ── 主流程 ──
const listRes = await fetch(LIST_URL, { headers: { 'user-agent': UA } });
const text = await listRes.text();
const all = parseM3U(text);
const tw = all.filter((c) => TW_KEYS.some((k) => c.name.includes(k)));
console.log(`═══ ${LIST_URL} ═══`);
console.log(`  總頻道 ${all.length}   台灣相關 ${tw.length}\n`);

const hosts = {};
for (const c of all) {
  try { hosts[new URL(c.url).host] = (hosts[new URL(c.url).host] || 0) + 1; } catch {}
}
console.log('  清單裡的 URL 主機分佈：');
for (const [h, n] of Object.entries(hosts).sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)} × ${h}`);

const results = [];
const CONC = 8;
for (let i = 0; i < tw.length; i += CONC) {
  const batch = tw.slice(i, i + CONC);
  const rs = await Promise.all(batch.map(async (c) => ({ ...(await probe(c)), tvg_id: c.tvg_id })));
  results.push(...rs);
  for (const r of rs) {
    console.log(
      `  ${r.ok ? '✓' : '✗'} ${r.name.slice(0, 16).padEnd(18)} ${r.tvg_id.padEnd(18)} ` +
        `${String(r.reason).padEnd(24)} cors=${r.cors ?? '-'} ${r.cdn_host ?? ''}`,
    );
  }
}

const ok = results.filter((r) => r.ok);
const live = ok.filter((r) => r.isLive);
const corsOk = ok.filter((r) => r.cors === '*');
console.log(`\n═══ 結果 ═══`);
console.log(`  探測台灣頻道：${results.length}`);
console.log(`  可播：${ok.length}（其中直播 ${live.length}、VOD ${ok.length - live.length}）`);
console.log(`  CORS 為 * 的：${corsOk.length}（其餘需走自家代理）`);
const cdnHosts = {};
for (const r of ok) cdnHosts[r.cdn_host] = (cdnHosts[r.cdn_host] || 0) + 1;
console.log('  可播頻道背後的 CDN 主機：');
for (const [h, n] of Object.entries(cdnHosts).sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(3)} × ${h}`);
console.log('\n  可用清單（直播）：');
for (const r of live) console.log(`    ${r.name.padEnd(18)} ${r.tvg_id.padEnd(18)} ${r.cdn_url}`);

writeFileSync(OUT, JSON.stringify({ probed_at: new Date().toISOString(), list: LIST_URL, results }, null, 2));
console.log(`\n  結果已存：${OUT}`);
