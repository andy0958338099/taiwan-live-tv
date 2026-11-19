# 頻道資料結構定義 (Channel Schema)

`shared/channels.json` 是整個系統的**唯一真實來源**。Android APK 與 Web 版都從這一份資料產生，
由 `scripts/sync-channels.mjs` 同步。任何一端都不允許自己維護另一份頻道清單。

## 頂層結構

```jsonc
{
  "schema_version": "1.0.0",      // 格式版本，前端據此做相容處理
  "updated_at": "2026-11-19T12:00:00Z",
  "categories": [ ... ],          // 分類定義（顯示順序 + 中文名）
  "channels": [ ... ]             // 頻道陣列
}
```

## Category 欄位

```jsonc
{
  "id": "news",                  // 穩定識別碼，不可更動（前端會存進收藏/歷史）
  "name": "新聞台",               // 中文顯示名
  "name_en": "News",
  "order": 1,                    // 顯示順序，小的在前
  "icon": "news"                 // 對應圖示 key（見 docs/01-system-design.md）
}
```

規劃的分類架構（對應 `category` 欄位）：

1. `news` 新聞台
2. `general` 綜合台
3. `entertainment` 娛樂台
4. `finance` 財經台
5. `public` 公共電視
6. `life` 生活資訊
7. `education` 教育文化
8. `local` 地方及其他頻道

> 分類架構不代表所有頻道都有合法可用的直播來源。沒有合法來源的分類可能為空。

## Channel 欄位（必要）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `channel_id` | string | 穩定唯一識別碼，建議格式 `{slug}` 或 `{network}-{name}`。**建立後不可更動**，收藏與歷史以此為準 |
| `channel_name` | string | 中文頻道名稱，顯示於 UI |
| `category` | string | 所屬分類 id，必須存在於 `categories` 陣列 |
| `logo` | string \| null | 台標圖片 URL。`null` 時前端顯示頻道名稱首字佔位 |
| `stream_url` | string | 直播串流網址（HLS `.m3u8` 或 DASH `.mpd`）。**不可為空字串或 null 才算有效頻道** |
| `stream_type` | enum | `hls` \| `dash` \| `mp4` \| `progressive` |
| `source_name` | string | 來源名稱（例如「台視 TTV 官方網站」）。**必填**，不可留空 |
| `source_website` | string | 來源官方網址。**必填**，不可留空 |
| `authorization_status` | enum | 授權狀態，見下表。**建置前檢查** |
| `is_active` | boolean | 是否啟用。停用的頻道不出現在 UI，但保留資料 |
| `last_checked` | string | ISO 8601 格式，最後一次檢查串流可用性的時間 |
| `description` | string | 頻道簡介，顯示於詳情／資訊面板 |

## Channel 欄位（選填）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `name_en` | string | 英文名稱 |
| `channel_number` | number \| null | 頻道號碼，若來源有提供 |
| `tags` | string[] | 關鍵字，強化搜尋比對 |
| `region` | string \| null | 地區（例如「台北」「高雄」），地方台用 |
| `cors_enabled` | boolean | 是否確認支援跨網域載入。`false` 時 Web 版需代理，見下方說明 |
| `http_referrer` | string \| null | 需要 Referer 標頭的來源；Web 代理可用，APK 需自訂 header |
| `notes` | string | 內部備註，不對使用者顯示 |
| `checked_by` | string | 執行檢查的人或腳本 |

## authorization_status 授權狀態

| 值 | 意義 | 可上線 |
|---|---|---|
| `authorized` | 官方明確授權嵌入或重新發佈 | ✅ |
| `public_official` | 官方公開直播頁，且官方提供 embed 播放器（默許嵌入） | ✅ |
| `user_provided` | 使用者自行提供，且使用者確認有權使用 | ✅ |
| `pending_review` | 已列入清單，但授權狀態尚未確認 | ❌ 不可上線 |
| `restricted` | 明確不允許重新播放，或需繞過登入/付費/DRM/地區限制 | ❌ 不可上線 |
| `unknown` | 授權狀態不明 | ❌ 不可上線 |

`scripts/validate-channels.mjs` 的規則：
- `authorization_status` 必須是上表六值之一
- 非 `authorized` / `public_official` / `user_provided` 的頻道，**若 `is_active: true` 則建置失敗**
- `stream_url` 為空、`source_name` 為空、`source_website` 為空 → 建置失敗
- `category` 必須存在於 `categories`
- `channel_id` 不得重複
- `stream_url` 開頭必須是 `http://` 或 `https://`（禁止 `file://`、`rtsp://` 等本地路徑）

## CORS 與 Web 版

`cors_enabled` 記錄該來源是否回傳 `Access-Control-Allow-Origin`：

- `true`：HLS.js 可直接載入，Web 版零額外成本
- `false`：**Android ExoPlayer 不受 CORS 限制，可正常播放**；Web 版需經 Next.js 路由代理轉送 segment

代理的取捨（記錄於 `docs/01-system-design.md`）：
代理會讓伺服器承載串流頻寬，且必須只代理授權頻道。預設策略為**只對 `cors_enabled: false` 且
`authorization_status` 為允許值的頻道開啟代理**，並記錄使用量以便日後切換為 CDN。

## 範例

```jsonc
{
  "channel_id": "ttv",
  "channel_name": "台視",
  "name_en": "Taiwan Television",
  "category": "general",
  "channel_number": null,
  "logo": null,
  "stream_url": "https://example.com/authorized/ttv/master.m3u8",
  "stream_type": "hls",
  "source_name": "台視 TTV 官方網站",
  "source_website": "https://www.ttv.com.tw/",
  "authorization_status": "public_official",
  "is_active": true,
  "last_checked": "2026-11-19T12:00:00Z",
  "description": "台灣電視公司",
  "tags": ["台視", "TTV"],
  "region": null,
  "cors_enabled": true,
  "http_referrer": null,
  "notes": ""
}
```
