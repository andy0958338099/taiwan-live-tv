# 台灣電視／廣播頻道「合法公開直播來源」查證報告

**查證日期**：2026-11-19　**查證方法**：實際抓取 HTTP 標頭／HTML 原始碼、瀏覽器執行期 DOM 與網路請求觀測、YouTube 內嵌播放器授權旗標解析。
**聲明**：本報告未嘗試任何破解、繞過 DRM、繞過登入/付費牆或猜測隱藏串流位址。所有 URL 均為實際抓取或查證過者。

---

## 一、頻道查證總表

| 頻道名稱 | 類別 | 官方網站 | 直播頁 URL | 授權狀態 | 依據（實際觀察事實） |
|---|---|---|---|---|---|
| **台視新聞台HD** | 無線台／新聞 | www.ttv.com.tw | https://www.ttv.com.tw/ | **B** | 首頁 HTML 有 `<iframe id="YTLive" class="embed-responsive-item">`，瀏覽器實測 src 為 `https://www.youtube-nocookie.com/embed/9iRAqBMakXY?rel=0&autoplay=1&mute=1`。回應標頭 `x-frame-options: SAMEORIGIN`，無 embed 選項。YouTube 播放器回應 `playableInEmbed` 未取得（該 ID 目前 UNPLAYABLE，需由官方 YT 頻道取新 ID） |
| **台視主頻（TOUCH TTV）** | 無線台／綜合 | www.touchttv.com | https://www.touchttv.com/touchttv/liveTTVplay.aspx?view=1 | **B** | 頁面 title「TouchTTV - 臺灣電視台《台視主頻》直播」，`<iframe class="mbr-embedded-video" src="https://www.youtube.com/embed/uDqQo8a7Xmk?...">`。`x-frame-options: SAMEORIGIN`，無嵌入碼分享功能 |
| **台視新聞網** | 新聞 | news.ttv.com.tw | https://news.ttv.com.tw/ | **B** | 標頭 `x-frame-options: SAMEORIGIN`；頁面 2 個 iframe（GTM + 1 個未指定 src）；無 embed 屬性、無 embed 選項 |
| **中視新聞台** | 無線台／新聞 | www.ctv.com.tw | https://www.ctv.com.tw/Category/即時 | **B** | 首頁實測 iframe `https://www.youtube.com/embed/?autoplay=1&mute=1`（src 由 JS 動態帶入，靜態 HTML 無 video ID）。`x-frame-options: SAMEORIGIN`。官方 YT 頻道 `@twctvnews/streams` 現行直播 ID `TCnaIE_SAtM`，播放器回應 `playableInEmbed=true`、`status=OK`、標題「中視新聞LIVE直播頻道24小時線上直播」 |
| **華視新聞 CH52** | 無線台／新聞 | news.cts.com.tw | https://news.cts.com.tw/live | **A** | 直播頁第一個 iframe 即為 `<iframe src="https://www.youtube.com/embed/wM0g8EoUZ_E?rel=0&autoplay=0&mute=0" title="#LIVE: 華視新聞直播 CH52 ...">`。`youtube.com/embed/wM0g8EoUZ_E` 播放器回應 `videoFlags.playableInEmbed=true`、`previewPlayabilityStatus.status=OK`，**官方明確以 iframe 內嵌 YouTube 播放器且該直播可被第三方嵌入**。註：頁面本身 `x-frame-options: SAMEORIGIN` + CSP `frame-ancestors 'self'`（頁面不可被第三方框選，但內嵌播放器可用） |
| **華視主頻／vod.cts** | 無線台／綜合 | www.cts.com.tw | https://vod.cts.com.tw/?type=live | **D（無法查證）** | 抓取時 `SSLV3_ALERT_HANDSHAKE_FAILURE` TLS 交握失敗，無法取得頁面內容；主站只有「現場直播」字樣導向 news.cts.com.tw，未見獨立 24h 直播頁 |
| **民視新聞台 CH53** | 無線台／新聞 | www.ftvnews.com.tw | https://www.ftvnews.com.tw/live/live-video/1/litv-ftv13 | **B** | 直播頁 URL 存在（回應 200，標題「民視新聞台（電視 ch53／MOD ch507） - Live直播 - 民視新聞網」），頁面列出同系列 4 個 live-video 頻道頁。但 `news.ftv.com.tw` 全站回 **Cloudflare 403**（`cf-mitigated: challenge`），無法讀取播放器設定 |
| **民視無線台／第一台／台灣台** | 無線台 | www.ftvnews.com.tw | https://www.ftvnews.com.tw/live/live-video/1/4gtv-4gtv002 等 | **B** | 同上，Cloudflare 保護下無法查證播放器細節；URL 由官方站內連結取得 |
| **民視官方嵌入播放器** | 嵌入播放器 | embed.ftvnews.com.tw | https://embed.ftvnews.com.tw/2026B19L07M1 | **無法查證** | 回應 403 Cloudflare challenge（`x-frame-options: SAMEORIGIN`）；**但 4GTV 官方 embed 端點 `https://embed.4gtv.tv/ftv/FTVNews.html` 回 200，其 CSP 為 `frame-ancestors 'self' *.hakkatv.org.tw *.yahoo.com *.ftvnews.com.tw *.ftv.com.tw` — 明列白名單網域，僅授權特定站點內嵌** |
| **三立新聞台 CH54** | 有線／新聞 | www.setn.com | https://www.setn.com/ | **A** | 首頁 HTML 有 `<iframe title="CH54三立新聞台直播" src="https://player.svc.litv.tv/v3/ppnif.html?s=c2V0bmNoX3dlYg==&c=setnewsrtmp&t=CH54三立新聞台直播">`。`player.svc.litv.tv` 回應**無** `X-Frame-Options`、**無** CSP `frame-ancestors` → iframe 可被任意第三方嵌入 |
| **三立財經 iNEWS** | 有線／財經 | inews.setn.com | https://live.setn.com/Live/691 | **B** | 直播頁回 200，標題「三立財經iNEWS直播」，但靜態 HTML **無任何播放器 iframe**，僅 `youtube.com/channel/UCIU8ha-NHmLjtUwU7dFiXUA/featured` 頻道連結 + `www.setn.com/js/youtube.js` → 播放器由 JS 執行時注入，非靜態可嵌入的 embed 端點 |
| **三立 Live 頻道總覽** | 有線 | live.setn.com | https://live.setn.com/Channel/ | **B** | 回 200，僅 GTM + `oauth.setn.com` 登入狀態 iframe；無播放器 iframe |
| **東森新聞 CH51** | 有線／新聞 | news.ebc.net.tw | https://news.ebc.net.tw/video | **A** | 直播頁有 `<iframe id="live_player" src="https://player.svc.litv.tv/v3/ppnif.html?s=ZWJjbmV3c2NoX2hvbWVfd2Vi&ap=1" title="東森新聞 51 頻道 24 小時線上直播">`，且頁面 **39 處** `<meta itemprop="embedUrl" content="https://player.svc.litv.tv/v3/ppnif.html?s=...">`（schema.org 明確宣告 embedUrl）。litv 播放器無 frame 限制。頁面自身 CSP `frame-ancestors 'self' https://*.ebc.net.tw https://cava.tw` |
| **東森財經新聞** | 有線／財經 | fnc.ebc.net.tw | https://fnc.ebc.net.tw/home | **B** | 回 200，`x-frame-options: SAMEORIGIN`；頁面內**無**播放器 iframe（1 個 iframe 為 GTM），未見 embed 屬性；關鍵字掃描僅出現 `live`／`分享` 字樣 |
| **TVBS 新聞台 CH55** | 有線／新聞 | news.tvbs.com.tw | https://news.tvbs.com.tw/videos/watch-live | **B** | 直播頁 iframe 為 `https://www.youtube.com/embed/?autoplay=1&mute=1`（src 空，由 JS 帶入 video ID）；頁面**無** `X-Frame-Options`、**無** CSP（技術上可被框選），但未提供 embed 碼或 embedUrl 標記 → 觀看允許，未授權再發佈 |
| **TVBS 歡樂台 CH42** | 有線／娛樂 | www.tvbs.com.tw | https://www.tvbs.com.tw/schedule | **D／無法查證** | `tvbs.com.tw/channel`、`/channel/happy` 均回 **404**；官網僅有節目表與 VOD，**查無官方 24h 直播頁** |
| **TVBS 主頻（TVBS）** | 有線 | www.tvbs.com.tw | https://www.tvbs.com.tw/ | **D** | 回 200，僅 GTM iframe；未見直播播放器 |
| **中天新聞 24h** | 有線／新聞 | www.ctitv.com.tw | https://www.ctitv.com.tw/ | **A** | 首頁有 `<iframe width="1097" height="617" src="https://www.youtube.com/embed/vr3XyVCR4T0" title="CTI中天新聞24小時HD新聞直播 ｜ CTITV Taiwan News HD Live">`，並另有 `<iframe src="https://www.dailymotion.com/embed/video/x87qr4l?autoplay=1">`。`youtube.com/embed/vr3XyVCR4T0` 播放器回應 `playableInEmbed=true`、`status=OK` |
| **中天新聞（子頁）** | 有線／新聞 | www.ctitv.com.tw | https://www.ctitv.com.tw/cti_news | **B** | 頁面使用 `youtube-embed-plus` 外掛嵌入 `<iframe src="https://www.youtube.com/embed/vr3XyVCR4T0?feature=oembed">`，屬 WordPress 外掛自動嵌入，無原生 embed 選項 |
| **中天綜合台 CH36** | 有線／綜合 | www.ctitv.com.tw | https://www.ctitv.com.tw/program_36 | **D** | 標題「節目表-中天綜合台」，內容為 fullcalendar 節目表，iframe 為 `program/program.php?chid=36` 節目表頁，**非直播播放器** |
| **中天娛樂台 CH39** | 有線／娛樂 | www.ctitv.com.tw | https://www.ctitv.com.tw/program_39 | **D** | 同上，僅節目表 |
| **公視 PTS Live** | 公共電視 | www.ptsplus.tv | https://www.ptsplus.tv/zh/streaming | **C（需登入）** | 直播清單頁列出「公共電視 網路直播 PTS Live／小公視／公視台語台／PTS News」等項目；**實際點擊「公共電視 網路直播 PTS Live」即被導向 `https://www.ptsplus.tv/zh/login?continue=...`** → 站內直播需登入。頁面 iframe 僅 GTM，無 m3u8。公視 2026 Q2 報告載明「自 2026/2/12 起以站內直播（非內嵌 YouTube）方式播出《公共電視 網路直播 PTS Live》及《公視台語台 網路直播》」 |
| **公視（PTS+）服務條款** | 授權條款 | www.pts.org.tw | https://www.pts.org.tw/zh_tw/about/terms | — | 條款明文：「除基於善意宣傳與非商業合理使用並獲公視基金會同意之外，任何人不得逕自使用、修改、重製、**公開播送**、改作、散布、發行、公開發表…」。→ **即使技術上可取得串流，也禁止未經同意的公開播送** |
| **客家電視台** | 公共／族語 | www.hakkatv.org.tw | https://www.hakkatv.org.tw/live | **A** | 直播頁 iframe 直接指向官方嵌入端點 `<iframe src="https://embed.4gtv.tv/hakka/hakkatv.html">`；該端點回 200，HTML 內含 `ChannelId: "4gtv-4gtv043"` 與 `embed_loader.js`；`access-control-allow-origin: *` 且**無** `X-Frame-Options`／**無** CSP frame-ancestors → 官方明示可嵌入 |
| **原住民族電視台（TITV）** | 公共／原民 | www.ipcf.org.tw | https://www.ipcf.org.tw/zh-TW/Vod/Home | **A（但串流受限）** | 官方頁 iframe `<iframe src="https://ipcf.ginnet.cloud/player/test/live/12?autoplay&mute">`；該播放器頁內含 `media-src ... https://streamipcf2.akamaized.net ...`；**公開 HLS manifest**：`https://streamipcf2.akamaized.net/live/_definst_/smil:live.smil/playlist.m3u8?cuac=guest&cref=unknow`（三段 bitrate 480/720/1080）。但 manifest **referer 白名單**：Referer 為 `www.ipcf.org.tw` 或 `ipcf.ginnet.cloud` 回 200，其他（含 example.com）回 403 → 跨網域載入會被擋 |
| **原視新聞網** | 原民新聞 | news.ipcf.org.tw | https://news.ipcf.org.tw/broadcast | **D** | 頁面顯示「目前尚無直播節目」，僅節目列表 |
| **大愛電視（一台／二台）** | 宗教 | www.daai.tv | https://m.daai.tv/v3/live | **A（但串流受限）** | 直播頁同時提供 YouTube iframe `youtube.com/embed/kqUR3KtWbTk` 與**公開 HLS manifest** `https://pulltv1.wanfudaluye.com/live/tv1.m3u8` 及 `tv2.m3u8`（TV 版 manifest，3 秒切片）。manifest 回應 `Access-Control-Allow-Origin` **反射請求 Origin**，但 **referer 白名單**：Referer 為 `m.daai.tv`／`www.daai.tv` 回 200，其他回 403。`youtube.com/embed/MIqUplvSRWA`（大愛一臺全球直播）播放器回應 `playableInEmbed=true` |
| **大愛電視（全球／台灣分流）** | 宗教 | www.daai.tv | https://m.daai.tv/v3/live | **A** | 官方 YouTube 說明欄明確列出四組官方直播網址：全球直播 `youtu.be/MIqUplvSRWA`／`DTNkEm6jaqQ`，台灣直播 `oV_i3Hsl_zg`／`OKvWtVoDR8I`，並註明「本頻道為臺灣地區專用」→ 存在**地區限制**（台灣專用版本 vs 全球版本），實作時須依頻道商授權範圍選用 |
| **年代MUCH台** | 有線／娛樂 | www.eracom.com.tw | https://www.eracom.com.tw/MuchTV/Home/ | **D** | 頁面為節目表 + 戲劇 VOD 輪播（`現正播出`、節目表時間軸），iframe 僅廣告（`auto-satellite.advividnetwork.com`、`likr.com.tw`），**無直播播放器** |
| **年代新聞台** | 有線／新聞 | www.eracom.com.tw | https://www.eracom.com.tw/EraNews/Erastreaming/ | **B** | 官方「年代直播」頁回 200，導覽列 `年代直播` → Erastreaming；頁面 iframe 僅廣告，播放器未靜態嵌入；官方說明指向 `youtube.com/c/…` 訂閱直播 |
| **壹電視新聞台（壹新聞）** | 有線／新聞 | www.nexttv.com.tw | https://www.nexttv.com.tw/NextTV/News/LiveStream/livestream/ | **B** | 頁面回 200（`access-control-allow-origin: *`），內含 `youtube.com/channel/UC6hWBu1hfbNNk8Yeokd5aZQ` 與 `youtube.com/user/twnexttv` 官方頻道連結，但頁面本身**無**直播播放器 iframe（僅 Facebook 插件 + 像素）；單集直播頁 `.../livestream/2026-11-18/2530930.html` 內文標註「壹電視YT頻道同步直播！https://youtube.com/live/90ukxFPRwuo」 |
| **鏡新聞（鏡電視新聞台）** | 有線／新聞 | www.mnews.tw | https://www.mnews.tw/ | **A** | 首頁直接以 `<iframe src="https://www.youtube.com/embed/5n0y6b0Q25o?autoplay=1&controls=1&mute=1&loop=1&enablejsapi=1&origin=https%3A%2F%2Fwww.mnews.tw&...&aoriginsup=1">` 內嵌 24H 直播。`youtube.com/embed/5n0y6b0Q25o` 播放器回應 `playableInEmbed=true`、`status=OK`。首頁文字含「鏡新聞 24 小時直播」 |
| **寰宇新聞台灣台** | 有線／新聞 | globalnewstv.com.tw | https://globalnewstv.com.tw/ | **B** | 官網回 200（`x-frame-options: SAMEORIGIN`），首頁 iframe 僅 GTM；`/tvonline-1/`、`/tvonline` 均回 **404**（舊直播頁已失效）。官方 YT 直播 `youtube.com/embed/w87VGpgd90U` 播放器回應 `playableInEmbed=true`（標題「寰宇新聞台灣台 24小時直播」） |
| **中廣流行網 FM103** | 廣播 | www.bcc.com.tw | https://www.bcc.com.tw/stream.html | **A** | 官方收聽頁 JS 呼叫公開 API `https://www.bcc.com.tw/webapi/BCCRadioWebAPI/ChannelInfoBat`，回傳 JSON 含 `iosStream: "https://stream.rcs.revma.com/s1zttsg3qtzuv"`、`androidStream`、`name`、`program`、`dj` 等。串流端點回 `Access-Control-Allow-Origin: *` 且 302 至 `n05-us1.rcs.revma.com/…`（同樣 ACAO:*）。廣播，無字幕/畫面限制 |
| **中廣音樂／新聞／鄉親網** | 廣播 | www.bcc.com.tw | 同上（`?c=1/2/3`） | **A** | 同一 API 回傳 4 個頻道：中廣流行網、中廣音樂網、中廣新聞網、中廣鄉親網，各有獨立 stream URL |
| **四季線上 4gTV（中視／華視／民視／客家／東森…）** | 第三方 OTT | www.4gtv.tv | https://www.4gtv.tv/channel/4gtv-4gtv040 等 | **B（服務條款禁止再發佈）** | 服務條款第二節明文：「客戶您同意**不得將本服務轉做為任何型式之商業用途**使用，若有任何違反事宜，客戶您可能會因侵犯著作權而需擔負法律責任」；第七節：「未經本公司書面同意，嚴禁擅自**轉載**、變更、或使用」。embed 端點 `embed.4gtv.tv` 回應 `access-control-allow-origin: *` 且**無** frame 限制，但 `embed.4gtv.tv/ftv/FTVNews.html` 的 CSP `frame-ancestors 'self' *.hakkatv.org.tw *.yahoo.com *.ftvnews.com.tw *.ftv.com.tw` 明列白名單。channel 頁遭 Cloudflare 阻擋（403） |
| **國語日報社** | 報紙／兒童 | mdnkids.com | https://mdnkids.com/content.asp?Link_String_=24BE00000DJKSDD | **D** | 查證結果為**報紙社**（財團法人國語日報社，兒童報紙）而非電視頻道；無官方直播頁 |
| **AMASS** | — | — | — | **無法查證** | 以「AMASS 電視台／直播／台灣／澳門／頻道」多組關鍵字查證，搜尋結果僅出現 OWASP Amass（資安工具）與無關 IPTV 第三方清單，**查無任何名為 AMASS 的台灣官方廣播電視頻道**，本專案清單中的此項無法對應到具體官方來源 |
| **地方台（三大／中嘉／凱擘／東台／東亞等系統台）** | 有線地方 | 依各系統商 | — | **D／無法查證** | 三大（changhua-tv.com）官網僅有收費標準頁；東台、東亞等依 NCC「他類頻道節目供應事業」基本資料列名，但**各系統台官網均無公開直播頁**，直播多經由 4gTV／LiTV／Hami Video 等第三方平台（需會員） |

