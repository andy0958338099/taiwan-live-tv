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
      const hit = channels.find((c) => c.channel_number === num);
      if (hit) onSelect(hit);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;

      // ── ↑↓ 換台 ──
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (channels.length === 0) return;
        e.preventDefault();
        const idx = channels.findIndex((c) => c.channel_id === currentId);
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        // 沒選中 → Down 選第一個、Up 選最後一個
        const next =
          idx === -1
            ? e.key === 'ArrowDown'
              ? 0
              : channels.length - 1
            : (idx + delta + channels.length) % channels.length;
        onSelect(channels[next]);
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
      if (numTimerRef.current) clearTimeout(numTimerRef.current);
    };
  }, [channels, currentId, onSelect, enabled]);
}
