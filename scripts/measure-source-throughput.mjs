#!/usr/bin/env node
/**
 * measure-source-throughput.mjs — 用**新鮮 segment** 量測每個來源的實際完成時間
 *
 * ## 這個工具要解決的問題
 *
 * 專案裡既有的兩個速度工具都有同一個致命缺陷：
 *   · `verify-channel-sources.mjs` 在 `fetch()` 回應標頭到達時就停止計時
 *   · `rank-backups-by-speed.mjs` 同樣只量 TTFB
 *
 * 量到的都是 **TTFB** 不是 **throughput**。實測反例：
 *   `121.19.134.149:808` manifest TTFB = 191 ms（看起來很快）
 *   同一個 host 的 segment（5.4 MB）實測要 89–141 秒 → 遠超平台 30 秒上限
 *
 * 另外先前的 `measure-mirror-speed.mjs` 用「1 MB 切片」量，
 * 但切片是從 manifest 路徑推導的，**各 host 的 path 編號不同**，
 * 導致幾乎全部量到 0 B/s（`shared/mirror-speed.json` 摘要全是 0）。
 *
 * ## 本工具的正確做法
 *
 * 對每個 (host, path) 組合：
 *   1. 抓該 host 自己的 manifest → 取出**它自己的** segment 路徑
 *      （每個 host 的路徑編號不同，不能套用別的 host 的 path）
 *   2. **立刻**下載該 segment（帶 `Range: bytes=0-`）
 *      → 直播 segment 只活約 30 秒，慢速來源要 90+ 秒，
 *        所以必須「抓完 manifest 立刻下載」，量到的才會是完整 segment
 *   3. 記錄：位元組數、耗時、是否完整（收到的位元組 == Content-Range 總長）
 *   4. 完整下載所需的時間，就是代理能否在平台 30 秒內送完的**唯一有效指標**
 *
 * ## 輸出
 *
 * `shared/source-throughput.json` — 每個來源的完整量測結果
 *
 * ## 用法
 *
 *   node scripts/measure-source-throughput.mjs [--conc 12] [--timeout 45000]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHANNELS_PATH = join(ROOT, 'shared', 'channels.json');
const OUT_PATH = join(ROOT, 'shared', 'source-throughput.json');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const CONC = parseInt(arg('conc', '12'), 10);
const TIMEOUT = parseInt(arg('timeout', '45000'), 10);

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/** 平台（Netlify Functions）的回應時限 */
const PLATFORM_BUDGET_MS = 30_000;

/**
 * 收集所有「候選來源」：(host, path) 組合
 *
 * 用 Set 去重 —— 同一個 host+path 可能被多個頻道共用。
 */