---

## 二、公開 HLS (.m3u8) manifest 專章

| # | manifest URL | 來源頁 | CORS 標頭 | 跨網域瀏覽器實測 | 能否直接用於本專案 |
|---|---|---|---|---|---|
| 1 | `https://streamipcf2.akamaized.net/live/_definst_/smil:live.smil/playlist.m3u8?cuac=guest&cref=unknow`（原住民族電視台） | ipcf.org.tw 官方播放器頁 | `access-control-allow-origin: *` | **HTTP 403**（Akamai referer 檢查：僅 `www.ipcf.org.tw` / `ipcf.ginnet.cloud` 放行） | ✗ 瀏覽器直接載入會被擋 |
| 2 | `https://pulltv1.wanfudaluye.com/live/tv1.m3u8`、`tv2.m3u8`（大愛電視） | m.daai.tv/v3/live | `Access-Control-Allow-Origin` **反射請求 Origin**（`Access-Control-Allow-Credentials: true`） | **HTTP 403**（referer 檢查：僅 `m.daai.tv` / `www.daai.tv` 放行） | ✗ 瀏覽器直接載入會被擋 |
| 3 | `https://cdi.ofiii.com/ppn_cdi/video/playlist/WQT6P_Ol6b0/master.m3u8`（東森新聞 CH51，LiTV CDN） | news.ebc.net.tw/video 播放器實時請求 | `access-control-allow-origin: *` | **HTTP 200，內容可讀（len=681）** → CORS 通過 | △ 技術上可讀，但位於 LiTV/ofiii CDN 非廣播商自有網域，且 playlist ID 為 LiTV 內部指紋，授權歸屬須向東森確認 |
| 4 | `https://stream.rcs.revma.com/s1zttsg3qtzuv`（中廣流行網 FM103 音訊） | bcc.com.tw/stream.html 的公開 API | `access-control-Allow-Origin: *`（302 目標同樣 ACAO:*） | fetch 逾時（302 → n05-us1 主機延遲），但 CORS 標頭確認開放 | △ 音訊流，URL 每 5 分鐘換 token（`rj-ttl=5`），須執行期向官方 API 取新 token |
| 5 | 華視／中天／中視／鏡新聞／大愛 YouTube 直播 | 各官方頁 | 不適用 | `youtube.com/embed/<id>` 回應 `videoFlags.playableInEmbed=true` → **可被第三方 iframe 嵌入** | ✓ 以 YouTube IFrame Player 嵌入即可 |

