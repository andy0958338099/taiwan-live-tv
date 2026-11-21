#!/usr/bin/env node
/**
 * 批次抓取多個 M3U 來源，找出台灣頻道。
 *
 * 來源清單來自 youhunwl/TVAPP 的 README「直播源」段落
 * （該 repo 整理了業界公認最穩的直播源）。
 *
 * 我們已經用過的來源（不在此重複抓）：
 *   · YanG-1989/m3u → Gather.m3u（現有清單的 8 個台灣頻道來自這裡）
 *   · suxuang/myIPTV → 現有清單也有
 *   · iptv-org/index.m3u → 上一輪已處理
 *
 * 這一輪專注在**還沒用過**的來源。
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SCRATCH = '/Users/andy/.hermes/cache/scratch';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/** 候選來源 —— 來自 youhunwl/TVAPP README 的「直播源」段落 */
const SOURCES = [
  { url: 'https://www.iyouhun.com/tv/zb', label: '游魂直播源', skip: true },
  { url: 'https://live.zbds.top/tv/iptv4.m3u', label: 'zbds IPTV4 M3U' },
  { url: 'https://develop202.github.io/migu_video/interface.txt', label: '咪咕 IPTV', skip: true },
  {
    url: 'https://raw.githubusercontent.com/Guovin/iptv-api/gd/output/result.m3u',
    label: 'Guovin IPTV 預設',
  },
  {
    url: 'https://raw.githubusercontent.com/Guovin/iptv-api/gd/output/ipv4/result.m3u',
    label: 'Guovin IPTV IPv4',
  },
  {
    url: 'https://raw.githubusercontent.com/BurningC4/Chinese-IPTV/master/TV-IPV4.m3u',
    label: 'BurningC4',
  },
  { url: 'https://raw.githubusercontent.com/vamoschuck/TV/main/M3U', label: '茶客源' },
  {
    url: 'https://raw.githubusercontent.com/fanmingming/live/main/tv/m3u/ipv6.m3u',
    label: '范明明 IPv6',
  },
  { url: 'https://live.fanmingming.cn/tv/m3u/ipv6.m3u', label: '范明明鏡像' },
  { url: 'https://raw.githubusercontent.com/YueChan/Live/main/IPTV.m3u', label: 'YueChan' },
  {
    url: 'https://raw.githubusercontent.com/Kimentanm/aptv/master/m3u/iptv.m3u',
    label: 'Kimentanm',
  },
  {
    url: 'https://raw.githubusercontent.com/BigBigGrandG/IPTV-URL/release/Gather.m3u',
    label: 'BigBigGrandG',
  },
  { url: 'https://php.946985.filegear-sg.me/jackTV.m3u', label: 'JackTV' },
  { url: 'https://epg.pw/test_channels_taiwan.m3u', label: 'epg.pw 台灣' },
];

/** 台灣關鍵字（中英文都用） */
const TW_KEYWORDS = [
  '台視', '中視', '華視', '民視', '公視', '大愛', '三立', '東森', '中天',
  'TVBS', '客家', '原住民', '大愛', '三立', '東森', '中天', '八大', '年代',
  '非凡', '緯來', '鏡新聞', '寰宇', 'GOOD TV', '美麗人生', 'CGNTV', '唯心',
  '真善美', '龍祥', '天映', '澳視', 'HOY', 'Now TV', 'NOW TV', 'TVB',
  'Taiwan', 'TaiwanPlus', 'Taiwan Plus', 'TTV', 'CTV', 'CTS', 'FTV', 'DaAi',
  'Hakka', 'MOMO', 'SUPREME MASTER', 'Good TV', 'WxTV', 'SET', 'MOMO',
  'Animax', 'AXN', 'Cinemax', 'HBO', 'CGN', 'Dali', 'NTD',
  '台', '灣', '臺',
];

/** 判斷一個名稱是否台灣相關 */
function isTaiwanName(name) {
  const n = String(name);
  return TW_KEYWORDS.some((k) => n.includes(k));
}

/** 解析 M3U */
function parseM3u(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXTINF')) continue;
    const url = lines[i + 1];
    if (!url || url.startsWith('#')) continue;
    const mid = lines[i].match(/tvg-id="([^"]+)"/);
    const mname = lines[i].match(/,([^,]+)$/);
    const mlogo = lines[i].match(/tvg-logo="([^"]+)"/);
    const mgroup = lines[i].match(/group-title="([^"]+)"/);
    out.push({
      id: mid?.[1] ?? '',
      name: (mname?.[1] ?? '').trim(),
      logo: mlogo?.[1] ?? '',
      group: mgroup?.[1] ?? '',
      url,
    });
  }
  return out;
}

console.log('════ 批次抓取 M3U 來源，找台灣頻道 ════\n');

const results = {};

for (const src of SOURCES) {
  if (src.skip) {
    console.log(`  ⊘ 略過 ${src.label}`);
    continue;
  }
  process.stdout.write(`  ${src.label.padEnd(20)} `);
  try {
    const res = await fetch(src.url, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) {
      console.log(`✗ HTTP ${res.status}`);
      continue;
    }
    const text = await res.text();
    const all = parseM3u(text);
    if (!all.length) {
      console.log(`✗ 解析不到頻道（內容 ${text.length}B）`);
      continue;
    }
    const tw = all.filter((c) => isTaiwanName(c.name) || /\.tw@|@Taiwan/i.test(c.id));
    console.log(
      `✓ 總 ${String(all.length).padStart(5)}  台灣 ${String(tw.length).padStart(4)}`,
    );
    results[src.label] = { url: src.url, total: all.length, taiwan: tw };
  } catch (e) {
    console.log(`✗ ${e.cause?.code ?? e.message}`);
  }
}

console.log('\n════ 各來源的台灣頻道 ════\n');
for (const [label, r] of Object.entries(results)) {
  if (!r.taiwan.length) continue;
  console.log(`── ${label} (${r.taiwan.length} 個)`);
  for (const c of r.taiwan.slice(0, 40)) {
    console.log(`   ${c.name.slice(0, 40).padEnd(42)} ${c.url.slice(0, 58)}`);
  }
  if (r.taiwan.length > 40) console.log(`   ...還有 ${r.taiwan.length - 40} 個`);
  console.log();
}

writeFileSync(
  join(SCRATCH, 'tvapp-sources-tw.json'),
  JSON.stringify(results, null, 2) + '\n',
  'utf8',
);
console.log(`已寫入 ${join(SCRATCH, 'tvapp-sources-tw.json')}`);
