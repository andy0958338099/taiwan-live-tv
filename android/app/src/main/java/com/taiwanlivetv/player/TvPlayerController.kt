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

    /** 連線中／緩衝中 */
    data class Buffering(val channelName: String) : PlaybackState()

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
            Log.e(TAG, "播放失敗 [$channel]: $message", error)

            if (shouldAutoRetry(error) && retryCount < MAX_AUTO_RETRIES) {
                scheduleRetry(channel)
            } else {
                emit(PlaybackState.Error(channel.channelName, message, error))
            }
        }
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
            }
    }

    /** 播放指定頻道 */
    fun play(channel: Channel) {
        val p = player ?: run {
            initialize()
            player ?: return
        }
        pendingChannel = channel
        retryCount = 0

        val mediaItem = MediaItem.Builder()
            .setUri(Uri.parse(channel.streamUrl))
            .setMediaId(channel.channelId)
            .setMimeType(if (channel.streamType == "dash") MimeTypes_DASH else MimeTypes_HLS)
            .build()

        p.setMediaItem(mediaItem)
        p.prepare()
        p.playWhenReady = true
        emit(PlaybackState.Buffering(channel.channelName))
    }

    /** 使用者主動重新連線 */
    fun reconnect() {
        val channel = pendingChannel ?: return
        retryCount = 0
        play(channel)
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
        emit(PlaybackState.Buffering(channel.channelName))

        handler.postDelayed({
            val p = player ?: return@postDelayed
            if (p.playbackState == Player.STATE_IDLE || p.playbackState == Player.STATE_ENDED) {
                play(channel)
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

        const val MimeTypes_HLS = "application/x-mpegURL"
        const val MimeTypes_DASH = "application/dash+xml"
    }
}
