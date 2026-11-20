package com.taiwanlivetv.player

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import com.taiwanlivetv.data.Channel

/** 播放狀態 */
sealed class PlaybackState {
    /** 尚未開始 */
    data object Idle : PlaybackState()

    /** 連線中／緩衝中。sourceIndex/totalSources 顯示目前使用第幾個來源 */
    data class Buffering(
        val channelName: String,
        val sourceIndex: Int = 1,
        val totalSources: Int = 1,
    ) : PlaybackState()

    /** 播放中 */
    data class Playing(val channelName: String) : PlaybackState()

    /** 播放失敗 */
    data class Error(
        val channelName: String,
        val message: String,
        val cause: Throwable? = null,
    ) : PlaybackState()
}

/**
 * ExoPlayer 包裝。
 *
 * 職責：
 *  - 建立 / 釋放 ExoPlayer
 *  - 播放直播串流（HLS / DASH）
 *  - 自動重試策略（網路錯誤指數退避重試）
 *  - 監聽網路恢復後自動重連
 */
class TvPlayerController(private val context: Context) {

    private val handler = Handler(Looper.getMainLooper())
    private var retryCount = 0
    private var pendingChannel: Channel? = null
    private var pendingUrls: List<String> = emptyList()
    private var pendingIndex: Int = 0

    var player: ExoPlayer? = null
        private set

    /** 播放狀態變更 */
    var onStateChanged: ((PlaybackState) -> Unit)? = null

    /** 需要重連（例如使用者按「重新連線」） */
    var onReconnectRequested: ((Channel) -> Unit)? = null

