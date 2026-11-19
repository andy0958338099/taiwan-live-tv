# 頻道授權與來源管理政策（Phase 1）

> 對應需求：四、合法影音來源

## 1. 基本原則

本專案只使用以下類型的來源：

1. **官方公開直播** —— 頻道業者公開提供、且明確允許嵌入或重新發佈
2. **經授權使用的直播串流** —— 取得業者書面或頁面上明確的授權
3. **使用者自行提供且有權使用的 IPTV 串流** —— 由使用者提供並確認權利
4. **明確允許重新播放或嵌入的影音來源** —— 頁面提供 embed 程式碼或公開 API

### 明確禁止

- ❌ 破解付費電視頻道
- ❌ 繞過任何 DRM（Widevine / FairPlay / PlayReady）
- ❌ 未經授權擷取付費電視訊號
- ❌ **偽造或猜測串流 URL**
- ❌ 繞過網站登入、付費牆或存取限制
- ❌ 將不允許重新播放的官方網站影片轉接成自己的直播服務
- ❌ 以本專案的 CORS 代理繞過來源的存取控制

> 最後一點特別重要：代理（proxy）只解決瀏覽器的同源政策限制，
> **不會改變來源的授權狀態**。不允許發佈的來源，不會因為加了代理就變成可以發佈。

## 2. 授權狀態定義

| 狀態 | 意義 | 可上線 | 判定依據 |
|---|---|---|---|
| `authorized` | 官方明確授權嵌入或重新發佈 | ✅ | 有書面授權，或官方頁面明確標示可嵌入／可轉載 |
| `public_official` | 官方公開直播頁且提供 embed 播放器 | ✅ | 官方頁面含 iframe 播放器且未設防嵌入限制，等同默許嵌入 |
| `user_provided` | 使用者自行提供且確認有權使用 | ✅ | 使用者明確聲明擁有該串流的使用權利 |
| `pending_review` | 已列入清單但授權狀態尚未確認 | ❌ | 查證中，或使用者尚未提供授權證明 |
| `restricted` | 不允許重新播放，或需繞過登入／付費／DRM／地區限制 | ❌ | 頁面明確標示版權所有，或需登入才能取得串流 |
| `unknown` | 授權狀態不明 | ❌ | 無法查證、或來源無法辨識 |

**判定原則**：無法確認 → 記為 `pending_review` 或 `unknown`，不得上線。
「猜測它應該可以」不是判定依據。

## 3. 三道防線

授權守門不是靠人工記憶，而是寫在建置流程裡。

### 防線一：建置期驗證

`scripts/validate-channels.mjs` —— 在同步之前執行，任何一條規則失敗即 `exit 1`：

- `authorization_status` 必須是六個合法值之一
- **非允許授權狀態的頻道，若 `is_active=true` → 建置失敗**
- `stream_url` 為空 → 失敗
- `source_name` 或 `source_website` 為空 → 失敗（來源必須標註）
- `source_website` 非 http(s) → 失敗
- `stream_url` 非 http(s) 開頭 → 失敗（禁止 `file://`、`rtsp://` 等）
- `category` 必須存在於 `categories` 定義
- `channel_id` 不得重複
- `stream_type` 必須是 `hls`/`dash`/`mp4`/`progressive`

### 防線二：同步期過濾

`scripts/sync-channels.mjs` 只把 `is_active=true` **且** 授權狀態屬允許值的頻道
寫入 `android/app/src/main/assets/channels.json` 與 `web/public/channels.json`。

未授權頻道保留在 `shared/channels.json`（供日後確認），但絕不進入任何公開產物。

### 防線三：執行期過濾

即使前兩道防線失效，兩端執行時仍會各自再過濾一次：

- Android：`ChannelRepository.parse()` — 授權狀態不符 → 不載入該頻道
- Web：`isPublishable()` — 授權狀態不符 → 不渲染

