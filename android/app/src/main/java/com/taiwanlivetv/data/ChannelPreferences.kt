package com.taiwanlivetv.data

import android.content.Context
import android.content.SharedPreferences

/**
 * 使用者偏好：收藏、最近觀看、上次觀看頻道。
 *
 * 使用 SharedPreferences 而非 Room/DataStore：資料量極小（數十筆），
 * 需要的是零啟動延遲與最低相容性（minSdk 21 的電視盒）。
 */
class ChannelPreferences(context: Context) {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /** 我的最愛頻道 id 集合 */
    val favorites: MutableSet<String>
        get() = prefs.getStringSet(KEY_FAVORITES, emptySet()).orEmpty().toMutableSet()

    fun isFavorite(channelId: String): Boolean = favorites.contains(channelId)

    fun toggleFavorite(channelId: String): Boolean {
        val current = favorites
        val nowFavorite = if (current.contains(channelId)) {
            current.remove(channelId); false
        } else {
            current.add(channelId); true
        }
        prefs.edit().putStringSet(KEY_FAVORITES, current).apply()
        return nowFavorite
    }

    /** 最近觀看頻道 id，由新到舊，最多 MAX_RECENT 筆 */
    val recentChannelIds: List<String>
        get() = prefs.getString(KEY_RECENT, "")
            ?.split(SEPARATOR)
            ?.filter { it.isNotBlank() }
            .orEmpty()

    fun recordWatched(channelId: String) {
        val updated = (listOf(channelId) + recentChannelIds.filter { it != channelId })
            .take(MAX_RECENT)
        prefs.edit().putString(KEY_RECENT, updated.joinToString(SEPARATOR)).apply()
    }

    /** 上次觀看的頻道 id（啟動時自動恢復） */
    var lastChannelId: String?
        get() = prefs.getString(KEY_LAST_CHANNEL, null)
        set(value) {
            prefs.edit().putString(KEY_LAST_CHANNEL, value).apply()
        }

    /** 頻道清單最後更新時間（顯示於設定／關於頁） */
    var lastCatalogUpdate: String?
        get() = prefs.getString(KEY_CATALOG_UPDATE, null)
        set(value) {
            prefs.edit().putString(KEY_CATALOG_UPDATE, value).apply()
        }

    companion object {
        private const val PREFS_NAME = "taiwan_live_tv_prefs"
        private const val KEY_FAVORITES = "favorites"
        private const val KEY_RECENT = "recent_channels"
        private const val KEY_LAST_CHANNEL = "last_channel_id"
        private const val KEY_CATALOG_UPDATE = "catalog_update"
        private const val SEPARATOR = ""
        private const val MAX_RECENT = 20
    }
}
