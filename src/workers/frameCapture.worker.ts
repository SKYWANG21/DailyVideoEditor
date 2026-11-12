import type { FrameCaptureWorkerRequest, FrameCaptureWorkerResponse } from "@/types/frameCapture";

/** 截图使用独立画布和线程，不占用预览或转场的输出缓冲。 */
async function compose({ frame, overlay }: FrameCaptureWorkerRequest): Promise<Blob> {
  try {
    const canvas = new OffscreenCanvas(frame.width, frame.height);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("截图画布不可用");
    context.fillStyle = "#000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(frame, 0, 0);
    if (overlay) context.drawImage(overlay, 0, 0, canvas.width, canvas.height);
    return canvas.convertToBlob({ type: "image/png" });
  } finally {
    frame.close();
    overlay?.close();
  }
}

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<FrameCaptureWorkerRequest>) => void) | null;
  postMessage(response: FrameCaptureWorkerResponse): void;
};

/** 回传 Blob 或可由宿主识别的浏览器错误。 */
worker.onmessage = ({ data }): void => {
  void compose(data).then(
    (blob) => worker.postMessage({ blob }),
    (error: unknown) =>
      worker.postMessage({
        error: error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) },
      }),
  );
};