function collectCandidates() {
  const catalog = JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'));
  const byKey = new Map();

  const add = (url, channelId, role) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    // 只量 itvlist 家族（/tsfile/live/ 路徑）
    if (!parsed.pathname.includes('/tsfile/live/')) return;
    const path = parsed.pathname.split('/').pop();
    if (!path) return;
    const key = `${parsed.host}|${path}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        host: parsed.host,
        path,
        origin: parsed.origin,
        usedBy: [],
      });
    }
    byKey.get(key).usedBy.push({ channelId, role });
  };

  for (const ch of catalog.channels) {
    add(ch.stream_url, ch.channel_id, 'primary');
    for (const b of ch.playlist_source?.backup_urls ?? []) {
      add(b.url, ch.channel_id, 'backup');
    }
  }
  return [...byKey.values()];
}

/** 抓 manifest → 取出該 host 自己的 segment 完整網址 */
async function freshSegmentUrl(candidate) {
  const manifestUrl = `${candidate.origin}/tsfile/live/${candidate.path}`;
  const res = await fetch(manifestUrl, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return { error: `manifest HTTP ${res.status}` };
  const text = await res.text();
  if (!text.trimStart().startsWith('#EXTM3U')) {
    return { error: 'manifest 內容不是 m3u8' };
  }
  const seg = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))[0];
  if (!seg) return { error: 'manifest 沒有 segment' };
  return { url: new URL(seg, manifestUrl).href };
}

/** 量測單一候選來源的完整 segment 下載 */
async function measure(candidate) {
  const result = {
    key: candidate.key,
    host: candidate.host,
    path: candidate.path,
    usedBy: candidate.usedBy,
    ok: false,
    bytes: 0,
    ms: 0,
    bps: 0,
    complete: false,
    fitsPlatform: false,
    reason: null,
  };

  let segUrl;
  try {
    const f = await freshSegmentUrl(candidate);
    if (f.error) {
      result.reason = f.error;
      return result;
    }
    segUrl = f.url;
  } catch (e) {
    result.reason = `manifest 例外：${e.name}`;
    return result;
  }

  const t0 = Date.now();
  try {
    const res = await fetch(segUrl, {
      headers: { 'User-Agent': UA, Range: 'bytes=0-' },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) {
      result.reason = `segment HTTP ${res.status}`;
      result.ms = Date.now() - t0;
      return result;
    }
    // 預期的總長（Content-Range: bytes 0-N/TOTAL）
    const cr = res.headers.get('content-range');
    const expected = cr ? Number(cr.split('/')[1]) : null;

    const buf = Buffer.from(await res.arrayBuffer());
    result.ms = Date.now() - t0;
    result.bytes = buf.byteLength;
    result.bps = Math.round(result.bytes / Math.max(0.001, result.ms / 1000));
    result.expectedBytes = expected;
    result.ok = true;
    result.complete = expected ? buf.byteLength === expected : false;
    // 「能不能在平台時限內送完」→ 以**實際量到**的耗時為準
    result.fitsPlatform = result.complete && result.ms < PLATFORM_BUDGET_MS;
    if (!result.complete && expected) {
      result.reason = `不完整：${buf.byteLength}/${expected}`;
    }
  } catch (e) {
    result.ms = Date.now() - t0;
    result.reason = e.name === 'TimeoutError' ? '下載超時' : e.name;
  }
  return result;
}

async function main() {
  console.log('═'.repeat(78));
  console.log('來源實際 throughput（每個 host 用自己的 manifest → 新鮮 segment）');
  console.log('═'.repeat(78));
  console.log(`平台時限 ${PLATFORM_BUDGET_MS / 1000}s｜並行 ${CONC}｜逾時 ${TIMEOUT}ms\n`);

  const candidates = collectCandidates();
  console.log(`待測 ${candidates.length} 個 (host, path) 組合\n`);

  const results = [];
  const queue = [...candidates];
  let done = 0;

  async function worker() {
    while (queue.length) {
      const c = queue.shift();
      const r = await measure(c);
      results.push(r);
      done++;
      const tag = r.complete
        ? r.fitsPlatform
          ? '✓'
          : '✗慢'
        : '✗';
      process.stdout.write(
        `  [${done}/${candidates.length}] ${tag} ${c.key.padEnd(30)} ` +
          `${String(r.bytes).padStart(8)}B ${String(r.ms).padStart(6)}ms ` +
          `${String(r.bps).padStart(7)} B/s ${r.reason ?? ''}\n`,
      );
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  // ── 依 host 彙整 ──
  const byHost = new Map();
  for (const r of results) {
    if (!byHost.has(r.host)) byHost.set(r.host, []);
    byHost.get(r.host).push(r);
  }

  console.log('\n' + '─'.repeat(78));
  console.log('host 彙整（取最快的一筆）：');
  console.log('─'.repeat(78));
  const summary = [];
  for (const [host, rs] of byHost) {
    const good = rs.filter((r) => r.complete);
    const best = good.sort((a, b) => a.ms - b.ms)[0];
    summary.push({
      host,
      paths: rs.length,
      completePaths: good.length,
      bestMs: best?.ms ?? null,
      bestBps: best?.bps ?? null,
      bestKey: best?.key ?? null,
    });
  }
  summary.sort((a, b) => (a.bestMs ?? 1e9) - (b.bestMs ?? 1e9));
  for (const s of summary) {
    const verdict =
      s.bestMs === null
        ? '✗ 無完整 segment'
        : s.bestMs < PLATFORM_BUDGET_MS
          ? '✓ 可在時限內送完'
          : '✗ 太慢';
    console.log(
      `  ${s.host.padEnd(24)} ${String(s.completePaths).padStart(2)}/${String(s.paths).padEnd(2)} 完整  ` +
        `最快 ${String(s.bestMs ?? '-').padStart(6)}ms  ${String(s.bestBps ?? '-').padStart(7)} B/s  ${verdict}`,
    );
  }

  writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        measured_at: new Date().toISOString(),
        platform_budget_ms: PLATFORM_BUDGET_MS,
        results,
        summary,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  console.log(`\n已寫入 ${OUT_PATH}`);
}

await main();
