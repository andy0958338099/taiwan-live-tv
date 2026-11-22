#!/usr/bin/env node
/**
 * audit-all-user-path.mjs — ⭐ 以「使用者實際會走的路徑」為準的巡檢
 *
 * ## 為什麼需要這支（2026-11-22 第 2 輪實測）
 *
 * 第 1 輪建立的 `audit-all-via-proxy.mjs` 有兩個根本性的判斷錯誤：
 *
 * 1. **判定路徑錯了**。
 *    `web/src/lib/useHlsPlayer.ts` 的 `needsProxy()` 決定要不要走代理：
 *      · `cors_enabled === false` → 走代理
 *      · 網址是 `http://`（混合內容）→ 走代理
 *      · 其餘（`cors_enabled === true` + https）→ **瀏覽器直連，不走代理**
 *    所以對 `cors_enabled: true` 的頻道用代理路徑判定，
 *    等於用「使用者不會走的路徑」去下結論。
 *    實測：TVBS 經代理被 CloudFront 回 403（Netlify egress IP 被擋），
 *    但直連 master/child/segment 全部 200 + CORS `*` + MPEG-TS —— 使用者看得到。
 *
 * 2. **取 segment 的方式錯了**。
 *    舊版只取清單的**最後一行**。但代理在收到帶 `Range` 的請求時會把
 *    manifest 截成前 2KB → 最後一行是被截斷的 → 網址簽章是斷的 → 502。
 *    實測：廣東體育台／廣東珠江台／CGNTV／真善美 四個頻道因此被誤判失效，
 *    但實際首／中／尾 segment 全部 206 + 0x47。
 *
 * 這支修正以上兩點：
 *   · **依 `cors_enabled` 與協定決定走哪條路徑**（直連 or 代理）
 *   · master 的**每個 variant** 都試；每個 child 取**多個位置**的 segment
 *   · 每次都帶**重試**（上游多後端負載平衡會隨機回 404/502）
 *
 * ## 判定口徑（沿用 2026-11-22 固定口徑）
 *   1. manifest 以 `#EXTM3U` 開頭、不含 `#EXT-X-ENDLIST`
 *   2. 子清單最多遞迴 2 層
 *   3. segment 用 `Range: bytes=0-2047` 抓前 2KB
 *   4. 位元組嗅探：首位 0x47 = MPEG-TS、ISO-BMFF box = fMP4 → 通過
 *   5. 開頭 '<'（HTML）/ FF D8（JPEG）/ 89 50（PNG）→ 失效
 *   6. 網址含 youtube.com / youtu.be → 失效
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
const OUT = arg('out', '/Users/andy/.hermes/cache/scratch/user-path-audit.json');

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
  const headers = { 'User-Agent': UA, Origin: ORIGIN };
  if (range) headers.Range = 'bytes=0-2047';
  try {
    const res = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      buf,
      cors: res.headers.get('access-control-allow-origin'),
      final: res.url,
    };
  } catch (e) {
    return { status: 0, buf: Buffer.alloc(0), cors: null, final: url, err: e.name ?? e.message };
  }
}

const seqOf = (t) => {
  const m = t.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m);
  return m ? Number(m[1]) : null;
};

/** 取出清單裡的網址列（網址列 + 標籤裡的 URI="..."） */
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

/** 這台瀏覽器對這個頻道實際會走哪條路徑（與 useHlsPlayer.ts 的 needsProxy 對齊） */
function userPath(channel) {
  if (channel.cors_enabled === false) return 'proxy';
  if (!channel.stream_url) return 'proxy';
  if (channel.stream_url.startsWith('http://')) return 'proxy';
  return 'direct';
}

/**
 * 驗證單一頻道的主來源。
 * @param {object} channel channels.json 的頻道條目
 */