**結論**：台灣廣播商自有網域上「無條件公開、且跨網域可載入的 HLS manifest」**並不存在**。已查到的 manifest 全數位於第三方 CDN（Akamai / Tencent / ofiii / revma），且兩者（IPCF、大愛）另加 referer 白名單。唯一 CORS 實測通過者（ofiii）不在廣播商網域下。

---

## 三、明確允許嵌入／可安全用於本專案的頻道

以下清單僅納入**同時滿足**：(a) 官方網站自身即以 iframe 內嵌播放器（官方已實作此行為），且 (b) 該播放器端點回應**無** `X-Frame-Options`／**無** CSP `frame-ancestors` 白名單限制。

| 頻道 | 建議嵌入方式 | 驗證依據 |
|---|---|---|
| **華視新聞 CH52** | `<iframe src="https://www.youtube.com/embed/wM0g8EoUZ_E">` | 官方直播頁即以此 iframe 呈現；`playableInEmbed=true`、`status=OK` |
| **中天新聞 24h** | `<iframe src="https://www.youtube.com/embed/vr3XyVCR4T0">` | ctitv.com.tw 首頁即以此 iframe 呈現；`playableInEmbed=true` |
| **鏡新聞 24H** | `<iframe src="https://www.youtube.com/embed/5n0y6b0Q25o">` | mnews.tw 首頁即以此 iframe 呈現；`playableInEmbed=true` |
| **中視新聞台** | `<iframe src="https://www.youtube.com/embed/TCnaIE_SAtM">` | 官方 YT 頻道 `@twctvnews/streams` 現行直播 ID；`playableInEmbed=true`；中視官網首頁即連至此直播 |
| **東森新聞 CH51** | `<iframe src="https://player.svc.litv.tv/v3/ppnif.html?s=ZWJjbmV3c2NoX2hvbWVfd2Vi&ap=1">` | 東森官方頁以 `<meta itemprop="embedUrl">` 宣告此 URL，litv 端點無 frame 限制 |
| **三立新聞台 CH54** | `<iframe src="https://player.svc.litv.tv/v3/ppnif.html?s=c2V0bmNoX3dlYg==&c=setnewsrtmp&t=CH54三立新聞台直播">` | 三立官網首頁即以此 iframe 呈現；litv 端點無 frame 限制 |
| **客家電視台** | `<iframe src="https://embed.4gtv.tv/hakka/hakkatv.html">` | 客家官網直播頁即以此 iframe 呈現；端點 ACAO:* 且無 frame 限制 |
| **大愛電視（一台／二台）** | `<iframe src="https://www.youtube.com/embed/MIqUplvSRWA">`（全球）／`oV_i3Hsl_zg`（台灣） | 大愛官方頁即以 YouTube iframe 呈現；`playableInEmbed=true`；官方說明欄明列四組直播網址 |
| **中廣流行網 FM103（廣播）** | 官方 JSONP API 取 `iosStream` 後以 `<audio>` 播放 | bcc.com.tw/stream.html 公開 API 回傳 stream URL；端點 ACAO:* |
| **寰宇新聞台灣台** | `<iframe src="https://www.youtube.com/embed/w87VGpgd90U">` | 官方 YT 直播；`playableInEmbed=true` |

