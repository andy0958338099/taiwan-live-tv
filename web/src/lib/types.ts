/**
 * 頻道資料型別 — 與 shared/schema.md 及 Android 端 ChannelRepository 保持一致。
 *
 * 這個檔案是 Web 端唯一的頻道資料定義來源。實際資料來自
 * /channels.json（由 scripts/sync-channels.mjs 從 shared/channels.json 產生）。
 */

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
  http_referrer?: string | null;
  notes?: string | null;
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
}

/**
 * 授權守門：未授權或停用的頻道不得進入 UI。
 *
 * 前端不做這道防線是危險的 —— 資料雖然來自我們自己的伺服器，
 * 但一旦網域或流程出錯，前端不過濾就會把未授權內容顯示出去。
 */
export function isPublishable(channel: Channel): boolean {
  return (
    channel.is_active &&
    ALLOWED_AUTHORIZATION.includes(channel.authorization_status) &&
    channel.stream_url.trim().length > 0
  );
}

export function filterPublishable(catalog: ChannelCatalog): ChannelCatalog {
  return {
    ...catalog,
    channels: catalog.channels.filter(isPublishable),
  };
}
