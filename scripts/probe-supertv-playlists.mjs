#!/usr/bin/env node
/**
 * probe-supertv-playlists.mjs — 探測 SuperTV 舊專案使用的 9 個遠端播放清單
 *
 * 這些清單與 taiwan-live-tv 現有來源（iptv-org / TVAPP / YanG）**完全不重疊**，
 * 是新的來源家族。其中 `Guovin/iptv-api` 是維護中的知名台灣 IPTV 彙整專案。
 *
 * 流程：抓清單 → 統計台灣相關頻道數 → 對台灣頻道做 deep probe
 *       （manifest → 無 ENDLIST → segment → 位元組驗證）
 *
 * 用法：node scripts/probe-supertv-playlists.mjs [--probe N]
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const PROBE_N = parseInt(arg('probe', '40'), 10);
const ALL = process.argv.includes('--all');
const CONC = parseInt(arg('conc', String(ALL ? 25 : 10)), 10);
const OUT = arg('out', join(__dirname, '..', 'shared', 'supertv-playlist-probe.json'));

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const SOURCES = [
  { id: 'catbox-jipin', label: '極品/黃金', url: 'https://files.catbox.moe/id0n84.txt' },
  { id: 'catbox-miaokai', label: '秒開', url: 'https://files.catbox.moe/zyat7k.m3u' },
  { id: 'catbox-judy', label: 'Judy', url: 'https://files.catbox.moe/25aoli.txt' },
  { id: 'catbox-laji', label: '垃圾', url: 'https://files.catbox.moe/1mj29e.m3u' },
  { id: 'xiaofeng', label: '曉峰', url: 'http://晓峰.azip.dpdns.org:5008/?type=m3u' },
  { id: 'guovin', label: '咪咪 Guovin/iptv-api', url: 'https://raw.githubusercontent.com/Guovin/iptv-api/gd/output/result.m3u' },
  { id: 'gather', label: 'Gather', url: 'https://tv.iill.top/m3u/Gather' },
  { id: 'yuanbao', label: '緣寶', url: 'https://chuxinya.top/f/DRGJH3/绿影流年.txt' },
  { id: 'koyeb-sub', label: 'Koyeb sub 代理', url: 'http://breezy-audrie-zspace-7524863c.koyeb.app/sub' },
];

/** 台灣相關的關鍵字 */
const TW_KEYS = [
  '台視', '中視', '華視', '民視', '公視', '三立', '八大', '緯來', '東森', '中天',
  'TVBS', '年代', '非凡', '壹電視', '寰宇', '鏡新聞', '龍華', '博斯', 'MUCH',
  '超視', '人間衛視', '好消息', 'GOOD', '大愛', 'MOMO', 'momo', '客家', 'Hakka',
  'Taiwan', 'taiwan', 'TAIWAN', '寰宇', '東風', 'SET', '台視', '鳳凰', '鳯凰',
  '緯', '幼幼', '動物星球', 'Discovery', 'DISCOVERY', 'HBO', 'AXN', 'CINEMAX',
  'DAZN', 'Trace', '東森', '中視',
];

/** 中國大陸（次要，數量多） */
const CN_KEYS = ['央視', 'CCTV', '湖南衛視', '浙江衛視', '東方衛視', '北京衛視', '江蘇衛視', '廣東衛視'];

function isTW(name) {
  return TW_KEYS.some((k) => name.includes(k));
}
function isCN(name) {
  return CN_KEYS.some((k) => name.includes(k));
}

/** 解析 m3u */
function parseM3U(text) {
  const out = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const t = line.match(/,(.*)$/);
      cur = { name: t ? t[1].trim() : '', attrs: line };
      continue;
    }
    if (line.startsWith('#')) continue;
    if (/^https?:\/\//i.test(line)) {
      out.push({ name: cur?.name || '', url: line, attrs: cur?.attrs || '' });
      cur = null;
    }
  }
  return out;
}

async function fetchText(url, timeout = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': UA },
    });
    if (!res.ok) return { ok: false, status: res.status, text: '' };
    return { ok: true, status: res.status, text: await res.text() };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: e.cause?.code || e.message };
  } finally {
    clearTimeout(t);
  }
}

