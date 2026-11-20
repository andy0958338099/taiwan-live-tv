'use client';

import { useEffect, useRef, useState } from 'react';
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
  /** 目前使用的是第幾個來源（0 = 主來源） */
  activeSourceIndex: number;
  /** 該頻道的來源總數 */
  totalSources: number;
  /** iframe 模式的官方嵌入網址（非 null 時以 iframe 播放） */
  embedUrl?: string | null;
  /** 目前頻道的 ID（litv handshake 需要） */
  channelId?: string | null;
  /** iframe 的 key（切換靜音時需要重新掛載） */
  iframeKey?: number;
  /** iframe 元素掛載回呼（供 litv handshake / YouTube 取消靜音使用） */
  onIframeMount?: (el: HTMLIFrameElement | null) => void;
  /** video 元素掛載回呼（供事件監聽綁定使用） */
  onVideoMount?: (el: HTMLVideoElement | null) => void;
  /** 目前是否靜音 */
  muted?: boolean;
  /** 切換靜音 */
  onToggleMute?: () => void;
  /** 已等待的秒數（載入中顯示，避免使用者以為當機） */
  elapsedSeconds?: number;
  /** 是否可切換到下一個來源（載入過久時提供手動切換） */
  onSkipSource?: () => void;
  /** 還有幾個備援來源可切換 */
  remainingSources?: number;
}

/**
 * 播放器元件。
 *
 * 錯誤處理原則：**明確顯示錯誤，不假裝在播**。
 * - loading → 顯示載入指示
 * - error → 顯示錯誤訊息 + 重試按鈕
 * - needsUserGesture → 顯示「點擊播放」遮罩（瀏覽器自動播放政策）
 * - 使用備援來源中 → 顯示提示，讓使用者知道已自動切換
 *
 * 兩種播放模式：
 * - `embedUrl` 有值 → iframe 嵌入官方播放器（官方已默許嵌入的來源）
 * - 否則 → HLS 直連播放
 */
export function VideoPlayer({
  videoRef,
  status,
  errorMessage,
  needsUserGesture,
  onRetry,
  onUserGesture,
  channelName,
  activeSourceIndex,
  totalSources,
  embedUrl,
  channelId,
  iframeKey = 0,
  onIframeMount,
  onVideoMount,
  muted = true,
  onToggleMute,
  elapsedSeconds,
  onSkipSource,
  remainingSources,
}: VideoPlayerProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [localIframeKey, setLocalIframeKey] = useState(0);

  // 自動播放被政策阻擋時，把焦點移到遮罩讓使用者能直接按 Enter
  useEffect(() => {
    if (needsUserGesture) {
      overlayRef.current?.focus();
    }
  }, [needsUserGesture]);

  const usingBackup = activeSourceIndex > 0 && totalSources > 1;

  // iframe 模式：重試 = 重新掛載 iframe
  const handleRetry = () => {
    if (embedUrl) {
      setLocalIframeKey((k) => k + 1);
    }
    onRetry();
  };

  if (embedUrl) {
    return (
      <div className={styles.playerShell}>
        <iframe
          key={`${iframeKey}-${localIframeKey}`}
          ref={onIframeMount}
          className={styles.playerIframe}
          src={embedUrl}
          title={`${channelName} 直播畫面`}
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
        {onToggleMute && (
          <button
            type="button"
            className={styles.muteToggle}
            onClick={onToggleMute}
            aria-label={muted ? '取消靜音' : '靜音'}
            title={muted ? '取消靜音' : '靜音'}
          >
            {muted ? '🔇' : '🔊'}
          </button>
        )}
        {status === 'error' && (
          <div className={styles.playerOverlayError} role="alert">
            <div className={styles.playerOverlay}>
              <h2 className={styles.playerOverlayTitle}>播放失敗</h2>
              <p className={styles.playerOverlayText}>
                {errorMessage ?? '無法播放此串流'}
              </p>
              <button type="button" className={styles.retryBtn} onClick={handleRetry}>
                重新載入播放器
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={styles.playerShell}>
      {/*
        注意：這裡刻意不設 muted 屬性。
        自動播放政策要求啟動瞬間是靜音的，但播放一旦開始就必須取消靜音。
        muted 的切換由 useHlsPlayer 在 playing 事件時處理。
      */}
      <video
        ref={onVideoMount}
        className={styles.playerVideo}
        playsInline
        controls
        preload="metadata"
        aria-label={`${channelName} 直播畫面`}
      />

      {onToggleMute && (
        <button
          type="button"
          className={styles.muteToggle}
          onClick={onToggleMute}
          aria-label={muted ? '取消靜音' : '靜音'}
          title={muted ? '取消靜音' : '靜音'}
        >
          {muted ? '🔇' : '🔊'}
        </button>
      )}

      {status === 'loading' && (
        <div className={styles.playerOverlay} role="status" aria-live="polite">
          <div className={styles.spinner} aria-hidden="true" />
          <p className={styles.playerOverlayText}>
            {usingBackup
              ? `連線中…（已切換至備援來源 ${activeSourceIndex + 1}/${totalSources}）`
              : '連線中…'}
          </p>
          {/*
           * 載入回饋：避免「一直轉圈圈」讓人以為當機。
           *
           * 慢速來源（實測央視 segment 5.2MB / 480KB/s）首個畫面可能要 10–30 秒，
           * 這期間若只有一個無聲的轉圈圈，使用者無從判斷是「還在載入」還是「壞了」。
           * 這裡顯示：
           *   1. 已等待秒數（讓人知道程式還活著）
           *   2. 超過 12 秒後說明「來源較慢」並提供「換一個來源」按鈕
           */}
          {elapsedSeconds !== undefined && elapsedSeconds > 3 && (
            <p className={styles.loadingHint}>已等待 {elapsedSeconds} 秒</p>
          )}
          {elapsedSeconds !== undefined && elapsedSeconds > 12 && (
            <p className={styles.loadingHint}>
              此來源傳輸較慢，可能需要 20–30 秒才會出現畫面。
            </p>
          )}
          {onSkipSource && remainingSources !== undefined && remainingSources > 0 && (
            <button
              type="button"
              className={styles.retryBtn}
              onClick={onSkipSource}
            >
              換一個來源（還有 {remainingSources} 個）
            </button>
          )}
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
            <button type="button" className={styles.retryBtn} onClick={handleRetry}>
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
