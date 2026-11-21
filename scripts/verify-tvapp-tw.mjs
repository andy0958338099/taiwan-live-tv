#!/usr/bin/env node
/**
 * 實測 TVAPP 來源的台灣頻道候選。
 *
 * 驗證流程（借鏡 `scripts/deep-verify-iptv-tw.mjs`）：
 *   1. manifest → 必須是 #EXTM3U
 *   2. 必須是直播（沒有 #EXT-X-ENDLIST）
 *   3. 連續抓 3 個不同 segment，每個都驗證位元組型別
 *      （MPEG-TS 0x47 / fMP4 ftyp）
 *   4. 12 秒後重新抓 manifest，確認有滾動（真直播）
 *   5. 檢查 CORS（決定 Web 版要不要走代理）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SCRATCH = '/Users/andy/.hermes/cache/scratch';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const candidates = JSON.parse(
  readFileSync(join(SCRATCH, 'tvapp-tw-candidates.json'), 'utf8'),
);

function parseSegs(text, base) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((s) => (s.startsWith('http') ? s : new URL(s, base).href));
}

async function manifestChain(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let text = await res.text();
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('不是 manifest');
  const isVod = /#EXT-X-ENDLIST/.test(text);
  let td = text.match(/#EXT-X-TARGETDURATION:\s*([\d.]+)/);
  let segs = parseSegs(text, url);
  if (!segs.length) throw new Error('沒有 segment');
  if (!/\.(ts|m4s|mp4|aac)(\?|$)/i.test(segs[0])) {
    const r2 = await fetch(segs[0], {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(25000),
    });
    if (!r2.ok) throw new Error(`子 manifest HTTP ${r2.status}`);
    const t2 = await r2.text();
    if (!t2.trimStart().startsWith('#EXTM3U')) throw new Error('子 manifest 不是 m3u8');
    const td2 = t2.match(/#EXT-X-TARGETDURATION:\s*([\d.]+)/);
    if (td2) td = td2;
    segs = parseSegs(t2, segs[0]);
    if (!segs.length) throw new Error('子 manifest 沒有 segment');
    return { segs, isVod, td: td ? parseFloat(td[1]) : null };
  }
  return { segs, isVod, td: td ? parseFloat(td[1]) : null };
}

async function checkSegment(url) {
  const t0 = Date.now();
  const r = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok && r.status !== 206) throw new Error(`segment HTTP ${r.status}`);
  const reader = r.body?.getReader();
  let bytes = 0;
  let head = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!head) head = value;
    bytes += value.length;
  }
  if (!head || head.byteLength === 0) throw new Error('segment 是空的');
  const isTs = head[0] === 0x47;
  const isMp4 =
    head.byteLength >= 8 &&
    head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70;
  if (!isTs && !isMp4) throw new Error('不是串流內容');
  return { bytes, ms: Date.now() - t0, kind: isTs ? 'mpegts' : 'fmp4' };
}

async function detectCors(url) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': UA, Origin: 'https://taiwan-live-tv.netlify.app' },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    });
    const acao = res.headers.get('access-control-allow-origin');
    return { has_cors: acao === '*' || !!acao, acao };
  } catch {
    return { has_cors: false, acao: null };
  }
}

console.log('════ 深度驗證 TVAPP 來源的台灣頻道 ════\n');
console.log(`候選 ${candidates.length} 個\n`);

const verified = [];
const failed = [];

for (const c of candidates) {
  process.stdout.write(`  ${c.name.slice(0, 26).padEnd(28)} `);
  try {
    const m1 = await manifestChain(c.url);
    if (m1.isVod) throw new Error('是 VOD');

    // 3 個不同 segment
    const picks = m1.segs.slice(-3).reverse();
    const details = [];
    for (const seg of picks) {
      details.push(await checkSegment(seg));
    }

    // 滾動檢查
    await new Promise((r) => setTimeout(r, 12000));
    const m2 = await manifestChain(c.url);
    const s1 = new Set(m1.segs);
    const overlap = m2.segs.filter((x) => s1.has(x)).length;
    const rolling = overlap < m1.segs.length;
    if (!rolling) throw new Error('manifest 未滾動（不是真直播）');

    const cors = await detectCors(c.url);
    const avgMs = Math.round(details.reduce((s, d) => s + d.ms, 0) / details.length);
    const avgMB = Number(
      (details.reduce((s, d) => s + d.bytes, 0) / details.length / 1024 / 1024).toFixed(2),
    );
    console.log(
      `✓ ${String(avgMs).padStart(5)}ms ${avgMB}MB td=${m1.td ?? '?'}s ` +
        `${cors.has_cors ? '直連' : '代理'} ${c.sources.length}源`,
    );
    verified.push({
      ...c,
      probe: {
        target_duration: m1.td,
        avg_segment_ms: avgMs,
        avg_segment_mb: avgMB,
        rolling: true,
        cors_acao: cors.acao,
        needs_proxy: !cors.has_cors || c.url.startsWith('http://'),
      },
    });
  } catch (e) {
    console.log(`✗ ${e.cause?.code ?? e.message}`);
    failed.push({ ...c, reason: e.cause?.code ?? e.message });
  }
}

console.log(`\n════ 結果 ════`);
console.log(`  通過：${verified.length}`);
console.log(`  失敗：${failed.length}`);
console.log('\n通過清單（多源優先 = 獨立來源多、較不易一起失效）：');
verified.sort((a, b) => b.sources.length - a.sources.length);
for (const v of verified) {
  console.log(
    `  ${String(v.sources.length).padStart(2)}源 ${v.name.slice(0, 26).padEnd(28)} ` +
      `${v.probe.needs_proxy ? '代理' : '直連'} ${v.url.slice(0, 52)}`,
  );
}

writeFileSync(
  join(SCRATCH, 'tvapp-tw-verified.json'),
  JSON.stringify({ verified, failed }, null, 2) + '\n',
  'utf8',
);
console.log(`\n已寫入 ${join(SCRATCH, 'tvapp-tw-verified.json')}`);
