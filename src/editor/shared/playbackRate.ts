/** 变速下限 */
export const PLAYBACK_RATE_MIN = 0.1;
/** 变速上限 */
export const PLAYBACK_RATE_MAX = 2;
/** 变速步进 */
export const PLAYBACK_RATE_STEP = 0.1;

/** 把倍率夹进 0.1–2.0 并按 0.1 取整；非法值回到 1 */
export function clampPlaybackRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  const steps = Math.round(rate / PLAYBACK_RATE_STEP);
  const stepped = steps * PLAYBACK_RATE_STEP;
  const clamped = Math.min(PLAYBACK_RATE_MAX, Math.max(PLAYBACK_RATE_MIN, stepped));
  return Math.round(clamped * 10) / 10;
}

/** 倍率 → 滑轨 0–1 */
export function playbackRateToRatio(rate: number): number {
  const span = PLAYBACK_RATE_MAX - PLAYBACK_RATE_MIN;
  return (clampPlaybackRate(rate) - PLAYBACK_RATE_MIN) / span;
}

/** 滑轨 0–1 → 倍率 */
export function ratioToPlaybackRate(ratio: number): number {
  const clamped = Math.min(1, Math.max(0, ratio));
  return clampPlaybackRate(PLAYBACK_RATE_MIN + clamped * (PLAYBACK_RATE_MAX - PLAYBACK_RATE_MIN));
}
