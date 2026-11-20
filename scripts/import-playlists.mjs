#!/usr/bin/env node
/**
 * import-playlists.mjs — 從外部 IPTV 播放清單匯入台灣頻道
 *
 * 這是「頻道來源管理」機制的自動化腳本：
 *   shared/sources.json（來源註冊表）
 *        → 抓取清單 → 解析 M3U → 過濾台灣頻道 → 探測可用性
 *        → 寫入 shared/channels.json
 *
 * 設計原則：
 *  1. **不覆蓋人工維護的頻道** —— 已存在的 channel_id 會保留既有資料，
 *     只更新 stream_url 等技術欄位（除非 --force-overwrite）
 *  2. **每個匯入的頻道都標註來源** —— source_name 記錄原始頻道與轉載清單，
 *     source_website 記錄清單網址
 *  3. **授權狀態為 user_provided** —— 這些清單由使用者提供並授權使用；
 *     但轉載性質會寫在 notes，並在文件中標明授權風險
 *  4. **探測過濾** —— 只有實際回應 HTTP 200 且內容為合法 m3u8 的才會匯入
 *
 * 用法：
 *   node scripts/import-playlists.mjs [--dry-run] [--no-probe] [--source <id>]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SOURCES_PATH = join(ROOT, 'shared', 'sources.json');
const CHANNELS_PATH = join(ROOT, 'shared', 'channels.json');

const DRY_RUN = process.argv.includes('--dry-run');
const NO_PROBE = process.argv.includes('--no-probe');
const FORCE_OVERWRITE = process.argv.includes('--force-overwrite');
const onlySource = (() => {
  const i = process.argv.indexOf('--source');
  return i >= 0 ? process.argv[i + 1] : null;
})();

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

// ---------- M3U 解析 ----------

function parseM3U(text) {
  const entries = [];
  let pending = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      const attrRe = /([A-Za-z0-9_-]+)="([^"]*)"/g;
      let m;
      while ((m = attrRe.exec(line)) !== null) attrs[m[1]] = m[2];

      const commaIdx = line.indexOf(',');
      const name = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : '';

      pending = {
        name,
        group: attrs['group-title'] || '',
        logo: attrs['tvg-logo'] || '',
        tvgId: attrs['tvg-id'] || '',
      };
    } else if (line.startsWith('#EXTGRP:')) {
      if (pending) pending.group = line.slice('#EXTGRP:'.length).trim();
    } else if (!line.startsWith('#')) {
      if (pending) {
        pending.url = line;
        entries.push(pending);
        pending = null;
      }
    }
  }

  return entries;
}

/** 去除清單中的裝飾標記，讓比對更準確 */
function cleanName(name) {
  return name
    .replace(/[「」\[\]【】（）()\s]/g, '')
    .replace(/Relay|ofiii|直播|备用|備用|備援/g, '');
}

// ---------- 頻道比對 ----------

function matchChannel(entry, rules) {
  const haystack = `${entry.name} ${entry.group}`;
  const inPool = rules.include_group_keywords.some((k) => haystack.includes(k));
  if (!inPool) return null;

  const clean = cleanName(entry.name);
  const map = rules.channel_map;

  // 長關鍵字優先，避免「三立」誤吃「三立戲劇」以外、或短字吃掉長字
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (clean.includes(key)) {
      return { id: key, ...map[key] };
    }
  }
  return null;
}

// ---------- 串流探測 ----------

async function probeStream(url) {
  if (!url.startsWith('http')) return { ok: false, reason: '非 http 網址' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Origin: 'http://localhost:3210' },
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };

    const acao = res.headers.get('access-control-allow-origin');
    const cors = acao === '*' || acao !== null;

    // 只讀前 800 bytes 判斷是否為 m3u8
    const reader = res.body.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const head = new TextDecoder().decode(value.slice(0, 800));
    const isManifest = head.trimStart().startsWith('#EXTM3U');

    if (!isManifest) return { ok: false, reason: '回應非 m3u8 格式' };

    return { ok: true, cors, isMaster: head.includes('EXT-X-STREAM-INF'), status: res.status };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? '逾時' : e.name };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 主流程 ----------

