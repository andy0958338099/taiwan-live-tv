#!/usr/bin/env node
/**
 * 為缺少備援來源的頻道指派備援。
 *
 * ## 來源池
 *
 * 1. `shared/epg.json` 與其他已驗證的來源
 * 2. TVAPP 深度驗證結果（`/Users/andy/.hermes/cache/scratch/tvapp-tw-verified.json`）
 * 3. YanG 原始清單裡的**同碼**鏡像（不同主機）
 *
 * ## 指派原則
 *
 * **備援必須是同一個頻道。** 判斷依據：
 *   · 直接路徑型（`/{數字}/{碼}`）→ 碼必須與主來源相同
 *   · 轉址型（無數字目錄）→ 抓 manifest 看它內部指向哪個碼
 *   · 名稱完全相符 → 可接受
 *
 * ## 為什麼這很重要（實測 2026-11-21）
 *
 * 照片顯示：播放器 failover 到「備援來源 3/7」，畫面卻是
 * **龍華日韓台**，但 UI 顯示「龍華電視」。
 *
 * 根因：`import-playlists.mjs` 用 `clean.includes(key)` 模糊配對，
 * 把同家族的其他頻道當成了備援。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SCRATCH = '/Users/andy/.hermes/cache/scratch';
const SRC = join(ROOT, 'shared', 'channels.json');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const catalog = JSON.parse(readFileSync(SRC, 'utf8'));

/** 取 URL 最後一段的碼 */
function codeOf(url) {
  if (!url) return null;
  const clean = url.split('?')[0].split('#')[0].replace(/\/+$/, '');
  const seg = clean.split('/').pop() ?? '';
  return /^[a-z0-9]{3,12}$/i.test(seg) ? seg.toLowerCase() : null;
}

/** 是否為「/{數字}/{碼}」的直接路徑型 */
function isDirectChannelPath(url) {
  const clean = url.split('?')[0].split('#')[0].replace(/\/+$/, '');
  const segs = clean.split('/');
  return segs.length >= 2 && /^\d+$/.test(segs[segs.length - 2]);
}

/**
 * 取得 URL 實際指向的頻道碼。
 *
 * 轉址型（`http://r.jdshipin.com/qClQf`）的碼要抓 manifest 才知道。
 */
async function resolveCode(url) {
  const code = codeOf(url);
  if (code && isDirectChannelPath(url)) return code;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return code;
    const text = await res.text();
    if (!text.trimStart().startsWith('#EXTM3U')) return code;
    // master manifest → 取子 manifest；否則取第一個 segment
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const first = lines.find((l) => !l.startsWith('#'));
    if (!first) return code;
    if (!/\.(ts|m4s|mp4|aac)(\?|$)/i.test(first)) {
      // 是子 manifest → 抓它
      const sub = await fetch(first, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(12000),
      });
      if (!sub.ok) return code;
      const subText = await sub.text();
      const subFirst = subText
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#'));
      return codeOf(subFirst) ?? code;
    }
    return codeOf(first) ?? code;
  } catch {
    return code;
  }
}

