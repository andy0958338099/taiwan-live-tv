#!/usr/bin/env node
/**
 * test-proxy-truncation.mjs — 驗證代理是否會把 segment 截斷
 *
 * ## 問題現象
 *
 * 2026-11-21 線上實測發現：透過代理取得的 segment 都在**約 30.4 秒**後
 * 就結束，且只有 1.2–1.8 MB（完整 segment 應為 5.4 MB）。
 * 而**直接**向上游抓同一個 segment 完全正常。
 *
 * 懷疑對象：Netlify Functions 的執行時間上限（30 秒）。
 * 代理把上游的串流「串流出去」，function 必須存活到整個 segment 傳完 ——
 * 上游慢（50–200 KB/s）時，5.4 MB 需要 27–110 秒，遠遠超過上限，
 * function 被強制中斷 → 用戶拿到**被截斷的 segment**。
 *
 * 更糟的是回應帶 `Cache-Control: public, max-age=300`：
 * **被截斷的內容會被 CDN 快取 5 分鐘**，所有使用者都拿到壞的 segment。
 *
 * ## 本測試做三件事
 *
 *   [1] 直接抓上游 segment → 取得完整長度與位元組
 *   [2] 透過代理抓**同一個** segment → 取得代理給的長度與位元組
 *   [3] 比對兩者
 *
 * 判定：
 *   · 代理位元組 < 上游位元組 → **代理截斷**（function 被中斷）
 *   · 兩者相同 → 代理沒截斷
 *
 * 用法：node scripts/test-proxy-truncation.mjs [--base https://taiwan-live-tv.netlify.app]
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

/** 讀完整個回應主體，回報位元組數與耗時 */
async function readAll(res, capMs = 180_000) {
  const t0 = Date.now();
  let n = 0;
  const reader = res.body?.getReader();
  if (!reader) return { bytes: 0, ms: 0, aborted: false };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (Date.now() - t0 > capMs) {
        await reader.cancel().catch(() => {});
        return { bytes: n, ms: Date.now() - t0, aborted: true };
      }
    }
  } catch (e) {
    return { bytes: n, ms: Date.now() - t0, aborted: true, error: e.message };
  }
  return { bytes: n, ms: Date.now() - t0, aborted: false };
}

/** 取一個上游來源 + 它第一個 segment 的絕對網址 */
async function firstSegment(upstream) {
  const res = await fetch(upstream, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!text.trimStart().startsWith('#EXTM3U')) {
    throw new Error('manifest 不是 m3u8');
  }
  const segs = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (!segs.length) throw new Error('manifest 無 segment');
  return new URL(segs[0], upstream).href;
}

/** 候選上游（挑 segment 較大、較容易觸發截斷的來源） */
const CANDIDATES = [
  {
    name: '央視-1 綜合',
    upstream:
      'http://121.19.134.149:808/tsfile/live/0001_1.m3u8?key=txiptv&playlive=1&authid=0',
  },
  {
    name: '央視-7 國防軍事',
    upstream:
      'http://121.19.134.149:808/tsfile/live/0007_1.m3u8?key=txiptv&playlive=1&authid=0',
  },
];

async function main() {
  console.log('═'.repeat(70));
  console.log('驗證：代理是否截斷 segment（Netlify Function 執行時間上限）');
  console.log('═'.repeat(70));
  console.log(`測試站點：${BASE}\n`);

  let anyTruncated = false;

  for (const cand of CANDIDATES) {
    console.log(`▶ ${cand.name}`);
    const segUrl = await firstSegment(cand.upstream);
    console.log(`  上游 segment：${segUrl.slice(0, 100)}`);

    // ── [1] 直接抓上游 ──
    console.log('  [1] 直接抓上游 segment…');
    const directRes = await fetch(segUrl, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(180_000),
    });
    const direct = await readAll(directRes);
    console.log(
      `      HTTP ${directRes.status}  bytes=${direct.bytes}  ` +
        `耗時=${direct.ms}ms  平均=${Math.round(direct.bytes / (direct.ms / 1000))} B/s` +
        `${direct.aborted ? '  ⚠ 中途被砍斷' : ''}`,
    );

    // ── [2] 透過代理抓同一個 segment ──
    // 代理的 segment 網址是「上游 manifest 經代理改寫後」產生的簽章網址，
    // 目標網址就是上游 segment 本身 → 兩邊比的是同一份內容。
    console.log('  [2] 透過代理抓同一個 segment…');
    const proxiedTarget = `${BASE}/api/proxy/${encodeTarget(segUrl)}`;
    const proxyRes = await fetch(proxiedTarget, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(180_000),
    });
    const viaProxy = await readAll(proxyRes);
    console.log(
      `      HTTP ${proxyRes.status}  bytes=${viaProxy.bytes}  ` +
        `耗時=${viaProxy.ms}ms  平均=${Math.round(viaProxy.bytes / (viaProxy.ms / 1000))} B/s` +
        `${viaProxy.aborted ? '  ⚠ 中途被砍斷' : ''}`,
    );
    console.log(
      `      Cache-Control: ${proxyRes.headers.get('cache-control') ?? '（無）'}` +
        `  Age: ${proxyRes.headers.get('age') ?? '（無）'}`,
    );

    // ── [3] 比對 ──
    const ratio = direct.bytes ? viaProxy.bytes / direct.bytes : 0;
    const truncated = direct.bytes > 0 && viaProxy.bytes < direct.bytes;
    if (truncated) anyTruncated = true;
    console.log(
      `  判定：${truncated ? '✗ 代理截斷了 segment' : '✓ 代理沒有截斷'} ` +
        `（代理拿到 ${(ratio * 100).toFixed(1)}% 的內容）\n`,
    );
  }

  console.log('═'.repeat(70));
  console.log(
    `結果：${anyTruncated ? '✗ 代理會截斷 segment（使用者拿到壞的影片，且被 CDN 快取 5 分鐘）' : '✓ 代理沒有截斷'}`,
  );
  console.log('═'.repeat(70));
  process.exit(anyTruncated ? 1 : 0);
}

await main();
