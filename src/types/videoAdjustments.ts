/** 片段调色参数。双向参数范围 -100～100，锐化和颗粒范围 0～100，0 为中性值。 */
export interface VideoAdjustments {
  /** 冷暖，正值偏暖。 */
  temperature: number;
  /** 绿与洋红，正值偏洋红。 */
  tint: number;
  /** 饱和度，-100 为灰度。 */
  saturation: number;
  /** 亮度增益。 */
  brightness: number;
  /** 围绕中灰的对比度。 */
  contrast: number;
  /** 亮部提升或压低。 */
  highlights: number;
  /** 暗部提升或压低。 */
  shadows: number;
  /** 邻域锐化强度。 */
  sharpen: number;
  /** 单色胶片颗粒强度。 */
  grain: number;
}

/** 默认参数用于旧工程和一键重置，每次读取产生独立对象。 */
const defaults: Readonly<VideoAdjustments> = {
  temperature: 0,
  tint: 0,
  saturation: 0,
  brightness: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  sharpen: 0,
  grain: 0,
};

/** 兼容旧工程、缺省字段和非法数值，统一 UI、预览与导出的参数尺度。 */
export function readVideoAdjustments(value?: unknown): VideoAdjustments {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const result = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof VideoAdjustments)[]) {
    const raw = source[key];
    const min = key === "sharpen" || key === "grain" ? 0 : -100;
    result[key] = typeof raw === "number" && Number.isFinite(raw) ? Math.max(min, Math.min(100, raw)) : 0;
  }
  return result;
}

/** 中性参数可跳过快照、Worker 和像素读写。 */
export function hasVideoAdjustments(value: VideoAdjustments): boolean {
  return Object.values(value).some((amount) => amount !== 0);
}

/** 实际解码帧身份，用于让颗粒在重绘、定位和导出时可重复。 */
export interface AdjustmentFrame {
  /** 时间轴片段 ID。 */
  clipId: string;
  /** 实际源帧 PTS，微秒。 */
  sourceTimeUs: number;
}
