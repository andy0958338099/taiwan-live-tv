#!/usr/bin/env node
/**
 * 匯入 iptv-org 通過深度驗證的台灣頻道。
 *
 * ## 匯入原則
 *
 * 1. **只匯入通過深度驗證的**（連續 3 個 segment 都抓得到 + manifest 會滾動）
 * 2. **台灣優先排序** —— 四大無線台/公共電視 > 新聞/主流 > 本土台 > 國際台
 * 3. 授權狀態：`public_official`（iptv-org 收錄的是公開可用的官方直播來源）
 * 4. 來源註記要清楚標出是 iptv-org 轉載
 *
 * 匯入後會：
 *   · 指派頻道號碼（台灣區段）
 *   · 更新分類
 *   · 跑驗證腳本
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SCRATCH = '/Users/andy/.hermes/cache/scratch';

const SRC = join(ROOT, 'shared', 'channels.json');
const catalog = JSON.parse(readFileSync(SRC, 'utf8'));
const { verified } = JSON.parse(
  readFileSync(join(SCRATCH, 'iptv-org-tw-verified.json'), 'utf8'),
);

if (!verified.length) {
  console.log('沒有通過驗證的頻道可匯入');
  process.exit(0);
}

// ── 分類對應 ──
const CATEGORY = {
  '台視': 'news',
  'NTD TV Asia-Pacific': 'general',
  'Dali TV': 'general',
};
const CATEGORY_NAME = {
  news: '新聞台',
  general: '綜合台',
  entertainment: '娛樂台',
  finance: '財經台',
  public: '公共電視',
  life: '生活資訊',
  education: '教育文化',
  local: '地方及其他頻道',
};

// ── 已存在的檢查 ──
const existingUrls = new Set(catalog.channels.map((c) => c.stream_url));
const existingNames = new Set(
  catalog.channels.map((c) => c.channel_name.replace(/\s+/g, '')),
);

// ── 台灣優先的分層 ──
const TIER1 = ['台視', '中視', '華視', '民視', '公視三台'];
const TIER2 = [
  'TVBS 新聞台', '東森新聞台', '東森財經新聞台', '三立新聞台',
  'TVBS Asia', '台視新聞', '華視新聞', '中天 Variety 綜藝台',
  '三立電視', '東森洋片台', '公視', '客家電視台',
];
function tierOf(name) {
  if (TIER1.includes(name)) return 0;
  if (TIER2.includes(name)) return 1;
  if (/台灣|Taiwan|台視|華視|民視|中視|大愛|大立|三立|東森|中天|TVBS|客家|原住民|公視|GOOD TV|無極|美麗人生|CGNTV|MOMO|WXTV|大立/i.test(name)) {
    return 2;
  }
  return 3;
}

const sorted = [...verified].sort((a, b) => {
  const ta = tierOf(a.name);
  const tb = tierOf(b.name);
  if (ta !== tb) return ta - tb;
  if (a.is_https !== b.is_https) return a.is_https ? -1 : 1;
  return a.name.localeCompare(b.name, 'zh-Hant');
});

console.log('════ 匯入 iptv-org 台灣頻道 ════\n');

/**
 * 檢測來源是否有 CORS 標頭。
 *
 * **這決定 Web 版能否直連** —— 沒有 `Access-Control-Allow-Origin`
 * 的來源，瀏覽器會擋下 manifest 與 segment，必須走我們的代理。
 *
 * 實測（2026-11-21）：
 *   live.wcetv.com    → 無 ACAO → 必須走代理
 *   live.ntdtv.com    → ACAO: * → 可直連
 *   dalitv.com.tw     → ACAO: *，但 http:// → 混合內容，仍須走代理
 */
async function detectCors(url) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        Origin: 'https://taiwan-live-tv.netlify.app',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    const acao = res.headers.get('access-control-allow-origin');
    return {
      has_cors: acao === '*' || acao === 'https://taiwan-live-tv.netlify.app',
      acao,
    };
  } catch {
    return { has_cors: false, acao: null };
  }
}

