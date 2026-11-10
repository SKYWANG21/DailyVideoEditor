import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTransitionRegistry } from "../src/transitions/catalog";
import { crossfadeAlgorithm } from "../src/transitions/algorithms/crossfade";
import { TransitionEngine } from "../src/transitions/engine";
import { loadWasmTransitionAlgorithm } from "../src/transitions/wasmAdapter";
import type { WasmTransitionExports } from "../src/types/transition";
import { installTransitionCanvasMocks, MockBitmap, MockTransitionWorker, reads } from "./helpers/transitionWorker";

vi.mock("../src/workers/transition.worker.ts?worker&inline", async () => {
  const { MockTransitionWorker } = await import("./helpers/transitionWorker");
  return { default: MockTransitionWorker };
});

const wasm = await readFile(new URL("../src/transitions/wasm/crossfade.wasm", import.meta.url));

/** 使用实际编译产物，验证浏览器之外无需宿主导入也能计算。 */
async function kernel(): Promise<WasmTransitionExports> {
  const module = await WebAssembly.compile(wasm);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const exports = (await WebAssembly.instantiate(module)).exports as unknown as WasmTransitionExports;
  exports.memory.grow(1);
  return exports;
}

describe("独立 WASM 淡化内核", () => {
  it("两端点、中点、透明与半透明像素遵守预乘颜色混合", async () => {
    const { memory, __heap_base, render } = await kernel();
    const base = __heap_base.value as number;
    const bytes = new Uint8Array(memory.buffer);
    bytes.set([255, 0, 0, 255, 255, 0, 0, 128, 255, 255, 255, 0], base);
    bytes.set([0, 0, 255, 255, 0, 0, 255, 0, 255, 255, 255, 0], base + 12);
    for (const [progress, expected] of [
      [0, [255, 0, 0, 255, 255, 0, 0, 128, 0, 0, 0, 0]],
      [0.5, [128, 0, 128, 255, 255, 0, 0, 64, 0, 0, 0, 0]],
      [1, [0, 0, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0]],
    ] as const) {
      expect(render(base, base + 12, base + 24, 3, 1, progress, base + 36, 0)).toBe(0);
      expect([...bytes.subarray(base + 24, base + 36)]).toEqual(expected);
    }
  });

  it("权重固定为 Q16，输出使用加权 Alpha 反预乘", async () => {
    const { memory, __heap_base, render } = await kernel();
    const base = __heap_base.value as number;
    const bytes = new Uint8Array(memory.buffer);
    bytes.set([200, 80, 30, 64, 20, 100, 220, 192], base);
    render(base, base + 4, base + 8, 1, 1, 0.25, base + 12, 0);
    expect([...bytes.subarray(base + 8, base + 12)]).toEqual([110, 90, 125, 96]);
  });
});

