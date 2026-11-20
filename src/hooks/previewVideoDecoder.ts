import type { ComposeMediaResolver } from "@/service/resolveComposeMediaUrl";
import { applyMediaCrossOrigin, mediaElementUsesUrl } from "@/service/resolveComposeMediaUrl";
import type { VideoClipItem } from "@/types/videoCompose";
import type { DecodedPreviewFrame } from "@/types/previewPlayback";
import { capturePreviewBitmap, seekPreviewVideo, VIDEO_FRAME_TIMEOUT_MS } from "./previewVideoFrame";
import { previewClipStartSec, previewSeekTimeSec } from "./previewSourceTime";

/** 每个原生解码槽最多保留三帧；当前任务借用的旧帧可在归还时延迟关闭。 */
export const PREVIEW_RAW_FRAME_LIMIT = 3;

/** 队列与边界缓存共享引用，取消任务不能关闭另一任务仍在使用的像素。 */
class OwnedFrame {
  private references = 1;

  constructor(
    readonly bitmap: ImageBitmap,
    readonly sourceTimeUs: number,
    readonly sourceSize: { width: number; height: number },
  ) {}

  borrow(): DecodedPreviewFrame {
    this.references += 1;
    let released = false;
    return {
      bitmap: this.bitmap,
      sourceTimeUs: this.sourceTimeUs,
      sourceSize: this.sourceSize,
      retain: () => this.borrow(),
      release: (): void => {
        if (released) return;
        released = true;
        this.release();
      },
    };
  }

  release(): void {
    if (--this.references === 0) this.bitmap.close();
  }
}

/** 一个连续解码会话；定位只发生在绑定源时，后续通过真实帧回调推进。 */
class NativePreviewSource {
  index = -1;
  private clip: VideoClipItem | null = null;
  private controller = new AbortController();
  private unbindParent: (() => void) | null = null;
  private ready: Promise<void> | null = null;
  private frames: OwnedFrame[] = [];
  private listeners = new Set<() => void>();
  private callback = 0;
  private raf = 0;
  private allowed = false;
  private capturing = false;
  private ended = false;
  private backpressured = false;
  private failure: Error | null = null;
  private requestedUs = -1;
  private endSec = 0;

  constructor(
    readonly video: HTMLVideoElement,
    private readonly resolver: ComposeMediaResolver,
    private readonly maxEdge: () => number | undefined,
  ) {
    video.muted = true;
    video.addEventListener("ended", this.onEnded);
    video.addEventListener("error", this.onError);
  }

