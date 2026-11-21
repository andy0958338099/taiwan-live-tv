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
  /** 已等待的秒數（載入中顯示，避免使用者以為當機） */
  elapsedSeconds?: number;
  /** 是否可切換到下一個來源（載入過久時提供手動切換） */
  onSkipSource?: () => void;
  /** 還有幾個備援來源可切換 */
  remainingSources?: number;
  /** 是否已選取頻道（false 時顯示「選擇頻道」提示） */
  hasChannel?: boolean;
  /** 開啟頻道選擇抽屜 */
  onOpenPicker?: () => void;
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
  elapsedSeconds,
  onSkipSource,
  remainingSources,
  /**
   * 是否已選取頻道。
   *
   * 沒有頻道時播放器是一片空白，使用者會以為「壞了」或「沒有頻道可選」。
   * 這時在播放器中央顯示「選擇頻道」提示，直接引導到抽屜。
   */
  hasChannel = true,
  /** 開啟頻道選擇抽屜（提示中的按鈕） */
  onOpenPicker,
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
        {/*
         * iframe 模式的靜音按鈕也一併移除（理由同 HLS 模式）。
         */}
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

      {/*
       * 靜音按鈕已移除。
       *
       * 使用者要求：「點選頻道後不要靜音，也不用出現喇叭標記」。
       *
       * 原本這裡有一個 🔇/🔊 的切換按鈕。它存在的唯一理由是
       * 「Chrome 的自動播放政策要求先靜音才能自動播放」——
       * 但使用者已經用點擊選台（真實手勢），Chrome 允許有聲自動播放，
       * 所以那個按鈕對我們的流程一點用都沒有，只有視覺噪音。
       *
       * 音量的控制交給瀏覽器內建的 `controls`（影片右下角的齒輪icon）。
       */}

      {/*
       * 未選頻道時的提示。
       *
       * 沒有這個提示，使用者看到的就是一片空白的播放器，
       * 會以為「沒有頻道可選」或「網站壞了」。
       * 這裡直接給一個可點擊的按鈕引導到頻道清單。
       */}
      {!hasChannel && (
        <div className={styles.pickerHint}>
          <span className={styles.pickerHintIcon} aria-hidden="true">
            📺
          </span>
          <h2 className={styles.pickerHintTitle}>尚未選擇頻道</h2>
          <p className={styles.pickerHintText}>
            點下方按鈕開啟頻道清單，從 90 個直播頻道中挑選
          </p>
          {onOpenPicker && (
            <button type="button" className={styles.retryBtn} onClick={onOpenPicker}>
              選擇頻道
            </button>
          )}
        </div>
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
