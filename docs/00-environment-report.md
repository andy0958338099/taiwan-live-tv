# 環境評估報告（Phase 0）

> 產出日期：2026-11-19
> 檢查方式：唯讀指令（system_profiler / sw_vers / df / which / 版本查詢），未修改任何系統設定。

## 1. 硬體

| 項目 | 值 |
|---|---|
| 機型 | Mac mini（Model Mac16,10，型號 MU9D3TA/A） |
| 晶片 | Apple M4，10 核心（4 效能 + 6 節能） |
| 記憶體 | 16 GB 統一記憶體 |
| 系統韌體 | 20457.41.3 |
| 作業系統 | macOS 27.2.1（Darwin 27.2.0, arm64） |
| 磁碟 | 1.8 TB SSD，已用 167 GB，**可用 1.6 TB** |
| 網路 | 192.168.31.8/24 |

結論：硬體效能與儲存空間對本專案（Android 編譯 + Next.js 建置）完全充足，
無任何硬體門檻。

## 2. 初始工具鏈狀態

### 檢查前（Phase 0 唯讀檢查結果）

| 工具 | 狀態 |
|---|---|
| JDK | ❌ **完全缺失**（`/usr/bin/java` 僅為 macOS 空殼，`java_home -V` 回報找不到 runtime） |
| Gradle | ❌ 缺失 |
| Android Studio | ❌ 缺失 |
| Android SDK | ❌ 缺失（`~/Library/Android/sdk` 不存在） |
| adb / sdkmanager | ❌ 缺失 |
| `ANDROID_HOME` / `ANDROID_SDK_ROOT` / `JAVA_HOME` | ❌ 皆未設定 |
| Node.js | ✅ v26.12.1（位於 `~/.hermes/tools/`，Hermes 自帶） |
| npm | ✅ 12.0.2 |
| pnpm | ✅ 12.15.0 |
| Git | ✅ 2.54.0（Apple Git-157），但**無 `~/.gitconfig`**、無 SSH 私鑰 |
| Xcode CLT | ✅ `/Library/Developer/CommandLineTools`（clang 21） |
| Homebrew | ❌ 未安裝（`/opt/homebrew` 不存在） |
| Docker | ❌ 未安裝 |
| ffmpeg | ✅ 9.0.1（Hermes 自帶，僅 ffmpeg，無 ffprobe） |
| Chromium | ✅ 1208（Hermes 自帶，供瀏覽器測試） |

既有專案衝突檢查：家目錄內**不存在**任何含 TV / Live / taiwan 字樣的專案，
唯一既有專案 `~/workspace/personal-workspace` 完全獨立，本專案不觸碰。

### 安裝後（實際建置所需）

| 項目 | 版本 | 大小 | 位置 |
|---|---|---|---|
| Temurin JDK | 17.0.21.1+2 | 186 MB | `~/.local/toolchains/jdk-17.0.21.1+2/` |
| Gradle | 8.13 | 130 MB | `~/.local/toolchains/gradle-8.13/` |
| Android cmdline-tools | 19.0 | 137 MB | `~/Library/Android/sdk/cmdline-tools/` |
| Android Platform | android-36 | ~90 MB | `~/Library/Android/sdk/platforms/` |
| Build Tools | 36.0.0 | ~70 MB | `~/Library/Android/sdk/build-tools/` |
| platform-tools (adb) | 37.0.1 | ~15 MB | `~/Library/Android/sdk/platform-tools/` |
| Gradle 依賴快取 | — | ~1.5 GB | `~/.gradle/` |
| Node 依賴 | — | ~350 MB | `web/node_modules/` |

**實際總用量約 2.5 GB**（遠低於預估的 4.5 GB），儲存空間無壓力。

## 3. 決策紀錄

### ADR-001：不安裝 Android Studio

**決策**：只安裝 cmdline-tools，不裝 Android Studio（1.2 GB）。

**理由**：
- 命令列足以完成 `assembleDebug` 與 `assembleRelease`
- 本專案不需要 IDE 的 Layout Preview 或 Inspector
- 安裝 Android Studio 對最終 APK 產出沒有任何幫助

**代價**：無法用 GUI 快速除錯；改以 `adb logcat` + `apkanalyzer` 驗證。

### ADR-002：使用 AGP 8.13.2 而非 AGP 9.x

