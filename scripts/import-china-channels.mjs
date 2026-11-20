#!/usr/bin/env node
/**
 * import-china-channels.mjs — 從外部 IPTV 播放清單匯入中國大陸頻道
 *
 * 與 import-playlists.mjs（台灣）的差異：
 *   1. 過濾規則是中國大陸的頻道命名（CCTV / 各省衛視 / 鳳凰）
 *   2. **嚴格驗證是真正的直播** —— 檢查 manifest 沒有 `#EXT-X-ENDLIST`，
 *      避免匯入「10 秒 VOD 預覽片段」（那是清單提供者放的預覽，不是直播）
 *   3. 授權狀態標為 user_provided（清單由使用者提供）
 *
 * 用法：node scripts/import-china-channels.mjs [--dry-run] [--no-probe] [--limit N]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHANNELS_PATH = join(ROOT, 'shared', 'channels.json');
const PLAYLIST_DIR =
  process.env.PLAYLIST_DIR || '/Users/andy/.hermes/cache/scratch/playlists';

const DRY_RUN = process.argv.includes('--dry-run');
const NO_PROBE = process.argv.includes('--no-probe');
const LIMIT_IDX = process.argv.indexOf('--limit');
const LIMIT = LIMIT_IDX >= 0 ? parseInt(process.argv[LIMIT_IDX + 1], 10) : null;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/**
 * 中國大陸頻道對照表。
 *
 * key 是清單中的頻道名稱關鍵字（去除裝飾後比對），
 * value 是我們的標準名稱與分類。
 *
 * 分類沿用既有架構（shared/schema.md 的 categories）：
 *   news / general / entertainment / finance / public / life / education / local
 *   → 中國頻道多為 general（綜合台）與 news（新聞台）
 */
