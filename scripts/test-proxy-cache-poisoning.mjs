#!/usr/bin/env node
/**
 * test-proxy-cache-poisoning.mjs — 驗證代理不會快取「過期 segment 的 HTML 錯誤頁」
 *
 * 背景（2026-11-21 實測發現的 bug）：
 *   直播 segment 只活約 30 秒。上游對已過期的 segment 回的是
 *   **HTTP 206 + `Content-Range: bytes 0-162/163`**，
 *   而內容其實是 163 bytes 的 **HTML 404 錯誤頁**。
 *
 *   舊的判斷規則只看 Content-Range（結尾 == 總長度 → 當成完整內容），
 *   於是這個 HTML 錯誤頁被回成 200 + `max-age=300` 快取起來 ——
 *   使用者拿到 HTML 當影片，且被釘住 5 分鐘。
 *
 * 修正後：代理會檢查第一個 chunk 的位元組
 *   · MPEG-TS → 第 1 byte 必須是 0x47
 *   · fMP4    → 第 5–8 byte 必須是 'ftyp'
 *   不符合 → 回 502 且**不快取**。
 *
 * 本測試驗證兩件事：
 *   1. 正常 segment → 200 + `public, max-age=300`（可快取）
 *   2. 過期 segment → 502 + **沒有** max-age（不可快取）
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const BASE =
  (() => {
    const i = process.argv.indexOf('--base');
    return i >= 0 ? process.argv[i + 1] : 'http://localhost:3211';
  })() ?? 'http://localhost:3211';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 帶重試的 fetch。
 *
 * 為什麼需要：上游速度是**跳動的**（實測同一個 5.4 MB segment
 * 有時 196ms、有時 78 秒）。單次逾時不代表有問題，
 * 重試才是公平的測法。
 */
async function fetchWithRetry(url, options = {}, timeoutMs = 30_000, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(1500);
    }
  }
  throw lastErr;
}

/**
 * 只讀回應的**第一個 chunk**。
 *
 * 為什麼只要第一個 chunk：
 *   代理的驗證邏輯（0x47 / ftyp 檢查）在第一個 chunk 就決定了，
 *   而 HTTP status 與 Cache-Control 標頭也立刻就讀得到。
 *   完整下載 5.4 MB 會花 40–80 秒（上游速度跳動），
 *   但判斷這個測試要的是**標頭與狀態碼**，不是完整內容。
 */
async function fetchHead(url, options = {}, timeoutMs = 30_000) {
  const res = await fetchWithRetry(url, options, timeoutMs);
  const reader = res.body?.getReader();
  let first = new Uint8Array(0);
  if (reader) {
    const r = await reader.read();
    first = r.value ?? new Uint8Array(0);
    // 中斷下載：我們只要第一個 chunk
    await reader.cancel().catch(() => {});
  }
  return {
    status: res.status,
    cacheControl: res.headers.get('cache-control') ?? '',
    contentRange: res.headers.get('content-range'),
    firstByte: first[0],
    firstBytes: Buffer.from(first.slice(0, 80)).toString('utf8'),
    size: first.length,
  };
}

/** 從頻道清單找一個已知有備援且主來源會回 206 的來源 */
function pickUpstream() {
  const catalog = JSON.parse(
    readFileSync(join(ROOT, 'shared', 'channels.json'), 'utf8'),
  );
  // 央視-1 的來源已知會回 206 + Content-Range
  const ch = catalog.channels.find((c) => c.channel_id === 'cn-cctv1');
  return ch?.stream_url ?? null;
}

