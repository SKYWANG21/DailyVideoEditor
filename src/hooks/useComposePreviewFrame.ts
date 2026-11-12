import { computed, inject, onUnmounted, ref, type Ref } from "vue";
import { readBeautyParams } from "@/types/composeMedia";
import type { PreviewVideoSize } from "@/types/beautyPreview";
import type { ComposeFrameCapture, PresentedComposeFrame } from "@/types/frameCapture";
import type { ComposeTrack, VideoClipItem, VideoFrameTransform } from "@/types/videoCompose";
import type { DecodedPreviewFrame, PreparedPreviewFrame, PreviewFrameRenderer, PreviewRenderRequest } from "@/types/previewPlayback";
import { COMPOSE_ALGORITHM_BASE, useComposeTransitionRegistry } from "@/editor/composeRuntime";
import { readVideoFrameTransform } from "@/editor/shared/videoFrame";
import { TransitionEngine } from "@/transitions/engine";
import { ComposeFrameProcessor } from "./composeFrameProcessor";
import { drawPreviewCanvasFrame, previewCanvasSize } from "./previewCanvasFrame";

/** 仅处理固定快照和展示完成帧，不再持有 video、播放时钟或定位职责。 */
interface UseComposePreviewFrameOptions {
  /** 唯一可见画布。 */
  canvas: Ref<HTMLCanvasElement | null>;
  /** 播放器独占的 GPU 资源。 */
  gpuCanvas: Ref<HTMLCanvasElement | null>;
  /** 当前工程或素材库预览的片段。 */
  clips: Ref<VideoClipItem[]>;
  /** 主轨变换，素材库单片为空。 */
  transitionTrack: Ref<ComposeTrack | undefined>;
  /** 原项目坐标尺寸，不等于缩小后的输出像素。 */
  canvasSize: Ref<PreviewVideoSize | null>;
  /** 单片预览的兼容变换。 */
  frame: Ref<VideoFrameTransform | null | undefined>;
  /** 美颜预热状态只用于显示与测试，不接管播放时钟。 */
  beautyReady: Ref<boolean>;
  /** 当前展示时钟的来源，供截图识别素材时间和工程时间。 */
  captureSource?: Readonly<Ref<ComposeFrameCapture["source"]>>;
}

