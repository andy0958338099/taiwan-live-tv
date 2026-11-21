#!/usr/bin/env node
/**
 * 診斷代理回 502 的原因。
 *
 * 502 有三個可能來源：
 *   1. 上游回非 200（已過期的 segment）
 *   2. 上游回應不是串流內容（HTML 錯誤頁）
 *   3. 「來源供應過慢」的主動放棄
 *
 * 第 3 種是**代理自己主動殺掉的** —— 如果它在直播播放的黃金路徑上
 * 誤判，就會造成明明有頻寬卻一直卡頓。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BASE = 'https://taiwan-live-tv.netlify.app';

function encodeProxyTarget(url) {
  return Buffer.from(url, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function parseM3u8(text, baseUrl) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  let targetDuration = 0;
  const segs = [];
  for (const line of lines) {
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseFloat(line.split(':')[1]) || 0;
      continue;
    }
    if (line.startsWith('#')) continue;
    segs.push(line.startsWith('http') ? line : new URL(line, baseUrl).href);
  }
  return { targetDuration, segs };
}

const channels = JSON.parse(readFileSync(join(ROOT, 'shared', 'channels.json'), 'utf8'));
const ids = process.argv.slice(2);
const targets = ids.length
  ? ids.map((id) => channels.channels.find((c) => c.channel_id === id)).filter(Boolean)
  : channels.channels.filter((c) => /清單|轉載/.test(c.source_name || '')).slice(0, 3);

let total = 0;
let fail = 0;
const reasons = {};

for (const ch of targets) {
  console.log(`\n📺 ${ch.channel_name}`);
  const proxyManifest = `${BASE}/api/proxy/${encodeProxyTarget(ch.stream_url)}`;
  const mres = await fetch(proxyManifest, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const mtext = await mres.text();
  let { segs } = parseM3u8(mtext, proxyManifest);
  if (segs.length && !/\.(ts|m4s|mp4|aac)(\?|$)/i.test(segs[0])) {
    const sub = await (await fetch(segs[0], { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
    const p = parseM3u8(sub, segs[0]);
    if (p.segs.length) segs = p.segs;
  }

  for (const seg of segs.slice(-4)) {
    total++;
    const t0 = Date.now();
    const res = await fetch(seg, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const ms = Date.now() - t0;
    if (res.ok) {
      // 讀掉內容
      const reader = res.body.getReader();
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
      }
      console.log(`  ✓ ${(bytes / 1024 / 1024).toFixed(2)}MB ${ms}ms age=${res.headers.get('age')}`);
    } else {
      fail++;
      const body = await res.text().catch(() => '');
      let reason = body.slice(0, 120);
      try {
        const j = JSON.parse(body);
        reason = j.error + (j.projected_ms ? ` (projected ${j.projected_ms}ms)` : '');
        if (j.projected_ms) reason = '太慢被放棄: ' + reason;
      } catch {}
      reasons[reason] = (reasons[reason] || 0) + 1;
      console.log(`  ✗ HTTP ${res.status} ${ms}ms — ${reason}`);
    }
  }
}

console.log(`\n══ 統計 ══`);
console.log(`  成功 ${total - fail} / ${total}  失敗 ${fail}`);
for (const [r, n] of Object.entries(reasons)) {
  console.log(`  [${n}次] ${r}`);
}
