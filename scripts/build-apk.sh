#!/usr/bin/env bash
#
# build-apk.sh — 建置 Android TV APK
#
# ## 為什麼需要這支
#
# 這台 Mac 的 JDK 不是用系統的 `/usr/libexec/java_home` 找得到
# （Temurin 17 裝在 `~/.local/toolchains/`，沒註冊到 macOS 的 JDK 清單）。
# 所以直接跑 `./gradlew` 會得到：
#
#     The operation couldn't be completed. Unable to locate a Java Runtime.
#
# 這支腳本把環境變數一次設好，並順便做幾件容易忘的事：
#   1. 先把 `shared/channels.json` 同步到 Android assets（確保 APK 內的頻道
#      清單與網頁版一致）
#   2. 建置 Debug APK（已用 debug key 簽名，可直接側載安裝）
#   3. 把 APK 複製到 `dist/`，檔名帶版本號與日期，方便辨認
#
# ## 用法
#
#     ./scripts/build-apk.sh              # Debug APK
#     ./scripts/build-apk.sh release      # Release APK（未設定簽署金鑰時會失敗）
#
# ## 產出
#
#     dist/taiwan-live-tv-<version>-<date>-debug.apk
#
# ## 關於 CPU 架構
#
# Media3 / ExoPlayer 是純 Java/Kotlin，APK 裡**沒有原生函式庫**
# （建置日誌會出現 `mergeDebugNativeLibs NO-SOURCE`），
# 所以同一個 APK 可以裝在 arm64-v8a、armeabi-v7a、x86_64 的任何機器上，
# 不需要分架構打包。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── 環境 ──
export JAVA_HOME="${JAVA_HOME:-$HOME/.local/toolchains/jdk-17.0.21.1+2/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

if [ ! -x "$JAVA_HOME/bin/java" ]; then
  echo "✗ 找不到 JDK：$JAVA_HOME" >&2
  echo "  （Temurin 17 應在 ~/.local/toolchains/jdk-17.0.21.1+2/Contents/Home）" >&2
  exit 1
fi

echo "JAVA_HOME=$JAVA_HOME"
"$JAVA_HOME/bin/java" -version 2>&1 | head -1
echo "ANDROID_HOME=$ANDROID_HOME"
echo

# ── 同步頻道資料 ──
echo "── 同步頻道資料 ──"
node scripts/sync-channels.mjs
echo

# ── 建置 ──
BUILD_TYPE="${1:-debug}"
# ⚠️ macOS 內建 /bin/bash 是 3.2（不支援 `${VAR^}`），
#    而且 BSD sed 不支援 `\U` → 用 cut + tr 做首字母大寫，兩邊都通用。
FIRST=$(printf '%s' "$BUILD_TYPE" | cut -c1 | tr '[:lower:]' '[:upper:]')
REST=$(printf '%s' "$BUILD_TYPE" | cut -c2-)
BUILD_TASK="assemble${FIRST}${REST}"
echo "── 建置 $BUILD_TYPE APK ──"
cd "$ROOT/android"
./gradlew "$BUILD_TASK" --console=plain

# ── 收集產出 ──
SRC=$(find "$ROOT/android/app/build/outputs/apk/$BUILD_TYPE" -name "*.apk" | head -1)
if [ -z "$SRC" ]; then
  echo "✗ 找不到產出的 APK" >&2
  exit 1
fi

mkdir -p "$ROOT/dist"
VERSION=$(grep -oE 'versionName = "[^"]+"' "$ROOT/android/app/build.gradle.kts" | head -1 | sed 's/.*"\(.*\)"/\1/')
DATE=$(date +%Y%m%d)
OUT="$ROOT/dist/taiwan-live-tv-${VERSION}-${DATE}-${BUILD_TYPE}.apk"
cp "$SRC" "$OUT"

echo
echo "✓ 完成：$OUT"
ls -lh "$OUT"
echo
echo "  安裝方式："
echo "    adb install -r \"$OUT\""
echo "  或把檔案傳到電視盒上用檔案管理器點安裝（需允許「安裝未知來源」）。"
