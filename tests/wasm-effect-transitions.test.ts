import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTransitionRegistry } from "../src/transitions/catalog";
import type { WasmTransitionExports } from "../src/types/transition";

/** 与各独立产物名称相同的稳定效果标识。 */
const ids = ["zoom-in", "fade-black", "zoom-out", "blinds", "blinds-diagonal", "wipe-right", "wipe-left", "split-open", "shake"] as const;
type EffectId = (typeof ids)[number];

/** 直接读取提交的内核产物，测试不依赖浏览器、编译器或宿主导入。 */
const binaries = new Map(
  await Promise.all(ids.map(async (id) => [id, await readFile(new URL(`../src/transitions/wasm/${id}.wasm`, import.meta.url))] as const)),
);

/** 创建无宿主导入的独立内核。 */
async function kernel(id: EffectId): Promise<WasmTransitionExports> {
  const module = await WebAssembly.compile(binaries.get(id)!);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  return (await WebAssembly.instantiate(module)).exports as unknown as WasmTransitionExports;
}

/** 为输入、输出复用线性内存，并立即复制本帧结果，避免下一帧覆盖断言数据。 */
function render(core: WasmTransitionExports, width: number, height: number, a: Uint8Array, b: Uint8Array, progress: number): Uint8Array {
  const base = core.__heap_base.value as number;
  const size = width * height * 4;
  const required = base + size * 3;
  if (required > core.memory.buffer.byteLength) core.memory.grow(Math.ceil((required - core.memory.buffer.byteLength) / 65536));
  const bytes = new Uint8Array(core.memory.buffer);
  bytes.set(a, base);
  bytes.set(b, base + size);
  expect(core.render(base, base + size, base + size * 2, width, height, progress, base + size * 3, 0)).toBe(0);
  return bytes.slice(base + size * 2, base + size * 3);
}

/** 构造纯色 RGBA8 输入；透明颜色也用于检查反预乘和区域替换。 */
function solid(width: number, height: number, color: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < bytes.length; offset += 4) bytes.set(color, offset);
  return bytes;
}

/** 逐字节检查完整帧，避免通用对象深比较遍历大图像的属性开销。 */
function expectPixels(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  const mismatch = actual.findIndex((value, index) => value !== expected[index]);
  expect(mismatch, `像素字节 ${mismatch}：实际 ${actual[mismatch]}，预期 ${expected[mismatch]}`).toBe(-1);
}

