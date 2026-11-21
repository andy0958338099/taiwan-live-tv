#!/usr/bin/env node
/**
 * 篩選 iptv-org 的台灣頻道候選。
 *
 * ## 篩選原則（依使用者要求：「台灣節目優先，有問題的不要」）
 *
 * 排除：
 *   1. **Geo-blocked** — iptv-org 明確標記 `[Geo-blocked]`，
 *      台灣以外的 IP 會被擋。伺服器在美國（Netlify），必定被擋。
 *   2. **rtmp://** — 瀏覽器不支援 RTMP，hls.js 也無法處理。
 *   3. **Not 24/7** — 不是 24 小時播出的頻道。
 *      使用者要看的是「電視台直播」，這種會在非播出時間黑屏。
 *   4. **實測無法播放** — manifest 取不到、不是直播（VOD）、
 *      或 segment 抓不到。
 *
 * 保留並優先：
 *   · 24/7 播出的台灣電視台／宗教台／文化台
 *   · HTTPS 來源優先（Web 版不需要代理也能播）
 *   · 官方來源（akamaihd.net、wcetv.com、now.amagi.tv 等）
 *
 * 輸出：shared/iptv-org-tw.json（候選清單 + 篩選結果）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SCRATCH = '/Users/andy/.hermes/cache/scratch';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/**
 * 讀取 iptv-org 的台灣頻道。
 *
 * ## 來源優先順序
 *
 * 1. `countries/tw.m3u` —— **台灣專屬清單**（iptv-org 官方文件推薦的地址）。
 *    只含台灣頻道，且比總清單多幾個（例如 NTD TV Asia-Pacific、
 *    HBO/Cinemax Asia Taiwan —— 這些在總清單裡因為沒有 `.tw` 後綴而漏掉）。
 * 2. `index.m3u` —— 總清單，作為補充（有些頻道只在總清單裡出現）。
 *
 * 使用者提供的參考明確指出：直接用 iptv-org 官方的台灣清單最穩，
 * 因為它是官方維護、GitHub Actions 每日自動更新、失效連結會自動修正。
 */
async function loadTaiwanChannels() {
  const SOURCES = [
    { url: 'https://iptv-org.github.io/iptv/countries/tw.m3u', label: 'countries/tw.m3u' },
    { url: 'https://iptv-org.github.io/iptv/index.m3u', label: 'index.m3u' },
  ];

  const merged = new Map();

  for (const src of SOURCES) {
    let text;
    try {
      const res = await fetch(src.url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) {
        console.log(`  ⚠ ${src.label} HTTP ${res.status} — 略過`);
        continue;
      }
      text = await res.text();
    } catch (e) {
      console.log(`  ⚠ ${src.label} 抓取失敗：${e.message} — 略過`);
      continue;
    }

    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    let added = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.startsWith('#EXTINF')) continue;
      const url = lines[i + 1];
      if (!url || url.startsWith('#')) continue;

      const mid = line.match(/tvg-id="([^"]+)"/);
      const mname = line.match(/,([^,]+)$/);
      const mlogo = line.match(/tvg-logo="([^"]+)"/);
      const mgroup = line.match(/group-title="([^"]+)"/);

      const tvgId = mid?.[1] ?? '';
      const rawName = mname?.[1]?.trim() ?? '';
      // 判斷是不是台灣頻道：
      //   · tvg-id 帶 .tw@ 或 @Taiwan
      //   · 來自 countries/tw.m3u 的全部都是
      const isTaiwan =
        src.label === 'countries/tw.m3u' ||
        /\.tw@/.test(tvgId) ||
        /@Taiwan$/.test(tvgId);
      if (!isTaiwan) continue;

      const key = url;
      if (merged.has(key)) continue;
      merged.set(key, {
        id: tvgId,
        name: rawName,
        logo: mlogo?.[1] ?? '',
        group: mgroup?.[1] ?? '',
        url,
        from: src.label,
      });
      added++;
    }
    console.log(`  ✓ ${src.label}: ${added} 個台灣頻道`);
  }

  return [...merged.values()];
}


/** 現有頻道清單（用於去重比對） */
const catalog = JSON.parse(readFileSync(join(ROOT, 'shared', 'channels.json'), 'utf8'));

