#!/usr/bin/env node
/**
 * enrich-channel-logos.mjs — 從原始 M3U 清單補齊頻道台標（logo）
 *
 * 問題：匯入時只帶了 stream_url，沒有把 `tvg-logo` 一起帶進來，
 *   導致 83 個頻道裡只有 8 個有 logo（其餘顯示首字佔位）。
 *
 * 做法：重新解析所有 M3U 清單，建立「頻道名稱 → logo URL」的對照表，
 *   再用模糊比對把 logo 對應到 shared/channels.json 的每個頻道。
 *
 * 比對策略（依序嘗試）：
 *   1. 完全相同
 *   2. 去掉裝飾標記後相同（清理引號、4K、備用、Relay 等）
 *   3. 簡繁轉換後相同
 *   4. 包含關係（清單名稱包含頻道名稱，或反之）
 *
 * 用法：node scripts/enrich-channel-logos.mjs [--dry-run]
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

const PLAYLISTS = ['yang', 'itvlist', 'suxuang', 'kuliao', 'kimentanm'];

/** 簡→繁 對照（只涵蓋頻道名稱常用字） */
const S2T = {
  视: '視', 东: '東', 苏: '蘇', 广: '廣', 辽: '遼', 宁: '寧',
  龙: '龍', 门: '門', 陕: '陝', 庆: '慶', 云: '雲', 贵: '貴',
  内: '內', 团: '團', 厦: '廈', 晋: '晉', 湘: '湘', 赣: '贛',
  豫: '豫', 皖: '皖', 冀: '冀', 桂: '桂', 滇: '滇', 黔: '黔',
  琼: '瓊', 华: '華', 凤: '鳳', 电: '電', 闻: '聞', 际: '際',
  综: '綜', 艺: '藝', 军: '軍', 奥: '奧', 戏: '戲', 农: '農',
  体: '體', 卫: '衛', 视: '視', 频: '頻', 道: '道', 发: '發',
  现: '現', 视: '視', 车: '車', 银: '銀', 药: '藥', 医: '醫',
};

/** 簡→繁 */
function toTrad(s) {
  return s
    .split('')
    .map((c) => S2T[c] ?? c)
    .join('');
}

/** 去除裝飾標記，讓比對只看核心名稱 */
function normalize(name) {
  return toTrad(
    name
      .replace(/[「」\[\]【】（）()·・\s]/g, '')
      .replace(/Relay|ofiii|備用|备用|備援|直播|高清|標清|超清/g, '')
      .replace(/[248]K\b/gi, '')
      .replace(/FHD|UHD|HD\b/gi, '')
      .replace(/[·・\-\s]+$/g, ''),
  );
}

/** 從 M3U 取得 頻道名稱 → logo */
function collectLogos(fileId) {
  const path = join(PLAYLIST_DIR, `${fileId}.m3u`);
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, 'utf8').split('\n');
  const out = [];
  let pending = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      const re = /([A-Za-z0-9_-]+)="([^"]*)"/g;
      let m;
      while ((m = re.exec(line)) !== null) attrs[m[1]] = m[2];
      const ci = line.indexOf(',');
      pending = {
        name: attrs['tvg-name'] || attrs['tvg-id'] || (ci >= 0 ? line.slice(ci + 1).trim() : ''),
        logo: attrs['tvg-logo'] || '',
      };
    } else if (!line.startsWith('#')) {
      if (pending?.logo) out.push({ ...pending, file: fileId });
      pending = null;
    }
  }
  return out;
}

/**
 * 手動對照表：專案頻道名稱 → 清單中的名稱。
 *
 * 為什麼需要：央視系列在本專案顯示為「央視-1 綜合」，
 * 但清單裡是「CCTV1」／「央视1」之類，模糊比對對不上。
 * 省衛視則是「湖南衛視」vs 清單的「湖南卫视」，簡繁轉換可解決。
 *
 * 值為「別名陣列」：依序嘗試，找到第一個「驗證可下載」的即採用。
 */
