/// <reference types="@webgpu/types" />

import type { VideoLayerSize, VideoLayerUpscaleRequest, VideoLayerUpscaler } from "@/types/videoExport";
import { edgeDetectShaderSource, edgeDirectedShaderSource, lanczosShaderSource } from "./openReelUpscaleShaders";

/** OpenReel balanced 的三个计算管线，每任务复用一次。 */
interface UpscalePipelines {
  lanczos: GPUComputePipeline;
  edgeDetect: GPUComputePipeline;
  edgeDirected: GPUComputePipeline;
}

/** 逐帧运行 OpenReel 的 Lanczos 与边缘处理，GPU 出错交给导出会话处理。 */
export class OpenReelUpscaler implements VideoLayerUpscaler {
  private device: GPUDevice | null = null;
  private pipelines: UpscalePipelines | null = null;
  private unavailable = false;

  /** 用实际输入输出尺寸跑一次 GPU 路径，避免只按 navigator.gpu 显示档位。 */
  async probe(sourceSize: VideoLayerSize, targetSize: VideoLayerSize, signal: AbortSignal): Promise<boolean> {
    try {
      await this.initialize(signal);
      const canvas = new OffscreenCanvas(sourceSize.width, sourceSize.height);
      if (!canvas.getContext("2d")) return false;
      const probe = canvas.transferToImageBitmap();
      try {
        const result = await this.upscale({ frame: probe, targetSize, clipId: "", sourceTimeUs: 0, resetHistory: true, signal });
        result.close();
        return true;
      } finally {
        probe.close();
      }
    } catch {
      signal.throwIfAborted();
      return false;
    }
  }

  /** 顺序提交水平和垂直重采样、边缘检测、沿边缘平滑。 */
  async upscale({ frame, targetSize, signal }: VideoLayerUpscaleRequest): Promise<ImageBitmap> {
    signal.throwIfAborted();
    const device = this.device;
    const pipelines = this.pipelines;
    if (!device || !pipelines) throw new Error("WebGPU 增强放大不可用");
    const { width, height } = targetSize;
    const textures: GPUTexture[] = [];
    const buffers: GPUBuffer[] = [];
    device.pushErrorScope("validation");
    let result: ImageBitmap | undefined;
    try {
      const texture = (w: number, h: number): GPUTexture => {
        const value = device.createTexture({
          size: [w, h],
          format: "rgba8unorm",
          usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.STORAGE_BINDING |
            GPUTextureUsage.COPY_SRC |
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.RENDER_ATTACHMENT,
        });
        textures.push(value);
        return value;
      };
      const source = texture(frame.width, frame.height);
      const horizontal = texture(width, frame.height);
      const resized = texture(width, height);
      const edges = texture(width, height);
      const output = texture(width, height);
      device.queue.copyExternalImageToTexture({ source: frame }, { texture: source }, [frame.width, frame.height]);
      const encoder = device.createCommandEncoder();
      const pass = (pipeline: GPUComputePipeline, inputs: GPUTexture[], destination: GPUTexture, values: number[]): void => {
        const buffer = device.createBuffer({ size: values.length * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        buffers.push(buffer);
        device.queue.writeBuffer(buffer, 0, new Uint32Array(values));
        dispatch(device, encoder, pipeline, [...inputs, destination], buffer);
      };
      pass(pipelines.lanczos, [source], horizontal, [frame.width, frame.height, width, height, 0, 0, 0, 0]);
      pass(pipelines.lanczos, [horizontal], resized, [width, frame.height, width, height, 1, 0, 0, 0]);
      pass(pipelines.edgeDetect, [resized], edges, [width, height, 0, 0]);
      pass(pipelines.edgeDirected, [resized, edges], output, [width, height, 0, 0]);
      result = await readTexture(device, encoder, output);
      signal.throwIfAborted();
      return result;
    } finally {
      for (const buffer of buffers) buffer.destroy();
      for (const texture of textures) texture.destroy();
      const error = await device.popErrorScope();
      if (error || signal.aborted) {
        result?.close();
        signal.throwIfAborted();
        throw new Error(error?.message ?? "增强放大已取消");
      }
    }
  }

  /** 结束任务后销毁设备和管线。 */
  dispose(): void {
    this.device?.destroy();
    this.device = null;
    this.pipelines = null;
  }

  /** WebGPU 仅在允许增强放大时初始化，设备不支持时缓存探测结果。 */
  private async initialize(signal: AbortSignal): Promise<void> {
    if (this.pipelines) return;
    if (this.unavailable) throw new Error("当前环境没有可用的 WebGPU 增强放大");
    this.unavailable = true;
    const adapter = await navigator.gpu?.requestAdapter();
    signal.throwIfAborted();
    if (!adapter) throw new Error("当前环境不支持 WebGPU");
    const device = await adapter.requestDevice();
    this.device = device;
    /** 在初始化阶段返回着色器编译错误。 */
    const pipeline = (code: string): Promise<GPUComputePipeline> =>
      device.createComputePipelineAsync({
        layout: "auto",
        compute: { module: device.createShaderModule({ code }), entryPoint: "main" },
      });
    this.pipelines = {
      lanczos: await pipeline(lanczosShaderSource),
      edgeDetect: await pipeline(edgeDetectShaderSource),
      edgeDirected: await pipeline(edgeDirectedShaderSource),
    };
    signal.throwIfAborted();
  }
}

/** 绑定纹理和尺寸参数并提交一个计算通道。 */
function dispatch(
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  pipeline: GPUComputePipeline,
  textures: GPUTexture[],
  uniform: GPUBuffer,
): void {
  const output = textures[textures.length - 1];
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      ...textures.map((texture, binding) => ({ binding, resource: texture.createView() })),
      { binding: textures.length, resource: { buffer: uniform } },
    ],
  });
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(output.width / 16), Math.ceil(output.height / 16));
  pass.end();
}

/** 读回 GPU 纹理并移除每行对齐填充。 */
async function readTexture(device: GPUDevice, encoder: GPUCommandEncoder, output: GPUTexture): Promise<ImageBitmap> {
  const { width, height } = output;
  const row = width * 4;
  const bytesPerRow = Math.ceil(row / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    encoder.copyTextureToBuffer({ texture: output }, { buffer, bytesPerRow }, [width, height]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(buffer.getMappedRange());
    const pixels = new Uint8ClampedArray(row * height);
    for (let y = 0; y < height; y += 1) pixels.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + row), y * row);
    return createImageBitmap(new ImageData(pixels, width, height));
  } finally {
    buffer.destroy();
  }
}
