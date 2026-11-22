# 直播源巡檢紀錄

每輪巡檢結果 appended 在檔尾，格式為 `## 輪次 N`。

> 這個檔案**必須進版控**（`git add docs/source-audit-log.md`）。
> 2026-11-22 實測教訓：它一度只存在於工作目錄、沒有 commit，
> 被同一個 repo 的另一個 cron job 的 git 清理連帶刪除，
> 導致 20 輪的輪次編號整段遺失、下一輪無法判斷自己是第幾輪。

## 驗證口徑（2026-11-22 起固定）

HTTP 200 不算可播。每個來源都要逐層驗：

1. manifest 必須以 `#EXTM3U` 開頭，且不含 `#EXT-X-ENDLIST`（VOD）
2. manifest 內若有子清單，最多再遞迴 2 層
3. 取第一個 segment，用 `Range: bytes=0-2047` 抓前 2KB
   （**注意**：Range 請求回 `206 Partial Content`，不是 200）
4. **位元組嗅探**：首位 `0x47` = MPEG-TS、含 `ftyp/styp/moof/mdat` = fMP4 → 通過；
   開頭是 `<` = HTML、`FF D8` = JPEG、`89 50` = PNG → 失效
5. URL 含 `youtube.com`／`youtu.be` → 不是 HLS 源，判失效
6. **停播檢查**：media playlist 的 `MEDIA-SEQUENCE` 必須會前進。
   序號不動 = 來源停播，使用者只會看到畫面凍結（不是「可播」）

## 身分比對規則（最重要）

**不要用名稱模糊比對。** 2026-11-22 曾因此把「龍華日韓台」當成「龍華電視」的備援，
使用者看到的是錯誤頻道內容。

身分證據只能取自**同一份上游清單的名稱↔網址配對**，或 `scripts/lib/channel-identity.mjs`
的 `(命名空間, 代碼)` 整組比對。

實測兩個關鍵陷阱：

- **代碼是 host-namespaced 的**：`1043_1@120.198.95.220` = 天映，
  但 `1043_1@113.25.252.226` = 青海卫视。光比代碼會配錯頻道。
- **上游清單用簡體名**（`龙华`／`凤凰`／`广东体育`／`辽宁卫视`），
  只拿繁體去比對會完全找不到候選。

## 已驗證的死路（不要重試）

- `ChiSheng9/iptv` 的 `TVxx.m3u8` —— 實際是 YouTube watch 頁引用
- `ubtvfans.com`、`jdshipin.com`（DNS 不解析或回 HTML）
- `4gtv` 免費頻道 —— 需 token + 地區鎖
- `iptv.ebc.edu.kh` —— 除 channel/1、channel/2 以外全 404
- `cdn3.indevs.in/stream/live/typd/`、`cdn.qd.je/163189/typd` —— 序號不動
- `cdn8.163189.xyz/live/*/stream.m3u8` —— 302 → `cdn5.163189.xyz/expired.html`（連結已失效）
- `seb.sason.top/sc/*.m3u8` —— DNS 不解析（`hsxw_fhd` / `dsxw_fhd` / `tvbsxw_fhd` 等）
- `api.kkitv.itv888.vip`、`cdn3.123.rr.kg/stream/live/*` —— 逾時 / 524
- `101.35.240.114:88/phenix.php?id=fhhk` —— HTTP 404
- `pulltv1/pulltv2.wanfudaluye.com` —— 需 `Referer: https://www.daai.tv/`，無 Referer 回 403

## ⭐ 判定陷阱（2026-11-22 實測，本輪最重要發現）

### 1. 本機直連失敗 ≠ 來源已死

客家電視台 HAKKA TV 的主機 `h5cul1yar48um3t.wcetv.com`：

| 路徑 | 結果 |
|---|---|
| 本機直連（nc 443 / curl 連續 5 次） | TCP 連線逾時，DNS 正常解析到 143.198.133.81 |
| 正式站代理（Netlify egress IP） | HTTP 200，序號 525250 → 525468 持續前進 |

也就是說「本機連不上」只是**巡檢機的 IP 被該 CDN 限流**。
若照本機直連結果下架，會把還在播的頻道誤殺。

**→ 判定一律以正式站代理路徑為準**（那也是使用者實際會走的路徑）。
新增工具：`scripts/audit-via-proxy.mjs`（單一網址）、`scripts/audit-all-via-proxy.mjs`（全清單）。

### 2. 只看序號會被 CDN 快取騙到

同時跑多個探測器時，CDN 對 media playlist 回應快取，兩邊讀到**同一份舊清單**，
序號看起來不動 → 誤判「已停播」。實測 `gdzj` 手動 curl 是
1750412925 → 1750412928 → 1750412931（有在動），但並發探測時讀到同一個值。

**→ 決定性判定 = 對同一個 segment 連續取樣並比對內容雜湊**。
雜湊不變 = 那一格畫面一直沒變 = 真的停播。
新增工具：`scripts/probe-frozen-decisive.mjs`（同時輸出 seq 與 sha256 前 12 碼）。

### 3. 代理改寫後的 manifest 會破壞 Range 邏輯

`/api/proxy/<base64url>` 路徑裡的 `.ts` 被 base64 編掉 → **不能靠副檔名**分辨
「這是清單還是 segment」。另外對清單送 `Range: bytes=0-2047` 會把清單截成
2048 bytes → segment 條目不完整 → 下一層簽章斷掉 → 代理回 502/403。

**→ 正確做法**：先送 Range 抓前 2KB，看開頭是不是 `#EXTM3U`；
是清單就**重新抓完整版**再往下走。

### 4. 代理有「上游供應過慢就放棄」保護

