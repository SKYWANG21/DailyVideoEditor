import type { TransitionInputKeys } from "./transition";

/** Worker 的加载和绘制命令；位图均为适配器独占快照。 */
export type TransitionWorkerCommand =
  | {
      /** 加载模块。 */
      type: "load";
      /** 当前 Worker 内独立的内核标识。 */
      kernelId: number;
      /** 转移给 Worker 的模块字节。 */
      buffer: ArrayBuffer;
    }
  | {
      /** 生成完成帧。 */
      type: "render";
      /** 当前 Worker 内的内核标识。 */
      kernelId: number;
      /** 离场画面的独占快照。 */
      outgoing: ImageBitmap;
      /** 入场画面的独占快照。 */
      incoming: ImageBitmap;
      /** 输出宽度，像素。 */
      width: number;
      /** 输出高度，像素。 */
      height: number;
      /** 已缓动的进度。 */
      progress: number;
      /** 可序列化的效果参数。 */
      params: Readonly<Record<string, unknown>>;
      /** 输入像素版本；省略时重新读回。 */
      inputKeys?: TransitionInputKeys;
    };

/** 带响应序号的任务，或无需响应的内核释放命令。 */
export type TransitionWorkerRequest = (TransitionWorkerCommand & { requestId: number }) | { type: "release"; kernelId: number };

/** 输出位图的所有权由 Worker 转给适配器；失败只返回当前请求的错误。 */
export type TransitionWorkerEvent =
  | { type: "ready"; requestId: number }
  | { type: "frame"; requestId: number; bitmap: ImageBitmap }
  | { type: "error"; requestId: number; message: string };
