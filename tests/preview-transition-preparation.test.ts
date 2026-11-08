import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref, shallowRef, type EffectScope } from "vue";
import { useVideoComposePreview } from "../src/hooks/useVideoComposePreview";
import { createDefaultComposeConfig } from "../src/types/composeMedia";
import type { ComposeTrack, VideoClipItem } from "../src/types/videoCompose";

/** 可控定位等待用于验证并发、任务复用和跳转取消，不依赖浏览器解码耗时。 */
const mocks = vi.hoisted(() => ({ seek: vi.fn() }));
vi.mock("../src/hooks/previewVideoFrame", () => ({ seekPreviewVideo: mocks.seek }));
vi.mock("../src/editor/composeRuntime", () => ({
  useComposeMediaResolver: () => ({ resolve: async (url: string) => url, peek: (url: string) => url }),
}));
vi.mock("../src/service/resolveComposeMediaUrl", () => ({
  applyMediaCrossOrigin: vi.fn(),
  mediaElementUsesUrl: (video: HTMLVideoElement, url: string) => video.src === url,
}));
vi.mock("../src/hooks/previewMediaGain", () => ({ applyPreviewGain: vi.fn(), primePreviewAudioContext: vi.fn() }));
vi.mock("../src/hooks/previewAudioMixer", () => ({
  createPreviewAudioMixer: () => ({ sync: vi.fn(), refresh: vi.fn(), pauseAll: vi.fn(), destroy: vi.fn() }),
}));
vi.mock("vue", async (importOriginal) => ({ ...(await importOriginal<typeof import("vue")>()), onUnmounted: vi.fn() }));

/** 只模拟播放控制使用的媒体字段，定位行为由可控 Promise 提供。 */
function createVideo(): HTMLVideoElement {
  const video = {
    src: "",
    currentTime: 0,
    readyState: 2,
    seeking: false,
    muted: true,
    ended: false,
    playbackRate: 1,
    pause: vi.fn(),
    play: vi.fn(async () => undefined),
  };
  return video as unknown as HTMLVideoElement;
}

/** 待完成的定位记录，允许测试在两侧均启动后再释放。 */
interface PendingSeek {
  video: HTMLVideoElement;
  signal: AbortSignal;
  finish(): void;
}

