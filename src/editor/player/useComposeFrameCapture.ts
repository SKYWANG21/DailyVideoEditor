import { nextTick, onScopeDispose } from "vue";
import type {
  ComposeFrameCapture,
  FrameCaptureWorkerRequest,
  FrameCaptureWorkerResponse,
  PresentedComposeFrame,
} from "@/types/frameCapture";
import FrameCaptureWorker from "@/workers/frameCapture.worker.ts?worker&inline";
import { rasterizeFrameOverlay } from "./frameCaptureOverlay";

/** 一次截图从取样到编码的最长等待时间。 */
const CAPTURE_TIMEOUT_MS = 15_000;

/** 线程独占本次截图的位图，结束或取消后立即释放。 */
function encodeInWorker(frame: ImageBitmap, overlay: ImageBitmap | null, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  const worker = new FrameCaptureWorker({ name: "video-frame-capture" });
  let onAbort: () => void;
  return new Promise<Blob>((resolve, reject) => {
    onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = ({ data }: MessageEvent<FrameCaptureWorkerResponse>): void => {
      if ("error" in data) reject(new DOMException(data.error.message, data.error.name));
      else resolve(data.blob);
    };
    worker.onerror = (event: ErrorEvent): void => {
      event.preventDefault();
      reject(new Error(event.message || "截图 Worker 启动或执行失败"));
    };
    worker.onmessageerror = (): void => reject(new Error("截图 Worker 响应读取失败"));
    const message: FrameCaptureWorkerRequest = { frame, overlay };
    try {
      worker.postMessage(message, overlay ? [frame, overlay] : [frame]);
    } catch (error: unknown) {
      if (!overlay && error instanceof DOMException && error.name === "DataCloneError") {
        reject(new DOMException("当前视频底图无法传输，请检查视频源的跨域配置", error.name));
      } else {
        reject(error);
      }
    }
  }).finally((): void => {
    signal.removeEventListener("abort", onAbort);
    worker.terminate();
  });
}

/** 同时冻结画布和覆盖层，任一侧失败也释放已生成的位图。 */
async function capture(frame: PresentedComposeFrame, stage: HTMLElement, signal: AbortSignal): Promise<ComposeFrameCapture> {
  const { canvas, timeSec, source } = frame;
  const { width, height } = canvas;
  const [base, overlay] = await Promise.allSettled([createImageBitmap(canvas), rasterizeFrameOverlay(stage, width, height, signal)]);
  try {
    signal.throwIfAborted();
    if (base.status === "rejected") throw base.reason;
    if (overlay.status === "rejected") throw overlay.reason;
    const blob = await encodeInWorker(base.value, overlay.value, signal);
    return { blob, width, height, timeSec, source };
  } finally {
    if (base.status === "fulfilled") base.value.close();
    if (overlay.status === "fulfilled") overlay.value?.close();
  }
}

/** 每个播放器从快照前到 Worker 清理完毕仅允许一张截图。 */
export function useComposeFrameCapture(
  getFrame: () => PresentedComposeFrame | null,
  getStage: () => HTMLElement | null,
): () => Promise<ComposeFrameCapture | null> {
  let active: AbortController | null = null;
  onScopeDispose(() => active?.abort());

  /** 等待本轮字幕和花字更新后，截取屏幕上已提交的画面。 */
  return async function captureCurrentFrame(): Promise<ComposeFrameCapture | null> {
    if (active) throw new DOMException("上一张截图仍在处理中", "InvalidStateError");
    const controller = new AbortController();
    active = controller;
    const timer = globalThis.setTimeout(() => controller.abort(new DOMException("截图处理超时", "TimeoutError")), CAPTURE_TIMEOUT_MS);
    try {
      await nextTick();
      controller.signal.throwIfAborted();
      const frame = getFrame();
      const stage = getStage();
      if (!frame?.canvas.width || !frame.canvas.height || !stage?.contains(frame.canvas)) return null;
      return await capture(frame, stage, controller.signal);
    } finally {
      clearTimeout(timer);
      controller.abort();
      active = null;
    }
  };
}
