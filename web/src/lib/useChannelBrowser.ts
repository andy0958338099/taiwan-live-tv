'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Category, Channel } from './types';
import {
  getFavorites,
  getLastChannel,
  getRecent,
  recordWatched,
  setLastChannel,
  toggleFavorite,
} from './storage';

export type ViewMode = 'all' | 'favorites' | 'recent';
export type CategoryFilter = string | '__all__';

const ALL_CATEGORY = '__all__';

export interface ChannelBrowserState {
  channels: Channel[];
  categories: Category[];
  visibleChannels: Channel[];
  viewMode: ViewMode;
  categoryFilter: CategoryFilter;
  query: string;
  favorites: string[];
  recent: string[];
  lastChannelId: string | null;
  setViewMode: (mode: ViewMode) => void;
  setCategoryFilter: (id: CategoryFilter) => void;
  setQuery: (q: string) => void;
  toggleFav: (channelId: string) => void;
  markWatched: (channelId: string) => void;
}

/**
 * 頻道瀏覽狀態。
 *
 * 收藏與最近觀看存於 localStorage，因此初始值必須在 mount 後才讀取
 * （避免 SSR/CSR hydration 不一致）。
 */
export function useChannelBrowser(
  allChannels: Channel[],
  categories: Category[],
): ChannelBrowserState {
  const [viewMode, setViewMode] = useState<ViewMode>('all');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>(ALL_CATEGORY);
  const [query, setQuery] = useState('');
  const [favorites, setFavorites] = useState<string[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [lastChannelId, setLastChannelId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setFavorites(getFavorites());
    setRecent(getRecent());
    setLastChannelId(getLastChannel());
    setHydrated(true);
  }, []);

  const visibleChannels = useMemo(() => {
    let list = allChannels;

    if (viewMode === 'favorites') {
      list = list.filter((c) => favorites.includes(c.channel_id));
    } else if (viewMode === 'recent') {
      list = recent
        .map((id) => list.find((c) => c.channel_id === id))
        .filter((c): c is Channel => Boolean(c));
    }

    if (categoryFilter !== ALL_CATEGORY) {
      list = list.filter((c) => c.category === categoryFilter);
    }

    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((c) => {
        const haystack = [
          c.channel_name,
          c.name_en ?? '',
          c.description,
          ...(c.tags ?? []),
        ]
          .join(' ')
          .toLowerCase();
        return haystack.includes(q);
      });
    }

    return list;
  }, [allChannels, viewMode, favorites, recent, categoryFilter, query]);

  const toggleFav = (channelId: string) => {
    const next = toggleFavorite(channelId);
    setFavorites(next);
  };

  const markWatched = (channelId: string) => {
    setRecent(recordWatched(channelId));
    setLastChannelId(channelId);
    setLastChannel(channelId);
  };

  return {
    channels: allChannels,
    categories,
    visibleChannels,
    viewMode,
    categoryFilter,
    query,
    favorites,
    recent,
    lastChannelId: hydrated ? lastChannelId : null,
    setViewMode,
    setCategoryFilter,
    setQuery,
    toggleFav,
    markWatched,
  };
}