describe("WASM 适配器与注册表", () => {
  beforeEach(installTransitionCanvasMocks);
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("默认 Canvas 不下载 WASM；选择 WASM 后按需加载、缓存，失败可重试", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockImplementation(async () => new Response(wasm));
    vi.stubGlobal("fetch", fetch);
    expect(await createTransitionRegistry().resolve("crossfade")).toBe(crossfadeAlgorithm);
    expect(fetch).not.toHaveBeenCalled();
    const registry = createTransitionRegistry({ backend: "wasm" });
    expect(registry.list().map((effect) => effect.id)).toEqual([
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
    ]);
    expect(fetch).not.toHaveBeenCalled();
    await expect(registry.resolve("crossfade")).rejects.toThrow("HTTP 503");
    const pending = registry.resolve("crossfade");
    expect(registry.resolve("crossfade")).toBe(pending);
    expect(await pending).not.toBe(crossfadeAlgorithm);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("拒绝缺少约定导出的模块", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))),
    );
    await expect(loadWasmTransitionAlgorithm("/invalid.wasm")).rejects.toThrow("缺少 memory");
  });

  it("沿用缓动且主线程不读回像素，内存扩容和尺寸变化后仍可绘制", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(wasm)),
    );
    const registry = createTransitionRegistry({ backend: "wasm" });
    const engine = new TransitionEngine(registry);
    for (const [width, height] of [
      [1, 1],
      [256, 256],
      [2, 1],
    ]) {
      const a = new Uint8ClampedArray(width * height * 4),
        b = new Uint8ClampedArray(a.length);
      for (let i = 0; i < a.length; i += 4) {
        a.set([255, 0, 0, 255], i);
        b.set([0, 0, 255, 255], i);
      }
      const outgoing = new MockBitmap(a, width, height),
        incoming = new MockBitmap(b, width, height);
      const request = {
        effectId: "crossfade",
        outgoing: outgoing as unknown as CanvasImageSource,
        incoming: incoming as unknown as CanvasImageSource,
        width,
        height,
        progress: 0.5,
        params: { curve: "ease-in" },
      };
      const frame = (await engine.render(request)) as unknown as { pixels: number[] };
      expect(frame.pixels.slice(0, 4)).toEqual([191, 0, 64, 255]);
      expect(frame.pixels.slice(-4)).toEqual([191, 0, 64, 255]);
      expect(outgoing.close).not.toHaveBeenCalled();
      expect(incoming.close).not.toHaveBeenCalled();
    }
    registry.dispose();
    await Promise.resolve();
    expect(MockTransitionWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });

  it("按像素版本复用输入，单侧更新只读回一侧，尺寸改变与省略版本会使缓存失效", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(wasm)),
    );
    const registry = createTransitionRegistry({ backend: "wasm" });
    const engine = new TransitionEngine(registry);
    const source = (pixel: number[], width = 1): CanvasImageSource => {
      const data = new Uint8ClampedArray(width * 4);
      for (let i = 0; i < data.length; i += 4) data.set(pixel, i);
      return new MockBitmap(data, width, 1) as unknown as CanvasImageSource;
    };
    const request = {
      effectId: "crossfade",
      outgoing: source([255, 0, 0, 255]),
      incoming: source([0, 0, 255, 255]),
      width: 1,
      height: 1,
      progress: 0.5,
      params: {},
      inputKeys: { outgoing: "a1", incoming: "b1" },
    };
    await engine.render(request);
    expect(reads.count).toBe(2);
    await engine.render({ ...request, progress: 0.25 });
    expect(reads.count).toBe(2);
    const updated = { ...request, incoming: source([0, 255, 0, 255]), inputKeys: { outgoing: "a1", incoming: "b2" } };
    const frame = (await engine.render(updated)) as unknown as { pixels: number[] };
    expect(frame.pixels).toEqual([128, 128, 0, 255]);
    expect(reads.count).toBe(3);
    await engine.render({ ...updated, width: 2, outgoing: source([255, 0, 0, 255], 2), incoming: source([0, 255, 0, 255], 2) });
    expect(reads.count).toBe(5);
    await engine.render({ ...request, inputKeys: undefined });
    await engine.render({ ...request, inputKeys: undefined });
    expect(reads.count).toBe(9);
    registry.dispose();
  });

  it("部分读回失败后使缓存失效，下一帧不会误用被覆盖的旧输入", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(wasm)),
    );
    const algorithm = await loadWasmTransitionAlgorithm("/crossfade.wasm");
    const ctx = { drawImage: vi.fn() } as unknown as OffscreenCanvasRenderingContext2D;
    const a = new MockBitmap(new Uint8ClampedArray([255, 0, 0, 255]), 1, 1);
    const b = new MockBitmap(new Uint8ClampedArray([0, 0, 255, 255]), 1, 1);
    const context = {
      ctx,
      outgoing: a as unknown as CanvasImageSource,
      incoming: b as unknown as CanvasImageSource,
      width: 1,
      height: 1,
      progress: 0.5,
      inputKeys: { outgoing: "a", incoming: "b" },
    };
    await algorithm.render(context, {});
    const broken = new MockBitmap(b.data, 1, 1);
    broken.badRead = true;
    await expect(
      algorithm.render({ ...context, incoming: broken as unknown as CanvasImageSource, inputKeys: { outgoing: "a2", incoming: "b2" } }, {}),
    ).rejects.toThrow("read failed");
    const before = reads.count;
    await algorithm.render(context, {});
    expect(reads.count - before).toBe(2);
    algorithm.dispose?.();
  });

  it("线程超时会拒绝等待并终止线程，不在主线程回退执行 WASM", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(wasm)),
    );
    const algorithm = await loadWasmTransitionAlgorithm("/crossfade.wasm");
    MockTransitionWorker.instances[0].silent = true;
    vi.useFakeTimers();
    const bitmap = new MockBitmap(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1);
    const promise = algorithm.render(
      {
        ctx: { drawImage: vi.fn() } as unknown as OffscreenCanvasRenderingContext2D,
        outgoing: bitmap as unknown as CanvasImageSource,
        incoming: bitmap as unknown as CanvasImageSource,
        width: 1,
        height: 1,
        progress: 0.5,
      },
      {},
    );
    const assertion = expect(promise).rejects.toThrow("处理超时");
    await vi.advanceTimersByTimeAsync(8001);
    await assertion;
    expect(MockTransitionWorker.instances[0].terminate).toHaveBeenCalledOnce();
    algorithm.dispose?.();
  });

  it("销毁注册表时取消仍在下载的内核，立即释放已加载的共享线程", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL, options?: RequestInit) => {
        if (String(url).endsWith("crossfade.wasm")) return Promise.resolve(new Response(wasm));
        return new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
        });
      }),
    );
    const registry = createTransitionRegistry({ backend: "wasm" });
    await registry.resolve("crossfade");
    const pending = registry.resolve("zoom-in");
    await Promise.resolve();
    registry.dispose();
    expect(MockTransitionWorker.instances[0].terminate).toHaveBeenCalledOnce();
    await expect(pending).rejects.toThrow("cancelled");
    expect(MockTransitionWorker.instances).toHaveLength(1);
  });

  it("输入快照有一侧失败时释放另一侧快照，不关闭调用方的输入", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(wasm)),
    );
    const algorithm = await loadWasmTransitionAlgorithm("/crossfade.wasm");
    const borrowed = new MockBitmap(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1);
    const owned = new MockBitmap(borrowed.data.slice(), 1, 1);
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValueOnce(owned).mockRejectedValueOnce(new Error("capture failed")));
    await expect(
      algorithm.render(
        {
          ctx: {} as OffscreenCanvasRenderingContext2D,
          outgoing: borrowed as unknown as CanvasImageSource,
          incoming: borrowed as unknown as CanvasImageSource,
          width: 1,
          height: 1,
          progress: 0.5,
        },
        {},
      ),
    ).rejects.toThrow("capture failed");
    expect(owned.close).toHaveBeenCalledOnce();
    expect(borrowed.close).not.toHaveBeenCalled();
    algorithm.dispose?.();
  });

  it("消息发送失败只拒绝当前帧，共享线程仍能处理后续请求", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(wasm)),
    );
    const algorithm = await loadWasmTransitionAlgorithm("/crossfade.wasm");
    const worker = MockTransitionWorker.instances[0];
    const post = vi.spyOn(worker, "postMessage").mockImplementationOnce(() => {
      throw new Error("clone failed");
    });
    const bitmap = new MockBitmap(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1);
    const context = {
      ctx: { drawImage: vi.fn() } as unknown as OffscreenCanvasRenderingContext2D,
      outgoing: bitmap as unknown as CanvasImageSource,
      incoming: bitmap as unknown as CanvasImageSource,
      width: 1,
      height: 1,
      progress: 0.5,
    };
    await expect(algorithm.render(context, {})).rejects.toThrow("clone failed");
    await algorithm.render(context, {});
    expect(worker.terminate).not.toHaveBeenCalled();
    post.mockRestore();
    algorithm.dispose?.();
  });
});