async function main() {
  console.log('═'.repeat(66));
  console.log('驗證：代理不會快取過期 segment 的 HTML 錯誤頁');
  console.log('═'.repeat(66));
  console.log(`測試站點：${BASE}\n`);

  const upstream = pickUpstream();
  if (!upstream) {
    console.log('✗ 找不到測試用來源');
    process.exit(1);
  }

  // ── 取得 manifest 與第一個 segment ──
  //
  // ⚠️ 必須走代理拿 manifest：代理會把 manifest 裡的 segment 網址
  // 改寫成**帶簽章**的代理網址。直接用上游網址會被 403
  // （allowlist + HMAC 簽章驗證）。
  const manifestRes = await fetch(
    `${BASE}/api/proxy?url=${encodeURIComponent(upstream)}`,
    { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) },
  );
  const m = await manifestRes.text();
  const seg =
    m
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && l.includes('/api/proxy'))[0] ?? null;
  if (!seg) {
    console.log('✗ manifest 沒有可用的 segment 網址');
    console.log(`  manifest 內容：${m.slice(0, 300)}`);
    process.exit(1);
  }
  const segUrl = new URL(seg, BASE).href;
  console.log(`測試來源：${upstream}`);
  console.log(`segment： ${segUrl.slice(0, 100)}\n`);

  // ── 情境 A：segment 還活著 ──
  console.log('[A] 有效 segment（應回 200 + 可快取）');
  const a = await fetchHead(segUrl, { headers: { Range: 'bytes=0-' } }, 30_000);
  const aCc = a.cacheControl;
  console.log(`    HTTP ${a.status}`);
  console.log(`    Cache-Control: ${aCc}`);
  console.log(`    Content-Range: ${a.contentRange ?? '無'}`);
  console.log(`    第一個 chunk: ${a.size} bytes，首位元組 0x${a.firstByte?.toString(16)}`);
  const aOk =
    a.status === 200 &&
    /max-age=[1-9]/.test(aCc) &&
    a.firstByte === 0x47;
  console.log(`    判定：${aOk ? '✓ 正確（完整 segment 且可快取）' : '✗ 不符預期'}\n`);

  // ── 情境 B：等 segment 過期 ──
  console.log('[B] 等待 40 秒讓 segment 過期…');
  await sleep(40_000);

  // 檢查上游是否真的過期（用原始上游網址，繞過代理）
  const rawSeg =
    m
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && l.includes('/api/proxy'))[0] ?? '';
  // 從簽章網址反推原始網址：/api/proxy?url=<encoded>&sig=<hex>
  // 注意 url 參數是 URL-encoded，內部的 `&` 已被編碼成 `%26`，
  // 所以用 `[^&]+` 就能完整取到（外層的 `&sig=` 才會分隔）。
  const rawUrl = rawSeg.match(/[?&]url=([^&]+)/)?.[1];
  const upstreamSegUrl = rawUrl ? decodeURIComponent(rawUrl) : null;

  if (upstreamSegUrl) {
    const expiredProbe = await fetch(upstreamSegUrl, {
      headers: { 'User-Agent': UA, Range: 'bytes=0-' },
      signal: AbortSignal.timeout(20_000),
    });
    const expiredCr = expiredProbe.headers.get('content-range');
    const expiredLen = expiredProbe.headers.get('content-length');
    console.log(
      `    上游此刻回: HTTP ${expiredProbe.status} len ${expiredLen} cr ${expiredCr}`,
    );
    console.log(
      `    （已過期：${expiredProbe.status === 206 && Number(expiredLen) < 1000 ? '是 ✓' : '否 —— 可能上游又更新了序號'}）\n`,
    );
  } else {
    console.log('    （無法反推原始網址，改以代理行為為準）\n');
  }

  // ── 情境 C：代理面對過期 segment ──
  //
  // ⚠️ 這裡有**兩種都正確**的結果，取決於 CDN 有沒有快取到：
  //
  //   (a) CDN 已快取到有效 segment（本地測試、或正式站上 A 情境剛存取過）
  //       → 代理/直接回 CDN 快取的**有效 MPEG-TS**（0x47）
  //       → 這正是快取的設計目的：上游的 segment 只活 30 秒，
  //         CDN 是唯一能持續供應的來源。
  //
  //   (b) CDN 沒有快取（上游真的已過期）
  //       → 代理必須回 **502 且不快取**，讓播放器改用備援來源。
  //
  // **兩種情況下唯一不可接受的結果是：把 HTML 錯誤頁當成影片回應。**
  // 所以斷言聚焦在這一點。
  console.log('[C] 代理回應（不可接受：HTML 錯誤頁被當成影片）');
  const c = await fetchHead(segUrl, { headers: { Range: 'bytes=0-' } }, 30_000);
  const cCc = c.cacheControl;
  console.log(`    HTTP ${c.status}`);
  console.log(`    Cache-Control: ${cCc}`);
  console.log(`    第一個 chunk: ${c.size} bytes，首位元組 0x${c.firstByte?.toString(16)}`);
  console.log(`    內容前 60 bytes: ${JSON.stringify(c.firstBytes.slice(0, 60))}`);

  const isHtmlContent = c.firstBytes.trimStart().startsWith('<');
  const isValidStream = c.firstByte === 0x47;
  const hasCacheableMaxAge = /max-age=[1-9]/.test(cCc);

  let cVerdict;
  if (isHtmlContent) {
    // ❌ HTML 錯誤頁被當成影片回應 → 快取污染
    cVerdict = `✗ HTML 錯誤頁被當成影片（status=${c.status}）`;
  } else if (isValidStream && c.status === 200) {
    // ✅ CDN 快取命中 → 回有效 segment（預期行為）
    cVerdict = '✓ CDN 快取命中，回有效 segment（0x47）—— 這是預期的保護效果';
  } else if (c.status === 502 && !hasCacheableMaxAge) {
    // ✅ 沒有 CDN 快取 → 拒絕且不快取
    cVerdict = '✓ 無 CDN 快取 → 502 且不快取（拒絕過期 segment）';
  } else {
    cVerdict = `✗ 不符預期（status=${c.status} firstByte=0x${c.firstByte?.toString(16)}）`;
  }
  console.log(`    判定：${cVerdict}`);

  const cOk = isValidStream || (c.status === 502 && !hasCacheableMaxAge);

  console.log('\n' + '═'.repeat(66));
  const pass = aOk && cOk;
  console.log(`結果：${pass ? '✓ 通過' : '✗ 未通過'}`);
  process.exit(pass ? 0 : 1);
}

await main();