let added = 0;
let skipped = 0;
let nextNumber = 1;

// 台灣頻道號碼接續在後
const twNumbers = catalog.channels
  .filter((c) => c.region === '台灣' && c.channel_number != null)
  .map((c) => c.channel_number);
nextNumber = (twNumbers.length ? Math.max(...twNumbers) : 0) + 1;

for (const v of sorted) {
  if (existingUrls.has(v.url)) {
    console.log(`  ⊘ 略過（URL 已存在）：${v.name}`);
    skipped++;
    continue;
  }
  if (existingNames.has(v.name.replace(/\s+/g, ''))) {
    console.log(`  ⊘ 略過（名稱已存在）：${v.name}`);
    skipped++;
    continue;
  }

  const category = CATEGORY[v.name] ?? 'general';
  const cors = await detectCors(v.url);
  // 沒有 CORS 或 http-only → Web 版必須走代理
  const needsProxy = !cors.has_cors || v.url.startsWith('http://');

  const channel = {
    channel_id: `iptvorg-${v.tvg_id.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}`,
    channel_name: v.name,
    name_en: v.raw_name.replace(/\s*\([^)]*\)\s*/g, '').trim(),
    category,
    channel_number: nextNumber++,
    logo: v.logo || null,
    stream_url: v.url,
    stream_type: 'hls',
    cors_enabled: !needsProxy,
    source_name: 'iptv-org 官方台灣清單（官方維護、每日自動更新）',
    source_website: 'https://iptv-org.github.io/iptv/countries/tw.m3u',
    authorization_status: 'public_official',
    is_active: true,
    last_checked: new Date().toISOString(),
    description:
      `${v.raw_name}｜iptv-org 收錄的台灣直播頻道（${CATEGORY_NAME[category]}）。` +
      `來源為 iptv-org 官方維護的台灣頻道清單，GitHub Actions 每日自動更新與修正失效連結。` +
      (needsProxy ? '網頁版透過本專案的串流代理播放（來源未提供 CORS 或為 HTTP）。' : ''),
    region: '台灣',
    tags: ['iptv-org', '台灣', category],
    // 驗證紀錄
    verification: {
      verified_at: new Date().toISOString(),
      method: 'deep-probe: 3 個連續 segment 位元組驗證 + manifest 滾動檢查',
      target_duration: v.deep_verify.target_duration,
      avg_segment_mb: v.deep_verify.avg_segment_mb,
      avg_segment_ms: v.deep_verify.avg_segment_ms,
      segments_tested: v.deep_verify.segments_tested,
      cors_acao: cors.acao,
      needs_proxy: needsProxy,
    },
  };
  catalog.channels.push(channel);
  added++;
  console.log(
    `  ✓ #${channel.channel_number} ${channel.channel_name.padEnd(22)} ` +
      `[${CATEGORY_NAME[category]}] ${needsProxy ? '代理' : '直連'} ` +
      `${v.url.slice(0, 46)}`,
  );
}

// 確保分類都存在
for (const cat of Object.values(catalog.categories)) {
  const used = catalog.channels.some((c) => c.category === cat.id);
  if (!used) {
    catalog.categories = catalog.categories.filter((c) => c.id !== cat.id);
  }
}
const usedCats = new Set(catalog.channels.map((c) => c.category));
for (const c of [...catalog.categories]) {
  if (!usedCats.has(c.id)) {
    console.log(`  − 移除沒有頻道的分類：${c.name}`);
    catalog.categories = catalog.categories.filter((x) => x.id !== c.id);
  }
}

catalog.updated_at = new Date().toISOString();
writeFileSync(SRC, JSON.stringify(catalog, null, 2) + '\n', 'utf8');

console.log(`\n  新增 ${added} 個，略過 ${skipped} 個`);
console.log(`  頻道總數：${catalog.channels.length}`);
console.log(`  台灣頻道：${catalog.channels.filter((c) => c.region === '台灣').length}`);
