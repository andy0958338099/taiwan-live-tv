package com.taiwanlivetv.data

import android.content.Context
import com.taiwanlivetv.R
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader

/**
 * 頻道資料模型。
 *
 * 對應 shared/schema.md 的 Channel 欄位定義。APK 與 Web 版讀取同一份
 * shared/channels.json（由 scripts/sync-channels.mjs 同步到 assets/）。
 */
data class Channel(
    val channelId: String,
    val channelName: String,
    val nameEn: String?,
    val category: String,
    val channelNumber: Int?,
    val logo: String?,
    val streamUrl: String,
    val streamType: String,
    val sourceName: String,
    val sourceWebsite: String,
    val authorizationStatus: String,
    val isActive: Boolean,
    val lastChecked: String?,
    val description: String,
    val tags: List<String>,
    val region: String?,
    val corsEnabled: Boolean,
    val httpReferrer: String?,
    val notes: String?,
    /** 備援來源網址（同頻道的其他可用來源）。IPTV 來源時常失效，這是必備欄位。 */
    val backupUrls: List<String> = emptyList(),
    /**
     * 官方嵌入播放器網址。
     *
     * 當此欄位有值時，改以 WebView 嵌入官方播放器（而非 ExoPlayer 直接播放 HLS）。
     * 對應授權狀態 A：官方頁面本身即以 iframe 內嵌該播放器，等同官方默許嵌入。
     */
    val embedUrl: String? = null,
) {
    /** 是否有可播放的串流網址（直接播放或官方嵌入皆算） */
    val isPlayable: Boolean get() = streamUrl.isNotBlank() || !embedUrl.isNullOrBlank()

    /** 此頻道是否需以 WebView 嵌入官方播放器播放 */
    val isEmbedOnly: Boolean get() = streamUrl.isBlank() && !embedUrl.isNullOrBlank()

    /** 顯示用的完整名稱 */
    val displayName: String get() = channelName
}

data class Category(
    val id: String,
    val name: String,
    val nameEn: String?,
    val order: Int,
    val icon: String?,
)

data class ChannelCatalog(
    val schemaVersion: String,
    val updatedAt: String,
    val categories: List<Category>,
    val channels: List<Channel>,
) {
    companion object {
        val EMPTY = ChannelCatalog("0", "", emptyList(), emptyList())
    }

    fun channelsIn(categoryId: String): List<Channel> =
        channels.filter { it.category == categoryId && it.isPlayable }

    fun find(channelId: String): Channel? = channels.firstOrNull { it.channelId == channelId }

    fun categoryOf(channelId: String): Category? {
        val ch = find(channelId) ?: return null
        return categories.firstOrNull { it.id == ch.category }
    }
}

/**
 * 頻道資料來源。
 *
 * 載入順序：
 *   1. assets/channels.json（APK 內建，由 shared/ 同步而來）
 *   2. 若 assets 缺失或解析失敗，回退到 assets/channels_fallback.json
 *
 * 只載入 is_active=true 且 authorization_status 屬於可上線值的頻道。
 * 未授權頻道即使存在於資料檔中也不會出現在 UI。
 */
object ChannelRepository {

    /** 可上線的授權狀態，與 scripts/validate-channels.mjs 保持一致 */
    private val ALLOWED_AUTHORIZATION = setOf("authorized", "public_official", "user_provided")

    private const val ASSET_NAME = "channels.json"
    private const val FALLBACK_ASSET_NAME = "channels_fallback.json"

    @Volatile
    private var cached: ChannelCatalog? = null

    /**
     * 載入頻道清單。结果會被快取。
     */
    fun load(context: Context): ChannelCatalog {
        cached?.let { return it }
        synchronized(this) {
            cached?.let { return it }
            val parsed = parse(readAsset(context, ASSET_NAME))
                ?: parse(readAsset(context, FALLBACK_ASSET_NAME))
                ?: ChannelCatalog.EMPTY
            cached = parsed
            return parsed
        }
    }

    /** 重新從 assets 載入（測試用） */
    fun invalidate() = synchronized(this) { cached = null }

