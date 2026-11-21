#!/usr/bin/env node
/**
 * decode-nuxt-payload.mjs — 擷取 Nuxt 3 SSR payload 裡的節目表（EPG）
 *
 * ## 為什麼需要這個
 *
 * 台灣的電視台多半有官方節目表，但抓法各異：
 *   · 官方 API 需要特殊 security header（Taiwan Plus 的
 *     `/api/live/live-schedule-today` 回 403「Missing required security headers」）
 *   · 但**直播頁的 SSR payload 已經內含節目表** —— 抓頁面就有。
 *
 * ## Nuxt 3 payload 的格式（2026-11-21 實測確認）
 *
 * `__NUXT_DATA__` 的內容是 JSON 陣列 `arr`：
 *   · `arr[0]` 是型別標記（如 `{ "ShallowReactive": 1 }`）
 *   · `arr[i]` 若是**數字** → 代表「去 `arr` 的第 N 個元素取值」
 *   · `arr[i]` 若是**物件** → 該物件的欄位值若是數字，同樣是索引
 *
 * 完整遞迴還原會**無限展開**（陣列裡有自我參照）→ OOM，
 * 所以這裡只做**一層**還原：找出節目物件並把它的欄位值取出來。
 * 對節目表來說一層就夠了（節目的欄位值都是字串，不是巢狀索引鏈）。
 *
 * 實測結果：Taiwan Plus 直播頁 → 88 個節目，
 * 每個含 `dateTime`（2026/11/21 10:00）、`time`、`title`、
 * `shortDescription`、`description`、`ageRating`、`image`。
 */

import { readFileSync, writeFileSync } from 'node:fs';

/** 節目物件會有的欄位（用來辨識） */
const PROGRAM_KEYS = new Set([
  'scheduleId',
  'dateTime',
  'time',
  'title',
  'shortDescription',
  'ageRating',
  'programTitle',
]);

/**
 * 從 HTML 擷取並解碼節目表。
 *
 * @param {string} html
 * @returns {Array<Record<string, unknown>>} 節目清單
 */
export function extractPrograms(html) {
  const m = html.match(
    /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!m) return [];

  const arr = JSON.parse(m[1]);

  /** 一層還原：索引 → 值 */
  const at = (i) =>
    typeof i === 'number' && i >= 0 && i < arr.length ? arr[i] : undefined;

  const programs = [];
  for (const node of arr) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    const keys = Object.keys(node);
    if (!keys.some((k) => PROGRAM_KEYS.has(k))) continue;

    /** 還原欄位：數字 → arr 的值 */
    const program = {};
    for (const [k, v] of Object.entries(node)) {
      const resolved = at(v);
      program[k] = resolved === undefined ? v : resolved;
    }
    programs.push(program);
  }
  return programs;
}

/**
 * 把節目表整理成「現在正在播 + 接下來」的形狀。
 *
 * @param {Array<Record<string, unknown>>} programs
 * @param {Date} now
 */
export function toNowNext(programs, now = new Date()) {
  const tz = 'Asia/Taipei';
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parsed = [];
  for (const p of programs) {
    if (!p.dateTime) continue;
    // 官方格式 "2026/11/21 10:00"（台北時間）
    const iso = String(p.dateTime).replace(/\//g, '-').replace(' ', 'T');
    const start = new Date(`${iso}:00+08:00`);
    if (Number.isNaN(start.getTime())) continue;
    parsed.push({ ...p, start, end: null });
  }
  // 依時間排序，讓「現在」容易找到
  parsed.sort((a, b) => a.start - b.start);

  /**
   * 節目長度未知 → 用「下一個**不同時間**的節目的開始」當結束時間。
   *
   * ⚠️ 官方 payload 裡同一時間常有兩個節目（不同頻道的節目表混在
   * 同一份 schedule 裡），如果直接用下一筆當結束時間，會出現
   * `end === start` → 節目長度為 0 → 「現在在播」永遠找不到。
   * 所以必須跳過時間相同的項目。
   */
  for (let i = 0; i < parsed.length; i++) {
    let next = null;
    for (let j = i + 1; j < parsed.length; j++) {
      if (parsed[j].start.getTime() > parsed[i].start.getTime()) {
        next = parsed[j].start;
        break;
      }
    }
    parsed[i].end = next ?? new Date(parsed[i].start.getTime() + 30 * 60000);
  }

  const nowMs = now.getTime();
  const current =
    parsed.find((p) => p.start <= nowMs && nowMs < p.end) ?? null;
  const upcoming = parsed.filter((p) => p.start > nowMs).slice(0, 6);

  return { current, upcoming, all: parsed, today: fmt.format(now) };
}

// ── CLI ──
if (process.argv[1] && process.argv[1].endsWith('decode-nuxt-payload.mjs')) {
  const file = process.argv[2];
  const html = readFileSync(file, 'utf8');
  const programs = extractPrograms(html);
  console.log(`節目數：${programs.length}`);
  for (const p of programs.slice(0, 6)) {
    console.log(`  ${p.dateTime ?? ''} | ${p.title ?? ''}`);
  }
  const { current, upcoming } = toNowNext(programs);
  console.log(`\n現在：${current ? `${current.dateTime} ${current.title}` : '（無資料）'}`);
  console.log('接下來：');
  for (const u of upcoming) console.log(`  ${u.dateTime} | ${u.title}`);

  if (process.argv[3]) {
    writeFileSync(process.argv[3], JSON.stringify(programs, null, 2));
    console.log(`\n已寫入 ${process.argv[3]}`);
  }
}
