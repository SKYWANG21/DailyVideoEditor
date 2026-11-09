import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewVideoDecoder } from "../src/hooks/previewVideoDecoder";
import type { ComposeMediaResolver } from "../src/service/resolveComposeMediaUrl";
import type { VideoClipItem } from "../src/types/videoCompose";

const mocks = vi.hoisted(() => ({ seek: vi.fn(), capture: vi.fn() }));
vi.mock("../src/hooks/previewVideoFrame", () => ({
  seekPreviewVideo: mocks.seek,
  capturePreviewBitmap: mocks.capture,
  VIDEO_FRAME_TIMEOUT_MS: 8000,
}));

/** 原生帧回调由测试显式推进，确保测试没有依赖 currentTime 轮询或真实解码。 */
class VideoSource extends EventTarget {
  src = "";
  currentTime = 0;
  readyState = 2;
  paused = true;
  seeking = false;
  muted = true;
  error = null;
  videoWidth = 320;
  videoHeight = 180;
  playbackRate = 1;
  private callbacks = new Map<number, VideoFrameRequestCallback>();
  private sequence = 0;
  play = vi.fn(async () => {
    this.paused = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
  requestVideoFrameCallback = (callback: VideoFrameRequestCallback): number => {
    this.callbacks.set(++this.sequence, callback);
    return this.sequence;
  };
  cancelVideoFrameCallback = (id: number): void => {
    this.callbacks.delete(id);
  };
  step(time: number): void {
    this.currentTime = time;
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    callbacks.forEach((callback) => callback(0, { mediaTime: time } as VideoFrameCallbackMetadata));
  }
}

const clips: VideoClipItem[] = [
  { id: "a", title: "A", url: "a.mp4", durationSec: 2, startTime: 0, endTime: 2, trimStart: 0, trimEnd: 2 },
  { id: "b", title: "B", url: "b.mp4", durationSec: 1, startTime: 2, endTime: 3, trimStart: 0, trimEnd: 1 },
  { id: "c", title: "C", url: "c.mp4", durationSec: 2, startTime: 3, endTime: 5, trimStart: 0, trimEnd: 2 },
];

describe("原生连续解码与快照所有权", () => {
  let decoder: PreviewVideoDecoder;
  let videos: VideoSource[];
  let controller: AbortController;
  let bitmaps: ImageBitmap[];

  beforeEach(() => {
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    videos = [new VideoSource(), new VideoSource()];
    controller = new AbortController();
    bitmaps = [];
    mocks.seek.mockReset().mockImplementation(async (video: VideoSource, time: number) => {
      video.currentTime = time;
    });
    mocks.capture.mockReset().mockImplementation(async () => {
      const bitmap = { width: 320, height: 180, close: vi.fn() } as unknown as ImageBitmap;
      bitmaps.push(bitmap);
      return bitmap;
    });
    const resolver = { resolve: async (url: string) => url } as ComposeMediaResolver;
    decoder = new PreviewVideoDecoder(videos as unknown as HTMLVideoElement[], resolver);
  });

  afterEach(() => {
    decoder.dispose();
    vi.unstubAllGlobals();
  });

  async function flush(): Promise<void> {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  }

  it("通过真实帧回调向前取帧，后续采样不重新 seek，原始队列三帧封顶", async () => {
    decoder.setRunning(true);
    const first = await decoder.acquire(clips, 0, 0, 1, [0], controller.signal);
    first.release();
    videos[0].step(1 / 30);
    await flush();
    videos[0].step(2 / 30);
    await flush();
    expect(bitmaps).toHaveLength(3);
    expect(videos[0].paused).toBe(true);
    const second = await decoder.acquire(clips, 0, 2 / 30, 1, [0], controller.signal);
    expect(second.sourceTimeUs).toBe(66667);
    second.release();
    const next = decoder.acquire(clips, 0, 0.1, 1, [0], controller.signal);
    await flush();
    expect(videos[0].paused).toBe(false);
    videos[0].step(0.1);
    const third = await next;
    expect(third.sourceTimeUs).toBe(100000);
    third.release();
    expect(mocks.seek).toHaveBeenCalledTimes(1);
    expect(videos.every((video) => video.muted)).toBe(true);
    decoder.dispose();
    bitmaps.forEach((bitmap) => expect(bitmap.close).toHaveBeenCalledTimes(1));
  });

  it("双侧准备在两个槽同时启动，边界缓存可释放 A 的槽给 C 且不会覆盖 B", async () => {
    const a = decoder.acquire(clips, 0, 2, 1, [0, 1], controller.signal);
    const b = decoder.acquire(clips, 1, 2, 1, [0, 1], controller.signal);
    await flush();
    expect(mocks.seek).toHaveBeenCalledTimes(2);
    expect(videos.map((video) => video.src)).toEqual(["a.mp4", "b.mp4"]);
    const [outgoing, incoming] = await Promise.all([a, b]);
    const heldBitmap = outgoing.bitmap;
    outgoing.release();
    incoming.release();
    const protectedIndices = decoder.protectedIndices(clips, [0, 1], 2.5);
    expect(protectedIndices).toEqual([1]);
    const c = await decoder.acquire(clips, 2, 2.5, 1, protectedIndices, controller.signal);
    c.release();
    expect(videos.map((video) => video.src)).toEqual(["c.mp4", "b.mp4"]);
    expect(heldBitmap.close).not.toHaveBeenCalled();
    const held = await decoder.acquire(clips, 0, 2.6, 1, [1, 2], controller.signal);
    expect(held.bitmap).toBe(heldBitmap);
    held.release();
    expect(mocks.seek).toHaveBeenCalledTimes(3);
    decoder.dispose();
    bitmaps.forEach((bitmap) => expect(bitmap.close).toHaveBeenCalledTimes(1));
  });

  it("取消等待帧立即结束，槽重置后借用仍有效直到最后一个消费者释放", async () => {
    decoder.setRunning(true);
    const first = await decoder.acquire(clips, 0, 0, 1, [0], controller.signal);
    const waiting = decoder.acquire(clips, 0, 0.2, 1, [0], controller.signal);
    await flush();
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    decoder.reset();
    expect(first.bitmap.close).not.toHaveBeenCalled();
    first.release();
    expect(first.bitmap.close).toHaveBeenCalledTimes(1);
  });

  it("裁剪与倍速只在源绑定时定位，采样身份使用实际源 PTS", async () => {
    const fast = [{ ...clips[0], trimStart: 3, trimEnd: 7, playbackRate: 2 }];
    const input = await decoder.acquire(fast, 0, 0.5, 1.5, [0], controller.signal);
    expect(mocks.seek.mock.calls[0][1]).toBe(4);
    expect(videos[0].playbackRate).toBe(3);
    expect(input.sourceTimeUs).toBe(4e6);
    input.release();
  });

  it("旧代次快照迟到时关闭，不混入重置后的原始帧队列", async () => {
    decoder.setRunning(true);
    const first = await decoder.acquire(clips, 0, 0, 1, [0], controller.signal);
    let finish!: (bitmap: ImageBitmap) => void;
    mocks.capture.mockImplementationOnce(
      () =>
        new Promise<ImageBitmap>((resolve) => {
          finish = resolve;
        }),
    );
    videos[0].step(1 / 30);
    decoder.reset();
    const late = { close: vi.fn() } as unknown as ImageBitmap;
    finish(late);
    await flush();
    expect(late.close).toHaveBeenCalledTimes(1);
    expect(first.bitmap.close).not.toHaveBeenCalled();
    first.release();
    expect(first.bitmap.close).toHaveBeenCalledTimes(1);
  });

  it("没有视频帧回调时使用 RAF 读取新媒体时间，也不通过 seek 逐帧驱动", async () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    (videos[0] as unknown as { requestVideoFrameCallback: undefined }).requestVideoFrameCallback = undefined;
    decoder.setRunning(true);
    const first = await decoder.acquire(clips, 0, 0, 1, [0], controller.signal);
    first.release();
    const next = decoder.acquire(clips, 0, 1 / 30, 1, [0], controller.signal);
    await flush();
    videos[0].currentTime = 1 / 30;
    callbacks.shift()!(0);
    const frame = await next;
    expect(frame.sourceTimeUs).toBe(33333);
    frame.release();
    expect(mocks.seek).toHaveBeenCalledTimes(1);
  });

  it("取消一次生产等待不销毁解码会话，续播仍复用原源和已捕获快照", async () => {
    decoder.setRunning(true);
    const first = await decoder.acquire(clips, 0, 0, 1, [0], controller.signal);
    first.release();
    const production = new AbortController();
    const waiting = decoder.acquire(clips, 0, 0.1, 1, [0], production.signal, controller.signal);
    await flush();
    decoder.setRunning(false);
    production.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    decoder.setRunning(true);
    const resumed = decoder.acquire(clips, 0, 0.1, 1, [0], controller.signal);
    await flush();
    videos[0].step(0.1);
    const frame = await resumed;
    expect(frame.sourceTimeUs).toBe(100000);
    frame.release();
    expect(mocks.seek).toHaveBeenCalledTimes(1);
  });
});
