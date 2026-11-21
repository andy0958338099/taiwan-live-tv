/**
 * EPG（電子節目表）型別 — 與 shared/epg.json 保持一致。
 *
 * EPG 由 `scripts/fetch-epg.mjs` 從各頻道的**官方來源**擷取，
 * 經 `scripts/sync-channels.mjs` 併入 channels.json，
 * 讓 APK 與 Web 共用同一份資料。
 *
 * 業界參考：Apple HIG「Live-Viewing Apps」要求選台時能看到
 * 現在正在播什麼；YouTube TV、Plex、Samsung TV Plus 都有同樣的設計。
 */

/** 目前正在播的節目 */
export interface EpgCurrent {
  title: string;
  /** 官方格式 "2026/11/21 15:00"（台北時間） */
  start: string;
  /** "16:00"（台北時間，僅小時:分） */
  end: string | null;
  description?: string;
  age_rating?: string | null;
}

/** 即將播出的節目 */
export interface EpgUpcoming {
  title: string;
  start: string;
}

/** 單一頻道的節目表 */
export interface EpgChannel {
  /** 節目表來源（哪個官方站台） */
  source: string;
  current: EpgCurrent | null;
  upcoming: EpgUpcoming[];
}

/** EPG 檔案頂層結構 */
export interface EpgCatalog {
  schema_version: number;
  updated_at: string;
  channels: Record<string, EpgChannel>;
}

/**
 * 從 channel_id 取出節目表。
 *
 * @param epg - EPG 資料（可能為 null）
 * @param channelId - 頻道 ID
 */
export function getEpg(
  epg: EpgCatalog | null | undefined,
  channelId: string | null,
): EpgChannel | null {
  if (!epg || !channelId) return null;
  return epg.channels[channelId] ?? null;
}

/**
 * 把官方日期格式轉成「15:00」這種顯示用格式。
 *
 * 官方給的是 "2026/11/21 15:00"（台北時間），只需要時間部分。
 */
export function epgTime(raw: string | null | undefined): string {
  if (!raw) return '';
  const m = raw.match(/(\d{1,2}):(\d{2})\s*$/);
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}
