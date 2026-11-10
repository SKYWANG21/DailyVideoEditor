import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTransitionRegistry } from "../src/transitions/catalog";
import { crossfadeAlgorithm } from "../src/transitions/algorithms/crossfade";
import { TransitionEngine } from "../src/transitions/engine";
import { loadWasmTransitionAlgorithm } from "../src/transitions/wasmAdapter";
import type { WasmTransitionExports } from "../src/types/transition";

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
  afterEach(() => vi.unstubAllGlobals());

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

  it("沿用引擎缓动，透明混合正确，尺寸变化与内存扩容后仍可绘制", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(wasm)),
    );
    vi.stubGlobal(
      "ImageData",
      class {
        constructor(
          public data: Uint8ClampedArray,
          public width: number,
          public height: number,
        ) {}
      },
    );
    let allocations = 0;
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        pixels: number[] = [];
        private source: { data: Uint8ClampedArray } | undefined;
        constructor(
          public width: number,
          public height: number,
        ) {
          allocations++;
        }
        getContext() {
          return {
            clearRect: (): void => {},
            save: (): void => {},
            restore: (): void => {},
            drawImage: (source: { data: Uint8ClampedArray }): void => {
              this.source = source;
            },
            getImageData: (): { data: Uint8ClampedArray } => this.source!,
            putImageData: (image: ImageData): void => {
              this.pixels = [...image.data];
            },
          };
        }
      },
    );
    const engine = new TransitionEngine(createTransitionRegistry({ backend: "wasm" }));
    /** 构造同尺寸像素源，避免引擎额外执行画幅适配。 */
    const source = (width: number, height: number, pixel: number[]): CanvasImageSource => {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < data.length; i += 4) data.set(pixel, i);
      return { width, height, data } as unknown as CanvasImageSource;
    };
    for (const [width, height] of [
      [1, 1],
      [256, 256],
      [2, 1],
    ]) {
      const request = {
        effectId: "crossfade",
        outgoing: source(width, height, [255, 0, 0, 255]),
        incoming: source(width, height, [0, 0, 255, 255]),
        width,
        height,
        progress: 0.5,
        params: { curve: "ease-in" },
      };
      const frame = (await engine.render(request)) as unknown as { pixels: number[] };
      expect(frame.pixels.slice(0, 4)).toEqual([191, 0, 64, 255]);
      expect(frame.pixels.slice(-4)).toEqual([191, 0, 64, 255]);
      const allocated = allocations;
      await engine.render({ ...request, incoming: source(width, height, [0, 0, 255, 0]), params: {} });
      expect(frame.pixels.slice(0, 4)).toEqual([255, 0, 0, 128]);
      expect(allocations).toBe(allocated);
    }
  });
});
