# 系統設計（Phase 1）

> 對應需求：C 頻道分類、D 頻道資料管理、A Android TV APK、B 網頁版

## 1. 系統架構圖

```
┌──────────────────────────────────────────────────────────────────────┐
│                        shared/channels.json                          │
│                 ★ 唯一真實來源 (Single Source of Truth) ★             │
│                                                                       │
│  channels[]: channel_id / channel_name / category / logo /           │
│              stream_url / stream_type / source_name /                │
│              source_website / authorization_status / is_active /     │
│              last_checked / description / tags / cors_enabled        │
│  categories[]: id / name / order / icon                              │
└───────────────┬──────────────────────────────────┬───────────────────┘
                │                                  │
     scripts/sync-channels.mjs          scripts/validate-channels.mjs
     （先驗證再同步）                    （授權守門，失敗即中止建置）
                │                                  │
        ┌───────┴────────┐                         │
        │                │                         │
        ▼                ▼                         ▼
┌───────────────┐ ┌──────────────┐        ┌──────────────┐
│ Android assets│ │  Web public  │        │ 建置失敗      │
│ channels.json │ │ channels.json │        │ exit code 1  │
│ (APK 內建)    │ │ (靜態 JSON)   │        │              │
└───────┬───────┘ └──────┬───────┘        └──────────────┘
        │                │
        ▼                ▼
┌────────────────┐  ┌─────────────────┐
│  Android TV    │  │   Next.js 16    │
│  APK           │  │   Web 版        │
│  Kotlin        │  │   TypeScript    │
│  Media3        │  │   HLS.js        │
│  ExoPlayer     │  │   + Safari 原生  │
└────────┬───────┘  └────────┬────────┘
         │                   │
         ▼                   ▼
┌────────────────┐  ┌─────────────────┐
│  電視盒         │  │  瀏覽器          │
│  (實機, D-pad) │  │  (桌面/手機/平板) │
└────────────────┘  └─────────────────┘
```

### 資料流不變式

> **APK 與 Web 讀到的頻道資料必然相同**，因為兩者都是同一次
> `sync-channels.mjs` 執行的產物，且來源是同一個檔案。
>
> 驗證方式：`scripts/test-channel-consistency.mjs` 比對三份檔案的
> 頻道 id 清單與關鍵欄位（網址/類型/授權/來源），任何不一致即失敗。

## 2. Android TV APK 架構

### 2.1 模組結構

```
android/app/src/main/java/com/taiwanlivetv/
├── data/
│   ├── ChannelRepository.kt     頻道資料載入 + 授權守門 + 快取
│   ├── ChannelPreferences.kt    收藏 / 最近觀看 / 上次頻道（SharedPreferences）
│   └── (Channel, Category, ChannelCatalog)  資料模型
├── player/
│   ├── TvPlayerController.kt    ExoPlayer 包裝、重試策略、錯誤訊息
│   └── NetworkMonitor.kt        網路狀態監控 → 斷線恢復自動重連
└── ui/
    ├── MainActivity.kt          主畫面、遙控器事件、搜尋、頻道資訊
    ├── ChannelAdapter.kt        頻道列（RecyclerView, D-pad focus）
    └── CategoryAdapter.kt       分類列
```

### 2.2 版面（1920×1080）

```
┌────────────────────────────────────────────────────────────┐
│ 台灣電視直播    [頻道][最愛][最近]              [搜尋]      │ ← 頂部列
├────────────────────────────────────────────────────────────┤
│                                                            │
│                    播放器 (PlayerView)                      │ ← 主視覺
│              全螢幕，Error overlay 疊在此層                 │
│                                                            │
├────────────────────────────────────────────────────────────┤
│ [台標] 頻道名稱   播放狀態              [頻道資訊]          │ ← 資訊列
├────────────────────────────────────────────────────────────┤
│ [全部][新聞台][綜合台][娛樂台][財經台][公共電視]...        │ ← 分類列
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐                │
│ │卡片│ │卡片│ │卡片│ │卡片│ │卡片│ │卡片│  ← 橫向捲動      │ ← 頻道列
│ └────┘ └────┘ └────┘ └────┘ └────┘ └────┘                │
└────────────────────────────────────────────────────────────┘
```

### 2.3 遙控器操作對應

