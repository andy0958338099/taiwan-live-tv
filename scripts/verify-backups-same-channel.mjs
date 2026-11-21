#!/usr/bin/env node
/**
 * 驗證：每個頻道的每個備援，實際抓 manifest 確認指向同一個頻道。
 *
 * 這是防止「備援指向別的頻道」的**回歸測試**。
 * 可以納入 CI / 巡檢 cron。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'shared', 'channels.json');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const catalog = JSON.parse(readFileSync(SRC, 'utf8'));

function codeOf(url) {
  if (!url) return null;
  const clean = url.split('?')[0].split('#')[0].replace(/\/+$/, '');
  const seg = clean.split('/').pop() ?? '';
  return /^[a-z0-9]{3,12}$/i.test(seg) ? seg.toLowerCase() : null;
}

function isDirectChannelPath(url) {
  const clean = url.split('?')[0].split('#')[0].replace(/\/+$/, '');
  const segs = clean.split('/');
  return segs.length >= 2 && /^\d+$/.test(segs[segs.length - 2]);
}

/** 抓 manifest → 追到 segment → 取碼 */
async function resolveCode(url) {
  const code = codeOf(url);
  if (code && isDirectChannelPath(url)) return code;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { code, ok: false, status: res.status };
    const text = await res.text();
    if (!text.trimStart().startsWith('#EXTM3U')) return { code, ok: false };
    const first = text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'));
    if (!first) return { code, ok: false };
    if (!/\.(ts|m4s|mp4|aac)(\?|$)/i.test(first)) {
      const sub = await fetch(first, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(15000),
      });
      if (!sub.ok) return { code, ok: false, status: sub.status };
      const subText = await sub.text();
      const subFirst = subText
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#'));
      return { code: codeOf(subFirst) ?? code, ok: true };
    }
    return { code: codeOf(first) ?? code, ok: true };
  } catch (e) {
    return { code, ok: false, error: e.cause?.code ?? e.message };
  }
}

console.log('════ 備援來源同頻道驗證 ════\n');

let total = 0;
let mismatched = 0;
let unreachable = 0;
const issues = [];

for (const ch of catalog.channels) {
  const backups = ch.playlist_source?.backup_urls ?? [];
  if (!backups.length) continue;

  const mainCode = codeOf(ch.stream_url);
  for (const b of backups) {
    total++;
    const r = await resolveCode(b.url);
    if (!r.ok) {
      unreachable++;
      continue;
    }
    if (r.code && mainCode && r.code !== mainCode) {
      mismatched++;
      issues.push({ channel: ch.channel_name, mainCode, backupCode: r.code, url: b.url });
      console.log(
        `  ✗ ${ch.channel_name.padEnd(20)} 主 ${mainCode} → 備援 ${r.code}  ${b.url.slice(0, 60)}`,
      );
    }
  }
}

console.log(`\n  檢查備援 ${total} 個`);
console.log(`  ✗ 指向別的頻道：${mismatched}`);
console.log(`  ○ 無法連線驗證（來源離線）：${unreachable}`);

if (mismatched === 0) {
  console.log('\n  ✅ 全部備援都指向同一個頻道');
} else {
  console.log('\n  ⚠️  需要移除錯配的備援');
}
