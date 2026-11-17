import { hasVideoAdjustments, type AdjustmentFrame, type VideoAdjustments } from "@/types/videoAdjustments";

/** 限制归一化色值，避免后续亮度权重超出范围。 */
function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** 平滑分配亮部与暗部权重。 */
function smooth(value: number): number {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
}

/** 七项颜色和明暗运算融合为一次遍历，保留原始 Alpha。 */
function adjustColors(data: Uint8ClampedArray, params: VideoAdjustments): void {
  const warm = params.temperature / 100;
  const tint = params.tint / 100;
  const gain = 1 + params.brightness / 100;
  const contrast = 1 + params.contrast / 100;
  const saturation = 1 + params.saturation / 100;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    let r = ((data[i] / 255 + warm * 0.2 + tint * 0.1) * gain - 0.5) * contrast + 0.5;
    let g = ((data[i + 1] / 255 - tint * 0.2) * gain - 0.5) * contrast + 0.5;
    let b = ((data[i + 2] / 255 - warm * 0.2 + tint * 0.1) * gain - 0.5) * contrast + 0.5;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = luma + (r - luma) * saturation;
    g = luma + (g - luma) * saturation;
    b = luma + (b - luma) * saturation;
    const adjustment = (params.shadows * (1 - smooth(luma * 2)) + params.highlights * smooth((luma - 0.5) * 2)) * 0.003;
    data[i] = clamp(r + adjustment) * 255;
    data[i + 1] = clamp(g + adjustment) * 255;
    data[i + 2] = clamp(b + adjustment) * 255;
  }
}

/** 以 Alpha 加权四邻域差值，避免透明区域在旋转和缩放边缘产生黑边。 */
function sharpenPixels(data: Uint8ClampedArray, source: Uint8ClampedArray, width: number, height: number, amount: number): void {
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * 4;
      if (source[i + 3] === 0) continue;
      const left = i - 4;
      const right = i + 4;
      const top = i - width * 4;
      const bottom = i + width * 4;
      const leftWeight = Math.min(source[i + 3], source[left + 3]) / 255;
      const rightWeight = Math.min(source[i + 3], source[right + 3]) / 255;
      const topWeight = Math.min(source[i + 3], source[top + 3]) / 255;
      const bottomWeight = Math.min(source[i + 3], source[bottom + 3]) / 255;
      for (let channel = 0; channel < 3; channel++) {
        const center = source[i + channel];
        const detail =
          (center - source[left + channel]) * leftWeight +
          (center - source[right + channel]) * rightWeight +
          (center - source[top + channel]) * topWeight +
          (center - source[bottom + channel]) * bottomWeight;
        data[i + channel] = center + detail * amount;
      }
    }
  }
}

/** 基于片段与源 PTS 固定随机种子，停帧重绘不会闪烁。 */
function addGrain(data: Uint8ClampedArray, amount: number, frame: AdjustmentFrame): void {
  let seed = 2166136261;
  const identity = `${frame.clipId}:${frame.sourceTimeUs}`;
  for (let i = 0; i < identity.length; i++) seed = Math.imul(seed ^ identity.charCodeAt(i), 16777619);
  for (let i = 0; i < data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    if (data[i + 3] === 0) continue;
    const noise = (seed / 4294967296 - 0.5) * amount * 0.5;
    data[i] += noise;
    data[i + 1] += noise;
    data[i + 2] += noise;
  }
}

/** 每个渲染会话独占实例，预览 Worker 和导出 Worker 共用同一算法。 */
export class VideoAdjustmentEngine {
  private scratch = new Uint8ClampedArray(0);

  /** 在独立片段画布上读取一次 RGBA、处理并写回一次。 */
  apply(ctx: OffscreenCanvasRenderingContext2D, params: VideoAdjustments, frame: AdjustmentFrame): void {
    if (!hasVideoAdjustments(params)) return;
    const image = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
    this.applyPixels(image, params, frame);
    ctx.putImageData(image, 0, 0);
  }

  /** 原地处理非预乘 RGBA8，供 Canvas 入口和像素回归测试共用。 */
  applyPixels(image: Pick<ImageData, "data" | "width" | "height">, params: VideoAdjustments, frame: AdjustmentFrame): void {
    if (!hasVideoAdjustments(params)) return;
    adjustColors(image.data, params);
    if (params.sharpen > 0) {
      if (this.scratch.length !== image.data.length) this.scratch = new Uint8ClampedArray(image.data.length);
      this.scratch.set(image.data);
      sharpenPixels(image.data, this.scratch, image.width, image.height, params.sharpen / 100);
    }
    if (params.grain > 0) addGrain(image.data, params.grain, frame);
  }
}