完整下載 3–6MB segment 會觸發代理的 `projected_ms` 保護 → 502
（「來源供應過慢，已放棄（避免回傳被截斷的內容）」）。
這是**代理保護，不是來源失效**。用 Range 只抓前 2KB 即可避開。

## 輪次

### 輪次 1 — 2026-11-22 10:45 CST

**巡檢範圍**：90 個頻道（81 個 HLS + 9 個官方 embed）。
判定工具：`scripts/verify-channel-sources.mjs`（專案既有 deep probe）
＋ 本輪新增的 5 支獨立工具（見下）。

**⭐ 本輪最大的發現：判定口徑本身有漏洞，已修正**

專案既有的 deep probe 判「已停播」靠的是 `MEDIA-SEQUENCE` 不動。
但 2026-11-22 實測證明這個口徑有兩個會誤殺的陷阱：

1. **本機 IP 被上游限流 ≠ 來源已死**
   客家電視台 HAKKA TV：`h5cul1yar48um3t.wcetv.com` 本機直連 TCP 443 逾時
   （nc 443 FAIL、curl 連續 5 次逾時），但走正式站代理 HTTP 200、
   序號 525250 → 525468 持續前進。**照直連結果下架會誤殺還在播的頻道。**
2. **CDN 快取會讓序號看起來不動**
   並發探測時讀到同一份舊的 media playlist → 誤判停播。
   實測 `gdzj` 手動 curl 序號是 1750412925 → 1750412928 → 1750412931（有在動）。

**修正後的決定性口徑**（新增 `scripts/probe-frozen-all.mjs`）：
對同一個 segment 連續取樣並比對 **sha256 內容雜湊**。
雜湊不變 = 那一格畫面一直沒變 = 真的停播。

以這個口徑重掃全清單（3 次取樣、間隔 12 秒）：**還在播 76｜停播 3｜連線錯誤 2**
（2 個錯誤經代理路徑複驗後皆正常：東方衛視、客家電視台 HAKKA TV）。

**處置一：換源（4 個）**

| 頻道 | 舊來源 → 新來源 | 實測依據 |
|---|---|---|
| 浙江衛視 | `ali-m-l.cztv.com/.../1080p.m3u8` → `121.19.134.149:808/tsfile/live/1011_1.m3u8` | 舊來源序號停在 359977910；新來源 seq 26072289 前進、mpegts 2048B |
| 天映 | `cdn.qd.je/163189/ccm` → `120.198.95.220:9901/tsfile/live/1043_1.m3u8` | 舊來源序號停在 703、雜湊不變；新來源 seq 2034426→2034434 前進 |
| 鳳凰衛視中文台 | `cdn.qd.je/163189/fhzw` → `120.198.95.220:9901/tsfile/live/1036_1.m3u8` | 舊來源序號停在 3315441、雜湊不變；新來源 seq 2035045→2035050 前進 |
| 鳳凰衛視資訊台 | `cdn.qd.je/163189/fhzx` → `120.198.95.220:9901/tsfile/live/1037_1.m3u8` | 舊來源序號停在 4578902、雜湊不變；新來源 seq 2035050→2035055 前進 |
| 大愛電視（全球） | YouTube embed → `pull.daaiplus.com/live-DAAIPLUS/live-DAAIPLUS_HD.m3u8` | 大愛官方 CDN；CORS `*` → Web 版免代理；mpegts、seq 1795297645 前進 |

身分比對全部取自**同一份上游清單的名稱↔網址配對**（itvlist.m3u）：
「浙江卫视」↔ `1011_1`、`天映」↔ `1043_1`、「凤凰中文」↔ `1036_1`、「凤凰资讯」↔ `1037_1`。
未使用名稱模糊比對。

**處置二：移除（5 個）**

| 頻道 | 判定依據 |
|---|---|
| 龍華電視 | 主來源與全部備援序號停在 21860，segment 雜湊 30 秒不變；七份上游清單無替代 |
| Now TV | 同上，序號停在 478282 |
| 鳳凰衛視香港台 | 同上，序號停在 668032 |
| 天映頻道 | `typd2` HTTP 404；同頻道替代（typd / cdn3 / cdn10 鏡像）序號全停滯或逾時 |
| 天映經典 | `ccm2` HTTP 404；同頻道替代（ccm / cdn3 / cdn10 鏡像）序號全停滯或逾時 |

**處置三：保留（1 個，重要）**

**客家電視台 HAKKA TV** —— 專案探針報「TypeError 失效」，
但那是**本機 IP 被限流**，走代理路徑實測正常前進 → **不移除**。

**本輪新增工具**

| 檔案 | 用途 |
|---|---|
| `scripts/audit-strict-sources.mjs` | 獨立於既有 probe 的嚴格稽核（口徑：#EXTM3U／無 ENDLIST／≤2 層遞迴／Range 前 2KB／位元組嗅探／YouTube 排除） |
| `scripts/audit-via-proxy.mjs` | 單一網址走正式站代理路徑驗證 |
| `scripts/audit-all-via-proxy.mjs` | 全清單走代理路徑驗證 |
| `scripts/probe-frozen-decisive.mjs` | 單一來源「內容雜湊」決定性停播判定 |
| `scripts/probe-frozen-all.mjs` | 全清單並行「內容雜湊」判定 |
| `scripts/audit-ref-sources.mjs` | 需 Referer 的來源驗證（大愛 wanfudaluye 系列） |
| `scripts/recheck-frozen.mjs` | 序號複驗（序號 + media playlist 解析） |
| `scripts/apply-round1.mjs` / `apply-round1b.mjs` | 本輪處置（可重播，附實測依據） |

**部署狀態**：已 commit + push 至 main，Netlify 自動部署。
部署後 curl 驗 `/`、`/channels.json`、`/privacy` 皆 200。


