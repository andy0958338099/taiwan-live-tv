'use client';

import { useEffect, useRef } from 'react';
import type { Channel } from './types';

/**
 * 桌面版鍵盤選台 —— ↑↓ 換台、數字鍵直選頻道號。
 *
 * ## 為什麼要這個
 *
 * 傳統遙控器就是「上下鍵換台 + 數字鍵選台號」。
 * 桌面版有實體鍵盤卻不能用，等於放棄了 TV app 最核心的操作模型
 * （也是 Apple HIG / YouTube TV 都假設的使用者肌肉記憶）。
 *
 * ## 設計細節
 *
 * · **只在桌面（≥1024px）啟用** —— 數字鍵在輸入框裡是必要的，
 *   手機上虛擬鍵盤沒有實體數字鍵，啟用反而困擾使用者。
 * · **數字鍵支援多位數**：頻道號碼 1–162，台灣本地台 1 起、境外 100 起。
 *   所以「1」按下後**不立即跳台**，等 600ms 看有沒有後續數字，
 *   否則「10」會被「1」搶先。
 * · **↑↓ 在已開啟的抽屜裡是移動選取焦點**，關閉時才是直接換台 ——
 *   兩種情境的直覺不同。
 * · 輸入框 / textarea / contenteditable 內一律不攔截。
 *
 * ## ⚠️ 為什麼資料都放 refs（重要）
 *
 * 第一版把 `channels` / `currentId` / `onSelect` 直接放進 effect 的依賴陣列。
 * 結果 **`onSelect` 是 page.tsx 裡的 inline arrow function，每次 render
 * 都是新的參考點** → effect 每次 render 都重跑 → cleanup 把
 * `numTimerRef` 裡還沒觸發的 600ms 計時器 `clearTimeout` 掉。
 *
 * 結果是：**按數字鍵後，只要 600ms 內有任何一次 re-render
 * （播放器狀態更新、EPG 更新、抽屜動畫……），
 * 這次選台就會被無聲地取消。**
 *
 * 線上實測重現：按「3」後播放器/EPG 觸發一次 re-render，
 * 頻道沒有切換；本機測試因為時序不同而通過 —— 典型的「本機過、線上壞」。
 *
 * 修法：event listener 只在 `enabled` 改變時掛載，
 * 資料一律透過 refs 讀取，計時器只在卸載時清除。
 *
 * @param channels  目前可見的頻道清單（決定 ↑↓ 的順序與數字鍵的對應）
 * @param currentId 目前選中的頻道 ID
 * @param onSelect  選取頻道的回呼
 * @param enabled   是否啟用（桌機 + 非輸入狀態）
 */
export function useKeyboardChannelNav({
  channels,
  currentId,
  onSelect,
  enabled,
}: {
  channels: Channel[];
  currentId: string | null;
  onSelect: (channel: Channel) => void;
  enabled: boolean;
}) {
  /** 數字鍵輸入緩衝 */
  const numBufferRef = useRef<string>('');
  const numTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 資料用 refs 保存，避免 effect 依賴它們。
   *
   * 每次 render 更新 ref 的內容，但**不觸發** listener 重新掛載。
   */
  const channelsRef = useRef(channels);
  const currentIdRef = useRef(currentId);
  const onSelectRef = useRef(onSelect);
  channelsRef.current = channels;
  currentIdRef.current = currentId;
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (!enabled) return;

    const isTypingTarget = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      if (!el || !el.tagName) return false;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true;
      return el.isContentEditable === true;
    };

    const flushNumberBuffer = () => {
      const buf = numBufferRef.current;
      numBufferRef.current = '';
      if (numTimerRef.current) {
        clearTimeout(numTimerRef.current);
        numTimerRef.current = null;
      }
      if (!buf) return;
      const num = Number(buf);
      if (!Number.isFinite(num)) return;
      const hit = channelsRef.current.find((c) => c.channel_number === num);
      if (hit) onSelectRef.current(hit);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;

      // ── ↑↓ 換台 ──
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const list = channelsRef.current;
        if (list.length === 0) return;
        e.preventDefault();
        const idx = list.findIndex((c) => c.channel_id === currentIdRef.current);
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        // 沒選中 → Down 選第一個、Up 選最後一個
        const next =
          idx === -1
            ? e.key === 'ArrowDown'
              ? 0
              : list.length - 1
            : (idx + delta + list.length) % list.length;
        onSelectRef.current(list[next]);
        return;
      }

      // ── 數字鍵直選頻道號 ──
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        numBufferRef.current += e.key;
        if (numTimerRef.current) clearTimeout(numTimerRef.current);
        // 等 600ms 看有沒有下一位數字
        numTimerRef.current = setTimeout(flushNumberBuffer, 600);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      // ⚠️ 只在 listener 真的被拆掉時清計時器。
      //    這裡 `enabled` 是唯一的依賴，所以正常 render 不會走到這行 ——
      //    數字鍵的選台不會被中途 re-render 取消。
      if (numTimerRef.current) {
        clearTimeout(numTimerRef.current);
        numTimerRef.current = null;
      }
    };
  }, [enabled]);
}
