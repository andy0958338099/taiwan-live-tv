#!/usr/bin/env node
/**
 * verify-channel-sources.mjs — 驗證每個頻道的主來源與備援是否真的能播
 *
 * 為什麼需要這個：
 *   匯入腳本選主來源的依據是「manifest 可讀 + 有 CORS」，
 *   但實際上有三種問題會讓頻道在網頁版播不出來：
 *
 *   1. 主來源是 PHP 轉址頁或需要特定參數 → 回 404
 *   2. 上游速度太慢 → segment 下載超過 hls.js 逾時
 *   3. segment 太大（>5 MB）→ 代理緩衝時觸發 function 逾時
 *
 * 本腳本對每個候選網址做完整驗證（manifest → child → segment），
 * 並量測 segment 下載時間，讓後續能把「慢速來源」排到備援、
 * 把「壞掉的主來源」替換掉。
 *
 * 用法：node scripts/verify-channel-sources.mjs [--ids id1,id2] [--conc 8]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHANNELS_PATH = join(ROOT, 'shared', 'channels.json');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const IDS = arg('ids', '').split(',').filter(Boolean);
const CONC = parseInt(arg('conc', '8'), 10);

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

async function get(url, ms = 20000, extraHeaders = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, ...extraHeaders },
      redirect: 'follow',
      signal: c.signal,
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

/**
 * 完整驗證：manifest → child → segment
 * 回傳 { ok, cors, segBytes, segMs, kind, reason }
 */
