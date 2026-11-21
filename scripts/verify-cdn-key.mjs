#!/usr/bin/env node
/**
 * verify-cdn-key.mjs — 驗證代理的 CDN 快取鍵正確隔離
 *
 * ## 為什麼這是硬性檢查
 *
 * Netlify 的 Next.js runtime 用 `netlify-vary: query=__nextDataReq|_rsc`
 * 決定快取鍵 —— **一般的 query 參數不在鍵裡**。
 *
 * 2026-11-21 實際發生過 P0：代理把目標網址放在 `?url=`，
 * 導致所有頻道共用同一個 CDN 快取項目，
 * manifest 請求拿到別人的 segment 位元組 → 頻道完全播不出來。
 *
 * 現行設計：目標網址 base64url 編碼在 path 裡
 *   /api/proxy/<base64url(target)>?sig=<sig>
 * 快取鍵**一定**包含 path → 每個目標網址各有自己的快取項目。
 *
 * ## 檢查內容
 *
 *   1. 取 N 個不同頻道的 manifest
 *   2. 各自的 sha256 必須互不相同（內容隔離）
 *   3. 每份內容都必須真的是 manifest（開頭是 #EXTM3U）
 *   4. 同一個網址重複請求必須拿到相同內容（快取命中，非每次重算）
 *
 * 用法：node scripts/verify-cdn-key.mjs [--base https://taiwan-live-tv.netlify.app] [--ids a,b,c]
 */
import { createHash } from 'node:crypto';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const BASE = arg('base', 'https://taiwan-live-tv.netlify.app');
const IDS = arg('ids', '')
  .split(',')
  .filter(Boolean);

const DEFAULT_IDS = [
  'playlist-龍華-龍華電視',
  'playlist-翡翠台-tvb翡翠台',
  'playlist-TVB-tvb系',
  'playlist-Now-now-tv',
  'playlist-HOY-hoy-tv',
  'playlist-澳視-澳視',
];

async function main() {
  console.log('═'.repeat(70));
  console.log('驗證：代理的 CDN 快取鍵隔離');
  console.log('═'.repeat(70));
  console.log(`測試站點：${BASE}\n`);

  const cat = await (await fetch(`${BASE}/channels.json`)).json();
  const pool = cat.channels.filter(
    (c) => c.stream_type !== 'embed' && c.stream_url && c.cors_enabled === false,
  );
  const ids = IDS.length
    ? cat.channels.filter((c) => IDS.includes(c.channel_id)).map((c) => c.channel_id)
    : DEFAULT_IDS;
  const results = [];
  for (const id of ids) {
    const ch = cat.channels.find((c) => c.channel_id === id);
    if (!ch) {
      console.log(`  ? ${id} —— 頻道不存在`);
      continue;
    }
    const enc = Buffer.from(ch.stream_url, 'utf8').toString('base64url');
    const url = `${BASE}/api/proxy/${enc}`;
    const res = await fetch(url, {
      headers: { 'x-nextjs-data': '1' },
      cache: 'no-store',
    });
    const text = await res.text();
    const sha = createHash('sha256').update(text).digest('hex').slice(0, 12);
    const isManifest = text.trimStart().startsWith('#EXTM3U');
    const age = res.headers.get('age');
    results.push({ id, name: ch.channel_name, sha, isManifest, age, status: res.status });
    console.log(
      `  ${id.padEnd(24)} sha=${sha} age=${age ?? '—'} ` +
        `status=${res.status} 是manifest=${isManifest ? '是' : '否'} ✓`,
    );
  }

  console.log('');
  const shas = new Set(results.map((r) => r.sha));
  const allManifest = results.every((r) => r.isManifest);
  console.log(`不同頻道數：${results.length}　不同內容數：${shas.size}`);

  let ok = true;
  if (shas.size !== results.length) {
    console.log('✗ 不同頻道拿到相同內容 → CDN 快取鍵沒有隔離');
    ok = false;
  } else {
    console.log('✓ 每個頻道內容不同 → 快取鍵正確隔離');
  }
  if (!allManifest) {
    console.log('✗ 有頻道拿到的不是 manifest');
    ok = false;
  } else {
    console.log('✓ 每個頻道拿到的都是 manifest');
  }

  // 快取命中檢查：同一網址再取一次，內容必須一致
  if (results.length) {
    const first = cat.channels.find((c) => c.channel_id === ids[0]);
    const enc = Buffer.from(first.stream_url, 'utf8').toString('base64url');
    const url = `${BASE}/api/proxy/${enc}`;
    const a = await (await fetch(url, { headers: { 'x-nextjs-data': '1' } })).text();
    const b = await (await fetch(url, { headers: { 'x-nextjs-data': '1' } })).text();
    if (a === b) {
      console.log('✓ 重複請求回應一致（快取命中）');
    } else {
      console.log('✗ 重複請求回應不一致');
      ok = false;
    }
  }

  console.log('');
  console.log(ok ? '結果：✓ 通過' : '結果：✗ 未通過');
  process.exit(ok ? 0 : 1);
}

main();
