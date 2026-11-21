# 測試報告

> 產出日期：2026-11-19
> 測試對象：`shared/channels.json` 中的 3 個官方測試串流（尚未取得實際台灣頻道授權來源）

## 0. 測試環境限制（重要）

**Headless Chromium 無法解碼影片。**

測試過程中發現 Hermes 內建的 HeadlessChrome 145 存在以下現象：

| 檢查 | 結果 |
|---|---|
| `canPlayType('video/mp4; codecs="avc1.42E01E"')` | 回傳 `"probably"` |
| `canPlayType('video/webm; codecs="vp8"')` | 回傳 `"probably"` |
| `MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"')` | 回傳 `true` |
| 純 `<video src="...ts">`（不經 hls.js） | `readyState=0`，無錯誤事件，永久停住 |
| 純 `MediaSource` + `appendBuffer`（不經 hls.js） | `sourceopen` **從未觸發** |
| 純 `<video src="....webm">` | `readyState=0` |
| WebCodecs `VideoDecoder.isConfigSupported(avc1.42E01E)` | 回傳 `true` |

結論：**瀏覽器回報支援，但實際沒有可用的媒體解碼管線**。
這是測試環境的限制，與本專案程式碼無關 —— 因為純 MSE 測試（完全不經過
本專案的任何程式碼）同樣失敗。

**因此所有播放驗證改用 `/Applications/Google Chrome.app`（真實 Chrome，
內建 H.264 解碼器），透過 CDP 遠端偵錯自動執行。**

## 1. 自動化測試腳本

| 腳本 | 用途 |
|---|---|
| `scripts/validate-channels.mjs` | 授權守門與資料完整性驗證 |
| `scripts/sync-channels.mjs` | 同步頻道資料到兩端產物 |
| `scripts/test-channel-consistency.mjs` | 驗證 APK 與 Web 讀到相同資料 |
| `scripts/run-all-checks.mjs` | 完整流程：驗證 → 同步 → 一致性 → 型別 → Web 建置 → APK 建置 → 產出檢查 |

執行結果：

```
════════════════════════════════════════════════════════════════
驗證結果
════════════════════════════════════════════════════════════════
  ✓ 頻道資料驗證（授權守門）                 0.0s
  ✓ 頻道資料同步                       0.1s
  ✓ 兩端資料一致性                      0.0s
  ✓ Web 型別檢查                       0.9s
  ✓ Web 正式建置                       1.7s
  ✓ Android Debug APK 建置              5.0s
  ✓ 產出檔案檢查                       0.0s
════════════════════════════════════════════════════════════════

✓ 全部步驟通過
```

## 2. 逐項測試結果

### 2.1 頻道資料一致性（需求七.8）

**結果：✅ 通過**（11/11 項檢查）

```
[1] 檔案存在性
  ✓ shared/channels.json 存在且可解析
  ✓ android assets/channels.json 存在且可解析
  ✓ web public/channels.json 存在且可解析

[2] 兩端內容一致
  ✓ APK 與 Web 的頻道 id 清單完全相同
  ✓ APK 與 Web 的頻道關鍵欄位（網址/類型/授權/來源）完全相同

[3] 授權守門
  ✓ 沒有任何未授權頻道出現在發佈產物中
  ✓ 每個已發佈頻道都有來源名稱與官方網址
  ✓ 每個已發佈頻道的 stream_url 都是 http(s)

[4] 資料結構
  ✓ 所有頻道的 category 都存在於 categories 定義
  ✓ 沒有重複的 channel_id

[5] 同步狀態
  ✓ 產物時間戳與 shared 一致（表示已執行 sync）

✓ 全部 11 項檢查通過
```

APK 內 `assets/channels.json` 與 Web `public/channels.json` 的實際內容比對：

```
APK: 4 個頻道 → test-mux-bigbuckbunny, test-unified-tearsofsteel,
                 test-apple-bipbop, test-invalid-404
Web: 4 個頻道 → 完全相同
```

### 2.2 直播播放（需求七.4、七.7）

**結果：✅ 通過**（3/3 頻道）

真實 Chrome 實測：

| 頻道 | 來源 | 解析度 | readyState | currentTime | 結果 |
|---|---|---|---|---|---|
| 測試頻道 A | Mux | 848×480 | 4 | 5.8s | ✅ 播放成功 |
| 測試頻道 B | Unified Streaming | 784×350 | 4 | — | ✅ 播放成功 |
| 測試頻道 C | Apple | 640×480 | 4 | — | ✅ 播放成功 |

截圖確認播放器顯示**實際影片畫面**（Big Buck Bunny 動畫畫面），
非黑畫面或載入圖示。

### 2.3 無效串流的錯誤處理（需求七.9）

**結果：✅ 通過**

測試方式：加入 `test-invalid-404` 頻道（`stream_url` 指向不存在的路徑）。

實測結果：
- 錯誤訊息：**「播放失敗」**（紅色標題）
- 詳細原因：**「無法載入串流清單：來源可能未提供跨網域存取（CORS），或網址已失效」**
- 提供 **「重新連線」** 按鈕
- `videoWidth = 0` → **沒有任何假播放畫面**

截圖確認錯誤面板正確呈現。

### 2.4 未授權來源排除（需求七.10）

**結果：✅ 通過**

測試方式：加入 `test-unauthorized-pending` 頻道
（`authorization_status: "pending_review"`，`is_active: false`）。

驗證腳本輸出：
```
未上線頻道（授權狀態未確認，保留資料但不發佈）：
  · test-unauthorized-pending (pending_review)
```

發佈數量：5 筆 → **4 筆**（未授權者被排除）

瀏覽器實測 UI：
- 顯示的頻道：A、B、C、D（4 個）
- **「測試頻道 E」（未授權）完全未出現** ✅

### 2.5 收藏 / 最近觀看 / 上次頻道

**結果：✅ 通過**

```
localStorage keys: ["tltv:v1:favorites", "tltv:v1:recent", "tltv:v1:lastChannel"]
lastChannel: test-mux-bigbuckbunny
recent: ["test-mux-bigbuckbunny"]
favorites: ["test-mux-bigbuckbunny"]   ← 切換到「我的最愛」分頁後顯示 1 個頻道 ✅
```

頻道卡上的 ★ 收藏標記正確顯示。

### 2.6 搜尋（需求 B）

**結果：✅ 通過**

- 輸入關鍵字後，頻道列表即時過濾
- 搜尋結果數量正確
- 搜尋結果為空時顯示「找不到符合「X」的頻道」訊息，而非空白頁

### 2.7 響應式版面（需求 B）

**結果：✅ 通過**

以 CDP `Emulation.setDeviceMetricsOverride` 模擬三種尺寸：

| 裝置 | 尺寸 | clientWidth | scrollWidth | 網格欄數 | 播放器 | 水平溢出 |
|---|---|---|---|---|---|---|
| iPhone | 390×844 | 390 | 390 | 2 | 360×202 | ❌ 無 |
| iPad | 820×1180 | 820 | 820 | 5 | 778×437 | ❌ 無 |
| TV | 1920×1080 | 1905 | 1905 | 7 | 1694×952 | ❌ 無 |

`scrollWidth == clientWidth` 代表**沒有水平捲動溢出**（三種尺寸皆通過）。

### 2.8 Android APK 建置與內容

**結果：✅ 通過**

```
APK: 8.9 MB
package: name='com.taiwanlivetv' versionCode='1' versionName='1.0.0'
compileSdkVersion='36'  targetSdkVersion='36'
application-label:'台灣電視直播'
```

Launcher 入口（**兩種都註冊**，涵蓋 TV 與一般電視盒）：

```
leanback-launchable-activity: name='com.taiwanlivetv.ui.MainActivity'  banner=''
launchable-activity: name='com.taiwanlivetv.ui.MainActivity'  icon=''
```

Manifest 中的 intent-filter：
```
android.intent.category.LEANBACK_LAUNCHER   ← Android TV Launcher
android.intent.category.LAUNCHER            ← 一般電視盒第三方 Launcher
```

權限與 features：
```
uses-permission: android.permission.INTERNET
uses-permission: android.permission.ACCESS_NETWORK_STATE
uses-feature-not-required: android.software.leanback
uses-feature-not-required: android.hardware.touchscreen   ← 不依賴觸控
```

簽章：debug keystore（SHA-256 `6caf4acd664fc127219656c6676556b95ac2c14b5093deb13836fb956093585f`）

### 2.9 APK 內頻道資料

**結果：✅ 通過**

```
assets/channels.json:
  schema_version: 1.0.0
  categories: 8
  channels: 4
  - test-mux-bigbuckbunny    | public_official
  - test-unified-tearsofsteel | public_official
  - test-apple-bipbop        | public_official
  - test-invalid-404         | public_official
```

與 `web/public/channels.json` 的頻道 id 完全相同 ✅

## 3. 測試過程中發現並修復的缺陷

