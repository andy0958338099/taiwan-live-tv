#!/usr/bin/env node
/**
 * validate-channels.mjs — 建置前授權與資料完整性檢查
 *
 * 存在目的：把「未授權來源不得上線」變成建置期硬性失敗，而不是靠人工記憶。
 *
 * 規則見 shared/schema.md。任何一條失敗 → exit code 1 → CI / build script 中斷。
 *
 * 用法：
 *   node scripts/validate-channels.mjs [--json]
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHANNELS_PATH = join(__dirname, '..', 'shared', 'channels.json');

const ALLOWED_STATUSES = ['authorized', 'public_official', 'user_provided'];
const ALL_STATUSES = [
  'authorized',
  'public_official',
  'user_provided',
  'pending_review',
  'restricted',
  'unknown',
];
const VALID_STREAM_TYPES = ['hls', 'dash', 'mp4', 'progressive', 'embed'];
const VALID_CATEGORIES = [
  'news',
  'general',
  'entertainment',
  'finance',
  'public',
  'life',
  'education',
  'local',
];

const errors = [];
const warnings = [];
const inactive = [];

function readJSON(path) {
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`✗ 無法解析 ${path}: ${e.message}`);
    process.exit(1);
  }
}

const data = readJSON(CHANNELS_PATH);

// --- 頂層結構 ---
if (!data.schema_version) {
  errors.push('缺少 schema_version');
}
if (!Array.isArray(data.categories)) {
  errors.push('categories 必須是陣列');
}
if (!Array.isArray(data.channels)) {
  errors.push('channels 必須是陣列');
}

const categoryIds = new Set((data.categories || []).map((c) => c.id));
for (const c of data.categories || []) {
  if (!c.id) errors.push('category 缺少 id');
  if (!c.name) errors.push(`category ${c.id} 缺少 name`);
  if (typeof c.order !== 'number') errors.push(`category ${c.id} 缺少 order`);
}

// --- 頻道逐筆檢查 ---
const seenIds = new Set();
for (const [i, ch] of (data.channels || []).entries()) {
  const id = ch.channel_id || `<第 ${i + 1} 筆，無 channel_id>`;
  const err = (msg) => errors.push(`[${id}] ${msg}`);
  const warn = (msg) => warnings.push(`[${id}] ${msg}`);

  if (!ch.channel_id) err('缺少 channel_id');
  else if (seenIds.has(ch.channel_id)) err('channel_id 重複');
  else seenIds.add(ch.channel_id);

  if (!ch.channel_name) err('缺少 channel_name');

  if (!categoryIds.has(ch.category)) {
    err(`category "${ch.category}" 不存在於 categories 定義`);
  }

  if (!ch.stream_url && !ch.embed_url) {
    err('缺少 stream_url（若為官方嵌入播放器來源，須改填 embed_url）');
  } else if (ch.stream_url && !/^https?:\/\//.test(ch.stream_url)) {
    err(`stream_url 必須以 http:// 或 https:// 開頭（目前: ${ch.stream_url.slice(0, 40)}）`);
  }

  if (ch.embed_url && !/^https?:\/\//.test(ch.embed_url)) {
    err('embed_url 必須以 http:// 或 https:// 開頭');
  }

  if (!VALID_STREAM_TYPES.includes(ch.stream_type)) {
    err(`stream_type "${ch.stream_type}" 不合法，須為 ${VALID_STREAM_TYPES.join(' | ')}`);
  }

  if (!ch.source_name) err('缺少 source_name（來源必須標註）');
  if (!ch.source_website) err('缺少 source_website（來源必須標註）');
  else if (!/^https?:\/\//.test(ch.source_website)) {
    err('source_website 必須是 http(s) 網址');
  }

  if (!ALL_STATUSES.includes(ch.authorization_status)) {
    err(`authorization_status "${ch.authorization_status}" 不合法`);
  } else if (!ALLOWED_STATUSES.includes(ch.authorization_status)) {
    if (ch.is_active) {
      err(
        `授權狀態為 "${ch.authorization_status}" 但 is_active=true — 未授權來源不得上線`
      );
    } else {
      inactive.push(`${ch.channel_id} (${ch.authorization_status})`);
    }
  }

  if (typeof ch.is_active !== 'boolean') err('is_active 必須是 boolean');

  if (!ch.last_checked) {
    warn('缺少 last_checked');
  } else if (Number.isNaN(Date.parse(ch.last_checked))) {
    warn(`last_checked 不是合法 ISO 8601 日期時間: ${ch.last_checked}`);
  }

  if (typeof ch.description !== 'string' || !ch.description.trim()) {
    warn('缺少 description');
  }

  if (ch.cors_enabled === false && ALLOWED_STATUSES.includes(ch.authorization_status)) {
    warn('cors_enabled=false — Web 版需啟用代理，請確認 docs/01-system-design.md 的頻寬方案');
  }
}

// --- 輸出 ---
const asJSON = process.argv.includes('--json');

if (asJSON) {
  console.log(JSON.stringify({ ok: errors.length === 0, errors, warnings, inactive }, null, 2));
} else {
  const active = (data.channels || []).filter((c) => c.is_active);
  console.log('─'.repeat(60));
  console.log('頻道資料驗證報告');
  console.log('─'.repeat(60));
  console.log(`總頻道數      : ${(data.channels || []).length}`);
  console.log(`啟用中        : ${active.length}`);
  console.log(`待確認/未授權 : ${inactive.length}`);
  console.log(`分類數        : ${(data.categories || []).length}`);
  console.log('');

  if (inactive.length) {
    console.log('未上線頻道（授權狀態未確認，保留資料但不發佈）：');
    for (const s of inactive) console.log(`  · ${s}`);
    console.log('');
  }

  if (warnings.length) {
    console.log(`⚠ 警告 (${warnings.length})：`);
    for (const w of warnings) console.log(`  · ${w}`);
    console.log('');
  }

  if (errors.length) {
    console.log(`✗ 錯誤 (${errors.length})：`);
    for (const e of errors) console.log(`  · ${e}`);
    console.log('');
    console.log('驗證失敗：禁止產出包含上述問題的頻道清單。');
    console.log('─'.repeat(60));
    process.exit(1);
  }

  console.log('✓ 驗證通過：所有啟用中頻道皆具備有效來源標註與可上線授權狀態。');
  console.log('─'.repeat(60));
}