const CHINA_CHANNEL_MAP = {
  // ── CCTV 央視台 ──
  'CCTV1': { id: 'cn-cctv1',name: '央視-1 綜合', category: 'general' },
  'CCTV2': { id: 'cn-cctv2',name: '央視-2 財經', category: 'finance' },
  'CCTV3': { id: 'cn-cctv3',name: '央視-3 綜藝', category: 'entertainment' },
  'CCTV4': { id: 'cn-cctv4',name: '央視-4 中文國際', category: 'news' },
  'CCTV5': { id: 'cn-cctv5',name: '央視-5 體育', category: 'entertainment' },
  'CCTV5+': { id: 'cn-cctv5plus',name: '央視-5+ 體育賽事', category: 'entertainment' },
  'CCTV6': { id: 'cn-cctv6',name: '央視-6 電影', category: 'entertainment' },
  'CCTV7': { id: 'cn-cctv7',name: '央視-7 國防軍事', category: 'general' },
  'CCTV8': { id: 'cn-cctv8',name: '央視-8 劇集', category: 'entertainment' },
  'CCTV9': { id: 'cn-cctv9',name: '央視-9 紀錄', category: 'education' },
  'CCTV10': { id: 'cn-cctv10',name: '央視-10 教育', category: 'education' },
  'CCTV11': { id: 'cn-cctv11',name: '央視-11 戲曲', category: 'entertainment' },
  'CCTV12': { id: 'cn-cctv12',name: '央視-12 社會與法', category: 'general' },
  'CCTV13': { id: 'cn-cctv13',name: '央視-13 新聞', category: 'news' },
  'CCTV14': { id: 'cn-cctv14',name: '央視-14 少兒', category: 'education' },
  'CCTV15': { id: 'cn-cctv15',name: '央視-15 音樂', category: 'entertainment' },
  'CCTV16': { id: 'cn-cctv16',name: '央視-16 奧林匹克', category: 'entertainment' },
  'CCTV17': { id: 'cn-cctv17',name: '央視-17 農業農村', category: 'life' },
  'CGTN': { id: 'cn-cgtn',name: 'CGTN 中國環球電視', category: 'news' },

  // ── 各省衛視 ──
  '北京衛視': { name: '北京衛視', category: 'local' },
  '東方衛視': { name: '東方衛視', category: 'local' },
  '湖南衛視': { name: '湖南衛視', category: 'local' },
  '浙江衛視': { name: '浙江衛視', category: 'local' },
  '江蘇衛視': { name: '江蘇衛視', category: 'local' },
  '廣東衛視': { name: '廣東衛視', category: 'local' },
  '深圳衛視': { name: '深圳衛視', category: 'local' },
  '山東衛視': { name: '山東衛視', category: 'local' },
  '安徽衛視': { name: '安徽衛視', category: 'local' },
  '河南衛視': { name: '河南衛視', category: 'local' },
  '遼寧衛視': { name: '遼寧衛視', category: 'local' },
  '黑龍江衛視': { name: '黑龍江衛視', category: 'local' },
  '吉林衛視': { name: '吉林衛視', category: 'local' },
  '河北衛視': { name: '河北衛視', category: 'local' },
  '山西衛視': { name: '山西衛視', category: 'local' },
  '陝西衛視': { name: '陝西衛視', category: 'local' },
  '四川衛視': { name: '四川衛視', category: 'local' },
  '重慶衛視': { name: '重慶衛視', category: 'local' },
  '湖北衛視': { name: '湖北衛視', category: 'local' },
  '湖南經視': { name: '湖南經視', category: 'local' },
  '天津衛視': { name: '天津衛視', category: 'local' },
  '雲南衛視': { name: '雲南衛視', category: 'local' },
  '貴州衛視': { name: '貴州衛視', category: 'local' },
  '廣西衛視': { name: '廣西衛視', category: 'local' },
  '海南衛視': { name: '海南衛視', category: 'local' },
  '江西衛視': { name: '江西衛視', category: 'local' },
  '甘肅衛視': { name: '甘肅衛視', category: 'local' },
  '青海衛視': { name: '青海衛視', category: 'local' },
  '寧夏衛視': { name: '寧夏衛視', category: 'local' },
  '新疆衛視': { name: '新疆衛視', category: 'local' },
  '西藏衛視': { name: '西藏衛視', category: 'local' },
  '內蒙古衛視': { name: '內蒙古衛視', category: 'local' },
  '兵團衛視': { name: '兵團衛視', category: 'local' },

  // ── 鳳凰衛視 ──
  '鳳凰衛視中文': { id: 'cn-fhzw',name: '鳳凰衛視中文台', category: 'general' },
  '鳳凰衛視香港': { id: 'cn-fhhk',name: '鳳凰衛視香港台', category: 'general' },
  '鳳凰衛視INFO': { id: 'cn-fhzx',name: '鳳凰衛視資訊台', category: 'news' },
  '鳳凰衛視': { id: 'cn-fh',name: '鳳凰衛視', category: 'general' },

  // ── 鳳凰衛視（簡體） ──
  '凤凰中文': { id: 'cn-fhzw',name: '鳳凰衛視中文台', category: 'general' },
  '凤凰卫视': { id: 'cn-fh',name: '鳳凰衛視', category: 'general' },
  '凤凰香港': { id: 'cn-fhhk',name: '鳳凰衛視香港台', category: 'general' },
  '凤凰资讯': { id: 'cn-fhzx',name: '鳳凰衛視資訊台', category: 'news' },
};

/**
 * 各省衛視對照表（含簡體與繁體兩種寫法）。
 *
 * 為什麼要兩種：清單提供者混用簡體（卫视）與繁體（衛視），
 * 而且同一頻道在不同清單裡的寫法不一致。
 *
 * key 必須是 **ASCII**，因為它會直接變成 channel_id。
 * 若用中文當 key，`replace(/[^a-zA-Z0-9]+/g, '-')` 會把所有中文
 * 都折成單一破折號，導致 34 個省衛視全部撞成同一個 id。
 */
