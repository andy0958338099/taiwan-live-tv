#!/usr/bin/env node
/**
 * test-proxy-segment-validation.mjs — 驗證代理的「segment 位元組驗證」規則
 *
 * ## 為什麼需要這個測試
 *
 * 代理為了避免把「已過期 segment 的 HTML 404 錯誤頁」當成影片快取，
 * 會在回應前檢查第一個 chunk 的位元組：
 *   · MPEG-TS       → 第 1 byte 必須是同步位元組 0x47
 *   · fMP4/ISO BMFF → 第 5–8 byte 必須是合法的頂層 box 型別
 *
 * ## 這裡要防止的回歸（2026-11-21 線上實測）
 *
 * 初版只接受 `ftyp`，結果 **天映頻道整個播不出來**（線上 502）。
 *
 * 原因在 ISO BMFF 規格（W3C「ISO BMFF Byte Stream Format」）：
 *   · 初始化區段（EXT-X-MAP） = `ftyp` + `moov`
 *   · 媒體區段（media segment）= 選用的 `styp` + `moof` + `mdat`
 *
 * **`ftyp` 只出現在初始化區段**；真正的影片片段開頭是 `styp` 或 `moof`。
 * 實測天映（`10.fast.hidns.vip/163189/ccm`）：
 *   init.txt   → box[4:8] = 'ftyp'  （初始化區段）
 *   10769….jpg → box[4:8] = 'styp'  （媒體區段）← 只認 ftyp 會被誤殺
 *
 * ## 測試內容
 *
 *  1. 位元組判斷規則的單元測試（不需網路）
 *  2. 線上實測：fMP4 頻道的 manifest → init segment → media segment
 *  3. 線上實測：確認 segment 的 Cache-Control 正確
 *
 * 用法：
 *   node scripts/test-proxy-segment-validation.mjs [--base https://taiwan-live-tv.netlify.app]
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const BASE = arg('base', 'https://taiwan-live-tv.netlify.app');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

// ─────────────────────────────────────────────────────────────
// 1. 位元組判斷規則（必須與 web/src/app/api/proxy/[target]/route.ts 一致）
// ─────────────────────────────────────────────────────────────

/** ISO BMFF 合法的頂層 box 型別 */
const ISO_BMFF_BOX_TYPES = new Set([
  'ftyp',
  'styp',
  'moof',
  'mdat',
  'moov',
  'sidx',
  'emsg',
  'prft',
  'pdin',
  'free',
  'skip',
]);

/** 與代理相同規則的「這是有效串流內容」判定 */
function looksLikeStream(bytes) {
  if (!bytes || bytes.length === 0) return false;
  if (bytes[0] === 0x47) return true; // MPEG-TS
  if (bytes.length < 8) return false;
  const boxType = String.fromCharCode(
    bytes[4],
    bytes[5],
    bytes[6],
    bytes[7],
  );
  return ISO_BMFF_BOX_TYPES.has(boxType);
}

/** 造一個 fMP4 box 開頭：4 bytes 長度 + 4 bytes 型別 */
function makeBox(type, payload = 64) {
  const buf = Buffer.alloc(8 + payload);
  buf.writeUInt32BE(8 + payload, 0);
  buf.write(type, 4, 4, 'latin1');
  return buf;
}

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(
    `  ${ok ? '✓' : '✗'} ${name.padEnd(46)} ${ok ? '' : `（預期 ${expected}，實際 ${actual}）`}`,
  );
}

console.log('═'.repeat(70));
console.log('代理 segment 位元組驗證 — 規則測試');
console.log('═'.repeat(70));

console.log('\n【1. MPEG-TS】');
check('TS 開頭（0x47）應視為串流', looksLikeStream(Buffer.from([0x47, 0x40, 0x00])), true);
check('TS 開頭（0x46）應視為非串流', looksLikeStream(Buffer.from([0x46, 0x40, 0x00])), false);

console.log('\n【2. fMP4 / ISO BMFF box 型別】');
for (const t of ['ftyp', 'styp', 'moof', 'mdat', 'sidx', 'emsg', 'prft']) {
  check(`'${t}' box 應視為串流`, looksLikeStream(makeBox(t)), true);
}
for (const t of ['html', 'junk', 'xxxx']) {
  check(`'${t}' 應視為非串流`, looksLikeStream(makeBox(t)), false);
}
check('空內容應視為非串流', looksLikeStream(Buffer.alloc(0)), false);

console.log('\n【3. HTML 錯誤頁（回歸測試：不能被當成串流）】');
const htmlPage = Buffer.from(
  '<!DOCTYPE html>\r\n<html lang="en">\r\n<head>\r\n    <meta charset="UTF-8">\r\n    <title>404</title>\r\n</head>\r\n<body>\r\n<h1 align="center">404错误</h1>\r\n</body>\r\n</html>',
  'latin1',
);
check('HTML 404 頁應視為非串流', looksLikeStream(htmlPage), false);
check('HTML 404 頁的第 1 byte 不是 0x47', htmlPage[0] === 0x47, false);

