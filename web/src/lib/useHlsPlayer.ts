'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import type { Channel } from '../lib/types';
import { isYouTubeEmbed, postYouTubeCommand, useEmbedPlayer } from './useEmbedPlayer';

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'error';

/**
 * 播放方式
 *
 * - `hls`  —— 直接以 HLS.js／原生 HLS 播放 m3u8
 * - `iframe` —— 以 iframe 嵌入官方播放器（YouTube IFrame Player、litv 播放器等）
 *
 * 為什麼需要 iframe 模式：
 *   查證發現，部分台灣頻道的官方直播頁本身就是以 iframe 內嵌播放器呈現
 *   （例如三立、東森用 litv 播放器；華視、中天、中視、鏡新聞、大愛用 YouTube）。
 *   這些播放器端點**沒有** X-Frame-Options 或 frame-ancestors 限制，
 *   等同官方已默許第三方嵌入 —— 屬於授權狀態 A。
 *
 *   這類來源多半「不提供公開 HLS manifest」，只有 iframe 可用。
 */
export type PlaybackMode = 'hls' | 'iframe';

export interface BackupSource {
  url: string;
  source?: string;
  cors?: boolean;
}

/**
 * 取得應該使用的串流網址。
 *
 * 三種情況需要走代理：
 *
 *  1. `cors_enabled === false` —— 來源不回傳 CORS 標頭，
 *     瀏覽器的同源政策會擋下 manifest 與 segment。
 *
 *  2. 來源是 **http://**（非 TLS）—— 站台本身是 https，
 *     瀏覽器會以「混合內容（mixed content）」直接封鎖該請求，
 *     而且連錯誤訊息都不會顯示。
 *     這是 TVBS 這類來源的實際情況（http://38.64.72.148/...）。
 *     走代理後由伺服器端發出請求，就沒有混合內容問題。
 *
 *  3. 來源是 **IP 位址** —— 部分來源直接用 IP，
 *     同樣透過代理避免瀏覽器的其他限制。
 *
 * 注意：代理會驗證目標網址確實在已授權的頻道清單中，不是開放代理。
 *
 * 代理會為 manifest 內的子資源加上簽章（`sig` 參數），
 * 那些簽章由代理端自行產生並驗證，前端不需要處理。
 */
export function resolveStreamUrl(channel: Channel): string {
  if (needsProxy(channel)) {
    return `/api/proxy?url=${encodeURIComponent(channel.stream_url)}`;
  }
  return channel.stream_url;
}

/**
 * 該頻道的串流是否必須經由代理。
 *
 * 抽出成獨立函式，讓主網址與備援網址用同一套判斷規則。
 */
export function needsProxy(channel: Channel): boolean {
  if (channel.cors_enabled === false) return true;
  const url = channel.stream_url;
  if (!url) return false;
  // 非 TLS → 混合內容封鎖
  if (url.startsWith('http://')) return true;
  return false;
}

/**
 * 取得應該使用的備援來源網址（同樣套用代理規則）。
 */
export function resolveBackupUrls(channel: Channel): string[] {
  const backups = channel.playlist_source?.backup_urls ?? [];
  return backups
    .map((b) => b.url)
    .filter(Boolean)
    .map((url) => {
      // 備援來源同樣可能是 http:// 或需要代理
      const needsIt =
        channel.cors_enabled === false || url.startsWith('http://');
      return needsIt
        ? `/api/proxy?url=${encodeURIComponent(url)}`
        : url;
    });
}

/** 頻道是否應使用 iframe 播放 */
export function playbackModeOf(channel: Channel | null): PlaybackMode {
  if (!channel) return 'hls';
  const embed = (channel as Channel & { embed_url?: string }).embed_url;
  return embed ? 'iframe' : 'hls';
}

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
 * HLS 播放器 Hook —— 支援備援來源自動切換。
 *
 * 設計原則：
 *  1. Safari / iOS 走原生 HLS，其他瀏覽器用 hls.js
 *  2. **播放失敗必須明確顯示錯誤** —— 絕不把無效串流假裝成正常播放
 *  3. 自動播放受瀏覽器政策限制：必須 muted + playsInline，並提供使用者點擊入口
 *  4. 載入逾時 watchdog：串流卡住時必須轉為錯誤，不能永遠顯示「連線中」
 *  5. **備援來源 failover**：主來源失敗時自動改用下一個來源。
 *     IPTV 清單的來源時常失效，這是必備功能而非選配。
 */