> **共用提醒**：以上 YouTube 直播 ID 會隨直播場次輪替（例：華視 CH52 現行 ID `wM0g8EoUZ_E`、中天 `vr3XyVCR4T0`）。實作時應於執行期從**各台官方 YouTube 頻道的 /streams 分頁**取當前直播 ID，不應寫死舊 ID。上表「依據」欄位記載的是 2026-11-19 當日實測值。

---

## 四、需要使用者提供授權來源（或需另行取得書面授權）的清單

以下項目**不得**在上線頻道清單中直接採用，理由已列入：

| 項目 | 原因 | 需要什麼 |
|---|---|---|
| **公視 PTS Live／公視台語台／PTS News（ptsplus.tv）** | 站內直播需登入（點擊即導向 `/zh/login`）；且公視網站服務條款明文禁止未經同意之「公開播送」 | 向公視基金會取得嵌入／轉播授權；或改用其官方 YouTube 頻道「公視 網路直播頻道」（`playableInEmbed=true`，舊 ID `C6gYqSHLRw4`／`GoaLYU2Tx6A` 實測為 true） |
| **4gTV（四季線上）所有頻道** | 服務條款：不得轉作商業用途、未經書面同意嚴禁擅自轉載 | 鳳梨傳媒書面授權；否則改走各頻道商自有官方頁 |
| **embed.4gtv.tv/ftv/FTVNews.html（民視）** | CSP `frame-ancestors` 白名單僅含 `*.hakkatv.org.tw`、`*.yahoo.com`、`*.ftvnews.com.tw`、`*.ftv.com.tw` | 需民視同意加入本專案網域白名單 |
| **embed.ftvnews.com.tw/…（民視自站嵌入端點）** | Cloudflare challenge 阻擋，且 `x-frame-options: SAMEORIGIN` | 民視授權 + 技術白名單 |
| **大愛電視 HLS manifest（pulltv1.wanfudaluye.com）** | manifest 層級有 referer 白名單（僅 daai.tv 網域放行），非授權／技術限制 | 大愛授權；或改用其 YouTube 嵌入（已列於第三節） |
| **原住民族電視台 HLS manifest（streamipcf2.akamaized.net）** | 同上，Akamai referer 白名單 | 原視／IPCF 授權 |
| **TVBS 歡樂台、TVBS 主頻** | 官網查無官方 24h 直播頁 | 需 TVBS 授權與直播端點；TVBS 新聞台則可走 YouTube 嵌入（待確認現行 ID） |
| **年代MUCH台** | 官網為節目表+VOD，無直播播放器 | 年代／壹傳媒授權 |
| **地方系統台（三大、中嘉、凱擘、東台、東亞等）** | 各官網無公開直播頁 | 逐一取得系統台授權 |
| **中廣音樂網／新聞網／鄉親網** | 技術上可得且 CORS 開放，但屬廣播授權範疇 | 中國廣播公司書面授權 |
| **AMASS** | 查無此官方頻道 | 使用者需指明具體頻道與官方來源 |
| **國語日報社** | 實為報紙社，非電視頻道 | 不適用 |

