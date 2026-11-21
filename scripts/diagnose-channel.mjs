#!/usr/bin/env node
/**
 * diagnose-channel.mjs — 深入診斷單一頻道為何播不出來
 *
 * 沿著「manifest → 子清單 → segment」逐層實際抓取（全部經過線上代理），
 * 印出每一層的 HTTP 狀態、內容型別、大小、耗時，
 * 並比對「直連上游」與「經過代理」的結果。
 *
 * 用法：node scripts/diagnose-channel.mjs --id playlist-龍華-龍華電視
 */
import { readFileSync } from 'node:fs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const BASE = arg('base', 'https://taiwan-live-tv.netlify.app');
const ID = arg('id', '');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';

function enc(target) {
  return Buffer.from(target, 'utf8').toString('base64url');
}

function firstSegmentUrl(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let seenVariant = false;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF')) seenVariant = true;
    if (line && !line.startsWith('#') && !seenVariant) return new URL(line, base).toString();
  }
  // master → 取第一個 variant 的子清單
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j] && !lines[j].startsWith('#')) {
          const child = new URL(lines[j], base).toString();
          return { child };
        }
      }
    }
  }
  return null;
}

function firstSegmentOf(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  for (const line of lines) {
    if (line && !line.startsWith('#')) return new URL(line, base).toString();
  }
  return null;
}

async function probe(url, label) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: `${BASE}/` },
      signal: AbortSignal.timeout(30_000),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get('content-type');
    const head = buf.subarray(0, 12).toString('hex');
    const isM3u8 = buf.subarray(0, 7).toString() === '#EXTM3U';
    console.log(
      `  ${label.padEnd(22)} HTTP ${res.status}  ${String(buf.length).padStart(8)}B  ` +
        `${(Date.now() - started).toString().padStart(5)}ms  ct=${ct ?? '—'}  ` +
        `head=${head}${isM3u8 ? '  (m3u8)' : ''}  age=${res.headers.get('age') ?? '—'}`,
    );
    return { status: res.status, buf, text: buf.toString('utf8') };
  } catch (e) {
    console.log(
      `  ${label.padEnd(22)} ✗ ${String(e?.message ?? e).slice(0, 90)} ` +
        `(${Date.now() - started}ms)`,
    );
    return null;
  }
}

const catalog = JSON.parse(readFileSync('shared/channels.json', 'utf8'));
const channels = catalog.channels ?? catalog;
const ch = channels.find((c) => c.channel_id === ID);
if (!ch) {
  console.error(`✗ 找不到頻道 ${ID}`);
  process.exit(1);
}

console.log('═'.repeat(80));
console.log(`診斷：${ch.channel_name} (${ch.channel_id})`);
console.log('═'.repeat(80));
console.log(`上游 stream_url：${ch.stream_url}`);
console.log(`cors_enabled　 ：${ch.cors_enabled}　 stream_type：${ch.stream_type}`);
console.log('');

console.log('【A】直連上游');
const directMaster = await probe(ch.stream_url, 'master');
let directChild = null;
if (directMaster) {
  const r = firstSegmentUrl(directMaster.text, ch.stream_url);
  if (r?.child) {
    directChild = r.child;
    const c = await probe(directChild, 'child playlist');
    if (c) {
      const seg = firstSegmentOf(c.text, directChild);
      if (seg) await probe(seg, 'segment');
    }
  }
}

console.log('');
console.log('【B】經過線上代理');
const proxyMaster = await probe(`${BASE}/api/proxy/${enc(ch.stream_url)}`, 'master (proxy)');
if (proxyMaster) {
  const r = firstSegmentUrl(proxyMaster.text, `${BASE}/api/proxy/${enc(ch.stream_url)}`);
  if (r?.child) {
    const c = await probe(r.child, 'child playlist (proxy)');
    if (c) {
      const seg = firstSegmentOf(c.text, r.child);
      if (seg) {
        console.log(`     segment URL: ${seg.slice(0, 110)}`);
        await probe(seg, 'segment (proxy)');
      }
    }
  } else {
    // proxy 直接就是 media playlist
    const seg = firstSegmentOf(proxyMaster.text, `${BASE}/`);
    if (seg) await probe(seg, 'segment (proxy)');
  }
}

console.log('');
console.log('【C】原始 proxy manifest 內容（前 900 字元）');
if (proxyMaster) console.log(proxyMaster.text.slice(0, 900));
