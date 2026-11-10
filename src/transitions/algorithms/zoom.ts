import type { TransitionAlgorithm, TransitionRenderContext } from "@/types/transition";
import { renderCrossfade } from "./crossfade";

/** 自有的径向蒙版、镜像清晰层与放射模糊层，不保留调用方输入。 */
type ZoomBuffers = Record<"mask" | "sharp" | "soft", OffscreenCanvasRenderingContext2D>;

/** 同一输出画布复用缓冲；弱键允许编辑器销毁后释放，多个引擎互不覆盖。 */
const zoomBuffers = new WeakMap<OffscreenCanvas, ZoomBuffers>();

/** 创建或调整当前输出的离屏层，每帧重置自有状态并清除旧像素。 */
function getZoomBuffers(target: OffscreenCanvas, width: number, height: number): ZoomBuffers {
  let buffers = zoomBuffers.get(target);
  if (!buffers) {
    /** 创建仅供当前输出画布使用的绘制层。 */
    const createLayer = (): OffscreenCanvasRenderingContext2D => {
      const ctx = new OffscreenCanvas(width, height).getContext("2d");
      if (!ctx) throw new Error("变焦转场离屏画布不可用");
      return ctx;
    };
    buffers = { mask: createLayer(), sharp: createLayer(), soft: createLayer() };
    zoomBuffers.set(target, buffers);
  }
  for (const ctx of Object.values(buffers)) {
    if (ctx.canvas.width !== width) ctx.canvas.width = width;
    if (ctx.canvas.height !== height) ctx.canvas.height = height;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    ctx.clearRect(0, 0, width, height);
  }
  return buffers;
}

/** 四边与四角交替翻转完整画面，缩放下限为半倍，九宫格足以覆盖输出。 */
function mirrorZoomFrame(
  ctx: OffscreenCanvasRenderingContext2D,
  source: CanvasImageSource,
  width: number,
  height: number,
  scale: number,
): void {
  const tileWidth = width * scale;
  const tileHeight = height * scale;
  const x = (width - tileWidth) / 2;
  const y = (height - tileHeight) / 2;
  // 加法拼接相邻子像素覆盖率，避免镜像接缝变暗或透明度增厚。
  ctx.globalCompositeOperation = "lighter";
  ctx.save();
  try {
    for (let row = -1; row <= 1; row += 1) {
      for (let column = -1; column <= 1; column += 1) {
        const flipX = column === 0 ? 1 : -1;
        const flipY = row === 0 ? 1 : -1;
        ctx.setTransform(
          flipX,
          0,
          0,
          flipY,
          x + column * tileWidth + (flipX < 0 ? tileWidth : 0),
          y + row * tileHeight + (flipY < 0 ? tileHeight : 0),
        );
        ctx.drawImage(source, 0, 0, tileWidth, tileHeight);
      }
    }
  } finally {
    ctx.restore();
  }
}

/** 对镜像全画幅做多次向外缩放采样，仅在外围混入放射模糊，中心保持清晰。 */
function softenZoomFrame(context: TransitionRenderContext, source: CanvasImageSource, scale: number): OffscreenCanvas {
  const { ctx, width, height, progress } = context;
  const { mask, sharp, soft } = getZoomBuffers(ctx.canvas, width, height);
  const strength = 0.04 * Math.sin(Math.PI * progress);
  mirrorZoomFrame(sharp, source, width, height, scale);
  // 所有采样均向外扩张，覆盖整个输出，避免模糊采到画布外的透明像素。
  soft.globalCompositeOperation = "lighter";
  soft.globalAlpha = 1 / 8;
  for (let index = 0; index < 8; index += 1) {
    const sampleScale = 1 + (strength * index) / 7;
    soft.drawImage(
      sharp.canvas,
      (width * (1 - sampleScale)) / 2,
      (height * (1 - sampleScale)) / 2,
      width * sampleScale,
      height * sampleScale,
    );
  }
  mask.save();
  try {
    mask.scale(width / 2, height / 2);
    mask.translate(1, 1);
    const gradient = mask.createRadialGradient(0, 0, 0.65 * scale, 0, 0, 1.15 * scale);
    gradient.addColorStop(0, "rgba(255,255,255,0)");
    gradient.addColorStop(1, "#fff");
    mask.fillStyle = gradient;
    mask.fillRect(-1, -1, 2, 2);
  } finally {
    mask.restore();
  }
  // 蒙版仅控制模糊强度，不裁切画面；两层按相同权重替换，保留透明度。
  soft.globalAlpha = 1;
  soft.globalCompositeOperation = "destination-in";
  soft.drawImage(mask.canvas, 0, 0);
  sharp.globalCompositeOperation = "destination-out";
  sharp.drawImage(mask.canvas, 0, 0);
  soft.globalCompositeOperation = "lighter";
  soft.drawImage(sharp.canvas, 0, 0);
  return soft.canvas;
}

/** 双帧变焦后按全画幅权重叠化，镜像缩小帧不再产生局部矩形融合边界。 */
function renderZoom(context: TransitionRenderContext, outgoingScale: number, incomingScale: number): void {
  const { ctx, outgoing, incoming, width, height, progress } = context;
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.filter = "none";
  if (progress <= 0 || progress >= 1) {
    ctx.drawImage(progress <= 0 ? outgoing : incoming, 0, 0, width, height);
    return;
  }
  const incomingIsSmaller = incomingScale < outgoingScale;
  const foreground = incomingIsSmaller ? incoming : outgoing;
  const foregroundScale = incomingIsSmaller ? incomingScale : outgoingScale;
  const frame = softenZoomFrame(context, foreground, foregroundScale);
  renderCrossfade(
    { ...context, outgoing: incomingIsSmaller ? outgoing : frame, incoming: incomingIsSmaller ? frame : incoming },
    incomingIsSmaller ? outgoingScale : 1,
    incomingIsSmaller ? 1 : incomingScale,
  );
}

/** 推进：A 从原比例放大到两倍，B 同时从半倍放大至原比例。 */
export const zoomInAlgorithm: TransitionAlgorithm = {
  render(context): void {
    renderZoom(context, 1 + context.progress, (1 + context.progress) / 2);
  },
};

/** 拉远：A 从原比例缩小到半倍，B 同时从两倍缩小至原比例。 */
export const zoomOutAlgorithm: TransitionAlgorithm = {
  render(context): void {
    renderZoom(context, 1 - context.progress / 2, 2 - context.progress);
  },
};
