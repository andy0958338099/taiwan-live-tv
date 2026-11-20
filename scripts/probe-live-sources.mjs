#!/usr/bin/env node
/**
 * probe-live-sources.mjs — 探測直播聚合源，找出實際能播的頻道
 *
 * 這些來源（抖音/斗魚/B站/虎牙/歪歪/SOOP/Twitch）不是電視台，
 * 而是「主播的個人直播間」，所以：
 *   - 隨時可能離線（主播沒开播）
 *   - 同一個頻道會有多個備援網址
 *
 * 探測流程（deep probe）：
 *   manifest → 檢查是直播（無 #EXT-X-ENDLIST）→ 取第一個 segment → 驗證位元組
 *
 * 用法：node scripts/probe-live-sources.mjs [--file <name>] [--sample N] [--out <json>]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAYLIST_DIR =
  process.env.PLAYLIST_DIR || '/Users/andy/.hermes/cache/scratch/playlists';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const FILES = (arg('file', 'yang-live,huya,huya-yqk,douyu,bilibili')).split(',');
const SAMPLE = parseInt(arg('sample', '120'), 10);
const OUT = arg('out', join(__dirname, '..', 'shared', 'live-sources.json'));

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

function parseM3U(text) {
  const entries = [];
  let pending = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      const re = /([A-Za-z0-9_-]+)="([^"]*)"/g;
      let m;
      while ((m = re.exec(line)) !== null) attrs[m[1]] = m[2];
      const ci = line.indexOf(',');
      pending = {
        name: ci >= 0 ? line.slice(ci + 1).trim() : '',
        group: attrs['group-title'] || '',
        logo: attrs['tvg-logo'] || '',
      };
    } else if (line.startsWith('#EXTGRP:')) {
      if (pending) pending.group = line.slice('#EXTGRP:'.length).trim();
    } else if (!line.startsWith('#')) {
      if (pending) {
        pending.url = line;
        entries.push(pending);
        pending = null;
      }
    }
  }
  return entries;
}

/** 排除提示/公告類項目 */
function isRealChannel(e) {
  if (!e.url || !e.url.startsWith('http')) return false;
  if (/epg\.yang-1989\.xyz|\.mp4$|溫馨|提示|公告|订阅|訂閱/i.test(e.url + e.name))
    return false;
  if (/\.(mp4|mkv|flv)$/i.test(e.url)) return false;
  return true;
}

async function fetchWithTimeout(url, ms = 12000, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, ...headers },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deep probe：manifest → segment。
 * 回傳 { ok, cors, kind, reason }
 */
async function deepProbe(url) {
  let res;
  try {
    res = await fetchWithTimeout(url);
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? '逾時' : e.name };
  }

  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };

  const cors = res.headers.get('access-control-allow-origin') !== null;
  const text = await res.text();
  if (!text.trimStart().startsWith('#EXTM3U')) {
    return { ok: false, reason: '非 m3u8' };
  }
  if (text.includes('#EXT-X-ENDLIST')) {
    return { ok: false, reason: 'VOD' };
  }

  // 找出第一個 segment
  const segLines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (segLines.length === 0) {
    // 可能是 master manifest — 取第一個子 manifest
    const variant = text.split('\n').find((l) => l.includes('EXT-X-STREAM-INF'));
    if (variant) {
      const nextIdx = text.split('\n').findIndex((l) => l.includes('EXT-X-STREAM-INF'));
      const lines = text.split('\n');
      const child = lines[nextIdx + 1]?.trim();
      if (child) {
        const childUrl = new URL(child, url).href;
        const r2 = await deepProbe(childUrl);
        return { ...r2, cors: cors || r2.cors, master: true };
      }
    }
    return { ok: false, reason: '無 segment' };
  }

  const segUrl = new URL(segLines[0], url).href;

  // 驗證 segment 真的有位元組
  try {
    const sres = await fetchWithTimeout(segUrl, 12000);
    if (!sres.ok) return { ok: false, reason: `segment HTTP ${sres.status}` };
    const reader = sres.body.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    if (!value || value.length < 1024) {
      return { ok: false, reason: 'segment 過短' };
    }
    // 檢查是不是 TS/fMP4 開頭
    const isTs = value[0] === 0x47;
    const isFmp4 =
      value.length > 8 &&
      value[4] === 0x66 &&
      value[5] === 0x74 &&
      value[6] === 0x79 &&
      value[7] === 0x70;
    const isFlv = value[0] === 0x46 && value[1] === 0x4c && value[2] === 0x56;
    const kind = isTs ? 'mpegts' : isFmp4 ? 'fmp4' : isFlv ? 'flv' : 'unknown';

    return {
      ok: true,
      cors,
      kind,
      segmentBytes: value.length,
      segmentUrl: segUrl,
    };
  } catch (e) {
    return { ok: false, reason: `segment ${e.name === 'AbortError' ? '逾時' : e.name}` };
  }
}

async function main() {
  console.log('═'.repeat(70));
  console.log('直播聚合源 deep probe');
  console.log('═'.repeat(70));

  const all = [];

  for (const file of FILES) {
    const path = join(PLAYLIST_DIR, `${file}.m3u`);
    if (!existsSync(path)) {
      console.log(`⚠️  找不到 ${file}.m3u`);
      continue;
    }
    const entries = parseM3U(readFileSync(path, 'utf8')).filter(isRealChannel);
    // 取樣：每個群組各抽一些，避免整份都是同一類型
    const byGroup = new Map();
    for (const e of entries) {
      if (!byGroup.has(e.group)) byGroup.set(e.group, []);
      byGroup.get(e.group).push(e);
    }
    const picked = [];
    const perGroup = Math.max(1, Math.floor(SAMPLE / Math.max(1, byGroup.size)));
    for (const [, list] of byGroup) picked.push(...list.slice(0, perGroup));

    console.log(
      `  ${file}: ${entries.length} 個頻道，${byGroup.size} 個群組，抽樣 ${picked.length} 個`,
    );

    // 並行探測
    const CONC = 12;
    const queue = [...picked];
    const results = [];
    async function worker() {
      while (queue.length) {
        const e = queue.shift();
        const r = await deepProbe(e.url);
        results.push({ ...e, ...r, file });
      }
    }
    await Promise.all(Array.from({ length: CONC }, worker));

    const okList = results.filter((r) => r.ok);
    console.log(`    → 可播 ${okList.length}/${results.length}`);
    all.push(...okList);
  }

  console.log('');
  console.log(`總計可播：${all.length}`);

  // 依平台統計
  const byPlatform = {};
  for (const r of all) {
    const p = r.group.replace(/^[•\s]*/, '').split(/[「\[]/)[0] || '其他';
    byPlatform[p] = (byPlatform[p] || 0) + 1;
  }
  console.log('\n依平台：');
  for (const [p, c] of Object.entries(byPlatform).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.toString().padStart(4)}  ${p}`);
  }

  // 依類型統計
  const byKind = {};
  for (const r of all) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
  console.log('\n依格式：', JSON.stringify(byKind));

  const corsCount = all.filter((r) => r.cors).length;
  console.log(`\nCORS 開啟：${corsCount}/${all.length}`);

  if (OUT) {
    writeFileSync(
      OUT,
      JSON.stringify(
        {
          probed_at: new Date().toISOString(),
          total_working: all.length,
          channels: all.map((r) => ({
            name: r.name,
            group: r.group,
            logo: r.logo,
            url: r.url,
            cors: r.cors,
            kind: r.kind,
            source_file: r.file,
          })),
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    console.log(`\n已寫入 ${OUT}`);
  }
}

main();
