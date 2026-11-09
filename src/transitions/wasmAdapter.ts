import type { TransitionAlgorithm, WasmTransitionExports } from "@/types/transition";

/** 加载独立 WASM 像素内核，包装成现有 Canvas 引擎可调用的算法。 */
export async function loadWasmTransitionAlgorithm(url: string | URL): Promise<TransitionAlgorithm> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`转场 WASM 加载失败：HTTP ${response.status}`);
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {});
  const exports = instance.exports;
  if (
    !(exports.memory instanceof WebAssembly.Memory) ||
    !(exports.__heap_base instanceof WebAssembly.Global) ||
    typeof exports.__heap_base.value !== "number" ||
    typeof exports.render !== "function"
  ) {
    throw new Error("转场 WASM 缺少 memory、__heap_base 或 render 导出");
  }
  const kernel = exports as unknown as WasmTransitionExports;
  const base = kernel.__heap_base.value as number;
  const encoder = new TextEncoder();
  let scratch: OffscreenCanvas | undefined;
  let input: OffscreenCanvasRenderingContext2D | null = null;

  return {
    /** 复用读回画布与线性内存；透明度混合由内核处理，适配器不重复缓动。 */
    render({ ctx, outgoing, incoming, width, height, progress }, params): void {
      const byteLength = width * height * 4;
      const parameters = encoder.encode(JSON.stringify(params));
      const output = base + byteLength * 2;
      const paramsPointer = output + byteLength;
      const required = paramsPointer + parameters.byteLength;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || required > 0x7fffffff) {
        throw new Error("转场 WASM 输入尺寸无效或超出内存范围");
      }
      if (required > kernel.memory.buffer.byteLength) {
        kernel.memory.grow(Math.ceil((required - kernel.memory.buffer.byteLength) / 65536));
      }
      // grow 会使旧视图失效，每次渲染从当前 buffer 创建视图。
      const bytes = new Uint8Array(kernel.memory.buffer);
      if (!scratch || scratch.width !== width || scratch.height !== height) {
        scratch = new OffscreenCanvas(width, height);
        input = scratch.getContext("2d", { willReadFrequently: true });
      }
      if (!input) throw new Error("转场 WASM 像素读取画布不可用");
      for (const [slot, source] of [outgoing, incoming].entries()) {
        input.clearRect(0, 0, width, height);
        input.drawImage(source, 0, 0, width, height);
        bytes.set(input.getImageData(0, 0, width, height).data, base + slot * byteLength);
      }
      bytes.set(parameters, paramsPointer);
      const status = kernel.render(base, base + byteLength, output, width, height, progress, paramsPointer, parameters.byteLength);
      if (status !== 0) throw new Error(`转场 WASM 渲染失败：${status}`);
      const pixels = new Uint8ClampedArray(kernel.memory.buffer, output, byteLength);
      ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
    },
  };
}
