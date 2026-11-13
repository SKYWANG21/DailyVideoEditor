import { beautyNeedsFace } from "@/types/beautyPreview";
import type { BeautyParams } from "@/types/composeMedia";
import { GpuPixelPreview, locateGpuPixelFile } from "@/utils/beauty/gpuPixelPreview";
import { copyFrameRgba, releaseFrameRgba } from "@/workers/beauty/copyFrameRgba";
import { FacePass } from "@/workers/beauty/facePass";
import { installImportScripts } from "@/workers/beauty/installImportScripts";
import { createWorkerGpuPixel } from "virtual:compose-worker-gpupixel";

/** 在导出 Worker 内复用预览的 GPUPixel 与 MediaPipe 算法。 */
export class ExportBeauty {
  private readonly canvas = new OffscreenCanvas(1, 1);
  private readonly processor = new GpuPixelPreview(this.canvas, async () => ({
    module: await createWorkerGpuPixel(this.canvas, { locateFile: locateGpuPixelFile }),
    selector: "#compose-export-beauty",
  }));
  private readonly faces = new Map<string, FacePass>();

  constructor(private readonly root: string) {}

  /** 仅在工程需要美颜时加载 WASM。 */
  prepare(): Promise<void> {
    return this.processor.init();
  }

  /** 同步消费 GPU 美颜画布，转场两侧各自保留人脸跟踪历史。 */
  async apply(source: ImageBitmap, beauty: BeautyParams, clipId: string, timeUs: number, signal: AbortSignal): Promise<ImageBitmap> {
    let landmarks = new Float32Array(0);
    if (beautyNeedsFace(beauty)) {
      let face = this.faces.get(clipId);
      if (!face) {
        installImportScripts();
        face = new FacePass();
        this.faces.set(clipId, face);
        await face.init(new URL("mediapipe/", this.root).href, new URL("face_landmarker.task", this.root).href);
      }
      landmarks = new Float32Array(await face.detect(source, timeUs, timeUs / 1000));
    }
    signal.throwIfAborted();
    const rgba = copyFrameRgba(source);
    this.processor.draw(new Uint8Array(rgba.buffer), rgba.width, rgba.height, beauty, landmarks);
    return createImageBitmap(this.canvas);
  }

  /** 释放已离开时间轴范围的跟踪模型。 */
  release(clipId: string): void {
    this.faces.get(clipId)?.close();
    this.faces.delete(clipId);
  }

  /** 释放任务的 WebGL 与全部 MediaPipe 状态。 */
  dispose(): void {
    for (const face of this.faces.values()) face.close();
    this.faces.clear();
    this.processor.destroy();
    releaseFrameRgba();
  }
}
