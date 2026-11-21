#!/usr/bin/env node
/**
 * retest-production-failures.mjs — 對代理實測失敗的頻道做「間隔重測」
 *
 * ## 為什麼需要
 *
 * `verify-production-proxy.mjs` 會對 85 個頻道平行發請求，
 * 而其中 44 個頻道共用同一個上游 host（`121.19.134.149:808`）。
 * 平行打同一個 host 會觸發上游的**速率限制**（回 403），
 * 那是**量測工具造成的假失敗**，不是使用者真的看不了。
 *
 * 這個腳本把失敗的頻道**逐一、帶間隔**重測，
 * 才能分清楚「真的不能用」與「剛才被我自己打到限流」。
 *
 * 用法：node scripts/retest-production-failures.mjs [--gap 8]
 */
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const BASE = arg('base', 'https://taiwan-live-tv.netlify.app');
const GAP_MS = Number(arg('gap', '8')) * 1000;

const enc = (t) => Buffer.from(t, 'utf8').toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isManifest(t) {
  return t.trimStart().startsWith('#EXTM3U');
}

function pickSegment(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j] && !lines[j].startsWith('#')) return { child: new URL(lines[j], base).toString() };
      }
    }
  }
  const segs = lines.filter((l) => l && !l.startsWith('#'));
  return segs.length ? { seg: new URL(segs[segs.length - 1], base).toString() } : null;
}

async function testCandidate(u) {
  const mUrl = `${BASE}/api/proxy/${enc(u)}`;
  const mRes = await fetch(mUrl, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131.0' } });
  if (!mRes.ok) return { ok: false, stage: 'manifest', reason: (await mRes.text()).slice(0, 90) };
  const mText = await mRes.text();
  if (!isManifest(mText)) return { ok: false, stage: 'manifest', reason: '不是 manifest' };

  const pick = pickSegment(mText, mUrl);
  let segUrl = pick?.seg ?? null;
  if (pick?.child) {
    const cRes = await fetch(pick.child, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131.0' } });
    const cText = cRes.ok ? await cRes.text() : null;
    if (cText && isManifest(cText)) {
      const segs = cText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      if (segs.length) segUrl = new URL(segs[segs.length - 1], pick.child).toString();
    }
  }
  if (!segUrl) return { ok: false, stage: 'segment', reason: '找不到 segment' };

  const sRes = await fetch(segUrl, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131.0' } });
  if (!sRes.ok) return { ok: false, stage: 'segment', reason: (await sRes.text()).slice(0, 90) };
  const buf = Buffer.from(await sRes.arrayBuffer());
  if (buf.length < 1024) return { ok: false, stage: 'segment', reason: `過短 ${buf.length}B` };
  return { ok: true, bytes: buf.length };
}

async function main() {
  const ids = arg('ids', 'cn-cctv1,cn-cctv5plus,cn-cctv16,cn-cq,cn-sc,cn-dn,cn-ah').split(',');
  const cat = await (await fetch(`${BASE}/channels.json`)).json();

  console.log('═'.repeat(74));
  console.log('失敗頻道逐一重測（帶間隔，避免自己打到上游限流）');
  console.log('═'.repeat(74));

  for (const id of ids) {
    const ch = cat.channels.find((c) => c.channel_id === id);
    if (!ch) continue;
    const cands = [ch.stream_url, ...(ch.playlist_source?.backup_urls ?? []).map((b) => b.url)].filter(Boolean);
    let verdict = null;
    for (const u of cands) {
      const r = await testCandidate(u);
      if (r.ok) {
        verdict = { ok: true, bytes: r.bytes };
        break;
      }
      verdict = { ok: false, ...r };
      await sleep(GAP_MS * 1000);
    }
    console.log(
      `  ${verdict.ok ? '✓' : '✗'} ${ch.channel_name.padEnd(18)} ` +
        (verdict.ok ? `${(verdict.bytes / 1048576).toFixed(1)}MB` : `${verdict.stage}: ${verdict.reason}`),
    );
    await sleep(GAP_MS * 1000);
  }
}

main();