const MANUAL_ALIAS = {
  '央視-1 綜合': ['CCTV1', '央视1', '央视综合', 'CCTV-1'],
  '央視-2 財經': ['CCTV2', '央视2', '央视财经', 'CCTV-2'],
  '央視-3 綜藝': ['CCTV3', '央视3', '央视综艺', 'CCTV-3'],
  '央視-4 中文國際': ['CCTV4', '央视4', 'CCTV-4'],
  '央視-5 體育': ['CCTV5', '央视5', 'CCTV-5'],
  '央視-5+ 體育賽事': ['CCTV5+', 'CCTV5plus', '央视5+'],
  '央視-6 電影': ['CCTV6', '央视6', 'CCTV-6'],
  '央視-7 國防軍事': ['CCTV7', '央视7', 'CCTV-7'],
  '央視-8 劇集': ['CCTV8', '央视8', 'CCTV-8'],
  '央視-9 紀錄': ['CCTV9', '央视9', 'CCTV-9'],
  '央視-10 教育': ['CCTV10', '央视10', 'CCTV-10'],
  '央視-11 戲曲': ['CCTV11', '央视11', 'CCTV-11'],
  '央視-12 社會與法': ['CCTV12', '央视12', 'CCTV-12'],
  '央視-13 新聞': ['CCTV13', '央视13', 'CCTV-13', 'CCTV13新闻'],
  '央視-14 少兒': ['CCTV14', '央视14', 'CCTV-14'],
  '央視-15 音樂': ['CCTV15', '央视15', 'CCTV-15'],
  '央視-16 奧林匹克': ['CCTV16', '央视16', 'CCTV-16'],
  '央視-17 農業農村': ['CCTV17', '央视17', 'CCTV-17'],
  'CGTN 中國環球電視': ['CGTN', 'CGTN中文', 'CGTN Documentary'],
  '海峽衛視': ['海峡卫视', '海峽衛視', 'HTV'],
  '客家電視台': ['客家電視', '客家电视', 'HakkaTV', '客家综合'],
  '大愛電視（全球）': ['大愛電視', '大爱电视', 'DaAiTV', '大爱1台'],
  '公視網路直播': ['公視', '公視頻道', 'PTS', '公视3台'],
  '寰宇新聞台灣台': ['寰宇新聞', '寰宇新闻', 'GlobalNews'],
  '華視新聞 CH52': ['華視新聞', '华视新闻', 'CTS新聞', '华视新闻HD'],
  '中天新聞 CH52': ['中天新聞', '中天新闻', 'CTi新聞', '中天新闻台'],
  '鏡新聞 24H': ['鏡新聞', '镜新闻', 'Mnews', '鏡新聞24H'],
  '中視新聞台': ['中視新聞', '中视新闻', 'CTV新聞', '中视新闻HD'],
  '東森新聞 CH51': ['東森新聞', '东森新闻', 'EBC新聞', '东森新闻CH51'],
  '三立新聞台 CH54': ['三立新聞', '三立新闻', 'SETN', '三立新闻台'],
  '鳳凰衛視': ['凤凰卫视', '凤凰衛視', 'PhoenixInfo'],
  '鳳凰衛視香港台': ['凤凰香港台', '凤凰香港', 'PhoenixHK'],
  '鳳凰衛視中文台': ['凤凰中文台', '凤凰中文', 'PhoenixChinese'],
  '鳳凰衛視資訊台': ['凤凰资讯台', '凤凰资讯', 'PhoenixInfo'],
  '廣州南國都市台': ['广州南国都市', '南国都市', '南国都市4K'],
};

/**
 * 額外的 logo 來源：官方站點的台標。
 *
 * 為什麼需要：官方 embed 頻道（華視、中天、客家、大愛、公視等）
 * 在 IPTV 清單裡不一定有對應條目，或清單的 logo 網址已失效（404）。
 */
const OFFICIAL_LOGOS = {
  '客家電視台': 'https://www.hakkatv.org.tw/images/logo.png',
  '大愛電視（全球）': 'https://m.daai.tv/images/logo.png',
  '公視網路直播': 'https://www.pts.org.tw/images/logo.svg',
};

/**
 * 驗證 logo URL 是否真的取得得到圖片。
 *
 * 為什麼必要：IPTV 清單的 tvg-logo 有相當比例是 404。
 * 實測 `iptv.yang-1989.xyz/logo/湖南衛視.webp` 回 404，
 * 但 `CCTV1.webp` 正常 —— 因為來源只為「清單裡實際存在的名稱」放圖檔。
 * 若不驗證，網頁版會出現一堆壞圖（前端雖有 onError 隱藏，
 * 但那只是掩蓋問題，使用者看到的是空白佔位）。
 */
async function validateLogo(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const type = res.headers.get('content-type') || '';
    if (!type.startsWith('image/')) {
      return { ok: false, reason: `非圖片 (${type})` };
    }
    // 讀第一個 chunk 確認有實際內容
    const reader = res.body?.getReader();
    if (reader) {
      const { value } = await reader.read();
      await reader.cancel();
      if (!value || value.length < 100) {
        return { ok: false, reason: '內容過短' };
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? '逾時' : e.name };
  }
}

/**
 * 找同頻道的所有 logo 候選（依優先序）。
 *
 * 為什麼要收集「所有」而不是第一個：
 *   同一個頻道名稱在不同清單裡會對應到不同的 logo 網址，
 *   而其中相當比例是 404。例如「凤凰中文」有 4 個候選網址，
 *   必須全部驗證後才能挑到真正可用的那一個。
 */
