'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Channel, ChannelCatalog } from '../lib/types';
import { fetchCatalog } from '../lib/catalog';
import { useChannelBrowser, type ViewMode } from '../lib/useChannelBrowser';
import { useHlsPlayer } from '../lib/useHlsPlayer';
import { useDrawerSheet } from '../lib/useDrawerSheet';
import { useKeyboardChannelNav } from '../lib/useKeyboardChannelNav';
import { VideoPlayer } from '../components/VideoPlayer';
import { ChannelInfoDialog } from '../components/ChannelInfoDialog';
import { ChannelRail } from '../components/ChannelRail';
import { SegmentedSelect } from '../components/SegmentedSelect';
import styles from './page.module.css';

const ALL_CATEGORY = '__all__';

export default function Home() {
  const [catalog, setCatalog] = useState<ChannelCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Channel | null>(null);
  const [showInfo, setShowInfo] = useState(false);

  /**
   * 底部頻道抽屜 —— 可拖曳三段（peek／半屏／全屏）。
   *
   * 與舊版的差別：不再是「固定藏起 + 整個滑出」，而是**常駐底部的抽屜**，
   * 使用者可以拖到任一段；抽屜高度寫進 `--drawer-h`，
   * 播放器依此縮放，**任何高度下影片都還看得到**。
   */
  const headerRef = useRef<HTMLElement | null>(null);
  const sheet = useDrawerSheet(headerRef);
  const footerRef = useRef<HTMLElement | null>(null);

  // --- 把 Netlify 徽章搬進頁尾 ---
  //
  // Netlify 平台會注入一個 `position: fixed; bottom: 0; right: 0` 的
  // iframe（`#nl-badge-frame`），預設會**浮在內容上** —— 抽屜開著時
  // 它正好壓在右下角的頻道卡片上。
  //
  // 純 CSS 無解（它是 fixed 且在 body 底下），所以用 JS 把它搬到 `<footer>`，
  // 再由 CSS 在頁尾裡定位。這樣：
  //   · 徽章不再壓住任何內容
  //   · 仍然是平台的 attribution，沒有移除
  //
  // ⚠️ 徽章是**延後注入**的（Next.js hydration 之後才會出現），
  //    所以除了馬上搬一次，還要用 MutationObserver 持續守候。
  useEffect(() => {
    const relocate = () => {
      const footer = footerRef.current;
      if (!footer) return;
      const badge = document.getElementById('nl-badge-frame');
      if (!badge) return;
      if (badge.parentElement !== footer) footer.appendChild(badge);
    };

    relocate();
    const observer = new MutationObserver(relocate);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

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

  /**
   * 選取頻道。
   *
   * @param close 是否順便收起抽屜
   *
   * ⚠️ `prepareForChannelSwitch()` 必須在**點擊手勢內**同步呼叫。
   *
   * 頻道切換會走 `setSelected()` → React 渲染 → useEffect → startPlayback，
   * 而 useEffect 是在 paint 之後才跑的，已經離開使用者的點擊手勢時間窗。
   *
   * Chrome 的自動播放政策要求「媒體變成有聲的那一刻，使用者手勢必須仍有效」，
   * 所以這裡先把手勢記下並解除靜音，後續的 useEffect 就不會把音量關回去。
   * 少了這一步，慢速來源會讓使用者靜靜聽 50 秒的靜音。
   */
  const selectChannel = useCallback(
    (channel: Channel, close: boolean) => {
      player.prepareForChannelSwitch();
      setSelected(channel);
      browser.markWatched(channel.channel_id);
      if (close) sheet.closeDrawer();
    },
    [player, browser, sheet],
  );

  // 點擊卡片 / 台標 → 選台並收起
  const handleSelect = useCallback(
    (channel: Channel) => selectChannel(channel, true),
    [selectChannel],
  );

  // 鍵盤選台 → 選台但**不收起**（使用者還在瀏覽清單）
  const handleKeyboardSelect = useCallback(
    (channel: Channel) => selectChannel(channel, false),
    [selectChannel],
  );

  /**
   * 桌面版鍵盤選台（≥1024px）：↑↓ 換台、數字鍵直選頻道號。
   *
   * 數字鍵在輸入框內必須放行（搜尋框要能打數字），
   * 所以這裡只掛載在「不是輸入焦點」且「視窗夠寬」的時候。
   */
  const [isWide, setIsWide] = useState(false);
  const [focusInInput, setFocusInInput] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const sync = () => setIsWide(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  // 追蹤焦點是否在輸入框（搜尋框打字時不能觸發數字鍵選台）
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      setFocusInInput(
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable),
      );
    };
    const onFocusOut = () => setFocusInInput(false);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  useKeyboardChannelNav({
    channels: browser.visibleChannels,
    currentId: selected?.channel_id ?? null,
    onSelect: handleKeyboardSelect,
    enabled: isWide && !focusInInput,
  });

  // --- Esc 關閉抽屜 / 快捷鍵開啟 ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;

      if (e.key === 'Escape') {
        sheet.closeDrawer();
        return;
      }
      // `c` 或 `n` 開啟頻道選擇（電視遙控器常見的操作習慣）
      if ((e.key === 'c' || e.key === 'C' || e.key === 'n' || e.key === 'N') && !sheet.open) {
        e.preventDefault();
        sheet.openDrawer();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheet]);

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

  const favorites = new Set(browser.favorites);

  return (
    <main className={styles.page}>
      <header className={styles.header} ref={headerRef}>
        <div className={styles.brandBlock}>
          <h1 className={styles.title}>台灣電視直播</h1>
          <p className={styles.subtitle}>
            {catalog.channels.length} 個頻道 · 資料更新於 {formatTime(catalog.updated_at)}
          </p>
        </div>

        {/*
         * 唯一的頻道入口 —— 「頻道 ▾」。
         *
         * 舊版有兩個 CTA：右上角的浮動把手 + 播放器中央的「選擇頻道」。
         * 兩個都在說同一件事（「開頻道清單」），使用者要猜哪個才是入口。
         * 現在頁首只留這一顆；播放器的空狀態則只留它自己的「選擇頻道」。
         */}
        <button
          type="button"
          className={styles.headerChannelBtn}
          onClick={sheet.toggleDrawer}
          aria-label="選擇頻道"
          aria-expanded={sheet.open}
          aria-controls="channel-drawer"
        >
          <span className={styles.headerChannelBtnIcon} aria-hidden="true">
            📺
          </span>
          頻道
          <span className={styles.headerChannelBtnCaret} aria-hidden="true">
            ▾
          </span>
        </button>
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
          channelCount={browser.visibleChannels.length}
          onOpenPicker={sheet.openDrawer}
          officialUrl={selected?.source_website ?? null}
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
                {favorites.has(selected.channel_id) ? '取消收藏' : '加入收藏'}
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
          底部頻道抽屜（可拖曳三段）
          ------------------------------------------------------------
          布局是 flex 直向：頁首 → 內容（可捲動）→ 抽屜（固定高度）。
          抽屜高度寫在 `--drawer-h`，播放器用它計算自己該縮到多小，
          因此**任何高度下影片都還看得到**。
          ====================================================== */}

      <div className={styles.content}>
        <footer className={styles.footer} ref={footerRef}>
          <p>所有頻道均標註來源與授權狀態。未經授權的來源不會出現在本清單中。</p>
          <p className={styles.footerMeta}>
            schema v{catalog.schema_version} · APK 與網頁讀取同一份頻道資料 ·{' '}
            <a href="/privacy" className={styles.footerLink}>
              來源揭露與授權說明
            </a>
          </p>
        </footer>
      </div>

      {/* 抽屜本體 */}
      <aside
        id="channel-drawer"
        className={`${styles.drawer} ${sheet.open ? styles.drawerOpen : ''}`}
        style={{ height: sheet.open ? sheet.height : 0 }}
        aria-label="頻道選擇"
        aria-hidden={!sheet.open}
      >
        {/* 拖曳把手 —— 加寬加陰影，並可拖曳切換三段 */}
        <button
          type="button"
          className={styles.drawerGrip}
          onPointerDown={sheet.onGripPointerDown}
          onPointerMove={sheet.onGripPointerMove}
          onPointerUp={sheet.onGripPointerUp}
          onPointerCancel={sheet.onGripPointerUp}
          aria-label="調整抽屜高度"
        >
          <span className={styles.drawerGripBar} aria-hidden="true" />
        </button>

        <div className={styles.drawerHead}>
          <h2 className={styles.drawerTitle}>
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
            onClick={sheet.closeDrawer}
            aria-label="收起頻道選擇"
          >
            收起
          </button>
        </div>

        <div className={styles.drawerBody}>
          {/* 搜尋 —— 放在最上面且 sticky，捲動時不會消失 */}
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
           * 放在最上面（搜尋框之後、頁籤之前），因為它是「快速換台」用的；
           * 而下方的網格是「瀏覽完整清單」用的。兩者分工明確，不重複。
           */}
          <ChannelRail
            channels={browser.visibleChannels}
            selectedId={selected?.channel_id ?? null}
            epg={catalog.epg}
            categories={catalog.categories}
            onSelect={handleSelect}
          />

          {/*
           * 篩選列 —— 單行，不換行。
           *
           * 舊版是三排 chip（頁籤 + 地區 + 類型），chip 會換行，
           * 把頻道卡片擠到畫面外，「一屏看到更多」完全落空。
           * 現在：頁籤收成單行橫向捲動，地區／類型改成兩顆下拉。
           */}
          <div className={styles.filterRow}>
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
                  {mode === 'favorites' && browser.favorites.length > 0 && (
                    <span className={styles.chipCount}>{browser.favorites.length}</span>
                  )}
                </button>
              ))}
            </nav>

            <div className={styles.filterSelects}>
              {browser.regions.length > 1 && (
                <SegmentedSelect
                  label="地區"
                  value={browser.regionFilter}
                  allId={ALL_CATEGORY}
                  allLabel="全部"
                  options={browser.regions.map((r) => ({
                    id: r.id,
                    name: r.name,
                    count: r.count,
                  }))}
                  onChange={browser.setRegionFilter}
                />
              )}
              <SegmentedSelect
                label="類型"
                value={browser.categoryFilter}
                allId={ALL_CATEGORY}
                allLabel="全部"
                options={catalog.categories.map((c) => ({ id: c.id, name: c.name }))}
                onChange={browser.setCategoryFilter}
              />
            </div>
          </div>

          {browser.visibleChannels.length === 0 ? (
            <p className={styles.drawerEmpty}>{emptyMessage(browser.viewMode, browser.query)}</p>
          ) : (
            <ul className={styles.drawerGrid}>
              {browser.visibleChannels.map((channel) => {
                const isActive = selected?.channel_id === channel.channel_id;
                const isFav = favorites.has(channel.channel_id);
                return (
                  <li key={channel.channel_id} className={styles.drawerCardWrap}>
                    <button
                      type="button"
                      /**
                       * ⭐ 穩定識別碼 —— 測試腳本靠它找到頻道卡片。
                       *
                       * 為什麼需要這個屬性：
                       *   CSS module 會把 `.drawerCardName` 編譯成
                       *   `<hash>_drawerCardName`，而且**類別名一改就會跟著改**。
                       *   測試腳本若用 `[class*="cardName"]` 這種子字串選擇器，
                       *   在類別改名後會**永遠匹配不到**（實測 2026-11-22：
                       *   抽屜重設計把 `.cardName` 改成 `.drawerCardName`，
                       *   大小寫不同 → `[class*="cardName"]` 匹配 0 個，
                       *   導致 embed 頻道測試 10/10 全數誤判為失敗）。
                       *
                       *   `data-channel-id` 不受 CSS 改名影響，
                       *   而且語意明確（ChannelRail 早已使用同一個屬性）。
                       *
                       * `data-card-kind="grid"` 區分「網格卡片」與
                       * 「台標列項目」—— 兩者都有 data-channel-name，
                       * 但只有網格卡片有收藏星號。
                       */
                      data-channel-id={channel.channel_id}
                      data-channel-name={channel.channel_name}
                      data-card-kind="grid"
                      className={`${styles.drawerCard} ${
                        isActive ? styles.drawerCardActive : ''
                      }`}
                      onClick={() => handleSelect(channel)}
                      aria-pressed={isActive}
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
                        {isActive && (
                          <span className={styles.cardLiveBadge} aria-hidden="true">
                            LIVE
                          </span>
                        )}
                      </span>
                      <span className={styles.drawerCardName}>{channel.channel_name}</span>
                      <span className={styles.drawerCardCategory}>
                        {catalog.categories.find((c) => c.id === channel.category)?.name ??
                          channel.category}
                      </span>
                    </button>

                    {/*
                     * 收藏星號 —— 獨立按鈕（不能巢狀在卡片按鈕裡，否則 HTML 非法）。
                     *
                     * 放在卡片右上角，點擊不會觸發換台（`stopPropagation`）。
                     * 收藏狀態由 `useChannelBrowser` 持久化到 localStorage。
                     */}
                    <button
                      type="button"
                      className={`${styles.cardStar} ${isFav ? styles.cardStarOn : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        browser.toggleFav(channel.channel_id);
                      }}
                      aria-label={
                        isFav
                          ? `取消收藏 ${channel.channel_name}`
                          : `收藏 ${channel.channel_name}`
                      }
                      aria-pressed={isFav}
                    >
                      <span aria-hidden="true">{isFav ? '★' : '☆'}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>
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

function emptyMessage(mode: ViewMode, query: string): string {
  if (mode === 'favorites') return '尚未收藏任何頻道。點卡片右上角的星號即可加入。';
  if (mode === 'recent') return '尚無觀看紀錄。';
  if (query.trim()) return `找不到符合「${query}」的頻道。`;
  return '目前沒有可顯示的頻道。';
}