| 按鍵 | 行為 | 實作 |
|---|---|---|
| 上下左右 | focus 在分頁 → 分類 → 頻道卡間移動 | RecyclerView 內建 focus 管理 + `focusable=true` 的 ViewHolder |
| 確認 (DPAD_CENTER / ENTER) | 在頻道卡上切換播放 | `setOnClickListener` |
| 確認 | 在錯誤面板上重新連線 | `btnRetry` 自動取得 focus |
| 返回 (BACK) | 關閉輸入焦點 → 結束 App | `onKeyDown` 覆寫 |
| 數字 0–9 | 跳至對應頻道編號（若有 channel_number） | `onKeyDown` 攔截 |

**全程不依賴觸控**：`uses-feature android.hardware.touchscreen required=false`，
所有可互動元件設定 `focusable=true` + `focusableInTouchMode=false`。

### 2.4 Overscan 防護

部分電視機會裁切畫面邊緣（overscan）。對策：

1. 容器使用 `@dimen/safe_margin_horizontal` (48dp) / `safe_margin_vertical` (36dp)
   安全邊距，而非貼齊螢幕邊緣
2. 緊湊模式（頻道列與頂部列）用較小的 `*_compact` 邊距 (24dp / 18dp)
3. 文字最小 13sp（`text_channel_meta`），確保在 1080p 下清晰可讀
4. 焦點框粗度 3dp（`focus_stroke_width`），在低解析度螢幕仍明顯可見
5. 所有文字 `maxLines=1` + `ellipsize=end`，避免換行造成版面溢出

### 2.5 播放與錯誤處理

```
play(channel)
  ├─ 檢查 streamUrl 非空 → 否則直接顯示錯誤
  ├─ ExoPlayer.prepare() + playWhenReady = true
  └─ 監聽 Player.Listener
       ├─ STATE_BUFFERING → UI 顯示「連線中…」
       ├─ STATE_READY      → UI 顯示「播放中」
       ├─ STATE_ENDED      → 視為異常，指數退避重試
       └─ onPlayerError
            ├─ 網路類錯誤 且 retryCount < 3 → 指數退避重試
            │     1.5s → 3s → 6s（上限 8s）
            └─ 否則 → 顯示明確錯誤訊息 + 「重新連線」按鈕（自動取得 focus）
```

**網路恢復**：`NetworkMonitor` 註冊 `ConnectivityManager.NetworkCallback`，
`onNetworkAvailable` 時若播放器處於錯誤狀態則自動重連。

**授權相關錯誤特別處理**：
- `ERROR_CODE_IO_CLEARTEXT_NOT_PERMITTED` → 「不允許明文 (HTTP) 串流」
- `ERROR_CODE_IO_NO_PERMISSION` → 「沒有存取該串流的權限」
- `ERROR_CODE_PARSING_MANIFEST_MALFORMED` → 「串流清單格式錯誤」

### 2.6 持久化

`ChannelPreferences`（SharedPreferences）：

| Key | 內容 |
|---|---|
| `favorites` | 收藏頻道 id 集合（StringSet） |
| `recent_channels` | 最近觀看 id，以 `\u001F` 分隔，由新到舊，上限 20 筆 |
| `last_channel_id` | 上次觀看頻道 → 啟動時自動恢復 |

選用 SharedPreferences 而非 Room/DataStore：資料量極小（數十筆），
需要零啟動延遲與最低相容性（minSdk 23 的電視盒）。

### 2.7 未來擴充：管理後台

需求 D 提到「未來希望可以增加管理後台，方便新增、修改、停用頻道，而不必重新編譯 APK」。

**現行設計已為此預留**：`ChannelRepository` 讀取 assets 的邏輯與授權守門是分開的，
未來可改成：

```
啟動時 → 優先抓取遠端 channels.json（Web 版的 /channels.json）
       → 成功且通過授權守門 → 使用遠端版本（並寫入本地快取）
       → 失敗 → 回退到 assets 內建版本
```

如此新增頻道只需更新網頁端的 JSON，APK 下次啟動自動取得新清單，
**不必重新編譯 APK**。此項列為 Phase 6 之後的擴充項，不在本次交付範圍。

## 3. Web 版架構

### 3.1 模組結構

```
web/src/
├── app/
│   ├── layout.tsx           Root layout（中繼資料、viewport、深色主題）
│   ├── page.tsx             主頁（伺服器端取得 catalog，客戶端互動）
│   ├── page.module.css      頁面樣式
│   └── globals.css          重置 + CSS 變數
├── components/
│   ├── VideoPlayer.tsx      播放器 + 狀態疊層（載入/錯誤/點擊播放）
│   ├── VideoPlayer.module.css
│   ├── ChannelInfoDialog.tsx     頻道資訊（來源 + 授權狀態）
│   └── ChannelInfoDialog.module.css
└── lib/
    ├── types.ts             頻道型別 + 授權守門 isPublishable()
    ├── catalog.ts           fetchCatalog() + 錯誤處理
    ├── storage.ts           localStorage 收藏/最近/上次頻道
    ├── useChannelBrowser.ts 瀏覽狀態（分頁/分類/搜尋）
    └── useHlsPlayer.ts      HLS 播放 Hook
```

