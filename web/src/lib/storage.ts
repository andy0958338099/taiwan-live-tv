'use client';

/**
 * 收藏與最近觀看紀錄（localStorage）。
 *
 * 為什麼不用後端：
 *  - 收藏/歷史是個人化資料，不需要跨裝置同步才能滿足需求
 *  - 避免引入帳號系統與付費後端
 *  - 後續若需要跨裝置，可替換此模組的實作而不影響 UI
 *
 * key 前綴含版本號，未來若資料結構改版可整批失效重建。
 */

const STORAGE_PREFIX = 'tltv:v1:';
const FAVORITES_KEY = `${STORAGE_PREFIX}favorites`;
const RECENT_KEY = `${STORAGE_PREFIX}recent`;
const LAST_CHANNEL_KEY = `${STORAGE_PREFIX}lastChannel`;
const MAX_RECENT = 20;

function safeLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    // Safari 隱私模式會拋出 QuotaExceededError
    const test = '__tltv_test__';
    window.localStorage.setItem(test, '1');
    window.localStorage.removeItem(test);
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getFavorites(): string[] {
  const store = safeLocalStorage();
  if (!store) return [];
  try {
    const raw = store.getItem(FAVORITES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function toggleFavorite(channelId: string): string[] {
  const store = safeLocalStorage();
  const current = getFavorites();
  const next = current.includes(channelId)
    ? current.filter((id) => id !== channelId)
    : [...current, channelId];

  if (store) {
    try {
      store.setItem(FAVORITES_KEY, JSON.stringify(next));
    } catch {
      // 配額滿了：收藏功能失效但不影響播放
    }
  }
  return next;
}

export function isFavorite(channelId: string, favorites: string[]): boolean {
  return favorites.includes(channelId);
}

export function getRecent(): string[] {
  const store = safeLocalStorage();
  if (!store) return [];
  try {
    const raw = store.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function recordWatched(channelId: string): string[] {
  const store = safeLocalStorage();
  const current = getRecent();
  const next = [channelId, ...current.filter((id) => id !== channelId)].slice(0, MAX_RECENT);

  if (store) {
    try {
      store.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      // 忽略
    }
  }
  return next;
}

export function getLastChannel(): string | null {
  const store = safeLocalStorage();
  if (!store) return null;
  try {
    return store.getItem(LAST_CHANNEL_KEY);
  } catch {
    return null;
  }
}

export function setLastChannel(channelId: string): void {
  const store = safeLocalStorage();
  if (!store) return;
  try {
    store.setItem(LAST_CHANNEL_KEY, channelId);
  } catch {
    // 忽略
  }
}