| # | 缺陷 | 影響 | 修復 |
|---|---|---|---|
| 1 | Chromium 的 `canPlayType('application/vnd.apple.mpegurl')` 回傳 "maybe"，導致誤判為支援原生 HLS | **Web 版在所有 Chromium 瀏覽器永久卡在「連線中」** | 新增 `shouldUseNativeHls()`：只對 Safari / iOS 走原生路徑，其餘一律用 hls.js |
| 2 | 播放器元件的 class 名稱在 CSS Modules 重構後失效 | **video 以 intrinsic 尺寸 1280px 渲染，撐破所有窄螢幕版面** | 建立 `VideoPlayer.module.css` 並改用 CSS Modules |
| 3 | `.page` 為 flex 容器但未設 `min-width: 0` | **手機 / 平板出現整頁水平捲動** | `.page { min-width: 0 }` + `.page > * { min-width: 0 }` |
| 4 | `.categoryBar` 未限制 `max-width` | 分類 chip 撐破容器寬度 | 加入 `max-width: 100%; min-width: 0; overflow-y: hidden` |
| 5 | 串流卡住時永遠顯示「連線中」 | 使用者無法分辨「還在載入」與「已經失敗」 | 新增 25 秒載入 watchdog，逾時強制轉為錯誤狀態 |
| 6 | Apple 測試串流 URL 指向 `gear0/prog_index.m3u8`（**純音訊** rendition） | 頻道 C 播放出 0×0 畫面 | 改為 master manifest `bipbop_4x3_variant.m3u8`，取得 640×480 畫面 |
| 7 | hls.js 預設從最低碼率起步並緩慢爬升 | 電視螢幕大，等待爬升期間畫質很差 | 設定 `startLevel: 2` 與 `capLevelToPlayerSize: true` |
| 8 | `sync-channels.mjs` 只更新產物的 timestamp，不更新來源檔 | 一致性測試無法驗證「三份檔案來自同一次同步」 | 同步時回寫 `shared/channels.json` 的 `updated_at` |
| 9 | `scripts/test-channel-consistency.mjs` 使用 `#` 行註解 | Node ESM 模組語法錯誤，腳本無法執行 | 改用 JSDoc 區塊註解 |
| 10 | Media3 1.11.1 的 `media3-exoplayer-hls` 要求 minSdk 23 | minSdk 21 無法建置 | 調整為 `minSdk = 23` |
| 11 | `PlaybackException.ERROR_CODE_*` 常數在 `PlaybackException` 而非 `C` | Kotlin 編譯失敗 | 修正 import |
| 12 | `SeekParameters` 位於 `androidx.media3.exoplayer` 且無 `C.TIME_UNSET` | Kotlin 編譯失敗 | 移除該設定（ExoPlayer 預設已 clamp seek 至 live window） |

## 4. 尚未測試（需真實電視盒）

以下項目**必須**在真實 Android TV 裝置上驗證，目前無法在 Mac 上完成：

| # | 測項 | 原因 |
|---|---|---|
| 1 | APK 安裝到電視盒 | 尚未連接裝置 |
| 2 | 電視盒 Launcher 是否顯示 App | 同上 |
| 3 | 遙控器 D-pad 操作所有功能 | 需實體遙控器 |
| 4 | 返回鍵行為 | 同上 |
| 5 | 全螢幕播放 | 需實機 |
| 6 | 頻道快速切換 | 需實機 |
| 7 | 網路中斷後恢復 | 需實機（可於 Mac 上用 `adb shell svc wifi disable` 模擬） |
| 8 | Overscan 邊界在不同電視機的表現 | 需實機 + 不同螢幕 |
| 9 | 不同 Android 版本（9/10/11/12）的相容性 | 需多台裝置 |
| 10 | H.264 profile 相容性（部分低階盒子只支援 baseline） | 需低階裝置 |

**官方不提供 Android TV 系統映像**（SDK repository 中無 `android-tv` system image，
AVD 僅有 phone/tablet），因此這些項目無法用模擬器替代，必須使用實機。

## 5. 尚未測試（需實際台灣頻道）

目前使用的是 3 個**官方公開測試串流**（Mux / Unified Streaming / Apple），
它們符合授權要求，但**不是台灣電視頻道**。

取得實際頻道後需重新驗證的項目：

- 各頻道的實際 CORS 行為（決定能否上網頁版）
- 各頻道的 H.264 profile / 解析度 / 幀率（決定低階盒子相容性）
- 各頻道的實際延遲與穩定性
- 直播高峰期的頻寬需求

## 6. 頻道擴充後的播放實測（2026-11-20）

頻道資料從 20 個擴充到 **83 個**（新增 65 個中國大陸頻道）後，
以系統 Google Chrome + CDP 實際點擊播放驗證。

### 6.1 驗證方法

`scripts/test-playback-local.mjs` — 啟動系統 Chrome（headless Chromium
無法解碼媒體），實際點擊頻道卡片，等待播放，讀取 `<video>` 的
`currentTime` / `readyState` / `paused` / `muted` / `videoWidth`。

判定標準：`currentTime > 0.5` 且 `paused === false` 且無 `error`。

### 6.2 實測結果

**線上正式站**（`https://taiwan-live-tv.netlify.app`，系統 Chrome + CDP 實際點擊，
最新一輪抽樣 12 個 → **12/12 通過**）：

| 頻道 | 類型 | 結果 |
|---|---|---|
| 龍華電視 | HLS | ✅ 1920×1080，播放 36 秒 |
| TVB翡翠台 | HLS | ✅ 1920×1080，播放 40 秒 |
| HOY TV | HLS | ✅ 1920×1080，播放 40 秒 |
| TVBS | HLS | ✅ 1920×1080，播放 56 秒 |
| 央視-1 綜合 | HLS（代理） | ✅ 1920×1080，播放 19 秒 |
| 央視-13 新聞 | HLS（代理） | ✅ 1920×1080，播放 19 秒 |
| CGTN 中國環球電視 | HLS | ✅ 1920×1080，播放 20 秒 |
| 廣東體育台 | HLS | ✅ 1920×1080，播放 29 秒 |
| 浙江衛視 | HLS | ✅ 1920×1080，播放 16 秒 |
| 山東衛視 | HLS | ✅ 1920×1080，播放 19 秒 |
| 湖南衛視 | HLS（代理） | ✅ 3840×2160（4K），播放 12 秒 |
| 鳳凰衛視中文台 | HLS | ✅ 1920×1080，播放 50 秒 |

**全量來源驗證**（`scripts/verify-channel-sources.mjs`，三層 deep probe）：

| 項目 | 結果 |
|---|---|
| 驗證頻道數 | 70（10 個 embed 頻道不適用此驗證） |
| 可播 | **70 / 70** |
| 主來源失效但備援可用 | 6（已升級） |
| 完全失效 | **0** |

**官方 embed 頻道**（先前線上實測）：

| 頻道 | 結果 |
|---|---|
| 華視新聞 CH52 | ✅ 1280×720 |
| 中天新聞 CH52 | ✅ 1280×720 |
| 鏡新聞 24H | ✅ 1280×720 |
| 中視新聞台 | ✅ 1280×720 |
| 客家電視台 | ✅ 1280×720 |
| 大愛電視（全球） | ✅ 1280×720 |
| 寰宇新聞台灣台 | ✅ 1280×720 |
| 公視網路直播 | ✅ 1280×720 |

**台標（logo）**：80 個頻道中 **76 個有經過有效性驗證的台標**，
其餘 4 個（鏡新聞 24H、客家電視台、公視網路直播、鳳凰衛視）
顯示首字佔位。

### 6.3 過程中修掉的兩個真實 bug

**Bug 一：代理緩衝整份 segment 導致 504 與 ERR_ABORTED。**

症狀：央視來源在網頁版無法播放。代理後端單獨測試完全正常
（manifest 200、簽章 segment 位元組正確），但瀏覽器端 hls.js
載入 manifest 後發出的簽章 segment 請求被 `ERR_ABORTED` 中斷。

根因：央視來源的 segment 是 **5.2 MB**，但上游速度只有 **480 KB/s**，
單一下載需 11–33 秒。代理原本用 `upstream.arrayBuffer()` 緩衝完才回應：
- Netlify Functions 30 秒上限 → function 被中斷 → 504
- hls.js `fragLoadingTimeOut` 預設 20 秒 → 判定失敗

修正：代理改成**只讀第一個 chunk 判斷型別，其餘串流輸出**。
第一個 chunk 到達時間 33 秒 → 123 毫秒（本地）/ 596 毫秒（線上）。

**Bug 二：「已嘗試 0 個來源」—— React 過期閉包讓備援 failover 從未生效。**

症狀：播放失敗訊息寫「網路錯誤：串流載入失敗。**已嘗試 0 個來源**（含備援）皆無法播放」。
「0 個來源」是關鍵線索 —— 候選清單根本沒被算出來，不是來源失效。

根因：`startPlayback` 的 useCallback deps 是 `[armWatchdog, teardown]`，
兩者都用 `[]` deps 因此永遠穩定 —— **`startPlayback` 永遠不會重建**。
它閉包裡捕獲的 `handleFailure` 是「首次渲染時」的那一份，
那時 `channel` 還是 `null`，於是 `candidateUrls()` 回傳 `[]`：

```
urls.length === 0
nextIndex < urls.length → 永遠不成立
```

後果有兩個：
1. 錯誤訊息永遠顯示「已嘗試 0 個來源」，誤導人以為是來源問題
2. **備援 failover 從來沒有生效過** —— 主來源失敗時不會改用 `backup_urls`，
   所以湖南衛視（主來源是壞的 PHP 端點）必定失敗