export function useHlsPlayer(channel: Channel | null) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  /**
   * video 元素放在 state（搭配 callback ref）。
   *
   * 原因：React 的 ref 賦值不會觸發 re-render。
   *   而 `<video>` 元素會在 HLS 模式與 iframe 模式之間被替換
   *   （兩個分支回傳不同的 JSX 樹），
   *   若事件監聽器只綁在 mount 時拿到的元素上，切換頻道後就會失效 ——
   *   結果是播放中永遠不會觸發取消靜音。
   */
  const [videoEl, setVideoElState] = useState<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 載入計時器的 interval handle（顯示已等待秒數） */
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** 卡頓 watchdog（緩衝持續耗盡時觸發 failover） */
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 目前頻道的 ref（供事件監聽器讀取當下值，避免過期閉包） */
  const channelRef = useRef<Channel | null>(null);
  /** 目前播放中的來源網址 ref */
  const activeUrlRef = useRef<string | null>(null);
  const [status, setStatus] = useState<PlayerStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [needsUserGesture, setNeedsUserGesture] = useState(false);
  const [nativeHls, setNativeHls] = useState(false);
  const [activeSourceIndex, setActiveSourceIndex] = useState(0);
  const [attemptedUrls, setAttemptedUrls] = useState<string[]>([]);

  /**
   * handleFailure 的 ref 指標。
   *
   * 宣告位置很重要：**必須在 startPlayback 之前**。
   *
   * 原因：`startPlayback` 的 useCallback deps 是 `[armWatchdog, teardown]`，
   * 兩者都穩定（`[]` deps），所以 startPlayback 永遠不會重建，
   * 它閉包裡的 `handleFailure` 會是「首次渲染時」的那一份 ——
   * 那時 channel 還是 null，candidateUrls() 回傳 []。
   *
   * 結果：錯誤訊息永遠顯示「已嘗試 0 個來源」，
   * 而且 `nextIndex < urls.length` 永不成立 → 備援 failover 從未生效。
   *
   * 用 ref 就能每次拿到當下的 handleFailure。
   */
  const handleFailureRef = useRef<
    ((target: Channel, failedUrl: string, reason: string) => void) | null
  >(null);

  /**
   * 載入已等待的秒數。
   *
   * 用途：避免「一直轉圈圈」讓使用者以為當機。
   * 慢速來源首個畫面可能要 10–30 秒，這段時間必須有可見的回饋。
   */
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  /**
   * 靜音狀態。
   *
   * 預設為「靜音」，但**播放一旦開始就自動取消靜音**。
   *
   * 為什麼要這麼做：瀏覽器的自動播放政策只允許「靜音自動播放」。
   *   但靜音自動播放需要 video.muted = true，否則 play() 會被拒絕。
   *
   *   解法：先以靜音狀態啟動（滿足自動播放政策），
   *   等 playing 事件觸發後再把 muted 設為 false。
   *   切換頻道本身是使用者點擊（user activation），
   *   因此取消靜音不會被 Chrome 暫停。
   */
  const [muted, setMuted] = useState(true);
  /** 使用者是否手動靜音（手動靜音後不再自動取消靜音） */
  const userMutedRef = useRef(false);
  /**
   * 是否期望保持「有聲播放」。
   *
   * Chrome 會在媒體變成有聲後非同步地自動暫停它。
   * 這個旗標讓常駐的 pause 監聽器知道：被暫停是 Chrome 的自動行為，
   * 應該重新 play() 讓它繼續，而不是當成使用者暫停。
   */
  const wantUnmutedRef = useRef(false);
  /**
   * iframe 播放器的網址與 key。
   *
   * key 用來強制重新掛載 iframe（切換靜音時需要重新載入播放器）；
   * src 則是實際載入的網址，可能與 channel.embed_url 不同（例如加了 mute=1）。
   */
  const [iframeSrc, setIframeSrc] = useState<string | null>(null);
  const [iframeKey, setIframeKey] = useState(0);

  const mode = playbackModeOf(channel);
  const embedUrl = (channel as (Channel & { embed_url?: string }) | null)?.embed_url ?? null;

  const teardown = useCallback(() => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
    if (stallTimerRef.current) {
      clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
  }, []);

  /** 取得該頻道的所有候選來源：主來源 + 備援（皆已套用代理規則） */
  const candidateUrls = useCallback((): string[] => {
    if (!channel) return [];
    const list: string[] = [];
    const primary = resolveStreamUrl(channel);
    if (primary) list.push(primary);
    for (const b of resolveBackupUrls(channel)) {
      if (!list.includes(b)) list.push(b);
    }
    return list;
  }, [channel]);

  /** 載入 watchdog：超過時限仍未開始播放 → 判定為失敗 */
  const armWatchdog = useCallback(
    (target: Channel, url: string) => {
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      watchdogRef.current = setTimeout(() => {
        const video = videoRef.current;
        const started = video && video.readyState >= 3 && video.currentTime > 0;
        if (!started) {
          void handleFailureRef.current?.(
            target,
            url,
            `載入「${target.channel_name}」逾時`,
          );
        }
      }, LOAD_TIMEOUT_MS);
    },
    // handleFailure 以 ref 引用避免循環相依
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const startPlayback = useCallback(
    async (target: Channel, url: string) => {
      const video = videoRef.current;
      if (!video) return;

      teardown();
      setErrorMessage(null);
      setStatus('loading');
      armWatchdog(target, url);

      // 開始計時：顯示已等待秒數，避免「一直轉圈圈」讓人以為當機
      setElapsedSeconds(0);
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = setInterval(() => {
        setElapsedSeconds((n) => n + 1);
      }, 1000);

      // 記錄當下的頻道與來源網址（供卡頓 watchdog 使用）
      channelRef.current = target;
      activeUrlRef.current = url;

      /**
       * 自動播放政策只允許「靜音自動播放」。
       * 所以啟動時一定要先設 muted = true，
       * 等 playing 事件觸發後再取消靜音（見 unmuteAndResume）。
       *
       * 使用者若已手動選擇靜音，就維持靜音不再自動取消。
       */
      video.muted = true;
      video.volume = 1;
      setMuted(true);
      // 新頻道：尚未嘗試取消靜音
      wantUnmutedRef.current = false;
      /**
       * 立刻呼叫 play()（此時仍是靜音）。
       *
       * 為什麼要在這裡就呼叫：
       *   Chrome 的自動播放政策允許「靜音自動播放」，但要求 play() 發生在
       *   使用者手勢的有效時間窗內。等 manifest 載完才呼叫 play()，
       *   手勢會失效 → 有聲自動播放被拒絕。
       *
       *   所以先在這裡（點擊手勢內）啟動播放（靜音），
       *   之後 playing 事件觸發時再取消靜音。
       */
      video.play().catch(() => {
        // 自動播放被拒絕 → 交由 needsUserGesture 提示使用者點擊
        setNeedsUserGesture(true);
      });

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
        // ⚠️ 逾時值需要配合「上游實際速度」設定。
        //
        // 實測央視來源的 segment 為 5.2 MB，但上游傳輸速度只有約 480 KB/s，
        // 單一個 segment 需 11–33 秒（視上游負載）。hls.js 預設的
        // fragLoadingTimeOut = 20 秒會直接判定失敗並放棄整個頻道。
        //
        // 代理已改成串流輸出（見 api/proxy/route.ts），
        // 第一個 chunk 通常 100ms 內就到達，但「下載完成」仍受上游速度限制。
        // 因此把逾時拉長到 90 秒，讓慢速來源有機會完成下載。
        manifestLoadingTimeOut: 40_000,
        manifestLoadingMaxRetry: 2,
        levelLoadingTimeOut: 40_000,
        levelLoadingMaxRetry: 3,
        fragLoadingTimeOut: 90_000,
        fragLoadingMaxRetry: 4,
        // 起始碼率：預設 -1 會從最低階開始再慢慢往上跳，
        // 電視螢幕大、等爬升的時間長，觀看體驗差。
        // 設為 2 表示從第 3 階起步（若只有 1–2 階則自動退到最後一階）。
        startLevel: 2,
        // 限制最高碼率不超過播放器尺寸，避免在低解析度裝置上浪費頻寬
        capLevelToPlayerSize: true,
        // ─────────────────────────────────────────────────────────
        // 以下是「避免一直轉圈圈」的關鍵設定
        // ─────────────────────────────────────────────────────────
        //
        // liveSyncDurationCount：hls.js 預設是 **3**，
        // 意思是「必須先下載 3 個 segment、湊滿 3 個 targetduration 的
        // 緩衝才開始播放」。
        //
        // 對慢速上游來說這是災難：segment 需 30 秒 → 要等 90 秒才有畫面。
        // 改成 1 表示「第一個 segment 到就播」，畫面立刻出現。
        // 代價是開頭可能有一次微小的卡頓（第二個 segment 還在下載），
        // 對直播來說這個取捨非常划算。
        liveSyncDurationCount: 1,
        // 直播的最大允許延遲（以 targetduration 為單位）。
        // 若播放器落後直播現場超過這個數量，就直接跳到最新位置，
        // 而不是慢慢追趕 —— 避免「一直轉圈等追上台」。
        liveMaxLatencyDurationCount: 10,
        //
        // 緩衝區大小 —— 直接影響「中途訊號斷掉」的耐受度。
        //
        // maxBufferLength：向前緩衝的最大長度（秒）。
        // 播放器會維持這麼多秒的已下載內容，網路短暫中斷時
        // 可以從緩衝繼續播，不會立刻停頓。
        //
        // 實測：央視來源的 segment 是 5.2 MB / 6 秒內容 ≈ 6.9 Mbps，
        // 而慢速上游只有約 480 KB/s（3.8 Mbps）—— **供不應求**，
        // 緩衝只會持續流失，加長 maxBufferLength 對這類來源沒有用。
        // 但對「上游夠快」的來源（TVBS 65ms 下載 5.2MB），
        // 30 秒緩衝足以吸收數秒的網路抖动。
        //
        // 這裡從 30 提高到 60：讓快速來源有更厚的安全餘裕，
        // 而慢速來源不會因此變慢（它本來就受上游速度限制）。
        maxBufferLength: 60,
        // maxMaxBufferLength：即使使用者暫停也要保留的上限。
        // 拉高避免「暫停一下就把緩衝清空」。
        maxMaxBufferLength: 120,
        // 後向緩衝（回看用的已播放內容）。
        backBufferLength: 60,
        // 允許在 manifest 載入中就開始準備第一個 fragment（預載）
        startFragPrefetch: true,
        // 片段載入失敗時不要無限重試同一個來源，
        // 直接讓上層的 failover 邏輯換來源。
        fragLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 30_000,
            maxLoadTimeMs: 90_000,
            timeoutRetry: { maxNumRetry: 2, retryDelayMs: 1000, maxRetryDelayMs: 4000 },
            errorRetry: { maxNumRetry: 2, retryDelayMs: 1000, maxRetryDelayMs: 4000 },
          },
        },
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

      /**
       * 第一個 segment 緩衝完成 → 真的有畫面了。
       *
       * 這裡才停止計時器：MANIFEST_PARSED 只代表清單讀到了，
       * 畫面還沒出現（慢速來源還在下載第一個 segment）。
       */
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        if (elapsedTimerRef.current) {
          clearInterval(elapsedTimerRef.current);
          elapsedTimerRef.current = null;
        }
      });

      hls.on(
        Hls.Events.ERROR,
        (_event: string, data: { fatal: boolean; type: string; details: string }) => {
          if (!data.fatal) return;

          /**
           * ⚠️ 必須用 `handleFailureRef.current`，不能直接用 `handleFailure`。
           *
           * 原因：`startPlayback` 的 useCallback deps 是 `[armWatchdog, teardown]`，
           * 兩者都是穩定的（`[]` deps），所以 **startPlayback 永遠不會重建**。
           * 它閉包裡的 `handleFailure` 因此是「首次渲染時」的那一份 ——
           * 那時 `channel` 還是 null，`candidateUrls()` 會回傳 `[]`。
           *
           * 結果就是：
           *   · 錯誤訊息永遠顯示「已嘗試 0 個來源」
           *   · `nextIndex < urls.length` 永遠不成立 → **備援 failover 從未生效**
           *
           * ref 的值會隨每次 render 更新（見下方 useEffect），
           * 因此永遠拿到當下的 channel 與 activeSourceIndex。
           */
          const fail = handleFailureRef.current;
          if (!fail) return;

          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              if (
                data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
                data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT
              ) {
                void fail(
                  target,
                  url,
                  '無法載入串流清單：來源可能未提供跨網域存取（CORS），或網址已失效',
                );
              } else {
                void fail(target, url, '網路錯誤：串流載入失敗');
              }
              break;

            case Hls.ErrorTypes.MEDIA_ERROR:
              void fail(
                target,
                url,
                '媒體解碼錯誤：此串流的編碼格式可能不受支援',
              );
              break;

            default:
              void fail(target, url, `播放失敗（${data.details || data.type}）`);
              break;
          }
        },
      );

      hls.loadSource(url);
      hls.attachMedia(video);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [armWatchdog, teardown],
  );

  /**
   * 播放失敗處理：嘗試下一個備援來源，全部失敗才顯示錯誤。
   */
  const handleFailure = useCallback(
    async (target: Channel, failedUrl: string, reason: string) => {
      const urls = candidateUrls();
      const currentIndex = urls.indexOf(failedUrl);
      const nextIndex = currentIndex >= 0 ? currentIndex + 1 : activeSourceIndex + 1;

      setAttemptedUrls((prev) => [...new Set([...prev, failedUrl])]);

      if (nextIndex < urls.length) {
        // 還有備援來源可試
        const nextUrl = urls[nextIndex];
        setActiveSourceIndex(nextIndex);
        console.info(
          `[播放器] 「${target.channel_name}」來源失敗（${reason}），改用備援來源 ${nextIndex + 1}/${urls.length}`,
        );
        await startPlayback(target, nextUrl);
        return;
      }

      // 所有來源都失敗
      teardown();
      setStatus('error');
      setErrorMessage(`${reason}。已嘗試 ${urls.length} 個來源（含備援）皆無法播放。`);
    },
    [candidateUrls, startPlayback, teardown, activeSourceIndex],
  );

  // handleFailure 的 ref 指標 —— 宣告在上面（startPlayback 之前），
  // 這裡負責把最新的 handleFailure 同步進去。
  useEffect(() => {
    handleFailureRef.current = handleFailure;
  }, [handleFailure]);

  /**
   * 取消靜音。
   *
   * HLS 模式：直接設 video.muted = false。
   * iframe 模式：
   *   - YouTube：用 IFrame Player API 下 unMute 指令（不需重新載入播放器）
   *   - 其他播放器：無法從外部控制，改用重新載入且移除 mute=1 的方式
   */
  /**
   * iframe 元素掛載回呼（由 VideoPlayer 當作 ref 使用）。
   *
   * 為什麼不用 ref 物件直接傳：React 的 ref 賦值不會觸發 re-render，
   *   useEffect 若依賴 ref.current 就不會重跑 —— handshake / 取消靜音的邏輯
   *   會永遠掛不上。所以改用 callback ref + state，讓元素掛載能觸發 effect。
   */
  const [iframeMounted, setIframeMounted] = useState<HTMLIFrameElement | null>(null);

  const setIframeEl = useCallback((el: HTMLIFrameElement | null) => {
    iframeRef.current = el;
    setIframeMounted(el);
  }, []);

  /** video 元素掛載回呼（由 VideoPlayer 當作 ref 使用） */
  const setVideoEl = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    setVideoElState(el);
  }, []);

  // 嵌入播放器的整合：litv handshake + YouTube 取消靜音
  useEmbedPlayer(iframeMounted, channel?.channel_id ?? null, embedUrl);

  /**
   * 取消靜音並確保播放繼續。
   *
   * 為什麼需要這麼多步驟（實測 Chrome 157 行為）：
   *   1. 瀏覽器的自動播放政策**只允許靜音自動播放**。
   *      所以 video 必須先以 muted = true 啟動，play() 才不會被拒絕。
   *   2. 播放開始後再取消靜音，Chrome 會因為「變成有聲但沒有使用者手勢」
   *      而**自動暫停**該媒體。
   *      → 所以取消靜音之後必須補一次 play() 讓它繼續。
   *   3. 若補 play() 仍被拒絕（例如 App 啟動時自動恢復上次頻道，完全沒有
   *      使用者互動），就退回靜音並提示使用者點擊。
   */
  /**
   * 取消靜音並確保播放繼續。
   *
   * 為什麼需要這麼多步驟（實測 Chrome 157）：
   *   1. 瀏覽器的自動播放政策**只允許靜音自動播放**。
   *      所以 video 必須先以 muted = true 啟動，play() 才不會被拒絕。
   *   2. 播放開始後再取消靜音，Chrome 會因為「變成有聲但沒有使用者手勢」
   *      而**非同步地自動暫停**該媒體。
   *      實測這個 pause 可能在取消靜音後好幾秒才發生，
   *      所以不能用「取消靜音後馬上看一眼」的短暫檢查，
   *      必須有一個常駐的監聽器：只要被 Chrome 暫停就重新 play()。
   *   3. 若重新 play() 仍被拒絕（例如完全沒有使用者互動），
   *      就退回靜音並提示使用者點擊。
   *
   * ⚠️ 關鍵：取消靜音必須發生在**使用者的點擊手勢之內**。
   *   Chrome 的規則是「媒體變成有聲的那一刻，使用者手勢必須仍然有效」。
   *   若等到串流載入完成（數秒後）才取消靜音，手勢早已失效 → Chrome 會暫停。
   *   因此在 startPlayback 裡就先設好 muted=false 並 play()，
   *   讓整個播放動作都落在點擊手勢的時間窗內。
   */
  const unmuteAndResume = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;

    video.muted = false;
    video.volume = 1;
    wantUnmutedRef.current = true;

    try {
      await video.play();
      setMuted(false);
      setNeedsUserGesture(false);
    } catch {
      // 沒有使用者手勢 → Chrome 不允許有聲自動播放 → 退回靜音
      wantUnmutedRef.current = false;
      video.muted = true;
      setMuted(true);
      try {
        await video.play();
      } catch {
        // 仍然無法播放，維持提示
      }
      setNeedsUserGesture(true);
    }
  }, []);
  const unmute = useCallback(() => {
    if (mode === 'iframe') {
      if (isYouTubeEmbed(embedUrl)) {
        postYouTubeCommand(iframeMounted, 'unMute');
        postYouTubeCommand(iframeMounted, 'setVolume', 100);
        setMuted(false);
        return;
      }
      if (!embedUrl) return;
      const next = embedUrl.replace(/([?&])mute=1(&|$)/, (_m, p1, p2) => (p2 ? p1 : ''));
      if (next !== embedUrl) {
        setIframeSrc(next);
        setIframeKey((k) => k + 1);
      }
      setMuted(false);
      return;
    }
    void unmuteAndResume();
  }, [mode, embedUrl, iframeMounted, unmuteAndResume]);

  /** 手動切換靜音 */
  const toggleMute = useCallback(() => {
    if (muted) {
      userMutedRef.current = false;
      unmute();
    } else {
      userMutedRef.current = true;
      wantUnmutedRef.current = false;
      if (mode === 'iframe') {
        if (isYouTubeEmbed(embedUrl)) {
          postYouTubeCommand(iframeMounted, 'mute');
          setMuted(true);
          return;
        }
        if (!embedUrl) return;
        const sep = embedUrl.includes('?') ? '&' : '?';
        setIframeSrc(`${embedUrl}${sep}mute=1`);
        setIframeKey((k) => k + 1);
      } else {
        const video = videoRef.current;
        if (video) video.muted = true;
      }
      setMuted(true);
    }
  }, [muted, unmute, mode, embedUrl]);

  // 頻道變更時重新載入
  useEffect(() => {
    if (!channel) {
      teardown();
      setStatus('idle');
      return;
    }
    if (mode === 'iframe') {
      // iframe 模式：交由 VideoPlayer 渲染 <iframe>，此處不做 HLS 處理
      setIframeSrc(embedUrl);
      setIframeKey((k) => k + 1);
      setStatus('playing');
      setErrorMessage(null);
      return;
    }
    setIframeSrc(null);
    const urls = candidateUrls();
    setActiveSourceIndex(0);
    setAttemptedUrls([]);
    if (urls.length > 0) {
      void startPlayback(channel, urls[0]);
    }
    return () => teardown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, candidateUrls, mode, embedUrl]);

  // video 事件監聽
  //
  // 依賴 videoEl（元素本身）而不是 videoRef.current ——
  // `<video>` 元素會在 HLS 模式與 iframe 模式切換時被替換，
  // 若依賴 ref.current，監聽器會綁在已被移除的元素上，之後就再也收不到事件。
  useEffect(() => {
    const video = videoEl;
    if (!video) return;

    const onPlaying = () => {
      if (watchdogRef.current) {
        clearTimeout(watchdogRef.current);
        watchdogRef.current = null;
      }
      // 恢復播放 → 取消卡頓 watchdog（剛才是短暫卡頓，不是供應不足）
      if (stallTimerRef.current) {
        clearTimeout(stallTimerRef.current);
        stallTimerRef.current = null;
      }
      setStatus('playing');
      setErrorMessage(null);

      /**
       * 播放已開始 → 取消靜音（除非使用者手動靜音過）。
       *
       * 這裡刻意「同步」設定 muted（不 await）：
       *   Chrome 的規則是「媒體變成有聲的那一刻，使用者手勢必須仍有效」。
       *   playing 事件是在 play() 成功後觸發的，此時若 play() 是由
       *   使用者手勢觸發的（我們在 startPlayback 裡就呼叫了 play()），
       *   手勢仍在有效窗內 → 立刻取消靜音就能持續播放。
       *
       *   若改成 await 之後才設 muted，中間的 microtask 會讓手勢失效，
       *   Chrome 就會自動暫停媒體（實測會停在 t=10）。
       */
      if (!userMutedRef.current) {
        const v = videoRef.current;
        if (v) {
          v.muted = false;
          v.volume = 1;
          wantUnmutedRef.current = true;
          setMuted(false);
          // 補一次 play()：若 Chrome 因變成有聲而暫停，這裡會讓它繼續
          v.play().catch(() => {
            wantUnmutedRef.current = false;
            v.muted = true;
            setMuted(true);
            setNeedsUserGesture(true);
          });
        }
      }
    };
    /**
     * 緩衝耗盡（卡頓）的處理。
     *
     * `waiting` 事件 = 播放器的緩衝空了，必須等下一個 segment。
     * 短暫卡頓是正常的（緩衝會補上），但**連續卡頓**代表這個來源
     * 的供應速度跟不上消耗速度 —— 再怎麼等也補不回來。
     *
     * 這裡的做法：
     *   1. 每次 waiting 記錄時間戳，並啟動一個 stall watchdog
     *   2. 若 watchdog 期限到了仍在 waiting（= 緩衝一直補不上），
     *      就觸發 failover 換來源
     *   3. 若中途恢復播放（playing），就取消 watchdog
     *
     * 這對「慢速上游」特別重要：央視來源的 segment 是 5.2 MB / 6 秒內容，
     * 而上游只有 480 KB/s —— 永遠補不回來。
     * 與其讓使用者盯著轉圈圈，不如自動換到快一點的備援來源。
     */
    const onWaiting = () => {
      setStatus('loading');

      if (stallTimerRef.current) return; // 已在計時中

      const target = channelRef.current;
      const url = activeUrlRef.current;
      if (!target || !url) return;

      stallTimerRef.current = setTimeout(() => {
        stallTimerRef.current = null;
        const v = videoRef.current;
        // 已經恢復播放 → 不是真的卡住
        if (!v || v.paused === false) return;
        if (v.readyState >= 3) return;

        console.warn(
          `[播放器] 「${target.channel_name}」緩衝持續耗盡 ${STALL_TIMEOUT_MS}ms，改用備援來源`,
        );
        void handleFailureRef.current?.(
          target,
          url,
          '此來源供應速度不足，播放持續卡頓',
        );
      }, STALL_TIMEOUT_MS);
    };

    /**
     * Chrome 的自動暫停處理。
     *
     * 當媒體從靜音變成有聲，Chrome 會非同步地暫停它（沒有使用者手勢）。
     * 這裡偵測到被暫停且我們期望有聲播放時，就重新 play() 讓它繼續。
     *
     * 若是使用者自己按了暫停（wantUnmutedRef 為 false），則不做任何事。
     */
    const onPause = () => {
      if (!wantUnmutedRef.current || userMutedRef.current) return;
      const v = videoRef.current;
      if (!v || v.ended) return;
      v.play().catch(() => {
        // 沒有使用者手勢 → 退回靜音
        wantUnmutedRef.current = false;
        v.muted = true;
        setMuted(true);
        setNeedsUserGesture(true);
      });
    };

    const onError = () => {
      if (nativeHls) {
        setErrorMessage('串流載入失敗：請確認來源網址有效且支援跨網域存取');
        setStatus('error');
      }
    };

    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('pause', onPause);
    video.addEventListener('error', onError);

    return () => {
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('error', onError);
    };
  }, [nativeHls, videoEl, unmuteAndResume]);

  const retry = useCallback(() => {
    if (!channel) return;
    if (mode === 'iframe') {
      // iframe 模式由上層重新掛載 iframe（改 key 即可）
      setAttemptedUrls([]);
      setStatus('playing');
      setErrorMessage(null);
      return;
    }
    const urls = candidateUrls();
    if (urls.length === 0) return;
    // 重試時從第一個來源重新開始
    setActiveSourceIndex(0);
    setAttemptedUrls([]);
    void startPlayback(channel, urls[0]);
  }, [channel, candidateUrls, startPlayback, mode]);

  const resumeFromUserGesture = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      // 使用者點擊 = 有使用者手勢 → 可以直接以有聲方式播放
      video.muted = false;
      video.volume = 1;
      await video.play();
      setNeedsUserGesture(false);
      setMuted(false);
      setStatus('playing');
    } catch {
      // 仍然失敗，保持提示
    }
  }, []);

  /**
   * 手動切換到下一個來源。
   *
   * 為什麼需要這個：慢速來源可能讓使用者等 30 秒以上才有畫面。
   * 與其讓使用者乾等，不如給他一個按鈕立刻換來源。
   */
  const skipSource = useCallback(() => {
    if (!channel) return;
    if (mode === 'iframe') return;
    const urls = candidateUrls();
    if (urls.length === 0) return;
    const nextIndex = activeSourceIndex + 1;
    if (nextIndex >= urls.length) return;
    setActiveSourceIndex(nextIndex);
    setAttemptedUrls([]);
    void startPlayback(channel, urls[nextIndex]);
  }, [channel, mode, candidateUrls, activeSourceIndex, startPlayback]);

  return {
    videoRef,
    iframeRef,
    setIframeEl,
    setVideoEl,
    status,
    errorMessage,
    needsUserGesture,
    nativeHls,
    retry,
    resumeFromUserGesture,
    activeSourceIndex,
    totalSources: candidateUrls().length,
    mode,
    embedUrl: iframeSrc,
    iframeKey,
    muted,
    toggleMute,
    elapsedSeconds,
    skipSource,
  };
}

/**
 * 載入 watchdog 逾時。
 *
 * 實測部分中國來源的 segment 高達 5.2 MB，而上游傳輸速度只有約 480 KB/s，
 * 單一個 segment 需 11–33 秒。加上 manifest 載入時間，25 秒會誤判失敗。
 *
 * 這裡設 60 秒：足以讓慢速來源完成第一個 segment，
 * 又不會讓使用者無限等待（超過後會自動改用備援來源）。
 */
const LOAD_TIMEOUT_MS = 60_000;

/**
 * 卡頓 watchdog 逾時。
 *
 * 這是「緩衝持續耗盡」的判定時間，不是網路抖動的容忍度。
 *
 * 設定依據：慢速來源的 segment 下載需 10–30 秒，
 * 若給太短（例如 5 秒）會把正常的短暫等待誤判成卡死，
 * 導致頻繁切換來源反而更不順。
 * 25 秒足以讓「segment 剛好下載完」的情況正常恢復，
 * 又能在來源真的供不應求時及早切換。
 */
const STALL_TIMEOUT_MS = 25_000;
