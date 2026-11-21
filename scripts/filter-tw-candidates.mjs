#!/usr/bin/env node
/**
 * 從多個 M3U 來源找出**真正的台灣**頻道。
 *
 * ## 為什麼不能用關鍵字比對
 *
 * 第一版的關鍵字清單包含「台」「灣」這種單字，
 * 結果把央視（CCTV）、中國省市地方台全部誤判成台灣頻道 ——
 * 266 個「候選」裡只有十幾個真的是台灣的。
 *
 * ## 正確做法：白名單
 *
 * 用**明確的台灣頻道名稱**（中英文）比對。
 * 這個清單來自：
 *   · iptv-org 的 `countries/tw.m3u`（官方台灣清單）
 *   · 現有 shared/channels.json 的 31 個台灣頻道
 *   · TVBox / 影音倉介面中常見的台灣台標
 *
 * 涵蓋：四大無線台、有線新聞台、地方台、宗教台、文化台、
 *       國際台在台灣的版本（TVB/Animax/AXN/HBO/Cinemax）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SCRATCH = '/Users/andy/.hermes/cache/scratch';

/**
 * 台灣頻道名稱白名單。
 *
 * 每一項是「正規化後的名稱」。比對時兩邊都正規化。
 */
const TW_NAMES = [
  // ── 四大無線台 ──
  '台視', '台視新聞', '台視综合', '台視��合',
  '中視', '中视', '中視新聞',
  '華視', '华视', '華視新聞', '華視新聞台', '華視CTS',
  '民視', '民视', '民視新聞', '民視一台', '民視台灣台', '民視台灣',
  // ── 公共電視 ──
  '公視', '公視網路直播', '公视', '公視3', '公視三台', '公視二台', '公視一台',
  '公視PTS', 'PTS3', 'PTS2', 'PTS1',
  // ── 有線新聞台 ──
  'TVBS新聞', 'TVBS新闻', 'TVBS', 'TVBS台灣', 'TVBS-Asia', 'TVBS Asia',
  'TVBS_ASIA', 'TVBS財經', 'TVBS欢乐台',
  '中天新聞', '中天新闻', '中天電視', '中天综合', '中天综合台',
  '中天娛樂', '中天 Variety', '中天VARIETY', '中天亞洲', '中天亚洲',
  '東森新聞', '东森新闻', '東森財經', '东森财经', '東森洋片', '東森超視',
  '東森新聞台', '東森財經新聞台', 'EBC新闻', 'EBC新聞', 'EBC Financial',
  '三立新聞', '三立新闻', '三立台灣', '三立台灣台', '三立電視', 'SET News',
  '非凡新聞', '非凡新闻', '非凡電視',
  '鏡新聞', '鏡新闻', '鏡新聞 24H', '鏡新聞24H',
  '寰宇新聞', '寰宇新聞台灣台', '寰宇新闻',
  '年代MUCH', '年代',
  '八大第一台', '八大綜合台', '八大 drama',
  '緯來', '緯來綜合台', '緯來日本', '緯來育樂', '緯來體育',
  'TVBS-G', '重播台',
  // ── 地方台 ──
  '大愛電視', '大愛电视', 'DaAi', 'DaAi 1', 'DaAi 2',
  '大立電視', '大立电视', 'Dali TV',
  '客家電視', '客家电视', '客家電視台', 'Hakka TV', 'HAKKA',
  '原住民族電視', '原住民族電視台', '台灣原住民族電視台',
  'Taiwan Indigenous TV', 'Indigenous TV',
  '美麗人生', '美麗人生廣播電台', 'Beautiful Life TV',
  'GOOD TV', 'GOOD TV 綜合台', 'GOOD TV 真理台', 'Good TV', 'Good 2',
  'GOODTV', 'GOOD TV 好漾人間',
  'CGNTV', 'CGNTV 中文台', 'CGNTV Chinese',
  '唯心電視', '唯心电视', 'WS TV',
  '真善美電視', '真善美', 'TZM',
  '無極電視', '無极电视', 'Supreme Master TV',
  '新唐人', '新唐人亞太台', 'NTD TV', 'NTD TV Asia-Pacific',
  'MOMO', 'MOMO購物台', 'MOMO TV',
  'WXTV', 'WXTV 網路台',
  '臺灣', '台視新聞台',
  // ── 國際台在台灣的版本 ──
  'TVB翡翠台', 'TVB 翡翠台', '翡翠台', 'TVB1', 'TVB J1', 'TVBJ1',
  'TVB系', 'TVB Drama', 'TVB 星河台', 'TVB 功夫台', 'TVB Plus',
  '龍華電視', '龍華', '龍祥',
  'Now TV', 'Now新聞台', 'NOW新聞台',
  'HOY TV', 'HOY 資訊台', 'HOY 國際財經台',
  '澳視', '澳視澳門', '澳視台',
  '天映', '天映頻道', '天映經典', '天映電視',
  '明珠台', 'TVB明珠台',
  '無綫新聞台', '無綫',
  'Animax', 'Animax Asia Taiwan',
  'AXN Asia', 'Cinemax Asia', 'HBO Asia',
  '千禧經典台', '華麗翡翠台',
  // ── 其他常見名稱變體 ──
  'Taiwan Plus', 'TaiwanPlus', 'TaiwanPlus TV',
  '台視HD', '華視HD', '民視HD',
];

