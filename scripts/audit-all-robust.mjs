#!/usr/bin/env node
/**
 * audit-all-robust.mjs — 全清單「代理路徑」嚴格巡檢（修正版）
 *
 * ## 為什麼需要這支（2026-11-22 第 2 輪實測）
 *
 * 舊的 `audit-all-via-proxy.mjs` 有**系統性的假陰性**：
 *
 * 1. **只取清單的最後一行當 segment 候選。**
 *    代理在收到帶 `Range` 的請求時，會把 manifest 截成前 2KB 回傳
 *    （上游收到 Range → 只給前 2048 bytes → manifest 的最後一行是**被截斷的**）。
 *    拿截斷清單的最後一行去抓 segment → 網址簽章是斷的 → 代理回 502。
 *    實測：廣東體育台／廣東珠江台／CGNTV／真善美 四個頻道因此被誤判失效，
 *    但實際上它們的首／中／尾 segment 全部 HTTP 206 + 首位 0x47（MPEG-TS）。
 *
 * 2. **master manifest 只試最後一個 variant。**
 *    CGNTV 的 5 個 variant 中，第 5 個（`_5.m3u8`）上游整組壞掉，
 *    但前 4 個 variant 完全正常。只試最後一個 → 整個頻道被誤判失效。
 *
 * 3. **沒有重試。** 上游多後端負載平衡會隨機回 404/502，
 *    單次失敗就判死。
 *
 * ## 這支的判定口徑（沿用 2026-11-22 固定口徑）
 *
 * 1. manifest 必須以 `#EXTM3U` 開頭，且不含 `#EXT-X-ENDLIST`
 * 2. manifest 內若有子清單，最多再遞迴 2 層
 * 3. 取 segment，用 `Range: bytes=0-2047` 抓前 2KB
 * 4. 位元組嗅探：首位 `0x47` = MPEG-TS、ISO-BMFF box = fMP4 → 通過；
 *    開頭是 `<` = HTML、`FF D8` / `89 50` = 圖片 → 失效
 * 5. URL 含 `youtube.com`／`youtu.be` → 判失效
 *
 * ## 與舊版的差異
 *
 *  · master 的**每一個 variant** 都試
 *  · 每個 child 取**多個位置**的 segment（頭／中／尾／尾-1）
 *  · 每個 segment 有**重試**（上游負載平衡的隨機 miss）
 *  · manifest 一律抓**完整版**（不帶 Range），避免被截斷
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHANNELS_PATH = join(ROOT, 'shared', 'channels.json');

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);

const CONC = parseInt(arg('conc', '4'), 10);
const ONLY = (arg('ids', '') || '').split(',').filter(Boolean);
const RETRIES = parseInt(arg('retries', '2'), 10);
const WITH_SEQ = flag('seq');
const OUT = arg('out', '/Users/andy/.hermes/cache/scratch/proxy-audit.json');

const ORIGIN = 'https://taiwan-live-tv.netlify.app';
const PROXY = `${ORIGIN}/api/proxy`;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const enc = (u) => Buffer.from(u).toString('base64url');
const abs = (p) => (p.startsWith('/') ? `${ORIGIN}${p}` : p);

const ISO_BMFF_BOX_TYPES = new Set([
  'ftyp', 'styp', 'moof', 'mdat', 'moov', 'sidx', 'emsg', 'prft', 'pdin', 'free', 'skip',
]);

function sniff(buf) {
  if (!buf || buf.length === 0) return { kind: 'empty', first: '??' };
  const first = buf[0].toString(16).padStart(2, '0');
  if (buf[0] === 0x47) return { kind: 'mpegts', first };
  const box = buf.subarray(4, 8).toString('latin1');
  if (ISO_BMFF_BOX_TYPES.has(box)) return { kind: 'fmp4', first };
  if (buf[0] === 0x3c) return { kind: 'html', first };
  if (buf[0] === 0xff && buf[1] === 0xd8) return { kind: 'jpeg', first };
  if (buf[0] === 0x89 && buf[1] === 0x50) return { kind: 'png', first };
  return { kind: 'other', first };
}

async function fetchBuf(url, { range = false, timeout = 40000 } = {}) {
  const headers = { 'User-Agent': UA };
  if (range) headers.Range = 'bytes=0-2047';
  try {
    const res = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buf, headers: res.headers };
  } catch (e) {
    return { status: 0, buf: Buffer.alloc(0), err: e.name ?? e.message };
  }
}

const seqOf = (t) => {
  const m = t.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m);
  return m ? Number(m[1]) : null;
};

const uriList = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

function manifestLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) {
      const m = t.match(/URI="([^"]+)"/);
      if (m) out.push(m[1]);
      continue;
    }
    out.push(t);
  }
  return out;
}

/**
 * 驗證單一 HLS 網址（走正式站代理路徑）。
 * 回傳 { ok, reason, ... }
 */