describe("转场入口媒体准备", () => {
  let scope: EffectScope;
  let preview: ReturnType<typeof useVideoComposePreview>;
  let callbacks: Map<number, FrameRequestCallback>;
  let pending: PendingSeek[];
  let shouldWait: (video: HTMLVideoElement) => boolean;

  beforeEach(() => {
    scope = effectScope();
    callbacks = new Map();
    pending = [];
    shouldWait = () => false;
    let sequence = 0;
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.set(++sequence, callback);
      return sequence;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
    mocks.seek.mockReset();
    mocks.seek.mockImplementation((video: HTMLVideoElement, time: number, signal: AbortSignal) => {
      if (!shouldWait(video)) {
        video.currentTime = time;
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const abort = (): void => reject(new DOMException("取消定位", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
        pending.push({
          video,
          signal,
          finish: (): void => {
            signal.removeEventListener("abort", abort);
            if (signal.aborted) return;
            video.currentTime = time;
            resolve();
          },
        });
      });
    });
  });

  afterEach(() => {
    preview?.destroy();
    scope.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** 连续场景将中间片段缩为一秒，使两端转场窗口相接。 */
  function setup(duration = 1, consecutive = false): void {
    const middleDuration = consecutive ? 1 : 5;
    const clips: VideoClipItem[] = [
      { id: "a", title: "A", url: "a.mp4", durationSec: 5, trimStart: 0, trimEnd: 5, startTime: 0, endTime: 5 },
      {
        id: "b",
        title: "B",
        url: "b.mp4",
        durationSec: middleDuration,
        trimStart: 0,
        trimEnd: middleDuration,
        startTime: 5,
        endTime: 5 + middleDuration,
      },
    ];
    if (consecutive) clips.push({ id: "c", title: "C", url: "c.mp4", durationSec: 5, trimStart: 0, trimEnd: 5, startTime: 6, endTime: 11 });
    const track = {
      clips: clips.map((clip) => ({ id: clip.id, type: "video", startTime: clip.startTime, endTime: clip.endTime })),
      transitions: [{ id: "t", clipAId: "a", clipBId: "b", effectId: "crossfade", durationSec: duration, params: {} }],
    } as ComposeTrack;
    if (consecutive)
      track.transitions!.push({ id: "t2", clipAId: "b", clipBId: "c", effectId: "crossfade", durationSec: duration, params: {} });
    preview = scope.run(() =>
      useVideoComposePreview({
        videoA: shallowRef(createVideo()),
        videoB: shallowRef(createVideo()),
        bgmEl: shallowRef(null),
        clips: ref(clips),
        config: ref(createDefaultComposeConfig()),
        previewMuted: ref(true),
        beautyReady: ref(false),
        transitionTrack: ref(track),
      }),
    )!;
  }

  /** 排空控制逻辑的微任务，不推进真实播放时间。 */
  async function flush(): Promise<void> {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    await nextTick();
  }

  /** 让自然视频时钟前进一次，并执行该播放器唯一的 RAF。 */
  function tick(time: number): void {
    preview.activeVideoEl.value!.currentTime = time;
    const [id, callback] = callbacks.entries().next().value!;
    callbacks.delete(id);
    callback(0);
  }

  it("显式定位到转场中点时，两侧均启动后才等待定位完成", async () => {
    setup();
    shouldWait = () => true;
    const task = preview.seek(5);
    await flush();
    expect(pending).toHaveLength(2);
    expect(new Set(pending.map((item) => item.video.src))).toEqual(new Set(["a.mp4", "b.mp4"]));
    expect(preview.mediaReady.value).toBe(false);
    pending[0].finish();
    await flush();
    expect(preview.mediaReady.value).toBe(false);
    pending[1].finish();
    await task;
    expect(preview.mediaReady.value).toBe(true);
    expect(preview.sampleTime.value).toBe(5);
  });

  it.each([0.2, 1, 4])("%s 秒转场提前于窗口预热，入口复用未完成任务且不重新定位活动侧", async (duration) => {
    setup(duration);
    await preview.play();
    const active = preview.activeVideoEl.value!;
    const standby = preview.standbyVideoEl.value!;
    const activePauses = vi.mocked(active.pause).mock.calls.length;
    shouldWait = (video) => video === standby;
    mocks.seek.mockClear();
    const start = 5 - duration / 2;
    tick(start - 0.36);
    await flush();
    expect(mocks.seek).not.toHaveBeenCalled();
    tick(start - 0.34);
    await flush();
    expect(pending).toHaveLength(1);
    expect(pending[0].video).toBe(standby);
    expect(active.play).toHaveBeenCalled();
    expect(vi.mocked(active.pause)).toHaveBeenCalledTimes(activePauses);
    expect(preview.playbackWaiting.value).toBe(false);
    tick(start + 0.01);
    await flush();
    expect(pending[0].signal.aborted).toBe(false);
    expect(mocks.seek).toHaveBeenCalledTimes(1);
    expect(preview.playbackWaiting.value).toBe(true);
    pending[0].finish();
    await flush();
    expect(preview.activeVideoEl.value).toBe(active);
    expect(preview.mediaReady.value).toBe(true);
    expect(preview.sampleTime.value).toBeCloseTo(start + 0.01);
    expect(mocks.seek).toHaveBeenCalledTimes(1);
  });

  it("等待转场预热时跳回片头，迟到任务不能提交旧入口", async () => {
    setup();
    await preview.play();
    const standby = preview.standbyVideoEl.value!;
    shouldWait = (video) => video === standby;
    tick(4.2);
    await flush();
    tick(4.51);
    await flush();
    expect(preview.mediaReady.value).toBe(false);
    const old = pending[0];
    shouldWait = () => false;
    await preview.seek(0);
    old.finish();
    await flush();
    expect(old.signal.aborted).toBe(true);
    expect(preview.sampleTime.value).toBe(0);
    expect(preview.globalTime.value).toBe(0);
    expect(preview.mediaReady.value).toBe(true);
    expect(preview.playbackError.value).toBe("");
  });

  it.each([5.49, 5.5 - 1 / 30])("从 %s 秒采样跨入相接窗口时，先替换待命视频再允许合成", async (time) => {
    vi.useFakeTimers();
    setup(1, true);
    await preview.seek(time);
    await preview.play();
    const active = preview.activeVideoEl.value!;
    const standby = preview.standbyVideoEl.value!;
    expect(active.src).toBe("b.mp4");
    expect(standby.src).toBe("a.mp4");
    shouldWait = (video) => video === standby;
    const sourceTimeUs = Math.round((time - 5) * 1e6);
    preview.onFramePresented({
      generation: preview.renderGeneration.value,
      requestId: 1,
      clipId: "b",
      sourceTimeUs,
      timelineTimeSec: time,
      transitionId: "t",
      secondaryClipId: "b",
      secondarySourceTimeUs: sourceTimeUs,
    });
    await flush();
    await vi.advanceTimersByTimeAsync(40);
    expect(pending).toHaveLength(1);
    expect(pending[0].video).toBe(standby);
    expect(standby.src).toBe("c.mp4");
    expect(preview.mediaReady.value).toBe(false);
    expect(preview.sampleTime.value).toBe(time);
    pending[0].finish();
    await flush();
    expect(preview.mediaReady.value).toBe(true);
    expect(preview.activeVideoEl.value).toBe(active);
    expect(preview.sampleTime.value).toBeCloseTo(time + 1 / 30);
    expect(preview.playbackError.value).toBe("");
  });
});
