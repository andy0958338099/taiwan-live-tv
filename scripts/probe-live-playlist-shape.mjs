/**
 * 量測各頻道「live media playlist」的結構。
 *
 * 為什麼需要：
 *   hls.js issue #7556（已由 upstream 確認修復）指出，
 *   當 live media playlist 只有 1–2 個 segment 時，
 *   hls.js 會把 reload interval 重複加兩次，導致**停頓一個 target duration**。
 *   upstream 的建議是設定 `initialLiveManifestSize: 3`。
 *
 *   但這有風險：如果某個來源的 playlist **永遠只有 1–2 個 segment**，
 *   設成 3 會讓 hls.js 永遠不載入第一個 fragment → 完全播不出來。
 *
 *   所以要先量測：每個來源的 playlist 到底有幾個 segment。
 *
 * 用法：node scripts/probe-live-playlist-shape.mjs [--sample 20]
 */
import { readFileSync } from 'node:fs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const SAMPLE = Number(arg('sample', '0')); // 0 = 全部
const TIMEOUT_MS = 15_000;

const catalog = JSON.parse(readFileSync('shared/channels.json', 'utf8'));
const channels = catalog.channels ?? catalog;

const targets = channels
  .filter((c) => c.stream_url && !String(c.stream_url).startsWith('/'))
  .filter((c) => c.stream_type !== 'embed');

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        // 部分來源沒有 Referer 會回 403
        Referer: 'https://taiwan-live-tv.netlify.app/',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
      },
    });
    if (!res.ok) return { ok: false, status: res.status, text: '' };
    return { ok: true, status: res.status, text: await res.text() };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: String(e?.message ?? e) };
  } finally {
    clearTimeout(t);
  }
}

/** 數出 media playlist 裡的 segment（不是 #EXT-X-* 指令列） */
function countSegments(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let segCount = 0;
  let targetDuration = null;
  let isMaster = false;
  let endList = false;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF')) isMaster = true;
    if (line.startsWith('#EXT-X-ENDLIST')) endList = true;
    const td = line.match(/^#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/);
    if (td) targetDuration = Number(td[1]);
    if (!line.startsWith('#')) segCount += 1;
  }
  return { segCount, targetDuration, isMaster, endList };
}

/** 取得 child playlist 的網址（master manifest 的第一個 variant） */
function extractChild(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j] && !lines[j].startsWith('#')) {
          return new URL(lines[j], base).toString();
        }
      }
    }
  }
  return null;
}

const list = SAMPLE > 0 ? targets.slice(0, SAMPLE) : targets;
const rows = [];

for (const ch of list) {
  const res = await fetchText(ch.stream_url);
  if (!res.ok) {
    rows.push({ id: ch.channel_id, name: ch.channel_name, status: res.status, note: 'fetch failed' });
    continue;
  }
  const shape = countSegments(res.text);
  let row = {
    id: ch.channel_id,
    name: ch.channel_name,
    status: res.status,
    kind: shape.isMaster ? 'master' : 'media',
    segs: shape.segCount,
    td: shape.targetDuration,
    endList: shape.endList,
  };
  if (shape.isMaster) {
    const child = extractChild(res.text, ch.stream_url);
    if (child) {
      const cres = await fetchText(child);
      if (cres.ok) {
        const cshape = countSegments(cres.text);
        row = {
          ...row,
          kind: 'master→media',
          segs: cshape.segCount,
          td: cshape.targetDuration ?? shape.targetDuration,
          endList: cshape.endList,
        };
      } else {
        row = { ...row, note: `child fetch ${cres.status}` };
      }
    } else {
      row = { ...row, note: 'no child url' };
    }
  }
  rows.push(row);
}

console.log('='.repeat(90));
console.log('live media playlist 結構量測');
console.log('='.repeat(90));
console.log(
  [
    'id',
    '名稱',
    'kind',
    'segs',
    'td',
    'endlist',
    'status',
  ].join('\t'),
);
for (const r of rows) {
  console.log(
    [
      r.id,
      r.name,
      r.kind,
      r.segs ?? '-',
      r.td ?? '-',
      r.endList === undefined ? '-' : r.endList,
      r.status,
      r.note ?? '',
    ].join('\t'),
  );
}

const media = rows.filter((r) => typeof r.segs === 'number');
const dist = {};
for (const r of media) dist[r.segs] = (dist[r.segs] || 0) + 1;
console.log('\n── segment 數分布 ──');
console.log(Object.entries(dist).sort((a, b) => Number(a[0]) - Number(b[0]))
  .map(([k, v]) => `${k} 個 → ${v} 個頻道`)
  .join('\n'));

const lt3 = media.filter((r) => r.segs < 3);
console.log(`\nsegment < 3 的頻道：${lt3.length} 個`);
for (const r of lt3) console.log(`  ! ${r.id} (${r.name}) segs=${r.segs} td=${r.td} ${r.note ?? ''}`);

const endListed = media.filter((r) => r.endList);
console.log(`\n帶 #EXT-X-ENDLIST（VOD，非 live）：${endListed.length} 個`);
for (const r of endListed) console.log(`  · ${r.id} (${r.name}) segs=${r.segs}`);
