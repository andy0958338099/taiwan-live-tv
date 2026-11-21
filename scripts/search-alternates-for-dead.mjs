#!/usr/bin/env node
/**
 * search-alternates-for-dead.mjs — 在多個公開 IPTV 清單中搜尋死掉的頻道的替代來源
 *
 * 停播的 5 個頻道（2026-11-22 量測）：
 *   龍華電視 / Now TV / 天映 / 浙江衛視 / 鳳凰衛視香港台
 *
 * 做法：抓取多個公開清單 → 用頻道名稱比對 → 對每個候選實測
 *      「序號是否會前進」（比 deep probe 嚴格，因為 deep probe 抓不到停播）
 *
 * 用法：node scripts/search-alternates-for-dead.mjs [--seconds 25]
 */
import { writeFileSync } from 'node:fs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const SECONDS = Number(arg('seconds', '25'));
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';

const LISTS = [
  { url: 'https://iptv.yang-1989.xyz/playlist.m3u', label: 'YanG IPTV' },
  { url: 'https://iptv.445569.xyz/live.m3u', label: '裤佬 IPTV' },
  { url: 'https://live.zbds.top/tv/iptv4.m3u', label: 'zbds IPTV4' },
  { url: 'https://raw.githubusercontent.com/Guovin/iptv-api/gd/output/result.m3u', label: 'Guovin' },
  { url: 'https://raw.githubusercontent.com/BurningC4/Chinese-IPTV/master/TV-IPV4.m3u', label: 'BurningC4' },
  { url: 'https://raw.githubusercontent.com/fanmingming/live/main/tv/m3u/ipv6.m3u', label: '范明明' },
  { url: 'https://epg.pw/test_channels_taiwan.m3u', label: 'epg.pw 台灣' },
  { url: 'https://raw.githubusercontent.com/YueChan/Live/main/IPTV.m3u', label: 'YueChan' },
  { url: 'https://raw.githubusercontent.com/BigBigGrandG/IPTV-URL/release/Gather.m3u', label: 'BigBigGrandG' },
];

/** 要找替代的頻道 → 關鍵字（用來比對 tvg-name / 頻道名稱） */
const WANT = [
  { name: '龍華電視', keys: ['龍華'] },
  { name: 'Now TV', keys: ['NowTV', 'Now 新聞', 'Now新聞', 'Now TV'] },
  { name: '天映', keys: ['天映'] },
  { name: '浙江衛視', keys: ['浙江衛視', '浙江'] },
  { name: '鳳凰衛視香港台', keys: ['鳳凰衛視香港', '鳳凰香港'] },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** 解析 m3u → [{ name, url }] */
function parseM3u(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  let name = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const m = line.match(/,(.+)$/);
      name = m ? m[1].trim() : '';
      continue;
    }
    if (line.startsWith('#')) continue;
    if (name) out.push({ name, url: line });
  }
  return out;
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

/** 嚴格驗證：序號必須會前進 */
async function verifyLive(url) {
  const master = await getText(url);
  if (!master) return { ok: false, reason: 'manifest 取得失敗' };
  if (!master.trimStart().startsWith('#EXTM3U')) return { ok: false, reason: '不是 manifest' };

  const child = childUrlFrom(master, url) ?? url;
  const first = await getText(child);
  if (!first) return { ok: false, reason: '子清單取得失敗' };
  const s1 = seqOf(first);
  if (s1 === null) return { ok: false, reason: '無 MEDIA-SEQUENCE（VOD 或非 live）' };

  const tdMatch = first.match(/^#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/m);
  const td = tdMatch ? Number(tdMatch[1]) : null;
  const pollMs = td ? Math.max(2000, Math.round((td * 1000) / 2)) : 5000;

  await sleep(pollMs);
  const s2text = await getText(child);
  const s2 = s2text ? seqOf(s2text) : null;
  if (s2 === null) return { ok: false, reason: '第二次讀取失敗' };
  if (s2 === s1) return { ok: false, reason: `序號不動（${s1}）`, td };

  return { ok: true, reason: `序號前進 ${s1}→${s2}`, td, seq: s2 };
}

async function main() {
  console.log('═'.repeat(80));
  console.log('在公開 IPTV 清單中搜尋停播頻道的替代來源');
  console.log('═'.repeat(80));

  const pool = new Map(); // name → Map(url → { name, url, source })

  for (const list of LISTS) {
    process.stdout.write(`  抓取 ${list.label.padEnd(18)} … `);
    const text = await getText(list.url);
    if (!text) {
      console.log('✗ 取得失敗');
      continue;
    }
    const items = parseM3u(text);
    console.log(`✓ ${items.length} 筆`);
    for (const item of items) {
      for (const w of WANT) {
        if (!w.keys.some((k) => item.name.includes(k))) continue;
        if (!pool.has(w.name)) pool.set(w.name, new Map());
        const m = pool.get(w.name);
        if (!m.has(item.url)) m.set(item.url, { name: item.name, url: item.url, source: list.label });
      }
    }
  }

  const results = {};
  for (const w of WANT) {
    const m = pool.get(w.name);
    const cands = m ? [...m.values()] : [];
    console.log(`\n── ${w.name}（候選 ${cands.length} 筆）`);
    const good = [];
    for (const c of cands) {
      const v = await verifyLive(c.url);
      console.log(`   ${v.ok ? '✓' : '✗'} [${c.source}] ${c.name} → ${v.reason}`);
      console.log(`      ${c.url}`);
      if (v.ok) good.push({ ...c, ...v });
    }
    results[w.name] = good;
    console.log(`   → 可用：${good.length} 筆`);
  }

  writeFileSync(
    '/Users/andy/.hermes/cache/scratch/dead-search.json',
    JSON.stringify({ at: new Date().toISOString(), results }, null, 2),
  );
  console.log('\n已寫入 /Users/andy/.hermes/cache/scratch/dead-search.json');
}

main();
