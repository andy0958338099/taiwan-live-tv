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

/** 已授權頻道的入口 URL */
let ALLOWED_ENTRY_URLS: Set<string> | null = null;

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
      return `/api/proxy?url=${encodeURIComponent(abs)}&sig=${sign(abs)}`;
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

/** 單一代理端點，同時處理 manifest 與 segment */
export async function GET(request: NextRequest) {
  const target = request.nextUrl.searchParams.get('url');
  const sig = request.nextUrl.searchParams.get('sig');

  if (!target) {
    return NextResponse.json({ error: '缺少 url 參數' }, { status: 400 });
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

    const upstream = await fetch(target, {
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        ...(rangeHeader ? { Range: rangeHeader } : {}),
      },
      redirect: 'follow',
      cache: 'no-store',
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
    // 實作選擇：**整份讀進記憶體**再判斷與回應，不用 tee()。
    //
    // 為什麼不用串流：tee() 分流後若其中一支被取消讀取，
    // 另一支的 backpressure 會讓上游暫停，導致整個請求卡住
    // （實測 segment 請求 hang 住、hls.js 報 fragLoadTimeOut）。
    // 而 segment 大小約 1–8 MB，緩衝在記憶體中完全可接受，
    // 換取的是「位元組絕對正確」與「不會死鎖」。
    const buf = await upstream.arrayBuffer();
    const head = new TextDecoder().decode(buf.slice(0, 800));
    const isManifest = head.trimStart().startsWith('#EXTM3U');

    if (isManifest) {
      const text = new TextDecoder().decode(buf);
      const rewritten = rewriteManifest(text, upstream.url || target);
      return new NextResponse(rewritten, {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-store',
        },
      });
    }

    // Segment / 其他二進位內容 —— 原封不動回傳
    const headers = new Headers(CORS_HEADERS);
    headers.set('Content-Type', contentType || 'application/octet-stream');
    headers.set('Content-Length', String(buf.byteLength));
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Cache-Control', 'no-store');
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) headers.set('Content-Range', contentRange);

    return new NextResponse(buf, { status: upstream.status, headers });
  } catch (e) {
    return NextResponse.json(
      { error: `代理失敗：${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