/**
 * 解析 manifest 找出第一個 segment。
 *
 * ⚠️ **master manifest 要再追一層 child manifest。**
 *    有 `#EXT-X-STREAM-INF` 的清單是「多變位清單」，
 *    裡面的非註解行是**子清單網址**，不是 segment。
 *    直接抓它會拿到一份 m3u8（開頭是 #EXTM3U）→
 *    位元組驗證判成「不明」→ 整批被誤判為失敗。
 *
 *    實測踩到：amagi.tv / Pluto TV 的清單都是多變位的。
 */
function firstSegment(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let pendingVariant = false;
  const segs = [];
  for (const l of lines) {
    if (l.startsWith('#')) {
      if (/^#EXT-X-STREAM-INF/i.test(l)) pendingVariant = true;
      continue;
    }
    if (pendingVariant) return { url: new URL(l, baseUrl).href, kind: 'variant' };
    segs.push(l);
  }
  return segs.length ? { url: new URL(segs[0], baseUrl).href, kind: 'media' } : null;
}

/** 取得真正的 segment 網址（必要時追一層 child manifest） */
async function resolveSegment(text, baseUrl, depth = 0) {
  const seg = firstSegment(text, baseUrl);
  if (!seg) return null;
  if (seg.kind !== 'variant' || depth >= 2) return seg;
  const child = await fetchText(seg.url, 12000);
  if (!child.ok) return seg;              // 抓不到就退回原值（讓上层報錯）
  return resolveSegment(child.text, seg.url, depth + 1);
}

function byteKind(buf) {
  if (buf.length >= 1 && buf[0] === 0x47) return 'mpegts';
  if (buf.length >= 12 && buf.slice(4, 8).toString('latin1') === 'ftyp') return 'fmp4';
  if (buf.length >= 5 && buf.slice(0, 5).toString('latin1') === '<html') return 'html';
  return 'unknown';
}

async function deepProbe(ch) {
  const r = { name: ch.name, url: ch.url, ok: false, reason: '', isLive: null, byteKind: null };
  try {
    const res = await fetch(ch.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
      headers: { 'user-agent': UA },
    });
    if (!res.ok) { r.reason = `HTTP ${res.status}`; return r; }
    const text = await res.text();
    if (!text.includes('#EXTM3U')) { r.reason = '非 m3u8'; return r; }
    r.isLive = !text.includes('#EXT-X-ENDLIST');
    const seg = await resolveSegment(text, res.url || ch.url);
    if (!seg) { r.reason = '無 segment'; return r; }
    r.manifestKind = seg.kind;
    const sres = await fetch(seg.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: { 'user-agent': UA, range: 'bytes=0-4095' },
    });
    if (!sres.ok) { r.reason = `segment HTTP ${sres.status}`; return r; }
    const buf = Buffer.from(await sres.arrayBuffer());
    r.byteKind = byteKind(buf);
    if (r.byteKind === 'mpegts' || r.byteKind === 'fmp4') {
      r.ok = true;
      r.reason = r.isLive ? '直播 OK' : '可播但 VOD';
    } else if (r.byteKind === 'html') {
      r.reason = 'segment 回 HTML';
    } else {
      r.reason = `位元組不明(${r.byteKind})`;
    }
    return r;
  } catch (e) {
    r.reason = e.name === 'AbortError' || e.name === 'TimeoutError' ? 'timeout' : (e.cause?.code || e.message);
    return r;
  }
}

// ── EPG 端點（SuperTV 的清單裡附帶的）──
const EPG_URL = 'https://epg.iill.top/epg';