const PROVINCE_MAP = {
  bj: { cn: '北京', name: '北京衛視' },
  df: { cn: '東方', name: '東方衛視' },
  dn: { cn: '東南', name: '東南衛視' },
  hn: { cn: '湖南', name: '湖南衛視' },
  zj: { cn: '浙江', name: '浙江衛視' },
  js: { cn: '江蘇', name: '江蘇衛視' },
  gd: { cn: '廣東', name: '廣東衛視' },
  sz: { cn: '深圳', name: '深圳衛視' },
  sd: { cn: '山東', name: '山東衛視' },
  ah: { cn: '安徽', name: '安徽衛視' },
  ha: { cn: '河南', name: '河南衛視' },
  ln: { cn: '遼寧', name: '遼寧衛視' },
  hlj: { cn: '黑龍江', name: '黑龍江衛視' },
  jl: { cn: '吉林', name: '吉林衛視' },
  hb: { cn: '河北', name: '河北衛視' },
  sx: { cn: '山西', name: '山西衛視' },
  sx2: { cn: '陝西', name: '陝西衛視' },
  sc: { cn: '四川', name: '四川衛視' },
  cq: { cn: '重慶', name: '重慶衛視' },
  hb2: { cn: '湖北', name: '湖北衛視' },
  tj: { cn: '天津', name: '天津衛視' },
  yn: { cn: '雲南', name: '雲南衛視' },
  gz: { cn: '貴州', name: '貴州衛視' },
  gx: { cn: '廣西', name: '廣西衛視' },
  hn2: { cn: '海南', name: '海南衛視' },
  jx: { cn: '江西', name: '江西衛視' },
  gs: { cn: '甘肅', name: '甘肅衛視' },
  qh: { cn: '青海', name: '青海衛視' },
  nx: { cn: '寧夏', name: '寧夏衛視' },
  xj: { cn: '新疆', name: '新疆衛視' },
  xz: { cn: '西藏', name: '西藏衛視' },
  nm: { cn: '內蒙古', name: '內蒙古衛視' },
  bt: { cn: '兵團', name: '兵團衛視' },
  sh: { cn: '上海', name: '上海衛視' },
  xm: { cn: '廈門', name: '廈門衛視' },
  ss: { cn: '三沙', name: '三沙衛視' },
  nf: { cn: '南方', name: '南方衛視' },
};

/** 簡體 → 繁體 對照（只做頻道名稱比對用） */
/**
 * 簡體 → 繁體 對照（用於頻道名稱比對）。
 *
 * 只需要涵蓋各省市衛視的名稱用字，不需要完整的簡繁轉換表。
 */
const SIMPLIFIED_TO_TRADITIONAL = {
  卫: '衛',
  视: '視', 东: '東', 苏: '蘇', 广: '廣', 辽: '遼', 宁: '寧',
  龙: '龍', 门: '門', 陕: '陝', 庆: '慶', 云: '雲', 贵: '貴',
  内: '內', 团: '團', 厦: '廈', 晋: '晉', 湘: '湘', 赣: '贛',
  豫: '豫', 皖: '皖', 冀: '冀', 桂: '桂', 滇: '滇', 黔: '黔',
  琼: '瓊', 华: '華', 凤: '鳳', 电: '電', 闻: '聞', 际: '際',
  综: '綜', 艺: '藝', 军: '軍', 影: '影', 视: '視', 儿: '兒',
  农: '農', 奥: '奧', 林: '林', 戏: '戲', 音: '音', 少: '少',
  社: '社', 会: '會', 教: '教', 育: '育', 纪: '紀', 录: '錄',
  财: '財', 经: '經', 综: '綜', 球: '球', 赛: '賽', 事: '事',
  国: '國', 际: '際', 健: '健', 康: '康', 农: '農', 村: '村',
  治: '治', 城: '城', 乡: '鄉', 村: '村', 医: '醫', 药: '藥',
  银: '銀', 行: '行', 保: '保', 险: '險', 车: '車', 房: '房',
  食: '食', 品: '品', 旅: '旅', 游: '遊', 天: '天', 气: '氣',
  预: '預', 报: '報', 体: '體', 育: '育', 新: '新', 闻: '聞',
  综: '綜', 合: '合', 少: '少', 儿: '兒', 农: '農', 科: '科',
  军: '軍', 事: '事', 奥: '奧', 林: '林', 音: '音', 戏: '戲',
  电: '電', 影: '影', 剧: '劇', 综: '綜', 艺: '藝', 少: '兒',
};

/** 簡體轉繁體（單字對照表，逐字替換） */
function toTraditional(name) {
  return name
    .split('')
    .map((ch) => SIMPLIFIED_TO_TRADITIONAL[ch] ?? ch)
    .join('');
}

/** 清單中可能出現的群組關鍵字（用來篩選中國頻道） */
const GROUP_KEYWORDS = ['央視', '央视', '中國', '中国', '衛視', '卫视'];