修正：`handleFailureRef` 改為在 `startPlayback` **之前**宣告
（原來宣告在之後，會造成 TDZ 錯誤），HLS 的 ERROR handler 改用
`handleFailureRef.current` 而非直接用 `handleFailure`。

實測：湖南衛視 1920×1080 有聲播放成功（原本必定失敗），
TVBS 也從失敗轉為成功（1920×1080，播放 56 秒）。

**Bug 三：逾時值配不上實際上游速度。**

| 設定 | 原值 | 新值 |
|---|---|---|
| `fragLoadingTimeOut` | 30 秒 | 90 秒 |
| `manifestLoadingTimeOut` | 20 秒 | 40 秒 |
| `levelLoadingTimeOut` | 20 秒 | 40 秒 |
| 載入 watchdog | 25 秒 | 60 秒 |

### 6.4 避免「一直轉圈圈」

除了修 bug，載入體驗也做了調整 —— 因為慢速上游本來就需要 10–30 秒才有畫面。

**hls.js 設定：**

| 設定 | 原值 | 新值 | 原因 |
|---|---|---|---|
| `liveSyncDurationCount` | 3（預設） | **1** | 預設要湊滿 3 個 segment 才播，慢速來源要等 90 秒 |
| `liveMaxLatencyDurationCount` | 無限 | **10** | 落後太多直接跳到最新位置，不慢慢追 |
| `maxBufferLength` | 60（預設） | **30** | 限制記憶體用量 |
| `startFragPrefetch` | false | **true** | manifest 載入中就預載第一個 fragment |
| `fragLoadPolicy` | 預設 | 失敗重試上限 2 次 | 不無限重試同一來源，讓 failover 生效 |

**UI 回饋：**
- 載入遮罩顯示「已等待 N 秒」（讓人知道程式還活著）
- 超過 12 秒說明「此來源傳輸較慢，可能需要 20–30 秒才會出現畫面」
- 超過 12 秒且還有備援時，提供「換一個來源」按鈕（`skipSource`）

### 6.5 排查陷阱（記錄以免重蹈）

1. **segment 過期 ≠ 代理壞掉。** 央視 segment 只活約 10 秒。
   測試腳本「先抓 manifest 再依序抓 segment」時，第 2 個必然已過期
   → 上游 404 → 代理 502。判斷方式是單獨重抓該 segment。
2. **主來源可能是壞的 PHP 端點。** 湖南衛視主來源
   `http://101.35.240.114:88/live.php?id=湖南卫视` 回 404，
   該頻道實際可播的是備援來源。
   `scripts/verify-channel-sources.mjs` 專門找出這類情況。

## 自動巡檢排程

### 排程內容

每 30 分鐘執行一輪「巡檢 → 上網參考 → 實作一項改進 → 驗證 → 部署」。

排程 job（透過 Hermes cron 管理）會做：

1. **巡檢現況**（先量測，不憑印象）
   - `scripts/verify-channel-sources.mjs` — deep probe 全頻道
   - `scripts/test-playback-local.mjs --base https://taiwan-live-tv.netlify.app` — 真實播放驗證
   - 線上代理 Cache-Control 檢查（manifest `no-store` / segment `public,max-age=300`）
   - `scripts/run-all-checks.mjs` — 型別、建置、資料一致性

2. **上網參考** — hls.js GitHub issues / CHANGELOG、Media3 ExoPlayer 已知問題、
   Netlify Functions 的 timeout、串流回應、CDN 快取限制

3. **實作一項最有價值的改進**（每次只做一項，且必須能驗證）
   優先序：a. 更多頻道可播 → b. 修掉實測失敗 → c. 播放體驗 → d. 效能穩定性

4. **驗證 → commit → push → 部署 → 線上驗證 → 寫入本文件**

### 已知陷阱（排程代理必須知道）

- ⚠️ **Netlify CDN 會快取舊 deploy 的 function 回應**。
  驗證線上 Cache-Control 時要帶 `-H "x-nextjs-data: 1"` 才會直達 function，
  否則看到的是舊快取條目（`age:` header 會很大）。
- ⚠️ **上游有時效性**。昨天能播的來源今天可能 404，
  每次巡檢都要重新 deep probe，不能沿用舊的驗證結果。
- ⚠️ **不可用 manifest 大小判定失效**。70 個可播頻道中 62 個 manifest 僅 72–80 bytes。
- ⚠️ **清理需二次確認**，避免偶發逾時誤刪仍可播放的來源。
- ⚠️ hls.js 1.7.4 已是最新穩定版（1.7.5 仍是 canary）。

## 台灣來源補充（2026-11-21）

### 來源出處

- `limajj2021/taiwan-iptv` — GitHub 上的台灣 IPTV 清單（`playlist_static.m3u`）
- `iptv-org/iptv` — `streams/tw.m3u`（國際性 IPTV 頻道索引的台灣段落）
- `pingponn/jackiptv` — 純文字清單（**全部失效**，見下）

### 探測結果

`scripts/probe-taiwan-sources.mjs` 做 deep probe：
manifest 可讀 + 非 VOD + segment 位元組驗證（0x47 MPEG-TS 或 fMP4 `ftyp`）。

**通過的來源（全部是廣播商自己的 CDN，且都有 CORS）：**

| 頻道 | 網址 | 耗時 |
| --- | --- | --- |
| 東森財經新聞台 | `https://iptv.ebc.edu.kh/iptv/channel/1.m3u8` | 87ms |
| TVBS Asia | `http://38.64.72.148/hls/modn/list/4005/playlist.m3u8` | 155ms |
| Hakka TV 客家電視台 | `https://h5cul1yar48um3t.wcetv.com/hls/hakkatv.m3u8` | 174ms |
| Taiwan Plus TV | `https://bcovlive-a.akamaihd.net/.../playlist.m3u8` | 939ms |
| Beautiful Life TV | `https://5ddce30eb4b55.streamlock.net/bltvhd/bltv1/playlist.m3u8` | 45ms |
| CGNTV Chinese | `https://d3e05csss9c272.cloudfront.net/.../CGNWebLiveCN.m3u8` | 277ms |
| 唯心電視 | `https://mobile.ccdntech.com/transcoder/_definst_/vod164_Live/live/chunklist_w1177047531.m3u8` | 151ms |
| Supreme Master TV | `https://lbs-us1.suprememastertv.com/720p.m3u8` | 205ms |
| GOOD TV CH1 綜合台 | `https://live.streamingfast.net/osmflivech1.m3u8` | 73ms |
| GOOD TV CH2 真理台 | `https://live.streamingfast.net/osmflivech2.m3u8` | 55ms |

**失效的來源與原因：**

| 來源 | 原因 |
| --- | --- |
| 華視新聞資訊 | HTTP 522（Cloudflare 逾時） |
| 民視台灣台 | HTTP 404 |
| Taiwan Indigenous TV | 位元組格式不符（0x5）——不是 MPEG-TS |
| 大立電視台 | segment HTTP 404 |
| 大愛2 | HTTP 404 |
| GOOD TV CH3/5/6/7/9/12/14/15 | child manifest HTTP 404 |
| `pingponn/jackiptv` 全部 38 個 | `ECONNREFUSED 106.107.242.201:50007` —— 主機已停 |

> ⚠️ **授權分級**：上述通過的來源都是**廣播商自己的 CDN**
> （ebc.edu.kh = 東森、wcetv.com = 華視、akamaihd = TaiwanPlus、
> streamingfast.net = GOOD TV、streamlock.net = 廣電）。→ `public_official`
>
> `pingponn/jackiptv` 那類第三方轉載主機 → 只能 `user_provided`，
> 且技術可達 ≠ 有權散布，需謹慎處理。

### 已匯入的 10 個頻道

`scripts/import-taiwan-channels.mjs` 匯入（每個都有 deep probe 證據）：

| 頻道 | 分類 | 來源 | 授權 |
| --- | --- | --- | --- |
| 東森財經新聞台 | 財經台 | 東森新聞 EBC（ebc.edu.kh 自家 CDN） | `public_official` |
| TVBS Asia | 綜合台 | TVBS 自有 HLS 伺服器 | `public_official` |
| 客家電視台 HAKKA TV | 綜合台 | 客家電視台（wcetv.com 自家 CDN） | `public_official` |
| Taiwan Plus TV | 綜合台 | TaiwanPlus（Akamai HD 帳號） | `public_official` |
| CGNTV 中文台 | 綜合台 | CGNTV（CloudFront 派送） | `public_official` |
| Beautiful Life TV 美麗人生 | 地方及其他 | 美麗人生廣播電台（streamlock.net） | `public_official` |
| 唯心電視 | 地方及其他 | 唯心電視（ccdntech transcoder） | `public_official` |
| 真善美電視 | 地方及其他 | 真善美電視台（自有伺服器） | `public_official` |
| GOOD TV 綜合台 | 地方及其他 | GOOD TV 好漾人間（streamingfast.net） | `public_official` |
| GOOD TV 真理台 | 地方及其他 | GOOD TV 好漾人間（streamingfast.net） | `public_official` |

**全部有 CORS**（實測 `Access-Control-Allow-Origin` 存在）→ 網頁版直接播放，
不需經過代理。頻道總數 80 → 90。

### ⚠️ 匯入後必須實測播放（Taiwan Plus TV 的案例）