/** 原生、美颜与转场共享处理链，只有 present 能写入屏幕画布。 */
export function useComposePreviewFrame(options: UseComposePreviewFrameOptions) {
  const algorithmBase = inject(
    COMPOSE_ALGORITHM_BASE,
    computed(() => "/algorithm/"),
  );
  const registry = useComposeTransitionRegistry();
  const engine = new TransitionEngine(registry);
  const videoSize = ref<PreviewVideoSize | null>(null);
  const frameReady = ref(false);
  const previewError = ref("");
  const layers = new Map<string, { key: string; canvas: OffscreenCanvas }>();
  let processor: ComposeFrameProcessor | null = null;
  let processorCanvas: HTMLCanvasElement | null = null;
  let blank: OffscreenCanvas | null = null;
  let presentedFrame: PresentedComposeFrame | null = null;
  let disposed = false;
  let revision = 0;

  /** 解码槽换源不重建美颜资源，只有 GPU 节点本身变化才释放。 */
  function ensureProcessor(): ComposeFrameProcessor | null {
    const target = options.gpuCanvas.value;
    if (!target) return null;
    if (target !== processorCanvas) {
      processor?.dispose();
      processorCanvas = target;
      processor = new ComposeFrameProcessor(target, algorithmBase.value, (message, fallback) => {
        previewError.value = message;
        if (fallback) options.beautyReady.value = false;
      });
    }
    return processor;
  }

  /** 当前和即将进入的片段并入一次美颜预热，模型与 Worker 仅初始化一次。 */
  async function warmup(indices: readonly number[]): Promise<void> {
    if (disposed) return;
    const token = revision;
    const levels = indices.map((index) => readBeautyParams(options.clips.value[index]?.beauty));
    const ready = (await ensureProcessor()?.warmup(levels)) ?? false;
    if (!disposed && token === revision && levels.some((level) => level.enabled)) options.beautyReady.value = ready;
  }

  /** 两侧各有一份图层；源 PTS 不变时复用边界美颜和变换结果。 */
  async function layer(
    index: number,
    source: DecodedPreviewFrame,
    request: PreviewRenderRequest,
    signal: AbortSignal,
  ): Promise<OffscreenCanvas> {
    const clip = options.clips.value[index];
    if (!clip) throw new Error("视频片段已不存在");
    const project = options.canvasSize.value ?? source.sourceSize;
    const size = previewCanvasSize(project.width, project.height);
    const trackClip = options.transitionTrack.value?.clips.find((item) => item.id === clip.id);
    const frame = trackClip ? readVideoFrameTransform(trackClip.config) : options.frame.value;
    const beauty = readBeautyParams(clip.beauty);
    const key = JSON.stringify([request.identity.generation, source.sourceTimeUs, size, project, frame, beauty]);
    const cached = layers.get(clip.id);
    if (cached?.key === key) return cached.canvas;
    const prepared =
      (await ensureProcessor()?.process(
        source.bitmap,
        beauty,
        {
          ...request.identity,
          clipId: clip.id,
          sourceTimeUs: source.sourceTimeUs,
        },
        signal,
      )) ?? source.bitmap;
    signal.throwIfAborted();
    const canvas =
      cached?.canvas.width === size.width && cached.canvas.height === size.height
        ? cached.canvas
        : new OffscreenCanvas(size.width, size.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("预览画布不可用");
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.save();
    ctx.scale(size.width / project.width, size.height / project.height);
    drawPreviewCanvasFrame(ctx, prepared, source.sourceSize.width, source.sourceSize.height, project.width, project.height, frame);
    ctx.restore();
    layers.delete(clip.id);
    layers.set(clip.id, { key, canvas });
    while (layers.size > 2) layers.delete(layers.keys().next().value!);
    return canvas;
  }

  /** 生成独立快照入完成队列，后续 GPU/Canvas 重用不会覆盖它。 */
  async function render(request: PreviewRenderRequest, signal: AbortSignal): Promise<PreparedPreviewFrame> {
    signal.throwIfAborted();
    const base = { identity: request.identity, time: request.time, duration: request.duration, clipIndex: request.clipIndex };
    if (!request.outgoing) {
      if (!options.canvas.value) return { ...base, bitmap: null };
      const project = options.canvasSize.value ?? { width: 1, height: 1 };
      const size = previewCanvasSize(project.width, project.height);
      if (!blank || blank.width !== size.width || blank.height !== size.height) blank = new OffscreenCanvas(size.width, size.height);
      return { ...base, bitmap: await createImageBitmap(blank) };
    }
    const sample = request.transition;
    const indexA = sample ? options.clips.value.findIndex((clip) => clip.id === sample.clipA.id) : request.clipIndex;
    const a = await layer(indexA, request.outgoing, request, signal);
    let bitmap: ImageBitmap;
    if (sample && request.incoming) {
      const indexB = options.clips.value.findIndex((clip) => clip.id === sample.clipB.id);
      const b = await layer(indexB, request.incoming, request, signal);
      try {
        bitmap = await engine.renderBitmap({
          effectId: sample.transition.effectId,
          outgoing: a,
          incoming: b,
          width: a.width,
          height: a.height,
          progress: sample.progress,
          params: sample.transition.params,
          inputKeys: {
            outgoing: JSON.stringify([sample.clipA.id, layers.get(sample.clipA.id)!.key]),
            incoming: JSON.stringify([sample.clipB.id, layers.get(sample.clipB.id)!.key]),
          },
        });
      } catch (error: unknown) {
        signal.throwIfAborted();
        previewError.value = `转场已回退普通画面：${error instanceof Error ? error.message : "算法失败"}`;
        bitmap = await createImageBitmap(request.clipIndex === indexA ? a : b);
      }
    } else bitmap = await createImageBitmap(a);
    if (signal.aborted || disposed) {
      bitmap.close();
      signal.throwIfAborted();
      throw new DOMException("播放器已卸载", "AbortError");
    }
    const primary = sample && options.clips.value[request.clipIndex]?.id === sample.clipB.id ? request.incoming : request.outgoing;
    return { ...base, bitmap, sourceSize: primary?.sourceSize };
  }

  /** 帧实际绘制成功后调用方才能提交时间；纯音频允许没有 Canvas。 */
  function present(frame: PreparedPreviewFrame): void {
    if (disposed) throw new DOMException("播放器已卸载", "AbortError");
    if (!frame.bitmap) return;
    const target = options.canvas.value;
    const ctx = target?.getContext("2d");
    if (!target || !ctx) throw new Error("预览画布尚未就绪");
    if (target.width !== frame.bitmap.width) target.width = frame.bitmap.width;
    if (target.height !== frame.bitmap.height) target.height = frame.bitmap.height;
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.drawImage(frame.bitmap, 0, 0);
    presentedFrame = { canvas: target, timeSec: frame.time, source: options.captureSource?.value ?? "timeline" };
    videoSize.value = options.canvasSize.value ?? frame.sourceSize ?? { width: target.width, height: target.height };
    frameReady.value = true;
  }

  /** 定位期间旧画面仍可取图；换画布或切换预览来源时等待相应首帧。 */
  function getPresentedFrame(): PresentedComposeFrame | null {
    const source = options.captureSource?.value ?? "timeline";
    if (!presentedFrame || presentedFrame.canvas !== options.canvas.value || presentedFrame.source !== source) return null;
    return presentedFrame;
  }

  function reset(): void {
    revision += 1;
    layers.clear();
    processor?.resetFailure();
    options.beautyReady.value = false;
    previewError.value = "";
  }

  const renderer: PreviewFrameRenderer = { warmup, render, present, reset };
  onUnmounted(() => {
    disposed = true;
    processor?.dispose();
    layers.clear();
    blank = null;
    presentedFrame = null;
    options.beautyReady.value = false;
  });
  return { renderer, videoSize, frameReady, previewError, getPresentedFrame };
}
