#!/usr/bin/env node
/**
 * 傾印 M3U 清單中會被 `matchChannel` 命中的條目，
 * 讓頻道配對的行為可以對照**真實資料**檢查。
 *
 * 用法：node scripts/dump-m3u-matches.mjs <url> [關鍵字過濾]
 */
import { readFileSync } from 'node:fs';
import { matchChannel, cleanName } from './lib/channel-match.mjs';

const SRC = 'shared/sources.json';
const cfg = JSON.parse(readFileSync(SRC, 'utf8'));
const rules = cfg.import_rules;

const url = process.argv[2];
const filter = process.argv[3] ?? '';

if (!url) {
  console.error('用法：node scripts/dump-m3u-matches.mjs <url> [關鍵字]');
  process.exit(1);
}

const res = await fetch(url, {
  headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
  signal: AbortSignal.timeout(60000),
});
const text = await res.text();

// 解析（沿用 import-playlists.mjs 的邏輯）
const entries = [];
let pending = null;
for (const rawLine of text.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line) continue;
  if (line.startsWith('#EXTINF')) {
    const attrs = {};
    const attrRe = /([A-Za-z0-9_-]+)="([^"]*)"/g;
    let m;
    while ((m = attrRe.exec(line))) attrs[m[1]] = m[2];
    const name = line.slice(line.lastIndexOf(',') + 1).trim();
    pending = { name, group: attrs['group-title'] || '', logo: attrs['tvg-logo'] || '' };
  } else if (line.startsWith('#')) {
    continue;
  } else if (pending) {
    entries.push({ ...pending, url: line });
    pending = null;
  }
}

console.log(`  來源：${url}`);
console.log(`  條目：${entries.length}\n`);

const groups = new Map();
for (const e of entries) {
  const m = matchChannel(e, rules);
  if (!m) continue;
  if (filter && !e.name.includes(filter) && !m.name.includes(filter)) continue;
  if (!groups.has(m.id)) groups.set(m.id, []);
  groups.get(m.id).push(e);
}

for (const [id, list] of groups) {
  console.log(`  ▸ ${id} → ${rules.channel_map[id].name}  (${list.length} 筆)`);
  for (const e of list) {
    console.log(`      ${e.name.padEnd(30)} ${e.url.slice(0, 58)}`);
  }
}
