#!/usr/bin/env node
/**
 * audit-via-proxy.mjs — 透過正式站代理驗證來源
 *
 * ## 為什麼需要這個
 *
 * 2026-11-22 實測教訓：某些廣播商 CDN（例如客家電視台的
 * `h5cul1yar48um3t.wcetv.com`）會對**特定來源 IP** 做限流或封鎖。
 * 同一時間：
 *   · 本機直連 → TCP 443 連線逾時（nc 測試 443 FAIL）
 *   · 正式站代理（Netlify egress IP）→ HTTP 200，MEDIA-SEQUENCE 正常前進
 *
 * 若只看本機直連結果，會把「我的 IP 被擋」誤判成「來源已死」，
 * 進而錯把還在播的頻道從上線清單移除。
 *
 * 這個腳本改從正式站代理出去驗證，用的是**使用者實際會走的路徑**
 * （Web 版對 `cors_enabled: false` 的來源本來就會走代理）。
 *
 * 用法：node scripts/audit-via-proxy.mjs --urls u1,u2 [--seq]
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dfld;
};
const flag = (name) => process.argv.includes(`--${name}`);

const PROXY = 'https://taiwan-live-tv.netlify.app/api/proxy';
const RAW_URLS = (arg('urls', '') || '').split(',').filter(Boolean);
const WITH_SEQ = flag('seq');

/**
 * 把目標網址編進代理路徑。
 *
 * ⚠️ 目標網址本身可能帶 query string（例如 `?key=txiptv&playlive=1`）。
 *    base64url 編碼後不會殘留 `?` `&` `=` 等字元，所以整串編碼是安全的。
 *    但**代理回傳的改寫路徑**已經是 `/api/proxy/<b64>?sig=<hex>` 形式，
 *    這時不可再編碼（會把 `?sig=` 也編進去 → 簽章失效）。
 */
const enc = (u) => Buffer.from(u).toString('base64url');

async function getViaProxy(url, ms = 45000) {
  const res = await fetch(`${PROXY}/${enc(url)}`, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
    signal: AbortSignal.timeout(ms),
  });
  return res;
}

function sniff(buf) {
  if (!buf || !buf.length) return { kind: 'empty' };
  const b = buf;
  if (b[0] === 0x47) return { kind: 'mpegts' };
  if (b[0] === 0x3c) return { kind: 'html' };
  if (b[0] === 0xff && b[1] === 0xd8) return { kind: 'jpeg' };
  if (b[0] === 0x89 && b[1] === 0x50) return { kind: 'png' };
  if (b.length > 8) {
    const box = b.subarray(4, 8).toString('latin1');
    if (['ftyp', 'styp', 'moof', 'mdat'].includes(box)) return { kind: 'fmp4' };
  }
  const p = b.subarray(0, 64).toString('latin1');
  if (p.includes('ftyp') || p.includes('moof') || p.includes('mdat')) {
    return { kind: 'fmp4' };
  }
  return { kind: 'unknown', first: b[0].toString(16) };
}

const seqOf = (t) => {
  const m = t.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m);
  return m ? Number(m[1]) : null;
};

const ORIGIN = 'https://taiwan-live-tv.netlify.app';

/**
 * 把代理改寫後的相對路徑還原成絕對網址。
 *
 * ⚠️ 路徑裡帶 `?sig=...` 查詢字串 —— **不能**先對路徑做 base64 編碼再組網址，
 *    必須原樣保留 query，否則簽章失效 → 代理回 403。
 */
const abs = (p) => (p.startsWith('/') ? `${ORIGIN}${p}` : p);

