# 頻道來源管理（IPTV 清單匯入）

> 對應需求：D 頻道資料管理、可持續擴充的頻道管理機制

## 1. 設計理念

IPTV 播放清單（IPTV playlist）是**會持續變動**的來源：頻道會上下架、
來源網址會更換、代理節點會輪替。手動維護一份清單不可能跟上。

因此本專案採用「**來源註冊表 + 自動匯入 + 建置期驗證**」三段式：

```
shared/sources.json          來源註冊表（新增來源只要加一筆）
        │
        ▼  scripts/import-playlists.mjs
   抓取 → 解析 M3U → 過濾台灣頻道 → 探測可用性與 CORS
        │
        ▼
shared/channels.json         頻道資料（含匯入來源鏈與備援 URL）
        │
        ▼  scripts/validate-channels.mjs（授權守門）
        │
        ▼  scripts/sync-channels.mjs
   ├── android/app/src/main/assets/channels.json
   └── web/public/channels.json
```

**定期更新**：`scripts/refresh-channels.mjs` 一鍵完成「重新抓取 → 驗證 → 同步 → 一致性檢查」。

## 2. 已註冊的來源

`shared/sources.json` 中的 `sources` 陣列：

| id | 名稱 | URL | 台灣頻道數 | CORS 品質 | 優先序 |
|---|---|---|---|---|---|
| `yang` | YanG IPTV | `https://iptv.yang-1989.xyz/playlist.m3u` | 40 | ★★★ 多數支援 | 1 |
| `kuliao` | 裤佬 IPTV | `https://iptv.445569.xyz/live.m3u` | 47 | ★★ CloudFront 較佳 | 2 |
| `suxuang` | suxuang IPTV | `https://bit.ly/suxuang-v4` | 37 | ★ 多數無 | 3 |
| `itvlist` | itvlist | `https://bit.ly/itvlist` | 0 | — | 4 |
| `kimentanm` | Kimentanm APTV | `https://bit.ly/iptv-aptv` | 0 | — | 5 |

> `itvlist` 與 `kimentanm` 主要是央視／地方衛視，本次未篩出台灣頻道，
> 但保留在註冊表中 —— 內容每日更新，未來可能會有台灣頻道。

### 網頁型來源（組播／酒店源）

| 來源 | 狀態 | 原因 |
|---|---|---|
| IPTV神器Pro `https://iptv.cqshushu.com/` | **未匯入** | 需 Cloudflare 驗證；接口需依「產生 IP + Token」，Token 綁定請求 IP，無法作為公開訂閱源 |
| 淘IPTV `https://taoiptv.com/` | **未匯入** | 同上，Token 機制且限 2 個 IP |

這兩個站點提供的是**組播源／酒店源**（IP 位址 + 節目數量），
需要用其「接口生成工具」取得綁定特定 IP 的 Token 才能訂閱。
Token 機制意味著訂閱網址無法公開分享給 APK 使用者，因此**無法作為本專案的頻道來源**。
若日後使用者願意自行取得 Token，可改為在 APK 設定頁填入專屬訂閱網址。

## 3. 匯入規則

`shared/sources.json` 的 `import_rules` 定義：

```jsonc
{
  "include_group_keywords": ["台灣", "臺灣", "台湾", "港澳台", "台湾+", "台湾台"],
  "exclude_name_pattern": "回放|录播|录像|电影播放|劇集|劇情|电影|電影|点播|點播|成人|18\\+|情色|色情|WWE|NBA|足球|賽事|赛事|比赛|直播回放|少儿|少兒|点播台|戏曲|戲曲|直播间|聊天|公开课",
  "channel_map": { "台視": { "name": "台視 TTV", "category": "news" }, ... }
}
```

- **群組關鍵字**：只從標記為台灣／港澳台的群組取用
- **排除關鍵字**：排除電影點播、回放、成人內容、賽事、聊天房間等非線性內容
- **channel_map**：頻道名 → 正式名稱 + 分類（對應 `shared/schema.md` 的 8 個分類）

比對時會先去除清單的裝飾標記（`「」`、`Relay`、`ofiii`、`備用` 等）再比對，
且長關鍵字優先，避免「三立」誤吃其他字。

## 4. 探測與挑選

每個頻道最多探測 6 個候選來源，並檢查：

1. HTTP 狀態 200
2. 回應內容確實是 `#EXTM3U` 開頭的 m3u8 manifest
3. `Access-Control-Allow-Origin` 標頭 → 決定能否上網頁版

挑選優先序：**有 CORS > 來源優先序（priority）**。
因此 Web 版會優先挑到 `yang`（CORS 完整）的來源，
沒有 CORS 的頻道則退回其他來源，仍找不到就用無 CORS 的來源（僅 Android TV 可播）。