/**
 * 明確排除的群組（直播秀、賽事、酒店源等非電視台頻道）。
 *
 * 注意：`4K频道` **不在**排除清單裡 ——
 * 4K 省份衛視（如「湖南衛視4K」）是正規的電視台直播，
 * 只是解析度較高，應該納入。
 */
const EXCLUDE_GROUP_PATTERNS = [
  /快手/,
  /斗鱼|斗魚/,
  /YY直播/,
  /直播秀/,
  /酒店/,
  /组播|組播/,
  /賽事|赛事/,
  /主播/,
];

/** 去除清單中的裝飾標記 */
function cleanName(name) {
  return name
    .replace(/[「」\[\]【】（）()\s]/g, '')
    .replace(/Relay|ofiii|直播|备用|備用|備援|高清|標清|超清/g, '')
    // 4K / 8K / HD 等解析度標記不影響頻道識別
    .replace(/[248]K\b/gi, '')
    .replace(/FHD|UHD|HD\b/gi, '');
}

// ---------- M3U 解析 ----------

function parseM3U(text) {
  const entries = [];
  let pending = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      const attrRe = /([A-Za-z0-9_-]+)="([^"]*)"/g;
      let m;
      while ((m = attrRe.exec(line)) !== null) attrs[m[1]] = m[2];

      const commaIdx = line.indexOf(',');
      const name = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : '';

      pending = {
        name,
        group: attrs['group-title'] || '',
        logo: attrs['tvg-logo'] || '',
        tvgId: attrs['tvg-id'] || '',
        // 部分來源（如 suxuang 的 4K 台）需要特定的 User-Agent 才能取得串流
        httpUserAgent: attrs['http-user-agent'] || '',
        httpReferrer: attrs['http-referrer'] || '',
      };
    } else if (line.startsWith('#EXTGRP:')) {
      if (pending) pending.group = line.slice('#EXTGRP:'.length).trim();
    } else if (!line.startsWith('#')) {
      if (pending) {
        pending.url = line;
        entries.push(pending);
        pending = null;
      }
    }
  }

  return entries;
}

// ---------- 頻道比對 ----------

function matchChannel(entry) {
  if (EXCLUDE_GROUP_PATTERNS.some((p) => p.test(entry.group))) return null;

  const haystack = `${entry.name} ${entry.group}`;
  if (!GROUP_KEYWORDS.some((k) => haystack.includes(k))) return null;

  const clean = cleanName(entry.name);

  // 1) 先比對明確對照表（CCTV、鳳凰等）
  const keys = Object.keys(CHINA_CHANNEL_MAP).sort(
    (a, b) => b.length - a.length,
  );
  for (const key of keys) {
    if (clean.includes(key)) {
      return { key, ...CHINA_CHANNEL_MAP[key] };
    }
  }

  // 2) 各省衛視：清單用簡體，轉繁體後比對
  const trad = toTraditional(clean);
  const provinceEntries = Object.entries(PROVINCE_MAP);
  for (const [slug, def] of provinceEntries) {
    if (trad.includes(`${def.cn}衛視`)) {
      return {
        key: slug,
        name: def.name,
        category: 'local',
        id: `cn-${slug}`,
      };
    }
  }

  return null;
}

// ---------- 串流探測 ----------

/**
 * 探測串流，確認：
 *   - HTTP 200
 *   - 內容是合法 m3u8
 *   - **不是 VOD**（沒有 #EXT-X-ENDLIST）—— 直播必須沒有 ENDLIST
 */
async function probeStream(url, extraHeaders = {}) {
  if (!url.startsWith('http')) {
    return { ok: false, reason: '非 http 網址' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': extraHeaders['User-Agent'] || UA,
        Origin: 'https://taiwan-live-tv.netlify.app',
        ...extraHeaders,
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };

    const acao = res.headers.get('access-control-allow-origin');
    const cors = acao !== null;

    const reader = res.body.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const head = new TextDecoder().decode(value.slice(0, 1500));

    if (!head.trimStart().startsWith('#EXTM3U')) {
      return { ok: false, reason: '非 m3u8' };
    }
    if (head.includes('#EXT-X-ENDLIST')) {
      return { ok: false, reason: 'VOD（非直播）' };
    }
    if (head.includes('PLAYLIST-TYPE:VOD')) {
      return { ok: false, reason: 'VOD（非直播）' };
    }

    return { ok: true, cors, isMaster: head.includes('EXT-X-STREAM-INF') };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? '逾時' : e.name };
  } finally {
    clearTimeout(timer);
  }
}

