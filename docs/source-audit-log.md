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

### 輪次 2 — 2026-11-22 14:00 CST

**巡檢範圍**：92 個頻道（83 個 HLS + 9 個官方 embed）。
判定工具：**本輪新增的 `scripts/audit-all-user-path.mjs`**（見下方「本輪最重要發現」）。

**巡檢結果：可播 83、不失效 0**（HLS 部分）
（83 個 HLS 主來源全部通過使用者路徑驗證；含 4 個本輪新增、1 個本輪換源後復驗）

#### ⭐ 本輪最重要發現：第 1 輪的巡檢工具本身有系統性假陰性

第 1 輪的 `scripts/audit-all-via-proxy.mjs` 報「5 個頻道失效」，
但**逐一複驗後發現 4 個是誤判**。根因有兩個，都不是來源的問題：

**陷阱 1：判定路徑錯了 —— 代理不是所有頻道都會走**

`web/src/lib/useHlsPlayer.ts` 的 `needsProxy()` 決定要不要走代理：

```ts
export function needsProxy(channel: Channel): boolean {
  if (channel.cors_enabled === false) return true;
  if (!channel.stream_url) return false;
  if (channel.stream_url.startsWith('http://')) return true;  // 混合內容
  return false;
}
```

所以 `cors_enabled: true` **且 https** 的頻道，**瀏覽器是直連的，不走代理**。
第 1 輪卻對全部頻道都走代理驗證 → 等於用「使用者不會走的路徑」下結論。

實測 **TVBS**：

| 路徑 | 結果 |
|---|---|
| 代理（Netlify egress） | HTTP 502「來源回應 HTTP 403」（CloudFront 擋 Netlify 的 IP） |
| **直連（使用者實際路徑）** | master/child/segment 全部 HTTP 200/206、CORS `Access-Control-Allow-Origin: *`、segment 首位 `0x47`（MPEG-TS）、序號 235121839→235121840 前進 |

→ **TVBS 一直可播**，第 1 輪的「失效」是代理路徑的假陰性。
（註：`curl -I`（HEAD）看不到 CORS 標頭，S3/CloudFront 只在 GET 回；
必須用 GET + `Origin` 標頭驗證，否則會誤判 `cors_enabled` 錯誤。）

**陷阱 2：只取清單的最後一行當 segment 候選 → 拿到被截斷的網址**

代理收到帶 `Range` 的請求時，上游只回前 2048 bytes → manifest 被截成 2KB
→ 清單的最後一行是**被截斷的** segment 網址 → 簽章是斷的 → 代理回 502。

實測（代理路徑）：

| 頻道 | 第 1 輪結果 | 複驗（每個 variant × 多個 segment 位置） | 真相 |
|---|---|---|---|
| 廣東體育台 | 第 2 層 HTTP 502 | child[0] seq=73054834，seg[0/5/8/9] 全部 HTTP 206 + 0x47 | 可播 |
| 廣東珠江台 | 第 2 層 HTTP 502 | child[0] seq=1750414704，seg[0/5/8/9] 全部 HTTP 206 + 0x47 | 可播 |
| CGNTV 中文台 | 第 2 層 HTTP 502 | variant 0–3 全部 4/4 通過；**只有 variant 4 上游整組 404** | 可播 |
| 真善美電視 | 第 2 層 HTTP 502 | child[0] seq=31531，seg[0/100/198/199] 全部 HTTP 206 + 0x47 | 可播 |

→ 4 個都是假陰性。**master manifest 也必須試每一個 variant**：
CGNTV 的 5 個 variant 中，第 5 個（音訊-only，`BANDWIDTH=211612` 無 RESOLUTION）
上游整組 404（直連也是 404，不是代理問題），但 variant 1–4 完全正常，
hls.js 不會選音訊-only variant → 對使用者無影響。

**陷阱 3：沒有重試** —— 上游多後端負載平衡會隨機回 404/502
（江西衛視、山西衛視本輪一度被判失敗，複驗 4/4 全部 206 + 0x47）。

**本輪新增工具**

