package com.taiwanlivetv.player

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * 網路狀態監控。
 *
 * 用途：直播斷線時判斷是「網路中斷」還是「串流本身有問題」，
 * 讓 UI 顯示正確的錯誤訊息；網路恢復時觸發重新連線。
 */
class NetworkMonitor(private val context: Context) {

    private val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    private val handler = Handler(Looper.getMainLooper())

    private var callback: ConnectivityManager.NetworkCallback? = null

    /** 網路恢復時呼叫 */
    var onNetworkAvailable: (() -> Unit)? = null

    /** 網路中斷時呼叫 */
    var onNetworkLost: (() -> Unit)? = null

    fun isOnline(): Boolean {
        val manager = cm ?: return true // 無法取得時不作悲觀假設
        val network = manager.activeNetwork ?: return false
        val caps = manager.getNetworkCapabilities(network) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    fun start() {
        val manager = cm ?: return
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()

        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                handler.post { onNetworkAvailable?.invoke() }
            }

            override fun onLost(network: Network) {
                handler.post { onNetworkLost?.invoke() }
            }
        }

        try {
            manager.registerNetworkCallback(request, cb)
            callback = cb
        } catch (e: SecurityException) {
            Log.w(TAG, "無法註冊網路監控（缺少權限）: ${e.message}")
        }
    }

    fun stop() {
        val manager = cm ?: return
        callback?.let {
            try {
                manager.unregisterNetworkCallback(it)
            } catch (e: IllegalArgumentException) {
                // 已解除註冊，忽略
            }
        }
        callback = null
    }

    companion object {
        private const val TAG = "NetworkMonitor"
    }
}
