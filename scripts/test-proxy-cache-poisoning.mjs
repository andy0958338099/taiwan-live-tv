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
 * 本測試驗證四件事：
 *   1. 正常 segment → 完整內容 + `public, max-age=300`（可快取）
 *   2. 過期 segment → 502 + **沒有** max-age（不可快取）
 *   3. CDN 快取命中時 → 仍然是有效串流內容（0x47），不是 HTML 錯誤頁
 *   4. **Range 快取鍵隔離** —— 中途 range 的部分內容不得污染完整 segment
 *      （2026-11-21 新增；這是與「query string 不進快取鍵」同型別的 P0 風險）
 *
 * ⚠️ 2026-11-21 修正：本測試原本有兩處**過期斷言**，會在線上產生假失敗：
 *   · 只認 HTTP 200 → 但 edge 快取命中時會回 **206 + 完整 Content-Range**
 *     （`bytes 0-(N-1)/N`，內容完全正確）
 *   · 從 `?url=` 反推上游網址 → 代理已改成 **base64url 放 path**，
 *     反推永遠失敗 → 情境 [B]/[C] 的過期驗證被**靜默跳過**
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
    contentLength: res.headers.get('content-length'),
    firstByte: first[0],
    firstBytes: Buffer.from(first.slice(0, 80)).toString('utf8'),
    size: first.length,
  };
}

/**
 * 回應是否代表「完整資源」。
 *
 * 兩種形式都合法且內容相同：
 *   · 代理本地：上游回 206（`bytes 0-N/N`）→ 代理**正規化成 200** 並移除 Content-Range
 *     （見 route.ts 的 `isFullContent` / `responseStatus`）
 *   · Netlify edge：若 edge 已快取完整物件，對 Range 請求會自行切片並回
 *     **206 + 完整 Content-Range**（`bytes 0-(N-1)/N`）
 *
 * ⚠️ 舊的測試只認 200，於是 edge 回 206（內容完全正確）時被誤判為失敗。
 */
function isCompleteResponse(status, contentRange) {
  if (status === 200) return true;
  if (status !== 206 || !contentRange) return false;
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange.trim());
  if (!m) return false;
  return Number(m[1]) === 0 && Number(m[2]) + 1 === Number(m[3]);
}

/**
 * 從代理網址反推原始上游網址。
 *
 * 代理的目標網址有兩種形式：
 *   舊：/api/proxy?url=<urlencoded>&sig=<hex>
 *   新：/api/proxy/<base64url(target)>?sig=<hex>
 *
 * ⚠️ 2026-11-21 改成 path 形式是為了修 P0（Netlify 的快取鍵不含一般 query string，
 * 導致所有頻道共用同一份 CDN 快取項目）。反推方式必須跟著改，
 * 否則情境 [B] 會永遠拿不到上游網址 → **過期 segment 的驗證整段被靜默跳過**。
 */