### 3.2 播放策略分流

```
使用 Hls.isSupported()（MediaSource）？
  ├─ 是 → hls.js 路徑
  │        ├─ MANIFEST_PARSED → 播放
  │        ├─ NETWORK_ERROR  → 顯示錯誤 + startLoad()
  │        ├─ MEDIA_ERROR    → 顯示錯誤 + recoverMediaError()
  │        └─ 其他 fatal      → 顯示錯誤 + teardown()
  └─ 否 → canPlayType('application/vnd.apple.mpegurl')？
           ├─ 是 → 原生 HLS
           └─ 否 → 顯示「此瀏覽器不支援 HLS 播放」
```

**重要陷阱**：桌面版 Chromium 的 `canPlayType('application/vnd.apple.mpegurl')`
會回傳 `"maybe"`，但它**實際上無法播放原生 HLS**。若只相信 canPlayType，
Chromium 會被誤導進原生路徑並永久卡在載入中。

因此 `shouldUseNativeHls()` 的判斷順序是：

1. 明確是 Safari / iOS（排除 Chrome/Chromium/CriOS/Edg/OPR/Android）→ 原生 HLS
2. 其餘一律用 hls.js（以 `Hls.isSupported()` 判斷）
3. hls.js 不支援時才退回原生 HLS（保險）

### 3.3 自動播放政策

瀏覽器要求媒體播放必須有使用者互動或為靜音。對策：

- `<video muted playsInline>` 靜音自動播放（合法）
- `video.play()` 被拒絕時 → 顯示「點擊開始播放」遮罩
- 遮罩 `tabIndex=0` 並自動取得 focus，使用者可直接按 Enter
- 音訊：使用者點擊後可用瀏覽器的音量控制開啟

### 3.4 錯誤呈現原則

> **不得將無效串流假裝成正常播放。**

狀態機與 UI 對應：

| status | UI |
|---|---|
| `idle` | 無疊層（等待選擇頻道） |
| `loading` | 轉圈 + 「連線中…」（`role="status"`） |
| `playing` | 無疊層，video 正常顯示 |
| `error` | 紅色「播放失敗」+ 具體錯誤原因 + 「重新連線」按鈕（`role="alert"`） |

**載入 watchdog**：25 秒內未進入 `readyState >= 3` 且 `currentTime > 0`，
強制轉為錯誤狀態。避免串流卡住時永遠顯示「連線中」。

### 3.5 響應式

| 斷點 | 行為 |
|---|---|
| > 1800px | 容器最大寬 1760px，頻道網格最小欄寬 220px，字級放大 |
| 640–900px | 頻道網格最小欄寬 140px |
| < 640px | 頁面單欄、搜尋框滿版、網格最小欄寬 116px、播放器資訊垂直排列 |

防止水平捲動的必要條件（已在 `page.module.css` 實作）：

- `.page { min-width: 0 }` + `.page > * { min-width: 0 }`
  （flex 容器預設 `min-width:auto` 會讓子元素撐破容器）
- `.categoryBar { max-width: 100%; min-width: 0; overflow-x: auto }`
  （橫向捲動容器本身不可撐大）
- `.playerShell { aspect-ratio: 16/9 }` + `.playerVideo { width:100%; max-width:100%; height:100%; object-fit:contain }`
  （video 元素不套用 intrinsic 尺寸）

## 4. 共用頻道資料格式

完整定義見 `shared/schema.md`。摘要：

```
{
  schema_version, updated_at,
  categories: [{ id, name, name_en, order, icon }],
  channels: [{
    channel_id, channel_name, name_en, category, channel_number,
    logo, stream_url, stream_type, source_name, source_website,
    authorization_status, is_active, last_checked, description,
    tags, region, cors_enabled, http_referrer, notes
  }]
}
```

### 分類架構

| id | 名稱 | order |
|---|---|---|
| `news` | 新聞台 | 1 |
| `general` | 綜合台 | 2 |
| `entertainment` | 娛樂台 | 3 |
| `finance` | 財經台 | 4 |
| `public` | 公共電視 | 5 |
| `life` | 生活資訊 | 6 |
| `education` | 教育文化 | 7 |
| `local` | 地方及其他頻道 | 8 |

