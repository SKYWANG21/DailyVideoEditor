import type { AdjustmentFrame, VideoAdjustments } from "./videoAdjustments";

/** 调色请求身份，返回消息携带同一标识。 */
export interface AdjustmentRequestIdentity extends AdjustmentFrame {
  /** 请求序号。 */
  requestId: number;
  /** 预览取消代次。 */
  generation: number;
}

/** bitmap 转移后由 Worker 独占并关闭。 */
export interface AdjustmentWorkerRequest extends AdjustmentRequestIdentity {
  /** 当前片段独立快照。 */
  bitmap: ImageBitmap;
  /** 已归一化的九项参数。 */
  adjustments: VideoAdjustments;
  /** 客户端明确指定 CPU 或当前播放会话已停用 GPU。 */
  cpuOnly?: boolean;
}

/** 区分创建上下文、浏览器恢复和恢复后首次成功输出。 */
export type GradeContextEvent = "created" | "createFailed" | "lost" | "restored" | "rebuilt" | "rebuildFailed";

/** 完成位图归主线程所有，过期或绘制完成时关闭。 */
export type AdjustmentWorkerResponse = AdjustmentRequestIdentity &
  ({ type: "frame"; bitmap: ImageBitmap; backendUsed: "cpu" | "gpu"; fallbackReason?: string } | { type: "error"; message: string });

/** Worker 的帧回复与独立于播放请求的上下文事件。 */
export type GradeWorkerMessage = AdjustmentWorkerResponse | { type: "context"; event: GradeContextEvent };
