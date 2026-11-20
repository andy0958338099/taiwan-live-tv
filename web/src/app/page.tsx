'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Channel, ChannelCatalog } from '../lib/types';
import { fetchCatalog } from '../lib/catalog';
import { useChannelBrowser, type CategoryFilter, type ViewMode } from '../lib/useChannelBrowser';
import { useHlsPlayer } from '../lib/useHlsPlayer';
import { VideoPlayer } from '../components/VideoPlayer';
import { ChannelInfoDialog } from '../components/ChannelInfoDialog';
import styles from './page.module.css';

const ALL_CATEGORY = '__all__';

export default function Home() {
  const [catalog, setCatalog] = useState<ChannelCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Channel | null>(null);
  const [showInfo, setShowInfo] = useState(false);

  // --- 載入頻道資料 ---
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { catalog: c, error } = await fetchCatalog();
      if (cancelled) return;
      setCatalog(c);
      setLoadError(error);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const browser = useChannelBrowser(catalog?.channels ?? [], catalog?.categories ?? []);
  const player = useHlsPlayer(selected);

  // --- 自動恢復上次觀看頻道 ---
  const restoredRef = useMemo(() => new Set<string>(), []);
  useEffect(() => {
    if (!catalog || !browser.lastChannelId || restoredRef.has('done')) return;
    restoredRef.add('done');
    const ch = catalog.channels.find((c) => c.channel_id === browser.lastChannelId);
    if (ch) {
      setSelected(ch);
      browser.markWatched(ch.channel_id);
    }
  }, [catalog, browser.lastChannelId, browser, restoredRef]);

  const handleSelect = (channel: Channel) => {
    setSelected(channel);
    browser.markWatched(channel.channel_id);
  };

  const categoryName = useMemo(() => {
    if (!selected) return '';
    return catalog?.categories.find((c) => c.id === selected.category)?.name ?? selected.category;
  }, [selected, catalog]);

  if (loading) {
    return (
      <main className={styles.page}>
        <div className={styles.loading}>載入中…</div>
      </main>
    );
  }

  if (loadError || !catalog) {
    return (
      <main className={styles.page}>
        <div className={styles.errorBox}>
          <h1 className={styles.errorTitle}>無法載入頻道資料</h1>
          <p className={styles.errorText}>{loadError}</p>
          <p className={styles.errorHint}>
            頻道資料由專案的 <code>scripts/sync-channels.mjs</code> 從
            <code> shared/channels.json </code> 產生。若尚未執行同步，
            請先執行 <code>npm run sync:channels</code>。
          </p>
          <button type="button" className={styles.primaryBtn} onClick={() => location.reload()}>
            重新載入
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={styles.brandBlock}>
          <h1 className={styles.title}>台灣電視直播</h1>
          <p className={styles.subtitle}>
            {catalog.channels.length} 個頻道 · 資料更新於 {formatTime(catalog.updated_at)}
          </p>
        </div>

        <div className={styles.searchWrap}>
          <label htmlFor="channel-search" className={styles.srOnly}>
            搜尋頻道
          </label>
          <input
            id="channel-search"
            type="search"
            className={styles.searchInput}
            placeholder="搜尋頻道名稱或關鍵字"
            value={browser.query}
            onChange={(e) => browser.setQuery(e.target.value)}
          />
        </div>
      </header>

      {/* 檢視模式 */}
      <nav className={styles.viewTabs} aria-label="檢視模式">
        {(
          [
            ['all', '全部頻道'],
            ['favorites', '我的最愛'],
            ['recent', '最近觀看'],
          ] as [ViewMode, string][]
        ).map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            className={`${styles.tab} ${browser.viewMode === mode ? styles.tabActive : ''}`}
            onClick={() => browser.setViewMode(mode)}
            aria-pressed={browser.viewMode === mode}
          >
            {label}
          </button>
        ))}
      </nav>

      {/* 分類 */}
      <nav className={styles.categoryBar} aria-label="頻道分類">
        <button
          type="button"
          className={`${styles.categoryChip} ${
            browser.categoryFilter === ALL_CATEGORY ? styles.categoryChipActive : ''
          }`}
          onClick={() => browser.setCategoryFilter(ALL_CATEGORY)}
        >
          全部
        </button>
        {catalog.categories.map((cat) => (
          <button
            key={cat.id}
            type="button"
            className={`${styles.categoryChip} ${
              browser.categoryFilter === cat.id ? styles.categoryChipActive : ''
            }`}
            onClick={() => browser.setCategoryFilter(cat.id as CategoryFilter)}
          >
            {cat.name}
          </button>
        ))}
      </nav>

      {/* 播放區 */}
      <section className={styles.playerSection}>
        <VideoPlayer
          videoRef={player.videoRef}
          status={player.status}
          errorMessage={player.errorMessage}
          needsUserGesture={player.needsUserGesture}
          onRetry={player.retry}
          onUserGesture={player.resumeFromUserGesture}
          channelName={selected?.channel_name ?? ''}
          activeSourceIndex={player.activeSourceIndex}
          totalSources={player.totalSources}
          embedUrl={player.embedUrl}
          channelId={selected?.channel_id ?? null}
          iframeKey={player.iframeKey}
          onIframeMount={player.setIframeEl}
          onVideoMount={player.setVideoEl}
          muted={player.muted}
          onToggleMute={player.toggleMute}
        />

        {selected && (
          <div className={styles.nowPlaying}>
            <div className={styles.nowPlayingMain}>
              <h2 className={styles.nowPlayingTitle}>{selected.channel_name}</h2>
              <span className={styles.nowPlayingCategory}>{categoryName}</span>
              <p className={styles.nowPlayingDesc}>{selected.description}</p>
            </div>
            <div className={styles.nowPlayingActions}>
              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={() => browser.toggleFav(selected.channel_id)}
              >
                {browser.favorites.includes(selected.channel_id) ? '取消收藏' : '加入收藏'}
              </button>
              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={() => setShowInfo(true)}
              >
                頻道資訊
              </button>
            </div>
          </div>
        )}
      </section>

      <ChannelInfoDialog
        channel={showInfo ? selected : null}
        categoryName={categoryName}
        onClose={() => setShowInfo(false)}
      />

      {/* 頻道列表 */}
      <section className={styles.channelSection}>
        <h2 className={styles.sectionTitle}>
          {browser.viewMode === 'favorites'
            ? '我的最愛'
            : browser.viewMode === 'recent'
              ? '最近觀看'
              : '頻道列表'}
          <span className={styles.countBadge}>{browser.visibleChannels.length}</span>
        </h2>

        {browser.visibleChannels.length === 0 ? (
          <p className={styles.emptyState}>{emptyMessage(browser.viewMode, browser.query)}</p>
        ) : (
          <ul className={styles.channelGrid}>
            {browser.visibleChannels.map((channel) => (
              <li key={channel.channel_id}>
                <button
                  type="button"
                  className={`${styles.channelCard} ${
                    selected?.channel_id === channel.channel_id ? styles.channelCardActive : ''
                  }`}
                  onClick={() => handleSelect(channel)}
                  aria-pressed={selected?.channel_id === channel.channel_id}
                >
                  <span className={styles.cardLogoWrap}>
                    {channel.logo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={channel.logo}
                        alt=""
                        className={styles.cardLogo}
                        loading="lazy"
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    ) : (
                      <span className={styles.cardPlaceholder}>
                        {channel.channel_name.slice(0, 1)}
                      </span>
                    )}
                  </span>
                  <span className={styles.cardName}>{channel.channel_name}</span>
                  <span className={styles.cardCategory}>
                    {catalog.categories.find((c) => c.id === channel.category)?.name ??
                      channel.category}
                  </span>
                  {browser.favorites.includes(channel.channel_id) && (
                    <span className={styles.favBadge} aria-label="已收藏">
                      ★
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className={styles.footer}>
        <p>
          所有頻道均標註來源與授權狀態。未經授權的來源不會出現在本清單中。
        </p>
        <p className={styles.footerMeta}>
          schema v{catalog.schema_version} · APK 與網頁讀取同一份頻道資料
        </p>
      </footer>
    </main>
  );
}

function formatTime(iso?: string | null): string {
  if (!iso) return '未知';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('zh-TW', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Taipei',
  }).format(d);
}

function authorizationLabel(status: string): string {
  switch (status) {
    case 'authorized':
      return '已授權';
    case 'public_official':
      return '官方公開';
    case 'user_provided':
      return '使用者提供';
    case 'pending_review':
      return '待確認';
    case 'restricted':
      return '受限';
    default:
      return '未知';
  }
}

function emptyMessage(mode: ViewMode, query: string): string {
  if (mode === 'favorites') return '尚未收藏任何頻道。點選頻道後按「加入收藏」即可加入。';
  if (mode === 'recent') return '尚無觀看紀錄。';
  if (query.trim()) return `找不到符合「${query}」的頻道。`;
  return '目前沒有可顯示的頻道。';
}