/** 名稱正規化 */
const norm = (s) =>
  String(s)
    .replace(/\([^)]*\)/g, '')
    .replace(/[【】\[\]「」]/g, '')
    .replace(/[\s\-_·・,，.。'"/]/g, '')
    .toLowerCase()
    .trim();

// ── 收集候選來源池 ──
console.log('════ 收集已驗證的來源池 ════\n');

/** 來源池：{ code, url, source, verified } */
const pool = new Map();

// 1. YanG 清單裡的鏡像（已在 channels.json 裡，但被錯配了）
for (const ch of catalog.channels) {
  const backups = ch.playlist_source?.backup_urls ?? [];
  for (const b of backups) {
    const code = codeOf(b.url);
    if (!code) continue;
    const key = `${code}|${b.url}`;
    if (!pool.has(key)) {
      pool.set(key, {
        code,
        url: b.url,
        source: b.source ?? 'yang',
        verified: false,
      });
    }
  }
}

// 2. TVAPP 深度驗證結果
const tvappFile = join(SCRATCH, 'tvapp-tw-verified.json');
if (existsSync(tvappFile)) {
  const data = JSON.parse(readFileSync(tvappFile, 'utf8'));
  for (const v of data.verified) {
    const key = `tvapp|${v.url}`;
    if (!pool.has(key)) {
      pool.set(key, {
        code: null,
        url: v.url,
        source: `TVAPP（${v.sources.length} 源）`,
        name: v.name,
        verified: true,
        resolvedCode: null,
      });
    }
  }
}

console.log(`  來源池：${pool.size} 個`);

// ── 逐一頻道指派 ──
console.log('\n════ 為缺少備援的頻道指派 ════\n');

const assigned = [];
let index = 0;

for (const ch of catalog.channels) {
  const ps = ch.playlist_source;
  const existing = ps?.backup_urls ?? [];

  // 清理掉指向別的頻道的既有備援
  const mainCode = codeOf(ch.stream_url);
  const kept = existing.filter((b) => {
    const c = codeOf(b.url);
    if (!c || !isDirectChannelPath(b.url)) return true;
    return c === mainCode;
  });

  // 已有的（清理後）先收進去
  const used = new Set([ch.stream_url, ...kept.map((b) => b.url)]);
  const result = [...kept];

  // 從來源池找同頻道的備援
  if (mainCode) {
    for (const p of pool.values()) {
      if (result.length >= 3) break; // 每個頻道最多 3 個備援
      if (used.has(p.url)) continue;
      if (p.code && p.code !== mainCode) continue;
      if (!p.code && p.resolvedCode === undefined) {
        p.resolvedCode = await resolveCode(p.url);
      }
      if (p.code === null && p.resolvedCode && p.resolvedCode !== mainCode) continue;
      result.push({
        url: p.url,
        source: p.source,
        cors: false,
      });
      used.add(p.url);
    }
  }

  // 仍不足 → 用同名的 TVAPP 來源
  if (result.length === 0) {
    const selfNorm = norm(ch.channel_name);
    for (const p of pool.values()) {
      if (result.length >= 2) break;
      if (used.has(p.url)) continue;
      if (!p.name) continue;
      const pn = norm(p.name);
      // 名稱完全相符，或去掉「字幕/4K」後相符
      const pnCore = pn.replace(/字幕|webvtt|4k|hd|fhd|sd/g, '');
      const selfCore = selfNorm.replace(/字幕|webvtt|4k|hd|fhd|sd/g, '');
      if (pn === selfNorm || pnCore === selfCore) {
        result.push({ url: p.url, source: p.source, cors: false });
        used.add(p.url);
      }
    }
  }

  if (result.length !== existing.length) {
    if (!ch.playlist_source) ch.playlist_source = {};
    ch.playlist_source.backup_urls = result;
    const added = result.length - existing.length;
    assigned.push({
      channel: ch.channel_name,
      from: existing.length,
      to: result.length,
      added,
    });
  }
}

console.log('  變更的頻道：');
for (const a of assigned) {
  const tag = a.added > 0 ? `+${a.added}` : `${a.added}`;
  console.log(`    ${a.channel.padEnd(22)} ${a.from} → ${a.to}  (${tag})`);
}

catalog.updated_at = new Date().toISOString();
writeFileSync(SRC, JSON.stringify(catalog, null, 2) + '\n', 'utf8');

console.log(`\n  變更 ${assigned.length} 個頻道`);
const tw = catalog.channels.filter((c) => c.region === '台灣');
console.log(
  `  台灣頻道 ${tw.length} 個，其中有備援 ${tw.filter((c) => (c.playlist_source?.backup_urls?.length ?? 0) > 0).length} 個`,
);
