#!/usr/bin/env node
/**
 * 深度驗證候選頻道：連續抓多個 segment，確認是真正的持續直播。
 *
 * 單一 segment 抓得到不代表能播 —— 有些來源只回第一個片段就斷。
 * 這個測試會：
 *   1. 抓 manifest
 *   2. 連續抓 3 個**不同**的 segment
 *   3. 每個都驗證位元組型別（MPEG-TS 0x47 / fMP4 ftyp）
 *   4. 確認 manifest 會隨時間滾動（segment 列表在變）
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

const res = JSON.parse(readFileSync(join(SCRATCH, 'iptv-org-tw-final.json'), 'utf8'));
const candidates = res.accepted;

function parseSegs(text, base) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((s) => (s.startsWith('http') ? s : new URL(s, base).href));
}

async function getManifestChain(url) {
  const res1 = await fetch(url, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  if (!res1.ok) throw new Error(`HTTP ${res1.status}`);
  let text = await res1.text();
  if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('不是 manifest');
  let segs = parseSegs(text, url);
  let isVod = /#EXT-X-ENDLIST/.test(text);
  let td = text.match(/#EXT-X-TARGETDURATION:\s*([\d.]+)/);

  if (segs.length && !/\.(ts|m4s|mp4|aac)(\?|$)/i.test(segs[0])) {
    const r2 = await fetch(segs[0], {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(25000),
    });
    if (!r2.ok) throw new Error(`子 manifest HTTP ${r2.status}`);
    const t2 = await r2.text();
    if (!t2.trimStart().startsWith('#EXTM3U')) throw new Error('子 manifest 不是 m3u8');
    if (/#EXT-X-ENDLIST/.test(t2)) isVod = true;
    const td2 = t2.match(/#EXT-X-TARGETDURATION:\s*([\d.]+)/);
    if (td2) td = td2;
    segs = parseSegs(t2, segs[0]);
  }
  return {
    segs,
    isVod,
    targetDuration: td ? parseFloat(td[1]) : null,
  };
}

async function checkSegment(url) {
  const t0 = Date.now();
  const r = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok && r.status !== 206) return { ok: false, reason: `HTTP ${r.status}` };
  const reader = r.body?.getReader();
  let bytes = 0;
  let head = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!head) head = value;
    bytes += value.length;
  }
  const isTs = head && head[0] === 0x47;
  const isMp4 =
    head && head.byteLength >= 8 &&
    head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70;
  if (!isTs && !isMp4) {
    return { ok: false, reason: '不是串流內容', bytes };
  }
  return {
    ok: true,
    bytes,
    ms: Date.now() - t0,
    kind: isTs ? 'mpegts' : 'fmp4',
  };
}

console.log('════ 深度驗證：連續 3 個不同 segment ════\n');

const verified = [];
for (const c of candidates) {
  console.log(`📺 ${c.name}  (${c.raw_name})`);
  console.log(`   ${c.url}\n`);

  try {
    const m1 = await getManifestChain(c.url);
    if (m1.isVod) {
      console.log('   ✗ 是 VOD，不是直播\n');
      continue;
    }
    if (!m1.segs.length) {
      console.log('   ✗ manifest 沒有 segment\n');
      continue;
    }
    console.log(
      `   manifest: ${m1.segs.length} 個 segment, td=${m1.targetDuration ?? '?'}s`,
    );

    // 取最後 3 個（最新的）
    const picks = m1.segs.slice(-3).reverse();
    let allOk = true;
    const details = [];
    for (const seg of picks) {
      const r = await checkSegment(seg);
      if (r.ok) {
        console.log(
          `   ✓ ${(r.bytes / 1024 / 1024).toFixed(2)}MB  ${String(r.ms).padStart(5)}ms  ${r.kind}`,
        );
        details.push(r);
      } else {
        console.log(`   ✗ ${r.reason}`);
        allOk = false;
      }
    }

    // 檢查 manifest 是否會滾動（等 12 秒再看 segment 列表是否不同）
    await new Promise((r) => setTimeout(r, 12000));
    const m2 = await getManifestChain(c.url);
    const s1 = new Set(m1.segs);
    const s2 = new Set(m2.segs);
    const overlap = [...s1].filter((x) => s2.has(x)).length;
    const rolling = overlap < m1.segs.length;
    console.log(
      `   滾動檢查: 12 秒後 ${m2.segs.length} 個 segment，重疊 ${overlap}/${m1.segs.length} ` +
        `→ ${rolling ? '✓ 持續更新（真直播）' : '⚠ 未滾動'}`,
    );

    if (allOk && rolling) {
      console.log(`   ▸ ★ 通過深度驗證\n`);
      verified.push({
        ...c,
        deep_verify: {
          segments_tested: details.length,
          all_ok: allOk,
          rolling,
          target_duration: m1.targetDuration,
          avg_segment_ms: Math.round(
            details.reduce((s, d) => s + d.ms, 0) / Math.max(1, details.length),
          ),
          avg_segment_mb: Number(
            (
              details.reduce((s, d) => s + d.bytes, 0) /
              Math.max(1, details.length) /
              1024 /
              1024
            ).toFixed(2),
          ),
        },
      });
    } else {
      console.log(`   ▸ ✗ 未通過（segment ${allOk ? 'OK' : '有失敗'}、滾動 ${rolling ? 'OK' : '無'}）\n`);
    }
  } catch (e) {
    console.log(`   ✗ ${e.message}\n`);
  }
}

console.log('════ 最終結果 ════');
console.log(`  通過深度驗證: ${verified.length}`);
for (const v of verified) {
  console.log(
    `    ✓ ${v.name.padEnd(22)} td=${v.deep_verify.target_duration}s  ` +
      `avg ${v.deep_verify.avg_segment_mb}MB / ${v.deep_verify.avg_segment_ms}ms  ${v.url.slice(0, 50)}`,
  );
}

writeFileSync(
  join(SCRATCH, 'iptv-org-tw-verified.json'),
  JSON.stringify({ verified }, null, 2) + '\n',
  'utf8',
);
console.log(`\n已寫入 ${join(SCRATCH, 'iptv-org-tw-verified.json')}`);