分類架構不代表每個分類都有合法來源；沒有合法來源的分類會是空的。

## 5. CORS 與 Web 版代理方案

這是本專案**最大的技術風險**，會直接決定「哪些頻道能上網頁版」。

### 現況

- **Android ExoPlayer 不受 CORS 限制** —— 播放器在原生層，直接對來源發出請求
- **瀏覽器 HLS.js 受 CORS 限制** —— 來源必須回傳 `Access-Control-Allow-Origin`

實測 28 個頻道：**18 個支援 CORS，10 個不支援**（來自 `cdn.qd.je` 與
`61.221.215.25:8800` 等轉載主機）。

### 已實作的方案：Next.js 代理路由

`web/src/app/api/proxy/route.ts` —— 單一端點同時處理 manifest 與 segment。

```
GET /api/proxy?url=<URL-encoded 目標網址>
```

**manifest 改寫**：代理取得 manifest 後，會把裡面的 segment／子 manifest 網址
全部改寫成代理網址，否則瀏覽器還是會直接去來源拿 segment 而失敗。

```m3u8
# 原始（來源不支援 CORS，瀏覽器會擋）
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=6000000
https://8.fast.hidns.vip/163189/lhjd

# 代理改寫後
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=6000000
/api/proxy?url=https%3A%2F%2F8.fast.hidns.vip%2F163189%2Flhjd
```

### 安全設計

代理是對外開放的端點，必須防止被當成任意網址的開放代理。四道防線：

| 防線 | 說明 |
|---|---|
| **1. 入口白名單** | 目標網址必須是已授權頻道的 `stream_url` 或備援來源，否則 403 |
| **2. 子資源動態發現** | master manifest 會指向其他主機的子清單，這些無法事先列舉。採用「只能從已授權 manifest 中發現」的動態白名單 |
| **3. SSRF 防護** | 所有請求解析 DNS 並檢查目標 IP，阻擋 `127.0.0.0/8`、`10.0.0.0/8`、`172.16/12`、`192.168/16`、`169.254/16`、`::1`、`fc00::/7` 與雲端 metadata 位址 |
| **4. 協定限制** | 只允許 `http:` / `https:` |

實測結果：

```
未授權網址       https://example.com/evil.m3u8        → 403
未授權網址       https://www.google.com/               → 403
SSRF 迴圈位址    http://127.0.0.1:3210/channels.json  → 403
SSRF metadata    http://169.254.169.254/latest/...    → 403
SSRF 私有網段    http://192.168.31.8:3210/            → 403
SSRF IPv6 迴圈   http://[::1]:3210/                   → 403
缺少 url 參數                                          → 400
```

### 頻寬成本

代理會讓伺服器承載這些頻道的全部流量。10 個 CORS✗ 頻道在有觀眾時才會產生流量，
且這些多為備援節點，單頻道流量不大。

**啟用範圍**：只有 `cors_enabled: false` 的頻道會走代理；
`cors_enabled: true` 的頻道仍直接連來源，不經伺服器。

### 部署注意

代理需要 **Node.js runtime**（用 `node:dns/promises` 做 SSRF 檢查），
因此網站不能是純靜態輸出，必須保留 serverless／Node 環境。

Netlify 免費方案支援 Next.js 的動態路由，無需額外費用。

## 6. 頻道授權與來源管理

完整政策見 `docs/02-license-policy.md`。架構層面的三道防線：

1. **建置期**：`scripts/validate-channels.mjs` 在同步前驗證，
   未授權頻道若 `is_active=true` → exit 1 → 建置失敗
2. **同步期**：`scripts/sync-channels.mjs` 只把 `is_active=true` 且
   授權狀態屬允許值的頻道寫入兩端產物
3. **執行期**：兩端各自再過濾一次
   - Android `ChannelRepository.parse()`：非允許授權狀態 → 不載入
   - Web `isPublishable()`：非允許授權狀態 → 不顯示

三道防線是刻意的冗餘：任一層失效時，其他層仍能擋下未授權內容。

## 7. 部署方案

| 項目 | 方案 | 費用 |
|---|---|---|
| Web 版 | Netlify 免費方案，靜態輸出 | $0 |
| 頻道 JSON | 同站 `public/channels.json`，CDN 快取 60s | $0 |
| Android APK | 自行建置後提供安裝檔 | $0 |
| APK 更新（未來） | 官網下載頁 + 版本檢查 | $0 |

**不擅自變更既有網域或部署環境** —— 部署需使用者確認後執行。
