import type { TransitionAlgorithm, TransitionRenderContext } from "@/types/transition";
import type { TransitionWorkerCommand, TransitionWorkerEvent } from "@/types/transitionWorker";
import TransitionWorker from "../workers/transition.worker.ts?worker&inline";

/** 每个请求独占的响应槽，超时或线程故障时统一释放等待。 */
interface PendingResponse {
  resolve(event: TransitionWorkerEvent): void;
  reject(error: Error): void;
}

/** 同一注册表的内置内核共用线程，各内核拥有独立线性内存与输入版本。 */
export class WasmTransitionWorkerClient {
  private worker: Worker | null = null;
  private sequence = 0;
  private nextKernel = 0;
  private kernels = new Set<number>();
  private pending = new Map<number, PendingResponse>();
  private controller = new AbortController();
  private disposed = false;

  /** 下载模块并交给 Worker 实例化；失败时允许注册表再次加载。 */
  async load(url: string | URL): Promise<TransitionAlgorithm> {
    if (this.disposed) throw new DOMException("转场算法已释放", "AbortError");
    const kernelId = ++this.nextKernel;
    this.kernels.add(kernelId);
    try {
      const response = await fetch(url, { signal: this.controller.signal });
      if (!response.ok) throw new Error(`转场 WASM 加载失败：HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      if (this.disposed) throw new DOMException("转场算法已释放", "AbortError");
      await this.send({ type: "load", kernelId, buffer }, [buffer]);
    } catch (error: unknown) {
      this.release(kernelId);
      throw error;
    }
    const loadedWorker = this.worker;
    let disposed = false;
    return {
      /** 借用调用方画面，只转移自己创建的快照，输出消费后立即关闭。 */
      render: async (context, params): Promise<void> => {
        if (disposed) throw new DOMException("转场算法已释放", "AbortError");
        if (this.worker !== loadedWorker) throw new Error("转场 Worker 已失效，请重新创建注册表");
        const snapshots = await Promise.allSettled([context.outgoing, context.incoming].map(async (source) => createImageBitmap(source)));
        const bitmaps = snapshots.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
        try {
          const failure = snapshots.find((result) => result.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
          if (disposed) throw new DOMException("转场算法已释放", "AbortError");
          await this.render(kernelId, context, params, bitmaps[0], bitmaps[1]);
        } finally {
          for (const bitmap of bitmaps) bitmap.close();
        }
      },
      /** 一个内核释放不影响同注册表的其他算法，最后一个释放后终止线程。 */
      dispose: (): void => {
        if (disposed) return;
        disposed = true;
        this.release(kernelId);
      },
    };
  }

  /** 注册表销毁时立即取消未完成的下载和计算，防止迟到加载重建线程。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    this.kernels.clear();
    this.fail(new DOMException("转场算法已释放", "AbortError"));
  }

  /** 主线程只发送快照与显示完成帧，不读取或遍历 RGBA。 */
  private async render(
    kernelId: number,
    context: TransitionRenderContext,
    params: Readonly<Record<string, unknown>>,
    outgoing: ImageBitmap,
    incoming: ImageBitmap,
  ): Promise<void> {
    const { width, height, progress, inputKeys } = context;
    const event = await this.send({ type: "render", kernelId, outgoing, incoming, width, height, progress, params, inputKeys }, [
      outgoing,
      incoming,
    ]);
    if (event.type !== "frame") throw new Error("转场 Worker 未返回完成帧");
    try {
      context.ctx.drawImage(event.bitmap, 0, 0);
    } finally {
      event.bitmap.close();
    }
  }

  /** 请求序号隔离不同算法、缩略图与播放器的并发结果。 */
  private send(command: TransitionWorkerCommand, transfer: Transferable[]): Promise<TransitionWorkerEvent> {
    return new Promise((resolve, reject) => {
      const requestId = ++this.sequence;
      const timer = globalThis.setTimeout(() => this.fail(new Error("转场 Worker 处理超时（8 秒）")), 8000);
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
        this.ensureWorker().postMessage({ ...command, requestId }, transfer);
      } catch (error: unknown) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("转场 Worker 消息发送失败"));
      }
    });
  }

  /** 首个内核实际加载时才创建线程，Canvas 后端不会创建 Worker。 */
  private ensureWorker(): Worker {
    if (this.disposed) throw new DOMException("转场算法已释放", "AbortError");
    if (this.worker) return this.worker;
    const worker = new TransitionWorker({ name: "video-transitions" });
    worker.onmessage = ({ data }: MessageEvent<TransitionWorkerEvent>): void => {
      const pending = this.pending.get(data.requestId);
      if (!pending) {
        if (data.type === "frame") data.bitmap.close();
        return;
      }
      this.pending.delete(data.requestId);
      if (data.type === "error") pending.reject(new Error(data.message));
      else pending.resolve(data);
    };
    worker.onerror = (event): void => {
      event.preventDefault();
      this.fail(new Error(event.message || "转场 Worker 线程失败"));
    };
    worker.onmessageerror = (): void => this.fail(new Error("转场 Worker 消息读取失败"));
    this.worker = worker;
    return worker;
  }

  /** 取消所有等待；故障后新加载任务可重新建立线程。 */
  private fail(error: Error): void {
    this.worker?.terminate();
    this.worker = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  /** 释放内核缓存，空闲且不再被任何算法持有时关闭线程。 */
  private release(kernelId: number): void {
    if (!this.kernels.delete(kernelId)) return;
    this.worker?.postMessage({ type: "release", kernelId });
    if (!this.kernels.size) this.fail(new DOMException("转场算法已释放", "AbortError"));
  }
}

/** 宿主独立算法使用自己的 Worker；使用后通过算法或注册表的 dispose 释放。 */
export function loadWasmTransitionAlgorithm(url: string | URL): Promise<TransitionAlgorithm> {
  return new WasmTransitionWorkerClient().load(url);
}
