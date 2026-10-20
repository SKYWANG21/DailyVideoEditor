import type { BeautyParams } from "@/types/composeMedia";

/** 预览画面像素尺寸 */
export interface PreviewVideoSize {
  /** 视频宽（像素） */
  width: number;
  /** 视频高（像素） */
  height: number;
}

/** 主线程请求 Worker 解一帧 */
export interface BeautyRenderRequest {
  type: "render";
  /** 递增序号。过期结果由主线程丢弃 */
  requestId: number;
  /** 片段 id */
  clipId: string;
  /** 视频地址 */
  url: string;
  /** 源时间（微秒） */
  sourceTimeUs: number;
  /** 瘦脸或大眼大于 0 时才做人脸检测 */
  detectFace: boolean;
}

/** 预载下一段，避免切段时重新解封装 */
export interface BeautyPrefetchRequest {
  type: "prefetch";
  /** 片段 id */
  clipId: string;
  /** 视频地址 */
  url: string;
}

/** 页面卸载时释放解码器 */
export interface BeautyDisposeRequest {
  type: "dispose";
}

/** 主线程发往预览 Worker 的消息 */
export type BeautyWorkerRequest = BeautyRenderRequest | BeautyPrefetchRequest | BeautyDisposeRequest;

/** Worker 解出的一帧 RGBA 和关键点 */
export interface BeautyFrameEvent {
  type: "frame";
  /** 对应的请求序号 */
  requestId: number;
  /** 片段 id */
  clipId: string;
  /** 帧宽 */
  width: number;
  /** 帧高 */
  height: number;
  /** 源时间（微秒） */
  sourceTimeUs: number;
  /** RGBA，每行 width * 4 字节 */
  buffer: ArrayBuffer;
  /** MediaPipe 归一化坐标，x,y 交替。无人脸时长度为 0 */
  landmarks: Float32Array<ArrayBufferLike>;
}

/** Worker 无法解码或检测时的说明 */
export interface BeautyErrorEvent {
  type: "error";
  /** 对应请求序号。初始化失败时为 0 */
  requestId: number;
  /** 给界面展示的原因 */
  message: string;
}

/** Worker 发回主线程的消息 */
export type BeautyWorkerEvent = BeautyFrameEvent | BeautyErrorEvent;

/** 当前帧要交给 GPUPixel 的强度。关闭时四项为 0 */
export function beautyLevelsForFrame(beauty: BeautyParams): BeautyParams {
  if (!beauty.enabled) {
    return { enabled: false, smooth: 0, whiten: 0, slim: 0, eye: 0 };
  }
  return beauty;
}

/** 瘦脸或大眼开启时才需要关键点 */
export function beautyNeedsFace(beauty: BeautyParams): boolean {
  return beauty.enabled && (beauty.slim > 0 || beauty.eye > 0);
}
