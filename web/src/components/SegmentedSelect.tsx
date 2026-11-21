'use client';

import { useEffect, useId, useRef, useState } from 'react';
import styles from './SegmentedSelect.module.css';

/**
 * SegmentedSelect —— 用於「地區」「類型」的分段式下拉選單。
 *
 * ## 為什麼是下拉而不是 chip 列
 *
 * 原本地區 + 類型是兩排 chip（各 4–8 個），在抽屜裡吃掉大量垂直空間，
 * 而且 chip 會**換行**（`flex-wrap` 的預設行為），讓「一屏看到更多頻道」落空。
 *
 * 改成下拉後：
 *   · 篩選列固定**單行**（不會換行、不会被推擠）
 *   · 兩顆 segmented control 佔一行，下方直接就是頻道卡片
 *
 * ## 為什麼仍要顯示數量
 *
 * chip 上原本有頻道數量 badge —— 那是「不用點了才知道點下去有幾台」的設計。
 * 下拉選單裡同樣保留數量，這個資訊不能因為換成下拉就丟掉。
 *
 * ## 無障礙
 *
 * 使用原生 `<button>` + `aria-expanded` / `aria-haspopup="listbox"`，
 * 選項是真正的 `<button role="option">`，可鍵盤操作。
 */

export interface SegmentedOption {
  id: string;
  name: string;
  count?: number;
}

interface SegmentedSelectProps {
  /** 分段控制器的標籤（「地區」「類型」） */
  label: string;
  /** 目前選取的項目 id */
  value: string;
  /** 選項清單 */
  options: SegmentedOption[];
  /** 「全部」選項的 id */
  allId: string;
  /** 「全部」選項的顯示文字 */
  allLabel: string;
  onChange: (id: string) => void;
}

export function SegmentedSelect({
  label,
  value,
  options,
  allId,
  allLabel,
  onChange,
}: SegmentedSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const current = options.find((o) => o.id === value);
  const currentLabel = current?.name ?? allLabel;

  // 點外面 → 關閉
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const all: SegmentedOption = { id: allId, name: allLabel };

  return (
    <div className={styles.wrap} ref={rootRef}>
      <button
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerOpen : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
      >
        <span className={styles.triggerLabel}>{label}</span>
        <span className={styles.triggerValue}>{currentLabel}</span>
        <span className={styles.chevron} aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className={styles.menu} id={listId} role="listbox" aria-label={label}>
          <MenuItem
            option={all}
            active={value === allId}
            onSelect={() => {
              onChange(allId);
              setOpen(false);
            }}
          />
          {options.map((o) => (
            <MenuItem
              key={o.id}
              option={o}
              active={value === o.id}
              onSelect={() => {
                onChange(o.id);
                setOpen(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  option,
  active,
  onSelect,
}: {
  option: SegmentedOption;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      className={`${styles.item} ${active ? styles.itemActive : ''}`}
      onClick={onSelect}
    >
      <span className={styles.itemName}>{option.name}</span>
      {option.count !== undefined && (
        <span className={styles.itemCount}>{option.count}</span>
      )}
    </button>
  );
}
