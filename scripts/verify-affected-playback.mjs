#!/usr/bin/env node
/**
 * 播放驗證：確認受影響的頻道（備援被清理過的那些）仍能播放。
 *
 * 背景：2026-11-21 修正了「備援指向別的頻道」的 bug，
 * 移除了錯配的備援。要確認主來源仍可正常播放。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const catalog = JSON.parse(
  readFileSync(join(ROOT, 'shared', 'channels.json'), 'utf8'),
);

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const TARGETS = ['龍華電視', 'TVB翡翠台', 'HOY TV', '天映', '台視', 'TVB'];

console.log('════ 播放驗證（主來源 deep probe）════\n');

let pass = 0;
let fail = 0;

for (const name of TARGETS) {
  const ch = catalog.channels.find((c) => c.channel_name === name);
  if (!ch) {
    console.log(`  ? ${name} —— 不在清單中`);
    continue;
  }
  const backups = ch.playlist_source?.backup_urls ?? [];

  // 依序試主來源與每個備援
  const candidates = [ch.stream_url, ...backups.map((b) => b.url)];
  let ok = null;
  let tried = 0;

  for (const url of candidates) {
    tried++;
    const r = await probe(url);
    if (r.ok) {
      ok = { url, ...r };
      break;
    }
  }

  if (ok) {
    pass++;
    console.log(
      `  ✓ ${name.padEnd(12)} 第 ${tried} 個來源可用  ` +
        `(${ok.kind}, ${ok.ms}ms, ${ok.size}MB)`,
    );
  } else {
    fail++;
    console.log(`  ✗ ${name.padEnd(12)} 全部 ${tried} 個來源都失敗`);
  }
}

console.log(`\n  通過 ${pass} / 失敗 ${fail}`);

async function probe(url) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { ok: false };
    const text = await res.text();
    if (!text.trimStart().startsWith('#EXTM3U')) return { ok: false };
    if (text.includes('#EXT-X-ENDLIST')) return { ok: false }; // VOD

    const first = text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'));
    if (!first) return { ok: false };

    // ⚠️ manifest 裡的 segment 路徑可能是**相對路徑**
    // （實測台視：`https://live.wcetv.com/hls/master-ttvnews.m3u8` 裡
    //   的 segment 是 `m3u8/ttvnews.m3u8`）
    // 不處理相對路徑會讓 fetch 拋錯，誤判成來源失效。
    const segUrl = new URL(first, url).href;

    // 取第一個 segment 驗證是真串流
    const segRes = await fetch(segUrl, {
      headers: { 'User-Agent': UA, Range: 'bytes=0-2047' },
      signal: AbortSignal.timeout(15000),
    });
    if (!segRes.ok) return { ok: false };
    const buf = Buffer.from(await segRes.arrayBuffer());

    let kind = 'unknown';
    if (buf[0] === 0x47) kind = 'MPEG-TS';
    else if (buf.slice(4, 8).toString('latin1') === 'ftyp') kind = 'fMP4';
    else if (buf.slice(0, 4).toString('latin1') === '#EXT') kind = 'playlist';
    else return { ok: false };

    return {
      ok: true,
      kind,
      ms: Date.now() - t0,
      size: Math.round(buf.length / 1024 / 102.4) / 10,
    };
  } catch {
    return { ok: false };
  }
}
