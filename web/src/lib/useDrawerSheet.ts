'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * 底部頻道抽屜 —— 可拖曳的三段式（peek／半屏／全屏）。
 *
 * ## 為什麼要自己寫拖曳
 *
 * 瀏覽器沒有「吸附式底部抽屜」的原生元件，
 * 而 `<dialog>` 的 `showModal()` 是模態對話框（背景不可互動、
 * 強制 focus trap），跟「可選頻道的抽屜」語意不符。
 * 自己寫 pointer events 才有完整控制權。
 *
 * ## 三段的意義
 *
 * | 段 | 高度 | 用途 |
 * |---|---|---|
 * | peek | 148px | 只露出把手與一點內容，提示「下面還有東西」 |
 * | half | 45vh | **預設** —— 選頻道的主要工作區 |
 * | full | 88vh | 看完整清單 / 大量頻道時 |
 *
 * ## 影片必須永遠可見
 *
 * 抽屜是 `position: fixed` 的浮層，會蓋住頁面底部。
 * 所以頁面把抽屜高度寫進 CSS 變數 `--drawer-h`，
 * 播放器用 `max-height` / `width` 依剩餘空間縮放，
 * 確保**任何抽屜高度下影片都還看得到**（不足時以 letterbox 顯示）。
 */
export type SheetStage = 'closed' | 'peek' | 'half' | 'full';

/** peek 段的高度（px）—— 只露出把手與標題列 */
export const PEEK_HEIGHT = 148;
/** half 段佔視窗高度的比例 */
export const HALF_RATIO = 0.45;
/** full 段佔視窗高度的比例 */
export const FULL_RATIO = 0.88;

export interface DrawerSheet {
  /** 目前停在哪一段 */
  stage: SheetStage;
  /** 是否展開（closed 以外都算） */
  open: boolean;
  /** 目前高度（px）—— 拖曳中會是中間值 */
  height: number;
  /** 展開（預設停在 half） */
  openDrawer: () => void;
  /** 收起 */
  closeDrawer: () => void;
  /** 切換（收起時以 half 展開） */
  toggleDrawer: () => void;
  /** 直接跳到某一段 */
  setStage: (stage: SheetStage) => void;
  /** 把手上的 pointer 事件處理 */
  onGripPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onGripPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
  onGripPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
}

/**
 * 內容區最小高度（px）。
 *
 * 抽屜拉到最高時，播放器縮小但內容區仍要留一點空間，
 * 否則「現在在播」資訊會被完全擠掉。
 */
const CONTENT_MIN_HEIGHT = 90;

