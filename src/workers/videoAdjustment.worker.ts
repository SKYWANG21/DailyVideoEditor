import type { AdjustmentWorkerRequest, AdjustmentWorkerResponse } from "@/types/videoAdjustmentWorker";
import { VideoAdjustmentEngine } from "@/utils/videoAdjustmentEngine";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<AdjustmentWorkerRequest>) => void) | null;
  postMessage(message: AdjustmentWorkerResponse, transfer?: Transferable[]): void;
};
const engine = new VideoAdjustmentEngine();
let canvas: OffscreenCanvas | null = null;

/** 串行处理片段快照，计算结束即转移独立输出；输入在所有退出路径关闭。 */
scope.onmessage = ({ data }): void => {
  const { bitmap, adjustments, ...identity } = data;
  let output: ImageBitmap | null = null;
  try {
    if (!canvas || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    }
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("调色画布不可用");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    engine.apply(ctx, adjustments, identity);
    output = canvas.transferToImageBitmap();
    scope.postMessage({ type: "frame", ...identity, bitmap: output }, [output]);
    output = null;
  } catch (error: unknown) {
    scope.postMessage({ type: "error", ...identity, message: error instanceof Error ? error.message : "调色处理失败" });
  } finally {
    output?.close();
    bitmap.close();
  }
};
