/** 可调下限（dB）。再低用静音表示增益 0 */
export const VOLUME_DB_MIN = -60;

/** 可调上限（dB）。0 dB 为原声，正值放大 */
export const VOLUME_DB_MAX = 12;

/** 滑块吸附步进（dB） */
export const VOLUME_DB_SLIDER_STEP = 1;

/** 数字框步进（dB） */
export const VOLUME_DB_INPUT_STEP = 0.1;

/** +12 dB 对应的线性增益。与后端 ComposeAudioGain.MAX 同一公式 */
export const VOLUME_GAIN_MAX = 10 ** (VOLUME_DB_MAX / 20);

/** 滑块最右一档的索引：静音为 0，-60 dB 为 1，+12 dB 为该值 */
const SLIDER_INDEX_MAX = VOLUME_DB_MAX - VOLUME_DB_MIN + 1;

/**
 * 线性增益 → 展示分贝。
 * 增益 ≤ 0 或非有限值为静音（null）。结果按 0.1 dB 四舍五入并夹在可调范围内。
 */
export function gainToDb(gain: number | null | undefined): number | null {
  if (gain == null || !Number.isFinite(gain) || gain <= 0) return null;
  return clampDb(roundDb(20 * Math.log10(gain), VOLUME_DB_INPUT_STEP));
}

/** 分贝 → 线性增益。null 为静音（0） */
export function dbToGain(db: number | null): number {
  if (db == null || !Number.isFinite(db)) return 0;
  return 10 ** (clampDb(db) / 20);
}

/** 把分贝夹进 [VOLUME_DB_MIN, VOLUME_DB_MAX] */
export function clampDb(db: number): number {
  if (!Number.isFinite(db)) return VOLUME_DB_MIN;
  return Math.min(VOLUME_DB_MAX, Math.max(VOLUME_DB_MIN, db));
}

/**
 * 按步进四舍五入分贝。
 * 负数半数远离 0，避免 Math.round 把 -1.95 收到 -1.9。
 */
export function roundDb(db: number, step: number): number {
  if (!Number.isFinite(db) || !(step > 0)) return db;
  const factor = Math.round(1 / step);
  const scaled = db * factor;
  const rounded = scaled >= 0 ? Math.round(scaled) : -Math.round(-scaled);
  const decimals = step >= 1 ? 0 : 1;
  return Number((rounded / factor).toFixed(decimals));
}

/** 线性增益夹到 [0, VOLUME_GAIN_MAX] */
export function clampGain(gain: number): number {
  if (!Number.isFinite(gain) || gain <= 0) return 0;
  return Math.min(VOLUME_GAIN_MAX, gain);
}

/**
 * 滑块位置 0～1。
 * null（静音）在最左；非整数分贝停在相邻两档之间，不吸附。
 */
export function dbToSliderRatio(db: number | null): number {
  if (db == null || !Number.isFinite(db)) return 0;
  const index = 1 + (clampDb(db) - VOLUME_DB_MIN);
  return index / SLIDER_INDEX_MAX;
}

/**
 * 指针在轨道上的位置 → 滑块值。
 * 最左一整档为静音，其余按 1 dB 吸附，右端为 +12 dB。
 * @param ratio 0～1，相对轨道左边缘
 */
export function sliderRatioToDb(ratio: number): number | null {
  const clamped = Math.min(1, Math.max(0, ratio));
  const raw = clamped * SLIDER_INDEX_MAX;
  if (raw < 1) return null;
  const index = Math.round(raw);
  return VOLUME_DB_MIN + (index - 1);
}
