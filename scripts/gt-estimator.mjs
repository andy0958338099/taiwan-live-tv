#!/usr/bin/env node
/**
 * gt-estimator.mjs — 收集 segment 的「真實完成時間 + chunk 時序」作為 ground truth
 *
 * 用途：代理在送出 body 之前必須判斷「這個 segment 能不能在預算內下載完」。
 *   判斷錯了有兩種後果：
 *     · 誤殺（健康來源被回 502）→ hls.js 換源，使用者看到「切台」
 *     · 漏殺（真正太慢的來源放行）→ 平台在 30 秒切斷 → **截斷的 segment 被 CDN 快取 5 分鐘**
 *   所以要用 ground truth 驗證估算公式，而不是憑感覺。
 *
 * 本腳本對每個頻道下載 segment（給足 timeout），記錄：
 *   · 真實完成時間（判斷「是否真的慢」的依據）
 *   · 完整 chunk 時序（離線模擬各種估算公式）
 *
 * 用法：node scripts/gt-estimator.mjs [--ids id1,id2] [--timeout 45000]
 */
import { readFileSync, writeFileSync } from 'node:fs';
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
const IDS = arg('ids', '').split(',').filter(Boolean);
const TIMEOUT = Number(arg('timeout', '45000'));
const OUT = arg('out', 'shared/gt-estimator.json');

const data = JSON.parse(readFileSync(join(ROOT, 'shared/channels.json'), 'utf8'));
const targets = IDS.length
  ? data.channels.filter((c) => IDS.includes(c.channel_id))
  : data.channels.filter((c) => c.is_active);

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

const results = [];
for (const [i, ch] of targets.entries()) {
  let segUrl = null;
  let td = 0;
  try {
    const r = await resolveSegment(ch.stream_url);
    segUrl = r.segUrl;
    td = r.targetDuration;
  } catch (e) {
    console.log(`${i + 1}/${targets.length} ${ch.channel_name} ✗ manifest ${e.message}`);
    continue;
  }
  if (!segUrl) {
    console.log(`${i + 1}/${targets.length} ${ch.channel_name} ✗ 無 segment`);
    continue;
  }

  const t0 = Date.now();
  let res;
  try {
    res = await fetch(segUrl, {
      headers: { 'User-Agent': UA, Range: 'bytes=0-' },
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (e) {
    console.log(`${i + 1}/${targets.length} ${ch.channel_name} ✗ fetch ${e.message}`);
    continue;
  }
  const total = Number(res.headers.get('content-length') || 0);
  const reader = res.body.getReader();
  const chunks = [];
  let bytes = 0;
  let complete = true;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push({ at: Date.now() - t0, size: value.byteLength });
      bytes += value.byteLength;
    }
  } catch {
    complete = false;
  }
  const elapsed = Date.now() - t0;

  results.push({
    channel_id: ch.channel_id,
    name: ch.channel_name,
    td,
    url: segUrl,
    total,
    bytes,
    elapsed,
    complete,
    // chunk 時序壓成 [到達時間ms, 大小B] 的配對陣列 —— 檔案小 4 倍
    chunks: chunks.map((c) => [c.at, c.size]),
  });
  console.log(
    `${i + 1}/${targets.length} ${ch.channel_name.padEnd(14)} td=${String(td).padStart(2)}s ` +
      `total=${String(total).padStart(9)}B 實耗=${String(elapsed).padStart(6)}ms ` +
      `${complete ? '完整' : '逾時'} chunks=${chunks.length}`,
  );
}

writeFileSync(join(ROOT, OUT), JSON.stringify({ measured_at: new Date().toISOString(), results }, null, 1));
console.log(`\n已寫入 ${OUT}（${results.length} 筆）`);