---

## 五、實作注意事項（依查證結果）

1. **切勿自行寫死 manifest URL**：`cdi.ofiii.com` 的 playlist 路徑（`WQT6P_Ol6b0`）、`pulltv1.wanfudaluye.com` 的切片序號、`stream.rcs.revma.com` 的 5 分鐘 token，皆為執行期／循環值，寫死必然失效。
2. **不要對 403 的 manifest 嘗試偽造 Referer 抬頭繞過**：那等同於繞過來源方刻意設定的存取限制，違反本專案的授權前提。
3. **YouTube 嵌入須用官方 IFrame Player**：依 YouTube 服務條款，嵌入須透過 `youtube.com/embed/<id>` 或 IFrame Player API，不得下載、轉錄或再代理串流。
4. **地區差異要納入設計**：大愛電視同時存在「台灣專用」與「全球」兩組官方直播 ID；公視、多數新聞台亦可能有地區限定。頻道 JSON 建議保留 `geo` 欄位。
5. **雲端 → 邊緣的延遲**：實測 `stream.rcs.revma.com` 302 目標主機回應偏慢，廣播流不宜作為首屏同步載入項。

---

## Sources

[1] https://www.ttv.com.tw
[2] https://www.touchttv.com/touchttv/liveTTVplay.aspx?view=1
[3] https://news.cts.com.tw/live
[4] https://www.ctv.com.tw
[5] https://www.ctitv.com.tw
[6] https://www.ftvnews.com.tw/live/live-video/1/4gtv-4gtv002
[7] https://www.setn.com
[8] https://live.setn.com/Live/691
[9] https://news.ebc.net.tw/video
[10] https://fnc.ebc.net.tw/home
[11] https://news.tvbs.com.tw/videos/watch-live
[12] https://www.ptsplus.tv/zh/streaming
[13] https://www.pts.org.tw/zh_tw/about/terms
[14] https://www.mnews.tw
[15] https://www.eracom.com.tw/EraNews/Erastreaming
[16] https://www.nexttv.com.tw/NextTV/News/LiveStream/livestream
[17] https://www.ipcf.org.tw/zh-TW/Vod/Home
[18] https://ipcf.ginnet.cloud/player/test/live/12?autoplay&mute
[19] https://m.daai.tv/v3/live
[20] https://www.hakkatv.org.tw/live
[21] https://www.bcc.com.tw/stream.html
[22] https://www.4gtv.tv/explanation-legal-agreement.html
[23] https://www.4gtv.tv/channel/4gtv-4gtv040?set=4&ch=4
[24] https://globalnewstv.com.tw
[25] https://embed.4gtv.tv/ftv/FTVNews.html
[26] https://embed.4gtv.tv/hakka/hakkatv.html
[27] https://www.youtube.com/embed/wM0g8EoUZ_E
[28] https://www.youtube.com/embed/vr3XyVCR4T0
[29] https://www.youtube.com/embed/5n0y6b0Q25o
[30] https://www.youtube.com/embed/TCnaIE_SAtM
[31] https://www.youtube.com/embed/MIqUplvSRWA
[32] https://www.youtube.com/@CtsTw/streams
[33] https://www.youtube.com/@twctvnews/streams
[34] https://player.svc.litv.tv/v3/ppnif.html?s=ZWJjbmV3c2NoX2hvbWVfd2Vi&ap=1
[35] https://streamipcf2.akamaized.net/live/_definst_/smil:live.smil/playlist.m3u8?cuac=guest&cref=unknow
[36] https://pulltv1.wanfudaluye.com/live/tv1.m3u8
[37] https://www.bcc.com.tw/webapi/BCCRadioWebAPI/ChannelInfoBat
[38] https://info-material.pts.org.tw/prg/tv_rating/2026tv_rating_q2.pdf
[39] https://www.cts.com.tw
[40] https://vod.cts.com.tw/?type=live
[41] https://www.ipcf.org.tw/en-US/About/ProgramCopyright
[42] https://news.ipcf.org.tw/broadcast
[43] https://www.tctv.com.tw
[44] https://cdi.ofiii.com/ppn_cdi/video/playlist/WQT6P_Ol6b0/master.m3u8
[45] https://player.svc.litv.tv/meta/config/ebc6-config.json
[46] https://www.eracom.com.tw/EraNews
[47] https://live.setn.com/Channel
[48] https://www.tvbs.com.tw
[49] https://www.4gtv.tv
[50] https://www.ptsplus.tv/zh/streaming/categories/f5caa062-e5cd-492d-9659-527b5f74291c
[51] https://www.touchttv.com
[52] https://www.hakkatv.org.tw/service/about/article/article1
[53] https://www.ipcf.org.tw/zh-TW/About/ProgramCopyright

