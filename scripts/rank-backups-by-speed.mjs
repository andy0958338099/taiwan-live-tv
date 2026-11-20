#!/usr/bin/env node
/**
 * rank-backups-by-speed.mjs — 依實測速度重新排序每個頻道的備援來源
 *
 * 為什麼需要：
 *   備援的**順序**決定 failover 時先試哪個。
 *   原本的順序是「清單裡的先後」，而清單提供者不保證速度。
 *   實測：TVBS 的 segment 65ms 下載完，廣東體育台要 9845ms ——
 *   差 150 倍。同一個頻道若主來源慢、備援快，
 *   順序排對就能讓使用者幾乎不感覺到切換。
 *
 * 做法：
 *   1. 對每個頻道的所有候選來源（主 + 備援）做實際 deep probe，
 *      量出 segment 下載耗時
 *   2. 依耗時排序：最快的主來源優先，備援依序排後
 *   3. 失敗的來源丟到最後（但仍保留，作為最後一線希望）
 *
 * 用法：node scripts/rank-backups-by-speed.mjs [--dry-run] [--conc 8]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHANNELS_PATH = join(ROOT, 'shared', 'channels.json');

const DRY_RUN = process.argv.includes('--dry-run');
const CONC = parseInt(
  (() => {
    const i = process.argv.indexOf('--conc');
    return i >= 0 ? process.argv[i + 1] : '8';
  })(),
  10,
);

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

async function get(url, ms = 25000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: c.signal,
      redirect: 'follow',
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

/**
 * 量測一個來源的 segment 下載耗時。
 * 回傳 { ok, ms } 或 { ok: false, reason }
 */
async function measure(url) {
  let res;
  try {
    res = await get(url);
  } catch (e) {
    return { ok: false, reason: e.name };
  }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };

  let text;
  try {
    text = await res.text();
  } catch {
    return { ok: false, reason: '讀取失敗' };
  }
  if (!text.trimStart().startsWith('#EXTM3U')) {
    return { ok: false, reason: '非 m3u8' };
  }
  if (text.includes('#EXT-X-ENDLIST')) return { ok: false, reason: 'VOD' };

  const segs = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (segs.length === 0) return { ok: false, reason: '無 segment' };

  let target = new URL(segs[0], url).href;
  if (!/\.(ts|m4s|mp4|aac|cmfv|cmfa)(\?|$)/i.test(segs[0])) {
    let cres;
    try {
      cres = await get(target);
    } catch {
      return { ok: false, reason: 'child 失敗' };
    }
    if (!cres.ok) return { ok: false, reason: `child HTTP ${cres.status}` };
    let ctext;
    try {
      ctext = await cres.text();
    } catch {
      return { ok: false, reason: 'child 讀取失敗' };
    }
    const csegs = ctext
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (csegs.length === 0) return { ok: false, reason: 'child 無 segment' };
    target = new URL(csegs[0], target).href;
  }

  const t0 = Date.now();
  let sres;
  try {
    sres = await get(target, 30000);
  } catch {
    return { ok: false, reason: 'segment 失敗' };
  }
  const ms = Date.now() - t0;
  if (!sres.ok) return { ok: false, reason: `segment HTTP ${sres.status}` };

  try {
    const buf = Buffer.from(await sres.arrayBuffer());
    if (buf.length < 1024) return { ok: false, reason: 'segment 過短' };
  } catch {
    return { ok: false, reason: 'segment 讀取失敗' };
  }

  return { ok: true, ms };
}

async function main() {
  console.log('═'.repeat(70));
  console.log('依實測速度重新排序備援來源');
  console.log('═'.repeat(70));

  const catalog = JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'));
  const targets = catalog.channels.filter((c) => c.stream_url && !c.embed_url);

  console.log(`處理 ${targets.length} 個頻道\n`);

  const results = new Map();
  let done = 0;

  async function worker(queue) {
    while (queue.length) {
      const ch = queue.shift();
      const candidates = [
        { url: ch.stream_url, role: 'primary' },
        ...(ch.playlist_source?.backup_urls ?? []).map((b) => ({
          url: b.url,
          role: 'backup',
          cors: b.cors,
          source: b.source,
        })),
      ];

      const measured = [];
      for (const cand of candidates) {
        if (!cand.url) continue;
        const r = await measure(cand.url);
        measured.push({ ...cand, ...r });
      }

      // 排序：可用的按耗時升序，失敗的放最後
      const working = measured
        .filter((m) => m.ok)
        .sort((a, b) => a.ms - b.ms);
      const failed = measured.filter((m) => !m.ok);

      results.set(ch.channel_id, { working, failed });
      done++;
      if (done % 5 === 0) {
        process.stdout.write(`  量測中 ${done}/${targets.length}\r`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: CONC }, () => worker([...targets])),
  );
  process.stdout.write(' '.repeat(40) + '\r');

  // ── 套用排序 ──
  let reordered = 0;
  let promoted = 0;
  const slowChannels = [];

  for (const ch of targets) {
    const r = results.get(ch.channel_id);
    if (!r) continue;

    if (r.working.length === 0) continue;

    const fastest = r.working[0];
    const oldPrimary = ch.stream_url;

    // 新的主來源 = 最快的可用來源
    if (fastest.url !== oldPrimary) {
      ch.stream_url = fastest.url;
      promoted++;
    }

    // 新的備援清單 = 其餘可用來源（依速度遞增）+ 失敗的來源（放最後）
    const newBackups = [
      ...r.working.slice(1).map((m) => ({
        url: m.url,
        source: m.source ?? '備援來源',
        cors: m.cors ?? false,
        measured_ms: m.ms,
      })),
      ...r.failed.map((m) => ({
        url: m.url,
        source: `備援（量測時失效：${m.reason}）`,
        cors: m.cors ?? false,
        measured_ms: null,
      })),
    ];

    // 保留原本有但這次沒量到的（避免資料遺失）
    const measuredUrls = new Set(r.measured_urls ?? []);
    const orphans = (ch.playlist_source?.backup_urls ?? []).filter(
      (b) => !newBackups.some((n) => n.url === b.url),
    );

    ch.playlist_source = {
      ...(ch.playlist_source ?? {}),
      backup_urls: [...newBackups, ...orphans],
    };

    if (fastest.url !== oldPrimary) reordered++;

    // 記錄慢速頻道（主來源仍慢 → 需要更多備援）
    if (fastest.ms > 3000) {
      slowChannels.push({
        name: ch.channel_name,
        ms: fastest.ms,
        backups: newBackups.filter((b) => b.measured_ms).length,
      });
    }
  }

  console.log(`改變主來源：${promoted} 個`);
  console.log(`重新排序：${reordered} 個\n`);

  if (slowChannels.length) {
    console.log(`仍然偏慢的頻道（最快來源 > 3 秒）：${slowChannels.length} 個`);
    for (const s of slowChannels.sort((a, b) => b.ms - a.ms)) {
      console.log(`  · ${s.name.padEnd(16)} ${s.ms}ms（可用備援 ${s.backups} 個）`);
    }
  }

  if (DRY_RUN) {
    console.log('\n(dry-run 模式，未寫入檔案)');
    return;
  }

  catalog.updated_at = new Date().toISOString();
  writeFileSync(CHANNELS_PATH, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  console.log(`\n已寫入 ${CHANNELS_PATH}`);
  console.log('\n下一步：node scripts/validate-channels.mjs && node scripts/sync-channels.mjs');
}

await main();