  /** 同一绑定复用准备 Promise；新绑定取消全部旧定位和快照。 */
  bind(index: number, clip: VideoClipItem, sourceSec: number, rate: number, signal: AbortSignal): Promise<void> {
    if (this.index === index && this.clip?.url === clip.url && this.ready) return this.ready;
    this.reset();
    this.index = index;
    this.clip = clip;
    this.endSec = clip.trimEnd ?? (clip.trimStart ?? 0) + clip.durationSec * (clip.playbackRate || 1);
    const controller = this.controller;
    const abort = (): void => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    this.unbindParent = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) controller.abort();
    this.ready = this.load(clip, sourceSec, rate, controller.signal).catch((error: unknown) => {
      if (this.controller === controller) this.failure = error instanceof Error ? error : new Error("视频准备失败");
      throw error;
    });
    return this.ready;
  }

  private async load(clip: VideoClipItem, sourceSec: number, rate: number, signal: AbortSignal): Promise<void> {
    const url = await this.resolver.resolve(clip.url);
    signal.throwIfAborted();
    applyMediaCrossOrigin(this.video, url);
    if (!mediaElementUsesUrl(this.video, url)) this.video.src = url;
    this.video.muted = true;
    this.video.playbackRate = (clip.playbackRate || 1) * rate;
    await seekPreviewVideo(this.video, sourceSec, signal);
    const bitmap = await capturePreviewBitmap(this.video, signal, this.maxEdge());
    if (signal.aborted) {
      bitmap.close();
      signal.throwIfAborted();
    }
    this.frames.push(new OwnedFrame(bitmap, Math.round(this.video.currentTime * 1e6), this.sourceSize()));
    this.ended = sourceSec >= this.endSec - 0.0011;
    this.scheduleCallback();
    this.wake();
  }

  /** 等待覆盖目标的后继帧，返回之前最近的一帧；高帧率的多余帧可正常采样淘汰。 */
  async acquire(sourceSec: number, signal: AbortSignal): Promise<DecodedPreviewFrame> {
    this.requestedUs = Math.round(sourceSec * 1e6);
    while (true) {
      signal.throwIfAborted();
      this.controller.signal.throwIfAborted();
      if (this.failure) throw this.failure;
      this.trim();
      const last = this.frames.at(-1);
      if (last && (last.sourceTimeUs >= this.requestedUs - 1 || this.ended)) {
        const frame = [...this.frames].reverse().find((item) => item.sourceTimeUs <= this.requestedUs + 1) ?? this.frames[0];
        this.updatePlayback();
        return frame.borrow();
      }
      this.updatePlayback();
      await this.wait(signal);
    }
  }

  /** 背压只控制原生解码，不影响音频与展示时钟。 */
  setRunning(allowed: boolean): void {
    this.allowed = allowed;
    this.updatePlayback();
  }

  private sourceSize(): { width: number; height: number } {
    return { width: this.video.videoWidth, height: this.video.videoHeight };
  }

  private trim(): void {
    while (this.frames.length > 1 && this.frames[1].sourceTimeUs <= this.requestedUs) this.frames.shift()!.release();
  }

  private updatePlayback(): void {
    const video = this.video;
    if (this.frames.length >= PREVIEW_RAW_FRAME_LIMIT) this.backpressured = true;
    else if (this.frames.length <= 1) this.backpressured = false;
    if (this.controller.signal.aborted || !this.allowed || this.ended || this.failure || this.backpressured || !this.frames.length) {
      if (!video.paused) video.pause();
      return;
    }
    if (!video.paused) return;
    const controller = this.controller;
    void video.play().then(
      () => {
        if (this.controller !== controller) return;
        if (!this.allowed || this.ended || this.backpressured) video.pause();
      },
      (error: unknown) => {
        if (controller.signal.aborted || this.controller !== controller || !this.allowed) return;
        this.failure = error instanceof Error ? error : new Error("视频连续解码失败");
        this.wake();
      },
    );
  }

  private scheduleCallback(): void {
    if (this.controller.signal.aborted || this.index < 0 || this.ended) return;
    if (this.video.requestVideoFrameCallback) this.callback = this.video.requestVideoFrameCallback(this.onFrame);
    else this.raf = requestAnimationFrame(() => this.onFrame(0, { mediaTime: this.video.currentTime } as VideoFrameCallbackMetadata));
  }

  private onFrame = (_now: number, metadata: VideoFrameCallbackMetadata): void => {
    this.scheduleCallback();
    if (this.controller.signal.aborted || this.capturing || this.video.seeking || this.video.readyState < 2) return;
    if (metadata.mediaTime >= this.endSec - 1e-6) return this.onEnded();
    const sourceTimeUs = Math.round(metadata.mediaTime * 1e6);
    if (sourceTimeUs <= (this.frames.at(-1)?.sourceTimeUs ?? -1)) return;
    if (this.frames.length >= PREVIEW_RAW_FRAME_LIMIT) return this.updatePlayback();
    const controller = this.controller;
    this.capturing = true;
    void capturePreviewBitmap(this.video, controller.signal, this.maxEdge())
      .then(
        (bitmap) => {
          if (controller.signal.aborted || this.controller !== controller) return bitmap.close();
          this.frames.push(new OwnedFrame(bitmap, sourceTimeUs, this.sourceSize()));
          this.trim();
          this.updatePlayback();
          this.wake();
        },
        (error: unknown) => {
          if (controller.signal.aborted || this.controller !== controller) return;
          this.failure = error instanceof Error ? error : new Error("视频快照失败");
          this.wake();
        },
      )
      .finally(() => {
        if (this.controller === controller) this.capturing = false;
      });
  };

  private onEnded = (): void => {
    this.ended = true;
    this.video.pause();
    this.wake();
  };

  private onError = (): void => {
    this.failure = new Error(this.video.error?.message || "视频解码失败");
    this.wake();
  };

  private wake(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** 帧等待带超时及双重取消，避免旧代次占住处理队列。 */
  private wait(signal: AbortSignal): Promise<void> {
    const controller = this.controller;
    return new Promise((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        this.listeners.delete(changed);
        signal.removeEventListener("abort", abort);
        controller.signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const changed = (): void => finish();
      const abort = (): void => finish(new DOMException("预览解码已取消", "AbortError"));
      const timer = window.setTimeout(() => finish(new Error("等待连续视频帧超时（8 秒）")), VIDEO_FRAME_TIMEOUT_MS);
      this.listeners.add(changed);
      signal.addEventListener("abort", abort, { once: true });
      controller.signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted || controller.signal.aborted) abort();
    });
  }

  reset(): void {
    this.controller.abort();
    this.unbindParent?.();
    this.unbindParent = null;
    this.video.pause();
    this.video.cancelVideoFrameCallback?.(this.callback);
    cancelAnimationFrame(this.raf);
    for (const frame of this.frames) frame.release();
    this.frames = [];
    this.controller = new AbortController();
    this.index = -1;
    this.ready = null;
    this.clip = null;
    this.allowed = this.capturing = this.ended = this.backpressured = false;
    this.failure = null;
    this.requestedUs = -1;
  }

  dispose(): void {
    this.reset();
    this.controller.abort();
    this.video.removeEventListener("ended", this.onEnded);
    this.video.removeEventListener("error", this.onError);
  }
}