    private fun readAsset(context: Context, name: String): String? = try {
        context.assets.open(name).use { input ->
            BufferedReader(InputStreamReader(input, Charsets.UTF_8)).readText()
        }
    } catch (e: Exception) {
        null
    }

    private fun parse(raw: String?): ChannelCatalog? {
        if (raw.isNullOrBlank()) return null
        return try {
            val root = JSONObject(raw)

            val categories = root.optJSONArray("categories")?.let { arr ->
                (0 until arr.length()).mapNotNull { i ->
                    val o = arr.optJSONObject(i) ?: return@mapNotNull null
                    Category(
                        id = o.optString("id"),
                        name = o.optString("name"),
                        nameEn = o.optStringOrNull("name_en"),
                        order = o.optInt("order", Int.MAX_VALUE),
                        icon = o.optStringOrNull("icon"),
                    )
                }
            }.orEmpty()

            val channels = root.optJSONArray("channels")?.let { arr ->
                (0 until arr.length()).mapNotNull { i ->
                    val o = arr.optJSONObject(i) ?: return@mapNotNull null
                    val channel = o.toChannel() ?: return@mapNotNull null

                    // 授權守門：未授權或停用的頻道一律不進入 UI
                    if (!channel.isActive) return@mapNotNull null
                    if (channel.authorizationStatus !in ALLOWED_AUTHORIZATION) return@mapNotNull null
                    if (!channel.isPlayable) return@mapNotNull null

                    channel
                }
            }.orEmpty()

            ChannelCatalog(
                schemaVersion = root.optString("schema_version", "0"),
                updatedAt = root.optString("updated_at", ""),
                categories = categories.sortedBy { it.order },
                channels = channels,
            )
        } catch (e: Exception) {
            null
        }
    }

    private fun JSONObject.toChannel(): Channel? {
        val id = optStringOrNull("channel_id") ?: return null
        val url = optStringOrNull("stream_url")?.trim().orEmpty()
        return Channel(
            channelId = id,
            channelName = optString("channel_name", id),
            nameEn = optStringOrNull("name_en"),
            category = optString("category", "general"),
            channelNumber = if (has("channel_number") && !isNull("channel_number")) {
                optInt("channel_number")
            } else {
                null
            },
            logo = optStringOrNull("logo"),
            streamUrl = url,
            streamType = optString("stream_type", "hls"),
            sourceName = optString("source_name", ""),
            sourceWebsite = optString("source_website", ""),
            authorizationStatus = optString("authorization_status", "unknown"),
            isActive = optBoolean("is_active", false),
            lastChecked = optStringOrNull("last_checked"),
            description = optString("description", ""),
            tags = optJSONArrayOrEmpty("tags").toStringList(),
            region = optStringOrNull("region"),
            corsEnabled = optBoolean("cors_enabled", true),
            httpReferrer = optStringOrNull("http_referrer"),
            notes = optStringOrNull("notes"),
            backupUrls = parseBackupUrls(this),
            embedUrl = optStringOrNull("embed_url"),
        )
    }

    /**
     * 解析 playlist_source.backup_urls。
     *
     * 這是匯入型頻道的欄位；人工維護的頻道沒有此欄位。
     */
    private fun parseBackupUrls(o: JSONObject): List<String> {
        val ps = o.optJSONObject("playlist_source") ?: return emptyList()
        val arr = ps.optJSONArray("backup_urls") ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.optStringOrNull("url")?.takeIf { it.isNotBlank() }
        }.filter { it.startsWith("http://") || it.startsWith("https://") }
    }

    private fun JSONObject.optStringOrNull(key: String): String? {
        if (!has(key) || isNull(key)) return null
        val v = optString(key)
        return v.ifBlank { null }
    }

    private fun JSONObject.optJSONArrayOrEmpty(key: String): JSONArray =
        optJSONArray(key) ?: JSONArray()

    private fun JSONArray.toStringList(): List<String> =
        (0 until length()).mapNotNull { optString(it).ifBlank { null } }

}
