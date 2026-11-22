#!/usr/bin/env node
/**
 * audit-strict-sources.mjs — 獨立於 verify-channel-sources.mjs 的嚴格來源稽核
 *
 * 為什麼要另外寫一個：
 *   專案既有的 deep probe 對「manifest → child → segment」判定較寬鬆，
 *   2026-11-22 曾因此把 ChiSheng9/iptv 的 YouTube 假源判成可播，
 *   線上播放器直接 hls.js levelParsingError。
 *
 * 本腳本嚴格套用「驗證口徑」：
 *   1. manifest 必須以 `#EXTM3U` 開頭，且不含 `#EXT-X-ENDLIST`
 *   2. 子清單最多再遞迴 2 層
 *   3. 取 segment，用 Range: bytes=0-2047 抓前 2KB
 *   4. 位元組嗅探：首位 0x47 = MPEG-TS、ftyp/styp/moof/mdat = fMP4 → 通過
 *      開頭 `<` = HTML、FF D8 = JPEG、89 50 = PNG → 失效
 *   5. URL 含 youtube.com / youtu.be → 失效（不是 HLS 源）
 *   6. 停播檢查：MEDIA-SEQUENCE 必須會前進
 *
 * ⚠️ **分派依據是「實際內容」而不是副檔名**。
 *    實測（2026-11-22）：`8.fast.hidns.vip/163189/lhjd` 的 segment 網址是
 *    `/api?h=lhjd&u=<token>` —— 沒有 .ts 副檔名。若用副檔名判斷「是清單還是
 *    segment」，會把它當成第三層子清單而誤判整個頻道失效。
 *    正確做法：抓下來看開頭是不是 #EXTM3U。
 *
 * 用法：
 *   node scripts/audit-strict-sources.mjs                      # 全部 HLS 頻道
 *   node scripts/audit-strict-sources.mjs --sample 20          # 隨機抽 20 個頻道
 *   node scripts/audit-strict-sources.mjs --ids a,b,c          # 指定 channel_id
 *   node scripts/audit-strict-sources.mjs --urls u1,u2         # 直接給網址
 *   node scripts/audit-strict-sources.mjs --no-seq              # 略過停播檢查（較快）
 *   node scripts/audit-strict-sources.mjs --json out.json      # 輸出 JSON
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHANNELS_PATH = join(ROOT, 'shared', 'channels.json');

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);

const SAMPLE = parseInt(arg('sample', '0'), 10);
const IDS = (arg('ids', '') || '').split(',').filter(Boolean);
const RAW_URLS = (arg('urls', '') || '').split(',').filter(Boolean);
const SKIP_SEQ = flag('no-seq');
const JSON_OUT = arg('json', null);
const CONC = parseInt(arg('conc', '6'), 10);

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const get = (url, ms = 20000, extraHeaders = {}) =>
  fetch(url, {
    headers: { 'User-Agent': UA, ...extraHeaders },
    redirect: 'follow',
    signal: AbortSignal.timeout(ms),
  });

const isYoutube = (u) => /(^|\/\/)(www\.)?(youtube\.com|youtu\.be)/i.test(u);

/** 位元組嗅探：回 { kind, note } */
function sniff(buf) {
  if (!buf || buf.length === 0) return { kind: 'empty', note: '無內容' };
  const b = buf;
  if (b[0] === 0x47) return { kind: 'mpegts', note: '首位 0x47 MPEG-TS' };
  if (b[0] === 0x3c) {
    const head = b.subarray(0, 80).toString('latin1').replace(/\s+/g, ' ');
    return { kind: 'html', note: `開頭 "<" HTML: ${head.slice(0, 60)}` };
  }
  if (b[0] === 0xff && b[1] === 0xd8) return { kind: 'jpeg', note: 'FF D8 JPEG' };
  if (b[0] === 0x89 && b[1] === 0x50) return { kind: 'png', note: '89 50 PNG' };
  if (b.length > 8) {
    const box = b.subarray(4, 8).toString('latin1');
    if (['ftyp', 'styp', 'moof', 'mdat'].includes(box)) {
      return { kind: 'fmp4', note: `box ${box}` };
    }
  }
  const probe = b.subarray(0, 64).toString('latin1');
  if (probe.includes('ftyp') || probe.includes('moof') || probe.includes('mdat')) {
    return { kind: 'fmp4', note: '內含 ftyp/moof/mdat' };
  }
  return {
    kind: 'unknown',
    note: `首位 ${b[0].toString(16).padStart(2, '0')} 未知格式`,
  };
}

