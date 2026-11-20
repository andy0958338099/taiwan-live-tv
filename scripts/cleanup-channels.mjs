#!/usr/bin/env node
/**
 * cleanup-channels.mjs — 依驗證結果清理頻道清單
 *
 * 輸入：shared/source-verification.json
 *   （由 scripts/verify-channel-sources.mjs 產生，
 *     對每個頻道的主來源與備援做完整 manifest → child → segment 驗證）
 *
 * 處理：
 *   1. **完全失效**（主來源與所有備援都失敗）→ 二次確認後移除
 *   2. **主來源失效但備援可用** → 把可用的備援升為主來源
 *   3. 更新 last_checked
 *
 * ⚠️ 二次確認是必要的：
 *   驗證當下上游可能偶發壅塞（segment 逾時），
 *   一次失敗不足以判定頻道死亡。
 *   實測廣東體育台在清理時被誤殺，事後重測 3 次來源全部正常。
 *   所以「看起來失效」的頻道會再驗一次，兩次都失敗才移除。
 *
 * 用法：node scripts/cleanup-channels.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHANNELS_PATH = join(ROOT, 'shared', 'channels.json');
const VERIFY_PATH = join(ROOT, 'shared', 'source-verification.json');

const DRY_RUN = process.argv.includes('--dry-run');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

async function get(url, ms = 25000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: c.signal,
      redirect: 'follow',
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

/**
 * 快速驗證：manifest → child → segment。
 * 只用於二次確認，邏輯與 verify-channel-sources.mjs 相同但更精簡。
 */
async function verifyOnce(url) {
  let res;
  try {
    res = await get(url);
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? '逾時' : e.name };
  }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };

  const text = await res.text();
  if (!text.trimStart().startsWith('#EXTM3U')) {
    return { ok: false, reason: '非 m3u8' };
  }
  if (text.includes('#EXT-X-ENDLIST')) return { ok: false, reason: 'VOD' };

  const segs = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (segs.length === 0) return { ok: false, reason: '無 segment' };

  let target = new URL(segs[0], url).href;
  if (!/\.(ts|m4s|mp4|aac|cmfv|cmfa)(\?|$)/i.test(segs[0])) {
    let cres;
    try {
      cres = await get(target);
    } catch (e) {
      return { ok: false, reason: `child ${e.name}` };
    }
    if (!cres.ok) return { ok: false, reason: `child HTTP ${cres.status}` };
    const ctext = await cres.text();
    if (ctext.includes('#EXT-X-ENDLIST')) return { ok: false, reason: 'child VOD' };
    const csegs = ctext
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (csegs.length === 0) return { ok: false, reason: 'child 無 segment' };
    target = new URL(csegs[0], target).href;
  }

  let sres;
  try {
    sres = await get(target, 40000);
  } catch (e) {
    return { ok: false, reason: `segment ${e.name === 'AbortError' ? '逾時' : e.name}` };
  }
  if (!sres.ok) return { ok: false, reason: `segment HTTP ${sres.status}` };

  const buf = Buffer.from(await sres.arrayBuffer());
  if (buf.length < 1024) return { ok: false, reason: `segment 過短 ${buf.length}B` };
  return { ok: true };
}

