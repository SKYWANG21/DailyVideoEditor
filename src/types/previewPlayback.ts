import type { PreviewFrameIdentity, PreviewVideoSize } from "./beautyPreview";
import type { TransitionSample } from "./transition";

/** 播放意图与实际媒体运行状态分离，缓冲不等同于用户暂停。 */
export type PreviewPlaybackState = "paused" | "preparing" | "playing" | "buffering" | "seeking" | "ended" | "error";

/** 每个预览会话独立的展示时钟；时间轴只读，协调器提交画面后写入。 */
export interface PreviewPlaybackClock {
  /** 已提交画面的工程时间，不能用解码预卷时间代替。 */
  presentedTime: number;
  /** 播放意图，缓冲期间保持为 true。 */
  isPlaying: boolean;
  /** 当前播放倍率。 */
  playbackRate: number;
  /** 协调器的实际运行状态。 */
  state: PreviewPlaybackState;
  /** 同一时间重新提交画面也递增，用于完成待处理的定位请求。 */
  revision: number;
}

/** 时间轴交互命令，与被动读取展示时间分开。 */
export type TimelinePlaybackCommand =
  | { type: "play" }
  | { type: "pause" }
  | { type: "seek"; time: number }
  | { type: "rate"; rate: number }
  | { type: "scrub-start" }
  | { type: "scrub-end"; time: number; resume: boolean };

/** 解码队列借出的不可变快照；消费者在处理结束后释放借用。 */
export interface DecodedPreviewFrame {
  /** 实际源帧时间，微秒。 */
  sourceTimeUs: number;
  /** 源视频原始尺寸，独立于预览缩放。 */
  sourceSize: PreviewVideoSize;
  /** 借用期间有效，消费者不能直接关闭或转移。 */
  bitmap: ImageBitmap;
  /** 额外借用同一快照，供边界帧缓存安全跨越解码槽换源。 */
  retain(): DecodedPreviewFrame;
  /** 归还一次借用，旧代次清理时仍可安全调用。 */
  release(): void;
}

/** 一次合成使用的固定采样，不读取正在变化的 video.currentTime。 */
export interface PreviewRenderRequest {
  /** 控制代次及双侧源时间。 */
  identity: PreviewFrameIdentity;
  /** 输出帧在时间轴上的起点。 */
  time: number;
  /** 此画面覆盖的时间轴区间长度。 */
  duration: number;
  /** 当前自然时间所属片段，空隙为 -1。 */
  clipIndex: number;
  /** 普通片段或转场 A 的快照，空隙不传。 */
  outgoing?: DecodedPreviewFrame;
  /** 转场 B 的快照。 */
  incoming?: DecodedPreviewFrame;
  /** 当前采样的转场定义。 */
  transition?: TransitionSample | null;
}

/** 队列独占输出位图，展示、淘汰或取消后必须关闭。 */
export interface PreparedPreviewFrame {
  /** 帧所属请求及源身份。 */
  identity: PreviewFrameIdentity;
  /** 时间轴展示时间。 */
  time: number;
  /** 帧的有效时间区间。 */
  duration: number;
  /** 自然时间所属片段，空隙为 -1。 */
  clipIndex: number;
  /** 原视频尺寸，不将预览像素写回工程。 */
  sourceSize?: PreviewVideoSize;
  /** 纯音频没有可见画布时为空。 */
  bitmap: ImageBitmap | null;
}

/** 处理与展示的最小接口；处理器不控制媒体或推进时钟。 */
export interface PreviewFrameRenderer {
  /** 预热当前及即将进入的片段。 */
  warmup(indices: readonly number[]): Promise<void>;
  /** 串行生成独立输出，调用方释放输入借用。 */
  render(request: PreviewRenderRequest, signal: AbortSignal): Promise<PreparedPreviewFrame>;
  /** 唯一可见 Canvas 写入点。 */
  present(frame: PreparedPreviewFrame): void;
  /** 丢弃配置变化前的图层缓存。 */
  reset(): void;
}