/**
 * 名稱正規化，比對中英文。
 *
 * iptv-org 用英文（"TVBS-Asia"），我們用中文（"TVBS Asia"）。
 */
function normalize(s) {
  return String(s)
    .replace(/\(.*?\)/g, '')
    .replace(/[【】\[\]]/g, '')
    .replace(/[\s\-_·・,，.。'"]/g, '')
    .toLowerCase()
    .trim();
}

/** 現有頻道的正規化名稱集合 */
const existingNames = new Set(catalog.channels.map((c) => normalize(c.channel_name)));
const existingUrls = new Set(catalog.channels.map((c) => c.stream_url));

/**
 * 從 iptv-org 的英文名推斷中文名。
 *
 * 這是「台灣優先」的關鍵 —— 使用者看到的是中文介面，
 * 匯入的頻道名要是中文才不會突兀。
 */
const NAME_MAP = {
  'beautiful life tv': '美麗人生電視',
  'cgntv chinese': 'CGNTV 中文台',
  'cti variety': '中天 Variety 綜藝台',
  'cts': '華視',
  'daai 1': '大愛電視',
  'daai 2': '大愛電視二台',
  'dali tv': '大立電視',
  'discovery asia taiwan': '探索頻道台灣',
  'good 2': 'GOOD TV 真理台',
  'good tv': 'GOOD TV 綜合台',
  'hakka tv': '客家電視台',
  'indigenous tv': '原住民族電視台',
  'momo tv': 'MOMO 購物台',
  'pts 3': '公視三台',
  'sjtv': '三立電視',
  'supreme master tv': '無極電視',
  'taiwan indigenous tv': '台灣原住民族電視台',
  'taiwan plus tv': 'Taiwan Plus TV',
  'ttv': '台視',
  'ttv news': '台視新聞',
  'tvbs-asia': 'TVBS Asia',
  'wxtv': 'WXTV 網路台',
  'cts news': '華視新聞',
  'ebc financial news': '東森財經新聞台',
  'ebc news': '東森新聞台',
  'ebc foreign movie': '東森洋片台',
  'ftv': '民視',
  'ftv one': '民視一台',
  'ftv taiwan': '民視台灣台',
  'set news': '三立新聞台',
  'tvbs news': 'TVBS 新聞台',
  // countries/tw.m3u 獨有
  'animax asia taiwan': 'Animax Asia 台灣',
  'axn asia taiwan': 'AXN Asia 台灣',
  'cinemax asia taiwan': 'Cinemax Asia 台灣',
  'hbo asia taiwan': 'HBO Asia 台灣',
  'ntd tv asia-pacific': '新唐人亞太台',
};

/**
 * 台灣四大無線台 + 有線新聞台的分類對應。
 *
 * 「台灣節目優先」不只是排序，還要**分類正確** ——
 * 使用者在「新聞台」分類應該看到 TVBS、中天、東森、三立、公視、
 * 台視、華視、民視，而不是被歸到「地方或其他」。
 */
const CATEGORY_MAP = {
  '華視': 'general',
  '台視': 'general',
  '民視': 'general',
  '民視一台': 'general',
  '民視台灣台': 'general',
  '中視': 'general',
  '中天 Variety 綜藝台': 'entertainment',
  '大愛電視': 'general',
  '大愛電視二台': 'general',
  '大立電視': 'general',
  'TVBS Asia': 'entertainment',
  'TVBS 新聞台': 'news',
  '東森新聞台': 'news',
  '東森財經新聞台': 'finance',
  '東森洋片台': 'entertainment',
  '三立新聞台': 'news',
  '三立電視': 'general',
  '公視三台': 'public',
  '客家電視台': 'public',
  '原住民族電視台': 'public',
  '台灣原住民族電視台': 'public',
  '新唐人亞太台': 'general',
  '無極電視': 'general',
  '美麗人生電視': 'general',
  'GOOD TV 綜合台': 'general',
  'GOOD TV 真理台': 'general',
  'CGNTV 中文台': 'general',
  'Taiwan Plus TV': 'general',
  '台視新聞': 'news',
  '華視新聞': 'news',
  'WXTV 網路台': 'general',
  'MOMO 購物台': 'life',
  'Animax Asia 台灣': 'entertainment',
  'AXN Asia 台灣': 'entertainment',
  'Cinemax Asia 台灣': 'entertainment',
  'HBO Asia 台灣': 'entertainment',
};

function toChineseName(raw) {
  const base = normalize(raw);
  // 先去掉解析度與標記
  const key = base
    .replace(/\d{3,4}p/g, '')
    .replace(/geoblocked|not247|undefined|24h/g, '')
    .trim();
  if (NAME_MAP[key]) return NAME_MAP[key];
  // 嘗試以原始名稱的前段比對
  for (const [k, v] of Object.entries(NAME_MAP)) {
    if (base.startsWith(k)) return v;
  }
  return raw.replace(/\s*\([^)]*\)\s*/g, '').trim();
}

/**
 * 判定候選是否有問題。
 *
 * @returns {{ ok: boolean, reasons: string[] }}
 */
function screenOut(t) {
  const reasons = [];
  const name = t.name;

  // 1. Geo-blocked —— iptv-org 明確標記
  if (/\[Geo-blocked\]/i.test(name)) reasons.push('geo-blocked');

  // 2. RTMP —— 瀏覽器不支援
  if (/^rtmp:\/\//i.test(t.url)) reasons.push('rtmp');

  // 3. Not 24/7 —— 非全天播出
  if (/\[Not 24\/7\]/i.test(name)) reasons.push('not-24/7');

  return { ok: reasons.length === 0, reasons };
}

/**
 * 實測一個 URL 是不是可播的直播。
 *
 * 檢查鏈：
 *   manifest → 是不是 #EXTM3U → 是不是直播（沒有 #EXT-X-ENDLIST）
 *   → 跟隨子 manifest → 取第一個 segment → 抓開頭確認是串流內容
 */
async function probe(url) {
  const result = {
    url,
    ok: false,
    reason: '',
    manifestKind: null,
    targetDuration: null,
    segmentUrl: null,
    segmentBytes: 0,
    segmentMs: null,
  };

  let m3u;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      result.reason = `manifest HTTP ${res.status}`;
      return result;
    }
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    if (!text.trimStart().startsWith('#EXTM3U')) {
      result.reason = `不是 manifest（content-type=${ct}）`;
      return result;
    }
    m3u = text;
    result.manifestKind = ct.includes('mpegurl') ? 'mpegurl' : 'text';
  } catch (e) {
    /**
     * 診斷 fetch 失敗的原因。
     *
     * `fetch failed` 只是外層包裝，真正的原因在 `e.cause`：
     *   · ENOTFOUND → 網域解析失敗（來源已下架）
     *   · ECONNREFUSED → 主機拒絕連線（來源已關閉）
     *   · ETIMEDOUT → 連線逾時（多半是**地理限制** ——
     *     台灣的來源常只允許台灣 IP，我們的伺服器在美國）
     *   · ECONNRESET → 連線被重置
     *   · CERT_* → TLS 憑證問題
     */
    const cause = e.cause;
    const code = cause?.code ?? cause?.message ?? e.message;
    result.reason = `manifest 失敗：${code}`;
    result.error_code = code ?? null;
    result.error_detail = cause?.message ?? null;
    return result;
  }

  // VOD 檢查
  if (/#EXT-X-ENDLIST/.test(m3u)) {
    result.reason = '是 VOD（有 #EXT-X-ENDLIST），不是直播';
    return result;
  }

  const td = m3u.match(/#EXT-X-TARGETDURATION:\s*([\d.]+)/);
  result.targetDuration = td ? parseFloat(td[1]) : null;

  // 取 segment 列表
  const lines = m3u.split('\n').map((l) => l.trim()).filter(Boolean);
  let segs = lines.filter((l) => !l.startsWith('#'));
  if (!segs.length) {
    result.reason = 'manifest 內沒有 segment';
    return result;
  }
  segs = segs.map((s) => (s.startsWith('http') ? s : new URL(s, url).href));

  // master manifest → 跟隨第一個子 manifest
  if (!/\.(ts|m4s|mp4|aac)(\?|$)/i.test(segs[0])) {
    try {
      const subRes = await fetch(segs[0], {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(20000),
      });
      if (!subRes.ok) {
        result.reason = `子 manifest HTTP ${subRes.status}`;
        return result;
      }
      const subText = await subRes.text();
      if (!subText.trimStart().startsWith('#EXTM3U')) {
        result.reason = '子 manifest 不是 m3u8';
        return result;
      }
      if (/#EXT-X-ENDLIST/.test(subText)) {
        result.reason = '子 manifest 是 VOD';
        return result;
      }
      const subTd = subText.match(/#EXT-X-TARGETDURATION:\s*([\d.]+)/);
      if (subTd) result.targetDuration = parseFloat(subTd[1]);
      const subSegs = subText
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((s) => (s.startsWith('http') ? s : new URL(s, segs[0]).href));
      if (!subSegs.length) {
        result.reason = '子 manifest 內沒有 segment';
        return result;
      }
      segs = subSegs;
    } catch (e) {
      result.reason = `子 manifest 失敗：${e.message}`;
      return result;
    }
  }

  // 抓一個 segment 確認內容
  const seg = segs[Math.max(0, segs.length - 1)];
  result.segmentUrl = seg;
  try {
    const t0 = Date.now();
    const res = await fetch(seg, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok && res.status !== 206) {
      result.reason = `segment HTTP ${res.status}`;
      return result;
    }
    const reader = res.body?.getReader();
    if (!reader) {
      result.reason = 'segment 沒有回應內容';
      return result;
    }
    const first = await reader.read();
    if (first.done || !first.value || first.value.byteLength === 0) {
      result.reason = 'segment 是空的';
      return result;
    }
    const head = first.value;
    // MPEG-TS 的開頭必須是 0x47（sync byte）
    const isTs = head[0] === 0x47;
    // fMP4 必須有 ftyp box
    const isMp4 =
      head.byteLength >= 8 &&
      head[4] === 0x66 &&
      head[5] === 0x74 &&
      head[6] === 0x79 &&
      head[7] === 0x70;
    if (!isTs && !isMp4) {
      const ascii = new TextDecoder()
        .decode(head.slice(0, 40))
        .replace(/[^\x20-\x7e]/g, '.');
      result.reason = `segment 開頭不是串流內容（可能是錯誤頁：${ascii}）`;
      return result;
    }
    result.segmentBytes = head.byteLength;
    result.segmentMs = Date.now() - t0;
    result.ok = true;
    return result;
  } catch (e) {
    result.reason = `segment 失敗：${e.message}`;
    return result;
  }
}

// ── 主流程 ──
console.log('════ 讀取 iptv-org 台灣頻道 ════\n');
const tw = await loadTaiwanChannels();
console.log(`  合計 ${tw.length} 個台灣頻道\n`);

console.log('════ iptv-org 台灣頻道篩選 ════\n');

const candidates = [];
const rejected = [];

for (const t of tw) {
  const screen = screenOut(t);
  const key = normalize(t.name);
  const dup = existingNames.has(key) || existingUrls.has(t.url);

  const chineseName = toChineseName(t.name);

  const entry = {
    tvg_id: t.id,
    raw_name: t.name,
    name: chineseName,
    group: t.group,
    category: CATEGORY_MAP[chineseName] ?? 'general',
    logo: t.logo,
    url: t.url,
    is_https: t.url.startsWith('https://'),
    from: t.from,
    duplicate_of_existing: dup,
    screen_reasons: screen.reasons,
  };

  if (dup) {
    entry.reason = '已存在於清單中';
    rejected.push(entry);
    continue;
  }
  if (!screen.ok) {
    entry.reason = `靜態篩選排除：${screen.reasons.join(', ')}`;
    rejected.push(entry);
    continue;
  }
  candidates.push(entry);
}

console.log(`靜態篩選：通過 ${candidates.length}，排除 ${rejected.length}\n`);

// ── 實測 ──
console.log('════ 實測播放 ════\n');
const accepted = [];
for (const c of candidates) {
  process.stdout.write(`  ${c.name.padEnd(20)} `);
  const r = await probe(c.url);
  if (r.ok) {
    const mb = r.segmentBytes / 1024 / 1024;
    console.log(
      `✓ ${String(r.segmentMs).padStart(5)}ms  ${mb.toFixed(2)}MB  ` +
        `td=${r.targetDuration ?? '?'}s  ${c.is_https ? 'HTTPS' : 'http'}`,
    );
    accepted.push({
      ...c,
      probe: {
        target_duration: r.targetDuration,
        segment_bytes: r.segmentBytes,
        segment_ms: r.segmentMs,
        segment_url: r.segmentUrl,
      },
    });
  } else {
    console.log(`✗ ${r.reason}`);
    rejected.push({ ...c, reason: `實測失敗：${r.reason}` });
  }
}

console.log(`\n════ 結果 ════`);
console.log(`  通過：${accepted.length}`);
console.log(`  排除：${rejected.length}`);

/**
 * 台灣節目優先的排序。
 *
 * 使用者明確要求「以台灣節目優先」。排序邏輯：
 *   1. 台灣四大無線台（台視/中視/華視/民視）與公共電視優先
 *   2. 有線新聞台（TVBS/中天/東森/三立/公視）次之
 *   3. 其他台灣本土台再次
 *   4. 國際台（Animax/AXN/HBO/Cinemax）最後
 *
 * 同層內以「來源可信度」排序：官方 CDN 的來源排前面。
 */
const TIER1 = ['台視', '中視', '華視', '民視', '公視三台'];
const TIER2 = [
  'TVBS 新聞台', '東森新聞台', '東森財經新聞台', '三立新聞台',
  'TVBS Asia', '台視新聞', '華視新聞', '中天 Variety 綜藝台',
  '三立電視', '東森洋片台', '公視', '客家電視台',
];

function tierOf(name) {
  if (TIER1.includes(name)) return 0;
  if (TIER2.includes(name)) return 1;
  if (/台灣|Taiwan|台視|華視|民視|中視|大愛|大立|三立|東森|中天|TVBS|客家|原住民|公視|GOOD TV|無極|美麗人生|CGNTV|MOMO|WXTV/i.test(name)) {
    return 2;
  }
  return 3; // 國際台
}

/** 官方 CDN 的可信度（分數越高越可信） */
function trustScore(c) {
  let s = 0;
  if (c.is_https) s += 10;
  if (/akamai|akamaized|akamaihd|now\.amagi|streamlock|wcetv|akamaistream/i.test(c.url)) s += 8;
  if (/suprememastertv|streamipcf/i.test(c.url)) s += 5;
  if (/^http:\/\//i.test(c.url)) s -= 3;
  if (/\?key=/i.test(c.url)) s -= 4; // 需要簽章的來源較不穩
  if (/\.php\?/i.test(c.url)) s -= 2;
  return s;
}

accepted.sort((a, b) => {
  const ta = tierOf(a.name);
  const tb = tierOf(b.name);
  if (ta !== tb) return ta - tb;
  const sa = trustScore(a);
  const sb = trustScore(b);
  if (sa !== sb) return sb - sa;
  return a.name.localeCompare(b.name, 'zh-Hant');
});

console.log('\n通過清單（台灣優先排序）：');
accepted.forEach((a, i) => {
  const tier = tierOf(a.name);
  const tierLabel = ['【無線/公共】', '【新聞/主流】', '【本土台】', '【國際台】'][tier];
  console.log(
    `  ${String(i + 1).padStart(2)}. ${tierLabel} ${a.name.padEnd(22)} ` +
      `${a.is_https ? 'HTTPS' : 'http '} ${a.raw_name.slice(0, 34)}`,
  );
});

console.log('\n排除原因統計：');
const reasonCount = {};
for (const r of rejected) {
  const k = r.reason.replace(/：.*$/, '');
  reasonCount[k] = (reasonCount[k] || 0) + 1;
}
for (const [k, n] of Object.entries(reasonCount)) {
  console.log(`  ${String(n).padStart(2)} × ${k}`);
}

console.log('\n排除明細：');
for (const r of rejected) {
  console.log(`  ${r.raw_name.slice(0, 42).padEnd(44)} ${r.reason}`);
}

const out = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  source: 'https://iptv-org.github.io/iptv/index.m3u',
  accepted,
  rejected,
};
writeFileSync(
  join(SCRATCH, 'iptv-org-tw-result.json'),
  JSON.stringify(out, null, 2) + '\n',
  'utf8',
);
console.log(`\n已寫入 ${join(SCRATCH, 'iptv-org-tw-result.json')}`);