/** 双槽按片段绑定，保持侧通过引用缓存释放 video 槽给后续转场使用。 */
export class PreviewVideoDecoder {
  private sources: NativePreviewSource[];
  private edges = new Map<string, DecodedPreviewFrame>();
  private running = false;

  constructor(videos: readonly HTMLVideoElement[], resolver: ComposeMediaResolver, maxEdge: () => number | undefined = () => undefined) {
    this.sources = videos.map((video) => new NativePreviewSource(video, resolver, maxEdge));
  }

  /** 判定缓存边界，片段源地址和参数变化由调用方 generation 重置。 */
  private edgeKey(clips: VideoClipItem[], index: number, time: number): string | null {
    const start = previewClipStartSec(clips, index);
    const end = clips[index].endTime ?? start + clips[index].durationSec;
    return time <= start ? `${index}:in` : time >= end ? `${index}:out` : null;
  }

  async acquire(
    clips: VideoClipItem[],
    index: number,
    time: number,
    rate: number,
    protectedIndices: readonly number[],
    signal: AbortSignal,
    sessionSignal: AbortSignal = signal,
  ): Promise<DecodedPreviewFrame> {
    signal.throwIfAborted();
    const key = this.edgeKey(clips, index, time);
    const cached = key ? this.edges.get(key) : undefined;
    if (cached) return cached.retain();
    const source = this.sources.find((item) => item.index === index) ?? this.sources.find((item) => !protectedIndices.includes(item.index));
    if (!source) throw new Error("转场解码槽不足");
    const target = previewSeekTimeSec(clips, index, time);
    await source.bind(index, clips[index], target, rate, sessionSignal);
    signal.throwIfAborted();
    source.setRunning(this.running);
    const frame = await source.acquire(target, signal);
    if (key) {
      this.edges.get(key)?.release();
      this.edges.set(key, frame.retain());
      while (this.edges.size > 4) {
        const oldest = this.edges.keys().next().value!;
        this.edges.get(oldest)!.release();
        this.edges.delete(oldest);
      }
    }
    return frame;
  }

  /** 当前采样仅保护没有边界缓存的两侧，已保持的 A 不再占住 C 的预热槽。 */
  protectedIndices(clips: VideoClipItem[], indices: readonly number[], time: number): number[] {
    return indices.filter((index) => {
      const key = this.edgeKey(clips, index, time);
      return !key || !this.edges.has(key);
    });
  }

  /** 有空槽才后台预热，预热失败留给实际命中时报告。 */
  prewarm(
    clips: VideoClipItem[],
    index: number,
    time: number,
    rate: number,
    protectedIndices: readonly number[],
    signal: AbortSignal,
  ): void {
    if (!this.sources.some((item) => item.index === index || !protectedIndices.includes(item.index))) return;
    void this.acquire(clips, index, time, rate, protectedIndices, signal).then(
      (frame) => frame.release(),
      () => undefined,
    );
  }

  setRunning(running: boolean): void {
    this.running = running;
    this.sources.forEach((source) => source.setRunning(running));
  }

  reset(): void {
    this.setRunning(false);
    this.sources.forEach((source) => source.reset());
    for (const frame of this.edges.values()) frame.release();
    this.edges.clear();
  }

  dispose(): void {
    this.reset();
    this.sources.forEach((source) => source.dispose());
  }
}
