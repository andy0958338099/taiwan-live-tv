'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import type { Channel } from '../lib/types';

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'error';

/**
 * 判斷瀏覽器是否應走「原生 HLS」路徑。
 *
 * 關鍵陷阱：**桌面版 Chromium 的 `canPlayType('application/vnd.apple.mpegurl')`
 * 會回傳 "maybe"，但它實際上無法播放原生 HLS**（那是 Safari 專屬的解碼路徑）。
 * 若只相信 canPlayType，Chromium 會被誤導進原生路徑，然後永遠卡在載入中。
 *
 * 因此判斷順序是：
 *  1. 明確是 Safari / iOS → 原生 HLS
 *  2. hls.js 支援（MSE） → 用 hls.js
 *  3. 其他仍回報支援原生 HLS → 退回原生（保險）
 *  4. 都不行 → 明確報錯
 */
export function shouldUseNativeHls(video: HTMLVideoElement): boolean {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';

  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ 預設偽裝成 Mac，需靠觸控點數判斷
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  // Safari 但排除 Chrome / Chromium / Edge / Opera（它們都帶 Safari 字樣）
  const isSafari =
    /Safari/.test(ua) && !/Chrome|Chromium|CriOS|Edg|EdgiOS|OPR|OPiOS|Android/.test(ua);

  if (isIOS || isSafari) {
    return video.canPlayType('application/vnd.apple.mpegurl') !== '';
  }

  return false;
}

/**
 * HLS 播放器 Hook。
 *
 * 設計原則：
 *  1. Safari / iOS 走原生 HLS，其他瀏覽器用 hls.js
 *  2. **播放失敗必須明確顯示錯誤** —— 絕不把無效串流假裝成正常播放
 *  3. 自動播放受瀏覽器政策限制：必須 muted + playsInline，並提供使用者點擊入口
 *  4. 載入逾時 watchdog：串流卡住時必須轉為錯誤，不能永遠顯示「連線中」
 */
export function useHlsPlayer(channel: Channel | null) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<PlayerStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [needsUserGesture, setNeedsUserGesture] = useState(false);
  const [nativeHls, setNativeHls] = useState(false);

  const teardown = useCallback(() => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
  }, []);

  /** 載入 watchdog：超過時限仍未開始播放 → 判定為失敗 */
  const armWatchdog = useCallback((target: Channel) => {
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    watchdogRef.current = setTimeout(() => {
      const video = videoRef.current;
      const started = video && video.readyState >= 3 && video.currentTime > 0;
      if (!started) {
        setStatus('error');
        setErrorMessage(
          `載入「${target.channel_name}」逾時。來源可能已失效、不支援跨網域存取（CORS），或需要登入。`,
        );
      }
    }, LOAD_TIMEOUT_MS);
  }, []);

  const startPlayback = useCallback(
    async (target: Channel) => {
      const video = videoRef.current;
      if (!video) return;

      teardown();
      setErrorMessage(null);
      setStatus('loading');
      armWatchdog(target);

      const url = target.stream_url;

      // --- 原生 HLS（Safari / iOS）---
      if (shouldUseNativeHls(video)) {
        setNativeHls(true);
        video.src = url;
        try {
          await video.play();
        } catch {
          // 自動播放被政策阻擋 → 要求使用者點擊
          setNeedsUserGesture(true);
          setStatus('idle');
        }
        return;
      }

      // --- hls.js ---
      setNativeHls(false);

      if (!Hls.isSupported()) {
        // 最後保險：瀏覽器不支援 MSE 但可能支援原生 HLS
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          setNativeHls(true);
          video.src = url;
          try {
            await video.play();
          } catch {
            setNeedsUserGesture(true);
            setStatus('idle');
          }
          return;
        }
        setErrorMessage('此瀏覽器不支援 HLS 播放（缺少 MediaSource 支援）');
        setStatus('error');
        return;
      }

      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 30,
        manifestLoadingTimeOut: 20_000,
        manifestLoadingMaxRetry: 2,
        levelLoadingTimeOut: 20_000,
        levelLoadingMaxRetry: 3,
        fragLoadingTimeOut: 30_000,
        fragLoadingMaxRetry: 4,
      });
      hlsRef.current = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (watchdogRef.current) {
          clearTimeout(watchdogRef.current);
          watchdogRef.current = null;
        }
        setStatus('playing');
        setNeedsUserGesture(false);
        video.play().catch(() => {
          setNeedsUserGesture(true);
          setStatus('idle');
        });
      });

      hls.on(Hls.Events.ERROR, (_event: string, data: { fatal: boolean; type: string; details: string }) => {
        if (!data.fatal) return;

        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            if (data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
                data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT) {
              setErrorMessage(
                '無法載入串流清單：來源可能未提供跨網域存取（CORS），或網址已失效',
              );
              setStatus('error');
              hls.startLoad();
            } else {
              setErrorMessage('網路錯誤：串流載入失敗');
              setStatus('error');
              hls.recoverMediaError();
            }
            break;

          case Hls.ErrorTypes.MEDIA_ERROR:
            setErrorMessage('媒體解碼錯誤：此串流的編碼格式可能不受支援');
            setStatus('error');
            hls.recoverMediaError();
            break;

          default:
            setErrorMessage(`播放失敗（${data.details || data.type}）`);
            setStatus('error');
            teardown();
            break;
        }
      });

      hls.loadSource(url);
      hls.attachMedia(video);
    },
    [armWatchdog, teardown],
  );

  // 頻道變更時重新載入
  useEffect(() => {
    if (!channel) {
      teardown();
      setStatus('idle');
      return;
    }
    void startPlayback(channel);
    return () => teardown();
  }, [channel, startPlayback, teardown]);

  // video 事件監聽
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlaying = () => {
      if (watchdogRef.current) {
        clearTimeout(watchdogRef.current);
        watchdogRef.current = null;
      }
      setStatus('playing');
      setErrorMessage(null);
    };
    const onWaiting = () => setStatus('loading');
    const onError = () => {
      // 原生 HLS 的錯誤：video.error 只有代碼，沒有詳細訊息
      if (nativeHls) {
        setErrorMessage('串流載入失敗：請確認來源網址有效且支援跨網域存取');
        setStatus('error');
      }
    };

    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('error', onError);

    return () => {
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('error', onError);
    };
  }, [nativeHls]);

  const retry = useCallback(() => {
    if (channel) void startPlayback(channel);
  }, [channel, startPlayback]);

  const resumeFromUserGesture = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      await video.play();
      setNeedsUserGesture(false);
      setStatus('playing');
    } catch {
      // 仍然失敗，保持提示
    }
  }, []);

  return {
    videoRef,
    status,
    errorMessage,
    needsUserGesture,
    nativeHls,
    retry,
    resumeFromUserGesture,
  };
}

const LOAD_TIMEOUT_MS = 25_000;