const norm = (s) =>
  String(s)
    .replace(/\([^)]*\)/g, '')
    .replace(/[【】\[\]]/g, '')
    .replace(/[\s\-_·・,，.。'"/!！?？:：]/g, '')
    .toLowerCase()
    .trim();

const TW_SET = new Set(TW_NAMES.map(norm));

/** 判斷名稱是否是台灣頻道 */
function isTaiwan(name) {
  const n = norm(name);
  if (TW_SET.has(n)) return true;
  // 「XXX新聞台」「XXX 综合」這類變體 —— 前綴命中白名單即算
  for (const t of TW_SET) {
    if (t.length >= 2 && n.startsWith(t)) return true;
  }
  return false;
}

const data = JSON.parse(
  readFileSync(join(SCRATCH, 'tvapp-sources-tw.json'), 'utf8'),
);
const catalog = JSON.parse(
  readFileSync(join(ROOT, 'shared', 'channels.json'), 'utf8'),
);

const exUrls = new Set(catalog.channels.map((c) => c.stream_url));
const exNames = new Set(catalog.channels.map((c) => norm(c.channel_name)));

/** 名稱 → 候選（多來源合併） */
const found = new Map();

for (const [sourceLabel, src] of Object.entries(data)) {
  for (const c of src.taiwan) {
    if (!isTaiwan(c.name)) continue;
    const key = norm(c.name);
    if (exUrls.has(c.url)) continue;
    if (exNames.has(key)) continue;
    if (!found.has(key)) {
      found.set(key, {
        name: c.name,
        url: c.url,
        logo: c.logo,
        id: c.id,
        sources: [],
      });
    }
    found.get(key).sources.push(sourceLabel);
  }
}

const list = [...found.values()].sort((a, b) => b.sources.length - a.sources.length);

console.log('════ 精確篩選後的台灣頻道候選 ════\n');
console.log(`從 ${Object.keys(data).length} 個來源篩出 ${list.length} 個未涵蓋的台灣頻道\n`);

for (const c of list) {
  const multi = c.sources.length > 1 ? ' ★多源' : '';
  console.log(
    `  ${c.name.slice(0, 32).padEnd(34)} ${String(c.sources.length).padStart(2)} 源${multi}`,
  );
  console.log(`     ${c.url.slice(0, 88)}`);
  console.log(`     來源: ${c.sources.join(', ')}`);
}

writeFileSync(
  join(SCRATCH, 'tvapp-tw-candidates.json'),
  JSON.stringify(list, null, 2) + '\n',
  'utf8',
);
console.log(`\n已寫入 ${join(SCRATCH, 'tvapp-tw-candidates.json')}`);
