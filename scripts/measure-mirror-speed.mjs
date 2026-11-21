#!/usr/bin/env node
/**
 * measure-mirror-speed.mjs — 用「切片下載」量測各來源的實際 throughput
 *
 * ## 為什麼不能只看 TTFB
 *
 * 現有的 `verify-channel-sources.mjs` 與 `rank-backups-by-speed.mjs`
 * 都在 `fetch()` **回應標頭到達**時就停止計時（沒有讀完 body）。
 * 量到的其實是 **TTFB**，不是吞吐量。
 *
 * 實測反例（2026-11-21）：
 *   `121.19.134.149:808` 的 manifest TTFB = 191 ms  → 看起來很快
 *   但同一個 host 的 segment（5.4 MB）實測要 26–90 秒 → 遠超平台 30 秒上限
 *
 * 這個落差讓「快慢來源」的判斷完全失準。
 *
 * ## 本腳本怎麼量
 *
 * 用 `Range: bytes=0-1048575`（1 MB 切片）量 throughput：
 *   · 切片小 → 每個 host 只需幾秒，不必等整個 5.4 MB
 *   · 切片連續 → 得到的 B/s 就是真實的下載速度
 *   · 同一個 host 用不同 path 多測一次，避免單一 path 的偶然偏差
 *
 * ## 用法
 *
 *   node scripts/measure-mirror-speed.mjs [--slice 1048576] [--repeats 2]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHANNELS_PATH = join(ROOT, 'shared', 'channels.json');
const OUT_PATH = join(ROOT, 'shared', 'mirror-speed.json');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const SLICE = parseInt(arg('slice', '1048576'), 10);
const REPEATS = parseInt(arg('repeats', '2'), 10);
const CONC = parseInt(arg('conc', '8'), 10);

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/** 要量測的 host（itvlist 家族 + 已知鏡像） */
const HOSTS = [
  '121.19.134.149:808',
  '222.134.245.16:9901',
  '218.13.170.98:9901',
  '61.136.172.236:9901',
  '36.136.38.87:9901',
  '113.25.252.226:9901',
  '120.198.95.220:9901',
  '59.39.89.130:60901',
];

const QUERY = 'key=txiptv&playlive=1&authid=0';

/** 從 manifest 取出第一個 segment 的相對路徑 */
async function firstSegPath(manifestUrl) {
  const res = await fetch(manifestUrl, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const text = await res.text();
  if (!text.trimStart().startsWith('#EXTM3U')) return null;
  const seg = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))[0];
  if (!seg) return null;
  // 只取檔名部分（去掉查詢參數）
  return seg.split('?')[0];
}

/** 量測單一 (host, path) 的 throughput */
async function measure(host, path) {
  const url = `http://${host}/tsfile/live/${path}?${QUERY}`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Range: `bytes=0-${SLICE - 1}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    const ms = Date.now() - t0;
    if (buf.length < 1024) return { ok: false, reason: `過短 ${buf.length}B` };
    return {
      ok: true,
      bytes: buf.length,
      ms,
      bps: Math.round(buf.length / (ms / 1000)),
    };
  } catch (e) {
    return { ok: false, reason: e.name };
  }
}

async function main() {
  console.log('═'.repeat(72));
  console.log('各來源的實際 throughput（1 MB 切片量測）');
  console.log('═'.repeat(72));
  console.log(`切片大小 ${(SLICE / 1024).toFixed(0)} KB｜每組重複 ${REPEATS} 次\n`);

  // 找出每個 host 可用的 path（用該 host 自己的 manifest 清單）
  const catalog = JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'));
  const pathsByHost = new Map();
  for (const ch of catalog.channels) {
    const urls = [
      ch.stream_url,
      ...(ch.playlist_source?.backup_urls ?? []).map((b) => b.url),
    ];
    for (const u of urls) {
      try {
        const parsed = new URL(u);
        if (!HOSTS.includes(parsed.host)) continue;
        if (!parsed.pathname.includes('/tsfile/live/')) continue;
        const p = parsed.pathname.split('/').pop();
        if (!p) continue;
        if (!pathsByHost.has(parsed.host)) pathsByHost.set(parsed.host, new Set());
        pathsByHost.get(parsed.host).add(p);
      } catch {
        /* ignore */
      }
    }
  }

  const results = {};
  const jobs = [];
  for (const host of HOSTS) {
    const paths = [...(pathsByHost.get(host) ?? [])].slice(0, 3);
    for (const p of paths) jobs.push({ host, path: p });
  }
  console.log(`待測 ${jobs.length} 組 (host, path)\n`);

  let done = 0;
  const queue = [...jobs];
  async function worker() {
    while (queue.length) {
      const job = queue.shift();
      const runs = [];
      for (let r = 0; r < REPEATS; r++) {
        const res = await measure(job.host, job.path);
        if (res.ok) runs.push(res);
        else runs.push(res);
      }
      const okRuns = runs.filter((x) => x.ok);
      const bps = okRuns.length
        ? Math.round(okRuns.reduce((a, b) => a + b.bps, 0) / okRuns.length)
        : null;
      const key = `${job.host}|${job.path}`;
      results[key] = {
        host: job.host,
        path: job.path,
        bps,
        ok: okRuns.length,
        total: REPEATS,
        reasons: runs.filter((x) => !x.ok).map((x) => x.reason),
      };
      done++;
      process.stdout.write(`  量測中 ${done}/${jobs.length}\r`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  process.stdout.write(' '.repeat(40) + '\r');

  // ── 依 host 彙整 ──
  const byHost = new Map();
  for (const r of Object.values(results)) {
    if (!byHost.has(r.host)) byHost.set(r.host, []);
    byHost.get(r.host).push(r);
  }

  console.log('host 彙整（平均 B/s）：');
  const summary = [];
  for (const [host, rs] of byHost) {
    const ok = rs.filter((r) => r.ok > 0);
    const avg = ok.length
      ? Math.round(ok.reduce((a, b) => a + (b.bps ?? 0), 0) / ok.length)
      : 0;
    // 5.4 MB 的 segment 需要多久
    const secs = avg ? (5.4 * 1024 * 1024) / avg : Infinity;
    summary.push({ host, avg, paths: rs.length, secs });
  }
  summary.sort((a, b) => b.avg - a.avg);
  for (const s of summary) {
    const fits = s.secs < 25;
    console.log(
      `  ${s.host.padEnd(26)} 平均 ${String(s.avg).padStart(8)} B/s  ` +
        `5.4MB 需 ${String(Math.round(s.secs)).padStart(4)}s  ` +
        `${fits ? '✓ 30 秒內可完成' : '✗ 會超時'}`,
    );
  }

  writeFileSync(
    OUT_PATH,
    JSON.stringify({ measured_at: new Date().toISOString(), slice_bytes: SLICE, results, summary }, null, 2) +
      '\n',
    'utf8',
  );
  console.log(`\n已寫入 ${OUT_PATH}`);
}

await main();