const parseLines = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

const seqOf = (text) => {
  const m = text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m);
  return m ? Number(m[1]) : null;
};

/**
 * 驗證單一 URL（依「實際內容」分派層級）。
 */
async function audit(url, { seqCheck = true } = {}) {
  if (!url) return { ok: false, reason: '無網址', url };
  if (isYoutube(url)) {
    return { ok: false, reason: 'YouTube 頁面（非 HLS 源）', url };
  }

  // ── 層 0：必須是 manifest ──
  let res;
  try {
    res = await get(url);
  } catch (e) {
    return { ok: false, reason: `請求失敗：${e.name ?? e.message}`, url };
  }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, url };

  let text = await res.text();
  if (!text.trimStart().startsWith('#EXTM3U')) {
    const head = text.trimStart().slice(0, 60).replace(/\s+/g, ' ');
    return { ok: false, reason: `非 m3u8（開頭「${head}」）`, url };
  }
  if (text.includes('#EXT-X-ENDLIST')) {
    return { ok: false, reason: 'VOD（含 #EXT-X-ENDLIST）', url };
  }

  // media playlist = 最深那一層（用來做停播檢查）
  let mediaUrl = url;
  let mediaText = text;
  let seq = seqOf(text);
  // ⚠️ `currentText` 是「目前這一層的清單內容」——往下走時必須更新它，
  //    否則每一層都在重複解析最上層的清單，會無限遞迴到上限。
  let currentText = text;

  // ── 往下最多再遞迴 2 層 ──
  for (let depth = 0; depth < 2; depth++) {
    const lines = parseLines(currentText);
    if (!lines.length) {
      return { ok: false, reason: `第 ${depth} 層無 segment`, url };
    }
    // 取最後幾個候選（最新的 segment 較可能還活著）
    const candidates = [
      lines[0],
      ...[...lines].reverse().filter((l) => l !== lines[0]).slice(0, 3),
    ];

    let descended = false;
    let lastReason = '無 segment';

    for (const cand of candidates) {
      const candUrl = new URL(cand, mediaUrl).href;
      let cres;
      const t0 = Date.now();
      try {
        // 口徑要求用 Range 抓前 2KB —— 這樣既省頻寬又能立刻分辨
        // 「這是清單還是 segment」（看開頭是不是 #EXTM3U）。
        cres = await get(candUrl, 20000, { Range: 'bytes=0-2047' });
      } catch (e) {
        lastReason = `第 ${depth + 1} 層請求失敗：${e.name ?? e.message}`;
        continue;
      }
      const ms = Date.now() - t0;
      if (!cres.ok && cres.status !== 206) {
        lastReason = `第 ${depth + 1} 層 HTTP ${cres.status}`;
        continue;
      }
      const buf = Buffer.from(await cres.arrayBuffer());

      // ⚠️ 以「內容」判斷這是子清單還是 segment
      if (buf.subarray(0, 7).toString('latin1') === '#EXTM3U') {
        let ctext = buf.toString('utf8');
        // Range 回 206 代表內容被截斷 → 清單必須抓完整版
        if (cres.status === 206) {
          try {
            const full = await get(candUrl);
            if (full.ok) ctext = await full.text();
          } catch {
            /* 拿不到完整版就用截斷的 */
          }
        }
        if (ctext.includes('#EXT-X-ENDLIST')) {
          return { ok: false, reason: `第 ${depth + 1} 層 VOD`, url };
        }
        if (!parseLines(ctext).length) {
          return { ok: false, reason: `第 ${depth + 1} 層無 segment`, url };
        }
        // 這是 media playlist → 記錄下來（停播檢查用），再往下走一層
        mediaUrl = candUrl;
        mediaText = ctext;
        currentText = ctext;
        seq = seqOf(ctext) ?? seq;
        descended = true;
        break;
      }

      // 這是 segment → 位元組嗅探
      if (buf.length < 64) {
        lastReason = `segment 過短 ${buf.length}B`;
        continue;
      }
      const s = sniff(buf);
      if (s.kind !== 'mpegts' && s.kind !== 'fmp4') {
        return { ok: false, reason: `位元組不符：${s.note}`, url };
      }

      let out = {
        ok: true,
        reason: '',
        kind: s.kind,
        note: s.note,
        ms,
        bytes: buf.length,
        status: cres.status,
        seq,
        mediaPlaylistUrl: mediaUrl,
        url,
      };

      // ── 停播檢查：序號必須會前進 ──
      if (seqCheck && seq !== null) {
        const tdM = mediaText.match(/^#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/m);
        const td = tdM ? Number(tdM[1]) : 6;
        await new Promise((r) => setTimeout(r, Math.min(td * 1000 + 1500, 20000)));
        try {
          const again = await get(mediaUrl);
          const t2 = again.ok ? await again.text() : '';
          const s2 = seqOf(t2);
          if (s2 !== null && s2 === seq) {
            out.ok = false;
            out.reason = `已停播（序號停在 ${seq}）`;
            out.seqFrozen = true;
          } else if (s2 !== null) {
            out.seq = s2;
          }
        } catch {
          /* 第二次抓不到不判停播（保守） */
        }
      }
      return out;
    }

    if (!descended) {
      return { ok: false, reason: lastReason, url };
    }
  }

  return { ok: false, reason: '超過最大遞迴層數', url };
}

