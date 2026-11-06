/** 一帧 RGBA 及其显示尺寸 */
export interface FrameRgba {
  /** 像素缓冲 */
  buffer: ArrayBuffer;
  /** 宽 */
  width: number;
  /** 高 */
  height: number;
}

/** 每个 Worker 复用同一块离屏画布，只在分辨率变化时调整尺寸 */
let surface: OffscreenCanvas | null = null;
let context: OffscreenCanvasRenderingContext2D | null = null;

/** 从 video 快照读取 RGBA，并保留 GPUPixel 所需的上下翻行 */
export function copyFrameRgba(frame: ImageBitmap): FrameRgba {
  const { width, height } = frame;
  if (width <= 0 || height <= 0) throw new Error("视频帧尺寸无效");
  if (!surface) {
    surface = new OffscreenCanvas(width, height);
    context = surface.getContext("2d", { willReadFrequently: true });
  }
  if (!context) throw new Error("预览像素读取不可用");
  if (surface.width !== width) surface.width = width;
  if (surface.height !== height) surface.height = height;
  context.drawImage(frame, 0, 0);
  const pixels = context.getImageData(0, 0, width, height).data;
  const stride = width * 4;
  const row = new Uint8ClampedArray(stride);
  for (let top = 0, bottom = (height - 1) * stride; top < bottom; top += stride, bottom -= stride) {
    row.set(pixels.subarray(top, top + stride));
    pixels.copyWithin(top, bottom, bottom + stride);
    pixels.set(row, bottom);
  }
  return { buffer: pixels.buffer as ArrayBuffer, width, height };
}

/** 卸载 Worker 时释放离屏像素存储 */
export function releaseFrameRgba(): void {
  if (surface) surface.width = surface.height = 0;
  context = null;
  surface = null;
}
