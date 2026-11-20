package com.taiwanlivetv.ui

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import com.taiwanlivetv.R
import com.taiwanlivetv.data.Channel
import com.taiwanlivetv.data.ChannelCatalog
import com.taiwanlivetv.data.ChannelPreferences
import com.taiwanlivetv.data.ChannelRepository
import com.taiwanlivetv.databinding.ActivityMainBinding
import com.taiwanlivetv.player.EmbedPlayerController
import com.taiwanlivetv.player.NetworkMonitor
import com.taiwanlivetv.player.PlaybackState
import com.taiwanlivetv.player.TvPlayerController

/**
 * 主 Activity。
 *
 * 遙控器操作對應（全程不依賴觸控）：
 *   - 上下左右：focus 移動（在分頁 → 分類 → 頻道卡 → 搜尋按鈕之間）
 *   - 確認鍵 (DPAD_CENTER / ENTER)：在頻道卡上切換頻道
 *   - 返回鍵 (BACK)：關閉搜尋框 → 關閉對話框 → 退出 App
 *   - 頻道切換：在頻道列上左右移動即時預覽，確認後正式播放
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var prefs: ChannelPreferences
    private lateinit var playerController: TvPlayerController
    private lateinit var embedController: EmbedPlayerController
    private lateinit var networkMonitor: NetworkMonitor

    private lateinit var channelAdapter: ChannelAdapter
    private lateinit var categoryAdapter: CategoryAdapter

    private var catalog: ChannelCatalog = ChannelCatalog.EMPTY
    private var currentChannel: Channel? = null
    private var activeTab = Tab.CHANNELS
    private var activeCategory: String = ALL_CATEGORY
    private var searchQuery: String = ""

    private enum class Tab { CHANNELS, FAVORITES, RECENT }

    companion object {
        private const val ALL_CATEGORY = "__all__"
        private const val EXTRA_SEARCH = "extra_search_query"

        // 播放狀態代碼
        private const val STATUS_IDLE = 0
        private const val STATUS_BUFFERING = 1
        private const val STATUS_PLAYING = 2
        private const val STATUS_ERROR = 3
        private const val STATUS_OFFLINE = 4
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        prefs = ChannelPreferences(this)
        playerController = TvPlayerController(this)
        embedController = EmbedPlayerController(this)
        networkMonitor = NetworkMonitor(this)

        setupPlayer()
        setupRecyclerViews()
        setupTabs()
        setupCategoryBar()
        setupSearchButton()
        setupRetryButton()
        setupChannelPanel()

        loadCatalog()
        restoreLastChannel()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.getStringExtra(EXTRA_SEARCH)?.let { query ->
            activeTab = Tab.CHANNELS
            activeCategory = ALL_CATEGORY
            searchQuery = query
            applyFilters()
        }
    }

    override fun onResume() {
        super.onResume()
        networkMonitor.start()
        networkMonitor.onNetworkAvailable = {
            // 網路恢復：若當前是錯誤狀態，自動重試
            val channel = currentChannel
            if (channel != null && channel.isEmbedOnly) {
                if (binding.errorPanel.visibility == View.VISIBLE) {
                    embedController.reload(binding.embedWebView)
                }
            } else if (playerController.player?.playerError != null) {
                playerController.reconnect()
            }
        }
        networkMonitor.onNetworkLost = {
            updateStatus(getString(R.string.state_offline), STATUS_OFFLINE)
        }
    }

    override fun onPause() {
        super.onPause()
        networkMonitor.stop()
    }

    override fun onDestroy() {
        super.onDestroy()
        playerController.release()
        embedController.release(binding.embedWebView)
    }

    // ===== 設定 =====

    private fun setupPlayer() {
        playerController.initialize()
        binding.playerView.player = playerController.player

        playerController.onStateChanged = { state -> renderPlaybackState(state) }

        // 官方嵌入播放器（WebView）
        embedController.configure(binding.embedWebView)
        embedController.onStateChanged = { state -> renderPlaybackState(state) }
    }

    private fun setupRecyclerViews() {
        channelAdapter = ChannelAdapter(
            onChannelClick = { channel -> playChannel(channel) },
            onChannelFocused = { channel -> binding.currentChannelName.text = channel.displayName },
        )
        binding.channelRecycler.layoutManager =
            LinearLayoutManager(this, LinearLayoutManager.HORIZONTAL, false)
        binding.channelRecycler.adapter = channelAdapter

        categoryAdapter = CategoryAdapter { categoryId ->
            activeCategory = categoryId
            applyFilters()
            binding.channelRecycler.requestFocus()
        }
    }

    private fun setupTabs() {
        binding.tabChannels.setOnClickListener { switchTab(Tab.CHANNELS) }
        binding.tabFavorites.setOnClickListener { switchTab(Tab.FAVORITES) }
        binding.tabRecent.setOnClickListener { switchTab(Tab.RECENT) }
        updateTabSelection()
    }

    private fun setupCategoryBar() {
        val entries = mutableListOf<Pair<String, String>>()
        entries += ALL_CATEGORY to getString(R.string.action_all_channels)
        catalog.categories.forEach { entries += it.id to it.name }
        categoryAdapter.submit(entries)
        categoryAdapter.setSelected(activeCategory)
    }

    private fun setupSearchButton() {
        binding.btnSearch.setOnClickListener { showSearchDialog() }
    }

    // ===== 頻道選擇側邊面板 =====

    /**
     * 頻道選擇側邊面板的開關。
     *
     * 設計意圖：**觀看時完全隱藏**，不影響觀賞體驗。
     * 需要換台時才從右側滑出，選完頻道自動收起。
     *
     * 面板疊在播放器之上（overlay），不是切分版面 ——
     * 收合時播放器維持全尺寸，展開時才被覆蓋一部分。
     */
    private fun setupChannelPanel() {
        binding.btnChannelList.setOnClickListener { openChannelPanel() }
        binding.btnClosePanel.setOnClickListener { closeChannelPanel() }
        binding.panelScrim.setOnClickListener { closeChannelPanel() }
    }

    /** 展開頻道選擇面板（從右側滑入） */
    private fun openChannelPanel() {
        if (binding.channelPanel.visibility == View.VISIBLE) return

        binding.channelPanel.visibility = View.VISIBLE
        binding.panelScrim.visibility = View.VISIBLE

        // 分類列要重新建立（面板是後來才出現的，寬度與之前不同）
        setupCategoryBar()
        updatePanelTitle()

        // 從右側滑入
        binding.channelPanel.translationX = binding.channelPanel.width.toFloat().takeIf { it > 0f }
            ?: resources.getDimensionPixelSize(R.dimen.channel_panel_width).toFloat()
        binding.channelPanel.animate()
            .translationX(0f)
            .setDuration(220)
            .start()

        binding.panelScrim.alpha = 0f
        binding.panelScrim.animate().alpha(1f).setDuration(220).start()

        // 焦點移入面板，遙控器可以直接操作
        binding.channelRecycler.requestFocus()
    }

    /** 收起頻道選擇面板（滑回右側） */
    private fun closeChannelPanel() {
        if (binding.channelPanel.visibility != View.VISIBLE) return

        val target = resources.getDimensionPixelSize(R.dimen.channel_panel_width).toFloat()

        binding.channelPanel.animate()
            .translationX(target)
            .setDuration(200)
            .withEndAction {
                binding.channelPanel.visibility = View.GONE
                binding.channelPanel.translationX = 0f
            }
            .start()

        binding.panelScrim.animate()
            .alpha(0f)
            .setDuration(200)
            .withEndAction { binding.panelScrim.visibility = View.GONE }
            .start()

        // 焦點回到入口按鈕，遙控器使用者知道可以再按一次
        binding.btnChannelList.requestFocus()
    }

    /** 依目前分頁更新面板標題 */
    private fun updatePanelTitle() {
        binding.panelTitle.text = when (activeTab) {
            Tab.FAVORITES -> getString(R.string.action_favorites)
            Tab.RECENT -> getString(R.string.action_recent)
            Tab.CHANNELS -> getString(R.string.action_all_channels)
        }
    }

    /**
     * 返回鍵：若面板已展開，先收起面板。
     *
     * Android TV 的使用者預期「返回」是逐層退出，
     * 而不是直接離開應用程式。
     */
    @Deprecated("以 OnBackPressedDispatcher 取代；此處保留以支援舊系統")
    override fun onBackPressed() {
        if (binding.channelPanel.visibility == View.VISIBLE) {
            closeChannelPanel()
            return
        }
        @Suppress("DEPRECATION")
        super.onBackPressed()
    }

    private fun setupRetryButton() {
        binding.btnRetry.setOnClickListener {
            binding.errorPanel.visibility = View.GONE
            // 依目前播放模式決定重連對象
            val channel = currentChannel
            if (channel != null && channel.isEmbedOnly) {
                embedController.reload(binding.embedWebView)
            } else {
                playerController.reconnect()
            }
        }
    }

    // ===== 資料 =====

    private fun loadCatalog() {
        catalog = ChannelRepository.load(this)
        channelAdapter.setCategoryNames(catalog.categories.associate { it.id to it.name })
        setupCategoryBar()
        applyFilters()
    }

    private fun switchTab(tab: Tab) {
        activeTab = tab
        activeCategory = ALL_CATEGORY
        searchQuery = ""
        categoryAdapter.setSelected(ALL_CATEGORY)
        updateTabSelection()
        applyFilters()
        // 分頁在側邊面板內 → 切換分頁時面板必須是展開的
        updatePanelTitle()
        if (binding.channelPanel.visibility != View.VISIBLE) {
            openChannelPanel()
        }
    }

    private fun updateTabSelection() {
        binding.tabChannels.isSelected = activeTab == Tab.CHANNELS
        binding.tabFavorites.isSelected = activeTab == Tab.FAVORITES
        binding.tabRecent.isSelected = activeTab == Tab.RECENT
    }

    private fun applyFilters() {
        val visible = when (activeTab) {
            Tab.CHANNELS -> filterChannels(catalog.channels)
            Tab.FAVORITES -> catalog.channels.filter { prefs.isFavorite(it.channelId) }
            Tab.RECENT -> {
                val ids = prefs.recentChannelIds
                ids.mapNotNull { id -> catalog.find(id) }
            }
        }

        channelAdapter.submit(visible)
        channelAdapter.setSelected(currentChannel?.channelId)

        val emptyText = when {
            visible.isNotEmpty() -> null
            activeTab == Tab.FAVORITES -> getString(R.string.empty_favorites)
            activeTab == Tab.RECENT -> getString(R.string.empty_recent)
            searchQuery.isNotEmpty() -> getString(R.string.empty_search, searchQuery)
            else -> getString(R.string.empty_search, "")
        }
        binding.emptyStateText.text = emptyText
        binding.emptyStateText.visibility = if (visible.isEmpty()) View.VISIBLE else View.GONE
    }

    private fun filterChannels(all: List<Channel>): List<Channel> {
        var result = all
        if (activeCategory != ALL_CATEGORY) {
            result = result.filter { it.category == activeCategory }
        }
        if (searchQuery.isNotBlank()) {
            val q = searchQuery.trim().lowercase()
            result = result.filter { ch ->
                ch.channelName.lowercase().contains(q) ||
                    ch.nameEn?.lowercase()?.contains(q) == true ||
                    ch.tags.any { it.lowercase().contains(q) } ||
                    ch.description.lowercase().contains(q)
            }
        }
        return result
    }

    private fun restoreLastChannel() {
        val lastId = prefs.lastChannelId ?: return
        val channel = catalog.find(lastId) ?: return
        playChannel(channel)
    }

    // ===== 播放 =====

    private fun playChannel(channel: Channel) {
        if (!channel.isPlayable) {
            showError(channel.channelName, "此頻道沒有可用的串流網址")
            return
        }
        currentChannel = channel
        channelAdapter.setSelected(channel.channelId)
        binding.currentChannelName.text = channel.displayName
        binding.errorPanel.visibility = View.GONE
        prefs.lastChannelId = channel.channelId
        prefs.recordWatched(channel.channelId)

        // 選好頻道 → 收起側邊面板，回到純觀看畫面
        closeChannelPanel()

        // 兩種播放模式互斥切換：
        //   - embed 頻道 → WebView 載入官方播放器（官方頁面本身即以 iframe 內嵌）
        //   - 其他頻道   → ExoPlayer 直接播放 HLS
        if (channel.isEmbedOnly) {
            showEmbedSurface(true)
            embedController.play(binding.embedWebView, channel)
        } else {
            showEmbedSurface(false)
            playerController.play(channel)
        }
    }

    /**
     * 切換播放器顯示。
     *
     * ExoPlayer 與 WebView 必須互斥 —— 同時顯示會造成畫面重疊與音效打架。
     */
    private fun showEmbedSurface(showEmbed: Boolean) {
        binding.embedWebView.visibility = if (showEmbed) View.VISIBLE else View.GONE
        binding.playerView.visibility = if (showEmbed) View.GONE else View.VISIBLE
    }

    private fun renderPlaybackState(state: PlaybackState) {
        when (state) {
            is PlaybackState.Idle -> {
                binding.loadingIndicator.visibility = View.GONE
                updateStatus("", STATUS_IDLE)
            }
            is PlaybackState.Buffering -> {
                binding.loadingIndicator.visibility = View.VISIBLE
                binding.errorPanel.visibility = View.GONE
                val label = if (state.sourceIndex > 1 && state.totalSources > 1) {
                    "${getString(R.string.state_buffering)}（來源 ${state.sourceIndex}/${state.totalSources}）"
                } else {
                    getString(R.string.state_buffering)
                }
                updateStatus(label, STATUS_BUFFERING)
            }
            is PlaybackState.Playing -> {
                binding.loadingIndicator.visibility = View.GONE
                binding.errorPanel.visibility = View.GONE
                updateStatus(getString(R.string.state_playing), STATUS_PLAYING)
            }
            is PlaybackState.Error -> {
                binding.loadingIndicator.visibility = View.GONE
                showError(state.channelName, state.message)
            }
        }
    }

    private fun showError(channelName: String, message: String) {
        binding.loadingIndicator.visibility = View.GONE
        binding.errorPanel.visibility = View.VISIBLE
        binding.errorTitle.text = getString(R.string.state_error)
        binding.errorMessage.text = message
        binding.btnRetry.visibility = View.VISIBLE
        binding.btnRetry.requestFocus()
        updateStatus(message, STATUS_ERROR)
    }

    private fun updateStatus(text: String, status: Int) {
        binding.playStatus.text = text
        val color = when (status) {
            STATUS_PLAYING -> R.color.tv_status_playing
            STATUS_BUFFERING -> R.color.tv_status_buffering
            STATUS_ERROR, STATUS_OFFLINE -> R.color.tv_status_error
            else -> R.color.tv_text_secondary
        }
        binding.playStatus.setTextColor(getColor(color))
    }

    // ===== 搜尋 =====

    private fun showSearchDialog() {
        val input = EditText(this).apply {
            hint = getString(R.string.search_hint)
            setText(searchQuery)
            setSingleLine()
            setTextColor(getColor(R.color.tv_text_primary))
            setHintTextColor(getColor(R.color.tv_text_muted))
            textSize = 18f
        }

        val container = FrameLayout(this).apply {
            val pad = (32 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad, pad, pad)
            addView(input)
        }

        val dialog = AlertDialog.Builder(this)
            .setTitle(R.string.action_search)
            .setView(container)
            .setPositiveButton(R.string.btn_ok) { _, _ ->
                searchQuery = input.text.toString()
                activeTab = Tab.CHANNELS
                activeCategory = ALL_CATEGORY
                categoryAdapter.setSelected(ALL_CATEGORY)
                updateTabSelection()
                applyFilters()
                binding.channelRecycler.requestFocus()
            }
            .setNegativeButton(R.string.btn_cancel, null)
            .create()

        dialog.setOnShowListener {
            input.requestFocus()
            input.selectAll()
        }
        dialog.show()

        // 輸入即時過濾（電視打字慢，即時回饋更重要）
        input.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, st: Int, c: Int, a: Int) {}
            override fun onTextChanged(s: CharSequence?, st: Int, b: Int, c: Int) {}
            override fun afterTextChanged(s: Editable?) {
                // 搜尋框關閉時才套用，避免每次按鍵都重建列表
            }
        })
    }

    // ===== 頻道資訊 =====

    private fun showChannelInfo(channel: Channel) {
        val view = LayoutInflater.from(this).inflate(R.layout.dialog_channel_info, null)
        val authLabel = when (channel.authorizationStatus) {
            "authorized" -> getString(R.string.auth_authorized)
            "public_official" -> getString(R.string.auth_public_official)
            "user_provided" -> getString(R.string.auth_user_provided)
            "pending_review" -> getString(R.string.auth_pending_review)
            "restricted" -> getString(R.string.auth_restricted)
            else -> getString(R.string.auth_unknown)
        }

        view.findViewById<TextView>(R.id.infoName).text = channel.channelName
        view.findViewById<TextView>(R.id.infoDescription).text = channel.description
        view.findViewById<TextView>(R.id.infoSource).text =
            getString(R.string.info_source, channel.sourceName)
        view.findViewById<TextView>(R.id.infoAuthorization).text =
            getString(R.string.info_authorization, authLabel)

        val website = view.findViewById<TextView>(R.id.infoWebsite)
        website.text = channel.sourceWebsite
        website.setOnClickListener {
            runCatching {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(channel.sourceWebsite)))
            }
        }

        val favBtn = view.findViewById<TextView>(R.id.btnFavoriteToggle)
        val isFav = prefs.isFavorite(channel.channelId)
        favBtn.text = getString(
            if (isFav) R.string.action_remove_favorite else R.string.action_add_favorite
        )
        favBtn.setOnClickListener {
            val nowFav = prefs.toggleFavorite(channel.channelId)
            favBtn.text = getString(
                if (nowFav) R.string.action_remove_favorite else R.string.action_add_favorite
            )
            if (activeTab == Tab.FAVORITES) applyFilters()
        }

        AlertDialog.Builder(this)
            .setView(view)
            .setPositiveButton(R.string.btn_close, null)
            .create()
            .show()
    }

    // ===== 返回鍵 =====

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        // 返回鍵：優先關閉搜尋框 / 對話框（由 AlertDialog 自行處理）
        // 在主畫面時，返回 = 結束 App
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            val focused = currentFocus
            if (focused is EditText) {
                focused.clearFocus()
                return true
            }
            finish()
            return true
        }

        // 數字鍵 0-9：快速跳到對應頻道編號（若有）
        if (keyCode in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9) {
            val digit = keyCode - KeyEvent.KEYCODE_0
            val match = catalog.channels.firstOrNull { it.channelNumber == digit }
            if (match != null) {
                playChannel(match)
                return true
            }
        }

        return super.onKeyDown(keyCode, event)
    }
}
