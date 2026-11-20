#!/usr/bin/env node
/**
 * probe-streams.mjs — 深層串流探測
 *
 * 為什麼需要這個：
 *   單純檢查「manifest 可達且是 m3u8」是不夠的。
 *   實測有相當比例的來源：manifest 正常回應，但 segment 抓不到
 *   （上游回 400/502，或 segment token 已過期）。
 *   這類來源在 Web 版與 Android 版都播不出來。
 *
 * 本腳本驗證完整鏈路：manifest → 子 manifest → 第一個 segment，
 * 並確認 segment 是合法的 MPEG-TS（每 188 bytes 對齊、每個封包開頭 0x47）
 * 或 fMP4（開頭為 ftyp box）。
 *
 * 用法：
 *   node scripts/probe-streams.mjs [--file <channels.json>] [--verbose]
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const fileIdx = process.argv.indexOf('--file');
const TARGET_FILE =
  fileIdx >= 0 ? process.argv[fileIdx + 1] : join(ROOT, 'shared', 'channels.json');
const VERBOSE = process.argv.includes('--verbose');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const TS_PACKET = 188;

function isMpegTs(buf) {
  if (buf.length < TS_PACKET * 4) return false;
  let ok = 0;
  let total = 0;
  for (let i = 0; i + TS_PACKET <= buf.length && total < 40; i += TS_PACKET) {
    total++;
    if (buf[i] === 0x47) ok++;
  }
  return ok / total > 0.9;
}

function isFmp4(buf) {
  // fMP4 開頭為 'ftyp' box（offset 4）
  if (buf.length < 12) return false;
  const box = buf.subarray(4, 8).toString('latin1');
  return box === 'ftyp' || box === 'styp';
}

async function fetchText(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) return { ok: false, status: res.status, text: null };
    return { ok: true, status: res.status, text: await res.text() };
  } catch (e) {
    return { ok: false, status: 0, error: e.name };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBytes(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) return { ok: false, status: res.status, buf: null };
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, status: res.status, buf };
  } catch (e) {
    return { ok: false, status: 0, buf: null, error: e.name };
  } finally {
    clearTimeout(timer);
  }
}

/** 從 manifest 取出所有可能的 segment / 子 manifest 網址 */
function extractUrls(text) {
  const urls = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!line.startsWith('#')) {
      urls.push(line);
      continue;
    }
    // #EXT-X-MAP / #EXT-X-MEDIA / #EXT-X-I-FRAME-STREAM-INF 的 URI 屬性
    const m = line.match(/URI="([^"]+)"/);
    if (m) urls.push(m[1]);
  }
  return urls;
}

/**
 * 驗證單一來源的完整播放鏈路。
 */
async function verifyChain(url) {
  const man = await fetchText(url);
  if (!man.ok || !man.text) {
    return { ok: false, stage: 'manifest', status: man.status, reason: man.error || `HTTP ${man.status}` };
  }
  if (!man.text.trimStart().startsWith('#EXTM3U')) {
    return { ok: false, stage: 'manifest', status: man.status, reason: '非 m3u8 格式' };
  }

  const children = extractUrls(man.text);
  if (children.length === 0) {
    return { ok: false, stage: 'manifest', status: 200, reason: 'manifest 無子資源' };
  }

  // 逐個嘗試子資源，直到找到一個能取得合法 segment 的
  let lastReason = '所有子資源皆失敗';
  for (const child of children.slice(0, 4)) {
    let abs;
    try {
      abs = new URL(child, url).toString();
    } catch {
      continue;
    }

    // 情況 A：子資源本身是 manifest（多碼率）
    const sub = await fetchText(abs, 12000);
    if (sub.ok && sub.text && sub.text.trimStart().startsWith('#EXTM3U')) {
      const segs = extractUrls(sub.text);
      if (segs.length === 0) continue;
      const segUrl = new URL(segs[0], abs).toString();
      const seg = await fetchBytes(segUrl, 20000);
      if (!seg.ok || !seg.buf) {
        lastReason = `segment 抓取失敗 (HTTP ${seg.status})`;
        continue;
      }
      if (isMpegTs(seg.buf) || isFmp4(seg.buf)) {
        return {
          ok: true,
          kind: isFmp4(seg.buf) ? 'fmp4' : 'mpegts',
          bytes: seg.buf.length,
        };
      }
      lastReason = 'segment 格式異常（非 MPEG-TS / fMP4）';
      continue;
    }

    // 情況 B：子資源直接就是 segment
    const seg = await fetchBytes(abs, 20000);
    if (!seg.ok || !seg.buf) {
      lastReason = `segment 抓取失敗 (HTTP ${seg.status})`;
      continue;
    }
    if (isMpegTs(seg.buf) || isFmp4(seg.buf)) {
      return {
        ok: true,
        kind: isFmp4(seg.buf) ? 'fmp4' : 'mpegts',
        bytes: seg.buf.length,
      };
    }
    lastReason = 'segment 格式異常（非 MPEG-TS / fMP4）';
  }

  return { ok: false, stage: 'segment', status: 200, reason: lastReason };
}