async function verify(url) {
  let res;
  try {
    res = await get(url);
  } catch (e) {
    const reason =
      e.name === 'AbortError'
        ? '逾時'
        : e.cause?.code === 'ECONNRESET'
          ? '連線被重置'
          : e.name;
    return { ok: false, reason };
  }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };

  const cors = res.headers.get('access-control-allow-origin') !== null;
  let text;
  try {
    text = await res.text();
  } catch (e) {
    const reason =
      e.cause?.code === 'ECONNRESET' ? '連線被重置' : (e.name ?? '未知錯誤');
    return { ok: false, reason: `讀取失敗 (${reason})` };
  }

  // ⭐ **redirect 之後的網址才是相對路徑的基準**（2026-11-22 第 4 輪實測）
  //
  // 實測（央視台球 `http://107.150.60.122/live/ystq.m3u8`）：
  //   · 該網址 301 轉址到 `http://142.54.178.42:88/applive/ystq.m3u8?...`（**不同主機**）
  //   · manifest 裡的 segment 是**相對**路徑 `ystq/0455.ts`
  //   · 對「原網址」組 → `http://107.150.60.122/live/ystq/0455.ts` → **HTTP 404**
  //   · 對「redirect 後的網址」組 → `http://142.54.178.42:88/applive/ystq/0455.ts` → **HTTP 200**
  //
  // 用 `res.url`（fetch 跟完 redirect 後的最終網址）當基準，
  // 才與瀏覽器／代理的行為一致 —— 代理的 `rewriteManifest` 也是用
  // `new URL(raw, manifestUrl)` 且 manifestUrl = `upstream.url`（redirect 後）。
  const baseUrl = res.url || url;
  /** manifest 本身的長度（用來辨認「轉址入口」vs「真正的串流清單」） */
  const manifestBytes = Buffer.byteLength(text);
  if (!text.trimStart().startsWith('#EXTM3U')) {
    return { ok: false, reason: '非 m3u8' };
  }
  if (text.includes('#EXT-X-ENDLIST')) return { ok: false, reason: 'VOD' };

  const segs = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (segs.length === 0) return { ok: false, reason: '無 segment' };

  // child manifest？
  //
  // ⚠️ 直播清單的 segment 條目是**由舊到新**排列，而舊的 segment 會過期。
  // 實測（2026-11-21）Dali TV（官方來源）回 404：
  //   manifest 有 30 條 segment，`segs[0]`（331124.ts）→ **404**（過期）
  //   `segs[29]`（331153.ts）→ 200，4.8 MB，有效 MPEG-TS
  //
  // 所以驗證時必須**優先用最新的 segment**，並在失敗時往後往前回溯。
  // 只取 segs[0] 會把好頻道誤判成失效。
  const pickOrder = [...segs].reverse();

  // child manifest？
  let target = new URL(pickOrder[0], baseUrl).href;
  // targetduration / child 清單網址 —— 供「停播檢查」使用
  const manifestTdMatch = text.match(/^#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/m);
  const manifestTargetduration = manifestTdMatch ? Number(manifestTdMatch[1]) : null;
  let childTargetduration = null;
  let childPlaylistUrl = null;
  if (!/\.(ts|m4s|mp4|aac|cmfv|cmfa)(\?|$)/i.test(pickOrder[0])) {
    let cres;
    try {
      cres = await get(target);
    } catch (e) {
      const reason =
        e.name === 'AbortError'
          ? '逾時'
          : e.cause?.code === 'ECONNRESET'
            ? '連線被重置'
            : e.name;
      return { ok: false, reason: `child ${reason}` };
    }
    if (!cres.ok) return { ok: false, reason: `child HTTP ${cres.status}` };
    let ctext;
    try {
      ctext = await cres.text();
    } catch (e) {
      const reason =
        e.cause?.code === 'ECONNRESET' ? '連線被重置' : (e.name ?? '未知錯誤');
      return { ok: false, reason: `child 讀取失敗 (${reason})` };
    }
    if (ctext.includes('#EXT-X-ENDLIST')) return { ok: false, reason: 'child VOD' };
    const csegs = ctext
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (csegs.length === 0) return { ok: false, reason: 'child 無 segment' };
    // ⚠️ 必須**在 target 被改寫成 segment 網址之前**記下 child 清單網址
    //    （停播檢查要重新抓的是 child playlist，不是 segment）
    // ⚠️ 用 `cres.url`（redirect 後的最終網址）—— 見 baseUrl 的說明。
    childPlaylistUrl = cres.url || target;
    const childTdMatch = ctext.match(/^#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/m);
    childTargetduration = childTdMatch ? Number(childTdMatch[1]) : null;
    // child manifest 的 segment 同樣是由舊到新 → 取最新的
    // ⚠️ 基準也要用 redirect 後的網址（cres.url），理由同 baseUrl。
    const childBase = cres.url || target;
    target = new URL([...csegs].reverse()[0], childBase).href;
  }

  // segment 位元組 + 耗時
  //
  // ⚠️ 必須**逐一試**多個候選 segment，不能只試一個：
  //   · 最新的可能剛好在上游的更新空窗（404）
  //   · 舊的可能已過期（404）
  //   · 最新的可能下載中途被切斷（UND_ERR_SOCKET）
  // 實測 Dali TV：segs[0] 404、segs[29] 正常 → 只試一個會誤判整個頻道失效。
  const candidates = [
    target,
    ...pickOrder
      .slice(1, 4)
      .map((s) => new URL(s, baseUrl).href)
      .filter((u) => u !== target),
  ];

  let buf = null;
  let segMs = 0;
  let lastReason = '無 segment';

  for (const cand of candidates) {
    const t0 = Date.now();
    let sres;
    try {
      // ⭐ **只抓前 2KB**（2026-11-22 第 4 輪修正）
      //
      // 原本是「完整下載 segment」，30 秒逾時 → 判失敗。
      // 實測（天映 `120.198.95.220:9901`）：
      //   · 完整下載 → **30 秒 AbortError（逾時）** → 誤判「已停播」
      //   · `Range: bytes=0-2047` → 206、2048 bytes、首位 `0x47`（MPEG-TS）、**9 秒**
      //
      // 這也是 2026-11-22 固定驗證口徑的第 4 條
      //（「取第一個 segment，用 `Range: bytes=0-2047` 抓前 2KB」）。
      // 完整下載還會觸發代理的 `projected_ms` 保護（見 route.ts 的註解），
      // 造成「代理保護」被誤認為「來源失效」。
      sres = await get(cand, 30000, { Range: 'bytes=0-2047' });
    } catch (e) {
      const reason =
        e.name === 'AbortError'
          ? '逾時'
          : e.cause?.code === 'ECONNRESET'
            ? '連線被重置'
            : e.name;
      lastReason = `segment ${reason}`;
      continue;
    }
    segMs = Date.now() - t0;
    if (!sres.ok && sres.status !== 206) {
      lastReason = `segment HTTP ${sres.status}`;
      continue;
    }
    try {
      buf = Buffer.from(await sres.arrayBuffer());
    } catch (e) {
      // 下載中途連線被切斷（上游偶發）—— 換下一個候選
      const reason =
        e.cause?.code === 'ECONNRESET' ? '連線被重置' : (e.name ?? '未知錯誤');
      lastReason = `segment 讀取失敗 (${reason})`;
      buf = null;
      continue;
    }
    if (buf.length < 1024) {
      lastReason = `segment 過短 ${buf.length}B`;
      buf = null;
      continue;
    }
    break; // 拿到有效內容
  }

  if (!buf) return { ok: false, reason: lastReason };

  const isTs = buf[0] === 0x47;
  const isFmp4 =
    buf.length > 8 &&
    buf[4] === 0x66 &&
    buf[5] === 0x74 &&
    buf[6] === 0x79 &&
    buf[7] === 0x70;

  return {
    ok: true,
    cors,
    segBytes: buf.length,
    segMs,
    manifestBytes,
    kind: isTs ? 'mpegts' : isFmp4 ? 'fmp4' : 'unknown',
    // targetduration：停播檢查要用它決定「等多久再取一次序號」
    targetduration: childTargetduration ?? manifestTargetduration ?? null,
    // child 清單網址（停播檢查要重新取它）
    childUrl: childPlaylistUrl ?? null,
  };
}

/**
 * 檢查 live playlist 是否**真的在前進**（序號有沒有動）
 *
 * ## 為什麼需要這一步
 *
 * 純粹的「manifest → child → segment」驗證會對**停播來源**回報 ✓：
 *   · manifest 讀得到 ✅
 *   · 清單裡那幾段舊 segment 也還下載得到 ✅
 *   · 但序號早就定住了 → 其實根本沒在播
 *
 * 實測（2026-11-22）：龍華電視 / Now TV / 天映 / 浙江衛視 / 鳳凰衛視香港台
 * 都被舊的驗證判成「可播」，但序號 90 秒完全不動 —— 使用者只會看到
 * 畫面凍結在最後一格。
 *
 * ## 做法
 *
 * 取子清單兩次（間隔 = targetduration），比對 `#EXT-X-MEDIA-SEQUENCE`。
 * 序號不動 → 判定「已停播」。
 *
 * ⚠️ 只有在**第一次就取得 td** 時才做這個檢查（避免對沒有
 *    MEDIA-SEQUENCE 的來源誤判）。
 *
 * ## ⭐ 快取陷阱（2026-11-22 第 4 輪實測）
 *
 * 這個檢查有兩個會造成**假陽性**（把還在播的判成停播）的陷阱：
 *
 * 1. **子清單網址必須是 redirect 後的最終網址**。
 *    `verify()` 現在會把 `cres.url`（跟完 redirect）存進 `childUrl`。
 * 2. **CDN 對 media playlist 有 `max-age=5` 的短快取**。
 *    實測（海峽衛視 `10.fast.hidns.vip/163189/hxws/video/index.php`）：
 *    兩次取樣只隔 3 秒時讀到**同一份**快取（序號不動 → 誤判停播），
 *    隔 10.5 秒再取就會拿到新的（序號 15688400 → 15688402 → 前進）。
 *    → 取樣間隔必須**大於 CDN 的 max-age**，否則會誤判。
 *
 * @returns { Promise<{frozen: boolean, seq: number|null, detail: string}> }
 */
async function checkAdvancing(childUrl, td) {
  const first = await get(childUrl).then((r) => (r.ok ? r.text() : null)).catch(() => null);
  if (!first) return { frozen: false, seq: null, detail: '' };

  const m1 = first.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m);
  if (!m1) return { frozen: false, seq: null, detail: '' };
  const seq1 = Number(m1[1]);

  // 等一個 targetduration（hls.js 的 reload 間隔）再取一次
  await new Promise((r) => setTimeout(r, Math.min(td * 1000 + 1500, 20000)));

  const second = await get(childUrl).then((r) => (r.ok ? r.text() : null)).catch(() => null);
  if (!second) return { frozen: false, seq: seq1, detail: '' };

  const m2 = second.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m);
  if (!m2) return { frozen: false, seq: seq1, detail: '' };
  const seq2 = Number(m2[1]);

  if (seq2 === seq1) {
    // ⚠️ 序號相同可能是「CDN 快取同一份清單」，不一定是停播。
    // 再等一段時間（> CDN 的 max-age）取第三次確認。
    await new Promise((r) => setTimeout(r, 8000));
    const third = await get(childUrl).then((r) => (r.ok ? r.text() : null)).catch(() => null);
    const m3 = third?.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m);
    if (m3 && Number(m3[1]) !== seq1) {
      return { frozen: false, seq: Number(m3[1]), detail: '' };
    }
    return { frozen: true, seq: seq1, detail: `序號停在 ${seq1}（已停播）` };
  }
  return { frozen: false, seq: seq2, detail: '' };
}

