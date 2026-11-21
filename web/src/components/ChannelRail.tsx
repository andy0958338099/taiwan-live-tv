'use client';

import { useEffect, useRef } from 'react';
import type { Channel } from '../lib/types';
import { epgTime, getEpg, type EpgCatalog } from '../lib/epg';
import styles from './ChannelRail.module.css';

/**
 * ChannelRail —— 橫向台標列 + 「現在在播」面板
 *
 * ## 為什麼是這個設計
 *
 * 參考 Apple HIG「Live-Viewing Apps」、YouTube TV、Samsung TV Plus、
 * Plex、Tellyfin —— 這些成熟 TV app 的頻道選擇都是**橫向排列的台標**，
 * 不是縱向網格。原因：
 *
 *   1. **台標是最快的視覺辨識特徵** —— 掃一排就能找到要的頻道，
 *      不需要讀文字。
 *   2. **橫向捲動符合電視遙控器的直覺** —— 左���右就是換頻道。
 *   3. **在手機上更省力** —— 90 個頻道縱向捲動要滑很久，
 *      橫向滑動（尤其配合 LIVE 徽章）能快速掃過。
 *   4. **與播放器並存** —— 橫列的垂直高度固定，播放器不被推擠。
 *
 * ## 這個元件的職責
 *
 *   · 頂部是「現在在播」面板（EPG）—— Apple HIG 明確要求選台時
 *     要能看到正在播什麼，否則使用者只能靠台標猜。
 *   · 下面是橫向台標列，每格顯示台標、頻道號碼、目前播放中標記。
 *   · 沒有 EPG 的頻道只顯示台標與名稱，不會出現空白欄位。
 */

interface ChannelRailProps {
  channels: Channel[];
  selectedId: string | null;
  epg: EpgCatalog | null | undefined;
  categories: { id: string; name: string }[];
  onSelect: (channel: Channel) => void;
}

export function ChannelRail({
  channels,
  selectedId,
  epg,
  categories,
  onSelect,
}: ChannelRailProps) {
  const railRef = useRef<HTMLUListElement>(null);

  // 選中的頻道變動時，把它捲進視野
  useEffect(() => {
    if (!selectedId || !railRef.current) return;
    const el = railRef.current.querySelector<HTMLElement>(
      `[data-channel-id="${CSS.escape(selectedId)}"]`,
    );
    if (!el) return;
    const rail = railRef.current;
    const elLeft = el.offsetLeft;
    const elRight = elLeft + el.offsetWidth;
    const viewLeft = rail.scrollLeft;
    const viewRight = viewLeft + rail.clientWidth;
    if (elLeft < viewLeft || elRight > viewRight) {
      rail.scrollTo({
        left: elLeft - rail.clientWidth / 2 + el.offsetWidth / 2,
        behavior: 'smooth',
      });
    }
  }, [selectedId, channels.length]);

  const selected = channels.find((c) => c.channel_id === selectedId) ?? null;
  const selectedEpg = getEpg(epg, selectedId);
  const categoryName = selected
    ? (categories.find((c) => c.id === selected.category)?.name ?? selected.category)
    : '';

  if (channels.length === 0) return null;

  return (
    <section className={styles.wrap} aria-label="快速選台">
      {/*
       * 「現在在播」—— 只有在有節目表時才顯示。
       * 沒有節目表時顯示頻道名稱與分類，不留空白。
       */}
      {selected && (
        <div className={styles.epgPanel}>
          <div className={styles.epgHead}>
            <span className={styles.epgLabel}>● LIVE</span>
            <span className={styles.epgChannel}>{selected.channel_name}</span>
            {categoryName && <span className={styles.epgCategory}>{categoryName}</span>}
          </div>

          {selectedEpg?.current ? (
            <>
              <p className={styles.epgTitle}>{selectedEpg.current.title}</p>
              <p className={styles.epgMeta}>
                <span className={styles.epgTime}>{epgTime(selectedEpg.current.start)}</span>
                {selectedEpg.current.end && (
                  <>
                    <span className={styles.epgDash}>–</span>
                    <span className={styles.epgTime}>{selectedEpg.current.end}</span>
                  </>
                )}
                {selectedEpg.current.age_rating && (
                  <span className={styles.epgRating}>{selectedEpg.current.age_rating}</span>
                )}
              </p>
              {selectedEpg.current.description && (
                <p className={styles.epgDesc}>{selectedEpg.current.description}</p>
              )}

              {selectedEpg.upcoming.length > 0 && (
                <div className={styles.epgNext}>
                  {selectedEpg.upcoming.slice(0, 3).map((u, i) => (
                    <span key={`${u.start}-${i}`} className={styles.epgNextItem}>
                      <span className={styles.epgNextTime}>{epgTime(u.start)}</span>
                      {u.title}
                    </span>
                  ))}
                </div>
              )}

              <p className={styles.epgSource}>節目表來源：{selectedEpg.source}</p>
            </>
          ) : (
            <p className={styles.epgNoSchedule}>
              這個頻道暫時沒有可用的官方節目表，僅顯示即時直播。
            </p>
          )}
        </div>
      )}

      {/*
       * 橫向台標列。
       *
       * 用 <ul>/<li> 保有語意（螢幕閱讀器會 announce 列表項數量）。
       */}
      <ul className={styles.rail} ref={railRef}>
        {channels.map((channel, index) => {
          const isActive = channel.channel_id === selectedId;
          return (
            <li key={channel.channel_id}>
              <button
                type="button"
                data-channel-id={channel.channel_id}
                /**
                 * ⭐ 穩定識別碼。
                 *
                 * CSS module 的類別名是編譯後的雜湊值，改名就會變，
                 * 測試腳本用 `[class*="..."]` 匹配會在改名後失效。
                 * `data-channel-name` 不受 CSS 改名影響，
                 * 而且與抽屜卡片使用同一個屬性語意。
                 */
                data-channel-name={channel.channel_name}
                data-card-kind="rail"
                className={`${styles.item} ${isActive ? styles.itemActive : ''}`}
                onClick={() => onSelect(channel)}
                aria-pressed={isActive}
                aria-label={`${channel.channel_name}${isActive ? '（正在播放）' : ''}`}
              >
                {/*
                 * 頻道號碼 —— 傳統遙控器數字鍵選台的對應。
                 * 只在有號碼時顯示。
                 */}
                {channel.channel_number != null && (
                  <span className={styles.number}>{channel.channel_number}</span>
                )}

                <span className={styles.logoWrap}>
                  {channel.logo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={channel.logo}
                      alt=""
                      className={styles.logo}
                      loading="lazy"
                      decoding="async"
                      onError={(e) => {
                        const img = e.currentTarget;
                        img.style.display = 'none';
                        const ph = img.parentElement?.querySelector<HTMLElement>(
                          `.${styles.logoPlaceholder}`,
                        );
                        if (ph) ph.style.display = 'grid';
                      }}
                    />
                  ) : null}
                  <span
                    className={styles.logoPlaceholder}
                    style={
                      channel.logo
                        ? { display: 'none' }
                        : undefined
                    }
                  >
                    {channel.channel_name.slice(0, 1)}
                  </span>

                  {/* LIVE 徽章 —— 業界標準 */}
                  {isActive && (
                    <span className={styles.liveBadge} aria-hidden="true">
                      LIVE
                    </span>
                  )}
                </span>

                <span className={styles.name}>{channel.channel_name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
