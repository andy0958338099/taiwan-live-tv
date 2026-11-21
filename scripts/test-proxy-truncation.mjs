#!/usr/bin/env node
/**
 * test-proxy-truncation.mjs — 驗證代理是否回傳「被截斷的 segment」
 *
 * ## 背景（2026-11-21 線上實測）
 *
 * 央視來源的 segment 高達 5.4 MB，而 Netlify edge 到該來源的實測速度
 * 只有 38–100 KB/s → 單一個 segment 需要 90–140 秒。
 *
 * 但 Netlify 會在 **約 30.4 秒**切斷 function 的回應。
 * 結果：客戶端拿到 `HTTP 200` + **被截斷的 segment**（只到 1.2–1.7 MB），
 * 而且因為回應帶著 `Cache-Control: public, max-age=300`，
 * **被截斷的內容會被 CDN 快取 5 分鐘**，散播給所有使用者。
 *
 * ## 為什麼不能用「直接抓上游」來比對
 *
 * 代理回應的目標網址是**簽章過的**（`/api/proxy/<base64url(target)>?sig=...`），
 * 直接把上游網址塞進代理路徑會被 403（不在允許清單、也沒有簽章）。
 *
 * 所以正確的作法是：
 *   1. 走代理拿 manifest → 取出**代理改寫後**的 segment 網址
 *   2. 把那個網址的 base64url path 段解碼 → 還原成上游網址
 *   3. 直接抓上游 → 取得完整長度（Content-Range / Content-Length）
 *   4. 走代理抓同一個 segment → 取得代理實際送出的位元組數
 *   5. 比對
 *
 * ## 判定
 *
 *   · 代理位元組 < 上游總長 → **代理截斷了**（且會被 CDN 快取）
 *   · 兩者相同 → 代理沒有截斷
 *
 * 用法：node scripts/test-proxy-truncation.mjs [--base https://taiwan-live-tv.netlify.app]
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const BASE = arg('base', 'https://taiwan-live-tv.netlify.app');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const encodeTarget = (t) => Buffer.from(t, 'utf8').toString('base64url');

/** 讀完整個回應主體 */
async function readAll(res, capMs = 120_000) {
  const t0 = Date.now();
  let n = 0;
  const reader = res.body?.getReader();
  if (!reader) return { bytes: 0, ms: 0, truncated: false };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (Date.now() - t0 > capMs) {
        await reader.cancel().catch(() => {});
        return { bytes: n, ms: Date.now() - t0, truncated: true };
      }
    }
  } catch (e) {
    return { bytes: n, ms: Date.now() - t0, truncated: true, error: e.message };
  }
  return { bytes: n, ms: Date.now() - t0, truncated: false };
}

/** 從代理網址還原上游網址（base64url path 段） */
function upstreamOf(proxyUrl) {
  const m = proxyUrl.match(/\/api\/proxy\/([^/?]+)/);
  if (!m) return null;
  try {
    return Buffer.from(m[1], 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

async function main() {
  console.log('═'.repeat(72));
  console.log('驗證：代理是否回傳被截斷的 segment（且被 CDN 快取）');
  console.log('═'.repeat(72));
  console.log(`測試站點：${BASE}\n`);

  const catalog = JSON.parse(
    readFileSync(join(ROOT, 'shared', 'channels.json'), 'utf8'),
  );

  // 挑「segment 大、來自慢速 host」的頻道 —— 這些最容易被截斷
  const candidates = catalog.channels
    .filter((c) => c.stream_url && !c.embed_url)
    .filter((c) => {
      try {
        return ['121.19.134.149:808', '222.134.245.16:9901'].includes(
          new URL(c.stream_url).host,
        );
      } catch {
        return false;
      }
    })
    .slice(0, 3);

  let anyTruncated = false;

  for (const ch of candidates) {
    console.log(`▶ ${ch.channel_name} (${ch.channel_id})`);

    // ── 1. 走代理拿 manifest ──
    const manifestUrl = `${BASE}/api/proxy/${encodeTarget(ch.stream_url)}`;
    const mres = await fetch(manifestUrl, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(30_000),
    });
    const mtext = await mres.text();
    if (mres.status !== 200) {
      console.log(`  manifest HTTP ${mres.status} —— 略過\n`);
      continue;
    }

    // ── 2. 取出代理改寫後的 segment 網址 ──
    const proxiedSegment = mtext
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && l.includes('/api/proxy'))[0];
    if (!proxiedSegment) {
      console.log('  manifest 沒有 segment —— 略過\n');
      continue;
    }
    const proxiedSegUrl = new URL(proxiedSegment, BASE).href;
    const upstreamSegUrl = upstreamOf(proxiedSegUrl);
    if (!upstreamSegUrl) {
      console.log('  無法還原上游網址 —— 略過\n');
      continue;
    }

    // ── 3. 直接抓上游 → 完整長度 ──
    const hres = await fetch(upstreamSegUrl, {
      headers: { 'User-Agent': UA, Range: 'bytes=0-' },
      signal: AbortSignal.timeout(30_000),
    });
    const cr = hres.headers.get('content-range');
    const total = cr
      ? Number(cr.split('/')[1])
      : Number(hres.headers.get('content-length'));
    await hres.body?.cancel();
    console.log(`  上游 segment 總長：${total} bytes`);

    // ── 4. 走代理抓同一個 segment ──
    //
    // ⚠️ **必須帶 `Range: bytes=0-`**，與 hls.js 的行為一致。
    //
    // 實測：央視來源的 host（`121.19.134.149:808`）在**沒有 Range 標頭**時
    // 會回 404 + 163 bytes 的 HTML 錯誤頁；只有帶 Range 才回真正的 segment。
    // hls.js 對 segment 一律送 Range，所以測試也必須帶，
    // 否則量到的不是「播放器實際走的路徑」。
    const t0 = Date.now();
    const pres = await fetch(proxiedSegUrl, {
      headers: { 'User-Agent': UA, Range: 'bytes=0-' },
      signal: AbortSignal.timeout(120_000),
    });
    const via = await readAll(pres);
    const cc = pres.headers.get('cache-control') || '';
    const age = pres.headers.get('age');
    console.log(
      `  代理回應：HTTP ${pres.status}  bytes=${via.bytes}/${total}  ` +
        `(${total ? ((via.bytes / total) * 100).toFixed(1) : '?'}%)  ` +
        `耗時=${via.ms}ms`,
    );
    console.log(
      `  Cache-Control: ${cc}   Age: ${age ?? '（無）'}   ` +
        `content-length: ${pres.headers.get('content-length') ?? '（無）'}`,
    );

    // ── 5. 判定 ──
    const truncated = total > 0 && via.bytes < total;
    if (truncated) anyTruncated = true;
    console.log(
      `  判定：${truncated ? '✗ 代理回傳了被截斷的 segment' : '✓ 代理回傳完整 segment'}` +
        `${truncated && /max-age=[1-9]/.test(cc) ? '（且會被 CDN 快取！）' : ''}\n`,
    );
  }

  console.log('═'.repeat(72));
  console.log(
    `結果：${anyTruncated ? '✗ 代理會回傳被截斷的 segment' : '✓ 代理沒有回傳被截斷的 segment'}`,
  );
  console.log('═'.repeat(72));
  process.exit(anyTruncated ? 1 : 0);
}

await main();