async function main() {
  const sourcesCfg = JSON.parse(readFileSync(SOURCES_PATH, 'utf8'));
  const channels = JSON.parse(readFileSync(CHANNELS_PATH, 'utf8'));
  const rules = sourcesCfg.import_rules;

  const existingById = new Map(channels.channels.map((c) => [c.channel_id, c]));

  let activeSources = sourcesCfg.sources.filter((s) => s.enabled);
  if (onlySource) activeSources = activeSources.filter((s) => s.id === onlySource);

  console.log('═'.repeat(70));
  console.log('播放清單匯入');
  console.log('═'.repeat(70));
  console.log(
    `來源：${activeSources.map((s) => `${s.label}(${s.id})`).join(', ')}`,
  );
  console.log(
    `模式：${DRY_RUN ? 'dry-run（不寫檔）' : '實際寫入'}｜探測：${NO_PROBE ? '關閉' : '開啟'}｜覆寫：${FORCE_OVERWRITE ? '是' : '否'}`,
  );
  console.log('');

  // ---- 步驟 1：抓取並解析 ----
  const candidates = new Map(); // 正規頻道名 → { category, sources: [] }

  for (const src of activeSources) {
    process.stdout.write(`▶ 抓取 ${src.label}… `);
    try {
      const res = await fetch(src.url, {
        headers: { 'User-Agent': UA },
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const text = await res.text();
      const entries = parseM3U(text);
      let matched = 0;

      for (const entry of entries) {
        if (rules.exclude_name_pattern) {
          const ex = new RegExp(rules.exclude_name_pattern);
          if (ex.test(entry.name)) continue;
        }
        const m = matchChannel(entry, rules);
        if (!m) continue;
        matched++;

        if (!candidates.has(m.name)) {
          candidates.set(m.name, { category: m.category, id: m.id, sources: [] });
        }
        candidates.get(m.name).sources.push({
          sourceId: src.id,
          sourceLabel: src.label,
          sourceUrl: src.url,
          priority: src.priority ?? 99,
          rawName: entry.name,
          group: entry.group,
          logo: entry.logo,
          url: entry.url,
        });
      }

      console.log(`✓ ${entries.length} 筆，其中 ${matched} 筆符合台灣條件`);
    } catch (e) {
      console.log(`✗ 失敗：${e.message}`);
    }
  }

  console.log('');
  console.log(`符合條件的台灣頻道：${candidates.size} 個`);
  console.log('');

  // ---- 步驟 2：探測 ----
  const usable = new Map();

  for (const [name, info] of candidates) {
    const ordered = info.sources.sort(
      (a, b) => a.priority - b.priority || a.url.length - b.url.length,
    );

    // 每個頻道最多探測 6 個候選
    const toProbe = ordered.slice(0, 6);
    const working = [];

    if (!NO_PROBE) {
      const results = await Promise.all(
        toProbe.map(async (c) => ({ c, r: await probeStream(c.url) })),
      );

      for (const { c, r } of results) {
        if (r.ok) working.push({ ...c, cors: r.cors, isMaster: r.isMaster });
      }
    } else {
      working.push(...toProbe.map((c) => ({ ...c, cors: null, isMaster: null })));
    }

    if (working.length > 0) {
      // 優先選有 CORS 的（可上網頁版），其次依來源優先序
      working.sort((a, b) => {
        const corsDiff = (b.cors === true ? 1 : 0) - (a.cors === true ? 1 : 0);
        if (corsDiff !== 0) return corsDiff;
        return a.priority - b.priority;
      });
      usable.set(name, { ...info, working });
    }
  }

  // ---- 步驟 3：報告 ----
  console.log('─'.repeat(70));
  console.log('匯入結果');
  console.log('─'.repeat(70));

  const newChannels = [];
  let updated = 0;
  let skipped = 0;

  for (const [name, info] of usable) {
    const best = info.working[0];
    const id = `playlist-${info.id}-${slug(name)}`;
    const existing = existingById.get(id);

    if (existing && !FORCE_OVERWRITE) {
      // 保留人工維護的欄位，只更新技術欄位
      existing.stream_url = best.url;
      existing.last_checked = new Date().toISOString();
      existing.cors_enabled = best.cors === true;
      existing.source_name = `${name}（經 ${best.sourceLabel} 清單轉載）`;
      existing.source_website = best.sourceUrl;
      existing.notes = `轉載自 ${best.sourceLabel}。原始頻道：${best.rawName}。共 ${info.working.length} 個可用備援來源。`;
      updated++;
      console.log(`  ↻ 更新 ${name}（${existing.category}）`);
      continue;
    }

    const channel = {
      channel_id: id,
      channel_name: name,
      name_en: null,
      category: info.category,
      channel_number: null,
      logo: best.logo || null,
      stream_url: best.url,
      stream_type: 'hls',
      source_name: `${name}（經 ${best.sourceLabel} 清單轉載）`,
      source_website: best.sourceUrl,
      authorization_status: 'user_provided',
      is_active: true,
      last_checked: new Date().toISOString(),
      description: `由 IPTV 播放清單取得之「${best.rawName}」。備援來源 ${info.working.length} 個。`,
      tags: ['台灣', 'iptv', best.sourceId, ...info.working.map((w) => w.sourceId)],
      region: '台灣',
      cors_enabled: best.cors === true,
      http_referrer: null,
      notes:
        `轉載自 ${best.sourceLabel}（${best.sourceUrl}）。原始頻道名稱：${best.rawName}。` +
        (best.cors === true
          ? '此來源支援 CORS，網頁版可直接播放。'
          : '此來源未提供 CORS 標頭，網頁版無法直接播放，僅 Android TV 版可用。'),
    };

    // 附加專用欄位（記錄匯入來源鏈）
    channel.playlist_source = {
      provider: best.sourceId,
      provider_label: best.sourceLabel,
      provider_url: best.sourceUrl,
      raw_channel_name: best.rawName,
      backup_urls: info.working.map((w) => ({
        url: w.url,
        source: w.sourceId,
        cors: w.cors,
      })),
    };

    newChannels.push(channel);
    console.log(
      `  + 新增 ${name}（${info.category}）${best.cors === true ? ' CORS✓' : ' CORS✗'} 來源=${best.sourceLabel}`,
    );
  }

  for (const name of candidates.keys()) {
    if (!usable.has(name)) {
      console.log(`  ✗ 略過 ${name}（無可用串流）`);
      skipped++;
    }
  }

  console.log('');
  console.log(`新增 ${newChannels.length} 個｜更新 ${updated} 個｜略過 ${skipped} 個`);

  if (DRY_RUN) {
    console.log('\n(dry-run 模式，未寫入檔案)');
    return;
  }

  // ---- 步驟 4：寫入 ----
  const manualChannels = channels.channels.filter((c) => !c.playlist_source);
  const playlistChannels = [
    ...channels.channels.filter((c) => c.playlist_source),
    ...newChannels,
  ];

  channels.channels = [...manualChannels, ...playlistChannels];
  channels.updated_at = new Date().toISOString();
  channels.schema_version = channels.schema_version || '1.0.0';

  writeFileSync(CHANNELS_PATH, JSON.stringify(channels, null, 2) + '\n', 'utf8');
  console.log(`\n✓ 已寫入 ${CHANNELS_PATH}`);
  console.log(`  總頻道數 ${channels.channels.length}（人工 ${manualChannels.length} + 匯入 ${playlistChannels.length}）`);
  console.log('\n下一步：node scripts/validate-channels.mjs && node scripts/sync-channels.mjs');
}

function slug(name) {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

main().catch((e) => {
  console.error('\n✗ 匯入失敗:', e);
  process.exit(1);
});
