import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 舊版代理端點（目標網址在 query string）—— **已停用，改為轉址**。
 *
 * ## 為什麼要保留這個檔案
 *
 * 2026-11-21 發現 Netlify 的 Next.js runtime 的 CDN 快取鍵
 * **不包含 query string**（`netlify-vary: query=__nextDataReq|_rsc`）。
 * 舊版把目標網址放在 `?url=`，導致所有頻道共用同一個快取項目 ——
 * manifest 請求會拿到別人的 segment 位元組（0x47 MPEG-TS），
 * 使用者拿到的是一段影片而不是清單 → 頻道完全播不出來。
 *
 * 實測：6 個不同頻道拿到的 manifest sha256 完全相同。
 *
 * 新版把目標網址 base64url 編碼後放在 **path**：
 *   `/api/proxy/<base64url(target)>?sig=<sig>`
 *
 * 見 `web/src/app/api/proxy/[target]/route.ts`。
 *
 * ## 這個 shim 的作用
 *
 * 舊的 `/api/proxy?url=...` 網址可能還被瀏覽器快取、或被使用者存成書籤。
 * 把它們 **308 轉址** 到新版形式，而不是直接 404：
 *   · 舊的 manifest 網址（沒有 sig）→ 轉到新版 manifest 路徑
 *   · 舊的 segment 網址（有 sig）→ 轉到新版 segment 路徑
 *
 * ⚠️ 回應本身必須 `no-store` —— 轉址回應若被快取，
 * 舊的壞內容就會繼續被散播。
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get('url');
  const sig = request.nextUrl.searchParams.get('sig');

  if (!url) {
    return NextResponse.json(
      { error: '缺少 url 參數（請改用 /api/proxy/<base64url(target)>）' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const encoded = Buffer.from(url, 'utf8').toString('base64url');
  const target = new URL(`/api/proxy/${encoded}`, request.nextUrl.origin);
  if (sig) target.searchParams.set('sig', sig);

  return NextResponse.redirect(target, {
    status: 308,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Origin, Accept, Referer',
      'Cache-Control': 'no-store',
    },
  });
}