async function main() {
  let jobs = [];

  if (RAW_URLS.length) {
    jobs = RAW_URLS.map((u) => ({ name: u, url: u, role: 'raw' }));
  } else {
    const catalog = JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'));
    let targets = catalog.channels.filter((c) => !c.embed_url);
    if (IDS.length) targets = targets.filter((c) => IDS.includes(c.channel_id));

    for (const ch of targets) {
      jobs.push({ name: ch.channel_name, url: ch.stream_url, role: 'primary', ch });
      for (const b of ch.playlist_source?.backup_urls ?? []) {
        jobs.push({
          name: ch.channel_name,
          url: b.url,
          role: 'backup',
          ch,
          backupSource: b.source ?? null,
        });
      }
    }

    if (SAMPLE > 0 && SAMPLE < jobs.length) {
      // 以「頻道」為單位抽樣（每個頻道取一個候選），避免同頻道洗版
      const byCh = new Map();
      for (const j of jobs) {
        const k = j.ch?.channel_id ?? j.url;
        if (!byCh.has(k)) byCh.set(k, []);
        byCh.get(k).push(j);
      }
      const groups = [...byCh.values()];
      const picked = [];
      const pool = [...groups];
      while (picked.length < SAMPLE && pool.length) {
        const i = Math.floor(Math.random() * pool.length);
        picked.push(pool.splice(i, 1)[0][0]);
      }
      jobs = picked;
    }
  }

  console.log('═'.repeat(78));
  console.log(`嚴格來源稽核（${jobs.length} 個候選）`);
  console.log('═'.repeat(78));

  const results = [];
  const queue = [...jobs];
  let done = 0;

  async function worker() {
    while (queue.length) {
      const j = queue.shift();
      let r;
      try {
        r = await audit(j.url, { seqCheck: !SKIP_SEQ });
      } catch (e) {
        r = { ok: false, reason: `例外：${e.name ?? e.message}`, url: j.url };
      }
      r.name = j.name;
      r.role = j.role;
      r.channel_id = j.ch?.channel_id ?? null;
      r.backup_source = j.backupSource ?? null;
      results.push(r);
      done++;
      if (done % 5 === 0) process.stdout.write(`  稽核中 ${done}/${jobs.length}\r`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  process.stdout.write(' '.repeat(40) + '\r');

  const okList = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);

  console.log('');
  console.log('─'.repeat(78));
  console.log('通過：');
  for (const r of okList) {
    console.log(
      `  ✓ ${r.name.padEnd(20)} ${r.role.padEnd(8)} ${r.kind} ${r.bytes}B ${r.ms}ms ` +
        `HTTP ${r.status} seq=${r.seq ?? '-'}`,
    );
  }
  console.log('');
  console.log('不通過：');
  for (const r of bad) {
    console.log(`  ✗ ${r.name.padEnd(20)} ${r.role.padEnd(8)} ${r.reason}`);
    console.log(`      ${r.url}`);
  }
  console.log('─'.repeat(78));
  console.log(`通過 ${okList.length}/${results.length}｜不通過 ${bad.length}`);

  if (JSON_OUT) {
    writeFileSync(
      JSON_OUT,
      JSON.stringify({ audited_at: new Date().toISOString(), results }, null, 2) + '\n',
      'utf8',
    );
    console.log(`已寫入 ${JSON_OUT}`);
  }
}

main();
