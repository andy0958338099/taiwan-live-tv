#!/usr/bin/env node
/**
 * 區分「來源失效」與「只能在台灣播」兩種失敗。
 *
 * ## 為什麼需要區分
 *
 * iptv-org 的台灣來源很多是**地理限制**的（只允許台灣 IP）。
 * 我們的正式環境跑在 Netlify（美國），所以：
 *   · 本機（台中 IP）能播 → 對台灣使用者有用，但 Web 版需要台灣的伺服器
 *   · 兩邊都不能播    → 來源真的壞了，必須排除
 *
 * 「有問題的不要」指的是後者 —— 真的壞掉的來源不該出現在清單裡，
 * 只在台灣能播的則要標註清楚（Android 原生不受 CORS 限制，但仍受地理限制）。
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

const result = JSON.parse(
  readFileSync(join(SCRATCH, 'iptv-org-tw-result.json'), 'utf8'),
);

/** 從本機（台灣 IP）測試 manifest + segment */
async function probeLocal(url) {
  const out = { ok: false, reason: '', targetDuration: null, segmentBytes: 0, segmentMs: null };
  let m3u;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) {
      out.reason = `HTTP ${res.status}`;
      return out;
    }
    const text = await res.text();
    if (!text.trimStart().startsWith('#EXTM3U')) {
      out.reason = '不是 manifest';
      return out;
    }
    if (/#EXT-X-ENDLIST/.test(text)) {
      out.reason = '是 VOD';
      return out;
    }
    m3u = text;
  } catch (e) {
    out.reason = e.cause?.code ?? e.message;
    return out;
  }

  const td = m3u.match(/#EXT-X-TARGETDURATION:\s*([\d.]+)/);
  out.targetDuration = td ? parseFloat(td[1]) : null;

  let segs = m3u
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (!segs.length) {
    out.reason = '沒有 segment';
    return out;
  }
  segs = segs.map((s) => (s.startsWith('http') ? s : new URL(s, url).href));

  if (!/\.(ts|m4s|mp4|aac)(\?|$)/i.test(segs[0])) {
    try {
      const sub = await fetch(segs[0], {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(25000),
      });
      if (!sub.ok) {
        out.reason = `子 manifest HTTP ${sub.status}`;
        return out;
      }
      const subText = await sub.text();
      if (!subText.trimStart().startsWith('#EXTM3U')) {
        out.reason = '子 manifest 不是 m3u8';
        return out;
      }
      const subTd = subText.match(/#EXT-X-TARGETDURATION:\s*([\d.]+)/);
      if (subTd) out.targetDuration = parseFloat(subTd[1]);
      const subSegs = subText
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((s) => (s.startsWith('http') ? s : new URL(s, segs[0]).href));
      if (!subSegs.length) {
        out.reason = '子 manifest 沒有 segment';
        return out;
      }
      segs = subSegs;
    } catch (e) {
      out.reason = e.cause?.code ?? e.message;
      return out;
    }
  }

  try {
    const t0 = Date.now();
    const res = await fetch(segs[Math.max(0, segs.length - 1)], {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(35000),
    });
    if (!res.ok && res.status !== 206) {
      out.reason = `segment HTTP ${res.status}`;
      return out;
    }
    const reader = res.body?.getReader();
    const first = await reader.read();
    if (first.done || !first.value || first.value.byteLength === 0) {
      out.reason = 'segment 是空的';
      return out;
    }
    const h = first.value;
    const isTs = h[0] === 0x47;
    const isMp4 =
      h.byteLength >= 8 &&
      h[4] === 0x66 && h[5] === 0x74 && h[6] === 0x79 && h[7] === 0x70;
    if (!isTs && !isMp4) {
      out.reason = 'segment 不是串流內容';
      return out;
    }
    out.segmentBytes = h.byteLength;
    out.segmentMs = Date.now() - t0;
    out.ok = true;
    return out;
  } catch (e) {
    out.reason = e.cause?.code ?? e.message;
    return out;
  }
}

console.log('════ 台灣本機實測（排除清單裡實測失敗的）════\n');

const retest = [];
for (const r of result.rejected) {
  if (!/實測失敗/.test(r.reason)) continue;
  process.stdout.write(`  ${r.raw_name.slice(0, 38).padEnd(40)} `);
  const p = await probeLocal(r.url);
  if (p.ok) {
    console.log(`✓ 本機可播 ${String(p.segmentMs).padStart(5)}ms  td=${p.targetDuration ?? '?'}s`);
    retest.push({ ...r, local_ok: true, local_probe: p });
  } else {
    console.log(`✗ ${p.reason}`);
    retest.push({ ...r, local_ok: false, local_probe: p });
  }
}

console.log('\n════ 分類結果 ════');
const localOnly = retest.filter((r) => r.local_ok);
const dead = retest.filter((r) => !r.local_ok);
console.log(`  本機能播（先前被誤判失敗）: ${localOnly.length}`);
for (const r of localOnly) {
  console.log(`    ✓ ${r.name.padEnd(22)} ${r.raw_name.slice(0, 34)}`);
}
console.log(`  真的壞掉（兩個位置都不能播）: ${dead.length}`);
for (const r of dead) {
  console.log(`    ✗ ${r.name.padEnd(22)} ${r.local_probe.reason}`);
}

// 已通過的（兩個位置都能播）
console.log(`  兩個位置都能播: ${result.accepted.length}`);

const out = {
  ...result,
  retested_from_taiwan: retest,
  local_only: localOnly,
  confirmed_dead: dead,
};
writeFileSync(
  join(SCRATCH, 'iptv-org-tw-final.json'),
  JSON.stringify(out, null, 2) + '\n',
  'utf8',
);
console.log(`\n已寫入 ${join(SCRATCH, 'iptv-org-tw-final.json')}`);
