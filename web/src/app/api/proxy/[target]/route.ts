import { NextRequest, NextResponse } from 'next/server';
import { lookup } from 'node:dns/promises';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import net from 'node:net';

/**
 * HLS 串流代理 — 解決 CORS 限制
 *
 * 為什麼需要這個：
 *   瀏覽器的同源政策要求，回應必須帶 `Access-Control-Allow-Origin`。
 *   IPTV 清單中的來源（約 1/3）不回傳這個標頭，瀏覽器就會擋下 manifest 與 segment。
 *   Android ExoPlayer 在原生層請求，不受此限制 —— 所以同一個頻道在
 *   Android TV 版能播、在網頁版不能播。
 *
 * 安全設計（本檔案是全專案最需要注意安全的地方）：
 *
 *   1. **入口白名單**：目標網址必須是已授權頻道的 stream_url 或備援來源，
 *      否則 403。這防止代理被當成任意網址的開放代理。
 *
 *   2. **HMAC 簽章**：manifest 內的 segment／子 manifest 網址會被改寫成
 *      帶簽章的代理網址。代理只接受「簽章有效」的網址，或「本身就是
 *      已授權頻道」的網址。
 *      這解決了 master manifest 指向其他主機（如 cdn.qd.je → 8.fast.hidns.vip）
 *      的問題：簽章本身即證明「這個網址是我們剛剛代理過的 manifest 裡所引用的」，
 *      不需要依賴主機白名單，也不受處理順序影響。
 *
 *   3. **SSRF 防護**：所有請求（含簽章通過的）都會解析 DNS 並檢查目標 IP，
 *      阻擋迴圈位址、私有網段、保留位址與雲端 metadata 位址。
 *
 *   4. **改寫 manifest**：必須改寫，否則瀏覽器還是會直接去來源拿 segment 而失敗。
 *      ⚠️ 判斷 manifest 必須「嗅探內容」，不能只看 content-type ——
 *      實測 `8.fast.hidns.vip` 回應的是 `text/plain`。
 *
 *   5. **不緩存串流內容**：直播內容即時性重要，且會佔用頻寬。
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 已授權頻道的入口 URL */
let ALLOWED_ENTRY_URLS: Set<string> | null = null;

/**
 * ⭐ **目標網址放在 path，不是 query string**。
 *
 * ## 為什麼不能放在 query
 *
 * 實測（2026-11-21 線上故障）：Netlify 的 Next.js runtime 用
 * `netlify-vary: query=__nextDataReq|_rsc` 決定快取鍵 ——
 * **我們的 `url` / `sig` query 參數不在鍵裡**。
 *
 * 結果：所有頻道、所有 segment 共用同一個快取項目。
 * 實測 6 個不同頻道拿到的 manifest sha256 完全相同：
 *
 *   playlist-龍華-龍華電視    sha=bb394a1f3c2c age=245 是manifest=否
 *   playlist-翡翠台-tvb翡翠台 sha=bb394a1f3c2c age=246 是manifest=否
 *   ...（6 個全部相同）
 *   不同頻道數：6　不同內容數：1
 *
 * 而且更糟：因為我把 segment 設成 `max-age=300`，
 * **manifest 請求會拿到某個 segment 的位元組**（0x47 MPEG-TS），
 * 使用者拿到的是一段影片而不是清單 → 頻道完全播不出來。
 *
 * ## 修法
 *
 * 把目標網址 base64url 編碼後放進 **path**：
 *
 *   /api/proxy/<base64url(target)>?sig=<sig>
 *
 * 快取鍵**一定**包含 path，所以每個目標網址各有自己的快取項目。
 * base64url 的字元集是 `A–Z a–z 0–9 - _`，不含 `/`、`?`、`&`，
 * 可以安全地當成單一 path segment。
 */
function encodeTarget(target: string): string {
  return Buffer.from(target, 'utf8').toString('base64url');
}

