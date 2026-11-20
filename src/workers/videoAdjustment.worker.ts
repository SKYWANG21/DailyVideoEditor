import type {
  AdjustmentRequestIdentity,
  AdjustmentWorkerRequest,
  AdjustmentWorkerResponse,
  GradeWorkerMessage,
} from "@/types/videoAdjustmentWorker";
import { VideoAdjustmentEngine } from "@/utils/videoAdjustmentEngine";
import { WebGLGradeRenderer } from "./gpuGradePrototype";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<AdjustmentWorkerRequest | { type: "dispose" }>) => void) | null;
  close(): void;
  postMessage(message: GradeWorkerMessage, transfer?: Transferable[]): void;
};
const engine = new VideoAdjustmentEngine();
let canvas: OffscreenCanvas | null = null;
let gpu: WebGLGradeRenderer | null = null;
let gpuFailure: string | undefined;

/** 使用同一输入完成 CPU 调色，供指定 CPU 和 GPU 故障时共用。 */
function renderCpu(
  bitmap: ImageBitmap,
  adjustments: AdjustmentWorkerRequest["adjustments"],
  identity: AdjustmentRequestIdentity,
): ImageBitmap {
  if (!canvas || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  }
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("调色画布不可用");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  engine.apply(ctx, adjustments, identity);
  return canvas.transferToImageBitmap();
}

/** 串行处理片段快照，计算结束即转移独立输出；输入在所有退出路径关闭。 */
scope.onmessage = ({ data }): void => {
  if ("type" in data) {
    gpu?.dispose();
    scope.close();
    return;
  }
  const { bitmap, adjustments, cpuOnly, ...identity } = data;
  let output: ImageBitmap | null = null;
  try {
    if (!cpuOnly && !gpuFailure) {
      if (!gpu) {
        try {
          gpu = new WebGLGradeRenderer((event) => scope.postMessage({ type: "context", event }));
        } catch (error: unknown) {
          gpuFailure = error instanceof Error ? error.message : "WebGL2 初始化失败";
          scope.postMessage({ type: "context", event: "createFailed" });
        }
      }
      output = gpu?.render(bitmap, adjustments, identity.clipId, identity.sourceTimeUs) ?? null;
    }
    const backendUsed = output ? "gpu" : "cpu";
    output ??= renderCpu(bitmap, adjustments, identity);
    const response: AdjustmentWorkerResponse = { type: "frame", ...identity, bitmap: output, backendUsed };
    if (!cpuOnly && backendUsed === "cpu") response.fallbackReason = gpuFailure || gpu?.fallbackReason;
    scope.postMessage(response, [output]);
    output = null;
  } catch (error: unknown) {
    scope.postMessage({ type: "error", ...identity, message: error instanceof Error ? error.message : "调色处理失败" });
  } finally {
    output?.close();
    bitmap.close();
  }
};
