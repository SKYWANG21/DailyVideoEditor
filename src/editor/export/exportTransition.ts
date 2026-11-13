import type { TransitionAlgorithm } from "@/types/transition";
import type { TransitionWorkerCommand, TransitionWorkerEvent } from "@/types/transitionWorker";
import { TransitionWorkerRuntime } from "@/workers/transitionRuntime";

/** 用原有转场内核直接在当前导出 Worker 内执行。 */
export async function loadExportWasmTransition(url: URL, signal: AbortSignal): Promise<TransitionAlgorithm> {
  let resolveEvent: ((event: TransitionWorkerEvent) => void) | undefined;
  const runtime = new TransitionWorkerRuntime((event) => resolveEvent?.(event));
  /** 单个效果的调用由导出器顺序等待。 */
  function request(command: Exclude<TransitionWorkerCommand, { type: "release" }>): Promise<TransitionWorkerEvent> {
    return new Promise((resolve, reject) => {
      resolveEvent = (event) => {
        resolveEvent = undefined;
        if (event.type === "error") reject(new Error(event.message));
        else resolve(event);
      };
      runtime.accept({ ...command, requestId: 0 });
    });
  }
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`转场 WASM 加载失败（HTTP ${response.status}）`);
  await request({ type: "load", kernelId: 0, buffer: await response.arrayBuffer() });
  return {
    /** 两个输入沿用原 WASM 内核，返回结果直接合成到目标画布。 */
    async render(context, params): Promise<void> {
      signal.throwIfAborted();
      const outgoing = await createImageBitmap(context.outgoing);
      let incoming: ImageBitmap;
      try {
        incoming = await createImageBitmap(context.incoming);
      } catch (error: unknown) {
        outgoing.close();
        throw error;
      }
      const event = await request({
        type: "render",
        kernelId: 0,
        outgoing,
        incoming,
        width: context.width,
        height: context.height,
        progress: context.progress,
        params,
        inputKeys: context.inputKeys,
      });
      if (event.type !== "frame") throw new Error("转场没有返回画面");
      try {
        context.ctx.drawImage(event.bitmap, 0, 0);
      } finally {
        event.bitmap.close();
      }
    },
    /** 清除 WASM 内核持有的线性内存。 */
    dispose(): void {
      runtime.accept({ type: "release", kernelId: 0 });
    },
  };
}
