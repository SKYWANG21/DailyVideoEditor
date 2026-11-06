import type { BeautyParams } from "@/types/composeMedia";

/** 预览画面像素尺寸 */
export interface PreviewVideoSize {
  /** 视频宽（像素） */
  width: number;
  /** 视频高（像素） */
  height: number;
}

/** 贯穿快照、Worker 和画面提交的请求标识 */
export interface PreviewFrameIdentity {
  /** 播放控制代次；暂停、跳转和参数变化后旧代次失效 */
  generation: number;
  /** 播放器内递增的请求序号 */
  requestId: number;
  /** 片段 id */
  clipId: string;
  /** 请求的源时间（微秒） */
  sourceTimeUs: number;
}

/** 主线程交给 Worker 的视频快照；所有权随消息转移 */
export interface BeautyRenderRequest extends PreviewFrameIdentity {
  /** 处理当前快照 */
  type: "render";
  /** 已由活动 video 解码的画面 */
  bitmap: ImageBitmap;
  /** 瘦脸或大眼开启时才做人脸检测 */
  detectFace: boolean;
}

/** 算法预热期间保持普通 video 时钟 */
export interface BeautyInitRequest {
  /** 预热 Worker 与当前参数需要的模型 */
  type: "init";
  /** 对应主线程的预热序号 */
  requestId: number;
  /** 是否需要人脸模型 */
  detectFace: boolean;
  /** 美颜模型根路径 */
  algorithmBaseUrl: string;
}

/** 主线程发往预览 Worker 的消息 */
export type BeautyWorkerRequest = BeautyRenderRequest | BeautyInitRequest | { type: "dispose" };

/** Worker 处理后返回的 RGBA 和关键点 */
export interface BeautyFrameEvent extends PreviewFrameIdentity, PreviewVideoSize {
  /** 当前快照处理完成 */
  type: "frame";
  /** RGBA，每行 width * 4 字节，已适配 WebGL 行方向 */
  buffer: ArrayBuffer;
  /** MediaPipe 归一化坐标，x,y 交替；无人脸时为空 */
  landmarks: Float32Array<ArrayBufferLike>;
  /** 人脸检测降级原因；磨皮、美白仍然可用 */
  warning?: string;
}

/** Worker 发回主线程的消息 */
export type BeautyWorkerEvent =
  BeautyFrameEvent | { type: "ready"; requestId: number; warning?: string } | (PreviewFrameIdentity & { type: "error"; message: string });

/** 当前帧要交给 GPUPixel 的强度。关闭时四项为 0 */
export function beautyLevelsForFrame(beauty: BeautyParams): BeautyParams {
  return beauty.enabled ? beauty : { enabled: false, smooth: 0, whiten: 0, slim: 0, eye: 0 };
}

/** 瘦脸或大眼开启时才需要关键点 */
export function beautyNeedsFace(beauty: BeautyParams): boolean {
  return beauty.enabled && (beauty.slim > 0 || beauty.eye > 0);
}
