#!/usr/bin/env node
/**
 * 檢查「segment 網址重用」—— max-age=300 的 P0 風險（位元組層級判定）
 *
 * ## 為什麼要檢查這個
 *
 * 代理對 segment 回 `Cache-Control: public, max-age=300, s-maxage=300`。
 * 這只有在「**同一個 segment 網址永遠只對應同一份內容**」時才安全。
 *
 * 直播 segment 網址有兩種型態：
 *
 *   1. **唯一型**（帶遞增序號／token）
 *      例：`live_1_1_30826733.ts`、`live-ch1-3Num9012.ts`
 *      每個網址只被下載一次，內容不可變 → 快取安全 ✅
 *
 *   2. **循環型**（固定檔名，內容被覆寫）
 *      例：`live.ts`、`segment.ts`
 *      同一個網址持續被覆寫成新內容。
 *      CDN 會把舊的影片釘住最多 5 分鐘 →
 *      使用者看到的直播**停在 5 分鐘前的畫面** ❌ P0
 *
 * ## 關鍵：滑動視窗的自然重疊不算重用
 *
 * 直播 playlist 是滑動視窗 —— 同一個 segment 網址會連續出現在
 * 連續兩次擷取中（那是**同一個 segment**，內容沒有變）。
 * 只看「網址有沒有重複」會產生大量假陽性。
 *
 * ## 正確的判定：位元組比較
 *
 * 對「兩次擷取都出現」的網址 U：
 *   1. 直接向上游要 U 的位元組 → hash H1（**繞過代理快取**，否則拿到的是快取值）
 *   2. 等一段時間
 *   3. 再直接向上游要 U 的位元組 → hash H2
 *   4. **H1 ≠ H2 → 網址被覆寫 → P0**（CDN 會把舊內容釘住）
 *      H1 == H2 → 同一個 segment，內容沒變 → 安全 ✅
 *
 * 若上游對同一網址回 404（segment 已過期）→ 不會被再用到 → 安全。
 *
 * 用法：
 *   node scripts/check-segment-url-reuse.mjs
 *   node scripts/check-segment-url-reuse.mjs --base https://taiwan-live-tv.netlify.app --wait 25
 *   node scripts/check-segment-url-reuse.mjs --ids cn-cctv1,tw-goodtv-ch1
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/* ---------- 參數 ---------- */
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const BASE = String(arg('base', 'https://taiwan-live-tv.netlify.app')).replace(/\/$/, '');
const WAIT = Number(arg('wait', 25));
const ONLY = arg('ids', null);
const TIMEOUT = Number(arg('timeout', 25_000));
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/* ---------- 工具 ---------- */
const enc = (t) => Buffer.from(t, 'utf8').toString('base64url');

async function getText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 直接向上游取 segment 的前 N bytes → hash。
 *
 * ⚠️ **繞過代理**：代理會快取 segment，直接打代理會拿到快取值，
 * 比對不出「內容是否被覆寫」。必須直接打上游。
 *
 * 部分上游沒有 Range 標頭會回 404（實測央視來源），所以一律帶
 * `Range: bytes=0-<N>`。
 */
