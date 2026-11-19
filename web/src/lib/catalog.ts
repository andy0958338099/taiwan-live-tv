import type { ChannelCatalog } from './types';
import { filterPublishable } from './types';

/**
 * 載入頻道清單。
 *
 * 來源：/channels.json — 由 scripts/sync-channels.mjs 從 shared/channels.json 產生，
 * 與 APK 內的 assets/channels.json 同源。
 *
 * 失敗時回傳空目錄，而不是讓整個頁面崩潰 —— 但頁面必須明確顯示「無法載入頻道資料」，
 * 不得顯示成「沒有頻道」而讓人誤以為功能正常。
 */
export async function fetchCatalog(
  fetcher: typeof fetch = fetch,
): Promise<{ catalog: ChannelCatalog | null; error: string | null }> {
  try {
    const res = await fetcher('/channels.json', { cache: 'no-store' });

    if (!res.ok) {
      return {
        catalog: null,
        error: `無法載入頻道資料（HTTP ${res.status}）`,
      };
    }

    const raw = (await res.json()) as ChannelCatalog;

    if (!raw || !Array.isArray(raw.channels) || !Array.isArray(raw.categories)) {
      return {
        catalog: null,
        error: '頻道資料格式不正確',
      };
    }

    return {
      catalog: filterPublishable(raw),
      error: null,
    };
  } catch (e) {
    return {
      catalog: null,
      error: e instanceof Error ? `無法載入頻道資料：${e.message}` : '無法載入頻道資料',
    };
  }
}
