#!/usr/bin/env node
/**
 * 匯入 TVAPP 來源中通過深度驗證的台灣頻道。
 *
 * 來源：youhunwl/TVAPP 的 README「直播源」段落列出的業界公認來源
 * （Guovin / BigBigGrandG / JackTV / Kimentanm / 范明明 等 12 個），
 * 經 `scripts/scan-tvapp-sources.mjs` 抓取 → `filter-tw-candidates.mjs`
 * 用台灣頻道白名單精確篩選 → `verify-tvapp-tw.mjs` 深度驗證。
 *
 * ## 匯入原則
 *
 * 1. **只匯入通過深度驗證的**（3 個連續 segment 位元組驗證 + manifest 滾動）
 * 2. **優先多來源的** —— 8 個獨立來源都有的頻道，比只有 1 個來源的可靠
 * 3. 排除與現有清單重複的（名稱或 URL）
 * 4. 「字幕」版本優先於無字幕版（字幕版的 segment 較完整）
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
  readFileSync(join(SCRATCH, 'tvapp-tw-verified.json'), 'utf8'),
);

const norm = (s) =>
  String(s)
    .replace(/\([^)]*\)/g, '')
    .replace(/[【】\[\]「」]/g, '')
    .replace(/[\s\-_·・,，.。'"/]/g, '')
    .toLowerCase()
    .trim();

/**
 * 名稱正規化 —— 去掉「字幕」「4K」等修飾語。
 *
 * 「翡翠台」與「翡翠台「字幕」」是同一個頻道，
 * 應該合併（優先留字幕版，segment 比較完整）。
 */
function coreName(raw) {
  return norm(raw)
    .replace(/字幕|webvtt|4k|hd|fhd|sd|uhd|环绕|环绕音軌|備份|备用/g, '')
    .replace(/[「」『』]/g, '');
}

const existingUrls = new Set(catalog.channels.map((c) => c.stream_url));
const existingCore = new Set(catalog.channels.map((c) => coreName(c.channel_name)));

