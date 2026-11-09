import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref, shallowRef, type EffectScope, type Ref } from "vue";
import { useVideoComposePreview } from "../src/hooks/useVideoComposePreview";
import { createPreviewPlaybackClock } from "../src/hooks/previewPlaybackClock";
import { createDefaultComposeConfig } from "../src/types/composeMedia";
import type { PreviewFrameRenderer, PreviewPlaybackClock, PreviewRenderRequest } from "../src/types/previewPlayback";
import type { PreviewAudioClip, VideoClipItem } from "../src/types/videoCompose";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  running: vi.fn(),
  reset: vi.fn(),
  audio: { ready: vi.fn(), prepare: vi.fn(), sync: vi.fn(), refresh: vi.fn(), pauseAll: vi.fn(), destroy: vi.fn() },
}));
vi.mock("../src/hooks/previewVideoDecoder", () => ({
  PreviewVideoDecoder: class {
    acquire = mocks.acquire;
    setRunning = mocks.running;
    reset = mocks.reset;
    dispose = vi.fn();
    prewarm = vi.fn();
    protectedIndices = (_clips: unknown, indices: number[]) => indices;
  },
}));
vi.mock("../src/editor/composeRuntime", () => ({ useComposeMediaResolver: () => ({}) }));
vi.mock("../src/editor/shared/videoFrame", () => ({ readVideoFrameTransform: () => null }));
vi.mock("../src/hooks/previewMediaGain", () => ({ primePreviewAudioContext: vi.fn() }));
vi.mock("../src/hooks/previewAudioMixer", () => ({ createPreviewAudioMixer: () => mocks.audio }));
vi.mock("vue", async (importOriginal) => ({ ...(await importOriginal<typeof import("vue")>()), onUnmounted: vi.fn() }));

/** 可控异步算法，用于复现持续卡顿而不阻塞测试线程。 */
function gate() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    release: () => resolve(),
  };
}