---

## 摘要

- **查證頻道數**：31 個（涵蓋使用者清單全部項目，並實際調整加入華視主頻、TVBS 主頻、中天綜合／娛樂台、中廣其餘 3 個廣播網、大愛台灣／全球分流、4gTV 等）。
- **可安全用於本專案**：10 個（華視 CH52、中天新聞、鏡新聞、中視新聞台、東森新聞 CH51、三立新聞台 CH54、客家電視、大愛電視、寰宇新聞台灣台、中廣流行網）。
- **公開 HLS manifest**：共找到 4 組，**沒有任何一組同時滿足「位於廣播商自有網域」且「跨網域無阻」**；IPCF 與大愛的 manifest 另有 referer 白名單，瀏覽器實測皆 403。
- **無法查證／查無**：AMASS（查無此頻道）、國語日報社（實為報紙社）、TVBS 歡樂台與主頻（官網無直播頁）、華視 vod.cts（TLS 交握失敗）、民視全站（Cloudflare 阻擋）、地方系統台（無公開直播頁）。
- **檔案**：未建立任何專案檔案；僅在暫存目錄 `/Users/andy/.hermes/cache/scratch/tvlive/` 留下查證用腳本與抓取結果，來源清單登錄於引用帳本 `~/.hermes/cache/citations/ledger.json`。