function decodeTarget(encoded: string): string | null {
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * 簽章密鑰。
 *
 * 生產環境（serverless 多實例）**必須**設定 `PROXY_SECRET` 環境變數，
 * 否則每個實例會有各自的隨機密鑰：manifest 由實例 A 簽章、
 * segment 卻被送到實例 B → 簽章驗證失敗 → 頻道播不出來。
 * 單機部署則會自動產生安全的隨機密鑰。
 */
const PROXY_SECRET =
  process.env.PROXY_SECRET || randomBytes(32).toString('hex');

/**
 * ⏱️ 上游下載的時間預算。
 *
 * ## 為什麼需要這個
 *
 * 實測（2026-11-21 線上）：央視來源的 segment 高達 **5.4 MB**，
 * 而 Netlify edge 到該來源的實測速度只有 **38–100 KB/s**
 * → 單一個 segment 需要 **90–140 秒**。
 *
 * 但 Netlify 的 function／CDN origin 會在 **約 30.4 秒**切斷回應。
 * 結果是：
 *   · 客戶端拿到 `HTTP 200` + **被截斷的 segment**（5.4 MB 只到了 1.2–1.7 MB）
 *   · 這個回應帶著 `Cache-Control: public, max-age=300`
 *     → **被截斷的內容被 CDN 快取 5 分鐘**，所有使用者都拿到壞的 segment
 *
 * 這是比「播不出來」更糟的情況：壞的內容會被散播出去。
 *
 * ## 修法
 *
 * 1. `UPSTREAM_TIMEOUT_MS` —— 給上游 fetch 一個硬性時間上限。
 *    目前**完全沒有** timeout：一個掛住的上游會佔住 function 直到平台殺掉它。
 * 2. `MAX_PROJECTED_TRANSFER_MS` —— 讀到第一個 chunk 後就能估算
 *    「照這個速度，整個 segment 要多久」。若估算超過預算，
 *    **立刻放棄**並回 `502` + `no-store`：
 *    · 客戶端馬上知道這個來源不行 → hls.js 快速 failover 到備援
 *    · 因為還沒送出任何 body，**CDN 不會快取到壞內容**
 *
 * ⚠️ 預算必須小於平台的 30 秒切斷點，否則「快取到壞內容」的問題會先發生。
 */
const UPSTREAM_TIMEOUT_MS = 25_000;
const MAX_PROJECTED_TRANSFER_MS = 22_000;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

function sign(target: string): string {
  return createHmac('sha256', PROXY_SECRET).update(target).digest('hex').slice(0, 32);
}

function verifySig(target: string, sig: string | null): boolean {
  if (!sig) return false;
  const expected = sign(target);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 取得已授權頻道的入口 URL 清單。
 *
 * 來源網址的決定順序：
 *   1. `baseUrl`（由請求本身的 origin 推導）—— serverless 部署下
 *      站台網域在部署後才確定，這是最可靠的做法。
 *   2. `NEXT_PUBLIC_SITE_URL` 環境變數 —— 明確指定時優先。
 *   3. `http://localhost:3210` —— 本機開發。
 */
async function loadEntryUrls(baseUrl?: string): Promise<Set<string>> {
  if (ALLOWED_ENTRY_URLS) return ALLOWED_ENTRY_URLS;

  const urls = new Set<string>();
  const base =
    baseUrl || process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3210';

  try {
    const res = await fetch(`${base}/channels.json`, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      for (const ch of data.channels ?? []) {
        if (!ch.is_active) continue;
        if (ch.stream_url) urls.add(ch.stream_url);
        for (const b of ch.playlist_source?.backup_urls ?? []) {
          if (b?.url) urls.add(b.url);
        }
      }
    }
  } catch (e) {
    console.error('[proxy] 無法載入頻道清單:', e);
  }

  ALLOWED_ENTRY_URLS = urls;
  return urls;
}

/**
 * SSRF 防護：解析 DNS 並檢查所有回應 IP 是否為危險位址。
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // 無法解析 → 視為危險
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 私有
  if (a === 127) return true; // 迴圈
  if (a === 169 && b === 254) return true; // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 私有
  if (a === 192 && b === 168) return true; // 私有
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase().split('%')[0];
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('fe80')) return true; // link-local
  if (v.startsWith('fc') || v.startsWith('fd')) return true; // unique local
  if (v.startsWith('::ffff:')) {
    // IPv4-mapped → 檢查 IPv4 部分
    return isPrivateIPv4(v.slice(7));
  }
  return false;
}

async function isSafeTarget(target: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;

  let addrs: { address: string }[];
  try {
    addrs = await lookup(u.hostname, { all: true });
  } catch {
    return false;
  }
  if (addrs.length === 0) return false;

  return addrs.every((a) => {
    const fam = net.isIP(a.address);
    if (fam === 4) return !isPrivateIPv4(a.address);
    if (fam === 6) return !isPrivateIPv6(a.address);
    return false;
  });
}

/** 目標是否被允許代理 */
async function isAllowed(
  target: string,
  sig: string | null,
  baseUrl?: string,
): Promise<boolean> {
  const entries = await loadEntryUrls(baseUrl);
  if (entries.has(target)) return true;
  // 簽章有效 → 代表這個網址是我們代理過的 manifest 裡所引用的
  return verifySig(target, sig);
}

/**
 * 改寫 manifest：把 segment / 子 manifest 網址改寫成帶簽章的代理網址。
 *
 * 必須處理三種形式（缺一就會有頻道播不出來）：
 *   1. 單獨一行��網址）      —— segment URL
 *   2. `#EXT-X-MAP:URI="..."` —— fMP4 初始化區段
 *      （實測 `cdn.qd.je/163189/ccm` 等 fMP4 來源會用到，
 *        若不改寫，hls.js 會去來源拿 init.mp4 而被 CORS 擋下）
 *   3. `#EXT-X-MEDIA:...URI="..."` —— 音軌／字幕等替代軌道
 *   4. `#EXT-X-I-FRAME-STREAM-INF:URI="..."` —— I-frame 索引
 */
function rewriteManifest(text: string, manifestUrl: string): string {
  const base = new URL(manifestUrl);
  const lines = text.split('\n');
  const out: string[] = [];

  const toProxy = (raw: string): string | null => {
    try {
      const abs = new URL(raw, base).toString();
      // ⭐ 目標網址放在 path（快取鍵一定含 path），簽章放 query。
      // 理由見檔案上方 encodeTarget 的說明。
      return `/api/proxy/${encodeTarget(abs)}?sig=${sign(abs)}`;
    } catch {
      return null;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      out.push(line);
      continue;
    }

    // 1. 單獨一行的網址（segment / 子 manifest）
    if (!trimmed.startsWith('#')) {
      const proxied = toProxy(trimmed);
      out.push(proxied ?? line);
      continue;
    }

    // 2–4. 標籤屬性中的 URI="..."
    if (/^#[A-Z0-9-]+:/.test(trimmed) && trimmed.includes('URI="')) {
      out.push(
        trimmed.replace(/URI="([^"]*)"/g, (_m, uri: string) => {
          if (!uri || uri.startsWith('data:')) return `URI="${uri}"`;
          const proxied = toProxy(uri);
          return proxied ? `URI="${proxied}"` : `URI="${uri}"`;
        }),
      );
      continue;
    }

    out.push(line);
  }

  return out.join('\n');
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Origin, Accept, Referer',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
};