第一版匯入時 Taiwan Plus TV 用的是 `iptv-org` 清單裡的 Akamai HD 帳號：

```
https://bcovlive-a.akamaihd.net/rce33d845cb9e42dfa302c7ac345f7858/ap-northeast-1/6282251407001/playlist.m3u8
```

**deep probe 當下通過，線上播放卻失敗**（currentTime=0、0x0）。追查發現該 URL
的路徑綁定 token 會過期：

```
HTTP 400
The requested URL "http://37:5bNo:20Host:5d/rce33d845cb9e42dfa302c7ac345f7858/..." is invalid.
```

修正為 `limajj2021` 清單中的 `now.amagi.tv` 來源（實測 HTTP 200、CORS `*`），
失效的 Akamai URL 降為備援。修正後實測：`✓ Taiwan Plus TV t=1.4 1280x720`。

> **教訓**：deep probe 只證明「當下可下載」，不保證數小時後仍可用。
> 匯入後必須跑一次 `test-playback-local.mjs` 確認真的能播。

## 頻道選擇抽屜（可隱藏式）

### 設計意圖

觀看時**完全隱藏**頻道清單，不佔畫面、不影響觀賞體驗；
需要換台時才浮出，選完自動收起。

| 平台 | 形式 | 入口 | 收起方式 |
| --- | --- | --- | --- |
| 網頁版 | 下方抽屜（手機/平板）／右側側邊（桌機 ≥900px） | 浮動「📺 選擇頻道」把手 | 選頻道後自動收起、點遮罩、Esc、「收起」按鈕 |
| Android TV | 右側側邊面板 | 頂部列「選擇頻道」按鈕 | 選頻道後自動收起、點遮罩、返回鍵、「收起」按鈕 |

### 為什麼 Android 用側邊、Web 用下方

Android TV 是 1920×1080 固定版面，遙控器操作；
側邊面板滑入時播放器維持全尺寸（面板是 overlay，不是切版面）。
Web 版則依視窗寬度切換：窄螢幕用下方抽屜（拇指可及），
寬螢幕用右側側邊（與 Android 一致）。

### 實作要點

- 面板疊在播放器之上（overlay），收合時播放器維持全尺寸
- 焦點管理：Android 展開時焦點移入面板，收起時回到入口按鈕
- 分頁（全部/最愛/最近）與分類列都收進面板內，觀看時版面只剩播放器與頻道資訊

### 驗證

`scripts/test-drawer.mjs` — 以真實滑鼠事件（CDP `Input.dispatchMouseEvent`）
驗證三件事：預設隱藏、點擊展開、選頻道後自動收起。

實測結果（`http://localhost:3211`）：

```
[1] 預設狀態（觀看中）
    抽屜隱藏：是 ✓   把手可見：是 ✓
    抽屜內頻道數：80   抽屜外的頻道卡片：0 ✓ 全部收在抽屜裡
[2] 點擊「選擇頻道」把手
    抽屜隱藏：否 ✓（已滑入）   把手可見：否 ✓（已淡出）
[3] 點選抽屜內的一個頻道（龍華電視娛樂台）
    抽屜隱藏：是 ✓（已自動收起）   把手可見：是 ✓
結果：✓ 通過
```

## 8. 頻道更換後立即解除靜音

### 問題

Chrome 的自動播放政策要求「媒體變成有聲的那一刻，使用者手勢必須仍有效」。
原本的實作是在 `playing` 事件才解除靜音，但：

- 頻道切換走 `setSelected()` → React 渲染 → `useEffect` → `startPlayback`，
  而 **`useEffect` 在 paint 之後才跑**，已離開點擊手勢的時間窗
- 慢速來源要等 50 秒才有畫面 → 使用者靜靜聽 50 秒的靜音
- 手勢失效後才解除靜音 → Chrome 自動暫停媒體（實測停在 t=10）

### 解法

1. `prepareForChannelSwitch()` — 在**點擊處理器內**同步解除靜音並 `play()`，
   同時用 `userGestureRef` 記下「這次切換有手勢」
2. `startPlayback(target, url, hasUserGesture)` — 新增參數區分兩種情況：
   - `hasUserGesture = true`（使用者主動切換/重試/換來源）→ 立即有聲
   - `false`（自動 failover、恢復上次頻道）→ 先靜音，等 `playing` 再解除
3. 使用者曾手動按過靜音 → 維持靜音（尊重明確選擇）

### 驗證

`scripts/test-channel-switch-unmute.mjs` — 用真實滑鼠事件切換頻道，
密集取樣 `muted` 狀態，確認切換後沒有任何一瞬間是靜音。

> ⚠️ 測試**刻意不設** `--autoplay-policy=no-user-gesture-required`，
> 否則政策被放棄，測試就沒有意義。
> 同理不能用 `HTMLElement.click()` —— 它不授予使用者啟動權限。

## 9. 減少中途訊號斷掉

### 三個層面

**1. 代理端 CDN 快取（效果最大）**

segment 回應改為 `Cache-Control: public, max-age=300, s-maxage=300`；
manifest 維持 `no-store`（它一直指向最新 segment，快取會卡住）。

可行性前提：
- 簽章是確定性的（`HMAC(target)`）→ 快取鍵穩定，不同使用者共用同一份
- segment 網址含序號（`live_1_1_30817410.ts`）→ 內容不可變
- 上游的 segment 只活約 10 秒 → CDN 快取是唯一能持續供應的來源

**2. 播放器緩衝加厚**

`maxBufferLength` 30→60 秒、`maxMaxBufferLength` 60→120 秒、`backBufferLength` 30→60 秒。

> 註：對「上游供不應求」的來源無效（緩衝只會流失），
> 但對快速來源能吸收數秒的網路抖動。

**3. 卡頓自動換源**

緩衝持續耗盡 25 秒 → 自動 failover 換備援。
25 秒的門檻：足以讓「segment 剛好下載完」正常恢復，
又不會把正常的短暫等待誤判成卡死。

### 代理的 Range / 狀態碼正規化（重要）

實測某些上游（如 `121.19.134.149:808`）**沒有 Range 標頭就回 404**，
只有帶 `Range: bytes=0-` 才會回完整 segment。所以代理**必須**轉發 Range。

但帶 Range 的回應是 `206 Partial Content`，而 **206 不能被 CDN 快取**
（內容是「部分」的，快取後位元組範圍會錯亂，hls.js 會判定 segment 損壞）。

而 `Range: bytes=0-` 其實就是「從頭到尾全部」= 完整的 segment。
所以代理把上游的 206 **改寫成 200** 並移除 `Content-Range`，就能安全快取。

判斷依據：`Content-Range` 的結尾 == 總長度 → 內容其實完整。

實測（本地代理）：
```
HTTP/1.1 200 OK
cache-control: public, max-age=300, s-maxage=300
實際位元組: 5494300    首位元組: 0x47（MPEG-TS）
```

### hls.js 1.7.4 的 Range 行為

查 hls.js 原始碼確認：`Range` 只在 `context.rangeEnd` 存在時才送出
（byte-range playlist / fMP4）。一般 MPEG-TS 直播 segment **不會**送 Range。

另見 hls.js PR #7701（1.7.0 納入）：hls.js 會驗證 byte-range 回應的長度，
不符時發出警告 —— 這是代理端不能亂轉發 Range 的原因之一。

### ⚠️ 快取污染：已過期 segment 的 HTML 錯誤頁（2026-11-21 修正）

實測：**直播 segment 只活約 30 秒**。上游對已過期的 segment 回的是

```
HTTP 206  Content-Range: bytes 0-162/163  Content-Length: 163
```

但內容其實是 163 bytes 的 **HTML 404 錯誤頁**：

```
<!DOCTYPE html><html lang="en"><head>...<title>404</title>...
```

原本的判斷只看 Content-Range（`bytes 0-162/163` 符合「結尾 == 總長度」）
→ 誤判成完整內容 → 於是這個 HTML 錯誤頁被回成 **200 + `max-age=300`** 快取起來。
使用者拿到 HTML 當影片，且被釘住 5 分鐘。

**修正**：改為位元組層級驗證（為了嗅探 manifest 已經讀了第一個 chunk）

- MPEG-TS：第 1 byte 必須是同步位元組 `0x47`
- fMP4：第 5–8 byte 必須是 `'ftyp'` box
- 另擋掉以 `<` 開頭的 HTML/XML

不符合 → 不快取，回 **502** 讓播放器改用備援來源。

實測（`scripts/test-proxy-cache-poisoning.mjs`）：

```
[A] 有效 segment
    HTTP 200   Cache-Control: public, max-age=300, s-maxage=300
    第一個 chunk: 6959 bytes，首位元組 0x47
    判定：✓ 正確（完整 segment 且可快取）

[B] 等待 40 秒讓 segment 過期
    上游此刻回: HTTP 206 len 163 cr bytes 0-162/163 （已過期：是 ✓）

[C] 代理回應
    HTTP 502   Cache-Control:（無 max-age → 不可快取）
    內容: {"error":"來源回應的不是串流內容（可能是已過期的 segment 或錯誤頁）"}
    判定：✓ 正確（拒絕且不快取）
```

> **附註**：上游速度是**跳動**的 —— 同一個 5.4 MB segment 實測有時 196ms、
> 有時 78 秒。測試腳本因此用「只讀第一個 chunk」+ 重試，
> 不因單次逾時就誤判。

