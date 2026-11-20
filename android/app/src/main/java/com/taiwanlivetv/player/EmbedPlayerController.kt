package com.taiwanlivetv.player

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import com.taiwanlivetv.data.Channel

/** litv placement PID（廣播商公開的佈點識別碼） */
data class LitvPid(val desktop: String, val mobile: String)

/**
 * 官方嵌入播放器（WebView）。
 *
 * 為什麼需要這個：
 *   部分頻道（例如華視新聞 CH52、中天新聞、鏡新聞、三立新聞台、東森新聞 CH51、
 *   客家電視）的**官方網站本身就是以 iframe 內嵌播放器**。這種來源的
 *   manifest URL 是播放器內部指紋、帶短效 token、或有 referer 白名單，
 *   直接用 ExoPlayer 抓並不穩定，而且那等於繞過官方設定的存取限制。
 *
 *   正確做法就是照官方那樣嵌入 —— 官方頁面自己都這樣做，
 *   等同默許第三方嵌入（授權狀態 A：public_official）。
 *
 * 職責：
 *   - 用 WebView 載入官方 embed 網址
 *   - 開啟 JS（播放器需要）、多媒體（影片播放需要）
 *   - litv 播放器 handshake（見 applyPlayerPostLoad）
 *   - 取消靜音（見 applyPlayerPostLoad）
 *   - 載入失敗時回報錯誤並支援重試
 */
class EmbedPlayerController(private val context: Context) {

    private val handler = Handler(Looper.getMainLooper())
    private var loadTimeoutRunnable: Runnable? = null
    private var pendingChannel: Channel? = null

    /** 狀態變更通知 */
    var onStateChanged: ((PlaybackState) -> Unit)? = null

    /** 需要重載（使用者按「重新連線」） */
    var onReloadRequested: ((Channel) -> Unit)? = null

    /**
     * 設定 WebView。
     *
     * 注意：只開啟必要的能力。開啟檔案存取是危險的，且我們不需要。
     * 也不加 JavascriptInterface —— 那會擴大攻擊面，而我們只需要
     * evaluateJavascript 單向注入，不需要頁面呼叫我們的方法。
     */
    @SuppressLint("SetJavaScriptEnabled")
    fun configure(webView: WebView) {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
            builtInZoomControls = false
            displayZoomControls = false
            // 不啟用檔案存取 —— 我們只載入官方 https 網址
            allowFileAccess = false
            allowContentAccess = false
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            userAgentString = "$userAgentString TVLiveTV/1.0"
        }

        webView.setBackgroundColor(android.graphics.Color.BLACK)

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                // 只處理主框架；子框架（廣告等）完成不應觸發狀態變更
                if (view.url != url) return

