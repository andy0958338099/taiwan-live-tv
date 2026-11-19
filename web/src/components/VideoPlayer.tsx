'use client';

import { useEffect, useRef } from 'react';
import type { PlayerStatus } from '../lib/useHlsPlayer';
import styles from './VideoPlayer.module.css';

interface VideoPlayerProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  status: PlayerStatus;
  errorMessage: string | null;
  needsUserGesture: boolean;
  onRetry: () => void;
  onUserGesture: () => void;
  channelName: string;
}

/**
 * 播放器元件。
 *
 * 錯誤處理原則：**明確顯示錯誤，不假裝在播**。
 * - loading → 顯示載入指示
 * - error → 顯示錯誤訊息 + 重試按鈕
 * - needsUserGesture → 顯示「點擊播放」遮罩（瀏覽器自動播放政策）
 */
export function VideoPlayer({
  videoRef,
  status,
  errorMessage,
  needsUserGesture,
  onRetry,
  onUserGesture,
  channelName,
}: VideoPlayerProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null);

  // 自動播放被政策阻擋時，把焦點移到遮罩讓使用者能直接按 Enter
  useEffect(() => {
    if (needsUserGesture) {
      overlayRef.current?.focus();
    }
  }, [needsUserGesture]);

  return (
    <div className={styles.playerShell}>
      <video
        ref={videoRef}
        className={styles.playerVideo}
        playsInline
        muted
        controls
        preload="metadata"
        aria-label={`${channelName} 直播畫面`}
      />

      {status === 'loading' && (
        <div className={styles.playerOverlay} role="status" aria-live="polite">
          <div className={styles.spinner} aria-hidden="true" />
          <p className={styles.playerOverlayText}>連線中…</p>
        </div>
      )}

      {status === 'error' && (
        <div className={styles.playerOverlayError} role="alert">
          <div className={styles.playerOverlay}>
            <h2 className={styles.playerOverlayTitle}>播放失敗</h2>
            <p className={styles.playerOverlayText}>{errorMessage ?? '無法播放此串流'}</p>
            <p className={styles.playerOverlayHint}>
              若此頻道顯示在網頁版但無法播放，通常代表該來源未提供跨網域存取（CORS），
              或是來源網址已失效。Android TV 版不受此限制。
            </p>
            <button type="button" className={styles.retryBtn} onClick={onRetry}>
              重新連線
            </button>
          </div>
        </div>
      )}

      {needsUserGesture && status !== 'error' && (
        <div
          className={styles.playerOverlay}
          ref={overlayRef}
          tabIndex={0}
          role="button"
          onClick={onUserGesture}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onUserGesture();
            }
          }}
        >
          <div className={styles.playBadge} aria-hidden="true">
            ▶
          </div>
          <p className={styles.playerOverlayText}>點擊開始播放 {channelName}</p>
        </div>
      )}
    </div>
  );
}
