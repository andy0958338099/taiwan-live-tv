package com.taiwanlivetv.ui

import android.view.LayoutInflater
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.taiwanlivetv.R

/** 分類列 Adapter（全部 / 各分類） */
class CategoryAdapter(
    private val onCategoryClick: (String) -> Unit,
) : RecyclerView.Adapter<CategoryAdapter.CategoryViewHolder>() {

    private val items = mutableListOf<Pair<String, String>>() // id -> 顯示名稱
    private var selectedId: String? = null

    fun submit(newItems: List<Pair<String, String>>) {
        items.clear()
        items.addAll(newItems)
        notifyDataSetChanged()
    }

    fun setSelected(id: String?) {
        if (selectedId == id) return
        val oldIndex = items.indexOfFirst { it.first == selectedId }
        selectedId = id
        val newIndex = items.indexOfFirst { it.first == id }
        if (oldIndex >= 0) notifyItemChanged(oldIndex)
        if (newIndex >= 0) notifyItemChanged(newIndex)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): CategoryViewHolder {
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_category, parent, false) as TextView
        return CategoryViewHolder(view)
    }

    override fun onBindViewHolder(holder: CategoryViewHolder, position: Int) {
        holder.bind(items[position])
    }

    override fun getItemCount(): Int = items.size

    inner class CategoryViewHolder(
        private val view: TextView,
    ) : RecyclerView.ViewHolder(view) {

        fun bind(item: Pair<String, String>) {
            view.text = item.second
            view.isSelected = item.first == selectedId
            view.setOnClickListener { onCategoryClick(item.first) }
        }
    }
}