export function useDrawerSheet(headerRef?: React.RefObject<HTMLElement | null>): DrawerSheet {
  const [stage, setStage] = useState<SheetStage>('closed');
  /** 拖曳中的即時高度；null = 不在拖曳 */
  const [liveHeight, setLiveHeight] = useState<number | null>(null);
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window === 'undefined' ? 800 : window.innerHeight,
  );
  /** 頁首的實際高度（實測，不是猜的） */
  const [headerHeight, setHeaderHeight] = useState(64);

  /** 拖曳狀態（用 ref 避免每次移動都重繪） */
  const dragRef = useRef<{ startY: number; startHeight: number; moved: boolean } | null>(
    null,
  );
  /** liveHeight 的鏡像 —— pointerup 時要讀到最新的拖曳高度 */
  const liveHeightRef = useRef<number | null>(null);

  useEffect(() => {
    liveHeightRef.current = liveHeight;
  }, [liveHeight]);

  // 視窗尺寸變化（旋轉、縮放）時重算各段高度
  useEffect(() => {
    const onResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  // 實測頁首高度 —— 換行時（手機窄螢幕）高度會變
  useEffect(() => {
    const el = headerRef?.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      setHeaderHeight(el.getBoundingClientRect().height);
    });
    ro.observe(el);
    setHeaderHeight(el.getBoundingClientRect().height);
    return () => ro.disconnect();
  }, [headerRef]);

  const peekPx = PEEK_HEIGHT;
  const halfPx = Math.round(viewportHeight * HALF_RATIO);
  const fullPx = Math.round(viewportHeight * FULL_RATIO);

  const stageHeight = useCallback(
    (s: SheetStage): number => {
      switch (s) {
        case 'peek':
          return peekPx;
        case 'half':
          return halfPx;
        case 'full':
          return fullPx;
        case 'closed':
        default:
          return 0;
      }
    },
    [peekPx, halfPx, fullPx],
  );

  const height = liveHeight ?? stageHeight(stage);

  /**
   * 把抽屜高度寫進 CSS 變數。
   *
   * 播放器（VideoPlayer.module.css）用 `--drawer-h` 計算自己該縮到多小，
   * 這是「任何高度都保留影片可見」的機制。
   */
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--drawer-h', `${height}px`);

    /**
     * 播放器最大高度 = 視窗高度 − 抽屜高度 − 頁首 − 內容區最小高度。
     *
     * 剩下的空間扣掉後，播放器剛好填滿，**不會被抽屜蓋到**。
     *
     * 140px 是下限 —— 抽屜拉到全屏時，影片仍留一條可見的畫面
     * （完全消失會讓使用者以為網頁壞了）。
     */
    const available =
      viewportHeight - height - headerHeight - CONTENT_MIN_HEIGHT;
    root.style.setProperty('--player-max-h', `${Math.max(140, available)}px`);

    return () => {
      root.style.removeProperty('--drawer-h');
      root.style.removeProperty('--player-max-h');
    };
  }, [height, viewportHeight, headerHeight]);

  const openDrawer = useCallback(() => {
    setLiveHeight(null);
    setStage('half');
  }, []);

  const closeDrawer = useCallback(() => {
    setLiveHeight(null);
    setStage('closed');
  }, []);

  const toggleDrawer = useCallback(() => {
    setLiveHeight(null);
    setStage((s) => (s === 'closed' ? 'half' : 'closed'));
  }, []);

  const onGripPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (stage === 'closed') return;
      // 只接受主按鍵
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* 某些環境不支援 capture —— 不影響功能 */
      }
      dragRef.current = {
        startY: e.clientY,
        startHeight: height,
        moved: false,
      };
    },
    [height, stage],
  );

  const onGripPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const d = dragRef.current;
      if (!d) return;
      const delta = e.clientY - d.startY;
      if (Math.abs(delta) > 3) d.moved = true;
      // 往上拖 → 變高
      const next = Math.min(fullPx, Math.max(0, d.startHeight - delta));
      setLiveHeight(next);
    },
    [fullPx],
  );

  const onGripPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }

      const current = liveHeightRef.current ?? d.startHeight;

      // 沒實際拖動 → 當成點擊：half ↔ peek 切換
      if (!d.moved) {
        setLiveHeight(null);
        setStage((s) => (s === 'full' ? 'half' : s === 'half' ? 'peek' : 'half'));
        return;
      }

      setLiveHeight(null);

      // 往下拖過半 → 收起
      if (current < peekPx * 0.45) {
        setStage('closed');
        return;
      }

      // 否則吸附到最接近的一段
      const candidates: SheetStage[] = ['peek', 'half', 'full'];
      let best: SheetStage = 'half';
      let bestDist = Infinity;
      for (const c of candidates) {
        const dist = Math.abs(stageHeight(c) - current);
        if (dist < bestDist) {
          bestDist = dist;
          best = c;
        }
      }
      setStage(best);
    },
    [peekPx, stageHeight],
  );

  return {
    stage,
    open: stage !== 'closed',
    height,
    openDrawer,
    closeDrawer,
    toggleDrawer,
    setStage,
    onGripPointerDown,
    onGripPointerMove,
    onGripPointerUp,
  };
}
