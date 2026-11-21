#!/usr/bin/env node
/**
 * verify-production-proxy.mjs — 從**正式站代理**實測每個頻道能不能真的取到 segment
 *
 * ## 為什麼需要這支
 *
 * `verify-channel-sources.mjs` 是從**本機**直接抓上游，
 * 所以它量到的是「來源本身能不能播」。
 *
 * 但使用者實際看到的是**經過 Netlify edge 的代理**：
 *   本機 → 上游：快
 *   Netlify edge → 上游：慢（跨國路由）
 *
 * 代理為了避免回傳「被截斷的 segment」給 CDN 快取 5 分鐘，
 * 有一個上游速度檢查：預估下載時間超過門檻 → 直接回 502。
 *
 * 實測（2026-11-22）：央視-1／央視-7／央視-13／廣東衛視 從 edge 取 segment
 * 全部回 502「來源供應過慢」，但本機 deep probe 判為 ✓ 可播。
 *
 * 這個差異就是「巡檢結果」與「使用者實際體驗」的落差。
 *
 * 用法：node scripts/verify-production-proxy.mjs [--base https://...] [--conc 8]
 */
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const BASE = arg('base', 'https://taiwan-live-tv.netlify.app');
const CONC = Number(arg('conc', '8'));

const enc = (t) => Buffer.from(t, 'utf8').toString('base64url');

async function tryUrl(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131.0 Safari/537.36' },
      signal: AbortSignal.timeout(40_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, status: res.status, reason: body.slice(0, 110) };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) return { ok: false, status: res.status, reason: `segment 過短 ${buf.length}B` };
    return { ok: true, status: res.status, bytes: buf.length };
  } catch (e) {
    return { ok: false, status: 0, reason: String(e?.message ?? e).slice(0, 80) };
  }
}

/** 從代理的 manifest 找出一個 segment 網址 */
function pickSegment(manifestText, base) {
  const lines = manifestText.split(/\r?\n/).map((l) => l.trim());
  // master → 取第一個 child
  let child = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j] && !lines[j].startsWith('#')) {
          child = new URL(lines[j], base).toString();
          break;
        }
      }
      break;
    }
  }
  if (!child) {
    // 本來就是 media playlist
    const segs = lines.filter((l) => l && !l.startsWith('#'));
    return segs.length ? new URL(segs[segs.length - 1], base).toString() : null;
  }
  return { child };
}

/**
 * 判斷這段文字是 manifest 還是影片。
 *
 * ⚠️ manifest 本身只有幾百 bytes，**不能用大小判斷**。
 *    必須看開頭是不是 `#EXTM3U`。
 */
function isManifest(text) {
  return text.trimStart().startsWith('#EXTM3U');
}

async function main() {
  console.log('═'.repeat(80));
  console.log('正式站代理實測（從使用者真正走的那條路徑）');
  console.log('═'.repeat(80));
  console.log(`站點：${BASE}\n`);

  const cat = await (await fetch(`${BASE}/channels.json`)).json();
  const targets = cat.channels.filter((c) => c.stream_url && !c.embed_url);

  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < targets.length) {
      const ch = targets[idx];
      idx += 1;

      const candidates = [ch.stream_url, ...(ch.playlist_source?.backup_urls ?? []).map((b) => b.url)];
      let verdict = null;
      for (const c of candidates) {
        if (!c) continue;
        const mUrl = `${BASE}/api/proxy/${enc(c)}`;

        // ── 取 manifest ──
        let mText = null;
        let mStatus = 0;
        try {
          const mRes = await fetch(mUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131.0 Safari/537.36' },
            signal: AbortSignal.timeout(30_000),
          });
          mStatus = mRes.status;
          mText = await mRes.text();
        } catch (e) {
          verdict = { ok: false, role: 'manifest', reason: String(e?.message ?? e).slice(0, 80) };
          continue;
        }
        if (mStatus !== 200) {
          verdict = { ok: false, role: 'manifest', reason: mText.slice(0, 110) };
          continue;
        }
        if (!isManifest(mText)) {
          verdict = { ok: false, role: 'manifest', reason: `不是 manifest（${mText.length}B）` };
          continue;
        }

        // ── 找 segment ──
        const pick = pickSegment(mText, mUrl);
        let segUrl = null;
        if (typeof pick === 'string') segUrl = pick;
        else if (pick?.child) {
          const cRes = await fetch(pick.child, {
            headers: { 'User-Agent': 'Mozilla/5.0 Chrome/131.0 Safari/537.36' },
            signal: AbortSignal.timeout(30_000),
          });
          const cText = cRes.ok ? await cRes.text() : null;
          if (cText && isManifest(cText)) {
            const segs = cText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
            if (segs.length) segUrl = new URL(segs[segs.length - 1], pick.child).toString();
          }
        }
        if (!segUrl) {
          verdict = { ok: false, role: 'segment', reason: '找不到 segment' };
          continue;
        }

        const sRes = await tryUrl(segUrl);
        if (sRes.ok) {
          verdict = { ok: true, bytes: sRes.bytes, role: 'ok' };
          break;
        }
        verdict = { ok: false, role: 'segment', reason: sRes.reason };
      }

      results.push({
        id: ch.channel_id,
        name: ch.channel_name,
        ...verdict,
      });
      const mark = verdict.ok ? '✓' : '✗';
      console.log(
        `  ${mark} ${ch.channel_name.padEnd(20)} ` +
          (verdict.ok
            ? `${(verdict.bytes / 1048576).toFixed(1)}MB`
            : `${verdict.role}: ${verdict.reason}`),
      );
    }
  }

  await Promise.all(Array.from({ length: CONC }, worker));

  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  console.log('\n' + '═'.repeat(80));
  console.log(`代理可用：${ok.length}/${results.length}｜不可用：${bad.length}`);
  console.log('═'.repeat(80));
  if (bad.length) {
    console.log('\n不可用（從使用者路徑）：');
    for (const b of bad) console.log(`  ✗ ${b.name.padEnd(20)} ${b.role}: ${b.reason}`);
  }
  console.log('');
}

main();