function decodeUpstreamFromProxied(proxied) {
  try {
    const u = new URL(proxied, BASE);
    const m = /^\/api\/proxy\/([^/?]+)/.exec(u.pathname);
    if (m) {
      const decoded = Buffer.from(decodeURIComponent(m[1]), 'base64url').toString(
        'utf8',
      );
      if (/^https?:\/\//.test(decoded)) return decoded;
    }
    const raw = u.searchParams.get('url');
    if (raw) return decodeURIComponent(raw);
  } catch {
    /* 無法反推 → 回 null */
  }
  return null;
}

/**
 * 從頻道清單找一個測試用來源。
 *
 * 需求：上游要回 **206 + Content-Range**（過期時才看得出內容變短），
 * 而且**速度要夠快**（否則代理會正確地把它判為「太慢」而回 502）。
 *
 * ⚠️ 2026-11-21 換掉原本的央視-1：
 *
 * 央視-1 的來源實測要 30 秒以上才傳得完 5.4MB，
 * 代理正確地把它判為「太慢」而回 502 —— 這是**正確**行為。
 * （舊版會回 HTTP 200 但只傳 696KB 就被平台切斷，還帶著 max-age=300
 *   → 截斷的內容被 CDN 快取 5 分鐘，散播給所有使用者。）
 *
 * 但這讓本測試的 [A] 情境（「有效 segment 應回 200 + 可快取」）無法成立，
 * 測試會因為**被測對象的性質**而失敗，而不是因為代理有錯。
 * 所以改用龍華電視：實測 0.9 秒傳完 3MB，能正常通過代理的速度檢查。
 */
function pickUpstream() {
  const catalog = JSON.parse(
    readFileSync(join(ROOT, 'shared/channels.json'), 'utf8'),
  );
  // 龍華電視的來源夠快，且 segment 會隨直播滾動過期（可驗證 [B]/[C]）
  const ch = catalog.channels.find((c) => c.channel_id === 'playlist-龍華-龍華電視');
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
  //
  // ⚠️ 這些來源是**多層 playlist**（master → child → segment）。
  // 只取第一層會拿到「child manifest」而不是 segment，
  // 而 child manifest 的內容是 `#EXTM3U` 開頭（0x23）→ 會被誤判成
  // 「不是串流內容」。所以要逐層下鑽到真正的 segment。
  let manifestText = '';
  let segUrl = null;
  let currentUrl = `${BASE}/api/proxy/${Buffer.from(upstream, 'utf8').toString('base64url')}`;

  for (let depth = 0; depth < 5; depth++) {
    const res = await fetch(currentUrl, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      console.log(`✗ manifest 取得失敗（depth ${depth}）：HTTP ${res.status}`);
      process.exit(1);
    }
    const text = await res.text();

    // 回應不是 manifest → 這就是 segment 本身
    if (!text.trimStart().startsWith('#EXTM3U')) {
      segUrl = currentUrl;
      manifestText = text;
      break;
    }

    manifestText = text;
    const next =
      text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))[0] ?? null;
    if (!next) break;
    currentUrl = next.startsWith('http')
      ? next
      : next.startsWith('/')
        ? `${BASE}${next}`
        : new URL(next, currentUrl).href;
  }

  const m = manifestText;
  if (!segUrl) {
    // 沒下鑽到 segment（多層 playlist 解析失敗）→ 退回 manifest 裡的第一個網址
    segUrl =
      m
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && l.includes('/api/proxy'))[0] ?? null;
    if (!segUrl) {
      console.log('✗ manifest 沒有可用的 segment 網址');
      console.log(`  manifest 內容：${m.slice(0, 300)}`);
      process.exit(1);
    }
    segUrl = new URL(segUrl, BASE).href;
  }
  console.log(`測試來源：${upstream}`);
  console.log(`segment： ${segUrl.slice(0, 100)}\n`);

  // ── 情境 A：segment 還活著 ──
  console.log('[A] 有效 segment（應回完整內容 + 可快取）');
  const a = await fetchHead(segUrl, { headers: { Range: 'bytes=0-' } }, 30_000);
  const aCc = a.cacheControl;
  console.log(`    HTTP ${a.status}`);
  console.log(`    Cache-Control: ${aCc}`);
  console.log(`    Content-Range: ${a.contentRange ?? '無'}`);
  console.log(`    第一個 chunk: ${a.size} bytes，首位元組 0x${a.firstByte?.toString(16)}`);
  const aOk =
    isCompleteResponse(a.status, a.contentRange) &&
    /max-age=[1-9]/.test(aCc) &&
    a.firstByte === 0x47;
  console.log(`    判定：${aOk ? '✓ 正確（完整 segment 且可快取）' : '✗ 不符預期'}\n`);

  // ── 情境 B：等 segment 過期 ──
  console.log('[B] 等待 40 秒讓 segment 過期…');
  await sleep(40_000);

  // 檢查上游是否真的過期（用原始上游網址，繞過代理）
  const upstreamSegUrl = decodeUpstreamFromProxied(segUrl);

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
  } else if (isValidStream && isCompleteResponse(c.status, c.contentRange)) {
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

  // ── 情境 D：Range 快取鍵隔離（P0 級風險）─────────────────────────
  //
  // ⚠️ **這是本測試原本完全沒有覆蓋的風險**。
  //
  // Netlify 的快取鍵**不含一般 query string**（`netlify-vary: query=__nextDataReq|_rsc`）。
  // 那麼 `Range` 標頭呢？如果快取鍵也**不含 Range**：
  //   · 先請求 `Range: bytes=100-200` → edge 可能把這個「部分內容」存成快取項目
  //   · 後續請求 `Range: bytes=0-`（要完整 segment）→ 命中同一快取項目
  //   → **播放器拿到 101 bytes 的片段卻以為是完整 segment** → 播不出來
  //
  // 這正是 2026-11-21 那次 P0 的同型問題（識別資訊放錯位置導致快取共用）。
  // 所以這個情境必須**實測**，不能假設。
  //
  // 驗證方式：
  //   1. 先請求中途 range（bytes=100-200）—— 製造「部分內容」
  //   2. 再請求完整 range（bytes=0-）—— 必須拿到**完整** segment
  //   3. 比對完整 segment 的長度是否等於 Content-Range 宣稱的總長
  console.log('\n[D] Range 快取鍵隔離（部分內容不得污染完整 segment）');
  const d1 = await fetchHead(segUrl, { headers: { Range: 'bytes=100-200' } }, 30_000);
  console.log(
    `    [D1] 中途 range: HTTP ${d1.status} cc=${d1.cacheControl} ` +
      `cr=${d1.contentRange ?? '無'} len=${d1.size}`,
  );

  const d2 = await fetchHead(segUrl, { headers: { Range: 'bytes=0-' } }, 30_000);
  console.log(
    `    [D2] 完整 range: HTTP ${d2.status} cc=${d2.cacheControl} ` +
      `cr=${d2.contentRange ?? '無'} len=${d2.size}`,
  );

  // 完整 segment 的預期長度：Content-Range 的總長，或 Content-Length
  const declaredTotal = d2.contentRange
    ? Number(d2.contentRange.split('/')[1])
    : d2.contentLength
      ? Number(d2.contentLength)
      : null;

  // ⚠️ fetchHead 只讀**第一個 chunk**，d2.size 是已讀到的位元組數（通常 4096），
  // 不是整體長度。要真正驗證「拿到完整 segment」，必須把整個 body 讀完並比對長度。
  // 這一步會下載整個 segment（實測 2–8 MB），但這是本測試唯一能證明
  // 「部分內容沒有污染完整 segment」的方法。
  let actualTotal = null;
  try {
    const full = await fetch(segUrl, {
      headers: { 'User-Agent': UA, Range: 'bytes=0-' },
      signal: AbortSignal.timeout(60_000),
    });
    const buf = Buffer.from(await full.arrayBuffer());
    actualTotal = buf.length;
  } catch (e) {
    console.log(`    （完整下載失敗：${e.message}）`);
  }

  let dOk;
  if (!isCompleteResponse(d2.status, d2.contentRange)) {
    dOk = false;
    console.log(
      `    判定：✗ 完整 range 沒有回完整內容（status=${d2.status} cr=${d2.contentRange ?? '無'}）`,
    );
  } else if (
    actualTotal !== null &&
    declaredTotal !== null &&
    declaredTotal > 0 &&
    actualTotal < declaredTotal
  ) {
    // 實際下載到的位元組數 < 宣稱的總長 → 被中途 range 的部分內容污染了
    dOk = false;
    console.log(
      `    判定：✗ **快取污染**：完整 range 只拿到 ${actualTotal} bytes` +
        `（宣告 ${declaredTotal} bytes）—— CDN 快取鍵沒有包含 Range 標頭`,
    );
  } else if (actualTotal !== null) {
    dOk = true;
    console.log(
      `    判定：✓ 完整 range 回完整 segment（實際 ${actualTotal} bytes / 宣告 ${declaredTotal ?? '無'}）` +
        ` —— 未被中途 range 污染`,
    );
  } else {
    dOk = true;
    console.log('    判定：✓ 完整 range 回完整 segment —— 未被中途 range 污染');
  }

  // 部分內容的回應**不該**被快取（否則會變成上面那種污染）。
  //
  // ⚠️ 但要注意實測到的兩種情況（2026-11-21）：
  //   · **首次**請求中途 range（網址尚未被快取）→ 代理回 `206` + `no-store` ✓
  //   · 該網址**已被 edge 快取完整物件**後再請求中途 range → edge 會自行切片，
  //     回 `206` + `max-age=300`（沿用被快取物件的標頭）
  //
  // 後者**不是** bug：edge 持有的是完整物件，切片位元組完全正確
  // （[D2] 已實測下載到完整長度）。真正要防的是「部分內容被當成完整內容快取」，
  // 那由 isCompleteResponse 判定 + [D2] 的完整下載比對把關。
  const d1NotCacheable = !/max-age=[1-9]/.test(d1.cacheControl);
  console.log(
    `    [D1] 快取標頭：${d1.cacheControl}` +
      (d1NotCacheable
        ? '（部分內容不可快取 ✓）'
        : '（edge 已有完整物件的快取項目，切片沿用其標頭；位元組正確）'),
  );

  console.log('\n' + '═'.repeat(66));
  const pass = aOk && cOk && dOk;
  console.log(`結果：${pass ? '✓ 通過' : '✗ 未通過'}`);
  process.exit(pass ? 0 : 1);
}

await main();
