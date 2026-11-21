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
export type RegionFilter = string | '__all__';

const ALL_CATEGORY = '__all__';

export interface ChannelBrowserState {
  channels: Channel[];
  categories: Category[];
  visibleChannels: Channel[];
  viewMode: ViewMode;
  categoryFilter: CategoryFilter;
  regionFilter: RegionFilter;
  query: string;
  favorites: string[];
  recent: string[];
  lastChannelId: string | null;
  setViewMode: (mode: ViewMode) => void;
  setCategoryFilter: (id: CategoryFilter) => void;
  setRegionFilter: (id: RegionFilter) => void;
  setQuery: (q: string) => void;
  toggleFav: (channelId: string) => void;
  markWatched: (channelId: string) => void;
  /** 所有可用的地區（依頻道數排序） */
  regions: { id: string; name: string; count: number }[];
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
  const [regionFilter, setRegionFilter] = useState<RegionFilter>(ALL_CATEGORY);
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

  /**
   * 可用地區清單。
   *
   * 「地區」是台灣觀眾最實際的第一層篩選（台灣 / 中國 / 香港…），
   * 比「新聞台 / 綜合台」更符合「我要看本土台」的直覺。
   */
  const regions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of allChannels) {
      const r = c.region?.trim();
      if (!r) continue;
      counts.set(r, (counts.get(r) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([id, count]) => ({ id, name: id, count }))
      // 台灣優先（本地台永遠第一），其餘依頻道數排序
      .sort((a, b) => {
        if (a.id === '台灣') return -1;
        if (b.id === '台灣') return 1;
        return b.count - a.count;
      });
  }, [allChannels]);

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

    if (regionFilter !== ALL_CATEGORY) {
      list = list.filter((c) => c.region === regionFilter);
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
  }, [allChannels, viewMode, favorites, recent, categoryFilter, regionFilter, query]);

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
    regionFilter,
    query,
    favorites,
    recent,
    regions,
    lastChannelId: hydrated ? lastChannelId : null,
    setViewMode,
    setCategoryFilter,
    setRegionFilter,
    setQuery,
    toggleFav,
    markWatched,
  };
}
