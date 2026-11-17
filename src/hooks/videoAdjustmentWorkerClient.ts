import AdjustmentWorker from "../workers/videoAdjustment.worker.ts?worker&inline";
import type { AdjustmentFrame, VideoAdjustments } from "@/types/videoAdjustments";
import type { AdjustmentWorkerRequest, AdjustmentWorkerResponse } from "@/types/videoAdjustmentWorker";

/** 在途帧结算回调，集中释放定时器与取消监听。 */
interface PendingAdjustment {
  resolve(message: AdjustmentWorkerResponse): void;
  reject(error: Error): void;
}

/** 一个播放器独占的调色线程，取消代次时终止旧计算并按需重建。 */
export class VideoAdjustmentWorkerClient {
  private worker: Worker | null = null;
  private pending = new Map<number, PendingAdjustment>();
  private sequence = 0;
  private disposed = false;

  /** 复制片段画布后转移快照，原画布和解码帧仍归调用者所有。 */
  async render(
    canvas: OffscreenCanvas,
    adjustments: VideoAdjustments,
    frame: AdjustmentFrame,
    generation: number,
    signal: AbortSignal,
  ): Promise<ImageBitmap> {
    signal.throwIfAborted();
    if (this.disposed) throw new DOMException("调色预览已卸载", "AbortError");
    const bitmap = await createImageBitmap(canvas);
    try {
      signal.throwIfAborted();
      if (this.disposed) throw new DOMException("调色预览已卸载", "AbortError");
      const worker = this.ensureWorker();
      const requestId = ++this.sequence;
      const request: AdjustmentWorkerRequest = { ...frame, generation, requestId, bitmap, adjustments };
      return await this.send(worker, request, signal);
    } finally {
      bitmap.close();
    }
  }

  /** 验证请求身份后交付输出，错误或取消会拒绝等待者。 */
  private send(worker: Worker, request: AdjustmentWorkerRequest, signal: AbortSignal): Promise<ImageBitmap> {
    return new Promise((resolve, reject) => {
      const abort = (): void => this.reset();
      const timer = setTimeout(() => this.fail(new Error("调色预览处理超时")), 15000);
      const cleanup = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.pending.delete(request.requestId);
      };
      this.pending.set(request.requestId, {
        resolve: (message): void => {
          cleanup();
          if (message.type === "error") return reject(new Error(message.message));
          if (
            signal.aborted ||
            message.generation !== request.generation ||
            message.clipId !== request.clipId ||
            message.sourceTimeUs !== request.sourceTimeUs
          ) {
            message.bitmap.close();
            reject(new DOMException("调色帧已过期", "AbortError"));
          } else resolve(message.bitmap);
        },
        reject: (error): void => {
          cleanup();
          reject(error);
        },
      });
      signal.addEventListener("abort", abort, { once: true });
      try {
        worker.postMessage(request, [request.bitmap]);
      } catch (error: unknown) {
        this.fail(error instanceof Error ? error : new Error("调色帧传输失败"));
      }
    });
  }

  /** 按需建立线程，中性参数不会创建 Worker。 */
  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new AdjustmentWorker();
    worker.onmessage = ({ data }: MessageEvent<AdjustmentWorkerResponse>): void => {
      const pending = this.pending.get(data.requestId);
      if (pending) pending.resolve(data);
      else if (data.type === "frame") data.bitmap.close();
    };
    worker.onerror = (): void => {
      if (this.worker === worker) this.fail(new Error("调色预览线程运行失败"));
    };
    worker.onmessageerror = (): void => {
      if (this.worker === worker) this.fail(new Error("调色预览消息读取失败"));
    };
    this.worker = worker;
    return worker;
  }

  /** 终止线程并结算全部在途请求，避免取消后仍占用计算资源。 */
  private fail(error: Error): void {
    this.worker?.terminate();
    this.worker = null;
    for (const pending of [...this.pending.values()]) pending.reject(error);
  }

  /** 定位或修改参数时只丢弃在途计算，空闲线程可继续复用。 */
  reset(): void {
    if (this.pending.size) this.fail(new DOMException("调色预览已取消", "AbortError"));
  }

  /** 播放器卸载时释放线程与等待者。 */
  dispose(): void {
    this.disposed = true;
    this.fail(new DOMException("调色预览已卸载", "AbortError"));
  }
}
