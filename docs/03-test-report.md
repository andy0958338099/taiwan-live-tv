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

| 頻道 | 類型 | 結果 |
|---|---|---|
| 龍華電視 | HLS | ✅ 1920×1080，播放 28 秒 |
| CGTN 中國環球電視 | HLS | ✅ 1920×1080，播放 13 秒 |
| 鳳凰衛視中文台 | HLS | ✅ 1920×1080，播放 25 秒 |
| 央視-1 綜合 | HLS（代理） | ✅ 1920×1080，播放 8.6 秒 |
| 華視新聞 CH52 | 官方 embed | ✅ 1280×720 |
| 中天新聞 CH52 | 官方 embed | ✅ 1280×720 |
| 鏡新聞 24H | 官方 embed | ✅ 1280×720 |
| 中視新聞台 | 官方 embed | ✅ 1280×720 |
| 客家電視台 | 官方 embed | ✅ 1280×720 |
| 大愛電視（全球） | 官方 embed | ✅ 1280×720 |
| 寰宇新聞台灣台 | 官方 embed | ✅ 1280×720 |
| 公視網路直播 | 官方 embed | ✅ 1280×720 |

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

## 7. 結論

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
| **真實電視盒實測** | ⏳ **待設備** |
| **全部 83 個頻道的逐一播放驗證** | ⏳ **進行中**（`verify-channel-sources.mjs`） |
