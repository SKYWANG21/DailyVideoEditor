import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from "@mediapipe/tasks-vision";

/** 检测输入长边。人脸关键点不需要全分辨率 */
const DETECT_MAX_EDGE = 384;

/** 播放中复用关键点的间隔（毫秒） */
const DETECT_INTERVAL_MS = 100;

/** 至少要能读到 MediaPipe 下标 454 */
const MIN_POINTS = 455;

/**
 * MediaPipe Face Landmarker。CPU + SIMD wasm，跑在 Worker 里。
 */
export class FacePass {
  private landmarker: FaceLandmarker | null = null;
  private createOptions: { wasmBaseUrl: string; modelUrl: string } | null = null;
  private lastTimestamp = -1;
  private lastDetectAt = 0;
  private lastLandmarks: Float32Array<ArrayBufferLike> = new Float32Array(0);

  /**
   * 加载模型。失败时调用方继续出画，只是没有关键点。
   */
  async init(wasmBaseUrl: string, modelUrl: string): Promise<void> {
    this.createOptions = { wasmBaseUrl, modelUrl };
    await this.createLandmarker();
  }

  /** 释放检测器 */
  close(): void {
    this.landmarker?.close();
    this.landmarker = null;
  }

  /**
   * 检测一帧。时间回退时重建检测器，正向播放大约每 100ms 检测一次。
   * @param frame 当前视频帧，不会被关闭
   * @param sourceTimeUs 源时间（微秒），用作 VIDEO 模式时间戳
   */
  async detect(frame: VideoFrame, sourceTimeUs: number): Promise<Float32Array<ArrayBufferLike>> {
    if (!this.landmarker) return this.lastLandmarks;
    let timestamp = Math.max(0, Math.round(sourceTimeUs / 1000));
    let forceDetect = false;
    if (timestamp + 50 < this.lastTimestamp) {
      await this.createLandmarker();
      this.lastTimestamp = -1;
      forceDetect = true;
    }
    if (timestamp <= this.lastTimestamp) timestamp = this.lastTimestamp + 1;
    const now = performance.now();
    if (!forceDetect && this.lastLandmarks.length > 0 && now - this.lastDetectAt < DETECT_INTERVAL_MS) {
      this.lastTimestamp = timestamp;
      return this.lastLandmarks;
    }
    const bitmap = await this.downscale(frame);
    try {
      const result = this.landmarker.detectForVideo(bitmap, timestamp);
      this.lastTimestamp = timestamp;
      this.lastDetectAt = now;
      this.lastLandmarks = flattenLandmarks(result);
      return this.lastLandmarks;
    } finally {
      bitmap.close();
    }
  }

  /** 按当前选项新建检测器。重建前先关掉旧的 */
  private async createLandmarker(): Promise<void> {
    const options = this.createOptions;
    if (!options) throw new Error("人脸检测尚未配置");
    this.landmarker?.close();
    this.landmarker = null;
    // 模块 Worker 必须加载会挂上 globalThis.ModuleFactory 的模块版胶水
    const fileset = await FilesetResolver.forVisionTasks(options.wasmBaseUrl, true);
    this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: options.modelUrl,
        delegate: "CPU",
      },
      runningMode: "VIDEO",
      numFaces: 1,
    });
  }

  /** 缩到检测尺寸。ImageBitmap 可以被 Face Landmarker 直接读取 */
  private async downscale(frame: VideoFrame): Promise<ImageBitmap> {
    const longest = Math.max(frame.displayWidth, frame.displayHeight, 1);
    const scale = Math.min(1, DETECT_MAX_EDGE / longest);
    return createImageBitmap(frame, {
      resizeWidth: Math.max(1, Math.round(frame.displayWidth * scale)),
      resizeHeight: Math.max(1, Math.round(frame.displayHeight * scale)),
      resizeQuality: "low",
    });
  }
}

/** 把第一张脸收成 x,y 交替的数组。点数不够时当作没有脸 */
function flattenLandmarks(result: FaceLandmarkerResult): Float32Array<ArrayBufferLike> {
  const face = result.faceLandmarks[0];
  if (!face || face.length < MIN_POINTS) return new Float32Array(0);
  const flat = new Float32Array(face.length * 2);
  for (let i = 0; i < face.length; i += 1) {
    flat[i * 2] = face[i].x;
    flat[i * 2 + 1] = face[i].y;
  }
  return flat;
}
