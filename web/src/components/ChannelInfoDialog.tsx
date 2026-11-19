'use client';

import { useEffect } from 'react';
import type { Channel } from '../lib/types';
import styles from './ChannelInfoDialog.module.css';

/**
 * 頻道資訊對話框。
 *
 * 顯示來源、授權狀態與官方網站 —— 這是本專案「來源透明」承諾的一部分，
 * 使用者隨時可以知道自己在看的內容來自哪裡、授權狀態是什麼。
 */
export function ChannelInfoDialog({
  channel,
  categoryName,
  onClose,
}: {
  channel: Channel | null;
  categoryName: string;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!channel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [channel, onClose]);

  if (!channel) return null;

  return (
    <div
      className={styles.dialogBackdrop}
      role="dialog"
      aria-modal="true"
      aria-label={`${channel.channel_name} 頻道資訊`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.dialog}>
        <header className={styles.dialogHeader}>
          <h2 className={styles.dialogTitle}>{channel.channel_name}</h2>
          <button
            type="button"
            className={styles.dialogClose}
            onClick={onClose}
            aria-label="關閉"
          >
            ✕
          </button>
        </header>

        <div className={styles.dialogBody}>
          <dl className={styles.dialogList}>
            <dt>分類</dt>
            <dd>{categoryName}</dd>

            <dt>簡介</dt>
            <dd>{channel.description || '—'}</dd>

            <dt>來源</dt>
            <dd>{channel.source_name}</dd>

            <dt>官方網站</dt>
            <dd>
              <a href={channel.source_website} target="_blank" rel="noopener noreferrer">
                {channel.source_website}
              </a>
            </dd>

            <dt>授權狀態</dt>
            <dd>
              <span className={`${styles.authBadge} ${styles[`auth_${channel.authorization_status}`]}`}>
                {authorizationLabel(channel.authorization_status)}
              </span>
            </dd>

            <dt>串流格式</dt>
            <dd>{channel.stream_type.toUpperCase()}</dd>

            <dt>最後檢查</dt>
            <dd>{formatTime(channel.last_checked)}</dd>

            {channel.tags && channel.tags.length > 0 && (
              <>
                <dt>關鍵字</dt>
                <dd>{channel.tags.join('、')}</dd>
              </>
            )}
          </dl>
        </div>

        <footer className={styles.dialogFooter}>
          <p className={styles.dialogNote}>
            本頻道標示的授權狀態為「{authorizationLabel(channel.authorization_status)}」。
            若你發現來源已變更或不再允許嵌入，請告知以便更新頻道清單。
          </p>
          <button type="button" className={styles.dialogActionBtn} onClick={onClose}>
            關閉
          </button>
        </footer>
      </div>
    </div>
  );
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