    private val playerListener = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            val channel = pendingChannel ?: return
            when (playbackState) {
                Player.STATE_BUFFERING -> {
                    // 直播串流在 STREAMING 之前會經過 BUFFERING
                    if (player?.playbackParameters == null || true) {
                        emit(PlaybackState.Buffering(channel.channelName))
                    }
                }
                Player.STATE_READY -> {
                    retryCount = 0
                    emit(PlaybackState.Playing(channel.channelName))
                }
                Player.STATE_ENDED -> {
                    // 直播串流不應結束；若結束則視為異常，重連
                    Log.w(TAG, "直播串流意外結束，重新連線")
                    scheduleRetry(channel, force = true)
                }
                Player.STATE_IDLE -> {
                    // 等待 prepare，狀態由 play() 設定
                }
            }
        }

        override fun onPlayerError(error: PlaybackException) {
            val channel = pendingChannel ?: return
            val message = describeError(error)
            Log.e(TAG, "播放失敗 [$channel] 來源${pendingIndex + 1}/${pendingUrls.size}: $message", error)

            if (shouldAutoRetry(error) && retryCount < MAX_AUTO_RETRIES) {
                scheduleRetry(channel)
            } else {
                // 重試次數用盡或不可重試 → 改用下一個備援來源
                failOverToNextSource(channel, message)
            }
        }
    }

    /**
     * 切換到下一個備援來源。
     *
     * IPTV 清單的來源時常失效，自動切換到備援來源是必備功能。
     * 所有來源都失敗後才會顯示錯誤訊息。
     */
    private fun failOverToNextSource(channel: Channel, reason: String) {
        val urls = pendingUrls.ifEmpty { candidateUrls(channel) }
        val nextIndex = pendingIndex + 1

        if (nextIndex < urls.size) {
            Log.i(TAG, "改用備援來源 ${nextIndex + 1}/${urls.size}: ${urls[nextIndex]}")
            retryCount = 0
            playWithUrl(channel, urls, nextIndex)
            return
        }

        Log.e(TAG, "所有來源皆失敗 [$channel]: $reason")
        emit(
            PlaybackState.Error(
                channel.channelName,
                "$reason。已嘗試 ${urls.size} 個來源（含備援）皆無法播放。",
            )
        )
    }

    /** 建立播放器（Activity onCreate 呼叫） */
    fun initialize() {
        if (player != null) return

        val httpDataSourceFactory = DefaultHttpDataSource.Factory()
            .setUserAgent(USER_AGENT)
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(CONNECT_TIMEOUT_MS)
            .setReadTimeoutMs(READ_TIMEOUT_MS)

        val mediaSourceFactory = DefaultMediaSourceFactory(httpDataSourceFactory)

        player = ExoPlayer.Builder(context)
            .setMediaSourceFactory(mediaSourceFactory)
            .build()
            .apply {
                addListener(playerListener)
                repeatMode = Player.REPEAT_MODE_OFF
                // 直播不需另外設定 seek：ExoPlayer 預設會把 seek 限制在 live window 內，
                // 超出範圍的 seek 會自動 clamp，不需要（也無法）設成 TIME_UNSET。
                //
                // 音量：ExoPlayer 預設就是全音量（volume = 1f），不需要額外設定。
                // 這裡明確寫出來是為了讓意圖清楚 —— 電視直播本來就應該有聲音。
                volume = 1f
            }
    }

    /** 播放指定頻道（自動嘗試備援來源） */
    fun play(channel: Channel) {
        val urls = candidateUrls(channel)
        if (urls.isEmpty()) {
            emit(PlaybackState.Error(channel.channelName, "此頻道沒有可用的串流網址"))
            return
        }
        playWithUrl(channel, urls, 0)
    }

    /**
     * 取得該頻道的所有候選來源：主來源 + 備援來源。
     *
     * IPTV 清單的來源時常失效，備援來源是必備功能而非選配。
     */
    private fun candidateUrls(channel: Channel): List<String> {
        val urls = mutableListOf<String>()
        if (channel.streamUrl.isNotBlank()) urls.add(channel.streamUrl)
        channel.backupUrls.forEach { backup ->
            if (backup.isNotBlank() && !urls.contains(backup)) urls.add(backup)
        }
        return urls
    }

    /** 以指定 URL 播放，並在失敗時自動改用下一個來源 */
    private fun playWithUrl(channel: Channel, urls: List<String>, index: Int) {
        val p = player ?: run {
            initialize()
            player ?: return
        }
        pendingChannel = channel
        pendingUrls = urls
        pendingIndex = index
        retryCount = 0

        val url = urls[index]
        Log.i(TAG, "播放 [$channel] 來源 ${index + 1}/${urls.size}: $url")

        val mediaItem = MediaItem.Builder()
            .setUri(Uri.parse(url))
            .setMediaId(channel.channelId)
            .setMimeType(if (channel.streamType == "dash") MIME_DASH else MIME_HLS)
            .build()

        p.setMediaItem(mediaItem)
        p.prepare()
        p.playWhenReady = true
        emit(PlaybackState.Buffering(channel.channelName, index + 1, urls.size))
    }

    /** 使用者主動重新連線（從第一個來源重新開始） */
    fun reconnect() {
        val channel = pendingChannel ?: return
        val urls = pendingUrls.ifEmpty { candidateUrls(channel) }
        if (urls.isEmpty()) return
        retryCount = 0
        playWithUrl(channel, urls, 0)
    }

    /** 釋放播放器 */
    fun release() {
        handler.removeCallbacksAndMessages(null)
        player?.removeListener(playerListener)
        player?.release()
        player = null
        pendingChannel = null
    }

    // --- 內部 ---

    private fun scheduleRetry(channel: Channel, force: Boolean = false) {
        if (!force && retryCount >= MAX_AUTO_RETRIES) return
        retryCount++
        val delayMs = RETRY_BASE_DELAY_MS * (1L shl (retryCount - 1)).coerceAtMost(MAX_RETRY_DELAY_MS)
        Log.i(TAG, "第 $retryCount 次重試 [$channel]，延遲 ${delayMs}ms")
        emit(PlaybackState.Buffering(channel.channelName, pendingIndex + 1, pendingUrls.size))

        handler.postDelayed({
            val p = player ?: return@postDelayed
            if (p.playbackState == Player.STATE_IDLE || p.playbackState == Player.STATE_ENDED) {
                val urls = pendingUrls.ifEmpty { candidateUrls(channel) }
                if (urls.isNotEmpty()) {
                    playWithUrl(channel, urls, pendingIndex)
                }
            } else {
                p.prepare()
                p.playWhenReady = true
            }
        }, delayMs)
    }

    private fun shouldAutoRetry(error: PlaybackException): Boolean {
        return when (error.errorCode) {
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
            PlaybackException.ERROR_CODE_IO_NO_PERMISSION,
            PlaybackException.ERROR_CODE_IO_CLEARTEXT_NOT_PERMITTED,
            PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND,
            PlaybackException.ERROR_CODE_IO_UNSPECIFIED,
            PlaybackException.ERROR_CODE_TIMEOUT,
            PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED,
            PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED,
            -> true
            else -> false
        }
    }

    private fun describeError(error: PlaybackException): String = when (error.errorCode) {
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED -> "無法連線到串流伺服器，請檢查網路連線"
        PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT -> "連線逾時，請稍後重試"
        PlaybackException.ERROR_CODE_IO_NO_PERMISSION -> "沒有存取該串流的權限"
        PlaybackException.ERROR_CODE_IO_CLEARTEXT_NOT_PERMITTED -> "不允許明文 (HTTP) 串流"
        PlaybackException.ERROR_CODE_IO_UNSPECIFIED -> "網路傳輸發生錯誤"
        PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS -> "伺服器回傳錯誤狀態碼"
        PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND -> "找不到串流資源"
        PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED -> "串流格式無法解析（可能不是有效的 HLS 串流）"
        PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED -> "串流清單格式錯誤"
        PlaybackException.ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED -> "串流清單格式不受支援"
        PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED -> "此裝置不支援該串流的編碼格式"
        PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES -> "串流解析度或位元率超過此裝置能力"
        PlaybackException.ERROR_CODE_DECODER_INIT_FAILED -> "解碼器初始化失敗"
        PlaybackException.ERROR_CODE_TIMEOUT -> "載入串流逾時"
        else -> "播放失敗：${error.errorCodeName}"
    }

    private fun emit(state: PlaybackState) {
        handler.post { onStateChanged?.invoke(state) }
    }

    companion object {
        private const val TAG = "TvPlayerController"
        private const val USER_AGENT = "TaiwanLiveTV/1.0 (Android TV)"
        private const val CONNECT_TIMEOUT_MS = 15_000
        private const val READ_TIMEOUT_MS = 20_000
        private const val MAX_AUTO_RETRIES = 3
        private const val RETRY_BASE_DELAY_MS = 1_500L
        private const val MAX_RETRY_DELAY_MS = 8_000L

        const val MIME_HLS = "application/x-mpegURL"
        const val MIME_DASH = "application/dash+xml"
    }
}
