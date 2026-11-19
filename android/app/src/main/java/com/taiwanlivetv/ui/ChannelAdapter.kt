package com.taiwanlivetv.ui

import android.graphics.Color
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.taiwanlivetv.data.Channel
import com.taiwanlivetv.databinding.ItemChannelBinding

/**
 * 頻道列 Adapter。
 *
 * 遙控器操作要點：
 *  - 每個 ViewHolder 本身 focusable，由 RecyclerView 的 focus 管理
 *  - 選中狀態（正在播放的頻道）以 selected 呈現，方便眼睛定位
 */
class ChannelAdapter(
    private val onChannelClick: (Channel) -> Unit,
    private val onChannelFocused: (Channel) -> Unit,
) : RecyclerView.Adapter<ChannelAdapter.ChannelViewHolder>() {

    private val items = mutableListOf<Channel>()
    private var selectedChannelId: String? = null
    private var categoryNames: Map<String, String> = emptyMap()

    fun submit(newItems: List<Channel>) {
        items.clear()
        items.addAll(newItems)
        notifyDataSetChanged()
    }

    fun setCategoryNames(map: Map<String, String>) {
        categoryNames = map
    }

    fun setSelected(channelId: String?) {
        if (selectedChannelId == channelId) return
        val oldId = selectedChannelId
        selectedChannelId = channelId
        // 只刷新受影響的兩筆，避免全列表重繪造成的閃爍
        listOfNotNull(oldId, channelId).forEach { id ->
            val index = items.indexOfFirst { it.channelId == id }
            if (index >= 0) notifyItemChanged(index)
        }
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ChannelViewHolder {
        val binding = ItemChannelBinding.inflate(
            LayoutInflater.from(parent.context), parent, false
        )
        return ChannelViewHolder(binding)
    }

    override fun onBindViewHolder(holder: ChannelViewHolder, position: Int) {
        holder.bind(items[position])
    }

    override fun getItemCount(): Int = items.size

    inner class ChannelViewHolder(
        private val binding: ItemChannelBinding,
    ) : RecyclerView.ViewHolder(binding.root) {

        fun bind(channel: Channel) {
            binding.cardName.text = channel.displayName
            binding.cardCategory.text = categoryNames[channel.category] ?: channel.category
            binding.cardRoot.isSelected = channel.channelId == selectedChannelId

            // 台標：無 logo 時顯示名稱首字佔位
            val logo = channel.logo
            if (!logo.isNullOrBlank()) {
                binding.cardLogo.visibility = android.view.View.VISIBLE
                binding.cardPlaceholder.visibility = android.view.View.GONE
                // 圖片載入延後到 MVP 之後；目前先顯示佔位首字
                binding.cardLogo.setImageDrawable(null)
            } else {
                binding.cardLogo.visibility = android.view.View.GONE
                binding.cardPlaceholder.visibility = android.view.View.VISIBLE
                binding.cardPlaceholder.text = channel.displayName.take(1)
                binding.cardPlaceholder.setTextColor(
                    Color.parseColor(colorForCategory(channel.category))
                )
            }

            binding.cardRoot.setOnClickListener {
                onChannelClick(channel)
            }
            binding.cardRoot.setOnFocusChangeListener { _, hasFocus ->
                if (hasFocus) onChannelFocused(channel)
            }
        }
    }

    private fun colorForCategory(category: String): String = when (category) {
        "news" -> "#FF4CAF50"
        "general" -> "#FF3D8BFF"
        "entertainment" -> "#FFFF7043"
        "finance" -> "#FF26A69A"
        "public" -> "#FFAB47BC"
        "life" -> "#FF42A5F5"
        "education" -> "#FF9CCC65"
        "local" -> "#FFFFCA28"
        else -> "#FF9E9E9E"
    }
}
