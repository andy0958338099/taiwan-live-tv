#!/usr/bin/env node
/**
 * audit-all-via-proxy.mjs — 對 channels.json 每個 HLS 頻道的主來源做代理路徑驗證
 *
 * ## 為什麼要走代理
 *
 * 2026-11-22 實測教訓（客家電視台）：
 *   · 本機直連 `h5cul1yar48um3t.wcetv.com` → TCP 443 連線逾時（nc 443 FAIL）
 *   · 同一時間正式站代理 → HTTP 200，MEDIA-SEQUENCE 525250 → 525255 前進
 *
 * 也就是說「本機連不上」可能是**我的 IP 被該 CDN 限流**，而不是來源已死。
 * 若照本機直連結果下架，會把還在播的頻道誤殺。
 *
 * 代理路徑還有個好處：它就是 Web 版使用者實際走的路徑
 * （`cors_enabled: false` 的來源本來就會走 `/api/proxy`）。
 *
 * 代理的 `isAllowed()` 只放行 channels.json 裡出現過的網址（或帶有效簽章者），
 * 所以這個腳本剛好能驗「清單裡的主來源」——正是我們要問的問題。
 *
 * 用法：node scripts/audit-all-via-proxy.mjs [--seq] [--conc 4]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHANNELS_PATH = join(ROOT, 'shared', 'channels.json');

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);

const WITH_SEQ = flag('seq');
const CONC = parseInt(arg('conc', '4'), 10);
const ONLY = (arg('ids', '') || '').split(',').filter(Boolean);

const ORIGIN = 'https://taiwan-live-tv.netlify.app';
const PROXY = `${ORIGIN}/api/proxy`;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const enc = (u) => Buffer.from(u).toString('base64url');
const abs = (p) => (p.startsWith('/') ? `${ORIGIN}${p}` : p);

const seqOf = (t) => {
  const m = t.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m);
  return m ? Number(m[1]) : null;
};

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

async function audit(url) {
  let res;
  try {
    res = await fetch(`${PROXY}/${enc(url)}`, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(45000),
    });
  } catch (e) {
    return { ok: false, reason: `代理失敗 ${e.name ?? e.message}`, url };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return {
      ok: false,
      reason: `代理 HTTP ${res.status}${body.slice(0, 60) ? ` (${body.slice(0, 60).replace(/\s+/g, ' ')})` : ''}`,
      url,
    };
  }

  let text = await res.text();
  if (!text.trimStart().startsWith('#EXTM3U')) {
    return { ok: false, reason: '非 m3u8', url };
  }
  if (text.includes('#EXT-X-ENDLIST')) {
    return { ok: false, reason: 'VOD', url };
  }
  let seq = seqOf(text);
  let mediaUrl = `${PROXY}/${enc(url)}`;

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

    if (buf.length < 64) return { ok: false, reason: `segment 過短 ${buf.length}B`, url };
    const s = sniff(buf);
    if (s.kind !== 'mpegts' && s.kind !== 'fmp4') {
      return { ok: false, reason: `位元組不符 ${s.kind}（首位 ${s.first}）`, url };
    }

    const out = { ok: true, reason: '', kind: s.kind, bytes: buf.length, ms, seq, url };

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

async function main() {
  const catalog = JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'));
  let targets = catalog.channels.filter((c) => !c.embed_url && c.stream_url);
  if (ONLY.length) targets = targets.filter((c) => ONLY.includes(c.channel_id));

  console.log('═'.repeat(78));
  console.log(`代理路徑驗證 ${targets.length} 個 HLS 頻道主來源`);
  console.log('═'.repeat(78));

  const results = [];
  const queue = [...targets];
  let done = 0;

  async function worker() {
    while (queue.length) {
      const ch = queue.shift();
      let r;
      try {
        r = await audit(ch.stream_url);
      } catch (e) {
        r = { ok: false, reason: `例外 ${e.name ?? e.message}`, url: ch.stream_url };
      }
      results.push({
        channel_id: ch.channel_id,
        channel_name: ch.channel_name,
        region: ch.region,
        cors_enabled: ch.cors_enabled,
        stream_url: ch.stream_url,
        ...r,
      });
      done++;
      process.stdout.write(`  驗證中 ${done}/${targets.length}\r`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  process.stdout.write(' '.repeat(40) + '\r');

  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);

  console.log('');
  console.log('不通過：');
  for (const r of bad) {
    console.log(`  ✗ ${r.channel_name.padEnd(20)} ${r.reason}`);
    console.log(`      ${r.stream_url}`);
  }
  console.log('─'.repeat(78));
  console.log(`通過 ${ok.length}/${results.length}｜不通過 ${bad.length}`);

  const out = { audited_at: new Date().toISOString(), results };
  writeFileSync(
    '/Users/andy/.hermes/cache/scratch/proxy-audit.json',
    JSON.stringify(out, null, 2) + '\n',
    'utf8',
  );
  console.log('已寫入 /Users/andy/.hermes/cache/scratch/proxy-audit.json');
}

main();