| 檔案 | 用途 |
|---|---|
| `scripts/audit-all-user-path.mjs` | ⭐ **主巡檢工具**：依 `cors_enabled` + 協定決定走直連或代理（與 `needsProxy()` 對齊）；每個 variant 都試；每個 child 取多個 segment 位置；每個 segment 有重試；`--seq` 做停播檢查 |
| `scripts/audit-all-robust.mjs` | 同上但固定走代理路徑（用於診斷「代理壞但來源活著」的情況） |
| `scripts/apply-round2.mjs` | 本輪處置（可重播，附實測依據與身分證據出處） |

**處置一：換源（1 個）**

| 頻道 | 舊來源 → 新來源 | 實測依據 |
|---|---|---|
| 東方衛視 | `bp-resource-dfl.bestv.cn/155/3/video.m3u8` → `121.19.134.149:808/tsfile/live/1026_1.m3u8?key=txiptv&playlive=1&authid=0` | 舊來源 DNS 解析到 117.163.54.6/8/9 但 TCP 連線失敗：直連 HTTP 0、代理 502「fetch failed」→ 真死。新來源 segment 4/4 HTTP 206 + 0x47；序號 26075922→26075923→26075925 前進 |

身分證據（**同一份上游清單** itvlist `https://bit.ly/itvlist` 第 364–365 行）：
「东方卫视」↔`http://121.19.134.149:808/tsfile/live/1026_1.m3u8`。
⚠️ 代碼是 host-namespaced：`121.19.134.33:808` + `1026_1` 是「卡酷动画」，
不是東方衛視 → 必須比對 **(host, code) 整組**。

**處置二：新增（4 個）**

| 頻道 | 來源網址 | 身分證據（同一份上游清單） | 實測 |
|---|---|---|---|
| 民視新聞台 | `http://38.64.72.148/hls/modn/list/4012/chunklist0.m3u8` | reysc/M3U8 `live2024.m3u` 第 924–925 行「民视新闻」 | seg 4/4 206 + 0x47；CORS `*`；seq 11178 |
| 台視新聞台 | `http://38.64.72.148/hls/modn/list/4013/chunklist0.m3u8` | reysc/M3U8 `live2024.m3u` 第 930–931 行「台视新闻」 | seg 4/4 206 + 0x47；CORS `*` |
| 國會頻道 1 台 | `http://61.58.60.230:9319/live/123.m3u8` | peakzheng1112/iptv2025 第 45–46 行「國會頻道1台」 | seg 4/4 206 + 0x47；CORS `*`；seq 80536 |
| 國會頻道 2 台 | `http://61.58.60.230:9319/live/124.m3u8` | peakzheng1112/iptv2025 第 47–48 行「國會頻道2台」 | seg 4/4 206 + 0x47；CORS `*`；seq 3208 |

授權狀態全部 `user_provided`（第三方 IPTV 清單轉載，非廣播商官方 CDN），
`source_name` + `source_website` 均已標註。**台灣優先**。

**本輪驗證過的死路（不要重試）**

- `74.91.26.218:82/live/*.m3u8`（cts/ctv/ctsnews/ctvnews/ftvnews/pts…）
  —— **轉址目標不穩定**：同一個網址會輪替到不同頻道
  （實測 `ctvnews` 有時轉到 `mkt.m3u8`＝民視、有時轉到 `ctv.m3u8`＝中視）。
  → **身分不可驗證，絕對不可使用**（重演第 1 輪「龍華日韓台當成龍華電視」的坑）
- `66.165.240.154:808/live/*`（三立新聞 slxw01 / 中天新聞 ztylt01 / 台視新聞 tyxltsxw3）—— 連線失敗
- `hls127.freeott.top:8080/Da_Vinci_Learning/video.m3u8`（華視新聞）—— HTTP 522
- `aajtaklive.vgcdn.net/.../vglive-sk-848805/master.m3u8`（民視台灣台）—— HTTP 404
- `live.streamingfast.net/osmflivech{3,5,12}.m3u8`（GOOD TV CH3/5/12）—— child 404
- `streamipcfapp.akamaized.net/.../key_b1500.m3u8`（台視原住民族）—— HTTP 403
- `h5cul1yar48um3t.wcetv.com/hls/titv.m3u8`（台視原住民族）—— HTTP 404
- `111.59.139.85:11888/tsfile/live/{1217,1220,1222}_1.m3u8`（公視3/SJTV/東亞）—— 連線失敗
- `74.91.26.218:82/live/ctvnews.m3u8` / `ctsnews.m3u8` —— 轉址到已失效的 `142.54.179.26:81`（HTTP 404）
- `iptv-org/iptv` 的 `streams/tw.m3u` —— **已 404**（清單改版），
  正確做法是用 API：`https://iptv-org.github.io/api/channels.json` + `streams.json` 交叉比對