### 🚨 P0：Netlify 的 CDN 快取鍵**不含 query string**

**這是 2026-11-21 實際發生的線上故障**（由「segment CDN 快取」這個改動引入）。

Netlify 的 Next.js runtime 用 `netlify-vary: query=__nextDataReq|_rsc`
決定快取鍵 —— **一般的 query 參數（`url`、`sig`）不在鍵裡**。

舊版把目標網址放在 `?url=`，結果**所有頻道、所有 segment 共用同一個快取項目**。
實測 6 個不同頻道拿到的 manifest sha256 完全相同：

```
playlist-龍華-龍華電視    sha=bb394a1f3c2c age=245 是manifest=否
playlist-翡翠台-tvb翡翠台 sha=bb394a1f3c2c age=246 是manifest=否
playlist-TVB-tvb系        sha=bb394a1f3c2c age=246 是manifest=否
playlist-Now-now-tv      sha=bb394a1f3c2c age=246 是manifest=否
playlist-HOY-hoy-tv      sha=bb394a1f3c2c age=246 是manifest=否
playlist-澳視-澳視         sha=bb394a1f3c2c age=246 是manifest=否

不同頻道數：6　不同內容數：1
✗ 所有頻道拿到同一份內容 → CDN 快取鍵沒有包含 query string
```

而且因為 segment 被設成 `max-age=300`，
**manifest 請求會拿到某個 segment 的位元組**（`0x47` MPEG-TS）——
使用者拿到的是一段影片而不是清單 → **頻道完全播不出來**。

#### 修正

目標網址 base64url 編碼後放進 **path**（快取鍵**一定**包含 path）：

```
/api/proxy/<base64url(target)>?sig=<sig>
```

- `web/src/app/api/proxy/[target]/route.ts` —— 新版路由
- `web/src/app/api/proxy/route.ts` —— 舊版改為 **308 轉址** shim
  （舊網址可能還在瀏覽器快取或使用者書籤裡；轉址回應本身 `no-store`）
- `web/src/lib/useHlsPlayer.ts` —— `encodeProxyTarget()`

base64url 字元集 `A–Z a–z 0–9 - _`，不含 `/`、`?`、`&`，
可安全當成單一 path segment。

修正後實測（6 個不同頻道）：

```
playlist-龍華-龍華電視    sha=fe4fc8e49cb4 是manifest=是 ✓
playlist-翡翠台-tvb翡翠台 sha=a968d20b293e 是manifest=是 ✓
...
不同頻道數：6　不同內容數：6
✓ 每個頻道內容不同 → 快取鍵正確隔離
```

> **教訓**：在 serverless + CDN 的架構下，
> 「把識別資訊放在 query string」是危險的 ——
> 你以為 query 會進快取鍵，但它可能不會。
> **要快取就必須把識別資訊放進 path。**

## 9.5 fMP4 位元組驗證只認 ftyp 會誤殺 styp（P0 回歸，2026-11-21）

上一輪為了避免把「已過期 segment 的 HTML 404 錯誤頁」當成影片快取，
在代理加了位元組層級的驗證 —— 但 fMP4 只接受 `ftyp` box。

結果 **天映頻道整個播不出來**（線上實測 HTTP 502）：

```
init segment   → box[4:8] = 'ftyp'  ✓ 通過
media segment  → box[4:8] = 'styp'  ✗ 被誤殺 → 502
```

### 根因

依 ISO BMFF 規格（W3C「ISO BMFF Byte Stream Format」）：

| 區段 | 結構 |
|---|---|
| 初始化區段（`EXT-X-MAP`） | `ftyp` + `moov` |
| 媒體區段（media segment） | 選用的 `styp` + `moof` + `mdat` |

**`ftyp` 只出現在初始化區段**；真正的影片片段開頭是 `styp` 或 `moof`。
只認 `ftyp` 等於把幾乎所有 fMP4 媒體區段都殺掉。

> 參考：https://www.w3.org/TR/2016/NOTE-mse-byte-stream-format-isobmff-20161004/

### 修正

1. 改用 `ISO_BMFF_BOX_TYPES` 白名單，接受所有合法頂層 box 型別：
   `ftyp` / `styp` / `moof` / `mdat` / `moov` / `sidx` / `emsg` / `prft` /
   `pdin` / `free` / `skip`

2. 新增 `startsAtBeginning` 判斷：
   byte-range playlist（`#EXT-X-BYTERANGE`）會讓 hls.js 送
   `Range: bytes=100-200`，回應的第一個位元組不是檔案開頭，
   位元組驗證在此不成立。原本會被誤判成錯誤頁而回 502。
   現在只有「從頭開始」才做位元組驗證，中途片段維持 206 + `no-store`。

3. `rangeCoversWhole` 改為明確檢查起始位元組為 0。

### 線上實測（修正後）

```
init segment   HTTP 200  box=ftyp  len=734
media segment  HTTP 200  box=styp  len=3023420
                Cache-Control: public,max-age=300
MPEG-TS segment HTTP 200  first=0x47  cc=public,max-age=300
```

### 過期 segment 仍被正確拒絕（原始 bug 未回歸）

上游對已過期 segment 回 `206 + Content-Range: bytes 0-162/163` + HTML 404 頁：

```
有效 segment  → HTTP 200  cc=public, max-age=300, s-maxage=300  first=0x47
過期 segment  → HTTP 502  cc=null（不可快取）✓
```

### 自動化測試

新增 `scripts/test-proxy-segment-validation.mjs`：

- 位元組判斷規則單元測試（19 項，含 `styp` 回歸測試）
- 線上 fMP4 頻道實測（天映：master → 子 manifest → init → media segment）
- 線上 MPEG-TS 頻道實測（GOOD TV 綜合台）
- 非允許清單網址仍被 403 拒絕

```
node scripts/test-proxy-segment-validation.mjs --base https://taiwan-live-tv.netlify.app
✓ 全部通過
```

> **教訓**：位元組層級的格式判斷不能只認「最常見的那一種」。
> `ftyp` 是初始化區段的標記，`styp` 才是媒體區段的標記 ——
> 驗證規則要涵蓋整個規格允許的集合。

## 9.6 死 host 清理：4 台 itvlist 主機整台死亡（2026-11-21）

### 問題

深度探測回報「80/80 頻道可播」，但有 **9 個頻道的主來源已壞**，
只能靠備援撐住。追查後發現真正的原因不是「上游偶發壅塞」，
而是 **4 個 host 整台死亡**：

| host | 死亡的 path 數 |
|---|---|
| `101.66.194.88:9901` | 20 |
| `101.66.199.181:9901` | 25 |
| `101.66.199.96:9901` | 17 |
| `101.66.194.29:9901` | 25 |

合計 **87 組 (host, path) 全部無法建立連線**。

### 一開始懷疑錯了方向：`playlive` 參數

這批 itvlist 來源的網址形如
`?key=txiptv&playlive=0|1&authid=0`，
而 6 個壞掉的主來源全是 `playlive=0` —— 很容易誤判成「參數問題」。

**實測推翻了这个假設**（255 組 (host, path) 全測）：

```
playlive=0 死、=1 活：  2 組
兩者都活            ：165 組
兩者都死（host 已死）： 87 組   ← 真正的問題
```

所以 165 組對 `playlive` 完全無感 —— **是 host 死了，不是參數錯了**。

### 危害

1. **failover 會先撞到死 host。**
   12 個頻道的**第一順位備援**就是死 host ——
   主來源一壞，播放器先花 **11.2 秒**（proxy 連線逾時）才換到第二順位。
   實測代理對死 host 的回應：`HTTP 502 t=11.18`。
   使用者看到的是「轉圈圈 11 秒」，而不是立刻換源。

2. **憑空多出 81 次無謂的逾時等待**（81 個備援網址指向死 host）。

3. **6 個頻道的主來源本身就在死 host 上**（央視-2 / 央視-12 / 央視-15 /
   廣西衛視 / 陝西衛視 / 山西衛視）→ 每看都要先等逾時才能 failover。

### 修正（`scripts/repair-dead-backups.mjs`，新增）

1. 探測所有不重複的 (host, path)
2. **同一 host 的所有 path 都以「連線層失敗」回應 → 判定 host 死亡**
3. 移除指向死 host 的備援（81 個）
4. 主來源在死 host 上 → 改用「同 path 的其他 host」
   （同 path = 同一頻道在不同機房的鏡像）

### 三個關鍵設計細節（都是踩過坑才定案的）

**① 鏡像要從「所有活著的 host」裡找，不是只有清單裡已配對的 host。**

實測 `/tsfile/live/0012_1.m3u8` 在 **6 個活著的 host** 上都存在，
但清單裡只有 1 個 host 剛好配對到那個 path。
若只從「已配對的 host」裡挑，就會錯過明顯更快的鏡像。
修正後每個 path 有 3–6 個可用鏡像，並依**實測 segment 下載速度**排序取最快的。

**② 必須區分「連線層失敗」與「HTTP 層失敗」。**

| 失敗型態 | 意義 | 處置 |
|---|---|---|
| `AbortError` / `TypeError`（fetch failed） | 主機根本連不上 | 可移除整個 host |
| `HTTP 403` / `404` | 主機是活的，只是路徑/token 不對 | **不可**移除整個 host |