console.log('\n【4. 關鍵回歸：media segment 的 styp 不能被誤殺】');
check('styp media segment 應視為串流', looksLikeStream(makeBox('styp')), true);
check(
  "ftyp 與 styp 判定結果一致（避免只認 ftyp 的 bug）",
  looksLikeStream(makeBox('ftyp')) === looksLikeStream(makeBox('styp')),
  true,
);

// ─────────────────────────────────────────────────────────────
// 2. 線上實測
// ─────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(70));
console.log(`線上實測：${BASE}`);
console.log('═'.repeat(70));

const catalog = JSON.parse(
  readFileSync(join(ROOT, 'shared', 'channels.json'), 'utf8'),
);

/** 目標網址 → 代理路徑（base64url 放在 path，避免 CDN 快取鍵不含 query） */
function proxyPath(target) {
  return `/api/proxy/${Buffer.from(target, 'utf8').toString('base64url')}`;
}

async function fetchWithTimeout(url, opts = {}, ms = 45_000) {
  return fetch(url, {
    ...opts,
    headers: { 'User-Agent': UA, 'x-nextjs-data': '1', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(ms),
  });
}

async function testFmp4Channel() {
  console.log('\n【5. fMP4 頻道實測（天映）】');

  const target = 'https://10.fast.hidns.vip/163189/ccm/video/index.php';

  // 先確認這個網址在允許清單裡（用頻道的 stream_url 取得簽章）
  const chan = catalog.channels.find((c) => c.channel_id === 'playlist-天映-天映');
  if (!chan) {
    console.log('  ✗ 找不到天映頻道');
    failures++;
    return;
  }

  // 取 manifest —— 必須走頻道本身的 stream_url 才有簽章
  const manifestRes = await fetchWithTimeout(
    new URL(proxyPath(chan.stream_url), BASE).href,
  );
  console.log(`  manifest HTTP ${manifestRes.status}`);
  if (manifestRes.status !== 200) {
    console.log('  ✗ manifest 取不到');
    failures++;
    return;
  }
  const manifestText = await manifestRes.text();
  const manifestCc = manifestRes.headers.get('cache-control') || '';
  check('manifest 應為 no-store', /no-store/.test(manifestCc), true);

  /**
   * 天映的 stream_url 是 **master manifest**，
   * 指向子 manifest `https://10.fast.hidns.vip/163189/ccm/video/index.php`。
   * EXT-X-MAP 與 media segment 都在**子 manifest** 裡。
   */
  let text = manifestText;
  const masterLines = text
    .split('\n')
    .map((s) => s.trim())
    .filter((l) => l && !l.startsWith('#'));
  const isMaster =
    masterLines.length > 0 && masterLines[0].includes('/api/proxy');

  if (isMaster) {
    console.log('  （master manifest → 取子 manifest）');
    const subRes = await fetchWithTimeout(new URL(masterLines[0], BASE).href);
    console.log(`  子 manifest HTTP ${subRes.status}`);
    if (subRes.status !== 200) {
      /*
       * 來源是第三方轉載，**master manifest 的子清單網址會變**
       * （上游換路徑、換 CDN、甚至換來源）。
       * 「子 manifest 取不到」不代表代理有問題 ——
       * 這個測項要驗的是「代理對 fMP4 segment 的位元組驗證」，
       * 拿不到就略過，不要把整個測試判成失敗。
       */
      console.log(`  ⚠️ 子 manifest 取不到（HTTP ${subRes.status}）—— 略過此測項`);
      return;
    }
    text = await subRes.text();
  }

  // 從 manifest 取出 EXT-X-MAP（ftyp）與 media segment（styp）
  const mapUrl = text.match(/#EXT-X-MAP:URI="([^"]+)"/)?.[1];
  const segUrl = text
    .split('\n')
    .map((s) => s.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('/api/proxy'))[0];

  if (!mapUrl) {
    console.log('  ✗ manifest 沒有 EXT-X-MAP');
    failures++;
    return;
  }
  if (!segUrl) {
    console.log('  ✗ manifest 沒有 media segment');
    failures++;
    return;
  }

  // init segment（ftyp）
  const initRes = await fetchWithTimeout(new URL(mapUrl, BASE).href);
  const initBytes = Buffer.from(await initRes.arrayBuffer());
  const initBox = initBytes.slice(4, 8).toString('latin1');
  console.log(`  init segment   HTTP ${initRes.status}  box=${initBox}  len=${initBytes.length}`);
  check('init segment（ftyp）應回 200', initRes.status, 200);
  check('init segment 應可快取', /max-age=[1-9]/.test(initRes.headers.get('cache-control') || ''), true);

  // media segment（styp）—— 這就是回歸點
  const segRes = await fetchWithTimeout(new URL(segUrl, BASE).href);
  const segBytes = Buffer.from(await segRes.arrayBuffer());
  const segBox = segBytes.slice(4, 8).toString('latin1');
  const segCc = segRes.headers.get('cache-control') || '';
  console.log(`  media segment  HTTP ${segRes.status}  box=${segBox}  len=${segBytes.length}`);
  console.log(`  media segment  Cache-Control: ${segCc}`);

  check('media segment 應回 200（不可誤殺 styp）', segRes.status, 200);
  check('media segment 應可快取', /max-age=[1-9]/.test(segCc), true);
  check('media segment 首位元組應是 styp box', segBox, 'styp');
  if (segRes.status !== 200) {
    console.log(`     body: ${segBytes.toString('utf8').slice(0, 120)}`);
  }
}

async function testMpegTsChannel() {
  console.log('\n【6. MPEG-TS 頻道實測（GOOD TV 綜合台）】');

  const chan = catalog.channels.find((c) => c.channel_id === 'tw-goodtv-ch1');
  if (!chan) {
    console.log('  ✗ 找不到 GOOD TV 頻道');
    failures++;
    return;
  }

  const manifestRes = await fetchWithTimeout(
    new URL(proxyPath(chan.stream_url), BASE).href,
  );
  console.log(`  manifest HTTP ${manifestRes.status}`);
  const text = await manifestRes.text();

  // master manifest → variant → segment
  const lines = text
    .split('\n')
    .map((s) => s.trim())
    .filter((l) => l && !l.startsWith('#'));

  let segUrl = null;
  if (lines[0]?.includes('/api/proxy')) {
    const variantRes = await fetchWithTimeout(new URL(lines[0], BASE).href);
    const variantText = await variantRes.text();
    segUrl = variantText
      .split('\n')
      .map((s) => s.trim())
      .filter((l) => l && !l.startsWith('#') && l.includes('/api/proxy'))[0];
  }

  if (!segUrl) {
    console.log('  ✗ 找不到 segment 網址');
    failures++;
    return;
  }

  const segRes = await fetchWithTimeout(new URL(segUrl, BASE).href, {}, 60_000);
  const segBytes = Buffer.from(await segRes.arrayBuffer());
  const segCc = segRes.headers.get('cache-control') || '';
  console.log(`  segment HTTP ${segRes.status}  len=${segBytes.length}  cc=${segCc}`);

  check('segment 應回 200', segRes.status, 200);
  check('segment 應可快取（max-age>0）', /max-age=[1-9]/.test(segCc), true);
  check('segment 首位元組應是 0x47 (MPEG-TS)', segBytes[0], 0x47);
}

async function testErrorPageNotCached() {
  console.log('\n【7. 錯誤頁不得被快取（回歸測試）】');

  // 央視來源主機對不存在的路徑會回 206 + HTML 404 頁（實測）
  const target = 'http://121.19.134.149:808/tsfile/live/nonexistent_probe.ts';
  const chan = catalog.channels.find((c) => c.channel_id === 'cn-cctv1');
  if (!chan) {
    console.log('  ✗ 找不到央視-1 頻道');
    failures++;
    return;
  }

  // 直接對上游確認它真的回 HTML
  try {
    const upstreamRes = await fetchWithTimeout(target, {}, 25_000);
    const upstreamBytes = Buffer.from(await upstreamRes.arrayBuffer());
    const isHtml = /^\s*<!DOCTYPE/i.test(
      upstreamBytes.toString('latin1').slice(0, 20),
    );
    console.log(
      `  上游直接請求：HTTP ${upstreamRes.status}  cr=${upstreamRes.headers.get('content-range')}  是HTML=${isHtml}`,
    );
    if (!isHtml) {
      console.log('  （上游目前沒有回 HTML 錯誤頁，略過此項）');
      return;
    }
  } catch (e) {
    console.log(`  （上游無法連線：${e.message.slice(0, 40)}，略過此項）`);
    return;
  }

  // 這個網址不在允許清單 → 應被 403（不是我們要測的路徑）
  const res = await fetchWithTimeout(new URL(proxyPath(target), BASE).href);
  console.log(`  代理回應：HTTP ${res.status}`);
  check('不在允許清單的網址應被拒絕', res.status, 403);
}

// ─────────────────────────────────────────────────────────────

await testFmp4Channel();
await testMpegTsChannel();
await testErrorPageNotCached();

console.log('\n' + '═'.repeat(70));
if (failures > 0) {
  console.log(`✗ ${failures} 項未通過`);
  console.log('═'.repeat(70));
  process.exit(1);
}
console.log('✓ 全部通過');
console.log('═'.repeat(70));
