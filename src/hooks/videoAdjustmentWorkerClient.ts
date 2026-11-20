import AdjustmentWorker from "../workers/videoAdjustment.worker.ts?worker&inline";
import type { AdjustmentFrame, VideoAdjustments } from "@/types/videoAdjustments";
import type { AdjustmentWorkerRequest, AdjustmentWorkerResponse, GradeWorkerMessage } from "@/types/videoAdjustmentWorker";
import { type GradeBenchmark, readGradeBenchmarkMode } from "./gradeBenchmark";

/** 取消调用方的等待与释放物理计算槽分开，旧帧完成后才能发送下一帧。 */
interface GradeJob {
  start(worker: Worker): void;
  reply(message: AdjustmentWorkerResponse): void;
  cancel(error: Error): void;
}

/** 一个播放器共用一个调色线程，过期结果只清理，不重建 WebGL。 */
export class VideoAdjustmentWorkerClient {
  private worker: Worker | null = null;
  private active: GradeJob | null = null;
  private readonly jobs = new Map<number, GradeJob>();
  private sequence = 0;
  private revision = 0;
  private disposed = false;
  private timeout?: ReturnType<typeof setTimeout>;
  private gpuDisabled = "";
  private readonly mode = readGradeBenchmarkMode();
  private recentLosses: number[] = [];

  /** 基准模式和运行指标都属于当前播放器。 */
  constructor(private readonly stats?: GradeBenchmark) {}

  /** 复制独立输入，取消时不改变原图层或解码帧的所有权。 */
  async render(
    canvas: OffscreenCanvas,
    adjustments: VideoAdjustments,
    frame: AdjustmentFrame,
    generation: number,
    signal: AbortSignal,
  ): Promise<ImageBitmap> {
    signal.throwIfAborted();
    if (this.disposed) throw new DOMException("调色预览已卸载", "AbortError");
    const revision = this.revision;
    const start = this.stats ? performance.now() : 0;
    const cpuOnly = this.mode === "cpu" || !!this.gpuDisabled;
    const bitmap = await createImageBitmap(canvas, cpuOnly ? undefined : { premultiplyAlpha: "none" });
    try {
      signal.throwIfAborted();
      if (revision !== this.revision) throw new DOMException("快照已过期", "AbortError");
      const request = { ...frame, generation, requestId: ++this.sequence, bitmap, adjustments, cpuOnly };
      return await this.send(request, signal, start);
    } finally {
      bitmap.close();
    }
  }

  /** 已发送的旧帧保留在计算槽中；排队中已取消的请求立即移除。 */
  private send(request: AdjustmentWorkerRequest, signal: AbortSignal, start: number): Promise<ImageBitmap> {
    const { requestId, bitmap } = request;
    const { width, height } = bitmap;
    return new Promise((resolve, reject) => {
      let cancelled = false;
      const abort = (): void => job.cancel(new DOMException("调色帧已过期", "AbortError"));
      const job: GradeJob = {
        start: (worker): void => worker.postMessage(request, [bitmap]),
        cancel: (error): void => {
          cancelled = true;
          signal.removeEventListener("abort", abort);
          if (this.active !== job) this.jobs.delete(requestId);
          reject(error);
        },
        reply: (message): void => {
          signal.removeEventListener("abort", abort);
          if (message.type === "error") return reject(new Error(message.message));
          const stale =
            cancelled ||
            signal.aborted ||
            message.generation !== request.generation ||
            message.clipId !== request.clipId ||
            message.sourceTimeUs !== request.sourceTimeUs;
          this.stats?.frame(
            message.backendUsed,
            message.fallbackReason || (request.cpuOnly ? this.gpuDisabled : undefined),
            start,
            width,
            height,
            stale,
          );
          if (stale) {
            message.bitmap.close();
            reject(new DOMException("调色帧已过期", "AbortError"));
          } else resolve(message.bitmap);
        },
      };
      this.jobs.set(requestId, job);
      signal.addEventListener("abort", abort, { once: true });
      this.dispatch();
    });
  }

  /** 只有上一条物理请求已回复才启动下一条及其看门狗。 */
  private dispatch(): void {
    if (this.active || !this.jobs.size) return;
    this.active = this.jobs.values().next().value!;
    try {
      const worker = this.ensureWorker();
      this.timeout = setTimeout(() => this.stop("timeout", new Error("调色预览处理超时")), 15000);
      this.active.start(worker);
    } catch (error: unknown) {
      this.stop("sendError", error instanceof Error ? error : new Error("调色帧传输失败"));
    }
  }

  /** 仅初始化一次，真实上下文故障与过期回复分别处理。 */
  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new AdjustmentWorker();
    this.worker = worker;
    if (this.stats) this.stats.workersCreated++;
    worker.onmessage = ({ data }: MessageEvent<GradeWorkerMessage>): void => {
      if (this.worker !== worker) {
        if (data.type === "frame") data.bitmap.close();
        return;
      }
      if (data.type === "context") {
        this.stats?.context(data.event);
        if (data.event === "lost") {
          const now = performance.now();
          this.recentLosses = this.recentLosses.filter((time) => now - time < 10000);
          this.recentLosses.push(now);
          if (this.recentLosses.length >= 3) this.gpuDisabled = "WebGL2 在十秒内连续丢失三次";
        }
        return;
      }
      const job = this.jobs.get(data.requestId);
      if (!job || job !== this.active) {
        if (data.type === "frame") data.bitmap.close();
        return;
      }
      clearTimeout(this.timeout);
      this.jobs.delete(data.requestId);
      this.active = null;
      job.reply(data);
      this.dispatch();
    };
    worker.onerror = (): void => {
      if (this.worker === worker) this.stop("workerError", new Error("调色预览线程运行失败"));
    };
    worker.onmessageerror = (): void => {
      if (this.worker === worker) this.stop("messageError", new Error("调色预览消息读取失败"));
    };
    return worker;
  }

  /** 故障和卸载才结束线程，空闲时由 Worker 先释放 GL 对象再退出。 */
  private stop(reason: string, error: Error): void {
    clearTimeout(this.timeout);
    if (this.worker) {
      if (this.stats) this.stats.terminations[reason] = (this.stats.terminations[reason] ?? 0) + 1;
      if (reason === "dispose" && !this.active) this.worker.postMessage({ type: "dispose" });
      else this.worker.terminate();
    }
    this.worker = null;
    this.active = null;
    for (const job of this.jobs.values()) job.cancel(error);
  }

  /** 定位时取消等待和排队任务，已提交的 GL 工作自然结束。 */
  reset(): void {
    this.revision++;
    for (const job of this.jobs.values()) job.cancel(new DOMException("调色预览已取消", "AbortError"));
  }

  /** 卸载期间迟到的快照和回复都不会再交给播放器。 */
  dispose(): void {
    this.disposed = true;
    this.revision++;
    this.stop("dispose", new DOMException("调色预览已卸载", "AbortError"));
  }
}