## 5. 匯入的頻道結構

匯入的頻道除了共用欄位，另帶 `playlist_source` 記錄來源鏈：

```jsonc
{
  "channel_id": "playlist-台視-ttv",
  "channel_name": "台視 TTV",
  "category": "news",
  "stream_url": "https://iptv.yang-1989.xyz/tw/be6z3t.m3u8",
  "source_name": "台視 TTV（經 YanG IPTV 清單轉載）",
  "source_website": "https://iptv.yang-1989.xyz/playlist.m3u",
  "authorization_status": "user_provided",
  "cors_enabled": true,
  "notes": "轉載自 YanG IPTV。原始頻道名稱：台視「Relay」。此來源支援 CORS，網頁版可直接播放。",
  "playlist_source": {
    "provider": "yang",
    "provider_label": "YanG IPTV",
    "provider_url": "https://iptv.yang-1989.xyz/playlist.m3u",
    "raw_channel_name": "台視「Relay」",
    "backup_urls": [
      { "url": "https://iptv.yang-1989.xyz/tw/be6z3t.m3u8", "source": "yang", "cors": true }
    ]
  }
}
```

`backup_urls` 保留了該頻道的所有可用備援來源。
目前尚未使用 —— 這是 Phase 4 的功能：**播放失敗時自動改用備援來源重試**。

## 6. 授權狀態說明（重要）

匯入的頻道標記為 `user_provided`，理由是：

- 這些清單由**使用者提供並指定安裝**
- 每個頻道都完整標註了 `source_name`（原始頻道 + 轉載清單）與 `source_website`（清單網址）

但必須明確記錄其性質：

> **這是第三方彙整的轉載清單，不是頻道業者的官方授權串流。**
> 轉載方是否取得原始頻道業者的授權，本專案無法查證。
> 使用這些頻道前，請確認你對其使用方式有權利基礎。

原始台灣電視頻道（台視、中視、華視、三立、東森、TVBS、中天、年代等）
本身是商業電視頻道，其節目內容受版權保護。
本專案的架構已預留 `authorization_status` 欄位，
若日後要上架受版權保護的內容，應改用業者官方授權的串流。

## 7. 定期更新

```bash
cd /Users/andy/workspace/taiwan-live-tv
node scripts/refresh-channels.mjs
```

輸出範例：
```
════════════════════════════════════════════════════════════════════
更新摘要
════════════════════════════════════════════════════════════════════
  上線頻道數    : 28
  支援 CORS     : 18（其餘僅 Android TV 版可播）
  分類分布      :
     綜合台           13
     娛樂台            8
     新聞台            5
     公共電視           1
     教育文化           1
════════════════════════════════════════════════════════════════════
```

選項：
- `--skip-probe`：跳過探測（較快，但會把已失效的來源也匯入，不建議用於正式建置）

### 建議的 cron 設定

```cron
# 每日 05:00 更新頻道資料
0 5 * * * cd /Users/andy/workspace/taiwan-live-tv && /Users/andy/.local/toolchains/node-26.12.1-darwin-arm64/bin/node scripts/refresh-channels.mjs >> logs/refresh.log 2>&1
```

**注意**：使用者在第一階段明確要求「未經我確認，不得安裝或移除任何軟體、
修改系統設定」。cron 排程屬於系統變更，需使用者同意後才設定。

## 8. 新增來源的操作

```bash
# 1. 在 shared/sources.json 的 sources 陣列加一筆
#    { "id": "mysource", "label": "我的來源", "url": "https://...", "enabled": true, "priority": 6 }

# 2. 先試跑看看會匯入什麼
node scripts/import-playlists.mjs --dry-run

# 3. 確認無誤後實際匯入
node scripts/import-playlists.mjs

# 4. 驗證 + 同步
node scripts/validate-channels.mjs && node scripts/sync-channels.mjs
```

若新來源使用不同的台灣頻道命名，在 `import_rules.channel_map` 補上對應即可。

## 9. 中國大陸頻道（新增）

### 9.1 匯入方式

中國大陸頻道與台灣頻道分開處理，因為過濾規則與命名慣例完全不同：

| | 台灣 | 中國 |
|---|---|---|
| 匯入腳本 | `scripts/import-playlists.mjs` | `scripts/import-china-channels.mjs` |
| 過濾依據 | `group-title` 含「台灣」 | 名稱含 CCTV／央視／衛視／卫视 |
| 命名 | 繁體 | **簡體**（清單提供者的慣例） |
| 對照表 | `shared/sources.json` 的 `channel_map` | 腳本內 `CHINA_CHANNEL_MAP` + `PROVINCE_MAP` |

