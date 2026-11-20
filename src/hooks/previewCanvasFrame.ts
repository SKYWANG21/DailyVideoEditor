import type { VideoFrameTransform } from "@/types/videoCompose";
import { fitVideoFrame } from "@/editor/shared/videoFrame";

/** 保持原有默认画质，调低此值只影响预览的运行时像素。 */
const DEFAULT_PREVIEW_MAX_EDGE = 1920;

/** 将外部预览档位约束到当前支持的尺寸范围。 */
export function previewEdge(value?: number): number {
  return value && Number.isFinite(value) && value >= 1 ? Math.min(DEFAULT_PREVIEW_MAX_EDGE, Math.floor(value)) : DEFAULT_PREVIEW_MAX_EDGE;
}

/** 仅缩小预览像素，不改变工程坐标、原素材尺寸或导出配置。 */
export function previewCanvasSize(width: number, height: number, maxEdge?: number): { width: number; height: number } {
  const scale = Math.min(1, previewEdge(maxEdge) / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** 把视频或处理结果按项目坐标绘制，普通画面和转场共享相同变换。 */
export function drawPreviewCanvasFrame(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  frame?: VideoFrameTransform | null,
): void {
  const transform = frame ?? fitVideoFrame(width, height, sourceWidth, sourceHeight);
  const drawWidth = (transform.w * transform.scale) / 100;
  const drawHeight = (transform.h * transform.scale) / 100;
  ctx.save();
  ctx.translate(width / 2 + transform.x, height / 2 + transform.y);
  ctx.rotate((transform.rotate * Math.PI) / 180);
  ctx.drawImage(source, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  ctx.restore();
}