describe("连续生产与画面提交时钟", () => {
  let scope: EffectScope;
  let preview: ReturnType<typeof useVideoComposePreview>;
  let renderer: PreviewFrameRenderer;
  let callbacks: Map<number, FrameRequestCallback>;
  let now: number;
  let videoClips: Ref<VideoClipItem[]>;
  let audioClips: Ref<PreviewAudioClip[]>;
  let clock: PreviewPlaybackClock;

  beforeEach(() => {
    scope = effectScope();
    callbacks = new Map();
    now = 0;
    let sequence = 0;
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.set(++sequence, callback);
      return sequence;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
    vi.spyOn(performance, "now").mockImplementation(() => now);
    Object.values(mocks.audio).forEach((mock) => mock.mockReset());
    mocks.audio.prepare.mockResolvedValue(undefined);
    mocks.audio.ready.mockReturnValue(true);
    mocks.acquire.mockReset().mockImplementation(async (_clips: unknown, _index: number, time: number) => ({
      sourceTimeUs: Math.round(time * 1e6),
      sourceSize: { width: 320, height: 180 },
      bitmap: {},
      release: vi.fn(),
      retain: vi.fn(),
    }));
    renderer = {
      warmup: vi.fn(async () => undefined),
      reset: vi.fn(),
      present: vi.fn(),
      render: vi.fn(async (request: PreviewRenderRequest) => ({
        identity: request.identity,
        time: request.time,
        duration: request.duration,
        clipIndex: request.clipIndex,
        sourceSize: { width: 320, height: 180 },
        bitmap: { close: vi.fn() } as unknown as ImageBitmap,
      })),
    };
    const clips: VideoClipItem[] = [{ id: "a", title: "A", url: "a.mp4", durationSec: 5, startTime: 0, endTime: 5 }];
    videoClips = ref(clips);
    audioClips = ref([]);
    clock = createPreviewPlaybackClock();
    preview = scope.run(() =>
      useVideoComposePreview({
        clock: ref(clock),
        videoA: shallowRef({} as HTMLVideoElement),
        videoB: shallowRef({} as HTMLVideoElement),
        bgmEl: shallowRef(null),
        clips: videoClips,
        audioClips,
        config: ref(createDefaultComposeConfig()),
        previewMuted: ref(false),
        transitionTrack: ref(undefined),
        renderer: shallowRef(renderer),
      }),
    )!;
  });

  afterEach(() => {
    preview.destroy();
    scope.stop();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function flush(): Promise<void> {
    for (let index = 0; index < 100; index += 1) await Promise.resolve();
    await nextTick();
  }

  async function tick(wallTime: number): Promise<void> {
    now = wallTime;
    const [id, callback] = callbacks.entries().next().value!;
    callbacks.delete(id);
    callback(wallTime);
    await flush();
  }

  async function start(): Promise<void> {
    await preview.seek(0);
    await preview.play();
    await flush();
    await tick(0);
  }

  it("处理可提前六帧，但游标只在可见画面提交后推进，原声不使用 video 播放", async () => {
    await start();
    expect(preview.previewStats.maxQueued).toBe(6);
    expect(preview.globalTime.value).toBe(0);
    expect(renderer.present).toHaveBeenCalledTimes(1);
    await tick(34);
    expect(preview.globalTime.value).toBeCloseTo(1 / 30);
    expect(renderer.present).toHaveBeenCalledTimes(2);
    expect(mocks.audio.prepare.mock.calls[0][0].originalAudioClips[0]).toMatchObject({ id: "a", url: "a.mp4", volume: 0.8 });
    expect(preview.renderGeneration.value).toBe(1);
  });

  it("共享时钟只在展示成功后变化，失败画面不会提前推动时间轴", async () => {
    await preview.seek(1);
    expect(clock.presentedTime).toBe(1);
    const revision = clock.revision;
    vi.mocked(renderer.present).mockImplementation(() => {
      expect(clock.presentedTime).toBe(1);
      throw new Error("展示失败");
    });
    await preview.seek(2);
    expect(clock.presentedTime).toBe(1);
    expect(clock.revision).toBe(revision);
    expect(clock.state).toBe("error");
  });

  it("完成队列满后降到三帧才恢复生产，不能每腾出一帧就启停解码", async () => {
    await start();
    const produced = preview.previewStats.produced;
    await tick(34);
    await tick(67);
    expect(preview.previewStats.produced).toBe(produced);
    await tick(100);
    expect(preview.previewStats.produced).toBeGreaterThan(produced);
    expect(preview.previewStats.maxQueued).toBe(6);
  });

  it("算法异步阻塞 500ms 时游标和音频共同等待，恢复不追赶墙钟", async () => {
    await start();
    const blocked = gate();
    const original = vi.mocked(renderer.render).getMockImplementation()!;
    vi.mocked(renderer.render).mockImplementation(async (...args) => {
      await blocked.promise;
      return original(...args);
    });
    for (const time of [34, 67, 100, 134, 167, 200, 234]) await tick(time);
    expect(preview.playbackState.value).toBe("buffering");
    const frozen = preview.globalTime.value;
    const pauses = mocks.audio.pauseAll.mock.calls.length;
    await tick(734);
    expect(preview.globalTime.value).toBe(frozen);
    expect(mocks.audio.pauseAll).toHaveBeenCalledTimes(pauses);
    blocked.release();
    await flush();
    await tick(750);
    await tick(751);
    expect(preview.globalTime.value - frozen).toBeCloseTo(1 / 30);
    expect(preview.playbackState.value).toBe("playing");
    expect(mocks.audio.prepare).toHaveBeenCalledTimes(2);
  });

  it("快速定位不提前写目标时间，取消代次的迟到结果关闭且不覆盖新位置", async () => {
    await preview.seek(0);
    const blocked = gate();
    const original = vi.mocked(renderer.render).getMockImplementation()!;
    const late: ImageBitmap[] = [];
    vi.mocked(renderer.render).mockImplementation(async (...args) => {
      if (args[0].time === 1) await blocked.promise;
      const result = await original(...args);
      if (args[0].time === 1) late.push(result.bitmap!);
      return result;
    });
    const old = preview.seek(1);
    await flush();
    expect(preview.globalTime.value).toBe(0);
    const latest = preview.seek(2);
    blocked.release();
    await Promise.all([old, latest]);
    expect(preview.globalTime.value).toBe(2);
    expect(vi.mocked(renderer.present).mock.calls.map(([frame]) => frame.time)).toEqual([0, 2]);
    expect(late[0].close).toHaveBeenCalledTimes(1);
  });

  it("暂停续播保留完成队列，不重建解码代次，也不让旧续播任务自行启动", async () => {
    await start();
    const generation = preview.renderGeneration.value;
    preview.pause();
    const presented = preview.previewStats.presented;
    await flush();
    expect(preview.isPlaying.value).toBe(false);
    expect(preview.previewStats.presented).toBe(presented);
    await preview.play();
    await tick(1000);
    await tick(1034);
    expect(preview.renderGeneration.value).toBe(generation);
    expect(preview.globalTime.value).toBeCloseTo(1 / 30);
  });

  it("播放中处理失败后可重新播放，不复用已取消的代次或陷入重试空转", async () => {
    await start();
    vi.mocked(renderer.render).mockRejectedValueOnce(new Error("处理失败"));
    await tick(34);
    await tick(67);
    await tick(100);
    expect(preview.playbackState.value).toBe("error");
    expect(preview.isPlaying.value).toBe(false);
    await preview.play();
    await flush();
    expect(preview.renderGeneration.value).toBe(2);
    expect(preview.isPlaying.value).toBe(true);
    expect(preview.playbackError.value).toBe("");
  });

  it("音量和原声分离只刷新音频，不打断解码或重建视频代次", async () => {
    await start();
    const generation = preview.renderGeneration.value;
    videoClips.value[0].volume = 0.2;
    await flush();
    expect(preview.renderGeneration.value).toBe(generation);
    expect(mocks.audio.refresh.mock.lastCall![0].originalAudioClips[0].volume).toBe(0.2);
    videoClips.value[0].audioDetached = true;
    await flush();
    expect(preview.renderGeneration.value).toBe(generation);
    expect(mocks.audio.refresh.mock.lastCall![0].originalAudioClips).toEqual([]);
  });

  it("等待下一张原始帧时暂停会立即取消生产等待，续播不重置解码代次", async () => {
    await start();
    const acquire = mocks.acquire.getMockImplementation()!;
    let pendingSignal: AbortSignal | undefined;
    mocks.acquire.mockImplementationOnce(async (...args) => {
      pendingSignal = args[5] as AbortSignal;
      await new Promise<void>((_resolve, reject) =>
        pendingSignal!.addEventListener("abort", () => reject(new DOMException("暂停", "AbortError")), { once: true }),
      );
      return acquire(...args);
    });
    await tick(34);
    await tick(67);
    await tick(100);
    expect(pendingSignal?.aborted).toBe(false);
    preview.pause();
    await flush();
    expect(pendingSignal?.aborted).toBe(true);
    expect(preview.playbackState.value).toBe("paused");
    expect(preview.playbackError.value).toBe("");
    await preview.play();
    await tick(1000);
    await tick(1034);
    expect(preview.renderGeneration.value).toBe(1);
    expect(preview.isPlaying.value).toBe(true);
  });

  it("音频缺数据也必须共同缓冲，准备完成前不提交下一张画面", async () => {
    await start();
    const audio = gate();
    mocks.audio.ready.mockReturnValue(false);
    mocks.audio.prepare.mockImplementationOnce(async () => {
      await audio.promise;
    });
    await tick(34);
    expect(preview.playbackState.value).toBe("buffering");
    expect(preview.globalTime.value).toBe(0);
    await tick(534);
    expect(preview.globalTime.value).toBe(0);
    mocks.audio.ready.mockReturnValue(true);
    audio.release();
    await flush();
    await tick(535);
    expect(preview.globalTime.value).toBeCloseTo(1 / 30);
  });

  it("片尾不足三帧也能播放到终点，结束保留最后画面", async () => {
    await preview.seek(4.99);
    await preview.play();
    await flush();
    await tick(0);
    await tick(11);
    expect(preview.globalTime.value).toBe(5);
    expect(preview.playbackState.value).toBe("ended");
    expect(preview.isPlaying.value).toBe(false);
  });

  it("纯音频使用同一展示时钟，不需要 video 槽或可见 Canvas", async () => {
    videoClips.value = [];
    audioClips.value = [{ id: "audio", url: "a.mp3", startTime: 0, endTime: 1, trimStart: 0, volume: 1, playbackRate: 1 }];
    await flush();
    await preview.seek(0);
    await preview.play();
    await flush();
    await tick(0);
    await tick(34);
    expect(preview.isAudioOnlyPreview.value).toBe(true);
    expect(preview.globalTime.value).toBeCloseTo(1 / 30);
    expect(preview.playbackError.value).toBe("");
  });

  it("真实空隙提交黑色帧，跨入下一片段时才更新片段身份", async () => {
    videoClips.value = [
      { id: "a", title: "A", url: "a.mp4", durationSec: 1, startTime: 0, endTime: 1 },
      { id: "b", title: "B", url: "b.mp4", durationSec: 1, startTime: 2, endTime: 3 },
    ];
    await flush();
    await preview.seek(1.5);
    expect(preview.inGap.value).toBe(true);
    await preview.play();
    await flush();
    await tick(0);
    for (let index = 1; index <= 16; index += 1) await tick((index * 1000) / 30 + 0.1);
    expect(preview.globalTime.value).toBeGreaterThanOrEqual(2);
    expect(preview.inGap.value).toBe(false);
    expect(preview.currentIdx.value).toBe(1);
  });
});
