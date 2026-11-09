import type { BeautyParams } from "@/types/composeMedia";
import {
  beautyNeedsFace,
  type BeautyFrameEvent,
  type BeautyWorkerEvent,
  type BeautyWorkerRequest,
  type PreviewFrameIdentity,
} from "@/types/beautyPreview";
import type { GpuPixelPreview } from "@/utils/beauty/gpuPixelPreview";
import BeautyPreviewWorker from "../workers/beautyPreview.worker.ts?worker&inline";
import { capturePreviewBitmap, VIDEO_FRAME_TIMEOUT_MS } from "./previewVideoFrame";

/** Worker 消息的响应槽，不允许把不同请求结果互换。 */
interface PendingResponse {
  /** 校验并完成当前请求。 */
  resolve(event: BeautyWorkerEvent): void;
  /** 超时、卸载或 Worker 错误。 */
  reject(error: Error): void;
}

/** 单播放器的美颜处理器；普通帧与转场两侧共享实现、串行使用 GPU 缓冲。 */
export class ComposeFrameProcessor {
  private worker: Worker | null = null;
  private gpu: GpuPixelPreview | null = null;
  private loading: Promise<void> | null = null;
  private faceReady = false;
  private sequence = 0;
  private disposed = false;
  private failed = false;
  private pending = new Map<number, PendingResponse>();
  private output: OffscreenCanvas | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly algorithmBase: string,
    private readonly warning: (message: string, fallback?: boolean) => void,
  ) {}

  /** 失败后由明确的参数变更允许重试。 */
  resetFailure(): void {
    this.failed = false;
  }

  /** 仅启用美颜时创建资源；人脸模型按两侧需求提前预热。 */
  async warmup(levels: readonly BeautyParams[]): Promise<boolean> {
    if (this.failed || this.disposed || !levels.some((item) => item.enabled)) return false;
    try {
      if (!this.loading) {
        this.loading = import("@/utils/beauty/gpuPixelPreview")
          .then(async ({ acquireGpuPixelPreview }) => {
            if (this.disposed) return;
            this.gpu = acquireGpuPixelPreview(this.canvas);
            await this.gpu.init();
          })
          .catch((error: unknown) => {
            this.loading = null;
            throw error;
          });
      }
      await this.loading;
      if (this.disposed) return false;
      if (!this.faceReady && levels.some(beautyNeedsFace)) {
        const event = await this.send({ type: "init", requestId: ++this.sequence, detectFace: true, algorithmBaseUrl: this.algorithmBase });
        if (event.type === "ready" && event.warning) this.warning(event.warning);
        this.faceReady = true;
      }
      return !this.disposed;
    } catch (error: unknown) {
      if (this.disposed) return false;
      this.failed = true;
      this.warning(`美颜已回退普通预览：${error instanceof Error ? error.message : "算法初始化失败"}`, true);
      return false;
    }
  }

  /** 美颜输出立即复制到独立画布，处理 B 时不会覆盖 A。 */
  async process(
    source: ImageBitmap,
    beauty: BeautyParams,
    identity: PreviewFrameIdentity,
    signal: AbortSignal,
  ): Promise<CanvasImageSource> {
    if (!beauty.enabled || !(await this.warmup([beauty]))) return source;
    signal.throwIfAborted();
    const bitmap = await capturePreviewBitmap(source, signal);
    if (signal.aborted) {
      bitmap.close();
      signal.throwIfAborted();
    }
    try {
      const requestId = ++this.sequence;
      const event = await this.send({ type: "render", ...identity, requestId, bitmap, detectFace: beautyNeedsFace(beauty) }, [bitmap]);
      signal.throwIfAborted();
      if (event.type !== "frame" || !this.gpu) throw new Error("美颜返回了无效画面");
      if (event.generation !== identity.generation || event.clipId !== identity.clipId || event.sourceTimeUs !== identity.sourceTimeUs) {
        throw new Error("美颜画面标识不匹配");
      }
      const frame: BeautyFrameEvent = event;
      this.gpu.draw(
        new Uint8Array(frame.buffer),
        frame.width,
        frame.height,
        frame.warning ? { ...beauty, slim: 0, eye: 0 } : beauty,
        frame.landmarks,
      );
      if (!this.output || this.output.width !== frame.width || this.output.height !== frame.height)
        this.output = new OffscreenCanvas(frame.width, frame.height);
      const result = this.output;
      const context = result.getContext("2d");
      if (!context) throw new Error("美颜输出画布不可用");
      context.clearRect(0, 0, frame.width, frame.height);
      context.drawImage(this.canvas, 0, 0);
      if (frame.warning) this.warning(frame.warning);
      return result;
    } catch (error: unknown) {
      if (signal.aborted || this.disposed) throw error;
      this.failed = true;
      this.warning(`美颜已回退普通预览：${error instanceof Error ? error.message : "处理失败"}`, true);
      return source;
    }
  }

  /** 等待实际 Worker 完成后才释放处理槽；取消只使结果失效。 */
  private send(message: Exclude<BeautyWorkerRequest, { type: "dispose" }>, transfer: Transferable[] = []): Promise<BeautyWorkerEvent> {
    return new Promise((resolve, reject) => {
      const requestId = message.requestId;
      const timer = window.setTimeout(() => this.failWorker(new Error("美颜处理超时（8 秒）")), VIDEO_FRAME_TIMEOUT_MS);
      this.pending.set(requestId, {
        resolve: (event): void => {
          clearTimeout(timer);
          resolve(event);
        },
        reject: (error): void => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.ensureWorker().postMessage(message, transfer);
      } catch (error: unknown) {
        if (message.type === "render") message.bitmap.close();
        this.failWorker(error instanceof Error ? error : new Error("美颜消息发送失败"));
      }
    });
  }

  /** 普通预览不创建线程，处理器实例之间不共享请求槽。 */
  private ensureWorker(): Worker {
    if (this.disposed) throw new DOMException("播放器已卸载", "AbortError");
    if (this.worker) return this.worker;
    const worker = new BeautyPreviewWorker();
    worker.onmessage = ({ data }: MessageEvent<BeautyWorkerEvent>): void => {
      const pending = this.pending.get(data.requestId);
      if (!pending) return;
      this.pending.delete(data.requestId);
      if (data.type === "error") pending.reject(new Error(data.message));
      else pending.resolve(data);
    };
    worker.onerror = (): void => this.failWorker(new Error("美颜预览线程失败"));
    this.worker = worker;
    return worker;
  }

  /** 错误会释放所有等待，不能让播放一直卡在处理状态。 */
  private failWorker(error: Error): void {
    this.worker?.terminate();
    this.worker = null;
    this.faceReady = false;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  /** 关闭线程、模型等待和 GPU，不允许迟到任务重建资源。 */
  dispose(): void {
    this.disposed = true;
    this.failWorker(new DOMException("播放器已卸载", "AbortError"));
    this.gpu?.destroy();
    this.gpu = null;
    this.output = null;
  }
}
