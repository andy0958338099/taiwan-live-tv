# 建置與安裝說明

> 對應需求：六、Phase 4/5/6、八、交付

## 1. 環境變數

所有建置指令都需要以下兩個變數：

```bash
export JAVA_HOME=/Users/andy/.local/toolchains/jdk-17.0.21.1+2/Contents/Home
export ANDROID_HOME=/Users/andy/Library/Android/sdk
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
```

`android/local.properties` 已寫入 SDK 路徑（該檔已列入 `.gitignore`）。

## 2. 頻道資料同步

**每次修改 `shared/channels.json` 後都必須執行**：

```bash
cd /Users/andy/workspace/taiwan-live-tv
node scripts/sync-channels.mjs
```

此指令會先驗證授權狀態，再同步到 Android assets 與 Web public。
驗證失敗則不寫入任何檔案。

驗證兩端資料一致：

```bash
node scripts/test-channel-consistency.mjs
```

## 3. 建置 Android APK

### Debug APK（測試用）

```bash
cd android
./gradlew assembleDebug
```

產物：`android/app/build/outputs/apk/debug/app-debug.apk`（約 8.9 MB）

Debug APK 使用 Gradle 自動產生的 debug keystore 簽章，可直接安裝測試，
但**不能用於正式發佈**（每次建置簽章指紋可能不同，會造成無法覆蓋安裝）。

### Release APK（正式版）

```bash
cd android
./gradlew assembleRelease
```

產物：`android/app/build/outputs/apk/release/app-release-unsigned.apk`

**需要自行建立 release keystore**（密碼由你保管，不要提交到版控）：

```bash
keytool -genkeypair -v \
  -keystore ~/taiwan-live-tv-release.jks \
  -alias taiwan-live-tv \
  -keyalg RSA -keysize 2048 -validity 10000
```

在 `android/app/build.gradle.kts` 加入簽章設定（密碼讀取自環境變數，
不要寫死）：

```kotlin
android {
    signingConfigs {
        create("release") {
            storeFile = file(System.getenv("TLTV_KEYSTORE_PATH") ?: "")
            storePassword = System.getenv("TLTV_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("TLTV_KEY_ALIAS")
            keyPassword = System.getenv("TLTV_KEY_PASSWORD")
        }
    }
    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
        }
    }
}
```

## 4. 安裝到 Android TV 電視盒

### 方法一：USB 連線 + adb（推薦）

1. 電視盒開啟「USB 偵錯 / ADB 偵錯」
   （多數盒子在 設定 → 關於 → 版本號碼 連點 7 次開啟开发者模式，
   再到 設定 → 开发者選項 → USB 偵錯）
2. 用 USB 線連接 Mac mini 與電視盒
3. 電視盒上會跳出授權對話框，勾選「一律允許」並確認
4. 確認裝置已連線：

```bash
adb devices -l
# 應看到類似：ABC1234567  device product:xxx model:xxx
```

5. 安裝 APK：

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

6. 啟動：

```bash
adb shell am start -n com.taiwanlivetv/.ui.MainActivity
```

### 方法二：無線 ADB（網路）

若電視盒與 Mac mini 在同一網段（192.168.31.x）：

```bash
# 電視盒端需先開啟「網路 ADB / TCP 連接埠 5555」
adb connect 192.168.31.XX:5555
adb install -r app-debug.apk
```

### 方法三：直接安裝檔

把 `app-debug.apk` 複製到 USB 隨身碟，插到電視盒，用檔案管理器點擊安裝。
需要電視盒允許「安裝未知來源應用程式」。

## 5. 驗證安裝結果

### App 是否出現在 Launcher

```bash
# 查詢 LEANBACK 入口
adb shell cmd package query-activities \
  --brief -a android.intent.action.MAIN -c android.intent.category.LEANBACK_LAUNCHER \
  | grep taiwanlivetv
```

應輸出 `com.taiwanlivetv/.ui.MainActivity`。

### 確認台標 banner 正常

```bash
adb shell dumpsys package com.taiwanlivetv | grep -i banner
```

### 查看執行 log

```bash
adb logcat -s TvPlayerController ChannelRepository NetworkMonitor MainActivity
```

### 螢幕截圖

```bash
adb shell screencap -p /sdcard/tltv.png
adb pull /sdcard/tltv.png
```

### 遙控器操作測試

```bash
# 方向鍵
adb shell input keyevent KEYCODE_DPAD_UP
adb shell input keyevent KEYCODE_DPAD_DOWN
adb shell input keyevent KEYCODE_DPAD_LEFT
adb shell input keyevent KEYCODE_DPAD_RIGHT
adb shell input keyevent KEYCODE_DPAD_CENTER
adb shell input keyevent KEYCODE_BACK
```

## 6. 啟動 Web 版

### 開發模式

```bash
cd web
npm install
npm run dev
# http://localhost:3000
```

### 本機試跑（正式建置）

```bash
cd web
npm run build
npm run start -- --port 3210
```

區網內其他裝置可透過 `http://192.168.31.8:3210` 存取。

### 部署到 Netlify（需你確認後執行）

專案為靜態輸出，可直接部署：

```bash
cd web
npm i -g netlify-cli
netlify deploy --prod --dir=.next
```

或在 Netlify 後台設定：

| 設定 | 值 |
|---|---|
| Build command | `cd web && npm run build` |
| Publish directory | `web/.next` |
| Node version | 20 或以上 |

**注意**：部署前必須先執行 `node scripts/sync-channels.mjs`，
確保 `web/public/channels.json` 是最新的。

## 7. 產出檔案清單

| 檔案 | 說明 |
|---|---|
| `android/app/build/outputs/apk/debug/app-debug.apk` | 可安裝的 Debug APK |
| `web/.next/` | Next.js 建置產物（可部署） |
| `web/public/channels.json` | 頻道資料（與 APK 內相同） |
| `android/app/src/main/assets/channels.json` | 頻道資料（與網頁版相同） |

## 8. 常見問題

### Q: 電視盒上找不到 App

依序檢查：
1. 是否有第三方 Launcher 而非 Android TV Launcher → 已同時註冊 `LAUNCHER` 與
   `LEANBACK_LAUNCHER`，理論上兩者都會顯示
2. Android 版本是否 < 6.0 → minSdk 23，低於此值無法安裝
3. 用 `adb shell pm list packages | grep taiwanlivetv` 確認已安裝

### Q: 播放器黑畫面但沒有錯誤

檢查 logcat 中的 `TvPlayerController` 標籤。常见原因：
- 來源需要 Referer 標頭 → 在頻道資料填 `http_referrer`
- 來源不支援此裝置的 H.264 profile → 換低解析度來源
- 來源是 HTTP（明文）→ Manifest 已設 `usesCleartextTraffic="true"`，若仍被擋
  檢查是否有其他安全策略限制

### Q: 網頁版顯示「無法載入串流清單」

多半是 **CORS** 限制。Android 版不受影響。
在 `shared/channels.json` 將該頻道的 `cors_enabled` 設為 `false`，
後續可選擇啟用代理方案（見 `docs/01-system-design.md` 第 5 節）。

### Q: 建置時出現 `requires Android Gradle plugin X or higher`

表示某個 androidx 依賴版本太新。查證方式：

```bash
unzip -p ~/.gradle/caches/modules-2/files-2.1/androidx.core/core-ktx/<版本>/<hash>/core-ktx-<版本>.aar \
  META-INF/com/android/build/gradle/aar-metadata.properties | grep minAndroidGradlePlugin
```

或直接降版（見 `docs/00-environment-report.md` ADR-002 的相容矩陣）。