describe("九种独立 WASM 转场内核", () => {
  it.each(ids)("%s 的端点、进度限制与无效尺寸", async (id) => {
    const core = await kernel(id);
    const a = solid(17, 11, [220, 30, 50, 128]);
    const b = solid(17, 11, [20, 80, 240, 192]);
    for (const progress of [-1, 0, Number.NaN]) expect(render(core, 17, 11, a, b, progress)).toEqual(a);
    for (const progress of [1, 2]) expect(render(core, 17, 11, a, b, progress)).toEqual(b);
    expect(core.render(0, 0, 0, 0, 1, 0.5, 0, 0)).toBe(1);
    expect(core.render(0, 0, 0, 0x7fffffff, 2, 0.5, 0, 0)).toBe(1);
  });

  it.each(ids)("%s 保持亮度、透明语义与尺寸变化后的输出", async (id) => {
    const core = await kernel(id);
    for (const [width, height] of [
      [1, 1],
      [65, 37],
      [37, 65],
      [256, 256],
      [2, 1],
    ]) {
      const white = solid(width, height, [255, 255, 255, 255]);
      const transparent = solid(width, height, [200, 50, 30, 0]);
      const half = solid(width, height, [20, 100, 220, 128]);
      for (const progress of [0.01, 0.25, 0.5, 0.75, 0.99]) {
        const brightness = id === "fade-black" ? Math.round(255 * Math.abs(2 * progress - 1)) : 255;
        expectPixels(render(core, width, height, white, white, progress), solid(width, height, [brightness, brightness, brightness, 255]));
        if (id !== "fade-black") {
          expectPixels(render(core, width, height, transparent, transparent, progress), solid(width, height, [0, 0, 0, 0]));
          expectPixels(render(core, width, height, half, half, progress), half);
        }
      }
    }
  });

  it.each(["wipe-right", "wipe-left", "split-open"] as const)("%s 的方向、分数像素边界及透明 B 区域替换", async (id) => {
    const core = await kernel(id);
    const red = solid(8, 4, [255, 0, 0, 255]);
    const transparent = solid(8, 4, [0, 0, 255, 0]);
    const result = render(core, 8, 4, red, transparent, 0.25);
    for (let x = 0; x < 8; x++) {
      const incoming = id === "wipe-right" ? x < 2 : id === "wipe-left" ? x >= 6 : x === 3 || x === 4;
      expect([...result.slice(x * 4, x * 4 + 4)]).toEqual(incoming ? [0, 0, 0, 0] : [255, 0, 0, 255]);
    }
    const fractional = render(core, 3, 1, solid(3, 1, [255, 0, 0, 255]), solid(3, 1, [0, 0, 255, 255]), 0.5);
    if (id !== "split-open") expect([...fractional.slice(4, 8)]).toEqual([128, 0, 128, 255]);
    else expect([...fractional.slice(4, 8)]).toEqual([0, 0, 255, 255]);
  });

  it("水平百叶分成十条，倾斜百叶沿 45° 同向延伸", async () => {
    const horizontal = await kernel("blinds");
    const diagonal = await kernel("blinds-diagonal");
    const a = solid(80, 40, [255, 0, 0, 255]),
      b = solid(80, 40, [0, 0, 255, 255]);
    const straight = render(horizontal, 80, 40, a, b, 0.5);
    for (let y = 0; y < 40; y++)
      expect([...straight.slice(y * 80 * 4, y * 80 * 4 + 4)]).toEqual(y % 4 < 2 ? [0, 0, 255, 255] : [255, 0, 0, 255]);
    const tilted = render(diagonal, 80, 40, a, b, 0.5);
    for (let y = 0; y < 39; y++)
      for (let x = 0; x < 79; x++) {
        const offset = (y * 80 + x) * 4,
          next = ((y + 1) * 80 + x + 1) * 4;
        expect(tilted.slice(offset, offset + 4)).toEqual(tilted.slice(next, next + 4));
      }
    expect(tilted.some((value, index) => index % 4 === 0 && value === 255)).toBe(true);
    expect(tilted.some((value, index) => index % 4 === 2 && value === 255)).toBe(true);
  });

  it.each(["zoom-in", "zoom-out"] as const)("%s 镜像铺满四周，并对整个输出统一叠化", async (id) => {
    const core = await kernel(id);
    const image = solid(400, 240, [0, 0, 0, 255]);
    for (let y = 0; y < 240; y++) for (let x = 20; x < 100; x++) image.set([255, 0, 0, 255], (y * 400 + x) * 4);
    const blank = solid(400, 240, [0, 0, 0, 0]);
    const mirrored = render(core, 400, 240, id === "zoom-in" ? blank : image, id === "zoom-in" ? image : blank, 0.5);
    expect([...mirrored.slice((120 * 400 + 20) * 4, (120 * 400 + 20) * 4 + 4)]).toEqual([255, 0, 0, 128]);
    expect(mirrored.every((value, index) => index % 4 !== 3 || value === 128)).toBe(true);
    const mix = render(core, 400, 240, solid(400, 240, [255, 0, 0, 255]), solid(400, 240, [0, 0, 255, 255]), 0.25);
    expectPixels(mix, solid(400, 240, [191, 0, 64, 255]));
  });
});

describe("内置 WASM 注册与按需加载", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("九种内置效果分别下载对应内核，加载任务去重且不使用 Canvas 实现", async () => {
    const fetch = vi.fn(async (url: string | URL) => {
      const id = new URL(String(url)).pathname.split("/").at(-1)!.replace(".wasm", "") as EffectId;
      return new Response(binaries.get(id));
    });
    vi.stubGlobal("fetch", fetch);
    const canvas = createTransitionRegistry(),
      wasm = createTransitionRegistry({ backend: "wasm" });
    expect(wasm.list()).toHaveLength(10);
    expect(fetch).not.toHaveBeenCalled();
    for (const id of ids) {
      const pending = wasm.resolve(id);
      expect(wasm.resolve(id)).toBe(pending);
      expect(await pending).not.toBe(await canvas.resolve(id));
    }
    expect(fetch).toHaveBeenCalledTimes(9);
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname.split("/").at(-1))).toEqual(ids.map((id) => `${id}.wasm`));
  });
});