async function checkEpg() {
  console.log('\n═══ EPG 端點 ═══');
  try {
    const res = await fetch(EPG_URL, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    console.log(`  ${EPG_URL} → HTTP ${res.status}  ${text.length} bytes`);
    console.log(`  前 200 字元：${text.slice(0, 200).replace(/\n/g, ' ')}`);
    // 抓出台灣頻道的節目數
    let twCount = 0, total = 0;
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/<channel id="([^"]+)"[^>]*name="([^"]+)"/);
      if (!m) continue;
      total++;
      if (/台視|中視|華視|民視|公視|三立|八大|緯來|東森|中天|TVBS|年代|非凡|寰宇|龍華|博斯|MOMO|客家|GOOD|超視|人間|Trace|HBO|AXN|CINEMAX|DAZN|Taiwan/i.test(m[2])) twCount++;
    }
    console.log(`  解析到頻道 ${total} 個，其中台灣相關 ${twCount} 個`);
    return { ok: res.ok, bytes: text.length, total, tw: twCount, head: text.slice(0, 200) };
  } catch (e) {
    console.log(`  ${EPG_URL} → 失敗：${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ── 主流程 ──
const report = { probed_at: new Date().toISOString(), sources: [] };

console.log('═══ 抓取 9 個遠端播放清單 ═══\n');
for (const s of SOURCES) {
  const { ok, status, text, error } = await fetchText(s.url);
  if (!ok) {
    console.log(`  ✗ ${s.label.padEnd(22)} ${s.id.padEnd(16)} HTTP ${status} ${error || ''}`);
    report.sources.push({ ...s, ok: false, status, error, total: 0, tw: 0, cn: 0 });
    continue;
  }
  const chans = parseM3U(text);
  const tw = chans.filter((c) => isTW(c.name));
  const cn = chans.filter((c) => !isTW(c.name) && isCN(c.name));
  console.log(
    `  ✓ ${s.label.padEnd(22)} ${s.id.padEnd(16)} 總 ${String(chans.length).padStart(5)}  ` +
      `台灣相關 ${String(tw.length).padStart(4)}  中國 ${String(cn.length).padStart(4)}`,
  );
  report.sources.push({ ...s, ok: true, status, total: chans.length, tw: tw.length, cn: cn.length, sample: tw.slice(0, 6) });
}

// ── 對台灣頻道 deep probe ──
console.log(`\n═══ 對台灣相關頻道 deep probe（每個清單取前 ${PROBE_N} 個）═══\n`);
const probeTargets = [];
for (const s of report.sources) {
  if (!s.ok) continue;
  const { text } = await fetchText(s.url);
  const chans = ALL ? parseM3U(text) : parseM3U(text).filter((c) => isTW(c.name));
  for (const c of chans.slice(0, PROBE_N)) {
    probeTargets.push({ ...c, source: s.id, sourceLabel: s.label });
  }
}

const results = [];
for (let i = 0; i < probeTargets.length; i += CONC) {
  const batch = probeTargets.slice(i, i + CONC);
  const rs = await Promise.all(
    batch.map(async (c) => ({ ...(await deepProbe(c)), source: c.source, sourceLabel: c.sourceLabel })),
  );
  results.push(...rs);
  for (const r of rs) {
    console.log(
      `  ${r.ok ? '✓' : '✗'} [${r.source}] ${r.name.slice(0, 18).padEnd(20)} ` +
        `${String(r.reason).padEnd(28)}${r.isLive === false ? ' [VOD]' : ''}`,
    );
  }
}

const bySource = {};
for (const r of results) {
  bySource[r.source] ??= { total: 0, ok: 0, live: 0, vod: 0 };
  bySource[r.source].total++;
  if (r.ok) {
    bySource[r.source].ok++;
    if (r.isLive) bySource[r.source].live++;
    else bySource[r.source].vod++;
  }
}
console.log('\n═══ 各清單的台灣頻道存活率 ═══');
for (const [k, v] of Object.entries(bySource)) {
  console.log(
    `  ${k.padEnd(18)} 探測 ${String(v.total).padStart(3)}  可播 ${String(v.ok).padStart(3)}` +
      `  (直播 ${v.live} / VOD ${v.vod})  存活率 ${v.total ? Math.round((v.ok / v.total) * 100) : 0}%`,
  );
}
const totalLive = Object.values(bySource).reduce((a, b) => a + b.live, 0);
const epg = await checkEpg();
report.epg = epg;
console.log(`\n  合計可播的台灣直播頻道：${totalLive}`);

report.probe = results;
writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`\n  結果已存：${OUT}`);