**三道防線是刻意的冗餘。** 授權是本專案最不能出錯的部分，
任何單一防線都可能有實作疏漏（例如未來新增管理後台時寫入邏輯有 bug），
多層獨立檢查能把風險降到可接受。

## 4. 新增頻道的標準流程

```
1. 收集來源資訊
   ├─ 頻道名稱、分類
   ├─ 官方網站 URL
   ├─ 直播頁 URL
   ├─ 串流 URL（或播放器 API 回傳的 URL）
   └─ 授權依據（頁面截圖／embed 程式碼／書面授權／使用者聲明）

2. 判定授權狀態
   ├─ 有 embed 播放器 → public_official
   ├─ 有明確授權聲明 → authorized
   ├─ 使用者提供且確認有權 → user_provided
   ├─ 需登入／付費／繞過限制 → restricted
   └─ 查不出來 → pending_review

3. 寫入 shared/channels.json（authorization_status 如實填寫）

4. 執行 node scripts/validate-channels.mjs
   ├─ 通過 → 繼續
   └─ 失敗 → 修正後重跑

5. 執行 node scripts/sync-channels.mjs
   （會自動驗證 → 同步到兩端）

6. 執行 node scripts/test-channel-consistency.mjs
   （確認 APK 與 Web 讀到相同資料）

7. 實測播放，並更新 last_checked
```

**禁止**：先寫 `is_active=true` 再補授權判定。必須先確定授權狀態。

## 5. 欄位填寫規範

| 欄位 | 規範 |
|---|---|
| `channel_id` | 穩定唯一，建立後**不可更動**（收藏與歷史以此為準）。格式 `{network}-{name}`，例：`ttv-general` |
| `channel_name` | 中文正式名稱 |
| `category` | 必須是 `categories` 中已定義的 id |
| `logo` | 台標圖片 URL；無則填 `null`（前端顯示頻道名首字佔位） |
| `stream_url` | 完整 HLS/DASH URL。**不可留空或填佔位字串** |
| `stream_type` | `hls`（多數直播）/ `dash` / `mp4` / `progressive` |
| `source_name` | 來源名稱，例：「台視 TTV 官方網站」 |
| `source_website` | 來源官方網址（供使用者查證） |
| `authorization_status` | 見上表 |
| `is_active` | 是否上線。未確認授權者必須為 `false` |
| `last_checked` | ISO 8601，例 `2026-11-19T12:00:00Z` |
| `description` | 頻道簡介 |
| `tags` | 關鍵字，強化搜尋比對 |
| `cors_enabled` | 來源是否回傳 `Access-Control-Allow-Origin`。**需實測確認**，不可猜測 |
| `http_referrer` | 需要 Referer 標頭的來源才填 |

## 6. CORS 檢查方法

```bash
curl -sS -o /dev/null -D - --max-time 15 \
  -H "Origin: https://your-domain.example" \
  "https://source.example/live/stream.m3u8" | grep -i "access-control-allow-origin"
```

- 有回應標頭 → `cors_enabled: true`（Web 版可直接播放）
- 沒有 → `cors_enabled: false`（Web 版需代理；Android 版不受影響）

## 7. 移除與停用頻道

若來源變更、不再允許嵌入、或收到下架要求：

1. 將 `is_active` 改為 `false`（保留資料紀錄）
2. 執行 `sync-channels.mjs` → 該頻道立即從兩端消失
3. 若情況是「來源已失效」而非「授權問題」，同時更新 `last_checked` 與 `notes`

**不刪除紀錄** —— 保留 `is_active=false` 的紀錄可追蹤歷史，
且驗證腳本會明確列出未上線頻道，方便定期檢視。

## 8. 定期檢視

建議每月執行一次：

```bash
node scripts/validate-channels.mjs     # 檢查資料完整性與授權狀態
node scripts/test-channel-consistency.mjs  # 確認兩端資料一致
```

並人工抽查：
- `last_checked` 超過 3 個月的頻道，重新確認串流是否仍有效
- `authorization_status: public_official` 的頻道，確認官方頁面未變更嵌入政策