async function main() {
  const catalog = JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'));
  let targets = catalog.channels;

  /**
   * embed 類型的頻道要排除。
   *
   * 它們的 stream_url 是空字串（實際播放走官方 iframe 播放器），
   * 用 stream_url 驗證只會得到「主來源 無」，屬於誤判。
   * 官方 embed 頻道的可用性改由 scripts/test-playback-local.mjs 實測。
   */
  const embedChannels = targets.filter((c) => c.embed_url);
  targets = targets.filter((c) => !c.embed_url);

  if (IDS.length) targets = targets.filter((c) => IDS.includes(c.channel_id));

  console.log('═'.repeat(78));
  console.log('頻道來源驗證（manifest → child → segment，含耗時）');
  console.log('═'.repeat(78));
  console.log(`檢查 ${targets.length} 個頻道`);
  if (embedChannels.length) {
    console.log(
      `（另排除 ${embedChannels.length} 個官方 embed 頻道 —— ` +
        `它們以 iframe 播放，無法用 stream_url 驗證）`,
    );
  }
  console.log('');

  const results = [];

  // ── 並行驗證所有頻道 ──
  // 逐一個驗證太慢（83 個頻道 × 每個數十秒）。
  // 每個頻道彼此獨立，所以並行處理；單一頻道內部仍依序試主來源與備援。
  const CONC = 8;
  let doneCount = 0;

  async function verifyChannel(ch) {
    const candidates = [
      { url: ch.stream_url, role: 'primary' },
      ...(ch.playlist_source?.backup_urls ?? []).map((b) => ({
        url: b.url,
        role: 'backup',
      })),
    ];

    const found = [];
    for (const cand of candidates) {
      if (!cand.url) continue;
      let r = await verify(cand.url);

      // 逾時／網路錯誤可能是上游偶發壅塞，而不是真的失效。
      // 對「逾時」與 AbortError 重試一次，避免誤殺可用頻道。
      //
      // ⚠️ 2026-11-21 修正：原本只重試「逾時／AbortError」，
      // 但**下載中途連線被切斷**（ECONNRESET / UND_ERR_SOCKET / TypeError）
      // 同樣是上游偶發狀況 —— 實測四川衛視（121.19.134.149:808）會出現
      // `TypeError terminated UND_ERR_SOCKET`，重試後立刻就成功。
      // 不重試 → 該頻道被誤判為失效（✗），而且會被 `needs_swap` 建議換源。
      if (!r.ok && /逾時|AbortError|讀取失敗|連線被重置|TypeError/.test(r.reason)) {
        await new Promise((res) => setTimeout(res, 1500));
        const retry = await verify(cand.url);
        if (retry.ok) r = retry;
      }

      // 注意：r 裡有 kind（媒體格式），cand 裡有 role（來源角色），
      // 兩者不可共用同一個欄位名 —— 否則 role 會被 kind 蓋掉，
      // 導致 needs_swap 判斷錯誤。
      found.push({ ...cand, ...r });
      if (r.ok) break; // 找到可用的就停
    }

    const primary = found[0];
    const working = found.find((f) => f.ok);

    // ── 停播檢查 ──
    //
    // ⚠️ **必須在「可播」判定之後再做**，而且只對**通過驗證**的來源做。
    //
    // 停播來源的特徵是「manifest 讀得到、舊 segment 也下載得到」，
    // 所以前面的驗證會回報 ✓ —— 但它其實沒有在播。
    //
    // 這裡對**每個通過驗證的候選**檢查序號是否前進；
    // 只要有**任何一個**候選還在播，這個頻道就是可用的。
    let frozenDetail = '';
    let allFrozen = false;
    if (working) {
      const advancing = [];
      for (const cand of found.filter((f) => f.ok)) {
        // ⚠️ 必須檢查 **media playlist**（child），不是 master manifest
        //    —— master manifest 沒有 MEDIA-SEQUENCE，而且內容本來就不常變。
        //    沒有 child 的（本身就是 media playlist）就用它自己。
        const playlistUrl = cand.childUrl ?? cand.url;
        const adv = await checkAdvancing(playlistUrl, cand.targetduration ?? 6);
        if (!adv.frozen) advancing.push(cand);
        else frozenDetail = adv.detail;
      }
      if (advancing.length === 0) {
        allFrozen = true;
      }
    }

    const status = working && !allFrozen ? '✓' : '✗';
    const detail =
      working && !allFrozen
        ? `${working.kind} ${(working.segBytes / 1048576).toFixed(1)}MB ` +
          `${(working.segMs / 1000).toFixed(1)}s ${working.cors ? 'CORS' : '需代理'}`
        : allFrozen
          ? `已停播：${frozenDetail}`
          : `主來源 ${primary?.reason ?? '無'}`;

    console.log(
      `  ${status} ${ch.channel_name.padEnd(18)} ` +
        `${working && working.role === 'backup' && !allFrozen ? '備援可用 ' : ''}${detail}`,
    );

    doneCount++;
    return {
      channel_id: ch.channel_id,
      channel_name: ch.channel_name,
      primary_url: ch.stream_url,
      primary_ok: primary?.ok ?? false,
      primary_reason: primary?.reason ?? null,
      primary_cors: primary?.cors ?? null,
      working_url: working?.url ?? null,
      working_role: working?.role ?? null,
      working_kind: working?.kind ?? null,
      working_ms: working?.segMs ?? null,
      working_bytes: working?.segBytes ?? null,
      working_manifest_bytes: working?.manifestBytes ?? null,
      needs_swap: !!(working && working.role === 'backup'),
      // 停播狀態：manifest 讀得到但序號不動 → 其實沒在播
      frozen: allFrozen,
      frozen_detail: allFrozen ? frozenDetail : null,
    };
  }

  const queue = [...targets];
  async function worker() {
    while (queue.length) {
      const ch = queue.shift();
      let r;
      try {
        r = await verifyChannel(ch);
      } catch (e) {
        // 單一頻道的意外錯誤不能讓整批驗證中斷
        r = {
          channel_id: ch.channel_id,
          channel_name: ch.channel_name,
          primary_url: ch.stream_url,
          primary_ok: false,
          primary_reason: `例外：${e.name ?? '未知'}`,
          working_url: null,
          working_role: null,
          working_kind: null,
          working_ms: null,
          working_bytes: null,
          needs_swap: false,
        };
      }
      results.push(r);
      if (doneCount % 5 === 0) {
        process.stdout.write(`  驗證中 ${doneCount}/${targets.length}\r`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  process.stdout.write(' '.repeat(40) + '\r');

  // 依原始順序排列，輸出較好閱讀
  const order = new Map(targets.map((c, i) => [c.channel_id, i]));
  results.sort((a, b) => (order.get(a.channel_id) ?? 0) - (order.get(b.channel_id) ?? 0));

  const ok = results.filter((r) => r.working_url && !r.frozen).length;
  const needSwap = results.filter((r) => r.needs_swap).length;
  const dead = results.filter((r) => !r.working_url);
  // 停播：manifest 讀得到、segment 也下載得到，但序號不動 → 沒在播
  const frozen = results.filter((r) => r.frozen);

  console.log('');
  console.log('═'.repeat(78));
  console.log(
    `可播 ${ok}/${results.length}｜需改用備援 ${needSwap}｜完全失效 ${dead.length}｜已停播 ${frozen.length}`,
  );
  if (dead.length) {
    console.log('\n完全失效：');
    for (const d of dead) console.log(`  ✗ ${d.channel_name} — ${d.primary_reason}`);
  }
  if (frozen.length) {
    console.log('\n已停播（清單讀得到但序號不動 —— 使用者只會看到畫面凍結）：');
    for (const f of frozen) {
      console.log(`  ✗ ${f.channel_name} — ${f.frozen_detail ?? '序號未前進'}`);
    }
  }
  if (needSwap) {
    console.log('\n主來源壞掉但備援可用（建議置換）：');
    for (const s of results.filter((r) => r.needs_swap)) {
      console.log(`  ! ${s.channel_name}`);
      console.log(`      舊: ${s.primary_url.slice(0, 78)}`);
      console.log(`      新: ${s.working_url.slice(0, 78)}`);
    }
  }
  console.log('═'.repeat(78));

  writeFileSync(
    join(ROOT, 'shared', 'source-verification.json'),
    JSON.stringify(
      { verified_at: new Date().toISOString(), results },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  console.log('\n已寫入 shared/source-verification.json');
}

main();
