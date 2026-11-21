#!/usr/bin/env node
/**
 * verify-manifest-freshness.mjs — 量測「線上 manifest 是否會被 CDN 冰住」
 *
 * ## 為什麼需要這個測試
 *
 * HLS live 的 manifest 是一份「滾動清單」：它一直指向最新的 segment。
 * 如果 manifest 被 CDN 快取住（而不是每次都回源），播放器會拿到一份
 * **過期的 segment 清單** —— 那些 segment 可能已經被上游清掉。
 *
 * 參考資料（CDN Blog 的 hls.js 指南）：
 *   "If a live playlist is cached for a full 6-second target duration, a viewer
 *    can receive a copy that is one segment stale. hls.js then sees no new
 *    segment, waits, and refetches. In the worst case, that adds 6 seconds of
 *    latency or a stall."
 *   "Live stream drifts 30 seconds or more behind: the live media playlist is
 *    cached too long, or the CDN ignores origin Cache-Control."
 *
 * 代理程式碼裡 manifest 設定的是 `Cache-Control: no-store`，
 * 但 **Netlify 的 CDN 是否真的遵守** 必須實測 —— 程式碼寫了不等於生效。
 *
 * ## 測試方法
 *
 *   1. 以**瀏覽器的方式**（普通 GET，不帶 x-nextjs-data）反覆請求 manifest
 *   2. 每 5 秒記錄：
 *      · `age` 標頭（>0 代表是 CDN 快取命中，不是回源）
 *      · `cache-control` / `netlify-cdn-cache-control`
 *      · manifest 內容的雜湊（內容不變 = 被冰住）
 *      · `#EXT-X-MEDIA-SEQUENCE`（序號不變 = 沒有新 segment）
 *   3. 連續 N 輪後判定：
 *      · age 一直 >0 且內容不變 → manifest 被 CDN 冰住 ❌
 *      · 內容會變 / age = 0 → manifest 每次都回源 ✅
 *
 * 用法：node scripts/verify-manifest-freshness.mjs [--base https://...] [--rounds 8] [--interval 5]
 */
import { createHash } from 'node:crypto';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const BASE = arg('base', 'https://taiwan-live-tv.netlify.app');
const ROUNDS = Number(arg('rounds', '8'));
const INTERVAL_MS = Number(arg('interval', '5')) * 1000;

const DEFAULT_IDS = [
  'playlist-龍華-龍華電視',
  'playlist-Now-now-tv',
  'tw-goodtv-ch1',
  'iptvorg-dalitv-tw-sd',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractSequence(text) {
  const m = text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m);
  return m ? Number(m[1]) : null;
}

async function main() {
  console.log('═'.repeat(78));
  console.log('驗證：線上 manifest 是否會被 CDN 冰住（live playlist 新鮮度）');
  console.log('═'.repeat(78));
  console.log(`測試站點：${BASE}`);
  console.log(`輪數：${ROUNDS}　間隔：${INTERVAL_MS / 1000} 秒`);
  console.log('');

  const cat = await (await fetch(`${BASE}/channels.json`)).json();
  const channels = cat.channels;
  const ids = arg('ids', '')
    .split(',')
    .filter(Boolean);
  const targets = ids.length ? ids : DEFAULT_IDS;

  const results = [];

  for (const id of targets) {
    const ch = channels.find((c) => c.channel_id === id);
    if (!ch) {
      console.log(`  ? ${id} —— 頻道不存在`);
      continue;
    }
    const enc = Buffer.from(ch.stream_url, 'utf8').toString('base64url');
    const url = `${BASE}/api/proxy/${enc}`;

    console.log(`── ${ch.channel_name} (${id})`);
    const samples = [];
    for (let i = 0; i < ROUNDS; i += 1) {
      // ⚠️ 用普通 GET（瀏覽器 hls.js 的真實行為），**不帶** x-nextjs-data
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131.0 Safari/537.36' },
      });
      const text = await res.text();
      const sha = createHash('sha256').update(text).digest('hex').slice(0, 10);
      const age = res.headers.get('age');
      const cc = res.headers.get('cache-control');
      const ncc = res.headers.get('netlify-cdn-cache-control');
      const nfCache = res.headers.get('x-nf-cache') ?? res.headers.get('x-nf-request-id');
      const seq = extractSequence(text);
      samples.push({
        age: age === null ? null : Number(age),
        sha,
        seq,
        cc,
        ncc,
        status: res.status,
      });
      console.log(
        `   [${i + 1}/${ROUNDS}] age=${age ?? '—'} seq=${seq ?? '—'} ` +
          `sha=${sha} status=${res.status} cc="${cc ?? '—'}"` +
          (ncc ? ` netlify-cc="${ncc}"` : '') +
          (nfCache ? ` nf="${nfCache}"` : ''),
      );
      if (i < ROUNDS - 1) await sleep(INTERVAL_MS);
    }

    const ages = samples.map((s) => s.age);
    const shas = new Set(samples.map((s) => s.sha));
    const seqs = samples.map((s) => s.seq).filter((s) => s !== null);
    const uniqueSeqs = new Set(seqs);
    const allServedFromCache = ages.every((a) => a !== null && a > 0);
    const neverChanged = shas.size === 1;
    const seqNeverAdvanced = seqs.length > 0 && uniqueSeqs.size === 1;

    console.log('');
    console.log(`   不同內容數：${shas.size}　不同序號數：${uniqueSeqs.size}`);
    console.log(`   age 值：${ages.map((a) => a ?? '—').join(', ')}`);

    let verdict;
    if (neverChanged && seqNeverAdvanced) {
      verdict = '❌ manifest 被冰住（內容與序號都不變）';
    } else if (allServedFromCache && shas.size > 1) {
      verdict = '⚠️ 內容有變但每次都是 CDN 快取命中（不是回源）';
    } else if (shas.size > 1) {
      verdict = '✅ manifest 會更新（每次回源）';
    } else {
      verdict = '⚠️ 內容不變（可能是來源停播或 segment 序號未變）';
    }
    console.log(`   判定：${verdict}`);
    console.log('');

    results.push({ id, name: ch.channel_name, verdict, shas: shas.size, seqs: uniqueSeqs.size });
  }

  console.log('═'.repeat(78));
  console.log('總結');
  console.log('═'.repeat(78));
  for (const r of results) {
    console.log(`${r.verdict.startsWith('✅') ? '✓' : '!'} ${r.name.padEnd(16)} ${r.verdict}`);
  }
  const bad = results.filter((r) => r.verdict.startsWith('❌'));
  console.log('');
  console.log(
    bad.length === 0
      ? '結果：✓ 沒有頻道的 manifest 被 CDN 冰住'
      : `結果：✗ ${bad.length} 個頻道的 manifest 被 CDN 冰住`,
  );
  process.exit(bad.length === 0 ? 0 : 1);
}

main();
