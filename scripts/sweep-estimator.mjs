#!/usr/bin/env node
/**
 * sweep-estimator.mjs — 用**全頻道實測資料**決定速度估算的最佳參數
 *
 * 問題（2026-11-21 線上實測）：
 *   代理用「第一個 chunk 的速率」外推整個 segment 的下載時間，
 *   但上游把 segment 切成極小的 chunk（實測 1369B / 8192B），
 *   所以外推結果離譜地大 → 健康來源被誤判成「太慢」而回 502。
 *   實測 TVB翡翠台被回 502（projected 34855ms），但同一個 segment
 *   實際下載只要 1.3 秒 → hls.js 換源，使用者看到「切台」而非「繼續播放」。
 *
 * 這個腳本對每個頻道實測 segment 的 chunk 時序，
 * 然後**模擬代理的估算邏輯**，比較不同參數組合的
 *   · 誤殺率（健康來源被判定為太慢）
 *   · 漏殺率（真正慢的來源沒被判定出來）
 *   · 額外等待時間（每個 segment 多等多久才能下判斷）
 *
 * 用法：node scripts/sweep-estimator.mjs [--limit N] [--ids id1,id2]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const LIMIT = Number(arg('limit', '40'));
const IDS = arg('ids', '').split(',').filter(Boolean);

const THRESHOLD = 22_000;
const CANDIDATES = [
  { minBytes: 64 * 1024, maxWait: 1500 },
  { minBytes: 128 * 1024, maxWait: 1500 },
  { minBytes: 256 * 1024, maxWait: 1500 },
  { minBytes: 512 * 1024, maxWait: 1500 },
  { minBytes: 256 * 1024, maxWait: 800 },
  { minBytes: 128 * 1024, maxWait: 800 },
];

const data = JSON.parse(readFileSync(join(ROOT, 'shared/channels.json'), 'utf8'));
const targets = (IDS.length
  ? data.channels.filter((c) => IDS.includes(c.channel_id))
  : data.channels.filter((c) => c.is_active)
).slice(0, LIMIT);

const resolveSegment = async (url, depth = 0) => {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  const text = await res.text();
  let td = 0;
  let firstUri = null;
  let isMaster = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-TARGETDURATION:')) td = parseFloat(line.split(':')[1]) || 0;
    if (line.startsWith('#EXT-X-STREAM-INF')) isMaster = true;
    if (!line.startsWith('#')) {
      firstUri = line.startsWith('http') ? line : new URL(line, url).href;
      break;
    }
  }
  if (!firstUri) return { segUrl: null, targetDuration: td };
  if (depth < 3 && (isMaster || firstUri.endsWith('.m3u8') || firstUri.endsWith('.m3u'))) {
    return resolveSegment(firstUri, depth + 1);
  }
  return { segUrl: firstUri, targetDuration: td };
};

/** 模擬代理的新估算：累積到 minBytes 或 maxWait，再算「平均速率」 */
const simulate = (chunks, total, cfg) => {
  let acc = chunks[0].size;
  let waited = chunks[0].at;
  let done = false;
  for (let i = 1; i < chunks.length; i++) {
    const c = chunks[i];
    if (acc >= cfg.minBytes || c.at >= cfg.maxWait) {
      waited = c.at;
      break;
    }
    acc += c.size;
    waited = c.at;
    if (i === chunks.length - 1) done = true;
  }
  const ms = Math.max(1, waited);
  if (total <= 0) return { projected: 0, waited: ms, done };
  const rate = acc / ms;
  return { projected: rate > 0 ? total / rate : Infinity, waited: ms, done };
};

const results = [];
let measured = 0;

for (const ch of targets) {
  let segUrl = null;
  let td = 0;
  try {
    const r = await resolveSegment(ch.stream_url);
    segUrl = r.segUrl;
    td = r.targetDuration;
  } catch {
    continue;
  }
  if (!segUrl) continue;

  const t0 = Date.now();
  let res;
  try {
    res = await fetch(segUrl, {
      headers: { 'User-Agent': UA, Range: 'bytes=0-' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    continue;
  }
  const total = Number(res.headers.get('content-length') || 0);
  const reader = res.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push({ at: Date.now() - t0, size: value.byteLength });
      bytes += value.byteLength;
    }
  } catch {
    /* 中途斷掉 → 用已收到的資料評估 */
  }
  const elapsed = Date.now() - t0;
  if (chunks.length < 2 || total <= 0) continue;
  measured++;

  const per = CANDIDATES.map((cfg) => {
    const s = simulate(chunks, total, cfg);
    return {
      ...cfg,
      projected: Math.round(s.projected),
      waited: s.waited,
      killed: s.projected > THRESHOLD,
    };
  });

  // 真實速度：real > 門檻 → 這個來源本來就應該被殺
  const trulySlow = elapsed > THRESHOLD;

  results.push({
    name: ch.channel_name,
    td,
    total,
    real: elapsed,
    trulySlow,
    per,
  });

  process.stdout.write(
    `${results.length}/${targets.length} ${ch.channel_name} real=${elapsed}ms ` +
      per.map((p) => `${p.minBytes / 1024}K:${p.killed ? '殺' : '過'}`).join(' ') +
      '\n',
  );
}

console.log('\n' + '═'.repeat(100));
console.log('統計');
console.log('═'.repeat(100));
console.log(`實測到 ${measured} 個頻道的 segment 資料`);
console.log(
  `其中「真實下載 > ${THRESHOLD}ms」（本來就該被殺）：${results.filter((r) => r.trulySlow).length} 個`,
);
console.log('');

for (const cfg of CANDIDATES) {
  const col = results.map((r) => r.per.find((p) => p.minBytes === cfg.minBytes && p.maxWait === cfg.maxWait));
  const falseKill = results.filter(
    (r, i) => !r.trulySlow && col[i].killed,
  );
  const missed = results.filter((r, i) => r.trulySlow && !col[i].killed);
  const waits = col.map((c) => c.waited).sort((a, b) => a - b);
  const median = waits[Math.floor(waits.length / 2)] ?? 0;
  const p90 = waits[Math.floor(waits.length * 0.9)] ?? 0;
  console.log(
    `minBytes=${String(cfg.minBytes / 1024).padStart(4)}KB maxWait=${String(cfg.maxWait).padStart(5)}ms  ` +
      `誤殺 ${String(falseKill.length).padStart(2)}  漏殺 ${String(missed.length).padStart(2)}  ` +
      `等待中位數 ${String(median).padStart(5)}ms  p90 ${String(p90).padStart(5)}ms`,
  );
  if (falseKill.length) {
    console.log(
      `      誤殺名單: ${falseKill.map((r) => `${r.name}(實${r.real}ms/預${r.per.find((p) => p.minBytes === cfg.minBytes && p.maxWait === cfg.maxWait).projected})`).join('、')}`,
    );
  }
}