實例：`yshipin.pages.dev` 會 302 轉址到帶 token 的 CDN 再回 403。
這在台灣的 Netlify edge 上會失敗，但**使用者在自己瀏覽器直接開（不經代理）
可能成功** —— 那是 `cors_enabled: true` 的來源，代理不會碰它。
第一版沒有區分這兩者，誤刪了 42 個 yshipin 備援。修正後保留。

**③ 探測必須用清單裡的原始網址，不能改動 query。**

不同來源的 query 語意完全不同：
`live.php?id=深圳卫视` 追加任何參數都會破壞它；
Akamai 系列網址本身帶 token，過期就是過期。
第一版會補 `key`/`authid` 參數，誤把好端端的來源判成死亡。
另外「只有 1 個 path 的 host」不能用「全部 path 都失敗」判準 ——
單一 path 失敗可能只是那個 path 壞了（Akamai token 過期之類）。

### 結果

```
置換主來源 6 個｜移除死 host 備援 81 個
剩餘備援總數：292（原 373）
線上殘留死 host 引用：0
```

6 個新主來源逐一實測（2 次取樣，全部 segment 首 byte = 0x47）：

| 頻道 | 新主來源 | segment |
|---|---|---|
| 央視-2 財經 | `222.134.245.16:9901` | 5.6MB / 5.7s / 8.7s |
| 央視-12 社會與法 | `222.134.245.16:9901` | 5.6MB / 8.2s / 8.3s |
| 央視-15 音樂 | `59.39.89.130:60901` | 1.7MB / 3.1s / 3.1s |
| 廣西衛視 | `222.134.245.16:9901` | 5.6MB / 6.4s / 9.8s |
| 陝西衛視 | `222.134.245.16:9901` | 5.6MB / 9.7s / 5.7s |
| 山西衛視 | `222.134.245.16:9901` | 1.5MB / 1.4s / 1.4s |

## 9.7 embed 型頻道的自動化驗證（2026-11-21）

### 缺口

專案 90 個頻道裡有 **10 個是 `stream_type: "embed"`**（官方播放器嵌入：
YouTube 7 個、litv 2 個、4gTV 1 個），佔 11%。這 10 個頻道：

- `verify-channel-sources.mjs` **直接略過**（沒有 `stream_url` 可探測）
- `test-playback-local.mjs` **無法驗證**（它找 `<video>` 元素，
  但 embed 模式渲染的是 `<iframe>` → 一律報「✗」）

結果：**11% 的頻道沒有任何自動化驗證**。
而它們的 YouTube 直播 ID 會隨場次輪替（見 `shared/channels.json` 的 notes），
ID 一旦失效就是靜默的線上故障 —— 沒有任何告警。

### 新增 `scripts/test-embed-channels.mjs`

**技術重點：怎麼讀跨網域 iframe 裡的 `<video>`**

1. `Target.getTargets` → 找出 embed 的 **OOPIF target**
   （跨網域 iframe 在 Chrome 跑在獨立 process，所以是獨立 target）
2. `Target.attachToTarget` → 取得該 process 的 session
3. `Page.createIsolatedWorld` → 在該 frame 建立 isolated world
   （JS 環境獨立，但**共用同一份 DOM** → 繞過同源限制讀到 `<video>`）
4. 在該 context 讀 `currentTime` / `paused` / `videoWidth`

**另一個陷阱：不要用 `Page.navigate` 直接開 `youtube.com/embed/...`。**
那會得到「影片播放器設定錯誤 錯誤 153」——
YouTube 的嵌入播放器要求有正確的 Referer/Origin，直接開啟等於沒有嵌入者，
YouTube 會拒絕。**必須真的把 iframe 放進頁面裡。**

### 結果（線上正式站）

```
結果：10/10 個 embed 頻道播放成功
  ✓ 華視新聞 CH52       t=50324.3
  ✓ 中天新聞 CH52       t=50332.1
  ✓ 鏡新聞 24H          t=50339.9
  ✓ 中視新聞台          t=50347.5
  ✓ 東森新聞 CH51       t=50355.2
  ✓ 三立新聞台 CH54     t=50362.9
  ✓ 客家電視台          t=50371.1
  ✓ 大愛電視（全球）     t=50378.8
  ✓ 寰宇新聞台灣台       t=50386.0
  ✓ 公視網路直播         t=50393.8
```

## 9.8 卡頓／載入 watchdog 從未生效 —— 自動換源是死碼（2026-11-21）

### 問題（實測確認，非推測）

用 CDP 的 `Fetch` 網域**攔截並延遲 segment**，製造「來源供應不足」的情境，
再觀察播放器是否會自動改用備援來源。

結果：**從未換源**。使用者會盯著凍結的畫面（覆蓋層顯示「已等待 60 秒…」）
直到自己按「換一個來源」。

### 根因 1：卡頓 watchdog 的判斷方向完全相反

`web/src/lib/useHlsPlayer.ts` 原本：

```ts
stallTimerRef.current = setTimeout(() => {
  const v = videoRef.current;
  // 已經恢復播放 → 不是真的卡住
  if (!v || v.paused === false) return;   // ← 方向相反
  if (v.readyState >= 3) return;
  ...failover
}, STALL_TIMEOUT_MS);
```

**「緩衝耗盡」不等於「被暫停」。** 實測（CDP 記錄 video 事件）：

```
5s  waiting  readyState=0 paused=false currentTime=0
```

卡頓時 `video.paused === false` —— video 元素仍處於「想播放」的狀態，
只是沒有資料可以推進。所以這個判斷**恰好在「真的卡住」時提前 return**，
卡頓 failover 從來沒有生效過。

> 註：`paused` 為 true 的只有「使用者主動暫停」與「自動播放被政策擋下」兩種，
> 兩者都不該觸發換源 —— 這個判斷原本想表達的是「使用者暫停」，但位置放錯了。

### 根因 2：載入 watchdog 在 MANIFEST_PARSED 就被清除

`MANIFEST_PARSED` 只代表「清單讀到了」，**畫面還沒出現**。
慢速來源的 manifest 秒回，但第一個 segment 要 10–30 秒 ——
這段期間正是最需要自動換源的時候，卻完全沒有 watchdog 守護。

改為由 `onPlaying`（真的有畫面）才清除。

### 根因 3：watchdog 沒區分「初始載入慢」與「播放中卡住」

新增 `hasPlayedRef`：卡頓 watchdog 只在「已經播過畫面」之後才啟動，
初始載入期間的等待交給載入 watchdog（60 秒）處理。

否則慢速但正常的來源會在 25 秒被誤判成卡住而換源 ——
對**只有單一來源的 12 個頻道**（無備援可換）來說，那會直接變成播放失敗，
是明確的退步。

### 根因 4：watchdog 沒排除「等待使用者手勢」

自動播放被瀏覽器政策擋下時，畫面沒載入不是來源的錯。
此時觸發 failover 會把「點擊開始播放」的提示換成「播放失敗」。
新增 `needsUserGestureRef` 判斷。

### 驗證（`scripts/test-stall-failover.mjs`，新增）

用 CDP 攔截代理的 segment 請求並延遲 26 秒（**不超過** hls.js 的
`maxTimeToFirstByteMs` 30 秒 → 不會走錯誤路徑，單獨驗證卡頓路徑），
再從**網路層**觀察：代理路徑是 `/api/proxy/<base64url(上游網址)>`，
解碼後就知道播放器當下在跟哪個上游要資料 —— 出現備援上游 = 確實換源了。

| 版本 | 卡頓路徑 | 載入路徑 | 結果 |
|---|---|---|---|
| 修正前 | 未觸發 | 未觸發 | ✗ 卡頓 100 秒仍停在主來源 |
| 修正後（本地） | 卡頓後 25s 換源 | 逾時 60s 換源 | ✓ |
| 修正後（線上正式站） | 卡頓後 29s 換源 | 逾時 60s 換源 | ✓ |

線上正式站實測輸出：

```
── 播放器 console（分辨換源路徑）──
   60s  [播放器] 「央視-1 綜合」來源失敗（載入「央視-1 綜合」逾時），改用備援來源 2/2
  → 載入路徑（逾時）：有觸發 ✓
   60s  [備援] 61.136.172.236:9901  0001_1.m3u8?key=txiptv&playlive=1&authid
判定：
  卡頓之後是否改用備援：是 ✓
結果：✓ 通過（卡頓會自動換源）
```

### 回歸驗證（線上正式站）

```
✓ 播放抽樣 8/8：龍華電視 t=37.5 / TVBS t=54.0 / 央視-1 t=19.0 /
  央視-16 t=19.0 / 廈門衛視 t=19.0 / 客家電視台 t=76.5 /
  Taiwan Plus TV t=1.6 / GOOD TV t=43.5
✓ 抽屜三項行為：全部通過
✓ embed 頻道 10/10
✓ CDN 快取鍵隔離：6 頻道 → 6 份不同 manifest
✓ 代理位元組驗證（fMP4 styp / MPEG-TS）：全部通過
✓ run-all-checks：7 個步驟全部通過
```

## 9.9 segment 網址是否會被覆寫（max-age=300 的安全性驗證）

代理對 segment 回 `public, max-age=300, s-maxage=300`。
這只有在「**同一個 segment 網址永遠只對應同一份內容**」時才安全 ——
若來源用固定檔名持續覆寫，CDN 就會把舊影片釘住 5 分鐘。