/**
 * 驗證一個頻道的所有候選來源，回傳可用來源清單。
 */
async function verifyChannel(channel) {
  const candidates = [];
  const ps = channel.playlist_source;
  if (ps?.backup_urls?.length) {
    for (const b of ps.backup_urls) {
      if (b?.url) candidates.push(b.url);
    }
  }
  if (channel.stream_url && !candidates.includes(channel.stream_url)) {
    candidates.unshift(channel.stream_url);
  }
  if (!candidates.length && channel.stream_url) candidates.push(channel.stream_url);

  const working = [];
  for (const url of candidates.slice(0, 6)) {
    const r = await verifyChain(url);
    if (r.ok) {
      working.push({ url, kind: r.kind, bytes: r.bytes });
    } else if (VERBOSE) {
      console.error(`      ✗ ${url.slice(0, 70)} → ${r.reason}`);
    }
  }
  return working;
}

async function main() {
  const data = JSON.parse(readFileSync(TARGET_FILE, 'utf8'));
  const channels = data.channels.filter((c) => c.is_active);

  console.log('═'.repeat(70));
  console.log('串流深度探測（manifest → segment → 格式驗證）');
  console.log('═'.repeat(70));
  console.log(`目標檔案：${TARGET_FILE.replace(ROOT + '/', '')}`);
  console.log(`頻道數：${channels.length}\n`);

  const results = [];
  for (const ch of channels) {
    process.stdout.write(`  ${ch.channel_name.padEnd(24)}`);
    const working = await verifyChannel(ch);
    if (working.length === 0) {
      console.log('✗ 無可用來源');
      results.push({ channel: ch.channel_name, working: [] });
    } else {
      const kinds = [...new Set(working.map((w) => w.kind))].join('/');
      console.log(`✓ ${working.length} 個可用來源 (${kinds})`);
      results.push({ channel: ch.channel_name, working });
    }
  }

  const ok = results.filter((r) => r.working.length > 0);
  const bad = results.filter((r) => r.working.length === 0);

  console.log('\n' + '─'.repeat(70));
  console.log(`可用：${ok.length}/${results.length}`);
  if (bad.length) {
    console.log('\n不可用頻道（建議停用或等待來源恢復）：');
    for (const b of bad) console.log(`  · ${b.channel}`);
  }
  console.log('─'.repeat(70));

  // 輸出 JSON 供程式使用
  const outPath = join(ROOT, 'shared', '.probe-result.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    outPath,
    JSON.stringify(
      Object.fromEntries(results.map((r) => [r.channel, r.working])),
      null,
      2,
    ),
    'utf8',
  );
  console.log(`\n結果已存：${outPath.replace(ROOT + '/', '')}`);
}

main().catch((e) => {
  console.error('✗ 探測失敗:', e);
  process.exit(1);
});
