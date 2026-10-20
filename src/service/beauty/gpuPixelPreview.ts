import gpupixelScriptUrl from "@/algorithm/wasm/gpupixel.js?url";
import wasmUrl from "@/algorithm/wasm/gpupixel.wasm?url";
import dataUrl from "@/algorithm/wasm/gpupixel.data?url";
import type { BeautyParams } from "@/types/composeMedia";
import { beautyLevelsForFrame, beautyNeedsFace } from "@/types/beautyPreview";

/** 页面上 GPUPixel 独占的画布 id。创建前不能对它调用 getContext */
export const GPU_PIXEL_CANVAS_ID = "gpupixel_preview_canvas";

/** GPUPixel 滤镜链。结果直接画到创建时绑定的 canvas */
interface GpuPixelPipeline {
  /** 处理一帧 RGBA。ptr 指向 WASM 堆 */
  process(ptr: number, width: number, height: number): void;
  /** 写入 MediaPipe 归一化坐标。空数组表示这一帧没有脸 */
  setMediaPipeLandmarks(flatXy: number[]): void;
  /** 磨皮 0–10 */
  setSmooth(value: number): void;
  /** 美白 0–10 */
  setWhiten(value: number): void;
  /** 瘦脸 0–10 */
  setSlim(value: number): void;
  /** 大眼 0–10 */
  setEye(value: number): void;
}

/** createGpuPixelModule 返回的运行时 */
interface GpuPixelModule {
  /** 在已有 canvas 上创建 WebGL2。参数是 id 或 CSS 选择器 */
  create(canvasId: string): GpuPixelPipeline;
  /** 在 WASM 堆上分配字节 */
  _malloc(size: number): number;
  /** 释放 WASM 堆指针 */
  _free(ptr: number): void;
  /** 线性内存视图。扩容后必须重新读取 */
  HEAPU8: Uint8Array;
}

/** gpupixel.js 的加载函数 */
type CreateGpuPixelModule = (options?: { locateFile?: (file: string) => string }) => Promise<GpuPixelModule>;

/** 把 .wasm / .data 指到 Vite 产出的地址 */
function locateGpuPixelFile(file: string): string {
  if (file.endsWith(".wasm")) return wasmUrl;
  if (file.endsWith(".data")) return dataUrl;
  return file;
}

/** 经典脚本会把 var createGpuPixelModule 挂到全局 */
type GpuPixelGlobal = typeof globalThis & { createGpuPixelModule?: CreateGpuPixelModule };

let loadingCreate: Promise<CreateGpuPixelModule> | null = null;

/**
 * 以经典脚本加载胶水代码。
 * 这个文件没有 ESM export，直接 import 会得到空模块。
 */
function loadCreateGpuPixelModule(): Promise<CreateGpuPixelModule> {
  if (!loadingCreate) {
    loadingCreate = new Promise((resolve, reject) => {
      const existing = (globalThis as GpuPixelGlobal).createGpuPixelModule;
      if (typeof existing === "function") {
        resolve(existing);
        return;
      }
      const script = document.createElement("script");
      script.src = gpupixelScriptUrl;
      script.async = true;
      script.onload = () => {
        const created = (globalThis as GpuPixelGlobal).createGpuPixelModule;
        if (typeof created === "function") resolve(created);
        else reject(new Error("GPUPixel 加载器不可用"));
      };
      script.onerror = () => {
        loadingCreate = null;
        reject(new Error("GPUPixel 脚本加载失败"));
      };
      document.head.appendChild(script);
    });
  }
  return loadingCreate;
}

/**
 * 主线程美颜绘制。
 * 模块的 WebGL 上下文只会绑到第一次 create 的那块 canvas。
 */
export class GpuPixelPreview {
  private module: GpuPixelModule | null = null;
  private pipeline: GpuPixelPipeline | null = null;
  private heapPtr = 0;
  private heapCap = 0;
  private loading: Promise<void> | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  /** 加载 wasm 并在当前 canvas 上创建滤镜链 */
  init(): Promise<void> {
    if (!this.loading) this.loading = this.load();
    return this.loading;
  }

  /**
   * 把一帧画到 canvas。
   * 美颜关闭时强度为 0，仍然走 process，避免换 WebGL 上下文。
   */
  draw(rgba: Uint8Array, width: number, height: number, beauty: BeautyParams, landmarks: Float32Array<ArrayBufferLike>): void {
    const pipeline = this.pipeline;
    const module = this.module;
    if (!pipeline || !module || width <= 0 || height <= 0) return;
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    const levels = beautyLevelsForFrame(beauty);
    pipeline.setSmooth(levels.smooth);
    pipeline.setWhiten(levels.whiten);
    pipeline.setSlim(levels.slim);
    pipeline.setEye(levels.eye);
    const useFace = beautyNeedsFace(beauty) && landmarks.length >= 910;
    pipeline.setMediaPipeLandmarks(useFace ? Array.from(landmarks) : []);
    const ptr = this.upload(module, rgba);
    pipeline.process(ptr, width, height);
  }

  /** 加载查找表并创建管道。失败时下次 init 可以重试 */
  private async load(): Promise<void> {
    try {
      if (!this.canvas.id) this.canvas.id = GPU_PIXEL_CANVAS_ID;
      const createGpuPixelModule = await loadCreateGpuPixelModule();
      const module = await createGpuPixelModule({ locateFile: locateGpuPixelFile });
      this.module = module;
      this.pipeline = module.create(`#${this.canvas.id}`);
    } catch (error) {
      this.loading = null;
      throw error;
    }
  }

  /** 复用 WASM 堆缓冲，只在分辨率变大时重新分配 */
  private upload(module: GpuPixelModule, rgba: Uint8Array): number {
    if (rgba.byteLength > this.heapCap) {
      if (this.heapPtr) module._free(this.heapPtr);
      this.heapPtr = module._malloc(rgba.byteLength);
      this.heapCap = rgba.byteLength;
    }
    module.HEAPU8.set(rgba, this.heapPtr);
    return this.heapPtr;
  }
}

let sharedPreview: GpuPixelPreview | null = null;

/**
 * 取得与这块 canvas 绑定的 GPUPixel。
 * 已绑定过别的元素时仍返回旧实例，因为 wasm 不能改绑画布。
 */
export function acquireGpuPixelPreview(canvas: HTMLCanvasElement): GpuPixelPreview {
  if (!sharedPreview) sharedPreview = new GpuPixelPreview(canvas);
  return sharedPreview;
}