async function main() {
  console.log('═'.repeat(70));
  console.log('依驗證結果清理頻道清單');
  console.log('═'.repeat(70));

  if (!existsSync(VERIFY_PATH)) {
    console.error('✗ 找不到 shared/source-verification.json');
    console.error('  請先執行：node scripts/verify-channel-sources.mjs');
    process.exit(1);
  }

  const verify = JSON.parse(readFileSync(VERIFY_PATH, 'utf8'));
  const catalog = JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'));

  console.log(`驗證時間：${verify.verified_at}`);
  console.log(`驗證頻道數：${verify.results.length}\n`);

  const byId = new Map(verify.results.map((r) => [r.channel_id, r]));
  const now = new Date().toISOString();

  const removed = [];
  const promoted = [];
  const kept = [];
  /** 待二次確認的頻道 */
  const pendingRemoval = [];

  for (const ch of catalog.channels) {
    const v = byId.get(ch.channel_id);

    // 沒被驗證到的頻道 → 保留
    if (!v) {
      kept.push(ch);
      continue;
    }

    // ⚠️ **embed 類型的頻道不能用 stream_url 驗證** ——
    // 它們的 stream_url 是空字串，實際播放走的是官方 iframe 播放器。
    // 驗證腳本對它們只會得到「主來源 無」，若照樣判成失效就會誤刪。
    // 官方 embed 頻道的可用性要在瀏覽器裡實測（scripts/test-playback-local.mjs），
    // 不在這裡處理。
    if (ch.embed_url) {
      kept.push(ch);
      continue;
    }

    // 完全失效 → 列入待二次確認
    if (!v.working_url) {
      pendingRemoval.push({ ch, reason: v.primary_reason });
      continue;
    }

    // 主來源失效但備援可用 → 升級
    if (v.needs_swap) {
      const oldPrimary = ch.stream_url;
      ch.stream_url = v.working_url;

      const backups = ch.playlist_source?.backup_urls ?? [];
      ch.playlist_source = {
        ...(ch.playlist_source ?? {}),
        backup_urls: [
          ...backups.filter((b) => b.url !== v.working_url),
          ...(oldPrimary !== v.working_url
            ? [{ url: oldPrimary, source: '原主來源（已失效）', cors: false }]
            : []),
        ],
      };

      promoted.push({
        name: ch.channel_name,
        old: oldPrimary,
        new: v.working_url,
      });
    }

    ch.last_checked = now;
    kept.push(ch);
  }

  // ── 二次確認 ──
  if (pendingRemoval.length) {
    console.log(
      `二次確認 ${pendingRemoval.length} 個看起來失效的頻道（避免誤殺）…`,
    );
    const queue = [...pendingRemoval];
    const confirmed = [];

    async function worker() {
      while (queue.length) {
        const item = queue.shift();
        const urls = [
          item.ch.stream_url,
          ...(item.ch.playlist_source?.backup_urls ?? []).map((b) => b.url),
        ].filter(Boolean);

        let recovered = null;
        for (const u of urls) {
          const r = await verifyOnce(u);
          if (r.ok) {
            recovered = { url: u, ...r };
            break;
          }
        }
        confirmed.push({ ...item, recovered });
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker));

    for (const item of confirmed) {
      if (item.recovered) {
        // 二次確認通過 → 保留，並把可用的網址升為主來源
        console.log(
          `  ↻ ${item.ch.channel_name} — 二次確認可播，保留` +
            `（改用 ${item.recovered.url.slice(0, 60)}）`,
        );
        const oldPrimary = item.ch.stream_url;
        item.ch.stream_url = item.recovered.url;
        if (oldPrimary !== item.recovered.url) {
          const backups = item.ch.playlist_source?.backup_urls ?? [];
          item.ch.playlist_source = {
            ...(item.ch.playlist_source ?? {}),
            backup_urls: [
              ...backups.filter((b) => b.url !== item.recovered.url),
              ...(oldPrimary !== item.recovered.url
                ? [{ url: oldPrimary, source: '原主來源（驗證時逾時）', cors: false }]
                : []),
            ],
          };
        }
        item.ch.last_checked = now;
        kept.push(item.ch);
      } else {
        console.log(
          `  ✗ ${item.ch.channel_name} — 二次確認仍失敗，移除（${item.reason}）`,
        );
        removed.push({
          name: item.ch.channel_name,
          id: item.ch.channel_id,
          reason: item.reason,
        });
      }
    }
  }

  // 依原本順序組回來
  const keptIds = new Set(kept.map((c) => c.channel_id));
  catalog.channels = catalog.channels.filter((c) => keptIds.has(c.channel_id));

  console.log('');
  console.log(
    `移除 ${removed.length} 個｜升級備援 ${promoted.length} 個｜保留 ${kept.length} 個`,
  );
  console.log(`頻道總數：${catalog.channels.length}`);

  if (removed.length) {
    console.log('\n移除（兩次驗證皆失敗）：');
    for (const r of removed) {
      console.log(`  ✗ ${r.name} (${r.id}) — ${r.reason}`);
    }
  }

  if (promoted.length) {
    console.log('\n升級為可用備援：');
    for (const p of promoted) {
      console.log(`  ↻ ${p.name}`);
      console.log(`      舊: ${p.old.slice(0, 76)}`);
      console.log(`      新: ${p.new.slice(0, 76)}`);
    }
  }

  if (DRY_RUN) {
    console.log('\n(dry-run 模式，未寫入檔案)');
    return;
  }

  catalog.updated_at = now;
  writeFileSync(CHANNELS_PATH, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  console.log(`\n已寫入 ${CHANNELS_PATH}`);
  console.log('\n下一步：node scripts/validate-channels.mjs && node scripts/sync-channels.mjs');
}

await main();
