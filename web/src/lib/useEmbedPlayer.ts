'use client';

import { useEffect } from 'react';

/**
 * 嵌入式官方播放器的整合處理。
 *
 * 兩件事：
 *  1. **litv handshake**（東森 CH51、三立 CH54）
 *     `player.svc.litv.tv/v3/ppnif.html` 是一個外殼頁，本身不載串流。
 *     它在兩種情況下會等待「父頁」透過 postMessage 傳入 `ppnPid`：
 *       - URL 帶 `ap=1`（自動佈點）
 *       - `s` 參數解碼後等於 `setnch_web`（三立首頁）
 *     拿到 ppnPid 後，它才會去 `cdi.ofiii.com` 查 `asset_id` 對應的直播網址。
 *
 *     廣播商自己的首頁是靠 `player.svc.litv.tv/media_custom/<sponsor>_ppn_placement.js`
 *     完成這個 handshake。該腳本是公開檔案，PID 值也是公開常數。
 *
 *     為什麼我們要自己做：那份 placement 腳本會依 `window.parent.location.pathname`
 *     推算 PID。我們的頁面路徑會讓它推導出「次要佈點」的 PID，
 *     對應的頻道組合不同，可能取不到直播。因此在這裡明確帶入與官方首頁相同的 PID。
 *
 *     這不是繞過存取限制：端點、參數、PID 全部公開，
 *     且廣播商主動把它們放在自己的首頁原始碼裡。
 *
 *  2. **YouTube 取消靜音**（華視、中天、鏡新聞、中視、大愛、寰宇、公視）
 *     YouTube IFrame Player 支援用 postMessage 下指令：
 *       {"event":"command","func":"unMute","args":""}
 *     播放器在開始播放時會回報 `onStateChange`（info=1 代表 PLAYING），
 *     收到後再送 unMute，就能在不重新載入播放器的前提下恢復音量。
 *
 *     自動播放政策要求啟動瞬間是靜音的，所以 embed 網址保留 `mute=1`，
 *     等播放器真的開始播才取消靜音。
 */

const LITV_ORIGIN = 'https://player.svc.litv.tv';
const YOUTUBE_ORIGIN = 'https://www.youtube.com';

export type LitvPid = {
  desktop: string;
  mobile: string;
};

/** 頻道 ID → 對應的 litv placement PID */
const PID_BY_CHANNEL: Record<string, LitvPid> = {
  // 三立新聞台 CH54（官方首頁首選佈點）
  'setn-news-54': { desktop: 'setnch_web', mobile: 'setnch_mweb' },
  // 東森新聞 CH51（官方 /video 頁佈點）
  'ebc-news-51': {
    desktop: 'ebcnewsch_videopage_web',
    mobile: 'ebcnewsch_videopage_mweb',
  },
};

/** 是否為 YouTube 播放器 */
export function isYouTubeEmbed(url: string | null | undefined): boolean {
  return !!url && url.startsWith(YOUTUBE_ORIGIN);
}

/**
 * 對 YouTube 播放器下指令。
 *
 * 必須在網址加上 `enablejsapi=1` 才會生效（見 shared/channels.json 的 embed_url）。
 */
export function postYouTubeCommand(
  iframe: HTMLIFrameElement | null,
  func: 'unMute' | 'mute' | 'setVolume' | 'playVideo',
  args: string | number = '',
): void {
  if (!iframe) return;
  try {
    iframe.contentWindow?.postMessage(
      JSON.stringify({ event: 'command', func, args: String(args) }),
      YOUTUBE_ORIGIN,
    );
  } catch {
    // 跨網域 postMessage 在 iframe 尚未完成導航時可能拋錯，忽略即可
  }
}

/**
 * 為嵌入播放器掛上必要的整合處理。
 *
 * @param iframe 播放器 iframe 元素
 * @param channelId 頻道 ID（用來決定 litv PID）
 * @param embedUrl 目前載入的網址（用來判斷播放器類型）
 */
export function useEmbedPlayer(
  iframe: HTMLIFrameElement | null,
  channelId: string | null,
  embedUrl: string | null,
): void {
  useEffect(() => {
    if (!iframe || !embedUrl) return;

    const isLitv = embedUrl.startsWith(LITV_ORIGIN);
    const isYouTube = isYouTubeEmbed(embedUrl);

    if (!isLitv && !isYouTube) return;

    let cancelled = false;

    // --- litv handshake ---
    const pid = channelId ? PID_BY_CHANNEL[channelId] : undefined;
    const sendPid = () => {
      if (cancelled || !pid) return;
      try {
        iframe.contentWindow?.postMessage({ ppnPid: pid }, LITV_ORIGIN);
      } catch {
        // ignore
      }
    };

    // --- YouTube 取消靜音 ---
    const sendUnmute = () => {
      if (cancelled) return;
      postYouTubeCommand(iframe, 'unMute');
      postYouTubeCommand(iframe, 'setVolume', 100);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return;

      if (isLitv && event.origin === LITV_ORIGIN) {
        sendPid();
        return;
      }

      if (isYouTube && event.origin === YOUTUBE_ORIGIN) {
        // {"event":"onStateChange","info":1} → 1 = PLAYING
        try {
          const data =
            typeof event.data === 'string'
              ? JSON.parse(event.data)
              : event.data;
          if (data?.event === 'onStateChange' && data?.info === 1) {
            sendUnmute();
          }
        } catch {
          // 不是 JSON，忽略
        }
      }
    };

    window.addEventListener('message', onMessage);
    iframe.addEventListener('load', onMessage as EventListener);

    if (isLitv) {
      // 官方 placement 腳本的做法：頁面載入後立即送一次，並在稍後補送
      const timers = [300, 1000, 2500].map((ms) => window.setTimeout(sendPid, ms));
      sendPid();
      return () => {
        cancelled = true;
        window.removeEventListener('message', onMessage);
        iframe.removeEventListener('load', onMessage as EventListener);
        timers.forEach((t) => window.clearTimeout(t));
      };
    }

    // YouTube：若播放器已開始播放（晚於我們掛上監聽器），補送一次
    const timers = [1500, 4000].map((ms) => window.setTimeout(sendUnmute, ms));
    return () => {
      cancelled = true;
      window.removeEventListener('message', onMessage);
      iframe.removeEventListener('load', onMessage as EventListener);
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [iframe, channelId, embedUrl]);
}
