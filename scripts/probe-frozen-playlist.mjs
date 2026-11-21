#!/usr/bin/env node
/**
 * probe-frozen-playlist.mjs — 判定某個來源的 live playlist 是「真的停播」
 * 還是「只是被上游 CDN 快取住、稍後會前進」。
 *
 * ## 為什麼需要
 *
 * 量測發現：龍華電視 / Now TV 的子 playlist 序號在 24 秒內完全不動，
 * 而且**直連上游也不動**。兩種可能：
 *   A. 來源真的停播 → 播放器會播完緩衝裡的內容後就卡住
 *   B. 上游 CDN 快取 → 過一段時間會前進，只是比較慢
 *
 * A 與 B 需要完全不同的處理，所以必須分清楚。
 *
 * ## 方法
 *
 *   1. 直連上游的**子** playlist，連續觀察 N 秒，記錄序號
 *   2. 加上 cache-busting query（`?t=<timestamp>`）再試一次 —— 繞過上游 CDN 快取
 *   3. 兩種都停 → 真的停播；加了 busting 會動 → 只是 CDN 快取
 *
 * 用法：node scripts/probe-frozen-playlist.mjs [--ids id1,id2] [--seconds 90] [--interval 6]
 */
import { readFileSync } from 'node:fs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const SECONDS = Number(arg('seconds', '90'));
const INTERVAL_MS = Number(arg('interval', '6')) * 1000;
const IDS = arg('ids', '')
  .split(',')
  .filter(Boolean);

const DEFAULT_IDS = ['playlist-龍華-龍華電視', 'playlist-Now-now-tv', 'tw-goodtv-ch1'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parse(text) {
  const seq = text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m);
  const td = text.match(/^#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/m);
  const segs = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).length;
  // 取最後一個 segment 的檔名（含序號）
  const segLines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const last = segLines[segLines.length - 1] ?? '';
  return { seq: seq ? Number(seq[1]) : null, td: td ? Number(td[1]) : null, segs, last };
}

function childUrlFrom(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j] && !lines[j].startsWith('#')) return new URL(lines[j], base).toString();
      }
    }
  }
  return null;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';

async function get(url) {
  const res = await fetch(url, {
    headers: { Referer: 'https://taiwan-live-tv.netlify.app/', 'User-Agent': UA },
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text, age: res.headers.get('age') };
}

const catalog = JSON.parse(readFileSync('shared/channels.json', 'utf8'));
const channels = catalog.channels ?? catalog;
const targets = IDS.length ? IDS : DEFAULT_IDS;

console.log('═'.repeat(78));
console.log('判定：live playlist 是真的停播，還是被上游 CDN 快取住');
console.log('═'.repeat(78));
console.log(`觀察時間：${SECONDS} 秒　間隔：${INTERVAL_MS / 1000} 秒\n`);

for (const id of targets) {
  const ch = channels.find((c) => c.channel_id === id);
  if (!ch) {
    console.log(`? ${id} —— 頻道不存在\n`);
    continue;
  }
  console.log(`── ${ch.channel_name} (${id})`);
  console.log(`   上游：${ch.stream_url}`);

  // 找到子清單網址
  const m = await get(ch.stream_url);
  if (!m.ok) {
    console.log(`   master fetch 失敗 status=${m.status}\n`);
    continue;
  }
  let child = childUrlFrom(m.text, ch.stream_url);
  if (!child) {
    child = ch.stream_url;
    console.log('   （直接就是 media playlist）');
  } else {
    console.log(`   子清單：${child}`);
  }

  const seqs = [];
  const busts = [];
  const started = Date.now();
  let round = 0;
  while (Date.now() - started < SECONDS * 1000) {
    round += 1;
    const r = await get(child);
    const p = r.ok ? parse(r.text) : { seq: null, td: null, segs: 0, last: '' };
    seqs.push(p.seq);

    // cache-busting 版本
    const bustUrl = child + (child.includes('?') ? '&' : '?') + '_cb=' + Date.now();
    const b = await get(bustUrl);
    const bp = b.ok ? parse(b.text) : { seq: null, td: null, segs: 0, last: '' };
    busts.push(bp.seq);

    console.log(
      `   [${String(round).padStart(2)}] seq=${p.seq ?? '—'} segs=${p.segs} age=${r.age ?? '—'} ` +
        `| bust seq=${bp.seq ?? '—'} last=${p.last.slice(-24)}`,
    );
    if (round * INTERVAL_MS >= SECONDS * 1000) break;
    await sleep(INTERVAL_MS);
  }

  const uniq = new Set(seqs.filter((s) => s !== null));
  const buniq = new Set(busts.filter((s) => s !== null));
  const normalAdvanced = uniq.size > 1;
  const bustAdvanced = buniq.size > 1;

  console.log('');
  console.log(`   一般請求序號：${seqs.filter((s) => s !== null).join(' → ')}`);
  console.log(`   防快取序號　：${busts.filter((s) => s !== null).join(' → ')}`);

  let verdict;
  if (normalAdvanced) {
    verdict = '✅ 序號有前進 → 來源正常，之前的觀察只是剛好撞到停頓';
  } else if (bustAdvanced) {
    verdict = '⚠️ 一般請求不動、加防快取參數會動 → 上游 CDN 快取住了 playlist（會有延遲）';
  } else {
    verdict = '❌ 兩種都不動 → 來源真的停播（播放器會播完緩衝後卡住）';
  }
  console.log(`   判定：${verdict}\n`);
}