async function audit(url) {
  if (/youtube\.com|youtu\.be/i.test(url)) {
    return { ok: false, reason: 'YouTube 網址，非 HLS 源' };
  }

  // ── 第 0 層：master manifest（**不帶 Range**，避免被截成 2KB）─────────
  const m = await fetchBuf(`${PROXY}/${enc(url)}`);
  if (m.status !== 200) {
    const detail = m.buf.length
      ? m.buf.subarray(0, 160).toString('utf8')
      : (m.err ?? '');
    return { ok: false, reason: `master HTTP ${m.status} ${detail}`.trim() };
  }
  let text = m.buf.toString('utf8');
  if (!text.startsWith('#EXTM3U')) {
    return { ok: false, reason: `master 不是 #EXTM3U（首位 ${sniff(m.buf).first}）` };
  }
  if (text.includes('#EXT-X-ENDLIST')) {
    return { ok: false, reason: 'master 是 VOD（含 #EXT-X-ENDLIST）' };
  }

  // ── master 的每一個 variant 都試 ─────────────────────────────────
  const isMaster = text.includes('#EXT-X-STREAM-INF');
  const children = isMaster ? manifestLines(text) : [null];
  if (!children.length) return { ok: false, reason: 'master 沒有任何子項' };

  const variantReports = [];
  let best = null;

  for (let ci = 0; ci < children.length; ci++) {
    const childUrl = isMaster ? abs(children[ci]) : null;
    let mediaText = text;
    let mediaSeq = seqOf(text);

    if (childUrl) {
      // ⭐ child manifest 一律抓完整版（帶 Range 會被截斷 → 最後一行簽章斷掉）
      const c = await fetchBuf(childUrl);
      if (c.status !== 200) {
        variantReports.push({ variant: ci, ok: false, reason: `child HTTP ${c.status}` });
        continue;
      }
      const ct = c.buf.toString('utf8');
      if (!ct.startsWith('#EXTM3U')) {
        variantReports.push({ variant: ci, ok: false, reason: 'child 不是 #EXTM3U' });
        continue;
      }
      if (ct.includes('#EXT-X-ENDLIST')) {
        variantReports.push({ variant: ci, ok: false, reason: 'child 是 VOD' });
        continue;
      }
      mediaText = ct;
      mediaSeq = seqOf(ct) ?? mediaSeq;
    }

    const segs = manifestLines(mediaText);
    if (!segs.length) {
      variantReports.push({ variant: ci, ok: false, reason: 'child 沒有 segment' });
      continue;
    }

    // ── 取多個位置的 segment（頭／中／尾／尾-1）────────────────────
    const picks = [...new Set([
      0,
      Math.floor(segs.length / 2),
      segs.length - 1,
      segs.length - 2,
    ])].filter((i) => i >= 0 && i < segs.length);

    let good = 0;
    let tried = 0;
    const segReports = [];
    for (const i of picks) {
      tried++;
      const su = abs(segs[i]);
      let r = null;
      for (let attempt = 1; attempt <= RETRIES; attempt++) {
        r = await fetchBuf(su, { range: true });
        const s = sniff(r.buf);
        if ((r.status === 200 || r.status === 206) && (s.kind === 'mpegts' || s.kind === 'fmp4')) {
          break;
        }
        if (attempt < RETRIES) await new Promise((res) => setTimeout(res, 400 * attempt));
      }
      const s = sniff(r.buf);
      const isGood =
        (r.status === 200 || r.status === 206) && (s.kind === 'mpegts' || s.kind === 'fmp4');
      if (isGood) good++;
      segReports.push({
        index: i,
        status: r.status,
        kind: s.kind,
        first: s.first,
        bytes: r.buf.length,
        ok: isGood,
      });
    }

    const variantOk = good > 0;
    variantReports.push({
      variant: ci,
      ok: variantOk,
      seq: mediaSeq,
      segments: `${good}/${tried}`,
      details: segReports,
    });
    if (variantOk && !best) {
      best = { variant: ci, seq: mediaSeq, segments: `${good}/${tried}`, kind: segReports.find((x) => x.ok)?.kind };
    }
  }

  const variantsOk = variantReports.filter((v) => v.ok).length;

  if (!best) {
    const reason = variantReports
      .map((v) => `v${v.variant}:${v.reason ?? `${v.segments ?? ''}`}`)
      .join(' / ');
    return { ok: false, reason: `全部 ${children.length} 個 variant 失敗（${reason}）`, variants: variantReports };
  }

  const out = {
    ok: true,
    reason: '',
    variants_ok: variantsOk,
    variants_total: children.length,
    best_variant: best.variant,
    seq: best.seq ?? null,
    kind: best.kind,
    segments_ok: best.segments,
  };

  // ── 停播檢查：MEDIA-SEQUENCE 必須會前進 ──────────────────────────
  if (WITH_SEQ && best.seq != null) {
    await new Promise((r) => setTimeout(r, 12000));
    const again = await fetchBuf(`${PROXY}/${enc(url)}`);
    if (again.status === 200) {
      const t2 = again.buf.toString('utf8');
      const seq2 = seqOf(t2);
      if (seq2 != null && seq2 === best.seq) {
        out.ok = false;
        out.reason = `已停播（序號停在 ${best.seq}）`;
      } else if (seq2 != null) {
        out.seq_after = seq2;
      }
    }
  }

  return { ...out, variants: variantReports };
}

