/**
 * 頻道資料型別 — 與 shared/schema.md 及 Android 端 ChannelRepository 保持一致。
 *
 * 這個檔案是 Web 端唯一的頻道資料定義來源。實際資料來自
 * /channels.json（由 scripts/sync-channels.mjs 從 shared/channels.json 產生）。
 */

import type { EpgCatalog } from './epg';

export type { EpgCatalog, EpgChannel, EpgCurrent, EpgUpcoming } from './epg';

export type StreamType = 'hls' | 'dash' | 'mp4' | 'progressive';

export type AuthorizationStatus =
  | 'authorized'
  | 'public_official'
  | 'user_provided'
  | 'pending_review'
  | 'restricted'
  | 'unknown';

/** 可上線的授權狀態 — 與 scripts/validate-channels.mjs 保持一致 */
export const ALLOWED_AUTHORIZATION: readonly AuthorizationStatus[] = [
  'authorized',
  'public_official',
  'user_provided',
];

export interface BackupSource {
  url: string;
  source?: string;
  cors?: boolean;
}

/**
 * 匯入型頻道的來源鏈資訊（由 scripts/import-playlists.mjs 產生）。
 *
 * backup_urls 是同一頻道的其他可用來源。IPTV 清單的來源時常失效，
 * 播放器會在主來源失敗時自動改用備援來源。
 */
export interface PlaylistSource {
  provider: string;
  provider_label: string;
  provider_url: string;
  raw_channel_name: string;
  backup_urls: BackupSource[];
}

export interface Channel {
  channel_id: string;
  channel_name: string;
  name_en?: string | null;
  category: string;
  channel_number?: number | null;
  logo?: string | null;
  stream_url: string;
  stream_type: StreamType;
  source_name: string;
  source_website: string;
  authorization_status: AuthorizationStatus;
  is_active: boolean;
  last_checked?: string | null;
  description: string;
  tags?: string[];
  region?: string | null;
  cors_enabled?: boolean;
  /**
   * 網頁版是否可播（預設 true，只有明確 `false` 才排除）。
   *
   * 為什麼需要：有些 HLS 源的單一 TS 分片高達 5.2 MB（時長 6 秒 ≈ 7 Mbps），
   * 而我們的 `/api/proxy` 出口到該上游實測只有 1.35 Mbps
   * → 永遠追不上直播，播放 6 秒就卡 25 秒。
   *
   * 這種頻道「源是活的」，所以源巡檢不會判死；但網頁版一定播不動。
   * 標成 `web_playable: false` 讓網頁版不顯示，Android 版仍保留
   * （Android 直連，不經過代理，不受這個頻寬瓶頸限制）。
   */
  web_playable?: boolean;
  http_referrer?: string | null;
  /**
   * 來源要求特定的 User-Agent 才能取得串流。
   *
   * 部分 IPTV 轉載站會檢查 UA（例如 4K 來源要求 `AptvPlayer-UA`），
   * 帶錯時會回 403 或空清單。Web 版由代理轉送此標頭；
   * Android 版在建立 ExoPlayer 時設定。
   */
  http_user_agent?: string | null;
  notes?: string | null;
  playlist_source?: PlaylistSource;
  /**
   * 官方嵌入播放器網址。
   *
   * 若此欄位有值，前端改以 iframe 嵌入官方播放器而非直接播放 HLS。
   * 這是授權狀態 A（官方明確允許嵌入）的來源所使用的播放方式。
   */
  embed_url?: string | null;
}

export interface Category {
  id: string;
  name: string;
  name_en?: string | null;
  order: number;
  icon?: string | null;
}

export interface ChannelCatalog {
  schema_version: string;
  updated_at: string;
  categories: Category[];
  channels: Channel[];
  /**
   * 節目表（EPG）—— 由 scripts/fetch-epg.mjs 從官方來源擷取。
   *
   * 沒有 EPG 的頻道不會出現在這裡，UI 會退回「只顯示台標與名稱」。
   */
  epg?: EpgCatalog;
}

/**
 * 授權守門：未授權或停用的頻道不得進入 UI。
 *
 * 前端不做這道防線是危險的 —— 資料雖然來自我們自己的伺服器，
 * 但一旦網域或流程出錯，前端不過濾就會把未授權內容顯示出去。
 *
 * 播放網址可以是 `stream_url`（直接播放 HLS/DASH）或 `embed_url`
 * （嵌入官方播放器）。兩者至少要有一個，否則這個頻道無法播放。
 */
export function isPublishable(channel: Channel): boolean {
  const hasSource =
    channel.stream_url.trim().length > 0 ||
    (channel.embed_url?.trim().length ?? 0) > 0;

  return (
    channel.is_active &&
    ALLOWED_AUTHORIZATION.includes(channel.authorization_status) &&
    hasSource &&
    // 網頁版明確標記不可播的（分片過大、代理頻寬追不上）不進入 UI
    channel.web_playable !== false
  );
}

export function filterPublishable(catalog: ChannelCatalog): ChannelCatalog {
  return {
    ...catalog,
    channels: catalog.channels.filter(isPublishable),
  };
}
