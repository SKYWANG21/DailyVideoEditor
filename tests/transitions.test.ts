import { afterEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createTransitionRegistry } from "../src/transitions/catalog";
import { TransitionRegistry } from "../src/transitions/registry";
import { TransitionEngine, transitionEasing } from "../src/transitions/engine";
import { crossfadeAlgorithm } from "../src/transitions/algorithms/crossfade";
import {
  MIN_TRANSITION_DURATION,
  normalizeTrackTransitions,
  resolveTransitionAtTime,
  resolveTransitionSeams,
  resolveTransitionTarget,
} from "../src/transitions/timing";
import { previewSourceTimeUs, previewSeekTimeSec } from "../src/hooks/previewSourceTime";
import { useTracksStore } from "../src/clip-track/stores/tracks";
import { useHistoryStore } from "../src/clip-track/stores/history";
import type { Track, MediaClip } from "../src/clip-track/types";
import type { ComposeTransition, TransitionClipRef } from "../src/types/transition";

/** 可复用的相邻主轨测试片段。 */
const clips: TransitionClipRef[] = [
  { id: "a", type: "video", startTime: 0, endTime: 5 },
  { id: "b", type: "video", startTime: 5, endTime: 10 },
  { id: "c", type: "video", startTime: 10, endTime: 15 },
];
const transition: ComposeTransition = {
  id: "t",
  clipAId: "a",
  clipBId: "b",
  effectId: "crossfade",
  durationSec: 1,
  params: { curve: "linear" },
};

describe("接缝时间与工程兼容", () => {
  it("中心窗口是半开区间，播放头、片段和总时长均不变化", () => {
    expect(resolveTransitionAtTime(clips, [transition], 4.49)).toBeNull();
    expect(resolveTransitionAtTime(clips, [transition], 4.5)?.progress).toBe(0);
    expect(resolveTransitionAtTime(clips, [transition], 5)?.progress).toBe(0.5);
    expect(resolveTransitionAtTime(clips, [transition], 5.5)).toBeNull();
    expect(clips[2].endTime).toBe(15);
  });
  it("间隙、重叠、非视频和不足一帧不提供手柄", () => {
    for (const delta of [-0.1, 0.1]) expect(resolveTransitionSeams([clips[0], { ...clips[1], startTime: 5 + delta }])).toHaveLength(0);
    expect(resolveTransitionSeams([clips[0], { ...clips[1], type: "audio" }])).toHaveLength(0);
    expect(resolveTransitionSeams([{ ...clips[0], startTime: 4.99 }, clips[1]])).toHaveLength(0);
  });
  it("短片段限制长度，两端转场不互相重叠", () => {
    const short = [clips[0], { ...clips[1], endTime: 5.2 }, { ...clips[2], startTime: 5.2 }];
    const values = normalizeTrackTransitions(short, [transition, { ...transition, id: "t2", clipAId: "b", clipBId: "c" }]);
    expect(values).toHaveLength(2);
    expect(values.every((item) => item.durationSec <= 0.201)).toBe(true);
    const a = resolveTransitionAtTime(short, values, 5);
    const b = resolveTransitionAtTime(short, values, 5.2);
    expect(a!.end).toBeLessThanOrEqual(b!.start + 1e-9);
  });
  it("去重、清理失效关联，并保留未知算法的持久化参数", () => {
    expect(normalizeTrackTransitions(clips, [transition, { ...transition, id: "duplicate" }])).toHaveLength(1);
    expect(normalizeTrackTransitions([clips[0], clips[2]], [transition])).toEqual([]);
    const custom = { ...transition, effectId: "future-effect", durationSec: -1, params: { seed: 42 } };
    expect(normalizeTrackTransitions(clips, [custom])[0]).toMatchObject({
      effectId: "future-effect",
      durationSec: MIN_TRANSITION_DURATION,
      params: { seed: 42 },
    });
    expect(normalizeTrackTransitions(clips)).toEqual([]);
  });
  it("双击目标按明确接缝、双选、单选、播放头顺序查找", () => {
    const seams = resolveTransitionSeams(clips);
    expect(resolveTransitionTarget(seams, seams[1].key, ["a"], 0)?.clipA.id).toBe("b");
    expect(resolveTransitionTarget(seams, null, ["b", "a"], 0)?.clipA.id).toBe("a");
    expect(resolveTransitionTarget(seams, null, ["c"], 0)?.clipA.id).toBe("b");
    expect(resolveTransitionTarget(seams, null, [], 5.05)?.clipA.id).toBe("a");
    expect(resolveTransitionTarget(seams, null, ["a", "c"], 5)).toBeUndefined();
    expect(resolveTransitionTarget(seams, null, [], 7)).toBeUndefined();
  });
  it("源时间包含裁剪和倍速，转场可见范围之外保持边缘", () => {
    const source = [
      { id: "a", title: "A", url: "a", durationSec: 5, startTime: 0, endTime: 5, trimStart: 3, trimEnd: 13, playbackRate: 2 },
    ];
    expect(previewSourceTimeUs(source, 0, -1)).toBe(3e6);
    expect(previewSourceTimeUs(source, 0, 2)).toBe(7e6);
    expect(previewSourceTimeUs(source, 0, 6)).toBe(13e6);
    expect(previewSeekTimeSec(source, 0, 6)).toBe(12.999);
  });
});

