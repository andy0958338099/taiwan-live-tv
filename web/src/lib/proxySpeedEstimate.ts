/**
 * proxySpeedEstimate.ts — segment 下載速度估算（純函式，可獨立測試）
 *
 * ## 為什麼需要這個模組
 *
 * 代理在送出任何 body 之前，必須判斷「這個 segment 能不能在預算內下載完」。
 * 判斷錯了有兩種後果：
 *
 *   · **誤殺**：健康來源被回 502 → hls.js 換源 → 使用者看到「切台」
 *     而不是「繼續播放」。這是使用者直接感受到的退步。
 *   · **漏殺**：真正太慢的來源被放行 → 平台 30 秒切斷 →
 *     **截斷的 segment 被 CDN 快取 5 分鐘**，壞內容散播給所有使用者。
 *
 * 兩種都不可接受，所以估算必須有實測依據。
 *
 * ## 舊做法的問題（2026-11-21 線上實測）
 *
 * 舊做法是「用第一個 chunk 的速率外推整個 segment」，實測會大量誤殺：
 *
 *   頻道          實際下載   單一 chunk 外推   兩個 chunk 累計
 *   龍華電視         875ms      1,103,488ms ✗      549,924ms ✗
 *   TVB翡翠台      1,396ms      1,792,316ms ✗      893,202ms ✗
 *   Now TV        1,193ms      1,059,192ms ✗      527,849ms ✗
 *
 * 根因有兩個：
 *
 *   1. **上游把 segment 切成極小的 chunk**（實測 1369B / 8192B 一塊），
 *      用單一 chunk 算速率只是抽樣誤差，不是真實頻寬。
 *   2. **TTFB（第一個 chunk 之前的等待）被算進分母** ——
 *      那 200–500ms 沒有任何頻寬被使用，卻讓速率被嚴重低估。
 *
 * 線上實測更直接：`diagnose-502.mjs` 量到 TVB翡翠台被回
 * 「預估 34855ms → 回 502」，但同一個 segment 實際下載只要 1.3 秒。
 *
 * ## 本模組的做法
 *
 *   · 先**累積足夠的位元組**（預設 256KB）再估算 ——
 *     抽樣誤差會隨累積量收斂
 *   · 速率**只算扣掉 TTFB 之後**的那一段
 *   · 剩餘位元組 ÷ 這個速率 = 剩餘時間，再加上 TTFB
 *
 * ## 實測驗證（`scripts/eval-estimator.mjs`）
 *
 *   公式                        誤殺   漏殺   等待中位數
 *   單一 chunk（舊做法）           10      0        0ms
 *   兩個 chunk 累計（舊做法）      10      0      186ms
 *   **本模組（256KB / 800ms）**    **0**      1       53ms
 */

/** 累積到這麼多位元組才估算（256KB：抽樣誤差已收斂，且等待時間夠短） */
export const SAMPLE_MIN_BYTES = 256 * 1024;

/** 量測時間上限（超過就用手上的樣本估算） */
export const SAMPLE_MAX_WAIT_MS = 800;

export interface SpeedEstimateInput {
  /** segment 完整長度（Content-Length）；null = 未知 */
  totalBytes: number | null;
  /** 第一個 chunk 之後收到的位元組數 */
  sampleBytes: number;
  /** 第一個 chunk 之後經過的毫秒數 */
  sampleMs: number;
  /** TTFB：headers 到達 → 第一個 chunk 到達 */
  ttfbMs: number;
}

/**
 * 估算「照目前速度，整個 segment 還要多久下載完」。
 *
 * 回傳 0 代表「無法判斷」→ 呼叫端應放行。
 * 寧可漏殺（最壞是被平台截斷）也不要誤殺
 * —— 誤殺會直接讓使用者看到切台，影響更立即且更明顯。
 */
export function estimateSegmentTransferMs(input: SpeedEstimateInput): number {
  const { totalBytes, sampleBytes, sampleMs, ttfbMs } = input;

  // 沒有完整長度 → 無法外推
  if (totalBytes === null || !Number.isFinite(totalBytes) || totalBytes <= 0) return 0;

  // 樣本不足 → 無法判斷速率
  if (sampleBytes <= 0 || sampleMs <= 0) return 0;

  // 速率（bytes / ms），只取扣掉 TTFB 之後的那一段
  const rate = sampleBytes / sampleMs;
  if (!Number.isFinite(rate) || rate <= 0) return 0;

  const remainingBytes = Math.max(0, totalBytes - sampleBytes);
  const remainingMs = remainingBytes / rate;

  return ttfbMs + remainingMs;
}
