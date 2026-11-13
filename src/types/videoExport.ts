/** 导出分辨率档位。素材分辨率按主轨最低可用尺寸计算。 */
export type ComposeVideoExportResolution = "2k" | "1080p" | "720p" | "source";

/** 像素尺寸。 */
export interface VideoLayerSize {
  /** 宽度。 */
  width: number;
  /** 高度。 */
  height: number;
}

/** 导出 Worker 接收的单帧超分请求。 */
export interface VideoLayerUpscaleRequest {
  /** 调用期间借用的图层。所有权由导出器保留。 */
  frame: ImageBitmap;
  /** 输出图层尺寸。 */
  targetSize: VideoLayerSize;
  /** 用于隔离模型历史的片段 ID。 */
  clipId: string;
  /** 该解码帧在源素材中的微秒时间戳。 */
  sourceTimeUs: number;
  /** 首帧或该片段取帧不连续时重置历史。 */
  resetHistory: boolean;
  /** 当前导出任务的 Worker 内取消信号。 */
  signal: AbortSignal;
}

/** 仅在导出 Worker 内实例化的视频图层放大实现。 */
export interface VideoLayerUpscaler {
  /** 探测一对输入输出尺寸，可在同一实例内缓存模型资源。 */
  probe(sourceSize: VideoLayerSize, targetSize: VideoLayerSize, signal: AbortSignal): Promise<boolean>;
  /** 返回由导出器负责释放的独立位图。 */
  upscale(request: VideoLayerUpscaleRequest): Promise<ImageBitmap>;
  /** 可选，片段离开时间轴时及早回收时序缓存。 */
  releaseClip?(clipId: string): void;
  /** 释放任务拥有的模型、缓存和设备资源。 */
  dispose(): void | Promise<void>;
}

/** Worker 内登记的模型或图层放大后端工厂。 */
export type VideoLayerUpscalerFactory = () => VideoLayerUpscaler;

/** 导出进度阶段。 */
export type ComposeVideoExportStage = "preparing" | "rendering" | "finalizing" | "complete";

/** 组件和宿主收到的导出进度。 */
export interface ComposeVideoExportProgress {
  /** 当前阶段。 */
  stage: ComposeVideoExportStage;
  /** 处理帧数除以总帧数。准备和封装时为空。 */
  percent: number | null;
}

/** 组件导出参数。 */
export interface ComposeVideoExportOptions {
  /** 已登记的 Worker 算法 ID。默认使用 OpenReel balanced。 */
  upscalerId?: string;
  /** 已知的输出档位。省略时在遮罩中选择。 */
  resolution?: ComposeVideoExportResolution;
  /** 宿主取消信号。 */
  signal?: AbortSignal;
  /** 订阅导出进度。 */
  onProgress?: (progress: ComposeVideoExportProgress) => void;
}

/** 成功完成封装的 MP4 文件。 */
export interface ComposeVideoExportResult extends VideoLayerSize {
  /** 可下载的 MP4。 */
  blob: Blob;
  /** 建议的下载文件名。 */
  fileName: string;
  /** 主轨限定的导出时长，单位秒。 */
  durationSec: number;
}
