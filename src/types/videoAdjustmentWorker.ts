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
}

/** 完成位图归主线程所有，过期或绘制完成时关闭。 */
export type AdjustmentWorkerResponse = AdjustmentRequestIdentity &
  ({ type: "frame"; bitmap: ImageBitmap } | { type: "error"; message: string });
