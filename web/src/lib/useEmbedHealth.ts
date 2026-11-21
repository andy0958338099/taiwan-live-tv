'use client';

import { useEffect, useState } from 'react';

/**
 * 官方嵌入播放器的「健康狀態」偵測。
 *
 * 為什麼需要：這 10 個台灣頻道（中天、三立、華視、中視、東森 51、鏡新聞、寰宇、
 * 大愛、公視）沒有可用的 HLS 源，只能嵌官方播放器。而官方 embed 有兩種常見故障：
 *
 *   1. YouTube 直播 ID 會輪替 —— 舊 ID 對應的直播結束後，iframe 只會顯示一個
 *      「這部影片已結束」的黑畫面，網頁本身完全無感。
 *   2. litv／4gtv 外殼頁在換憑證或改版時，iframe 會載不出來。
 *
 * 兩種情況使用者看到的都是「一片黑」，然後以為是網站壞了。
 * 這個 hook 把「可能失效」變成可見狀態，讓播放器可以提示使用者。
 *
 * 判定來源：
 *   - YouTube：我們已在 embed 網址加上 `enablejsapi=1`，所以能收到 postMessage，
 *     可以直接拿到 `onStateChange`（1=播放中）與 `onError`（150/153 等）。
 *   - litv／4gtv：跨網域拿不到內部狀態，只能用 `load` 事件 + 逾時判斷。
 *
 * 刻意保守：判定不出來時回 `unknown`，不亂報警；只有「明確錯誤」或
 * 「超過時限完全沒動靜」才會標成 suspect／dead。
 */

export type EmbedHealth = 'unknown' | 'playing' | 'suspect' | 'dead';

const YOUTUBE_ORIGIN = 'https://www.youtube.com';

/** YouTube 播放器狀態碼 → 播放中 */
const PLAYING_STATES = new Set([1, 3]); // 1 = playing, 3 = buffering

interface Options {
  /** 非同步播放器多久沒回報就算異常（毫秒） */
  timeoutMs?: number;
}

export function useEmbedHealth(
  iframe: HTMLIFrameElement | null,
  embedUrl: string | null | undefined,
  options: Options = {},
): { health: EmbedHealth; errorCode: number | null } {
  const [health, setHealth] = useState<EmbedHealth>('unknown');
  const [errorCode, setErrorCode] = useState<number | null>(null);
  const timeoutMs = options.timeoutMs ?? 18000;

  useEffect(() => {
    setHealth('unknown');
    setErrorCode(null);

    if (!iframe || !embedUrl) return;

    const isYouTube = embedUrl.startsWith(YOUTUBE_ORIGIN);
    let cancelled = false;
    let loaded = false;

    const onLoad = () => {
      loaded = true;
      registerListener();
    };

    /**
     * YouTube 只會把事件送給「已註冊 listening」的父頁。
     *
     * 沒有送這個訊息，iframe 內部播得再順，我們也收不到任何 onStateChange／onError，
     * 於是「沒收到狀態」與「真的失效」就分不出來 —— 實測就是這樣誤報的。
     */
    const registerListener = () => {
      if (!isYouTube) return;
      try {
        iframe.contentWindow?.postMessage(
          JSON.stringify({ event: 'listening', id: 'embed-health', channel: 'widget' }),
          YOUTUBE_ORIGIN,
        );
      } catch {
        // iframe 尚未完成導航時可能拋錯，忽略
      }
    };
    registerListener();
    const registerTimers = isYouTube
      ? [800, 2000, 4000].map((ms) => window.setTimeout(registerListener, ms))
      : [];

    iframe.addEventListener('load', onLoad);

    const markPlaying = () => {
      if (!cancelled) setHealth((h) => (h === 'dead' ? h : 'playing'));
    };
    const markDead = (code: number | null) => {
      if (cancelled) return;
      if (typeof code === 'number' && Number.isFinite(code)) setErrorCode(code);
      setHealth('dead');
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return;
      if (event.origin !== YOUTUBE_ORIGIN) return;

      let data: unknown = event.data;
      try {
        if (typeof data === 'string') data = JSON.parse(data);
      } catch {
        return;
      }
      if (!data || typeof data !== 'object') return;

      const record = data as Record<string, unknown>;

      /**
       * 統一的播放器狀態處理。
       *
       * 只有兩種狀態值得報警：
       *   0（ENDED）—— 直播已經結束，畫面會停在最後一幀或黑畫面。
       *   5（CUED）不做判斷：使用者在直播載入後還沒按播放時也是 5，
       *     拿它當「失效」會誤報（實測就踩過）。
       */
      const onPlayerState = (state: number) => {
        if (state === 0) {
          markDead(null);
          return;
        }
        if (PLAYING_STATES.has(state)) markPlaying();
      };

      // 舊式事件：{"event":"onStateChange","info":1}
      if (record.event === 'onStateChange') {
        onPlayerState(Number(record.info));
        return;
      }
      if (record.event === 'onError') {
        markDead(Number(record.info));
        return;
      }

      // 新式事件：{"event":"infoDelivery","info":{"playerState":1,"errorCode":150}}
      if (record.event === 'infoDelivery' && record.info && typeof record.info === 'object') {
        const info = record.info as Record<string, unknown>;
        if (typeof info.playerState === 'number') onPlayerState(info.playerState);
        if (typeof info.errorCode === 'number' && info.errorCode > 0) {
          markDead(info.errorCode);
        }
      }
    };

    window.addEventListener('message', onMessage);

    // 逾時判定：只有「外殼頁連載入事件都沒有」才算異常。
    // YouTube 刻意不設逾時 —— 使用者沒點播放、自動播放被政策擋住時都是正常的暫停畫面，
    // 拿「沒收到播放中」當失效會誤報（實測就會）。YouTube 只信 onError。
    const timer = isYouTube
      ? null
      : window.setTimeout(() => {
          if (cancelled || loaded) return;
          setHealth((h) => (h === 'unknown' ? 'suspect' : h));
        }, timeoutMs);

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      registerTimers.forEach((t) => window.clearTimeout(t));
      window.removeEventListener('message', onMessage);
      iframe.removeEventListener('load', onLoad);
    };
  }, [iframe, embedUrl, timeoutMs]);

  return { health, errorCode };
}
