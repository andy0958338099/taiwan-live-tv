#!/usr/bin/env node
/**
 * find-alternate-for-dead.mjs — 為「停播」的頻道找可用的替代來源
 *
 * ## 為什麼需要
 *
 * 量測發現 5 個頻道的 live playlist 完全停滯（序號不前進），
 * 但它們**沒有任何備援來源**（backup_sources: null），
 * 所以播放器沒有東西可以 failover 到 —— 使用者只會看到最後一格畫面。
 *
 * 這個腳本從候選池（`shared/.probe-result.json` + 既有 IPTV 清單）
 * 找出**同名頻道**的其他來源，並實測「序號是否會前進」。
 *
 * ## 判定標準（比 deep probe 嚴格）
 *
 *   1. manifest 可取得
 *   2. 子清單序號在觀察窗內**有前進**（這是「真的在直播」）
 *   3. segment 可下載且大小合理
 *
 * 用法：node scripts/find-alternate-for-dead.mjs [--seconds 30] [--channel 龍華]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const SECONDS = Number(arg('seconds', '30'));
const ONLY = arg('channel', '');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';

const DEAD = ['龍華電視', 'Now TV', '天映', '浙江衛視', '鳳凰衛視香港台'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(url) {
  try {
    const res = await fetch(url, {
      headers: { Referer: 'https://taiwan-live-tv.netlify.app/', 'User-Agent': UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function childUrlFrom(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j] && !lines[j].startsWith('#')) return new URL(lines[j], base).toString();
      }
    }
  }
  return null;
}

function seqOf(text) {
  const m = text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m);
  return m ? Number(m[1]) : null;
}

/** 完整驗證：manifest → child → 序號前進 → segment 可下載 */
async function verifyLive(url) {
  const master = await getText(url);
  if (!master) return { ok: false, reason: 'manifest 取得失敗' };
  if (!master.trimStart().startsWith('#EXTM3U')) return { ok: false, reason: '不是 manifest' };

  const child = childUrlFrom(master, url) ?? url;
  const first = await getText(child);
  if (!first) return { ok: false, reason: '子清單取得失敗' };

  const s1 = seqOf(first);
  const tdMatch = first.match(/^#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/m);
  const td = tdMatch ? Number(tdMatch[1]) : null;

  // 序號是否會前進
  const pollMs = td ? Math.max(2000, Math.round((td * 1000) / 2)) : 5000;
  const s2 = await getText(child);
  const s2v = s2 ? seqOf(s2) : null;
  if (s1 === null) return { ok: false, reason: '無 MEDIA-SEQUENCE' };
  if (s2v === null) return { ok: false, reason: '第二次讀取失敗' };

  // 再等一個輪詢週期確認真的在動
  await sleep(pollMs);
  const s3text = await getText(child);
  const s3 = s3text ? seqOf(s3text) : null;
  const advanced = s3 !== null && s3 !== s1;

  // segment 可下載？
  const segLines = first.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const seg = segLines[segLines.length - 1];
  let segBytes = 0;
  if (seg) {
    try {
      const r = await fetch(new URL(seg, child).toString(), {
        headers: { Referer: 'https://taiwan-live-tv.netlify.app/', 'User-Agent': UA },
        signal: AbortSignal.timeout(25_000),
      });
      if (r.ok) segBytes = (await r.arrayBuffer()).byteLength;
    } catch {
      segBytes = 0;
    }
  }

  return {
    ok: advanced && segBytes > 100_000,
    advanced,
    segBytes,
    td,
    seq: s1,
    reason: advanced
      ? segBytes > 100_000
        ? 'ok'
        : `序號會前進但 segment 只有 ${segBytes}B`
      : `序號不動（${s1} → ${s3}）`,
  };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('為停播頻道尋找可用替代來源');
  console.log('═'.repeat(80));

  const probe = JSON.parse(readFileSync('shared/.probe-result.json', 'utf8'));
  const targets = ONLY ? [ONLY] : DEAD;

  const out = {};
  for (const name of targets) {
    const cands = probe[name];
    console.log(`\n── ${name}（候選 ${cands?.length ?? 0} 筆）`);
    if (!cands || !cands.length) {
      console.log('   （候選池沒有這個頻道）');
      out[name] = [];
      continue;
    }
    const results = [];
    for (const c of cands) {
      const v = await verifyLive(c.url);
      console.log(
        `   ${v.ok ? '✓' : '✗'} ${c.url.slice(0, 78).padEnd(78)} ${v.reason}`,
      );
      results.push({ ...c, ...v });
    }
    const good = results.filter((r) => r.ok);
    out[name] = good;
    console.log(`   → 可用替代：${good.length} 筆`);
    for (const g of good) console.log(`      ★ ${g.url}  (td=${g.td}s seg=${g.segBytes}B)`);
  }

  writeFileSync(
    '/Users/andy/.hermes/cache/scratch/dead-alternates.json',
    JSON.stringify({ at: new Date().toISOString(), out }, null, 2),
  );
  console.log('\n已寫入 /Users/andy/.hermes/cache/scratch/dead-alternates.json');
}

main();
