# 台灣電視直播平台 (Taiwan Live TV)

統一台灣電視直播系統：Android TV 原生 APK ＋ Web 網頁版，兩端共用同一份頻道資料。

## 目錄結構

```
taiwan-live-tv/
├── shared/                    # ★ 頻道資料唯一真實來源 (Single Source of Truth)
│   ├── channels.json          #   頻道清單
│   └── schema.md              #   欄位定義與授權狀態規範
├── android/                   # Android TV APK (Kotlin + Media3)
├── web/                       # Web 版 (Next.js + TypeScript + HLS.js)
├── scripts/
│   ├── sync-channels.mjs      # shared/channels.json → android assets + web public
│   └── validate-channels.mjs  # 授權狀態檢查：未授權頻道不得上線
├── docs/                      # 專案文件（決策紀錄）
│   ├── 00-environment-report.md
│   ├── 01-system-design.md
│   ├── 02-license-policy.md
│   ├── 03-test-report.md
│   └── 04-build-and-install.md
└── .gitignore
```

## 核心設計原則

1. **單一資料源**：`shared/channels.json` 是唯一真實來源。Android APK 與 Web 版都從這裡產生，
   由 `scripts/sync-channels.mjs` 同步到兩端。兩端讀到的頻道資料必然一致。
2. **授權優先**：`authorization_status` 不是裝飾欄位。`scripts/validate-channels.mjs` 會在
   建置前攔截未授權頻道，未通過則建置失敗。
3. **不假裝能播**：無效串流必須顯示明確錯誤，不得 fallback 成假播放畫面。
4. **不依賴觸控**：Android TV 全部操作以 D-pad 與返回鍵完成。

## 頻道授權狀態 (authorization_status)

| 值 | 意義 | 可上線 |
|---|---|---|
| `authorized` | 官方明確授權嵌入／重新發佈 | ✅ |
| `public_official` | 官方公開直播頁且明確允許嵌入 | ✅ |
| `user_provided` | 使用者自行提供且確認有權使用 | ✅ |
| `pending_review` | 已列入但授權狀態待確認 | ❌ |
| `restricted` | 不允許重新播放／需繞過限制 | ❌ |
| `unknown` | 授權狀態不明 | ❌ |

只有前三者可進入建置產物。詳見 `shared/schema.md` 與 `docs/02-license-policy.md`。

## 快速開始

```bash
# 1. 安裝依賴（web）
cd web && npm install

# 2. 同步頻道資料
node scripts/sync-channels.mjs

# 3. 驗證授權狀態
node scripts/validate-channels.mjs

# 4. 建置 Android Debug APK
cd android && ./gradlew assembleDebug

# 5. 啟動 Web
cd web && npm run dev
```

詳細說明見 `docs/04-build-and-install.md`。
