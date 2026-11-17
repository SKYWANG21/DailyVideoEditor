import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { useComposePreviewFrame } from "../src/hooks/useComposePreviewFrame";
import type { VideoAdjustmentWorkerClient } from "../src/hooks/videoAdjustmentWorkerClient";
import type { DecodedPreviewFrame, PreviewFrameRenderer, PreviewRenderRequest } from "../src/types/previewPlayback";
import { readVideoAdjustments } from "../src/types/videoAdjustments";

const mocks = vi.hoisted(() => ({ render: vi.fn<VideoAdjustmentWorkerClient["render"]>() }));
vi.mock("vue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue")>()),
  inject: (_key: unknown, fallback: unknown) => fallback,
  onUnmounted: vi.fn(),
}));
vi.mock("../src/editor/composeRuntime", () => ({ COMPOSE_ALGORITHM_BASE: Symbol(), useComposeTransitionRegistry: vi.fn() }));
vi.mock("../src/transitions/engine", () => ({ TransitionEngine: class {} }));
vi.mock("../src/hooks/composeFrameProcessor", () => ({ ComposeFrameProcessor: class {} }));
vi.mock("../src/hooks/videoAdjustmentWorkerClient", () => ({
  VideoAdjustmentWorkerClient: class {
    render = mocks.render;
    reset = vi.fn();
    dispose = vi.fn();
  },
}));

/** 用画面标记模拟像素拷贝，区分原始帧、调色帧和独立快照。 */
class FakeCanvas {
  pixels = "";
  context = {
    clearRect: (): void => {
      this.pixels = "";
    },
    drawImage: (source: { pixels: string }): void => {
      this.pixels = source.pixels;
    },
    save: vi.fn(),
    restore: vi.fn(),
    scale: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
  };
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  /** 同一画布始终复用上下文，以复现原地覆盖。 */
  getContext(): typeof this.context {
    return this.context;
  }
}

/** 快照保留创建时的画面，不跟随源画布变化。 */
function bitmap(pixels: string, width = 8, height = 8): ImageBitmap & { pixels: string } {
  return { pixels, width, height, close: vi.fn() };
}

/** 所有请求保持同一片段和播放代次，仅改变源帧时间与请求序号。 */
function request(sourceTimeUs: number, requestId: number, size = 8): PreviewRenderRequest {
  const outgoing: DecodedPreviewFrame = {
    bitmap: bitmap(`raw-${sourceTimeUs}`, size, size),
    sourceTimeUs,
    sourceSize: { width: size, height: size },
    retain: () => outgoing,
    release: vi.fn(),
  };
  return {
    identity: { generation: 1, clipId: "clip", sourceTimeUs, requestId },
    time: sourceTimeUs / 1e6,
    duration: 1 / 30,
    clipIndex: 0,
    outgoing,
  };
}

describe("预览图层缓存与画面一致性", () => {
  let renderer: PreviewFrameRenderer;

  beforeEach(() => {
    vi.stubGlobal("OffscreenCanvas", FakeCanvas);
    vi.stubGlobal("createImageBitmap", async (canvas: FakeCanvas) => bitmap(canvas.pixels, canvas.width, canvas.height));
    mocks.render.mockReset().mockImplementation(async (_canvas, _adjustments, frame) => bitmap(`graded-${frame.sourceTimeUs}`));
    ({ renderer } = useComposePreviewFrame({
      canvas: ref(null),
      gpuCanvas: ref(null),
      clips: ref([{ id: "clip", title: "Clip", url: "clip.mp4", durationSec: 5, adjustments: readVideoAdjustments({ brightness: 10 }) }]),
      transitionTrack: ref(undefined),
      canvasSize: ref(null),
      frame: ref(null),
      beautyReady: ref(false),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("成功帧仍可命中缓存，下一帧复用画布但不会覆盖已完成快照", async () => {
    const first = await renderer.render(request(1000, 1), new AbortController().signal);
    const cached = await renderer.render(request(1000, 2), new AbortController().signal);
    expect(cached.bitmap).toMatchObject({ pixels: "graded-1000" });
    expect(mocks.render).toHaveBeenCalledTimes(1);

    const next = await renderer.render(request(2000, 3), new AbortController().signal);
    expect(mocks.render.mock.calls[1][0]).toBe(mocks.render.mock.calls[0][0]);
    expect(first.bitmap).toMatchObject({ pixels: "graded-1000" });
    expect(next.bitmap).toMatchObject({ pixels: "graded-2000" });
    const nextCached = await renderer.render(request(2000, 4), new AbortController().signal);
    expect(nextCached.bitmap).toMatchObject({ pixels: "graded-2000" });
    expect(mocks.render).toHaveBeenCalledTimes(2);
  });

  it.each(["取消拒绝", "取消后迟到结果", "处理失败"] as const)("%s后重新请求旧帧必须重新调色", async (mode) => {
    const first = await renderer.render(request(1000, 1), new AbortController().signal);
    const controller = new AbortController();
    const late = bitmap("graded-2000");
    let settle!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    mocks.render.mockImplementationOnce(
      () =>
        new Promise<ImageBitmap>((resolve, reject) => {
          settle = (): void => {
            if (mode === "取消后迟到结果") resolve(late);
            else reject(mode === "取消拒绝" ? controller.signal.reason : new Error("调色失败"));
          };
          started();
        }),
    );
    const pending = renderer.render(request(2000, 2), controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: mode === "处理失败" ? "Error" : "AbortError" });
    await waiting;
    expect(mocks.render.mock.calls[1][0]).toBe(mocks.render.mock.calls[0][0]);
    expect(mocks.render.mock.calls[1][0]).toMatchObject({ pixels: "raw-2000" });
    if (mode !== "处理失败") controller.abort();
    settle();
    await rejected;
    if (mode === "取消后迟到结果") expect(late.close).toHaveBeenCalledTimes(1);
    expect(first.bitmap).toMatchObject({ pixels: "graded-1000" });

    // 不调用 reset，也不改变 generation，避免清空缓存掩盖错误命中。
    const retried = await renderer.render(request(1000, 3), new AbortController().signal);
    expect(retried.bitmap).toMatchObject({ pixels: "graded-1000" });
    expect(mocks.render).toHaveBeenCalledTimes(3);
    const cached = await renderer.render(request(1000, 4), new AbortController().signal);
    expect(cached.bitmap).toMatchObject({ pixels: "graded-1000" });
    expect(mocks.render).toHaveBeenCalledTimes(3);
  });

  it("尺寸变化使用新画布，处理失败后旧画布缓存仍可复用", async () => {
    await renderer.render(request(1000, 1), new AbortController().signal);
    mocks.render.mockRejectedValueOnce(new Error("调色失败"));
    await expect(renderer.render(request(2000, 2, 16), new AbortController().signal)).rejects.toThrow("调色失败");
    expect(mocks.render.mock.calls[1][0]).not.toBe(mocks.render.mock.calls[0][0]);
    const cached = await renderer.render(request(1000, 3), new AbortController().signal);
    expect(cached.bitmap).toMatchObject({ pixels: "graded-1000" });
    expect(mocks.render).toHaveBeenCalledTimes(2);
  });
});