/**
 * 單一代理端點，同時處理 manifest 與 segment。
 *
 * 目標網址從 **path** 的 `[target]` 參數取得（見 encodeTarget 的說明）。
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ target: string }> },
) {
  const { target: encoded } = await params;
  const sig = request.nextUrl.searchParams.get('sig');

  const target = decodeTarget(encoded);
  if (!target) {
    return NextResponse.json({ error: '無效的目標網址編碼' }, { status: 400 });
  }

  if (!(await isAllowed(target, sig, request.nextUrl.origin))) {
    return NextResponse.json(
      { error: '此來源不在允許的頻道清單中' },
      { status: 403 },
    );
  }

  if (!(await isSafeTarget(target))) {
    return NextResponse.json({ error: '不允許代理此位址' }, { status: 403 });
  }

  try {
    // 必須把 Range 標頭轉發給上游。
    // hls.js 會對 segment 送 Range 請求（部分抓取），
    // 上游回 206 Partial Content。若這裡不轉發 Range，
    // 上游會回傳完整 200 內容，而代理卻照抄 206 狀態碼，
    // 導致 hls.js 的位元組範圍計算錯亂、segment 被判定損壞而無法播放。
    const rangeHeader = request.headers.get('range');

    // 開始計時 —— 用來估算上游下載速度（見下方「上游速度檢查」）
    const startedAt = Date.now();

    // ⚠️ **必須有 timeout**。
    //
    // 沒有 timeout 時，一個掛住或極慢的上游會佔住 function
    // 直到平台在 ~30 秒強制中斷 —— 那時已經送出了 HTTP 200 + 部分內容，
    // 而這份**被截斷的內容會被 CDN 快取 5 分鐘**（見 UPSTREAM_TIMEOUT_MS 說明）。
    //
    // 有了 timeout：上游太慢時 function 會自己先放棄，
    // 走下面的「回 502 + 不快取」路徑 → 壞內容不會進入 CDN。
    const upstream = await fetch(target, {
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        ...(rangeHeader ? { Range: rangeHeader } : {}),
      },
      redirect: 'follow',
      cache: 'no-store',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    if (!upstream.ok && upstream.status !== 206) {
      return NextResponse.json(
        { error: `來源回應 HTTP ${upstream.status}` },
        { status: 502 },
      );
    }

    const contentType = upstream.headers.get('content-type') || '';

    // 判斷是否為 manifest：**必須嗅探內容，不能只看 content-type**。
    // 實測 `8.fast.hidns.vip` 等轉載主機回應的是 `text/plain`，
    // 若只看 content-type 就會把 manifest 當成 segment 直接輸出，
    // 導致 manifest 內的相對路徑沒被改寫，hls.js 解析後指向代理站自身而 404。
    //
    // ⚠️ **不能用 `upstream.arrayBuffer()` 把整份讀完**：
    //
    // 實測央視來源的 segment 高達 **5.2 MB**，而上游傳輸速度只有
    // **約 480 KB/s**（單一個 segment 需 11 秒）。
    // 整份緩衝會造成兩個問題：
    //   1. Netlify Functions 有 **30 秒執行上限** — 緩衝 + 傳輸會超過，
    //      function 被強制中斷，瀏覽器收到 HTTP 504 / "unknown error"
    //   2. 即使在本地，hls.js 也要等整個 segment 下載完才開始播放，
    //      等待期間就發出 ERR_ABORTED 而放棄
    //
    // 解法：**只讀第一個 chunk 來判斷型別，其餘串流出去**。
    //   - manifest → 讀完整份（很小，幾 KB）並改寫
    //   - segment → 直接把上游的 ReadableStream 串流回應
    //
    // 這不是先前註解裡提的 `tee()` 死鎖問題：
    // tee() 會把上游分流成兩支，其中一支被取消時另一支的 backpressure
    // 會卡住上游。而這裡是「先讀一塊判斷型別 → 決定要不要繼續讀」，
    // 只有一條消費路徑，不會有 backpressure 死結。
    const reader = upstream.body?.getReader();
    if (!reader) {
      return NextResponse.json({ error: '上游沒有回應內容' }, { status: 502 });
    }

    /**
     * headers 到達的時間點。
     *
     * 用它當速度估算的起點，才能把「DNS + TCP + TLS 握手」排除在外 ——
     * 那段時間沒有任何頻寬被使用（實測 100–300ms），
     * 算進「下載速度」會嚴重低估。
     */
    const headersAt = Date.now();

    const first = await reader.read();
    const firstChunk = first.value ?? new Uint8Array(0);
    const head = new TextDecoder().decode(firstChunk.slice(0, 800));
    const isManifest = head.trimStart().startsWith('#EXTM3U');

    /**
     * 已讀到但還沒送出的 chunk。
     *
     * 速度檢查可能會多讀一個 chunk（為了重新估算），
     * 那個 chunk 不能丟掉 —— 要在串流時一併送出。
     */
    const pendingChunks: Uint8Array[] = [];

    /**
     * ⏱️ **上游速度檢查**（在送出任何 body 之前）。
     *
     * 實測（2026-11-21 線上）：央視來源的 segment 是 5.4 MB，
     * 從 Netlify edge 下載只有 38–100 KB/s → 需要 90–140 秒。
     * 平台在 ~30.4 秒就會切斷回應，於是客戶端拿到
     * `HTTP 200` + **被截斷的 segment**，而且因為帶著
     * `Cache-Control: public, max-age=300`，**壞內容被 CDN 快取 5 分鐘**。
     *
     * 這裡在第一個 chunk 讀到之後就估算：
     * 「照目前速度，整個 segment 要多久？」
     * 若超過預算 → **立刻回 502 且不快取**：
     *   · 客戶端馬上知道這個來源不可用 → hls.js 快速 failover
     *   · 沒有送出任何 body → CDN 不會快取到壞內容
     *
     * 估算方式：用上游的 `Content-Length`（總長）÷ 第一個 chunk 的下載速度。
     * 沒有 Content-Length 時（chunked）就無法估算，此時靠
     * `UPSTREAM_TIMEOUT_MS` 的硬性 timeout 兜底。
     */
    const upstreamLengthHeader = upstream.headers.get('content-length');
    const upstreamTotalBytes = upstreamLengthHeader
      ? Number(upstreamLengthHeader)
      : null;

    if (
      !isManifest &&
      upstreamTotalBytes !== null &&
      Number.isFinite(upstreamTotalBytes) &&
      upstreamTotalBytes > 0
    ) {
      /**
       * 估算整個 segment 下載完要多久。
       *
       * ## ⚠️ 單靠「第一個 chunk」估算是不準的
       *
       * 兩個原因：
       *   1. **第一個 chunk 的到齊時間包含連線建立**
       *      （DNS 查詢 + TCP 握手 + TLS 交握，通常 100–300ms），
       *      這段時間沒有任何頻寬被使用，卻被算進「下載速度」。
       *   2. **上游速度是爆發式的** —— 實測同一個 5.23 MB segment：
       *      有時 196ms 就下載完（有時 123 秒）。
       *      第一個 chunk 的大小也會波動（實測 1199B ~ 14159B），
       *      用單一 chunk 外推會得到 wildly 不準的結果。
       *
       * ## 解法：兩段式判斷
       *
       *   1. 先用第一個 chunk 估算。**夠快就直接放行**（不增加延遲）。
       *   2. 只有在估算「可能太慢」時，才**讀第二個 chunk** 重新估算 ——
       *      這時連線已建立，量到的才是真實頻寬。
       *
       * 只有兩次估算都超過門檻才放棄上游。
       */
      const estimateWith = (bytes: number, ms: number): number => {
        const bpm = bytes / Math.max(1, ms);
        return bpm > 0 ? upstreamTotalBytes / bpm : Infinity;
      };

      // 第一次估算：用「headers 到達 → 第一個 chunk 到達」的時間。
      // 這樣連線建立的時間被排除在外（fetch 回應時 headers 就已到）。
      const chunk1Ms = Math.max(1, Date.now() - headersAt);
      let projectedMs = estimateWith(firstChunk.byteLength, chunk1Ms);

      if (projectedMs > MAX_PROJECTED_TRANSFER_MS) {
        // 可能太慢 → 讀第二個 chunk，用「已建立的連線」重新量一次真實頻寬
        const second = await Promise.race([
          reader.read(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
        ]);

        if (second && 'value' in second && second.value) {
          const chunk2 = second.value;
          // 累積：兩個 chunk 的總位元組 ÷ 從 headers 到第二個 chunk 的時間
          const chunk2Ms = Math.max(1, Date.now() - headersAt);
          projectedMs = estimateWith(
            firstChunk.byteLength + chunk2.byteLength,
            chunk2Ms,
          );
          // 第二個 chunk 也要一起送出去（不能丟掉）
          pendingChunks.push(chunk2);
        } else {
          // 讀不到第二個 chunk（上游沒給更多資料）→ 維持第一次估算
          projectedMs = Infinity;
        }
      }

      if (projectedMs > MAX_PROJECTED_TRANSFER_MS) {
        // 放棄上游（取消讀取，避免佔住頻寬）
        await reader.cancel().catch(() => {});
        console.warn(
          `[代理] 上游太慢（預估 ${Math.round(projectedMs)}ms > ` +
            `${MAX_PROJECTED_TRANSFER_MS}ms，總長 ${upstreamTotalBytes}B）→ 回 502 不快取`,
        );
        return NextResponse.json(
          {
            error: '來源供應過慢，已放棄（避免回傳被截斷的內容）',
            projected_ms: Math.round(projectedMs),
          },
          { status: 502, headers: { 'Cache-Control': 'no-store' } },
        );
      }
    }

    if (isManifest) {
      // Manifest 很小，讀完後改寫網址
      const chunks: Uint8Array[] = [firstChunk];
      let total = firstChunk.byteLength;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value);
        total += next.value.byteLength;
        // 安全上限，避免異常回應吃光記憶體
        if (total > 4 * 1024 * 1024) break;
      }
      const text = new TextDecoder().decode(
        chunks.length === 1 ? chunks[0] : concatChunks(chunks, total),
      );
      const rewritten = rewriteManifest(text, upstream.url || target);
      return new NextResponse(rewritten, {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/vnd.apple.mpegurl',
          // Manifest 必須即時 —— 它一直指向最新的 segment。
          // 快取它會讓播放器拿到過期的 segment 清單而卡住。
          'Cache-Control': 'no-store',
        },
      });
    }

    // Segment / 其他二進位內容 —— **串流**回傳，不緩衝整份
    const headers = new Headers(CORS_HEADERS);
    headers.set('Content-Type', contentType || 'application/octet-stream');
    headers.set('Accept-Ranges', 'bytes');

    /**
     * Segment 可以被 CDN 快取 —— 但必須先「正規化」成 200 回應。
     *
     * ## 為什麼需要正規化
     *
     * 實測：某些上游（如央視來源的 `121.19.134.149:808`）
     * **沒有 Range 標頭就會回 404**（163 bytes 的錯誤頁），
     * 只有帶 `Range: bytes=0-` 才會回完整的 segment。
     * 所以代理**必須**轉發 Range —— 這也是為什麼 hls.js 對 segment
     * 送 Range 時才能正常運作。
     *
     * 但帶 Range 的回應是 `206 Partial Content`，
     * 而 **206 不能被 CDN 快取**：
     *   · 內容是「部分」的，快取後再給其他 Range 的請求會位元組錯亂
     *   · hls.js 會把 segment 判定為損壞而無法播放
     *
     * 實測 `Range: bytes=0-` 其實就是「從頭到尾全部」，
     * 也就是完整的 segment。所以我們把上游的 206 **改寫成 200**，
     * 去掉 Content-Range，這樣就能安全地被快取。
     *
     * ## ⚠️ 判斷「內容完整」不能只看 Content-Range
     *
     * 實測：直播 segment 只活約 **30 秒**。上游對已過期的 segment
     * 回的是 **HTTP 206 + `Content-Range: bytes 0-162/163`**，
     * 而內容其實是一個 163 bytes 的 **HTML 404 錯誤頁**：
     *
     *   <!DOCTYPE html>...<title>404</title>...
     *
     * 單看 `bytes 0-162/163`（結尾 == 總長度）會誤判成「完整內容」，
     * 於是把這個 HTML 錯誤頁當成 segment 回 200 + `max-age=300` 快取起來 ——
     * 使用者就會拿到 HTML 當影片，且被釘住 5 分鐘。
     *
     * 所以判斷必須加上**位元組層級**的驗證。
     *
     * ## ⚠️ fMP4 不能只認 'ftyp'（2026-11-21 線上實測）
     *
     * 初版只接受 `ftyp`，結果 **天映頻道整個播不出來**（線上實測 502）。
     *
     * 原因在 ISO BMFF 規格（W3C MSE Byte Stream Format）：
     *   · **初始化區段**（`EXT-X-MAP`）= `ftyp` + `moov`
     *   · **媒體區段**（media segment）= 選用的 `styp` + `moof` + `mdat`
     *
     * 也就是說 **`ftyp` 只會出現在初始化區段**；
     * 真正的影片片段開頭是 `styp`（或直接 `moof`）。
     *
     * 實測天映（`10.fast.hidns.vip/163189/ccm`）：
     *   init.txt  → box[4:8] = 'ftyp'  （初始化區段）
     *   10769….jpg → box[4:8] = 'styp' （媒體區段）← 只認 ftyp 會被誤殺
     *
     * 所以這裡接受**所有合法的頂層 box 型別**。
     */
    const contentRange = upstream.headers.get('content-range');
    const rangeMatch = contentRange
      ? /bytes (\d+)-(\d+)\/(\d+)/.exec(contentRange)
      : null;

    /**
     * 回應是否「從資源的開頭開始」。
     *
     * 位元組層級的判斷（0x47 / box 型別）只有在拿到**開頭**時才成立。
     *
     * byte-range playlist（`#EXT-X-BYTERANGE`）會讓 hls.js 送
     * `Range: bytes=100-200` —— 這時回應的第一個位元組是位元組 100，
     * 不是 0x47 也不是 box 開頭。若照樣套用位元組判斷，會**誤判成錯誤頁**
     * 而回 502，讓頻道播不出來。
     *
     * 所以只有在「從頭開始」時才做位元組驗證；中途的片段一律視為
     * 合法但不可快取（維持 206 + Content-Range）。
     */
    const startsAtBeginning =
      upstream.status === 200 ||
      (rangeMatch !== null && Number(rangeMatch[1]) === 0);

    /**
     * ISO BMFF 合法的頂層 box 型別（4 bytes ASCII）。
     *
     * 依 W3C「ISO BMFF Byte Stream Format」規格：
     *   · 初始化區段：`ftyp`（後接 `moov`），前面可有 `pdin`/`free`/`sidx`
     *   · 媒體區段：選用的 `styp`，後接 `moof`、`mdat`
     *   · 片段之間可出現其他 ISO/IEC 14496-12 定義的 box
     *
     * 規格允許的 box 出現在最前面，所以這些都要視為合法串流內容。
     */
    const ISO_BMFF_BOX_TYPES = new Set([
      'ftyp', // File Type Box —— 初始化區段開頭
      'styp', // Segment Type Box —— 媒體區段開頭
      'moof', // Movie Fragment Box
      'mdat', // Media Data Box
      'moov', // Movie Box
      'sidx', // Segment Index Box
      'emsg', // Event Message Box
      'prft', // Producer Reference Time Box
      'pdin', // Progressive Download Information Box
      'free', // Free Space Box
      'skip', // Skipped Space Box（部分 CDN 會把 free 改名為 skip）
    ]);

    /**
     * 位元組層級的「這是有效串流內容」判定。
     *
     * 我們已經讀了第一個 chunk（為了嗅探 manifest），
     * 所以可以直接檢查它的開頭。
     */
    const boxType =
      firstChunk.length >= 8
        ? String.fromCharCode(
            firstChunk[4],
            firstChunk[5],
            firstChunk[6],
            firstChunk[7],
          )
        : '';

    const looksLikeStream =
      firstChunk.length > 0 &&
      (firstChunk[0] === 0x47 || // MPEG-TS 同步位元組
        // fMP4 / ISO BMFF：合法的頂層 box 型別
        ISO_BMFF_BOX_TYPES.has(boxType));

    // Content-Range 宣稱「從頭到尾全部」
    const rangeCoversWhole =
      rangeMatch !== null &&
      Number(rangeMatch[1]) === 0 &&
      Number(rangeMatch[2]) + 1 === Number(rangeMatch[3]);

    // 必須同時滿足：位元組看起來是串流 + Range 涵蓋全部 + HTTP 200
    const isFullContent =
      looksLikeStream &&
      startsAtBeginning &&
      (upstream.status === 200 || rangeCoversWhole) &&
      // 排除 HTML/XML 錯誤頁（它們不會通過 0x47 / box 型別檢查，
      //  但這裡再明確擋一次，萬一上游把錯誤頁包成合法的 MP4 容器）
      !/^\s*</.test(new TextDecoder().decode(firstChunk.slice(0, 16)));

    if (startsAtBeginning && !looksLikeStream) {
      // 上游回的不是串流內容（多半是 HTML 錯誤頁或已過期的 segment）
      console.warn(
        `[代理] 上游回應不是串流內容（status=${upstream.status} ` +
          `content-range=${contentRange ?? '無'}）→ 不快取，回 502`,
      );
      return NextResponse.json(
        { error: '來源回應的不是串流內容（可能是已過期的 segment 或錯誤頁）' },
        { status: 502 },
      );
    }

    if (isFullContent) {
      headers.set('Cache-Control', 'public, max-age=300, s-maxage=300');
    } else {
      // 真的只有部分內容 → 不能快取
      headers.set('Cache-Control', 'no-store');
    }
    // 轉發上游的長度（若有），讓瀏覽器知道預期大小
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) headers.set('Content-Length', contentLength);

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        // 先送出判斷型別時已經讀到的第一塊
        if (firstChunk.byteLength > 0) {
          controller.enqueue(firstChunk);
        }
        // 再送出速度檢查時多讀的那幾塊（不能丟掉，否則內容會缺一段）
        for (const c of pendingChunks) {
          controller.enqueue(c);
        }
        try {
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            controller.enqueue(next.value);
          }
          controller.close();
        } catch (e) {
          controller.error(e);
        }
      },
      cancel(reason) {
        // 客戶端取消時也取消上游，避免佔住來源頻寬
        void reader.cancel(reason).catch(() => {});
      },
    });

    /**
     * 回應狀態碼正規化。
     *
     * 上游因為我們轉發了 Range 而回 206，但實際內容是完整的
     * （`bytes 0-N/N`）。我們改回 200 並移除 Content-Range：
     *   · 200 的完整內容可以被 CDN 安全快取
     *   · 206 的「部分內容」語意會讓快取與 hls.js 的位元組計算出錯
     *
     * 若上游真的只給了部分內容（`bytes 0-M/N` 且 M < N-1），
     * 就維持原本的 206 與 Content-Range，不做正規化。
     */
    const responseStatus = isFullContent ? 200 : upstream.status;
    if (!isFullContent && contentRange) {
      headers.set('Content-Range', contentRange);
    }

    return new NextResponse(stream, { status: responseStatus, headers });
  } catch (e) {
    return NextResponse.json(
      { error: `代理失敗：${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }
}

/** 合併多個 Uint8Array 成單一 Buffer */
function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