- `58ad68d0b6c8d.streamlock.net/ios/-Ctsnews—0832/playlist.m3u8` —— 連線失敗
- `t.freetv.fun/live/*.m3u8`、`stream1.freetv.fun/*` —— 連線失敗 / HTTP 522
- `live.italkdd.com/cds160/hls/channel00{5,6}/*.m3u8` —— HTTP 404

**部署狀態**：已 commit + push 至 main，Netlify 自動部署。
部署後 curl 驗 `/`、`/channels.json`、`/privacy` 皆 200。


### 輪次 3 — 2026-11-22 19:55 CST（線上真實播放體檢後修正）

**觸發原因**：這一輪不是清單巡檢，而是「用瀏覽器真的點下去播」的體檢。
背景任務 `scripts/test-playback-local.mjs` 對台灣 25 個 HLS 頻道做線上實播，
結果 **24/25 成功**，唯一失敗是 `國會頻道 1 台`；`國會頻道 2 台` 雖回報 ✓ 但帶 `err=3`。

**根因（比「來源失效」更麻煩）**

1. 兩台的來源、代理都正常：
   manifest 200 且 `#EXT-X-MEDIA-SEQUENCE` 持續滾動、分片 `Range 0-2047` 206/0x47、
   完整分片 610,436 bytes、**3247 個 TS 包 0 個同步位元組錯誤**、
   PMT 為標準 `0x1B`（H.264）+ `0x0F`（AAC）。
2. 瀏覽器端卻在緩衝到約 10 秒後拋
   `hls.js 錯誤：type=mediaError details=bufferAppendError fatal=true`
   → 直接判定「媒體解碼錯誤，此串流編碼格式可能不受支援」。
3. 追到代理層：有一次代理對同一個分片只送出 **531,976 bytes**（上游完整 559,488），
   回應是 chunked 沒有 Content-Length → 瀏覽器不會報錯，
   hls.js 把**殘缺分片**送進 SourceBuffer → `bufferAppendError`。
   即「靜默截斷」讓播放器拿到壞資料，比 502 更難察覺。

**修正（三處，全部已上線）**

| 位置 | 修正 |
| --- | --- |
| `web/src/app/api/proxy/[target]/route.ts` | 串流結束時比對「實際送出位元組 vs 上游宣稱長度」，不足則以 `controller.error` 結束串流（讓 hls.js 走 fragment 重試，而不是拿殘缺資料去解碼） |
| `web/src/lib/useHlsPlayer.ts` | `mediaError` 不再一次判死：`bufferAppendError` / 其他媒體錯誤先 `recoverMediaError()` 重試（上限 2 次），失敗才換源；恢復後補一次 `play()`，避免停在「點擊開始播放」 |
| `shared/channels.json` | `國會頻道 1 台` 改用**立法院官方 YouTube 直播**（官網 `parliamentarytv.org.tw` 首頁嵌入的 `x6XVbD7Ln78`，已驗證 `isLiveNow=true`、embed 200），原 HLS 源退為備註 |

**移除**：`國會頻道 2 台`（`61.58.60.230:9319/live/124.m3u8`）
—— HLS 分片偶發殘缺、每分鐘仍會撞 `bufferAppendError`；
官網提供的另一個 YouTube 直播 `TZ4Nf7ZwfTw` **禁止嵌入**（embed 實測 `錯誤 153`），
無法提供穩定的網頁版播放。寧缺勿濫，先下架。頻道數 **96 → 95**。

**驗證**

- `npx tsc --noEmit` 通過、`npm run build` 通過
- 線上實點：`國會頻道 1 台` 顯示立法院議事直播畫面（「正在直播」）
- `curl /channels.json` 確認 95 個頻道、`tw-legislature-1` 為 `embed` 類型

**部署狀態**：commit `6828f61` 之後的手動觸發建置（Netlify 仍未自動觸發，
已用 `POST /api/v1/sites/<id>/builds` 並確認 `state=ready`、`commit_ref` 為本次提交）。