describe("算法注册与驱动", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("加载去重，失败可重试，新算法不修改引擎分发", async () => {
    const registry = new TransitionRegistry();
    const render = vi.fn();
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ render });
    registry.register({
      id: "custom",
      name: "自定义",
      description: "test",
      defaultParams: {},
      normalizeParams: (value) => ({ ...value }),
      load,
    });
    expect(load).not.toHaveBeenCalled();
    const first = registry.resolve("custom");
    expect(registry.resolve("custom")).toBe(first);
    await expect(first).rejects.toThrow("offline");
    await expect(registry.resolve("custom")).resolves.toEqual({ render });
    expect(load).toHaveBeenCalledTimes(2);
    await expect(registry.resolve("unknown")).rejects.toThrow("暂不支持");
  });
  it("失败的算法仍恢复状态，下一帧仍可运行", async () => {
    const ctx = { clearRect: vi.fn(), save: vi.fn(), restore: vi.fn() };
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        width: number;
        height: number;
        constructor(w: number, h: number) {
          this.width = w;
          this.height = h;
        }
        getContext() {
          return ctx;
        }
      },
    );
    const render = vi.fn().mockRejectedValueOnce(new Error("bad algorithm")).mockResolvedValue(undefined);
    const registry = new TransitionRegistry();
    registry.register({
      id: "custom",
      name: "test",
      description: "",
      defaultParams: {},
      normalizeParams: (value) => ({ ...value }),
      load: async () => ({ render }),
    });
    const engine = new TransitionEngine(registry);
    const request = {
      effectId: "custom",
      outgoing: {} as CanvasImageSource,
      incoming: {} as CanvasImageSource,
      width: 100,
      height: 100,
      progress: 2,
      params: {},
    };
    await expect(engine.render(request)).rejects.toThrow("bad algorithm");
    await engine.render(request);
    expect(ctx.save).toHaveBeenCalledTimes(2);
    expect(ctx.restore).toHaveBeenCalledTimes(2);
    expect(render.mock.calls[1][0].progress).toBe(1);
  });
  it("淡化使用加权加法，不用两次 source-over", () => {
    const commands: Array<{ alpha: number; mode: string }> = [];
    const ctx = {
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
      drawImage(): void {
        commands.push({ alpha: this.globalAlpha, mode: this.globalCompositeOperation });
      },
    };
    crossfadeAlgorithm.render(
      {
        ctx: ctx as unknown as OffscreenCanvasRenderingContext2D,
        outgoing: {} as CanvasImageSource,
        incoming: {} as CanvasImageSource,
        width: 2,
        height: 2,
        progress: 0.5,
      },
      {},
    );
    expect(commands).toEqual([
      { alpha: 0.5, mode: "source-over" },
      { alpha: 0.5, mode: "lighter" },
    ]);
    expect(transitionEasing(0.5, "ease-in")).toBe(0.25);
    expect(createTransitionRegistry().get("crossfade")?.normalizeParams({ curve: "bad" })).toEqual({ curve: "linear" });
  });
  it("原生输入按比例居中，A/B 分别使用独立适配缓冲", async () => {
    const draws: unknown[][] = [];
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        constructor(
          public width: number,
          public height: number,
        ) {}
        getContext() {
          return { clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), drawImage: (...args: unknown[]) => draws.push(args) };
        }
      },
    );
    const render = vi.fn();
    const registry = new TransitionRegistry();
    registry.register({
      id: "fit",
      name: "test",
      description: "",
      defaultParams: {},
      normalizeParams: () => ({}),
      load: async () => ({ render }),
    });
    await new TransitionEngine(registry).render({
      effectId: "fit",
      outgoing: { width: 50, height: 100 } as CanvasImageSource,
      incoming: { width: 100, height: 50 } as CanvasImageSource,
      width: 100,
      height: 100,
      progress: 0.5,
      params: {},
    });
    expect(draws[0].slice(1)).toEqual([25, 0, 50, 100]);
    expect(draws[1].slice(1)).toEqual([0, 25, 100, 50]);
    expect(render.mock.calls[0][0].outgoing).not.toBe(render.mock.calls[0][0].incoming);
  });
});

describe("历史与序列化", () => {
  it("转场随轨道保存、撤销重做和 clip 删除原子清理", () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const tracks = useTracksStore(pinia);
    const history = useHistoryStore(pinia);
    const track: Track = {
      id: "main",
      type: "video",
      isMain: true,
      name: "主轨",
      visible: true,
      locked: false,
      order: 0,
      clips: clips.map(
        (clip) =>
          ({ ...clip, trackId: "main", sourceUrl: clip.id, originalDuration: 5, trimStart: 0, trimEnd: 5, playbackRate: 1 }) as MediaClip,
      ),
    };
    tracks.setTracks([track]);
    history.initialize();
    tracks.updateTrack("main", { transitions: [transition] });
    history.pushSnapshot("添加转场");
    const saved: Track[] = JSON.parse(JSON.stringify(tracks.tracks));
    expect(saved[0].transitions?.[0]).toEqual(transition);
    history.undo();
    expect(tracks.tracks[0].transitions ?? []).toEqual([]);
    history.redo();
    expect(tracks.tracks[0].transitions?.[0]).toEqual(transition);
    tracks.removeClip("a");
    history.pushSnapshot("删除片段");
    expect(tracks.tracks[0].transitions).toEqual([]);
    history.undo();
    expect(tracks.tracks[0].transitions?.[0]).toEqual(transition);
    tracks.setTracks(saved);
    expect(tracks.tracks[0].transitions?.[0]).toEqual(transition);
  });
});
