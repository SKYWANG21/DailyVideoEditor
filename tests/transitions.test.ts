import { afterEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createTransitionRegistry, crossfadeDefinition } from "../src/transitions/catalog";
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
import type { ComposeTransition, TransitionClipRef, TransitionEffectDefinition } from "../src/types/transition";

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

/** 内置效果的持久化标识与素材目录顺序。 */
const builtinEffectIds: readonly string[] = [
  "crossfade",
  "zoom-in",
  "fade-black",
  "zoom-out",
  "blinds",
  "blinds-diagonal",
  "wipe-right",
  "wipe-left",
  "split-open",
  "shake",
];

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

describe("宿主转场注册", () => {
  it("按顺序追加只读效果列表，WASM 内置后端不替换宿主实现，查询目录不加载算法", async () => {
    const load = vi.fn(async () => crossfadeAlgorithm);
    const effects: readonly TransitionEffectDefinition[] = Object.freeze([
      { ...crossfadeDefinition, id: "host-a", load },
      { ...crossfadeDefinition, id: "host-b", load },
    ]);
    const registry = createTransitionRegistry({ backend: "wasm", effects });
    expect(registry.list().map((effect) => effect.id)).toEqual([...builtinEffectIds, "host-a", "host-b"]);
    expect(effects.map((effect) => effect.id)).toEqual(["host-a", "host-b"]);
    expect(load).not.toHaveBeenCalled();
    const first = registry.resolve("host-a");
    expect(registry.resolve("host-a")).toBe(first);
    await expect(first).resolves.toBe(crossfadeAlgorithm);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("宿主 ID 不得覆盖内置效果或另一宿主效果", () => {
    expect(() => createTransitionRegistry({ effects: [crossfadeDefinition] })).toThrow("转场已注册：crossfade");
    expect(() => createTransitionRegistry({ effects: [{ ...crossfadeDefinition, id: "zoom-in" }] })).toThrow("转场已注册：zoom-in");
    const custom = { ...crossfadeDefinition, id: "host-a" };
    expect(() => createTransitionRegistry({ effects: [custom, custom] })).toThrow("转场已注册：host-a");
  });

  it("编辑器实例不共享注册结果和算法加载缓存", async () => {
    const load = vi.fn(async () => ({ render: vi.fn() }));
    const effects = [{ ...crossfadeDefinition, id: "host-a", load }];
    const first = createTransitionRegistry({ effects });
    const second = createTransitionRegistry({ effects });
    const firstAlgorithm = await first.resolve("host-a");
    expect(await first.resolve("host-a")).toBe(firstAlgorithm);
    expect(await second.resolve("host-a")).not.toBe(firstAlgorithm);
    expect(load).toHaveBeenCalledTimes(2);
    first.register({ ...crossfadeDefinition, id: "first-only" });
    expect(second.get("first-only")).toBeUndefined();
    expect(
      createTransitionRegistry()
        .list()
        .map((effect) => effect.id),
    ).toEqual(builtinEffectIds);
  });
});

describe("Canvas 内置转场目录", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("全部效果共享曲线约定，只接受现有合法曲线", () => {
    const registry = createTransitionRegistry();
    expect(registry.list().map((effect) => effect.id)).toEqual(builtinEffectIds);
    for (const definition of registry.list()) {
      expect(definition.defaultParams).toEqual({ curve: "linear" });
      expect(definition.normalizeParams({ curve: "unknown", unused: 1 })).toEqual({ curve: "linear" });
      for (const curve of ["linear", "ease", "ease-in", "ease-out", "ease-in-out"]) {
        expect(definition.normalizeParams({ curve })).toEqual({ curve });
      }
    }
  });

  it("默认 Canvas 不下载 WASM，查询 WASM 目录不加载算法且为各效果提供独立加载器", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const canvas = createTransitionRegistry();
    const wasm = createTransitionRegistry({ backend: "wasm" });
    expect(wasm.list().map((effect) => effect.id)).toEqual(builtinEffectIds);
    for (const id of builtinEffectIds.slice(1)) {
      const pending = canvas.resolve(id);
      expect(canvas.resolve(id)).toBe(pending);
      const algorithm = await pending;
      expect(typeof algorithm.render).toBe("function");
      expect(wasm.get(id)?.load).not.toBe(canvas.get(id)?.load);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("算法注册与驱动", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("注册表释放已加载算法，销毁后的加载结果也释放且不会继续使用", async () => {
    const dispose = vi.fn();
    const registry = createTransitionRegistry({
      effects: [{ ...crossfadeDefinition, id: "disposable", load: async () => ({ render: vi.fn(), dispose }) }],
    });
    await registry.resolve("disposable");
    registry.dispose();
    registry.dispose();
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce();
    await expect(registry.resolve("disposable")).rejects.toThrow("已释放");
    let release!: (algorithm: { render: () => void; dispose: () => void }) => void;
    const pendingRegistry = createTransitionRegistry({
      effects: [
        {
          ...crossfadeDefinition,
          id: "late",
          load: () =>
            new Promise((resolve) => {
              release = resolve;
            }),
        },
      ],
    });
    const pending = pendingRegistry.resolve("late");
    await Promise.resolve();
    pendingRegistry.dispose();
    release({ render: vi.fn(), dispose });
    await expect(pending).rejects.toThrow("已释放");
    expect(dispose).toHaveBeenCalledTimes(2);
  });
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
