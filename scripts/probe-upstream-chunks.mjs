#!/usr/bin/env node
/**
 * probe-upstream-chunks.mjs — 量測「上游分 chunk 的實際行為」
 *
 * 為什麼需要這個：
 *   代理用「第一個 chunk 的速度」外推整個 segment 的下載時間，
 *   但上游的 chunk 大小波動很大（實測 1KB ~ 64KB），
 *   用單一 chunk 外推會得到 wildly 不準的結果 —— 導致健康來源被誤判成
 *   「太慢」而回 502（實測 TVB翡翠台被誤判 projected 34855ms，
 *   但同一個 segment 實際下載只要 3.9 秒）。
 *
 * 這個腳本直接對上游送出 Range: bytes=0- 的請求，
 * 逐 chunk 記錄「到達時間 / 大小」，用來設計一個**不會誤殺**的估算方式。
 *
 * 用法：node scripts/probe-upstream-chunks.mjs [channel_id ...]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const data = JSON.parse(readFileSync(join(ROOT, 'shared/channels.json'), 'utf8'));
const ids = process.argv.slice(2);
const targets = ids.length
  ? data.channels.filter((c) => ids.includes(c.channel_id))
  : data.channels.filter((c) => /^cdn\.qd\.je/.test(c.stream_url || '')).slice(0, 3);

for (const ch of targets) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`📺 ${ch.channel_name} (${ch.channel_id})`);
  console.log(`   ${ch.stream_url}`);

  /**
   * 解析 playlist，找出 segment 網址。
   *
   * ⚠️ 這些來源是**多層 playlist**：master → child manifest → segment。
   * 只解析第一層會拿到「child manifest 網址」而不是 segment，
   * 量到的 chunk 就會是 manifest 的內容（幾 KB），完全量不到真實速度。
   * 所以要遞迴解析，直到拿到真正的 segment。
   */
  const resolveSegment = async (url, depth = 0) => {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    const text = await res.text();
    let td = 0;
    let firstUri = null;
    let isMaster = false;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        td = parseFloat(line.split(':')[1]) || 0;
      }
      if (line.startsWith('#EXT-X-STREAM-INF')) isMaster = true;
      if (!line.startsWith('#')) {
        firstUri = line.startsWith('http') ? line : new URL(line, url).href;
        break;
      }
    }
    if (!firstUri) return { segUrl: null, targetDuration: td, depth };
    // 這一層看起來還是 manifest（太���或含 #EXTM3U）→ 繼續往下追
    if (depth < 3 && (isMaster || firstUri.endsWith('.m3u8') || firstUri.endsWith('.m3u'))) {
      return resolveSegment(firstUri, depth + 1);
    }
    return { segUrl: firstUri, targetDuration: td, depth };
  };

  let segUrl = null;
  let targetDuration = 0;
  try {
    const r = await resolveSegment(ch.stream_url);
    segUrl = r.segUrl;
    targetDuration = r.targetDuration;
    console.log(`   playlist 層數=${r.depth + 1}`);
  } catch (e) {
    console.log(`   ✗ manifest 抓取失敗: ${e.message}`);
    continue;
  }
  if (!segUrl) {
    console.log('   ✗ manifest 沒有 segment');
    continue;
  }
  console.log(`   TARGETDURATION=${targetDuration}s  segment=${segUrl.slice(0, 90)}`);

  // 量測 chunk 行為
  const t0 = Date.now();
  const res = await fetch(segUrl, {
    headers: { 'User-Agent': UA, Range: 'bytes=0-' },
  });
  const total = Number(res.headers.get('content-length') || 0);
  console.log(`   content-length=${total}B  status=${res.status}`);

  const reader = res.body.getReader();
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const at = Date.now() - t0;
    chunks.push({ at, size: value.byteLength });
    bytes += value.byteLength;
  }
  const elapsed = Date.now() - t0;

  console.log(`   收到 ${chunks.length} 個 chunk，共 ${bytes}B，用時 ${elapsed}ms`);
  console.log(`   前 12 個 chunk（到達時間 / 大小）：`);
  for (const c of chunks.slice(0, 12)) {
    console.log(`      t=${String(c.at).padStart(6)}ms  ${String(c.size).padStart(9)}B`);
  }

  // 各種估算方式比較
  const first = chunks[0];
  const estimate = (b, ms) => (b > 0 && ms > 0 ? (total / (b / ms)) : Infinity);
  console.log(`\n   ── 估算方式比較（門檻 22000ms）──`);
  const e1 = estimate(first.size, first.at);
  console.log(`      單一 chunk 外推（現行做法）: ${Math.round(e1)}ms ${e1 > 22000 ? '✗ 誤殺' : '✓'}`);

  const cum2 = chunks[1]
    ? estimate(first.size + chunks[1].size, chunks[1].at)
    : Infinity;
  console.log(`      兩個 chunk 累計（HEAD 做法）: ${Math.round(cum2)}ms ${cum2 > 22000 ? '✗ 誤殺' : '✓'}`);

  // 「讀到 N bytes 後的即時速率」：代表上游真正的持續吞吐
  const byBytes = (n) => {
    let acc = 0;
    for (const c of chunks) {
      acc += c.size;
      if (acc >= n) return estimate(acc, c.at);
    }
    return Infinity;
  };
  for (const n of [64 * 1024, 256 * 1024, 1024 * 1024]) {
    const e = byBytes(n);
    console.log(
      `      累計 ${String(n / 1024).padStart(5)}KB 後估算: ${Math.round(e)}ms ${e > 22000 ? '✗ 誤殺' : '✓'}`,
    );
  }

  // 真實值
  console.log(`      真實下載時間: ${elapsed}ms（真實速率 ${(bytes / elapsed).toFixed(0)} B/ms）`);
}