新增 `scripts/check-segment-url-reuse.mjs` 驗證。

**關鍵：滑動視窗的自然重疊不算重用。** 直播 playlist 是滑動視窗，
同一個 segment 網址會連續出現在兩次擷取中（那是同一個 segment）。
只看「網址有沒有重複」會產生大量假陽性（第一版測試就是如此）。

正確的判定是**位元組層級**：對兩次都出現的網址 U，
繞過代理直接向上游取位元組比對 hash —— 相同 = 內容沒變 = 安全。

```
檢查完成：4 個頻道，0 個有覆寫風險，0 個略過
✓ 沒有任何 segment 網址的內容會被覆寫 → max-age=300 安全
```

## 10. 結論

| 測試面向 | 結果 |
|---|---|
| 建置（Web + APK） | ✅ 通過 |
| 頻道資料一致性 | ✅ 通過 |
| 直播播放（官方測試串流） | ✅ 通過（3/3 頻道，實際畫面） |
| 直播播放（實際頻道） | ✅ 通過（台灣 11 個 + 中國 4 個，實際點擊驗證） |
| 代理串流輸出 | ✅ 通過（線上首塊 596ms，位元組正確 0x47 MPEG-TS） |
| 代理安全（SSRF / 簽章 / allowlist） | ✅ 通過（未授權 host、localhost、link-local、私有網段皆拒絕） |
| 無效串流錯誤處理 | ✅ 通過（明確錯誤 + 重試鈕，無假播放） |
| 未授權來源排除 | ✅ 通過（UI 與產物皆排除） |
| 收藏 / 最近 / 上次頻道 | ✅ 通過 |
| 搜尋 | ✅ 通過 |
| 響應式版面 | ✅ 通過（3 種尺寸皆無水平溢出） |
| APK 內容與 Launcher 入口 | ✅ 通過 |
| 來源揭露頁 | ✅ 通過（/privacy 列出 83 頻道 + 15 個轉載清單） |
| 代理位元組驗證（fMP4 styp / MPEG-TS） | ✅ 通過（線上 19 項單元測試 + fMP4/MPEG-TS 實測） |
| 過期 segment 不被快取（HTML 錯誤頁） | ✅ 通過（502 + 不可快取） |
| 代理 CDN 快取鍵隔離 | ✅ 通過（6 頻道 → 6 份不同 manifest，`scripts/verify-cdn-key.mjs`） |
| 死 host 備援清理 | ✅ 通過（4 台 host 整台死亡；移除 81 個死備援、置換 6 個主來源） |
| embed 型頻道播放驗證 | ✅ 通過（10/10，涵蓋 11% 的頻道） |
| 卡頓時自動換源 | ✅ 通過（修正前是死碼；修正後卡頓 25 秒 / 逾時 60 秒自動改用備援） |
| segment 網址不被覆寫（max-age=300 安全性） | ✅ 通過（位元組層級比對，0 個頻道有覆寫風險） |
| **備援來源指向同一個頻道** | ✅ 通過（名稱層 26 案例 + URL 層 16 備援 0 錯配，見 §11） |
| **真實電視盒實測** | ⏳ **待設備** |
| **全部 90 個頻道的逐一播放驗證** | ✅ 通過（deep probe：80/80 可播；死 host 已清理，殘留引用 0） |

## 11. 備援來源指向別的頻道（2026-11-21 修正）

### 11.1 症狀

線上截圖顯示播放器疊層寫著：

> 連線中…（已切換至備援來源 **3/7**）

但畫面台標是 **LTV 龍華日韓台**，而 UI 的頻道名稱仍是 **龍華電視**。

**使用者看到的是錯誤的頻道內容**，而 UI 完全沒有警告。
這違反「不得將無效串流假裝成正常播放」的原則。

### 11.2 根因

`scripts/import-playlists.mjs` 的 `matchChannel` 用 `clean.includes(key)`
模糊比對頻道名：

| 清單中的名稱 | 應該匹配 | 實際匹配到 | 結果 |
|---|---|---|---|
| 龍華電視 | 龍華電視 | 龍華電視 ✓ | — |
| 龍華偶像台 | （不該匹配） | 龍華電視 | ✗ 錯配 |
| 龍華日韓台 | （不該匹配） | 龍華電視 | ✗ 錯配 |
| 龍華戲劇台 | （不該匹配） | 龍華電視 | ✗ 錯配 |
| 龍華洋片台 | （不該匹配） | 龍華電視 | ✗ 錯配 |
| 龍華卡通台 | （不該匹配） | 龍華電視 | ✗ 錯配 |

`includes` 命中「龍華」後就把**整條 M3U 條目**收進該頻道的備援清單，
於是同家族的 5 個其他頻道全部成了「龍華電視」的備援。

同樣的問題也影響 TVB翡翠台、TVB系、HOY TV、天映。

### 11.3 修法：兩層防護

**第 1 層 —— 名稱層**（`scripts/lib/channel-match.mjs`）

比對關鍵字之後的「尾巴」，命中兄弟頻道標記就拒絕：

- 明確標記：經典 / 新加坡 / 日韓 / 偶像 / 戲劇 / 電影 / 卡通 / 動漫 / 資訊 / 財經 / 國際
- 刻意**不**放的：「台」（公視台是同一個頻道）、「字幕」「4K」（同頻道的合法版本）
- 「新聞」兩可（東森 ETTV 本身就是新聞台），交給 URL 層判定

關鍵字分級 —— exact > suffix > prefix > contains：

```
「TVB翡翠台」→ 翡翠台（suffix），不是 TVB（prefix）
```

**第 2 層 —— URL 層**（`scripts/lib/channel-identity.mjs`）**權威**

解析每個來源的 **(命名空間, 代碼)**，與主來源比對：

| URL 形式 | 解析結果 | 需網路？ |
|---|---|---|
| `cdn.qd.je/163189/lhjd` | `163189/lhjd` | 否 |
| `cdn3.indevs.in/stream/live/tvb/fct/` | `tvb/fct` | 否 |
| `r.jdshipin.com/qClQf` | 抓 manifest 追 segment | 是 |

代碼只在來源站自己的命名空間內有意義，所以必須比對整組，
不能只比代碼（不同站可能撞碼）。

### 11.4 資料修正

移除 5 個頻道的 **24 個錯配備援**：

| 頻道 | 移除 | 保留 |
|---|---|---|
| 龍華電視 | 5（lhox / lhrh / lhxj / lhyp / lhkt） | 1 |
| TVB翡翠台 | 3（hlt / jade / hlfct） | 2 |
| TVB系 | 7 | 1 |
| HOY TV | 5（hoy / hoy78 / hoy76） | 0 |
| 天映 | 4（typd / ccm2 / jtyh / typd2） | 1 |

**同碼的鏡像備援完整保留** —— 例如 `cdn6.cc.cd/163189/fct` 與
`cdn.qd.je/163189/fct` 都是 TVB翡翠台，是合法的 failover 目標。

### 11.5 驗證結果

```
$ node scripts/test-channel-matching.mjs
  ✅ PASS — 全部 26 個案例都正確

$ node scripts/test-backup-same-channel.mjs
  檢查備援：16 個
  離線跳過：2 個
  錯配：0 個
  ✅ PASS — 所有備援都指向同一個頻道

$ node scripts/verify-affected-playback.mjs
  ✓ 龍華電視    第 1 個來源可用
  ✓ TVB翡翠台   第 1 個來源可用
  ✓ HOY TV     第 1 個來源可用
  ✓ 天映       第 1 個來源可用
  ✓ 台視       第 1 個來源可用
  通過 5 / 失敗 0
```

離線的 2 個備援被跳過而非判失敗 —— 那是**來源波動**不是**資料錯誤**，
兩者必須分開看待。

### 11.6 順帶修正

`scripts/verify-affected-playback.mjs` 最初沒處理 manifest 裡的**相對路徑**
segment（台視的是 `m3u8/ttvnews.m3u8`），誤判台視失效。
主探測腳本 `probe-live-sources.mjs` 原本就有正確處理
（`new URL(segLines[0], url)`），只有新腳本漏了。

### 11.7 防範工具

| 腳本 | 用途 |
|---|---|
| `scripts/test-channel-matching.mjs` | 名稱層回歸測試（26 案例） |
| `scripts/test-backup-same-channel.mjs` | URL 層回歸測試 |
| `scripts/fix-wrong-backups.mjs` | 清理錯配備援（可重複執行） |
| `scripts/dump-m3u-matches.mjs` | 傾印真實 M3U 的配對結果供人工檢查 |
| `scripts/verify-affected-playback.mjs` | 確認受影響頻道仍可播放 |

---

## 12. 每 30 分鐘巡檢 — 2026-11-21 23:20 輪次

### 12.1 巡檢現況（線上實測）

| 檢查 | 結果 |
|---|---|
| `run-all-checks.mjs`（型別/建置/資料一致性/APK） | ✅ 8/8 全部通過 |
| `verify-cdn-key.mjs`（CDN 快取鍵隔離） | ✅ 6 個頻道 → 6 份**不同** manifest（sha 各異） |
| `test-drawer.mjs`（抽屜三項行為） | ✅ 全部通過（預設隱藏 / 點擊滑入 / 選頻道後自動收起） |
| `test-playback-local.mjs`（真實播放抽樣） | ✅ 4/4 頻道成功，`muted=false`（解除靜音有效） |
| `test-proxy-cache-poisoning.mjs` | ⚠️ **原本假失敗** → 修正後 ✅ 通過（見 §12.3） |

