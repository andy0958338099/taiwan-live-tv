/**
 * 頻道名稱比對 —— 共用模組。
 *
 * ## 為什麼要獨立成模組
 *
 * 實測（2026-11-21）：播放器 failover 到「備援來源 3/7」，
 * 畫面卻是**龍華日韓台**，但 UI 顯示「龍華電視」。
 *
 * 根因：`matchChannel` 用 `clean.includes(key)` 模糊比對，
 * 「龍華電視」因此匹配到「龍華偶像台」「龍華日韓台」等同家族頻道，
 * 它們被當成「龍華電視」的備援來源。
 *
 * 抽成模組是為了能寫**回歸測試**（`scripts/test-channel-matching.mjs`）。
 *
 * ## 兩層防護
 *
 * 1. **名稱層**（本模組）：檔掉明顯是「別的頻道」的名稱
 * 2. **URL 層**（`lib/channel-identity.mjs` + `scripts/fix-wrong-backups.mjs`）：
 *    比對來源站的頻道代碼，這是**權威**判斷
 *
 * 第 2 層才是最終防線 —— 名稱層只是先擋掉明顯錯配，
 * 減少後續要跑網路驗證的數量。
 */

/** 去除清單中的裝飾標記，讓比對更準確 */
export function cleanName(name) {
  return name
    .replace(/[「」\[\]【】（）()\s]/g, '')
    .replace(/Relay|ofiii|直播|备用|備用|備援/g, '');
}

/**
 * 「兄弟頻道標記」—— 尾巴出現這些就代表是**同一品牌的另一個頻道**。
 *
 * 例：關鍵字「龍華」、名稱「龍華日韓台」→ 尾巴含「日韓」→ 另一個頻道。
 *
 * ## 為什麼只放「明確無歧義」的標記
 *
 * 名稱層只是**第一道過濾**，權威判斷在 URL 層（比對來源站頻道代碼）。
 * 所以這裡只放「不管哪個品牌，尾巴出現就一定是別的頻道」的標記。
 *
 * 刻意**不**放的：
 *   · 「台」—— 兩可。「龍華經典台」是兄弟頻道，但「公視台」是同一個頻道。
 *   · 「字幕」「4K」—— 是同頻道的畫質／字幕版本，合法備援。
 *   · 「新聞」「財經」「綜合」「體育」—— **兩可**。
 *     「東森 ETTV」本身就是新聞台（「東森新聞台」指的就是它），
 *     但「華視新聞台」跟「華視 CTS」是兩個頻道。
 *     這類交給 URL 層用頻道代碼判定，名稱層不猜。
 *
 * ## 為什麼「電影」這種明確的可以放
 *
 * 「翡翠台」的兄弟是「華麗翡翠台」（同一台的字幕版，其實是合法備援），
 * 但「好萊塢電影」「龍華電影台」的「電影」是明確的兄弟頻道類型。
 * 即使誤擋，URL 層仍會重新確認，不會造成錯誤上線。
 */
const SIBLING_MARKERS = [
  // 明確的兄弟頻道類型或區域版本
  '經典', '经典', '新加坡', '馬來西亞', '马来西亚', '美國', '美国',
  '亞洲', '亚洲', '日韓', '日韩', '偶像', '戲劇', '剧场', '劇集', '剧集',
  '電影', '电影', '卡通', '動漫', '动漫',
  // 資訊／財經／國際 —— 這些是確定的「另一個台」
  // （「HOY資訊台」「HOY國際財經台」與「HOY TV」是三個不同的台）
  '資訊', '资讯', '国际', '國際', '财经', '財經',
  // 英文
  'movie', 'drama', 'kids', 'anime', 'comedy', 'action', 'series',
  'theatre', 'premiere',
];

/**
 * 判斷「尾巴」是否代表**另一個頻道**。
 *
 * @param {string} tail 關鍵字之後剩下的部分
 * @returns {boolean} true = 是別的頻道
 */
export function isAnotherChannelSuffix(tail) {
  if (!tail) return false;
  const lower = tail.toLowerCase();
  return SIBLING_MARKERS.some((m) => lower.includes(m.toLowerCase()));
}

/**
 * 比對一個 M3U 條目到頻道 map。
 *
 * @param {{name: string, group?: string}} entry M3U 條目
 * @param {object} rules import_rules（含 channel_map、include_group_keywords）
 * @returns {{id: string, name: string} | null}
 */
export function matchChannel(entry, rules) {
  const haystack = `${entry.name} ${entry.group ?? ''}`;
  const inPool = rules.include_group_keywords.some((k) => haystack.includes(k));
  if (!inPool) return null;

  const clean = cleanName(entry.name);
  const map = rules.channel_map;

  /**
   * 關鍵字的優先級 —— 越具體越優先。
   *
   * 1. **完全相符**（exact）——「台視」就是台視
   * 2. **結尾相符**（suffix）——「TVB翡翠台」→ 翡翠台（不是 TVB）
   * 3. **開頭相符**（prefix）——「翡翠台4K字幕」→ 翡翠台
   * 4. **包含**（contains）——「華麗翡翠台新加坡」→ 翡翠台
   *
   * 同層級內長的優先（「翡翠台」勝過「TVB」）。
   *
   * 為什麼結尾優先於開頭：「TVB翡翠台」裡的「TVB」是**品牌前綴**，
   * 「翡翠台」才是**頻道名**。同理「三立台灣台」→ 三立（開頭）。
   */
  const tier = (key) => {
    if (clean === key) return 0;
    if (clean.endsWith(key)) return 1;
    if (clean.startsWith(key)) return 2;
    return 3;
  };

  const keys = Object.keys(map).sort((a, b) => {
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    return b.length - a.length;
  });

  for (const key of keys) {
    if (!clean.includes(key)) continue;

    // ⚠️ **必須檢查「尾巴」**，否則會誤吃同家族的其他頻道。
    //
    // 實測（2026-11-21）：`clean.includes('龍華')` 會讓「龍華電視」
    // 匹配到「龍華偶像台」「龍華日韓台」「龍華戲劇台」「龍華洋片台」
    // 「龍華卡通台」—— 全部被當成「龍華電視」的備援來源。
    //
    // 症狀：播放器 failover 到備援 3/7，畫面卻顯示「龍華日韓台」，
    // 但 UI 的頻道名稱仍是「龍華電視」。使用者看到的是**錯誤的頻道內容**。
    const tail = clean.slice(clean.indexOf(key) + key.length);

    // 尾巴代表另一個頻道 → 繼續找下一個關鍵字
    if (isAnotherChannelSuffix(tail)) continue;

    return { id: key, ...map[key] };
  }

  return null;
}