**決策**：AGP 8.13.2 + Gradle 8.13 + Kotlin 2.3.21 + compileSdk 36。

**理由**：
- AGP 9.x 是大版本（內建 Kotlin 支援、多項 DSL 變更），相容性風險較高
- AGP 8.13.2 的 max API level 為 36.1，涵蓋本專案所需
- Kotlin 2.3.21 對應 R8 8.13.19（官方註明支援 Kotlin 2.3）

**代價**：`androidx.core:core-ktx` 等最新版本（1.19.x）要求 AGP 9.1+，
因此固定在 `core-ktx:1.17.0` / `appcompat:1.7.1` / `activity-ktx:1.11.0` /
`fragment-ktx:1.8.6` / `recyclerview:1.3.2`。這些版本功能完整且穩定。

### ADR-003：minSdk 23

**決策**：`minSdk = 23`（Android 6.0）。

**理由**：Media3 1.11.1 的 `media3-exoplayer-hls` 在 manifest merger 階段強制
`minSdkVersion 23`，低於此值無法建置。實務上現今電視盒多為 Android 9+，
影響可忽略。

### ADR-004：不使用官方 Android TV 系統映像

**決策**：不建立 AVD。

**理由**：Google **未提供** `android-tv` 系統映像於 SDK repository，
AVD 僅有 phone/tablet。因此模擬器無法驗證 TV Launcher 與遙控器操作，
必須以真實電視盒測試。這不是取捨而是平台限制。

### ADR-005：Web 版採 Next.js 靜態輸出

**決策**：Next.js 16 App Router，`channels.json` 以靜態檔提供於 `public/`。

**理由**：
- 頻道資料更新頻率低，靜態檔足夠
- 免費方案（Netlify）即可部署靜態內容，無需 serverless
- 若日後需要 CORS 代理，再加 route handler 即可（見 `docs/01-system-design.md`）

## 4. 已確認的環境限制

1. **headless Chromium 無媒體解碼能力**：測試環境的 HeadlessChrome 145
   `canPlayType` 對所有編碼都回傳 "probably"，但實際無法解碼 ——
   純 `<video src=".ts">`、純 MediaSource（不經 hls.js）、甚至 WebM
   都停在 `readyState = 0` 且 `sourceopen` 從未觸發。
   **這是測試環境的限制，不是專案程式的問題。**
   驗證方式改用 `/Applications/Google Chrome.app`（真實 Chrome，含 H.264 解碼器）
   + CDP 遠端偵錯，可正常播放 1280x720 串流。

2. **ffmpeg 缺少 CA 憑證**：Hermes 自帶的 ffmpeg 無法驗證 TLS 憑證
   （`certificate verify failed`）。串流可用性改以 `curl` 驗證。

3. **無 Homebrew**：所有工具以官方 tar/zip 直接安裝，不依賴套件管理器。

## 5. 環境建置指令（可重現）

```bash
# JDK 17
curl -sSL -o jdk17.tar.gz \
  "https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.21.1%2B2/OpenJDK17U-jdk_aarch64_mac_hotspot_17.0.21.1_2.tar.gz"
tar xzf jdk17.tar.gz -C ~/.local/toolchains/

# Gradle 8.13
curl -sSL -o gradle.zip "https://services.gradle.org/distributions/gradle-8.13-bin.zip"
unzip -q gradle.zip -d ~/.local/toolchains/

# Android cmdline-tools
mkdir -p ~/Library/Android/sdk/cmdline-tools
curl -sSL -o cmdline-tools.zip \
  "https://dl.google.com/android/repository/commandlinetools-mac-13114758_latest.zip"
unzip -q cmdline-tools.zip -d /tmp/ct && mv /tmp/ct/cmdline-tools ~/Library/Android/sdk/cmdline-tools/latest

# SDK 元件
export JAVA_HOME=~/.local/toolchains/jdk-17.0.21.1+2/Contents/Home
export ANDROID_HOME=~/Library/Android/sdk
yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses
$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager \
  "platform-tools" "platforms;android-36" "build-tools;36.0.0"
```

## 6. 結論

**環境完全具備 Android TV APK 與 Web 版雙平台的開發與建置能力。**
無需升級硬體、無需付費服務、無需變更既有專案。