function findLogoCandidates(name, norm, byExact, byNorm, byNameAll) {
  const candidates = [];

  // 1) 手動對照表（優先序最高）
  for (const alias of MANUAL_ALIAS[name] ?? []) {
    for (const l of byNameAll.get(alias) ?? []) candidates.push(l);
  }

  // 2) 原名完全相同
  for (const l of byNameAll.get(name) ?? []) candidates.push(l);

  // 3) 簡繁轉換後正規化相同
  for (const l of byNorm.get(norm) ?? []) candidates.push(l);

  // 4) 包含關係（雙向）
  for (const [k, list] of byNorm) {
    if (!k || k.length < 2) continue;
    if (norm.includes(k) || k.includes(norm)) candidates.push(...list);
  }

  // 5) 官方站台台標
  const off = OFFICIAL_LOGOS[name];
  if (off) candidates.push(off);

  return [...new Set(candidates)];
}

async function main() {
  console.log('═'.repeat(70));
  console.log('補齊頻道台標（logo）');
  console.log('═'.repeat(70));

  // ── 收集所有 logo ──
  const all = [];
  for (const p of PLAYLISTS) {
    const list = collectLogos(p);
    all.push(...list);
    console.log(`  ${p}: ${list.length} 筆帶 logo`);
  }

  // 建立索引（每個名稱對應「所有」logo 網址）
  const byExact = new Map(); // 原名 → [logo...]
  const byNorm = new Map(); // 正規化名 → [logo...]
  const byNameAll = new Map(); // 原名 → [logo...]（與 byExact 同義，供候選收集用）
  for (const item of all) {
    if (!item.logo) continue;
    if (!byExact.has(item.name)) byExact.set(item.name, []);
    byExact.get(item.name).push(item.logo);
    if (!byNameAll.has(item.name)) byNameAll.set(item.name, []);
    byNameAll.get(item.name).push(item.logo);

    const n = normalize(item.name);
    if (n) {
      if (!byNorm.has(n)) byNorm.set(n, []);
      byNorm.get(n).push(item.logo);
    }
  }
  console.log(
    `\n索引：${byExact.size} 個原名 / ${byNorm.size} 個正規化名` +
      `（${all.length} 筆 logo）\n`,
  );

  // ── 對應到頻道 ──
  const catalog = JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'));
  let matched = 0;
  let fixed = 0;
  const unmatched = [];
  const broken = [];

  // 收集所有要驗證的候選（避免重複驗證同一個網址）
  const toValidate = new Map(); // url → true
  for (const ch of catalog.channels) {
    const norm = normalize(ch.channel_name);
    const candidates = findLogoCandidates(
      ch.channel_name,
      norm,
      byExact,
      byNorm,
      byNameAll,
    );
    ch._candidates = candidates;
    for (const c of candidates) toValidate.set(c, true);
  }

  // ── 並行驗證所有候選 logo ──
  console.log(`\n驗證 ${toValidate.size} 個 logo 網址…`);
  const urls = [...toValidate.keys()];
  const validity = new Map();
  const CONC = 12;
  let done = 0;

  async function worker(queue) {
    while (queue.length) {
      const u = queue.shift();
      validity.set(u, await validateLogo(u));
      done++;
      if (done % 25 === 0) {
        process.stdout.write(`  驗證中 ${done}/${urls.length}\r`);
      }
    }
  }
  await Promise.all(
    Array.from({ length: CONC }, () => worker([...urls])),
  );
  process.stdout.write(' '.repeat(40) + '\r');

  const validCount = [...validity.values()].filter((v) => v.ok).length;
  console.log(`可用 logo：${validCount}/${urls.length}\n`);

  // ── 套用 ──
  for (const ch of catalog.channels) {
    const oldLogo = ch.logo;
    const chosen = ch._candidates.find((c) => validity.get(c)?.ok);
    delete ch._candidates;

    if (chosen) {
      ch.logo = chosen;
      if (!oldLogo) matched++;
      else if (oldLogo !== chosen) fixed++;
    } else {
      // 沒有任何可用 logo → 清掉（避免顯示壞圖）
      if (oldLogo) {
        const stillValid = validity.get(oldLogo)?.ok;
        if (stillValid === false) {
          broken.push({ name: ch.channel_name, url: oldLogo });
        }
      }
      if (!oldLogo) unmatched.push(ch.channel_name);
    }
  }

  console.log(`新補上：${matched} 個｜修正：${fixed} 個`);
  console.log(`仍無 logo：${unmatched.length} 個`);
  if (unmatched.length) {
    console.log('\n無 logo 的頻道（顯示首字佔位）：');
    for (const n of unmatched) console.log(`  · ${n}`);
  }
  if (broken.length) {
    console.log(`\n原有 logo 已失效（已清除）：${broken.length} 個`);
    for (const b of broken.slice(0, 10)) {
      console.log(`  ✗ ${b.name} — ${b.url.slice(0, 70)}`);
    }
  }

  if (DRY_RUN) {
    console.log('\n(dry-run 模式，未寫入檔案)');
    return;
  }

  catalog.updated_at = new Date().toISOString();
  writeFileSync(CHANNELS_PATH, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  console.log(`\n已寫入 ${CHANNELS_PATH}`);
}

await main();