async function upstreamHash(url, bytes = 131_072) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Range: `bytes=0-${bytes - 1}` },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok && res.status !== 206) {
      return { ok: false, status: res.status, hash: null };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: true,
      status: res.status,
      hash: createHash('sha256').update(buf).digest('hex').slice(0, 16),
      len: buf.byteLength,
    };
  } catch (e) {
    return { ok: false, status: 0, hash: null, error: String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function extractUrls(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/** 把代理網址還原成原始上游網址 */
function decodeProxied(p) {
  const m = /\/api\/proxy\/([^?]+)/.exec(p);
  if (!m) return p;
  try {
    return Buffer.from(m[1], 'base64url').toString('utf8');
  } catch {
    return p;
  }
}

/** 取得某頻道「當下的 segment 上游網址清單」 */
async function snapshotSegments(streamUrl) {
  const master = await getText(`${BASE}/api/proxy/${enc(streamUrl)}`);
  if (master.status !== 200) {
    return { ok: false, reason: `master HTTP ${master.status}`, segs: [] };
  }
  const masterLines = extractUrls(master.text);
  const isMediaPlaylist = !/#EXT-X-STREAM-INF/.test(master.text);

  let childText = master.text;
  if (!isMediaPlaylist && masterLines.length > 0) {
    const child = await getText(`${BASE}${masterLines[0]}`);
    if (child.status !== 200) {
      return { ok: false, reason: `child HTTP ${child.status}`, segs: [] };
    }
    childText = child.text;
  }

  const segs = extractUrls(childText)
    .map((s) => (s.startsWith('/api/proxy/') ? decodeProxied(s) : s))
    .map((s) => {
      try {
        return new URL(s, streamUrl).toString();
      } catch {
        return s;
      }
    });

  return { ok: true, segs };
}

/* ---------- 主流程 ---------- */
const raw = JSON.parse(readFileSync(resolve(ROOT, 'shared/channels.json'), 'utf8'));
const all = raw.channels ?? raw;

let channels = all.filter((c) => c.is_active && c.stream_url && !c.embed_url);
if (ONLY) {
  const want = new Set(String(ONLY).split(',').map((s) => s.trim()));
  channels = channels.filter((c) => want.has(c.channel_id));
}

console.log('══════════════════════════════════════════════════════════════════');
console.log('檢查 segment 網址是否被覆寫（max-age=300 的 P0 風險，位元組層級）');
console.log('══════════════════════════════════════════════════════════════════');
console.log(`測試站點：${BASE}`);
console.log(`檢查 ${channels.length} 個頻道，間隔 ${WAIT} 秒`);
console.log('');

const risky = [];
const skipped = [];
let checked = 0;

for (const ch of channels) {
  process.stdout.write(`  ${ch.channel_id.padEnd(30)}`);
  let a, b;
  try {
    a = await snapshotSegments(ch.stream_url);
    if (!a.ok) {
      process.stdout.write(` 略過（${a.reason}）\n`);
      skipped.push({ id: ch.channel_id, reason: a.reason });
      continue;
    }
    await new Promise((r) => setTimeout(r, WAIT * 1000));
    b = await snapshotSegments(ch.stream_url);
    if (!b.ok) {
      process.stdout.write(` 略過（第二次 ${b.reason}）\n`);
      skipped.push({ id: ch.channel_id, reason: b.reason });
      continue;
    }
  } catch (e) {
    process.stdout.write(` 略過（${e instanceof Error ? e.message : String(e)}）\n`);
    skipped.push({ id: ch.channel_id, reason: String(e) });
    continue;
  }

  checked += 1;
  const setA = new Set(a.segs);
  const overlap = b.segs.filter((s) => setA.has(s));

  if (overlap.length === 0) {
    process.stdout.write(` ✓ ${b.segs.length} 個網址，皆不重疊\n`);
    continue;
  }

  // 位元組層級比對：同一網址在兩次擷取之間，內容有沒有變
  let changed = 0;
  let expired = 0;
  let same = 0;
  let unreadable = 0;
  const examples = [];

  for (const url of overlap) {
    const h1 = await upstreamHash(url);
    if (!h1.ok) {
      unreadable += 1;
      continue;
    }
    await new Promise((r) => setTimeout(r, 3000));
    const h2 = await upstreamHash(url);
    if (!h2.ok) {
      // 上游已過期（404）→ 網址不會再被用到 → 安全
      expired += 1;
      continue;
    }
    if (h1.hash !== h2.hash) {
      changed += 1;
      if (examples.length < 2) examples.push(url);
    } else {
      same += 1;
    }
  }

  const verdict =
    changed > 0
      ? ` ❌ ${changed} 個網址內容被覆寫 → CDN 會釘住舊內容`
      : ` ✓ 重疊 ${overlap.length}（相同 ${same}／已過期 ${expired}／無法讀 ${unreadable}）`;

  process.stdout.write(`${verdict}\n`);
  if (examples.length) {
    console.log(`      例：${examples[0].slice(0, 110)}`);
  }
  if (changed > 0) {
    risky.push({ id: ch.channel_id, name: ch.channel_name, changed, examples });
  }
}

console.log('');
console.log('══════════════════════════════════════════════════════════════════');
console.log(
  `檢查完成：${checked} 個頻道，${risky.length} 個有覆寫風險，${skipped.length} 個略過`,
);
console.log('══════════════════════════════════════════════════════════════════');

if (risky.length > 0) {
  console.log('');
  console.log('⚠️  內容會被覆寫的 segment 網址（代理不可對其使用 max-age=300）：');
  for (const r of risky) {
    console.log(`  · ${r.id} (${r.name}) — ${r.changed} 個`);
  }
  process.exitCode = 1;
} else {
  console.log('');
  console.log('✓ 沒有任何 segment 網址的內容會被覆寫 → max-age=300 安全');
}