async function audit(channel) {
  const url = channel.stream_url;
  const path = userPath(channel);
  const base = path === 'proxy' ? `${PROXY}/${enc(url)}` : url;

  if (/youtube\.com|youtu\.be/i.test(url)) {
    return { ok: false, path, reason: 'YouTube 網址，非 HLS 源' };
  }

  // ── 第 0 層：master manifest ───────────────────────────────────
  const m = await fetchBuf(base);
  if (m.status !== 200) {
    const detail = m.buf.length ? m.buf.subarray(0, 140).toString('utf8') : (m.err ?? '');
    return { ok: false, path, reason: `master HTTP ${m.status} ${detail}`.trim() };
  }
  let text = m.buf.toString('utf8');
  if (!text.trimStart().startsWith('#EXTM3U')) {
    return { ok: false, path, reason: `master 不是 #EXTM3U（首位 ${sniff(m.buf).first}）` };
  }
  if (text.includes('#EXT-X-ENDLIST')) {
    return { ok: false, path, reason: 'master 是 VOD（含 #EXT-X-ENDLIST）' };
  }

  // ── master 的每一個 variant 都試 ─────────────────────────────
  const isMaster = text.includes('#EXT-X-STREAM-INF');
  const children = isMaster ? manifestLines(text) : [null];
  if (!children.length) return { ok: false, path, reason: 'master 沒有任何子項' };

  const variantReports = [];
  let best = null;

  for (let ci = 0; ci < children.length; ci++) {
    const childUrl = isMaster
      ? (path === 'proxy' ? abs(children[ci]) : new URL(children[ci], m.final).toString())
      : null;
    let mediaText = text;
    let mediaSeq = seqOf(text);
    let mediaBase = m.final;

    if (childUrl) {
      // ⭐ child manifest 一律抓完整版（帶 Range 會被截成 2KB → 最後一行簽章斷掉）
      const c = await fetchBuf(childUrl);
      if (c.status !== 200) {
        variantReports.push({ variant: ci, ok: false, reason: `child HTTP ${c.status}` });
        continue;
      }
      const ct = c.buf.toString('utf8');
      if (!ct.trimStart().startsWith('#EXTM3U')) {
        variantReports.push({ variant: ci, ok: false, reason: 'child 不是 #EXTM3U' });
        continue;
      }
      if (ct.includes('#EXT-X-ENDLIST')) {
        variantReports.push({ variant: ci, ok: false, reason: 'child 是 VOD' });
        continue;
      }
      mediaText = ct;
      mediaBase = c.final;
      mediaSeq = seqOf(ct) ?? mediaSeq;
    }

    const segs = manifestLines(mediaText);
    if (!segs.length) {
      variantReports.push({ variant: ci, ok: false, reason: 'child 沒有 segment' });
      continue;
    }

    // ── 取多個位置的 segment（頭／中／尾／尾-1）────────────────
    const picks = [...new Set([
      0,
      Math.floor(segs.length / 2),
      segs.length - 1,
      segs.length - 2,
    ])].filter((i) => i >= 0 && i < segs.length);

    let good = 0;
    const segReports = [];
    for (const i of picks) {
      const su = path === 'proxy'
        ? abs(segs[i])
        : new URL(segs[i], mediaBase).toString();
      let r = null;
      let s = { kind: 'empty', first: '??' };
      for (let attempt = 1; attempt <= RETRIES; attempt++) {
        r = await fetchBuf(su, { range: true });
        s = sniff(r.buf);
        if ((r.status === 200 || r.status === 206) && (s.kind === 'mpegts' || s.kind === 'fmp4')) {
          break;
        }
        if (attempt < RETRIES) await new Promise((res) => setTimeout(res, 400 * attempt));
      }
      const isGood =
        (r.status === 200 || r.status === 206) && (s.kind === 'mpegts' || s.kind === 'fmp4');
      if (isGood) good++;
      segReports.push({ index: i, status: r.status, kind: s.kind, first: s.first, ok: isGood });
    }

    const variantOk = good > 0;
    variantReports.push({
      variant: ci,
      ok: variantOk,
      seq: mediaSeq,
      segments: `${good}/${picks.length}`,
      details: segReports,
    });
    if (variantOk && !best) {
      best = {
        variant: ci,
        seq: mediaSeq,
        segments: `${good}/${picks.length}`,
        kind: segReports.find((x) => x.ok)?.kind,
      };
    }
  }

  const variantsOk = variantReports.filter((v) => v.ok).length;

  if (!best) {
    const reason = variantReports
      .map((v) => `v${v.variant}:${v.reason ?? `${v.segments ?? ''}`}`)
      .join(' / ');
    return {
      ok: false,
      path,
      reason: `全部 ${children.length} 個 variant 失敗（${reason}）`,
      variants: variantReports,
    };
  }

  const out = {
    ok: true,
    path,
    reason: '',
    variants_ok: variantsOk,
    variants_total: children.length,
    best_variant: best.variant,
    seq: best.seq ?? null,
    kind: best.kind,
    segments_ok: best.segments,
  };

  // ── 停播檢查：MEDIA-SEQUENCE 必須會前進 ────────────────────────
  if (WITH_SEQ && best.seq != null) {
    await new Promise((r) => setTimeout(r, 12000));
    const again = await fetchBuf(base);
    if (again.status === 200) {
      const seq2 = seqOf(again.buf.toString('utf8'));
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
  console.log(`使用者路徑巡檢 ${targets.length} 個 HLS 頻道主來源`);
  console.log('═'.repeat(78));

  const results = [];
  const queue = [...targets];
  let done = 0;

  async function worker() {
    while (queue.length) {
      const ch = queue.shift();
      let r;
      try {
        r = await audit(ch);
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
    console.log(`  ✗ ${r.channel_name.padEnd(20)} [${r.path ?? '-'}] ${r.reason}`);
    console.log(`      ${r.stream_url}`);
  }
  console.log('─'.repeat(78));
  console.log(`通過 ${ok.length}/${results.length}｜不通過 ${bad.length}`);
  console.log(`（直連 ${ok.filter((r) => r.path === 'direct').length}｜代理 ${ok.filter((r) => r.path === 'proxy').length}）`);

  const out = { audited_at: new Date().toISOString(), results };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`寫入 ${OUT}`);
}

await main();
