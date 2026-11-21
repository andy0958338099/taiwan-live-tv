#!/usr/bin/env node
/**
 * 頻道來源的身分解析工具（共用模組）。
 *
 * ## 為什麼需要「命名空間」
 *
 * 這些來源的頻道代碼只在**來源站自己的命名空間**內有意義：
 *   · `cdn.qd.je/163189/lhjd`   → 命名空間 163189，代碼 lhjd = 龍華電視
 *   · `cdn.qd.je/163189/lhrh`   → 命名空間 163189，代碼 lhrh = 龍華日韓台
 *   · `38.64.72.148/…/list/4005/playlist.m` → 命名空間 4005（另一套 ID）
 *
 * 所以判斷「是不是同一個頻道」必須比對 **(命名空間, 代碼)**，
 * 光比代碼會誤判（不同站可能撞碼）。
 *
 * ## 兩種 URL 型態
 *
 * 1. **直接路徑型** `/{數字}/{代碼}` → 代碼就在 URL 裡，不需要網路
 * 2. **轉址型**（沒有數字目錄）→ 要抓 manifest 才能知道它指向哪個頻道
 *    實例：`http://r.jdshipin.com/qClQf` 的 manifest 內部是
 *    `https://cdn6.cc.cd/163189/fct`，也就是 **TVB翡翠台**。
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/**
 * 從 URL 取出 (命名空間, 代碼)。
 *
 * ## 支援的兩種路徑形式（實測 2026-11-21）
 *
 * 1. `https://cdn.qd.je/163189/lhjd`
 *    → 命名空間 `163189`，代碼 `lhjd`
 * 2. `https://cdn3.indevs.in/stream/live/tvb/fct/`
 *    → 命名空間 `tvb`，代碼 `fct`
 *
 * 第 2 種結尾是 `/`，先去尾斜線再取。
 *
 * @returns {{ns: string, code: string} | null}
 */
export function parseChannelRef(url) {
  if (!url) return null;
  const clean = url.split('?')[0].split('#')[0].replace(/\/+$/, '');
  const segs = clean.split('/').filter(Boolean);
  if (segs.length < 2) return null;

  const code = segs[segs.length - 1];
  if (!/^[a-z0-9]{2,12}$/i.test(code)) return null;

  // 往前找命名空間：數字目錄，或 `live/<group>` 這種
  let ns = null;
  for (let i = segs.length - 2; i >= 0; i--) {
    if (/^\d{2,8}$/.test(segs[i])) {
      ns = segs[i];
      break;
    }
  }
  if (!ns) {
    // `live/tvb/fct` → ns = tvb
    const liveIdx = segs.lastIndexOf('live');
    if (liveIdx !== -1 && liveIdx + 1 < segs.length - 1) {
      ns = segs[liveIdx + 1];
    }
  }
  if (!ns) return null;

  return { ns, code: code.toLowerCase() };
}

/** 判斷是否為「直接路徑型」（URL 裡就帶得出身分） */
export function hasInlineRef(url) {
  return parseChannelRef(url) !== null;
}

/**
 * 抓 manifest，追到 segment，取出實際的頻道身分。
 *
 * @returns {Promise<{ns: string, code: string} | null>}
 */
export async function resolveChannelRef(url, timeoutMs = 15000) {
  // 直接路徑型 → 不用網路
  const inline = parseChannelRef(url);
  if (inline) return inline;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;

    const text = await res.text();
    if (!text.trimStart().startsWith('#EXTM3U')) return null;

    const first = text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'));
    if (!first) return null;

    // 子 manifest → 再抓一層
    if (!/\.(ts|m4s|mp4|aac)(\?|$)/i.test(first)) {
      const sub = await fetch(first, {
        headers: { 'User-Agent': UA },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!sub.ok) return null;
      const subText = await sub.text();
      const subFirst = subText
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#'));
      return parseChannelRef(subFirst) ?? parseChannelRef(first);
    }

    return parseChannelRef(first);
  } catch {
    return null;
  }
}

/** 兩個身分是否相同 */
export function sameRef(a, b) {
  if (!a || !b) return false;
  return a.ns === b.ns && a.code === b.code;
}

/** 身分是否可從 URL 直接取得（不需要網路） */
export function refOf(url) {
  return parseChannelRef(url);
}
