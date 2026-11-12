/** 宿主从编辑器取到的预览画面快照。 */
export interface ComposeFrameCapture {
  /** 合成后可下载或上传的 PNG。 */
  blob: Blob;
  /** 底层视频帧实际绘制时的时间（秒）。 */
  timeSec: number;
  /** PNG 像素宽度。 */
  width: number;
  /** PNG 像素高度。 */
  height: number;
  /** 工程时间或素材本地时间。 */
  source: "timeline" | "catalog";
}

/** 已绘制的画布及该帧的时间，画布替换后即失效。 */
export interface PresentedComposeFrame {
  canvas: HTMLCanvasElement;
  timeSec: number;
  source: ComposeFrameCapture["source"];
}

/** 一次截图借给 Worker 的独立位图。 */
export interface FrameCaptureWorkerRequest {
  frame: ImageBitmap;
  overlay: ImageBitmap | null;
}

/** Worker 完成编码或报告错误。 */
export type FrameCaptureWorkerResponse = { blob: Blob } | { error: { name: string; message: string } };