async function main() {
  const catalog = JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'));
  let targets = catalog.channels.filter((c) => !c.embed_url && c.stream_url);
  if (ONLY.length) targets = targets.filter((c) => ONLY.includes(c.channel_id));

  console.log('═'.repeat(78));
  console.log(`代理路徑嚴格巡檢 ${targets.length} 個 HLS 頻道主來源（每個 variant × 多個 segment 位置 × 重試）`);
  console.log('═'.repeat(78));

  const results = [];
  const queue = [...targets];
  let done = 0;

  async function worker() {
    while (queue.length) {
      const ch = queue.shift();
      let r;
      try {
        r = await audit(ch.stream_url);
      } catch (e) {
        r = { ok: false, reason: `例外 ${e.name ?? e.message}` };
      }
      results.push({
        channel_id: ch.channel_id,
        channel_name: ch.channel_name,
        region: ch.region,
        cors_enabled: ch.cors_enabled,
        stream_url: ch.stream_url,
        ...r,
      });
      done++;
      process.stdout.write(`  驗證中 ${done}/${targets.length}\r`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));
  process.stdout.write(' '.repeat(40) + '\r');

  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);

  console.log('\n不通過：');
  for (const r of bad) {
    console.log(`  ✗ ${r.channel_name.padEnd(20)} ${r.reason}`);
    console.log(`      ${r.stream_url}`);
  }
  console.log('─'.repeat(78));
  console.log(`通過 ${ok.length}/${results.length}｜不通過 ${bad.length}`);

  const out = { audited_at: new Date().toISOString(), results };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`已寫入 ${OUT}`);
}

await main();
