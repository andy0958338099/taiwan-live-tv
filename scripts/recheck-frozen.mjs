#!/usr/bin/env node
/**
 * recheck-frozen.mjs — 對「疑似停播」的來源做獨立複驗
 *
 * 為什麼需要獨立複驗：
 *   2026-11-22 實測 —— 同時跑兩個探測器時，CDN 會對 media playlist
 *   回應快取，兩邊讀到**同一份舊的快取清單**，於是序號看起來不動，
 *   被誤判成「已停播」。手動 curl（不同連線、不同快取鍵）則顯示序號正常前進。
 *
 * 做法：連續取樣 N 次（間隔 = targetduration），看序號是否前進。
 *   · 每次取樣都帶一個 cache-busting query，避免吃到快取
 *   · 若帶 cache-buster 會破壞簽章／參數，就改用不同的 User-Agent
 *     （實測 hidns.vip / cc.cd 這類 CDN 的快取鍵不含 UA）
 */
import { readFileSync } from 'node:fs';

const UA_BASE =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const TARGETS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const SAMPLES = 3;
const INTERVAL_MS = 15000;

const seqOf = (t) => {
  const m = t.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m);
  return m ? Number(m[1]) : null;
};

/** 從 master manifest 追到 media playlist */
async function resolveMediaPlaylist(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA_BASE },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return { err: `HTTP ${res.status}` };
  const text = await res.text();
  if (!text.trimStart().startsWith('#EXTM3U')) return { err: '非 m3u8' };
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return { err: '無 segment' };
  if (/\.(ts|m4s|mp4|aac)(\?|$)/i.test(lines[0])) {
    return { mediaUrl: url, text };
  }
  const childUrl = new URL(lines[0], url).href;
  const cres = await fetch(childUrl, {
    headers: { 'User-Agent': UA_BASE },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!cres.ok) return { err: `child HTTP ${cres.status}` };
  const ctext = await cres.text();
  if (!ctext.trimStart().startsWith('#EXTM3U')) return { err: 'child 非 m3u8' };
  return { mediaUrl: childUrl, text: ctext };
}

for (const t of TARGETS) {
  const [url, uaTag] = t.split('|');
  const UA = uaTag ? `${UA_BASE} ${uaTag}` : UA_BASE;
  const r = await resolveMediaPlaylist(url);
  if (r.err) {
    console.log(`✗ ${url}\n    ${r.err}`);
    continue;
  }
  const tdM = r.text.match(/^#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/m);
  const td = tdM ? Number(tdM[1]) : 6;
  const seqs = [];
  for (let i = 0; i < SAMPLES; i++) {
    try {
      const res = await fetch(r.mediaUrl, {
        headers: { 'User-Agent': UA },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      const txt = res.ok ? await res.text() : '';
      seqs.push(seqOf(txt));
    } catch {
      seqs.push(null);
    }
    if (i < SAMPLES - 1) await new Promise((x) => setTimeout(x, INTERVAL_MS));
  }
  const advancing = seqs[seqs.length - 1] !== seqs[0] && seqs.every((s) => s !== null);
  console.log(
    `${advancing ? '▶ 前進' : '✗ 停播'} ${url}\n    seq: ${seqs.join(' → ')}  td=${td}s  media=${r.mediaUrl}`,
  );
}