                // 頁面載入完成 → 取消逾時計時器
                loadTimeoutRunnable?.let { handler.removeCallbacks(it) }
                loadTimeoutRunnable = null
                pendingChannel?.let { ch ->
                    Log.i(TAG, "嵌入播放器載入完成 [$ch]: $url")
                    emit(PlaybackState.Playing(ch.channelName))
                }
                // 頁面就緒後執行 handshake 與取消靜音
                applyPlayerPostLoad(view, url)
            }

            override fun onReceivedError(
                view: WebView,
                request: android.webkit.WebResourceRequest,
                error: android.webkit.WebResourceError,
            ) {
                // 只處理主框架的錯誤；子資源（廣告、追蹤）失敗不影響播放
                if (!request.isForMainFrame) return
                val ch = pendingChannel ?: return
                val desc = error.description?.toString() ?: "未知錯誤"
                Log.e(TAG, "嵌入播放器載入失敗 [$ch]: $desc")
                emit(
                    PlaybackState.Error(
                        ch.channelName,
                        "無法載入官方播放器（$desc）。請確認網路連線後重試。",
                    )
                )
            }
        }
    }

    /**
     * 頁面載入後的處理：litv handshake + 取消靜音。
     *
     * ### litv handshake
     * `player.svc.litv.tv/v3/ppnif.html` 是一個外殼頁，本身不載串流。
     * 它會等待「父頁」透過 postMessage 傳入 `ppnPid`（placement 識別碼），
     * 拿到後才去 `cdi.ofiii.com` 查 `asset_id` 對應的直播網址。
     *
     * 廣播商自己的首頁是靠公開的 `player.svc.litv.tv/media_custom/<sponsor>_ppn_placement.js`
     * 完成這件事；該腳本依 `window.parent.location.pathname` 推算 PID。
     * 我們的頁面路徑會讓它推導出「次要佈點」的 PID（對應的頻道組合不同），
     * 因此在這裡明確帶入與廣播商首頁相同的 PID。
     *
     * 端點、參數、PID 全部公開，且廣播商主動把它們放在自己的首頁原始碼裡 ——
     * 這不是繞過存取限制。
     *
     * ### 取消靜音
     * YouTube 的 embed 網址帶 `mute=1`（自動播放政策要求），
     * 這裡用 IFrame Player API 取消靜音。
     */
    private fun applyPlayerPostLoad(view: WebView, url: String) {
        val ch = pendingChannel ?: return

        if (url.startsWith(LITV_ORIGIN)) {
            val pid = pidFor(ch.channelId) ?: return
            // WebView 中 ppnif.html 就是最上層文件（window.parent === window），
            // 所以它會把 ppnIframeReady 送給自己；我們監聽後回覆 ppnPid。
            val js = """
                (function () {
                  var pid = ${jsObject(pid)};
                  function send() {
                    try { window.postMessage({ppnPid: pid}, '$LITV_ORIGIN'); } catch (e) {}
                  }
                  window.addEventListener('message', function (e) {
                    if (e.origin === '$LITV_ORIGIN') {
                      try { e.source.postMessage({ppnPid: pid}, e.origin); } catch (err) {}
                    }
                  });
                  send();
                  setTimeout(send, 800);
                  setTimeout(send, 2500);
                })();
            """.trimIndent()
            view.evaluateJavascript(js, null)
            return
        }

        if (url.startsWith(YOUTUBE_ORIGIN)) {
            val js = """
                (function () {
                  function cmd(func, args) {
                    try {
                      window.postMessage(
                        JSON.stringify({event:'command', func:func, args:String(args)}),
                        '$YOUTUBE_ORIGIN'
                      );
                    } catch (e) {}
                  }
                  window.addEventListener('message', function (e) {
                    if (e.origin !== '$YOUTUBE_ORIGIN') return;
                    try {
                      var d = (typeof e.data === 'string') ? JSON.parse(e.data) : e.data;
                      if (d && d.event === 'onStateChange' && d.info === 1) {
                        cmd('unMute', '');
                        cmd('setVolume', 100);
                      }
                    } catch (err) {}
                  });
                  setTimeout(function(){ cmd('unMute',''); cmd('setVolume',100); }, 1500);
                  setTimeout(function(){ cmd('unMute',''); cmd('setVolume',100); }, 4000);
                })();
            """.trimIndent()
            view.evaluateJavascript(js, null)
        }
    }

    /** 頻道 ID → litv placement PID */
    private fun pidFor(channelId: String): LitvPid? = when (channelId) {
        // 三立新聞台 CH54（官方首頁首選佈點）
        "setn-news-54" -> LitvPid("setnch_web", "setnch_mweb")
        // 東森新聞 CH51（官方 /video 頁佈點）
        "ebc-news-51" -> LitvPid("ebcnewsch_videopage_web", "ebcnewsch_videopage_mweb")
        else -> null
    }

    /** 把 PID 物件轉成 JS 物件字面值 */
    private fun jsObject(pid: LitvPid): String =
        "{desktop:'${pid.desktop}', mobile:'${pid.mobile}'}"

    /**
     * 在 WebView 中載入官方嵌入播放器。
     */
    fun play(webView: WebView, channel: Channel) {
        val url = channel.embedUrl?.trim().orEmpty()
        if (url.isEmpty()) {
            emit(PlaybackState.Error(channel.channelName, "此頻道沒有可用的嵌入網址"))
            return
        }
        if (!url.startsWith("https://") && !url.startsWith("http://")) {
            emit(PlaybackState.Error(channel.channelName, "嵌入網址格式不正確"))
            return
        }

        pendingChannel = channel
        emit(PlaybackState.Buffering(channel.channelName))
        Log.i(TAG, "嵌入官方播放器 [$channel]: $url")

        webView.loadUrl(url)

        // 載入逾時監控 —— 網路不佳時 WebView 不會觸發 onReceivedError
        loadTimeoutRunnable?.let { handler.removeCallbacks(it) }
        val timeout = Runnable {
            val ch = pendingChannel
            if (ch != null) {
                Log.e(TAG, "嵌入播放器載入逾時 [$ch]")
                emit(
                    PlaybackState.Error(
                        ch.channelName,
                        "載入官方播放器逾時（${LOAD_TIMEOUT_MS / 1000} 秒）。請確認網路連線後重試。",
                    )
                )
            }
        }
        loadTimeoutRunnable = timeout
        handler.postDelayed(timeout, LOAD_TIMEOUT_MS)
    }

    /** 重載目前頻道 */
    fun reload(webView: WebView) {
        val ch = pendingChannel ?: return
        Log.i(TAG, "重新載入嵌入播放器 [$ch]")
        play(webView, ch)
    }

    /** 停止載入並釋放資源 */
    fun release(webView: WebView) {
        loadTimeoutRunnable?.let { handler.removeCallbacks(it) }
        loadTimeoutRunnable = null
        pendingChannel = null
        try {
            webView.stopLoading()
            webView.loadUrl("about:blank")
            webView.destroy()
        } catch (e: Exception) {
            Log.w(TAG, "釋放 WebView 時發生例外", e)
        }
    }

    private fun emit(state: PlaybackState) {
        handler.post { onStateChanged?.invoke(state) }
    }

    companion object {
        private const val TAG = "EmbedPlayerController"
        private const val LOAD_TIMEOUT_MS = 20_000L
        private const val LITV_ORIGIN = "https://player.svc.litv.tv"
        private const val YOUTUBE_ORIGIN = "https://www.youtube.com"
    }
}