async function audit(url) {
  let res;
  try {
    res = await getViaProxy(url);
  } catch (e) {
    return { ok: false, reason: `代理請求失敗：${e.name ?? e.message}`, url };
  }
  if (!res.ok) return { ok: false, reason: `代理 HTTP ${res.status}`, url };

  let text = await res.text();
  if (!text.trimStart().startsWith('#EXTM3U')) {
    return { ok: false, reason: '非 m3u8', url };
  }
  if (text.includes('#EXT-X-ENDLIST')) {
    return { ok: false, reason: 'VOD', url };
  }
  let seq = seqOf(text);

  // 代理會把 master manifest 的 child 網址改寫成 /api/proxy/...，
  // 所以要再往下走一層，直到拿到真正的 media playlist。
  let mediaUrl = url;
  for (let depth = 0; depth < 2; depth++) {
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (!lines.length) return { ok: false, reason: `第 ${depth} 層無 segment`, url };

    const cand = lines[lines.length - 1];
    const candUrl = abs(cand);
    // ⚠️ **先送 Range 抓前 2KB**，靠「開頭是不是 #EXTM3U」分辨清單 / segment。
    //    這是驗證口徑要求的做法，也避免把整個 3–6MB segment 抓下來
    //    （代理有「上游供應過慢就放棄」的保護，滿載下載會觸發 502）。
    let cres;
    const t0 = Date.now();
    try {
      cres = await fetch(candUrl, {
        headers: { 'User-Agent': UA, Range: 'bytes=0-2047' },
        redirect: 'follow',
        signal: AbortSignal.timeout(45000),
      });
    } catch (e) {
      return { ok: false, reason: `第 ${depth + 1} 層失敗 ${e.name ?? e.message}`, url };
    }
    const ms = Date.now() - t0;
    if (!cres.ok && cres.status !== 206) {
      return { ok: false, reason: `第 ${depth + 1} 層 HTTP ${cres.status}`, url };
    }
    let buf = Buffer.from(await cres.arrayBuffer());

    // 還是清單 → 再往下走一層
    if (buf.subarray(0, 7).toString('latin1') === '#EXTM3U') {
      if (buf.includes('#EXT-X-ENDLIST')) {
        return { ok: false, reason: `第 ${depth + 1} 層 VOD`, url };
      }
      // ⚠️ Range 會把清單截成 2048 bytes → segment 條目不完整
      //    （下一層取出來的簽章是斷的 → 代理回 502/403）。
      //    所以清單一律重新抓完整版。
      if (cres.status === 206) {
        try {
          const full = await fetch(candUrl, {
            headers: { 'User-Agent': UA },
            redirect: 'follow',
            signal: AbortSignal.timeout(45000),
          });
          if (full.ok) buf = Buffer.from(await full.arrayBuffer());
        } catch {
          /* 拿不到完整版就用截斷的 */
        }
      }
      text = buf.toString('utf8');
      mediaUrl = candUrl;
      seq = seqOf(text) ?? seq;
      continue;
    }

    if (buf.length < 64) {
      return { ok: false, reason: `segment 過短 ${buf.length}B`, url };
    }
    const s = sniff(buf);
    if (s.kind !== 'mpegts' && s.kind !== 'fmp4') {
      return { ok: false, reason: `位元組不符 ${s.kind}（首位 ${s.first}）`, url };
    }

    const out = {
      ok: true,
      reason: '',
      kind: s.kind,
      bytes: buf.length,
      ms,
      seq,
      url,
    };

    if (WITH_SEQ && seq !== null) {
      const tdM = text.match(/^#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/m);
      const td = tdM ? Number(tdM[1]) : 6;
      await new Promise((r) => setTimeout(r, Math.min(td * 1000 + 1500, 20000)));
      try {
        // ⚠️ mediaUrl 已經是「代理路徑」（/api/proxy/...），
        //    不可再套一次 base64 編碼，否則拿到的是錯誤網址 → 停播檢查會失效。
        const again = await fetch(mediaUrl.startsWith('/') ? `${ORIGIN}${mediaUrl}` : mediaUrl, {
          headers: { 'User-Agent': UA },
          redirect: 'follow',
          signal: AbortSignal.timeout(45000),
        });
        const t2 = again.ok ? await again.text() : '';
        const s2 = seqOf(t2);
        if (s2 !== null && s2 === seq) {
          out.ok = false;
          out.reason = `已停播（序號停在 ${seq}）`;
        } else if (s2 !== null) {
          out.seq = s2;
        }
      } catch {
        /* 第二次抓不到不判停播 */
      }
    }
    return out;
  }
  return { ok: false, reason: '超過最大遞迴層數', url };
}

for (const u of RAW_URLS) {
  const r = await audit(u);
  console.log(
    `${r.ok ? '✓' : '✗'} ${u}\n    ${r.reason || `${r.kind} ${r.bytes}B ${r.ms}ms seq=${r.seq}`}`,
  );
}
