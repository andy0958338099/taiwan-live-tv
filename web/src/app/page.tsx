'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Channel, ChannelCatalog } from '../lib/types';
import { fetchCatalog } from '../lib/catalog';
import { useChannelBrowser, type CategoryFilter, type ViewMode } from '../lib/useChannelBrowser';
import { useHlsPlayer } from '../lib/useHlsPlayer';
import { VideoPlayer } from '../components/VideoPlayer';
import { ChannelInfoDialog } from '../components/ChannelInfoDialog';
import { ChannelRail } from '../components/ChannelRail';
import styles from './page.module.css';

const ALL_CATEGORY = '__all__';

export default function Home() {
  const [catalog, setCatalog] = useState<ChannelCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Channel | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  /**
   * 頻道選擇抽屜是否展開。
   *
   * 設計意圖：**觀看時完全隱藏**。
   * 網頁版預設只顯示播放器 + 頻道資訊，
   * 頻道清單收在抽屜裡，只有需要換台時才滑出來，
   * 選完就自動收起 —— 不影響觀賞體驗。
   */
  const [drawerOpen, setDrawerOpen] = useState(false);

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
    /**
     * ⚠️ 必須在點擊手勢內同步呼叫。
     *
     * 頻道切換會走 `setSelected()` → React 渲染 → useEffect → startPlayback，
     * 而 useEffect 是在 paint 之後才跑的，已經離開使用者的點擊手勢時間窗。
     *
     * Chrome 的自動播放政策要求「媒體變成有聲的那一刻，使用者手勢必須仍有效」，
     * 所以這裡先把手勢記下並解除靜音，後續的 useEffect 就不會把音量關回去。
     * 少了這一步，慢速來源會讓使用者靜靜聽 50 秒的靜音。
     */
    player.prepareForChannelSwitch();
    setSelected(channel);
    browser.markWatched(channel.channel_id);
    // 選好頻道 → 自動收起抽屜，回到純觀看畫面
    setDrawerOpen(false);
  };

  // --- Esc 關閉抽屜 / 快捷鍵開啟 ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 輸入框內不觸發快捷鍵
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;

      if (e.key === 'Escape') {
        setDrawerOpen(false);
        return;
      }
      // `c` 或 `n` 開啟頻道選擇（電視遙控器常見的操作習慣）
      if ((e.key === 'c' || e.key === 'C' || e.key === 'n' || e.key === 'N') && !drawerOpen) {
        e.preventDefault();
        setDrawerOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

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
    <main className={`${styles.page} ${drawerOpen ? styles.pageDrawerOpen : ''}`}>
      <header className={styles.header}>
        <div className={styles.brandBlock}>
          <h1 className={styles.title}>台灣電視直播</h1>
          <p className={styles.subtitle}>
            {catalog.channels.length} 個頻道 · 資料更新於 {formatTime(catalog.updated_at)}
          </p>
        </div>

        {/*
         * 搜尋框只放在抽屜裡。
         *
         * 原本頁首也有一個，但抽屜展開時兩個搜尋框同時出現、
         * 內容同步、行為一致 —— 使用者會困惑到底哪個才是對的。
         * 抽屜關閉時看不到搜尋也沒關係：
         * 頁首的「選擇頻道」把手會引導使用者進到那裡。
         */}
      </header>

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
          elapsedSeconds={player.elapsedSeconds}
          onSkipSource={player.skipSource}
          remainingSources={Math.max(
            0,
            player.totalSources - player.activeSourceIndex - 1,
          )}
          hasChannel={!!selected}
          onOpenPicker={() => setDrawerOpen(true)}
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

      {/* ======================================================
          頻道選擇抽屜（可隱藏式）
          ------------------------------------------------------------
          觀看時只有右下角的「選擇頻道」把手，
          頻道清單完全收在抽屜裡，不佔觀看畫面。
          ====================================================== */}

      {/* 浮動把手 —— 觀看時的唯一入口 */}
      <button
        type="button"
        className={`${styles.drawerHandle} ${drawerOpen ? styles.drawerHandleHidden : ''}`}
        onClick={() => setDrawerOpen(true)}
        aria-label="選擇頻道"
        aria-expanded={drawerOpen}
      >
        <span aria-hidden="true">📺</span>
        <span>選擇頻道</span>
      </button>

      {/* 背景遮罩 —— 點擊即收起 */}
      {drawerOpen && (
        <div
          className={styles.drawerScrim}
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* 抽屜本體 */}
      <aside
        className={`${styles.drawer} ${drawerOpen ? styles.drawerOpen : ''}`}
        aria-label="頻道選擇"
        aria-hidden={!drawerOpen}
      >
        {/* 拖曳把手 —— 視覺提示這是可滑動的抽屜（手機上特別有用） */}
        <div className={styles.drawerGrip} aria-hidden="true" />

        <div className={styles.drawerHead}>
          <h2 className={styles.drawerTitle}>
            <span aria-hidden="true">📺</span>
            {browser.viewMode === 'favorites'
              ? '我的最愛'
              : browser.viewMode === 'recent'
                ? '最近觀看'
                : '頻道列表'}
            <span className={styles.countBadge}>{browser.visibleChannels.length}</span>
          </h2>
          <button
            type="button"
            className={styles.drawerClose}
            onClick={() => setDrawerOpen(false)}
            aria-label="收起頻道選擇"
          >
            收起
          </button>
        </div>

        <div className={styles.drawerBody}>
          {/*
           * 搜尋 —— 放在最上面且 sticky，捲動時不會消失。
           * （頁首也有一個搜尋框，但那個在抽屜關閉時才看得到，
           *   抽屜內這個才是選頻道時真正會用的。）
           */}
          <div className={styles.drawerSearch}>
            <label htmlFor="drawer-channel-search" className={styles.srOnly}>
              搜尋頻道
            </label>
            <input
              id="drawer-channel-search"
              type="search"
              className={styles.searchInput}
              placeholder="搜尋頻道名稱或關鍵字"
              value={browser.query}
              onChange={(e) => browser.setQuery(e.target.value)}
            />
          </div>

          {/*
           * 橫向台標列 —— 主要的選台入口。
           *
           * 放在最上面（搜尋框之後、頁籤之前），因為它是「快速換台」
           * 用的；而下方的網格是「瀏覽完整清單」用的。
           * 兩者分工明確，不重複。
           */}
          <ChannelRail
            channels={browser.visibleChannels}
            selectedId={selected?.channel_id ?? null}
            epg={catalog.epg}
            categories={catalog.categories}
            onSelect={handleSelect}
          />

          {/* 檢視模式 —— 可橫向捾動的 chip 列 */}
          <nav className={styles.drawerTabs} aria-label="檢視模式">
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
                onClick={() => browser.setViewMode(mode)}
                aria-pressed={browser.viewMode === mode}
              >
                {label}
              </button>
            ))}
          </nav>

          {/*
           * 我的最愛 —— 獨立的一列，不受頁籤切換影響。
           *
           * Apple HIG 對 Live-Viewing Apps 的說明裡，「My Channels」
           * （我的頻道）永遠直接可見，不藏在子頁籤裡 ——
           * 使用者最常回來的頻道就是最愛，藏起來等於增加兩次點擊。
           * 這裡放在地區/分類篩選之前，因為它是最常用的一層。
           */}
          {browser.favorites.length > 0 && (
            <section className={styles.favSection} aria-label="我的最愛頻道">
              <ul className={styles.favRow}>
                {browser.favorites.map((id) => {
                  const ch = catalog.channels.find((c) => c.channel_id === id);
                  if (!ch) return null;
                  const isActive = selected?.channel_id === id;
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        className={`${styles.favItem} ${isActive ? styles.favItemActive : ''}`}
                        onClick={() => handleSelect(ch)}
                        aria-pressed={isActive}
                      >
                        <span className={styles.favLogoWrap}>
                          {ch.logo ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={ch.logo} alt="" className={styles.favLogo} loading="lazy" />
                          ) : (
                            <span className={styles.favLogoPlaceholder}>
                              {ch.channel_name.slice(0, 1)}
                            </span>
                          )}
                          {isActive && (
                            <span className={styles.liveBadge} aria-hidden="true">
                              LIVE
                            </span>
                          )}
                        </span>
                        <span className={styles.favName}>{ch.channel_name}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/*
           * 地區 —— 對台灣觀眾最實用的一層篩選。
           * 台灣永遠排第一，其餘依頻道數排序。
           */}
          {browser.regions.length > 1 && (
            <nav className={styles.drawerChips} aria-label="頻道地區">
              <button
                type="button"
                onClick={() => browser.setRegionFilter(ALL_CATEGORY)}
                aria-pressed={browser.regionFilter === ALL_CATEGORY}
              >
                全部地區
              </button>
              {browser.regions.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => browser.setRegionFilter(r.id)}
                  aria-pressed={browser.regionFilter === r.id}
                >
                  {r.name}
                  <span className={styles.chipCount}>{r.count}</span>
                </button>
              ))}
            </nav>
          )}

          {/* 分類 —— 也是可橫向捾動的 chip 列 */}
          <nav className={styles.drawerChips} aria-label="頻道分類">
            <button
              type="button"
              onClick={() => browser.setCategoryFilter(ALL_CATEGORY)}
              aria-pressed={browser.categoryFilter === ALL_CATEGORY}
            >
              全部
            </button>
            {catalog.categories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => browser.setCategoryFilter(cat.id as CategoryFilter)}
                aria-pressed={browser.categoryFilter === cat.id}
              >
                {cat.name}
              </button>
            ))}
          </nav>

          {browser.visibleChannels.length === 0 ? (
            <p className={styles.drawerEmpty}>{emptyMessage(browser.viewMode, browser.query)}</p>
          ) : (
            <ul className={styles.drawerGrid}>
              {browser.visibleChannels.map((channel) => (
                <li key={channel.channel_id}>
                  <button
                    type="button"
                    className={`${styles.drawerCard} ${
                      selected?.channel_id === channel.channel_id ? styles.drawerCardActive : ''
                    }`}
                    onClick={() => handleSelect(channel)}
                    aria-pressed={selected?.channel_id === channel.channel_id}
                  >
                    {/*
                     * 台標放在固定尺寸的框裡。
                     * 各頻道台標大小差異極大（20×20 到 300×80），
                     * 沒有固定框的話台標會溢出卡片、排版整個歪掉。
                     */}
                    <span className={styles.drawerLogoWrap}>
                      {channel.logo ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={channel.logo}
                          alt=""
                          className={styles.drawerLogo}
                          loading="lazy"
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      ) : (
                        <span className={styles.drawerLogoPlaceholder}>
                          {channel.channel_name.slice(0, 1)}
                        </span>
                      )}
                    </span>
                    <span className={styles.drawerCardName}>{channel.channel_name}</span>
                    <span className={styles.drawerCardCategory}>
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
        </div>
      </aside>

      <footer className={styles.footer}>
        <p>
          所有頻道均標註來源與授權狀態。未經授權的來源不會出現在本清單中。
        </p>
        <p className={styles.footerMeta}>
          schema v{catalog.schema_version} · APK 與網頁讀取同一份頻道資料 ·{' '}
          <a href="/privacy" className={styles.footerLink}>
            來源揭露與授權說明
          </a>
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