線上抽樣播放（`--wait 60`，系統 Chrome + CDP 真實滑鼠事件）：

```
✓ 龍華電視    t=35.0  1920x1080  muted=false
✓ TVB翡翠台   t=41.7  1920x1080  muted=false
✓ Now TV      t=50.9  1920x1080  muted=false
✓ HOY TV      t=41.8  1920x1080  muted=false
結果：4/4 個頻道播放成功
```

### 12.2 本輪發現（實測，非推測）

**Netlify edge 對 `Range` 標頭的行為（實測，非文件假設）**

`netlify-vary` 顯示快取鍵為
`query=__nextDataReq|_rsc, header=x-nextjs-data|...` —— **不含 `Range`**。
這與「query string 不進快取鍵」是同型別的 P0 風險，因此必須實測而不能假設。

實測結果（`Range: bytes=100-200` 先，再 `Range: bytes=0-`）：

| 情境 | 結果 |
|---|---|
| 首次請求中途 range（網址尚未被快取） | `206` + `Cache-Control: no-store` ✓ 代理行為正確 |
| edge 已快取完整物件後再請求中途 range | `206` + `public,max-age=300`（edge 自行切片，沿用快取物件標頭） |
| **中途 range 之後請求完整 range** | **拿到完整 segment（實測 3056504 / 2258444 / 8696316 bytes 全部相符）** ✓ |
| 中途 range 前後位元組比對 | 一致 ✓ |

結論：**沒有 Range 快取污染**。edge 持有的是完整物件，切片位元組正確。

### 12.3 修正：`test-proxy-cache-poisoning.mjs` 的兩處過期斷言

本測試原本在線上**假失敗**（`✗ 未通過`），但代理行為其實是正確的。兩處原因：

1. **只認 HTTP 200。** edge 快取命中時會回 `206` + **完整** Content-Range
   （`bytes 0-(N-1)/N`，內容完全正確）。舊斷言把這種合法回應判為失敗。
2. **從 `?url=` 反推上游網址。** 代理在 2026-11-21 已改成
   `/api/proxy/<base64url(target)>?sig=…`（修 P0：query 不進快取鍵），
   舊的反推方式**永遠失敗** → 情境 [B]/[C] 的「過期 segment」驗證
   **被整段靜默跳過**。這是比假失敗更嚴重的問題：測試看起來在跑，
   實際上沒有驗證到它宣稱要驗的東西。

修法：

- 新增 `isCompleteResponse(status, contentRange)`：接受 `200`，
  或 `206` 且 Content-Range 涵蓋全部（`bytes 0-(N-1)/N`）。
- 新增 `decodeUpstreamFromProxied()`：從 **path 的 base64url** 反推上游網址
  （並保留舊 `?url=` 作為相容路徑）。
- **新增情境 [D]：Range 快取鍵隔離** —— 先請求中途 range、再請求完整 range，
  並**完整下載**比對位元組數是否等於宣告總長。這是本測試原本完全沒有覆蓋的
  P0 級風險。

### 12.4 修正後的線上驗證輸出

```
[A] 有效 segment（應回完整內容 + 可快取）
    HTTP 206   Cache-Control: public,max-age=300
    Content-Range: bytes 0-3056503/3056504
    判定：✓ 正確（完整 segment 且可快取）

[B] 等待 40 秒讓 segment 過期…
    上游此刻回: HTTP 206 len 3056504 cr bytes 0-3056503/3056504
    （已過期：否 —— 可能上游又更新了序號）   ← 反推成功，過期驗證不再被跳過

[C] 代理回應（不可接受：HTML 錯誤頁被當成影片）
    首位元組 0x47
    判定：✓ CDN 快取命中，回有效 segment（0x47）—— 這是預期的保護效果

[D] Range 快取鍵隔離（部分內容不得污染完整 segment）
    [D1] 中途 range: HTTP 206 cr=bytes 100-200/3056504 len=101
    [D2] 完整 range: HTTP 206 cr=bytes 0-3056503/3056504
    判定：✓ 完整 range 回完整 segment（實際 3056504 bytes / 宣告 3056504）
           —— 未被中途 range 污染

結果：✓ 通過
```

### 12.5 上網參考（真的能套用的）

| 來源 | 內容 | 對本專案的意義 |
|---|---|---|
| [Netlify Functions API reference](https://docs.netlify.com/build/functions/api/) | 同步執行上限 **60 秒**、串流回應上限 **20 MB**、緩衝 payload 6 MB | 代理的 `UPSTREAM_TIMEOUT_MS=25s` / `MAX_PROJECTED_TRANSFER_MS=22s` **低於**平台上限，屬保守但正確；本專案的 5.4 MB segment 在 20 MB 限制內 |
| [hls.js Releases](https://github.com/video-dev/hls.js/releases) | v1.7.4 仍為最新穩定版（v1.7.3 於 2026-09-11 發布） | **無需升級**；目前用的 1.7.4 已是最新的穩定版 |
| [hls.js #7283](https://github.com/video-dev/hls.js/issues/7283) / [videojs PR #2103](https://github.com/videojs/v10/pull/2103) | `startLoad()` 會先 `stopLoad()`，中止正在載入的 init segment → 100 ms 重試迴圈，播放永遠無法開始 | 本專案的 `useHlsPlayer.ts` **只在 `loadSource()` 後呼叫 `attachMedia()`**，沒有中途呼叫 `startLoad()`/`stopLoad()`，**不受此 bug 影響**；但這是未來若加入「手動重試」功能時的雷 |
| [hls.js #7556](https://github.com/video-dev/hls.js/issues/7556) | 直播清單只有 1 個 segment 時會停頓一個 target duration | 本專案用 `liveSyncDuration: 6` + `maxBufferLength: 60`（見 `useHlsPlayer.ts`），緩衝做厚可涵蓋 |

### 12.6 本輪未解問題

- `shared/source-verification.json` 的 deep probe 尚在執行（本輪時間窗內未跑完）。
- 未改動任何頻道資料 —— 本輪無「更多頻道可播」的可交付改動。
- 代理的 `UPSTREAM_TIMEOUT_MS` 仍為 25 秒；Netlify 實際同步上限是 60 秒，
  可考慮放寬以讓「慢但可用」的來源多撐 35 秒。**本輪未實作**：
  放寬預算會讓「被平台中途切斷的截斷內容」有被快取的風險，
  必須先量測各來源的實際下載時間分佈才能決定安全值。

### 12.7 修正：探測腳本誤判「好頻道失效」（4 個頻道）

deep probe 首輪結果是 **81/85 可播、4 個完全失效**。逐一查證後發現
**這 4 個都是探測腳本的誤判**，不是頻道真的壞了。兩個獨立原因：

#### 原因 A：驗證時取「最舊」的 segment（直播清單的舊 segment 會過期）

`verify-channel-sources.mjs` 原本取 `segs[0]`。但直播清單的 segment 條目
是**由舊到新**排列，舊的很快過期。

實測 **Dali TV**（官方來源 `www.dalitv.com.tw:4568`）：

```
manifest 有 30 條 segment
  segs[0]  （331124.ts）→ 404  ← 已過期
  segs[29] （331153.ts）→ 200，4835924 bytes，0x47 有效 MPEG-TS
```

修法：優先取**最新**的 segment，並逐一試多個候選（最新 + 前 3 條）。

#### 原因 B：下載中途斷線沒有重試

重試條件原本只有 `/逾時|AbortError/`，但**下載中途連線被切斷**
（`ECONNRESET` / `UND_ERR_SOCKET` / `TypeError`）同樣是上游偶發狀況。

實測 **四川衛視**（`121.19.134.149:808`）：

```
attempt 1  ERR TypeError terminated UND_ERR_SOCKET
attempt 2  status 404 len 163 b0=0x3c   ← 錯誤頁（HTML）
```

重試後立刻成功拿到 5.2 MB / 0.2s 的有效 segment。不重試會讓 `needs_swap`
建議「把好頻道換掉」—— 那會把可用的官方來源換成品質較差的備援。

#### 修正後重測（同一組 4 個先前失敗的頻道）

```
✓ Dali TV      mpegts 4.2MB 0.0s CORS
✓ 河南衛視      mpegts 5.2MB 0.5s 需代理
✓ 廣東珠江台     mpegts 5.2MB 0.1s 需代理
✓ 四川衛視      mpegts 5.2MB 0.2s 需代理

可播 4/4｜需改用備援 0｜完全失效 0
```

線上播放實測確認 Dali TV 真的可播（不是探測腳本說了算）：

```
✓ Dali TV  currentTime=233.05 paused=false muted=false size=1280x720
結果：1/1 個頻道播放成功
```

> ⚠️ 這個誤判有實質危害：`needs_swap` 會把「主來源失效」寫進
> `shared/source-verification.json`，後續的 `repair-dead-backups.mjs` /
> `assign-backups.mjs` 可能據此**把好頻道的主來源換掉**。
> 探測腳本的假失敗不只是數字不好看 —— 會造成資料劣化。
