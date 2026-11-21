#!/usr/bin/env node
/**
 * 修正「龍華系」頻道的備援來源 —— 移除跨頻道的錯誤備援。
 *
 * ## 問題（從截圖分析發現）
 *
 * 截圖顯示龍華電視的狀態是「已切換至備援來源 3/7」，
 * 但畫面右上角的浮水印是 **LTV 龍華日韓台** ——
 * 也就是說「龍華電視」這個頻道實際上播放的是**另一個頻道**的內容。
 *
 * 根因：`cdn.qd.je/163189/` 這個路徑下，每個尾碼是**不同的頻道**：
 *   lhjd → 龍華經典台   lhox → 龍華偶像台   lhrh → 龍華日韓台
 *   lhxj → 龍華戲劇台   lhyp → 龍華洋片台   lhkt → 龍華卡通台
 *
 * 但它們被當成「同一頻道的備援來源」放進 backup_urls。
 * 結果是：主來源失效時，播放器會安靜地切到另一個頻道 ——
 * 使用者以為在看龍華電視，實際上看的是龍華日韓台。
 *
 * ## 修法
 *
 * 1. 把這些**真的是不同頻道**的來源從 backup_urls 移除
 * 2. 把它們建成**各自的獨立頻道**（龍華偶像台、龍華日韓台…）
 * 3. 每個頻道有自己的主來源與真正的備援
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'shared', 'channels.json');

const catalog = JSON.parse(readFileSync(SRC, 'utf8'));

/**
 * cdn.qd.je/163189/ 的尾碼 → 頻道名。
 *
 * 這個對照表來自 JackTV 清單（`scripts/scan-tvapp-sources.mjs` 抓的），
 * 每個尾碼都是一個**獨立的電視頻道**，不是同一頻道的備援。
 */
const QD_163189 = {
  lhjd: '龍華經典台',
  lhox: '龍華偶像台',
  lhrh: '龍華日韓台',
  lhxj: '龍華戲劇台',
  lhyp: '龍華洋片台',
  lhkt: '龍華卡通台',
  lhdy: '龍華電影台',
  fct: 'TVB 翡翠台',
  j1: 'TVB J1',
  tvb1: 'TVB 首台',
  tvbd: 'TVB Drama',
  yzwx: 'TVB 功夫台',
  tvbxh: 'TVB 星河台',
  tvbc: '千禧經典台',
  tvbp: 'TVB Plus',
  hoy: 'HOY TV',
  hoy78: 'HOY 資訊台',
  hoy76: 'HOY 國際財經台',
  now: 'Now 新聞台',
  asam: '澳視澳門',
  typd: '天映頻道',
  ccm: '天映經典',
  ccm2: '天映經典（馬來西亞）',
  fhzw: '鳳凰中文台',
  fhzx: '鳳凰資訊台',
  fhhk: '鳳凰香港台',
  dsyp: '東森洋片台',
  ylxw: '娛樂新聞台',
  tvbp2: 'TVB Plus（副）',
  wxxw: '無綫新聞台',
  tvb: 'TVB',
};

const CATEGORY = {
  龍華經典台: 'general',
  龍華偶像台: 'entertainment',
  龍華日韓台: 'entertainment',
  龍華戲劇台: 'entertainment',
  龍華洋片台: 'entertainment',
  龍華卡通台: 'entertainment',
  龍華電影台: 'entertainment',
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

const norm = (s) =>
  String(s)
    .replace(/\([^)]*\)/g, '')
    .replace(/[【】\[\]「」]/g, '')
    .replace(/[\s\-_·・,，.。'"/]/g, '')
    .toLowerCase();

const existingUrls = new Set(catalog.channels.map((c) => c.stream_url));
const existingNames = new Set(catalog.channels.map((c) => norm(c.channel_name)));

console.log('════ 修正龍華系的跨頻道備援 ════\n');

let removed = 0;
let added = 0;
let nextNumber = 1;

const twNumbers = catalog.channels
  .filter((c) => c.region === '台灣' && c.channel_number != null)
  .map((c) => c.channel_number);
nextNumber = (twNumbers.length ? Math.max(...twNumbers) : 0) + 1;

for (const channel of catalog.channels) {
  if (!channel.playlist_source?.backup_urls?.length) continue;

  const keep = [];
  const moved = [];

  for (const b of channel.playlist_source.backup_urls) {
    const m = (b.url || '').match(/163189\/([a-z0-9]+)/i);
    if (!m) {
      keep.push(b); // 來自其他來源（例如 8.fast.hidns.vip）—— 保留
      continue;
    }
    const code = m[1].toLowerCase();
    const realName = QD_163189[code];
    if (!realName) {
      keep.push(b);
      continue;
    }
    if (norm(realName) === norm(channel.channel_name)) {
      keep.push(b); // 真的同一個頻道 → 是合法備援
    } else {
      moved.push({ ...b, code, realName });
    }
  }

  if (!moved.length) continue;

  channel.playlist_source.backup_urls = keep;
  if (!keep.length) delete channel.playlist_source.backup_urls;
  if (!Object.keys(channel.playlist_source).length) delete channel.playlist_source;
  removed += moved.length;

  console.log(`  ${channel.channel_name}：移除 ${moved.length} 個跨頻道備援`);
  for (const mv of moved) {
    console.log(`    − ${mv.code} → 實際是「${mv.realName}」`);
  }

  // 把這些來源建成獨立頻道
  for (const mv of moved) {
    if (existingUrls.has(mv.url)) continue;
    if (existingNames.has(norm(mv.realName))) continue;
    const url = `https://cdn.qd.je/163189/${mv.code}`;
    if (existingUrls.has(url)) continue;

    catalog.channels.push({
      channel_id: `qd-${mv.code}`,
      channel_name: mv.realName,
      name_en: null,
      category: CATEGORY[mv.realName] ?? 'general',
      channel_number: nextNumber++,
      logo: null,
      stream_url: url,
      stream_type: 'hls',
      cors_enabled: false,
      source_name: '龍華電視系列（cdn.qd.je/163189 轉載）',
      source_website: 'https://cdn.qd.je/163189/',
      authorization_status: 'user_provided',
      is_active: true,
      last_checked: new Date().toISOString(),
      description:
        `${mv.realName}｜龍華電視系列的另一個頻道。` +
        `與「龍華經典台」是不同頻道（上游路徑代碼 ${mv.code}），` +
        `先前被誤列為同一頻道的備援來源，現已拆開。`,
      region: '台灣',
      tags: ['龍華', '台灣', CATEGORY[mv.realName] ?? 'general'],
    });
    existingUrls.add(url);
    existingNames.add(norm(mv.realName));
    added++;
    console.log(`    ✓ 新增獨立頻道「${mv.realName}」→ ${url}`);
  }
}

catalog.updated_at = new Date().toISOString();
writeFileSync(SRC, JSON.stringify(catalog, null, 2) + '\n', 'utf8');

console.log(`\n  移除跨頻道備援 ${removed} 個，新增獨立頻道 ${added} 個`);
console.log(`  頻道總數：${catalog.channels.length}`);
console.log(`  台灣頻道：${catalog.channels.filter((c) => c.region === '台灣').length}`);