/** 分類對應 */
const CATEGORY = {
  翡翠台: 'general',
  'TVBS亚洲': 'entertainment',
  'TVB 星河台': 'entertainment',
  'TVB Plus': 'entertainment',
  'HOY 資訊台': 'news',
  '千禧經典台': 'entertainment',
  TVB1: 'general',
  'TVB Drama': 'entertainment',
  'TVB 功夫台': 'entertainment',
  '天映頻道「马来西亚」': 'entertainment',
  '天映經典「馬來西亞」': 'entertainment',
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

/** 顯示用名稱（去掉「字幕」等技術性修飾） */
const DISPLAY_NAME = {
  '翡翠台「字幕」': 'TVB 翡翠台',
  'TVB Plus「字幕」': 'TVB Plus',
  '天映頻道「马来西亚」': '天映頻道',
  '天映經典「馬來西亞」': '天映經典',
  TVB1: 'TVB 首台',
};

console.log('════ 匯入 TVAPP 來源的台灣頻道 ════\n');

/** 先依「核心名稱」合併同頻道的不同版本，優先選多來源的 */
const byCore = new Map();
for (const v of verified) {
  const core = coreName(v.name);
  const existing = byCore.get(core);
  // 優先：來源多 > segment 快
  if (!existing || v.sources.length > existing.sources.length) {
    byCore.set(core, v);
  }
}

/**
 * 找出「同義名稱」的既有頻道。
 *
 * 例：既有的「TVB翡翠台」vs 新的「翡翠台」是同一個頻道，
 * 不該變成兩個項目 —— 應該把新來源加成**備援來源**。
 */
const EXISTING_ALIASES = {
  翡翠台: 'TVB翡翠台',
  tvbs亞洲: 'TVBS Asia',
  tvbs亚洲: 'TVBS Asia',
  tvb1: 'TVB系',
  天映頻道: '天映',
  天映經典: '天映',
  hoy資訊台: 'HOY TV',
  tvbplus: 'TVB系',
  tvbdrama: 'TVB系',
  tvb功夫台: 'TVB系',
  tvb星河台: 'TVB系',
  千禧經典台: 'TVB系',
};

let added = 0;
let upgraded = 0;
let skipped = 0;
let nextNumber = 1;

// 台灣頻道號碼接續
const twNumbers = catalog.channels
  .filter((c) => c.region === '台灣' && c.channel_number != null)
  .map((c) => c.channel_number);
nextNumber = (twNumbers.length ? Math.max(...twNumbers) : 0) + 1;

/** 產生不重複的 channel_id */
function uniqueId(base) {
  const slug = base.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');
  let id = `tvapp-${slug || 'tw'}`;
  let n = 2;
  while (catalog.channels.some((c) => c.channel_id === id)) {
    id = `tvapp-${slug || 'tw'}-${n++}`;
  }
  return id;
}

for (const [core, v] of byCore) {
  if (existingUrls.has(v.url)) {
    console.log(`  ⊘ URL 已存在：${v.name}`);
    skipped++;
    continue;
  }

  // ── 檢查是否是既有頻道的同義名（→ 當成備援來源）──
  const aliasName = EXISTING_ALIASES[core];
  const aliasChannel = aliasName
    ? catalog.channels.find((c) => norm(c.channel_name) === norm(aliasName))
    : null;

  if (aliasChannel) {
    // 這個頻道已經有了 —— 把新來源加成備援
    if (!aliasChannel.playlist_source) aliasChannel.playlist_source = {};
    const backups = aliasChannel.playlist_source.backup_urls ?? [];
    if (!backups.some((b) => b.url === v.url)) {
      backups.push({
        url: v.url,
        source: `TVAPP 直播源（${v.sources.length} 個獨立來源）`,
        cors: false,
      });
      aliasChannel.playlist_source.backup_urls = backups;
      upgraded++;
      console.log(
        `  ↑ ${aliasChannel.channel_name.padEnd(16)} 加上備援來源 ` +
          `（${v.sources.length} 源）`,
      );
    } else {
      skipped++;
    }
    continue;
  }

  if (existingCore.has(core)) {
    console.log(`  ⊘ 頻道已存在：${v.name}`);
    skipped++;
    continue;
  }

  const displayName = DISPLAY_NAME[v.name] ?? v.name;
  const category = CATEGORY[v.name] ?? 'general';

  catalog.channels.push({
    channel_id: uniqueId(displayName),
    channel_name: displayName,
    name_en: null,
    category,
    channel_number: nextNumber++,
    logo: v.logo || null,
    stream_url: v.url,
    stream_type: 'hls',
    // 實測全部沒有 CORS 或是 http → Web 版走代理
    cors_enabled: !v.probe.needs_proxy,
    source_name:
      `TVAPP 直播源彙整（${v.sources[0]} 等 ${v.sources.length} 個來源交叉提供）`,
    source_website:
      'https://github.com/youhunwl/TVAPP#直播源-',
    authorization_status: 'user_provided',
    is_active: true,
    last_checked: new Date().toISOString(),
    description:
      `${displayName}｜來源為 TVAPP 專案整理的直播源（${CATEGORY_NAME[category]}）。` +
      `該頻道在 ${v.sources.length} 個獨立來源中都有提供，經深度驗證確認為持續更新的真直播。`,
    region: '台灣',
    tags: ['tvapp', '台灣', category],
    verification: {
      verified_at: new Date().toISOString(),
      method: 'deep-probe: 3 個連續 segment 位元組驗證 + manifest 滾動檢查',
      target_duration: v.probe.target_duration,
      avg_segment_mb: v.probe.avg_segment_mb,
      avg_segment_ms: v.probe.avg_segment_ms,
      source_count: v.sources.length,
      sources: v.sources,
      needs_proxy: v.probe.needs_proxy,
    },
  });

  added++;
  console.log(
    `  ✓ #${nextNumber - 1} ${displayName.padEnd(20)} ` +
      `[${CATEGORY_NAME[category]}] ${v.sources.length}源 ` +
      `${v.probe.avg_segment_mb}MB/${v.probe.avg_segment_ms}ms`,
  );
}

// 清理沒有頻道的分類
const usedCats = new Set(catalog.channels.map((c) => c.category));
catalog.categories = catalog.categories.filter((c) => usedCats.has(c.id));

catalog.updated_at = new Date().toISOString();
writeFileSync(SRC, JSON.stringify(catalog, null, 2) + '\n', 'utf8');

console.log(`\n  新增頻道 ${added} 個，升级備援 ${upgraded} 個，略過 ${skipped} 個`);
console.log(`  頻道總數：${catalog.channels.length}`);
console.log(`  台灣頻道：${catalog.channels.filter((c) => c.region === '台灣').length}`);
console.log(
  `  有備援來源的台灣頻道：${catalog.channels.filter((c) => c.region === '台灣' && (c.playlist_source?.backup_urls?.length ?? 0) > 0).length}`,
);