```bash
node scripts/import-china-channels.mjs --dry-run   # 先看會匯入什麼
node scripts/import-china-channels.mjs              # 實際匯入
```

### 9.2 簡繁轉換的必要處

清單中的省衛視名稱使用**簡體**（`湖南卫视`），而專案顯示名稱使用繁體（`湖南衛視`）。
`import-china-channels.mjs` 內的 `SIMPLIFIED_TO_TRADITIONAL` 對照表做逐字轉換後比對。

> ⚠️ **踩過的坑**：`channel_id` 必須是 ASCII。
> 早期用 `cn-${key.replace(/[^a-zA-Z0-9]+/g, '-')}` 產生 id，
> 中文 key 會全部折成單一破折號 → 34 個省衛視撞成同一個 `cn--`。
> 現在 `PROVINCE_MAP` 的 key 改為 ASCII slug（`hn` = 湖南、`sx2` = 陝西）。
> `scripts/normalize-channel-ids.mjs` 負責把既有的壞 id 改名。

### 9.3 4K 來源的特殊處理

`group-title="4K频道"` **不是**要排除的群組 —— 那是正規的省份衛視 4K 版本。
排除清單只針對非電視台內容（快手、斗鱼、YY直播、直播秀、酒店、组播、主播、賽事）。

部分 4K 來源需要特定 User-Agent 才能取得串流：
```
#EXTINF:-1 ... http-user-agent="AptvPlayer-UA" ...,湖南卫视4K
```
因此 `http_user_agent` 欄位會被記錄下來，Web 版由代理轉送、Android 版在
建立 ExoPlayer 時設定。

## 10. Deep probe：為什麼「manifest 可讀」不代表「能播」

這批 IPTV 來源是**三層結構**：

```
cdn.qd.je/163189/lhjd          ← 第一層：入口 manifest（永遠回 200）
  └─ https://8.fast.hidns.vip/163189/lhjd   ← 第二層：child manifest（真正的串流）
       └─ .../segment0.ts      ← 第三層：實際媒體分段
```

**只看第一層會嚴重誤判。** 實測結果（`scripts/probe-cdn-paths.mjs`，98 條路徑）：

| 失效階段 | 數量 | 症狀 |
|---|---|---|
| `child:HTTP 502` | 10 | 第一層 200，但 child host 整批掛掉 |
| `segment:HTTP 502` | 9 | child 可讀，但分段取不到 |
| `child:AbortError` | 7 | child host 無回應 |
| `child:VOD` | 4 | child 是點播檔（有 `#EXT-X-ENDLIST`） |
| `manifest:HTTP 404` | 4 | 入口就不存在 |

**64/98 條路徑真正可播。** 失效的 34 條裡，10 條全部指向同一個 host
`smt.1678520.xyz` —— 該 host 整批失效，且已確認沒有其他可用的替代 host。

因此：
- 緯來（`wlxj` / `wlty`）與龍祥（`lxsd`）**已下架**（`scripts/apply-verified-sources.mjs`）
- 有效頻道的主來源改為**直接指向驗證過的 child manifest**，
  避免每次播放都要多繞一層入口

### 探測腳本

| 腳本 | 用途 |
|---|---|
| `scripts/probe-cdn-paths.mjs` | 深度探測 `cdn.qd.je/163189/*` 全部路徑 → `shared/cdn-paths.json` |
| `scripts/apply-verified-sources.mjs` | 套用探測結果：移除失效、更新網址、補上漏掉的頻道 |
| `scripts/probe-live-sources.mjs` | 深度探測直播聚合源（抖音／斗魚／B站／虎牙等） |
| `scripts/import-china-channels.mjs` | 中國頻道匯入（含直播性與 VOD 檢查） |

## 11. 已知限制

1. **來源 IP 位址會失效**：`kuliao` / `suxuang` 有大量 `IP:port` 直連來源
   （例如 `http://121.199.48.54/...`），這些節點時常失效。
   `refresh-channels.mjs` 會定期重新探測並淘汰失效來源。

2. **簽章查詢無法涵蓋**：部分清單的 `tvg-logo` 指向失效的台標圖片網址，
   前端已做 `onError` 處理（自動隱藏並顯示首字佔位）。

3. **CORS 不完整**：約 1/3 的來源沒有 CORS 標頭。
   這些頻道在網頁版會顯示明確錯誤（符合「不得假裝在播」的要求），
   在 Android TV 版則正常播放。

4. **Token 綁定來源無法使用**：組播／酒店源需要依 IP 取得的 Token，
   訂閱網址無法公開分享，因此未納入。見第 2 節。
