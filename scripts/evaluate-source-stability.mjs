#!/usr/bin/env node
/**
 * evaluate-source-stability.mjs — 評估一個來源「能不能好好播出來」
 *
 * ## 為什麼需要這一支
 *
 * 位元組驗證通過 ≠ 能穩定播放。實測（2026-11-22）踩到三種狀況：
 *
 *   1. **NO SIGNAL 佔位畫面** —— 技術上完全正常，畫面卻是藍底插畫。
 *      （要靠目視驗證抓，本指令抓不到，請搭配 verify-channel-visually.mjs）
 *   2. **segment 會過期** —— 某些來源只保留不到 60 秒的 segment 視窗，
 *      manifest 與 segment 請求之間稍微一慢就 404。
 *   3. **上游負載平衡** —— 同一個 manifest 連抓兩次會拿到不同來源實例，
 *      各自有獨立的 segment 序號 → 抓 manifest 的實例跟抓 segment 的
 *      實例對不上 → 404。
 *
 * 本指令用「幾輪 manifest → 立刻抓第一個 segment」來量化這些問題。
 *
 * 用法：node scripts/evaluate-source-stability.mjs --urls a,b,c [--rounds 3]
 *       node scripts/evaluate-source-stability.mjs --channel 央視台球
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const ROUNDS = parseInt(arg('rounds', '3'), 10);
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout ?? 15000);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': UA, ...(opts.headers ?? {}) },
    });
    return { res, elapsed: Date.now() - t0 };
  } finally {
    clearTimeout(t);
  }
}

function byteKind(buf) {
  if (buf.length >= 1 && buf[0] === 0x47) return 'mpegts';
  if (buf.length >= 12 && buf.slice(4, 8).toString('latin1') === 'ftyp') return 'fmp4';
  if (buf.length >= 5 && buf.slice(0, 5).toString('latin1') === '<html') return 'html';
  return 'unknown';
}

/** manifest → 第一個 segment 網址（多變位追一層） */
function firstSegment(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let pendingVariant = false;
  const segs = [];
  for (const l of lines) {
    if (l.startsWith('#')) {
      if (/^#EXT-X-STREAM-INF/i.test(l)) pendingVariant = true;
      continue;
    }
    if (pendingVariant) return { url: new URL(l, baseUrl).href, kind: 'variant' };
    segs.push(l);
  }
  return segs.length ? { url: new URL(segs[0], baseUrl).href, kind: 'media' } : null;
}

async function evaluate(url) {
  const rounds = [];
  for (let i = 0; i < ROUNDS; i++) {
    const round = { i: i + 1, ok: false, detail: '', seq: null, segBytes: null, segMs: null, kind: null };
    try {
      const { res } = await get(url);
      if (!res.ok) { round.detail = `manifest HTTP ${res.status}`; rounds.push(round); continue; }
      const text = await res.text();
      if (!text.includes('#EXTM3U')) { round.detail = '非 m3u8'; rounds.push(round); continue; }
      const seqm = text.match(/MEDIA-SEQUENCE:(\d+)/);
      round.seq = seqm ? Number(seqm[1]) : null;
      round.isLive = !text.includes('#EXT-X-ENDLIST');

      let seg = firstSegment(text, res.url);
      // 多變位 → 追一層 child manifest
      if (seg?.kind === 'variant') {
        const c = await get(seg.url).catch(() => null);
        if (c?.res?.ok) {
          const ct = await c.res.text();
          if (ct.includes('#EXTM3U')) {
            const inner = firstSegment(ct, seg.url);
            if (inner) seg = inner;
          }
        }
      }
      if (!seg) { round.detail = '無 segment'; rounds.push(round); continue; }

      const t0 = Date.now();
      const s = await get(seg.url, { headers: { range: 'bytes=0-262143' }, timeout: 20000 });
      round.segMs = Date.now() - t0;
      if (!s.res.ok) { round.detail = `segment HTTP ${s.res.status}`; rounds.push(round); continue; }
      const buf = Buffer.from(await s.res.arrayBuffer());
      round.segBytes = buf.length;
      round.kind = byteKind(buf);
      if (round.kind === 'mpegts' || round.kind === 'fmp4') {
        round.ok = true;
        round.detail = `${round.kind} ${(buf.length / 1024 / 1024).toFixed(2)}MB / ${round.segMs}ms`;
      } else {
        round.detail = `segment 位元組 ${round.kind}`;
      }
    } catch (e) {
      round.detail = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message);
    }
    rounds.push(round);
    if (i < ROUNDS - 1) await sleep(4000);
  }
  const ok = rounds.filter((r) => r.ok).length;
  const seqs = rounds.map((r) => r.seq).filter((s) => s !== null);
  const seqJumps = seqs.length > 1 ? Math.max(...seqs) - Math.min(...seqs) : 0;
  return { url, ok, total: ROUNDS, rounds, seqJumps };
}

// ── 目標來源 ──
let targets = [];
const urlsArg = arg('urls', '');
if (urlsArg) {
  targets = urlsArg.split(',').filter(Boolean);
} else {
  const channelArg = arg('channel', '');
  if (!channelArg) {
    console.error('用法：--urls <a,b,c> 或 --channel <頻道名>');
    process.exit(1);
  }
  // 從目錄找該頻道的所有來源
  const cat = JSON.parse(readFileSync(join(__dirname, '..', 'shared', 'channels.json'), 'utf8'));
  const ch = cat.channels.find((c) => c.channel_name.includes(channelArg));
  if (!ch) { console.error(`找不到頻道：${channelArg}`); process.exit(1); }
  targets = [
    ch.stream_url,
    ...(ch.playlist_source?.backup_urls ?? []).map((b) => b.url),
  ];
  console.log(`頻道 ${ch.channel_name} 有 ${targets.length} 個來源\n`);
}

console.log(`═══ 評估 ${targets.length} 個來源（每個 ${ROUNDS} 輪）═══\n`);
const results = [];
for (const u of targets) {
  const r = await evaluate(u);
  results.push(r);
  const pct = Math.round((r.ok / r.total) * 100);
  console.log(`  ${r.ok === r.total ? '✓' : r.ok > 0 ? '⚠' : '✗'} ${u.slice(0, 74)}`);
  console.log(`      成功 ${r.ok}/${r.total} (${pct}%)   序號跨度 ${r.seqJumps}`);
  for (const rd of r.rounds) {
    console.log(`        第${rd.i}輪 seq=${rd.seq ?? '—'} ${rd.ok ? '✓' : '✗'} ${rd.detail}`);
  }
  console.log('');
}

console.log('═══ 總結（依成功率排序）═══');
for (const r of [...results].sort((a, b) => b.ok / b.total - a.ok / a.total)) {
  console.log(`  ${String(Math.round((r.ok / r.total) * 100)).padStart(3)}%  ${r.ok}/${r.total}  ${r.url.slice(0, 72)}`);
}
const stable = results.filter((r) => r.ok === r.total);
console.log(`\n  完全穩定的來源：${stable.length} 個`);
for (const s of stable) console.log(`    ✓ ${s.url}`);
