import type { TransitionRenderRequest } from "@/types/transition";
import { TransitionRegistry } from "./registry";

/** 统一缓动；具体算法不再重复解释时间曲线。 */
export function transitionEasing(progress: number, curve: unknown): number {
  const p = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  if (curve === "ease") return p * p * (3 - 2 * p);
  if (curve === "ease-in") return p * p;
  if (curve === "ease-out") return p * (2 - p);
  if (curve === "ease-in-out") return p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
  return p;
}

/** 仅驱动算法和输出；解码、clip 变换和播放时钟由调用方负责。 */
export class TransitionEngine {
  private canvas: OffscreenCanvas | null = null;
  private scratch = new Map<"outgoing" | "incoming", OffscreenCanvas>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly registry: TransitionRegistry) {}

  /** 串行使用实例缓冲；返回的画布应立即消费，跨帧保存请使用 renderBitmap。 */
  render(request: TransitionRenderRequest): Promise<OffscreenCanvas> {
    const result = this.queue.then(() => this.draw(request));
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** 在队列内取得独立快照，避免后续任务覆盖输出。 */
  renderBitmap(request: TransitionRenderRequest): Promise<ImageBitmap> {
    const result = this.queue.then(async () => createImageBitmap(await this.draw(request)));
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** 原生输入等比适配；已经在项目坐标绘制的输入直接复用。 */
  private fit(source: CanvasImageSource, slot: "outgoing" | "incoming", width: number, height: number): CanvasImageSource {
    const dimensions = source as { width?: number; height?: number; videoWidth?: number; videoHeight?: number };
    const sourceWidth = dimensions.videoWidth ?? dimensions.width ?? width;
    const sourceHeight = dimensions.videoHeight ?? dimensions.height ?? height;
    if (sourceWidth === width && sourceHeight === height) return source;
    if (sourceWidth <= 0 || sourceHeight <= 0) throw new Error("转场输入没有有效像素");
    let scratch = this.scratch.get(slot);
    if (!scratch || scratch.width !== width || scratch.height !== height) {
      scratch = new OffscreenCanvas(width, height);
      this.scratch.set(slot, scratch);
    }
    const ctx = scratch.getContext("2d");
    if (!ctx) throw new Error("转场输入画布不可用");
    const ratio = Math.min(width / sourceWidth, height / sourceHeight);
    const w = sourceWidth * ratio;
    const h = sourceHeight * ratio;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(source, (width - w) / 2, (height - h) / 2, w, h);
    return scratch;
  }

  /** 调用可替换的算法，finally 隔离异常留下的绘制状态。 */
  private async draw(request: TransitionRenderRequest): Promise<OffscreenCanvas> {
    const definition = this.registry.get(request.effectId);
    if (!definition) throw new Error(`暂不支持转场：${request.effectId}`);
    const algorithm = await this.registry.resolve(request.effectId);
    if (!this.canvas) this.canvas = new OffscreenCanvas(request.width, request.height);
    if (this.canvas.width !== request.width) this.canvas.width = request.width;
    if (this.canvas.height !== request.height) this.canvas.height = request.height;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("当前环境不支持转场画布");
    const params = definition.normalizeParams({ ...definition.defaultParams, ...request.params });
    ctx.clearRect(0, 0, request.width, request.height);
    ctx.save();
    try {
      await algorithm.render(
        {
          ...request,
          ctx,
          outgoing: this.fit(request.outgoing, "outgoing", request.width, request.height),
          incoming: this.fit(request.incoming, "incoming", request.width, request.height),
          progress: transitionEasing(request.progress, params.curve),
        },
        params,
      );
    } finally {
      ctx.restore();
    }
    return this.canvas;
  }
}
