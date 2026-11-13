import type { TransitionInputKeys, WasmTransitionExports } from "@/types/transition";
import type { TransitionWorkerEvent, TransitionWorkerRequest } from "@/types/transitionWorker";

/** 独立 Worker 消息接口，避免把 DOM 与 WebWorker 全局类型混合。 */
export interface TransitionWorkerScope {
  onmessage: ((event: MessageEvent<TransitionWorkerRequest>) => void) | null;
  postMessage(message: TransitionWorkerEvent, transfer?: Transferable[]): void;
}

/** 各效果独占内存和像素版本，共用一个线程与读写画布。 */
interface KernelState {
  core: WasmTransitionExports;
  base: number;
  width: number;
  height: number;
  inputKeys?: TransitionInputKeys;
}

/** 在 Worker 串行执行消息；可独立测试实际消息处理与像素内核。 */
export class TransitionWorkerRuntime {
  private kernels = new Map<number, KernelState>();
  private encoder = new TextEncoder();
  private input: OffscreenCanvasRenderingContext2D | null = null;
  private output: OffscreenCanvasRenderingContext2D | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly post: TransitionWorkerScope["postMessage"]) {}

  /** 不允许不同请求交错使用共享画布。 */
  accept(message: TransitionWorkerRequest): void {
    this.queue = this.queue.then(() => this.handle(message));
  }

  /** 验证并实例化通用 ABI，不依赖浏览器宿主导入。 */
  private async load(kernelId: number, buffer: ArrayBuffer): Promise<void> {
    const { instance } = await WebAssembly.instantiate(buffer, {});
    const exports = instance.exports;
    if (
      !(exports.memory instanceof WebAssembly.Memory) ||
      !(exports.__heap_base instanceof WebAssembly.Global) ||
      typeof exports.__heap_base.value !== "number" ||
      typeof exports.render !== "function"
    )
      throw new Error("转场 WASM 缺少 memory、__heap_base 或 render 导出");
    const core = exports as unknown as WasmTransitionExports;
    this.kernels.set(kernelId, { core, base: core.__heap_base.value as number, width: 0, height: 0 });
  }

  /** 读回、输入复制、JSON 编码和全部像素计算都留在 Worker。 */
  private render(message: Extract<TransitionWorkerRequest, { type: "render" }>): ImageBitmap {
    const state = this.kernels.get(message.kernelId);
    if (!state) throw new Error("转场 WASM 内核未加载或已释放");
    const { width, height, progress, params, inputKeys } = message;
    const length = width * height * 4;
    const parameters = this.encoder.encode(JSON.stringify(params));
    const outputPointer = state.base + length * 2;
    const paramsPointer = outputPointer + length;
    const required = paramsPointer + parameters.byteLength;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || required > 0x7fffffff) {
      throw new Error("转场 WASM 输入尺寸无效或超出内存范围");
    }
    const previousKeys = state.width === width && state.height === height ? state.inputKeys : undefined;
    // 任一输入读回失败时，不能继续把已被部分覆盖的缓存标记为有效。
    state.inputKeys = undefined;
    if (required > state.core.memory.buffer.byteLength)
      state.core.memory.grow(Math.ceil((required - state.core.memory.buffer.byteLength) / 65536));
    const bytes = new Uint8Array(state.core.memory.buffer);
    if (!this.input) this.input = new OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
    if (!this.output) this.output = new OffscreenCanvas(width, height).getContext("2d");
    const input = this.input,
      output = this.output;
    if (!input || !output) throw new Error("转场 Worker 画布不可用");
    if (input.canvas.width !== width) input.canvas.width = width;
    if (input.canvas.height !== height) input.canvas.height = height;
    if (output.canvas.width !== width) output.canvas.width = width;
    if (output.canvas.height !== height) output.canvas.height = height;
    for (const [slot, name] of (["outgoing", "incoming"] as const).entries()) {
      if (inputKeys && inputKeys[name] === previousKeys?.[name]) continue;
      input.clearRect(0, 0, width, height);
      input.drawImage(message[name], 0, 0, width, height);
      bytes.set(input.getImageData(0, 0, width, height).data, state.base + slot * length);
    }
    state.width = width;
    state.height = height;
    state.inputKeys = inputKeys;
    bytes.set(parameters, paramsPointer);
    const status = state.core.render(
      state.base,
      state.base + length,
      outputPointer,
      width,
      height,
      progress,
      paramsPointer,
      parameters.byteLength,
    );
    if (status !== 0) throw new Error(`转场 WASM 渲染失败：${status}`);
    const pixels = new Uint8ClampedArray(state.core.memory.buffer, outputPointer, length);
    output.putImageData(new ImageData(pixels, width, height), 0, 0);
    return output.canvas.transferToImageBitmap();
  }

  /** 异常只拒绝当前任务，成功、失败最终都归还输入快照。 */
  private async handle(message: TransitionWorkerRequest): Promise<void> {
    if (message.type === "release") {
      this.kernels.delete(message.kernelId);
      return;
    }
    try {
      if (message.type === "load") {
        await this.load(message.kernelId, message.buffer);
        this.post({ type: "ready", requestId: message.requestId });
      } else {
        const bitmap = this.render(message);
        try {
          this.post({ type: "frame", requestId: message.requestId, bitmap }, [bitmap]);
        } catch (error: unknown) {
          bitmap.close();
          throw error;
        }
      }
    } catch (error: unknown) {
      this.post({ type: "error", requestId: message.requestId, message: error instanceof Error ? error.message : "转场 Worker 处理失败" });
    } finally {
      if (message.type === "render") {
        message.outgoing.close();
        message.incoming.close();
      }
    }
  }
}