/** 依清單指定的 http-user-agent / http-referrer 組出請求標頭 */
function buildHeaders(entry) {
  const headers = {};
  if (entry.httpUserAgent) headers['User-Agent'] = entry.httpUserAgent;
  if (entry.httpReferrer) headers['Referer'] = entry.httpReferrer;
  return headers;
}

// ---------- 主流程 ----------

async function main() {
  const channels = JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'));
  const existingById = new Map(channels.channels.map((c) => [c.channel_id, c]));
  console.log('═'.repeat(70));
  console.log('中國大陸頻道匯入');
  console.log('═'.repeat(70));
  console.log(
    `模式：${DRY_RUN ? 'dry-run（不寫檔）' : '實際寫入'}｜探測：${NO_PROBE ? '關閉' : '開啟'}`,
  );
  console.log('');

  // ---- 步驟 1：讀取並解析所有清單 ----
  const files = [
    ['yang', 'YanG IPTV 清單'],
    ['kimentanm', 'Kimentanm APTV 測試源'],
    ['itvlist', 'itvlist 聚合源'],
    ['suxuang', 'suxuang 聚合源'],
    ['kuliao', '褲佬 清單'],
  ];

  /** channelId → { def, entries: [{url, sourceId, sourceLabel}] } */
  const candidates = new Map();

  for (const [fileId, label] of files) {
    const path = join(PLAYLIST_DIR, `${fileId}.m3u`);
    if (!existsSync(path)) {
      console.log(`  ⚠️ 找不到 ${fileId}.m3u，略過`);
      continue;
    }
    const entries = parseM3U(readFileSync(path, 'utf8'));
    let matched = 0;

    for (const entry of entries) {
      const hit = matchChannel(entry);
      if (!hit) continue;
      matched++;

      const id =
        hit.id ??
        `cn-${hit.key.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}`;
      if (!candidates.has(id)) {
        candidates.set(id, { id, def: hit, entries: [] });
      }
      const bucket = candidates.get(id);
      bucket.entries.push({
        url: entry.url,
        sourceId: fileId,
        sourceLabel: label,
        group: entry.group,
        httpUserAgent: entry.httpUserAgent,
        httpReferrer: entry.httpReferrer,
      });
    }
    console.log(`  ${label}: ${entries.length} 筆，其中 ${matched} 筆符合中國頻道條件`);
  }

  console.log('');
  console.log(`符合條件的中國頻道：${candidates.size} 個`);
  console.log('');

  // ---- 步驟 2：探測（並行） ----
  const results = [];
  const limit = LIMIT ?? candidates.size;
  const buckets = [...candidates.entries()].slice(0, limit);

  /**
   * 並行探測所有候選網址。
   *
   * 為什麼要並行：候選網址數量可達數百個，
   * 逐一圈探測（每個最長 15 秒逾時）會花掉數十分鐘。
   *
   * 快取鍵用 `url + headers`，因為同一個網址在不同清單可能
   * 需要不同的 User-Agent。
   */
  const allJobs = buckets.flatMap(([, b]) =>
    b.entries.map((e) => ({
      url: e.url,
      headers: buildHeaders(e),
      entry: e,
    })),
  );
  console.log(`  探測 ${allJobs.length} 個網址（並行）…`);

  const probeResults = new Map();
  const CONCURRENCY = 16;
  let done = 0;

  async function worker(queue) {
    while (queue.length) {
      const job = queue.shift();
      // --no-probe 時完全不發網路請求，直接標記為可用
      const r = NO_PROBE
        ? { ok: true, cors: true }
        : await probeStream(job.url, job.headers);
      probeResults.set(job.entry, r);
      done++;
      if (done % 40 === 0) {
        process.stdout.write(`  探測中 ${done}/${allJobs.length}\r`);
      }
    }
  }

  const queue = [...allJobs];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, () => worker(queue)),
  );
  process.stdout.write(' '.repeat(40) + '\r');
  console.log(`  探測完成：${done} 個`);

  for (const [id, bucket] of buckets) {
    const working = [];
    for (const e of bucket.entries) {
      const r = probeResults.get(e);
      if (!r) continue;
      if (NO_PROBE) {
        working.push({ ...e, cors: true });
        continue;
      }
      if (r.ok) working.push({ ...e, cors: r.cors });
    }

    if (working.length === 0) {
      console.log(`  ✗ ${bucket.def.name} — 無可用來源`);
      continue;
    }

    // 優先選 CORS 開啟的來源（Web 版可直接播放，省頻寬）
    working.sort((a, b) => (b.cors ? 1 : 0) - (a.cors ? 1 : 0));
    const best = working[0];

    const status = existingById.has(id) ? '↻' : '+';
    console.log(
      `  ${status} ${bucket.def.name} — ${working.length} 個可用來源` +
        `（${best.sourceLabel}）${best.cors ? ' [CORS 直連]' : ' [需代理]'}`,
    );

    results.push({ id, bucket, best, working });
  }

  console.log('');
  console.log(`可匯入：${results.length} 個`);

  if (DRY_RUN) {
    console.log('\n(dry-run 模式，未寫入檔案)');
    return;
  }

  // ---- 步驟 3：寫入 ----
  let added = 0;
  let updated = 0;

  for (const { id, bucket, best, working } of results) {
    const existing = existingById.get(id);
    const now = new Date().toISOString();

    const backupUrls = working
      .filter((w) => w.url !== best.url)
      .map((w) => ({
        url: w.url,
        source: w.sourceLabel,
        cors: w.cors,
      }));

    if (existing) {
      existing.stream_url = best.url;
      existing.cors_enabled = best.cors;
      existing.last_checked = now;
      existing.http_user_agent = best.httpUserAgent || null;
      existing.http_referrer = best.httpReferrer || null;
      existing.playlist_source = {
        provider: best.sourceId,
        provider_label: best.sourceLabel,
        provider_url: SOURCE_WEBSITES[best.sourceId] ?? '',
        raw_channel_name: bucket.def.name,
        backup_urls: backupUrls,
      };
      updated++;
      continue;
    }

    const channelId = id;
    channels.channels.push({
      channel_id: channelId,
      channel_name: bucket.def.name,
      name_en: null,
      category: bucket.def.category,
      channel_number: null,
      logo: null,
      stream_url: best.url,
      stream_type: 'hls',
      source_name: `${bucket.def.name}（經 ${best.sourceLabel} 轉載）`,
      source_website: SOURCE_WEBSITES[best.sourceId] ?? '',
      authorization_status: 'user_provided',
      is_active: true,
      last_checked: now,
      description: `${bucket.def.name} — 中國大陸頻道，來源為使用者提供的 IPTV 清單轉載`,
      tags: ['中國', '大陸', 'iptv', best.sourceId],
      region: '中國',
      cors_enabled: best.cors,
      http_user_agent: best.httpUserAgent || null,
      http_referrer: best.httpReferrer || null,
      notes:
        '轉載自第三方 IPTV 清單（非廣播商官方來源），授權狀態為使用者提供。',
      playlist_source: {
        provider: best.sourceId,
        provider_label: best.sourceLabel,
        provider_url: SOURCE_WEBSITES[best.sourceId] ?? '',
        raw_channel_name: bucket.def.name,
        backup_urls: backupUrls,
      },
    });
    added++;
  }

  channels.updated_at = nowIso();
  writeFileSync(CHANNELS_PATH, JSON.stringify(channels, null, 2) + '\n', 'utf8');
  console.log('');
  console.log(`新增 ${added} 個｜更新 ${updated} 個｜總頻道 ${channels.channels.length}`);
  console.log('\n下一步：node scripts/validate-channels.mjs && node scripts/sync-channels.mjs');
}

function nowIso() {
  return new Date().toISOString();
}

const SOURCE_WEBSITES = {
  yang: 'https://iptv.yang-1989.xyz/playlist.m3u',
  kimentanm: 'https://bit.ly/iptv-aptv',
  itvlist: 'https://bit.ly/itvlist',
  suxuang: 'https://bit.ly/suxuang-v4',
  kuliao: 'https://iptv.445569.xyz/live.m3u',
};

main();
