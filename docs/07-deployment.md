# 部署說明

## 線上環境

| 項目 | 值 |
|---|---|
| 網站網址 | https://taiwan-live-tv.netlify.app |
| GitHub repo | https://github.com/andy0958338099/taiwan-live-tv （公開） |
| Netlify site id | `4ee45693-cc95-4241-8d99-efe85565f8a9` |
| 建置指令 | `npm run build`（於 `web/` 底下執行） |
| 發布目錄 | `web/.next` |
| Node 版本 | 22 |

## 自動部署

推 `main` 分支到 GitHub 即會自動觸發 Netlify 建置與部署。

```bash
cd /Users/andy/workspace/taiwan-live-tv
git push origin main
```

查詢部署狀態：

```bash
TOKEN=$(grep "^NETLIFY_AUTH_TOKEN=" \
  "/Users/andy/Brian資料夾/江南部落格/manga-studio/frontend/.env.local" | cut -d= -f2-)
SITE=4ee45693-cc95-4241-8d99-efe85565f8a9

curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://api.netlify.com/api/v1/sites/$SITE/deploys?per_page=5" | \
  python3 -c "import sys,json; [print(x['created_at'][:19], x['state'], (x.get('error_message') or '')[:120]) for x in json.load(sys.stdin)]"
```

## 環境變數（必須）

### `PROXY_SECRET` — 簽章密鑰（**必要**）

HLS 代理會用 HMAC 為 manifest 內的 segment / 子 manifest 網址簽章，
讓代理只接受「自己剛剛代理過的 manifest 所引用的網址」，
避免被當成任意網址的開放代理。

**為什麼必須設定**：Netlify 的 serverless 是多實例架構，
若不設定，每個實例會各自產生隨機密鑰 →
manifest 由實例 A 簽章、segment 卻送到實例 B → 驗證失敗 → 頻道播不出來。

```bash
cd /Users/andy/workspace/taiwan-live-tv
export NETLIFY_AUTH_TOKEN=<token>
npx netlify env:set PROXY_SECRET "$(openssl rand -hex 32)" \
  --site 4ee45693-cc95-4241-8d99-efe85565f8a9 --context production
```

### `NEXT_PUBLIC_SITE_URL` — 站台網址

代理需要知道自己的網址才能取得 `channels.json`（用來建立允許清單）。
程式已改為優先使用「請求本身的 origin」，此變數作為備援。

```bash
npx netlify env:set NEXT_PUBLIC_SITE_URL "https://taiwan-live-tv.netlify.app" \
  --site 4ee45693-cc95-4241-8d99-efe85565f8a9 --context production
```

> 設定環境變數後**需要重新部署**才會生效。

## 已知限制

1. **litv 播放器（東森 CH51、三立 CH54）在 Web 版維持靜音。**
   litv 播放器沒有公開的 API 可下指令，而跨網域無法操作 iframe 內的 DOM。
   Android 版用原生 ExoPlayer 直接播 HLS，不受此限制。
   （YouTube 嵌入的 8 個頻道可透過 IFrame Player API 正常取消靜音。）

2. **代理不回應快取。** 直播內容即時性重要，且會佔用頻寬。

3. **代理的 manifest 改寫會把整份 manifest 讀進記憶體。**
   這是為了避免 `tee()` 分流造成的死鎖（實測會讓 segment 請求 hang 住）。
   segment 大小約 1–8 MB，在 serverless 的記憶體限制內可接受。

## 本機開發

```bash
# 同步頻道資料（兩端）
node scripts/sync-channels.mjs

# 啟動 Web 版
cd web && npm run dev

# 完整驗證（頻道資料、型別、建置、APK）
node scripts/run-all-checks.mjs
```

Android 建置：

```bash
export JAVA_HOME=/Users/andy/.local/toolchains/jdk-17.0.21.1+2/Contents/Home
export ANDROID_HOME=/Users/andy/Library/Android/sdk
cd android && ./gradlew assembleDebug
# 產出：android/app/build/outputs/apk/debug/app-debug.apk
```
