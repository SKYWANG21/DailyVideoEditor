import { computed, inject, onUnmounted, ref, watch, type Ref } from "vue";
import { readBeautyParams, type BeautyParams } from "@/types/composeMedia";
import type { PreviewFrameIdentity, PreviewVideoSize } from "@/types/beautyPreview";
import type { ComposeTrack, VideoClipItem, VideoFrameTransform } from "@/types/videoCompose";
import type { TransitionSample } from "@/types/transition";
import { previewSourceTimeUs, previewSeekTimeSec } from "./previewSourceTime";
import { seekPreviewVideo } from "./previewVideoFrame";
import { COMPOSE_ALGORITHM_BASE } from "@/editor/composeRuntime";
import { readVideoFrameTransform } from "@/editor/shared/videoFrame";
import { createTransitionRegistry } from "@/transitions/catalog";
import { TransitionEngine } from "@/transitions/engine";
import { resolveTransitionAtTime } from "@/transitions/timing";
import { ComposeFrameProcessor } from "./composeFrameProcessor";
import { drawPreviewCanvasFrame } from "./previewCanvasFrame";

/** 单一画面提交者的输入，播放时钟仍属于 useVideoComposePreview。 */
interface UseComposePreviewFrameOptions {
  /** 唯一可见画布。 */
  canvas: Ref<HTMLCanvasElement | null>;
  /** 美颜独占内部画布。 */
  gpuCanvas: Ref<HTMLCanvasElement | null>;
  /** 当前主解码槽。 */
  video: Ref<HTMLVideoElement | null>;
  /** 转场期间预留给另一侧的解码槽。 */
  standbyVideo: Ref<HTMLVideoElement | null>;
  /** 双侧定位准备完成。 */
  mediaReady: Ref<boolean>;
  /** 播放列表。 */
  clips: Ref<VideoClipItem[]>;
  /** 当前自然时间所属片段。 */
  currentIdx: Ref<number>;
  /** 请求采样点。 */
  sampleTime: Ref<number>;
  /** 使旧任务失效的控制代次。 */
  renderGeneration: Ref<number>;
  /** 用户播放意图。 */
  isPlaying: Ref<boolean>;
  /** 真实空隙。 */
  inGap: Ref<boolean>;
  /** 现有美颜逐帧时钟准备状态。 */
  beautyReady: Ref<boolean>;
  /** 当前主轨；素材库单片预览为空。 */
  transitionTrack: Ref<ComposeTrack | undefined>;
  /** 项目画布像素。 */
  canvasSize: Ref<PreviewVideoSize | null>;
  /** 兼容没有轨道元数据的普通预览变换。 */
  frame: Ref<VideoFrameTransform | null | undefined>;
  /** 只有当前帧真正提交后才能推进逐帧时钟。 */
  onFramePresented(identity: PreviewFrameIdentity): void;
  /** 加载/解码失败必须暂停。 */
  onFrameFailed(message: string): void;
}

/** 普通、美颜和双侧转场统一提交同一个项目坐标画布。 */
export function useComposePreviewFrame(options: UseComposePreviewFrameOptions) {
  const { canvas, gpuCanvas, video, mediaReady, clips, currentIdx, sampleTime, renderGeneration, isPlaying, inGap, beautyReady } = options;
  const algorithmBase = inject(
    COMPOSE_ALGORITHM_BASE,
    computed(() => "/algorithm/"),
  );
  const registry = createTransitionRegistry();
  const engine = new TransitionEngine(registry);
  const layers = new Map<string, OffscreenCanvas>();
  const videoSize = ref<PreviewVideoSize | null>(null);
  const frameReady = ref(false);
  const previewError = ref("");
  /** 同一个采样定义贯穿定位、两侧处理和最终回执。 */
  const transition = computed(() => {
    const track = options.transitionTrack.value;
    return track ? resolveTransitionAtTime(track.clips, track.transitions ?? [], sampleTime.value) : null;
  });
  let processor: ComposeFrameProcessor | null = null;
  let processorCanvas: HTMLCanvasElement | null = null;
  let disposed = false;
  let revision = 0;
  let warmupRevision = 0;
  let requestId = 0;
  let busy = false;
  let pending = false;
  let timer = 0;
  let request: AbortController | null = null;
  let unbindVideo: (() => void) | null = null;
  let lastTime = -1;
  let lastVideo: HTMLVideoElement | null = null;

  /** 按 ID 获取两侧各自的美颜参数。 */
  function requiredBeauty(): BeautyParams[] {
    const sample = transition.value;
    return sample
      ? [sample.clipA.id, sample.clipB.id].map((id) => readBeautyParams(clips.value.find((clip) => clip.id === id)?.beauty))
      : [readBeautyParams(clips.value[currentIdx.value]?.beauty)];
  }

  /** 内部 WebGL 画布重新挂载时释放旧上下文，实例间不共享处理状态。 */
  function ensureProcessor(): ComposeFrameProcessor | null {
    const target = gpuCanvas.value;
    if (!target) return null;
    if (processorCanvas !== target) {
      processor?.dispose();
      processorCanvas = target;
      processor = new ComposeFrameProcessor(target, algorithmBase.value, (message, fallback) => {
        previewError.value = message;
        if (fallback) beautyReady.value = false;
      });
    }
    return processor;
  }

  /** 所有输入变化使旧定位和提交失效。 */
  function invalidate(): void {
    revision += 1;
    request?.abort();
    clearTimeout(timer);
    pending = false;
  }

  /** 绘制失败不会冒充成功推进时钟。 */
  function fail(error: unknown): void {
    previewError.value = error instanceof Error ? error.message : "视频取帧失败";
    options.onFrameFailed(previewError.value);
  }

  /** 完整图层一次性提交，准备期间保留上一次画面。 */
  function commit(source: CanvasImageSource, width: number, height: number): void {
    const target = canvas.value;
    const ctx = target?.getContext("2d");
    if (!target || !ctx || disposed) throw new Error("预览画布尚未就绪");
    if (target.width !== width) target.width = width;
    if (target.height !== height) target.height = height;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(source, 0, 0, width, height);
    videoSize.value = { width, height };
    frameReady.value = true;
  }

  /** 普通画面和转场输入使用完全相同的画面变换。 */
  function makeLayer(
    source: CanvasImageSource,
    width: number,
    height: number,
    id: string,
    sourceWidth: number,
    sourceHeight: number,
  ): OffscreenCanvas {
    let layer = layers.get(id);
    if (!layer || layer.width !== width || layer.height !== height) {
      layer = new OffscreenCanvas(width, height);
      layers.set(id, layer);
    }
    // 只保留当前双侧，长工程不能不断累积整帧缓冲。
    while (layers.size > 2) layers.delete(layers.keys().next().value!);
    const ctx = layer.getContext("2d");
    if (!ctx) throw new Error("当前环境不支持预览画布");
    ctx.clearRect(0, 0, width, height);
    const clip = options.transitionTrack.value?.clips.find((item) => item.id === id);
    const frame = clip ? readVideoFrameTransform(clip.config) : options.frame.value;
    drawPreviewCanvasFrame(ctx, source, sourceWidth, sourceHeight, width, height, frame);
    return layer;
  }

  /** 原生帧回调只绘制无需异步处理的普通画面。 */
  function drawVideo(force = false): void {
    const source = video.value;
    if (
      disposed ||
      inGap.value ||
      beautyReady.value ||
      transition.value ||
      !mediaReady.value ||
      !source ||
      source.seeking ||
      source.readyState < 2
    )
      return;
    if (!force && source === lastVideo && source.currentTime === lastTime) return;
    if (!source.videoWidth || !source.videoHeight) return;
    const size = options.canvasSize.value ?? { width: source.videoWidth, height: source.videoHeight };
    try {
      commit(
        makeLayer(source, size.width, size.height, clips.value[currentIdx.value]?.id ?? "", source.videoWidth, source.videoHeight),
        size.width,
        size.height,
      );
      lastVideo = source;
      lastTime = source.currentTime;
    } catch (error: unknown) {
      fail(error);
    }
  }

  /** 暂停拖动合并请求；播放立即处理，始终只有一个实际任务。 */
  function schedule(): void {
    if (disposed || !mediaReady.value || inGap.value) return;
    pending = true;
    clearTimeout(timer);
    timer = window.setTimeout(() => void render(), isPlaying.value ? 0 : 80);
  }

  /** 定位并处理一侧，随采样而不是随当前播放片段读取美颜。 */
  async function renderSide(
    index: number,
    source: HTMLVideoElement,
    identity: PreviewFrameIdentity,
    signal: AbortSignal,
  ): Promise<OffscreenCanvas> {
    const clip = clips.value[index];
    if (!clip) throw new Error("转场关联片段不存在");
    const sourceTimeUs = previewSourceTimeUs(clips.value, index, sampleTime.value);
    await seekPreviewVideo(source, previewSeekTimeSec(clips.value, index, sampleTime.value), signal);
    signal.throwIfAborted();
    const prepared =
      (await ensureProcessor()?.process(source, readBeautyParams(clip.beauty), { ...identity, clipId: clip.id, sourceTimeUs }, signal)) ??
      source;
    signal.throwIfAborted();
    const size = options.canvasSize.value ?? { width: source.videoWidth, height: source.videoHeight };
    return makeLayer(prepared, size.width, size.height, clip.id, source.videoWidth, source.videoHeight);
  }

  /** 两侧串行共享美颜资源；算法异常降级为当前自然片段。 */
  async function renderTransition(
    sample: TransitionSample,
    identity: PreviewFrameIdentity,
    signal: AbortSignal,
  ): Promise<CanvasImageSource> {
    const a = clips.value.findIndex((clip) => clip.id === sample.clipA.id);
    const b = clips.value.findIndex((clip) => clip.id === sample.clipB.id);
    const active = video.value;
    const standby = options.standbyVideo.value;
    if (!active || !standby || a < 0 || b < 0) throw new Error("转场双侧画面尚未就绪");
    const outgoing = await renderSide(a, currentIdx.value === a ? active : standby, identity, signal);
    const incoming = await renderSide(b, currentIdx.value === b ? active : standby, identity, signal);
    try {
      const result = await engine.render({
        effectId: sample.transition.effectId,
        outgoing,
        incoming,
        width: outgoing.width,
        height: outgoing.height,
        progress: sample.progress,
        params: sample.transition.params,
      });
      signal.throwIfAborted();
      return result;
    } catch (error: unknown) {
      signal.throwIfAborted();
      previewError.value = `转场已回退普通画面：${error instanceof Error ? error.message : "算法失败"}`;
      return sample.progress < 0.5 ? outgoing : incoming;
    }
  }

  /** 串行提交，并核对控制代次、采样和转场配置，拒绝所有迟到帧。 */
  async function render(): Promise<void> {
    if (busy || !pending || disposed || !mediaReady.value || inGap.value) return;
    if (!transition.value && !beautyReady.value) {
      pending = false;
      drawVideo(true);
      return;
    }
    busy = true;
    pending = false;
    const token = revision;
    const sample = transition.value;
    const time = sampleTime.value;
    const identity: PreviewFrameIdentity = {
      generation: renderGeneration.value,
      requestId: ++requestId,
      clipId: clips.value[currentIdx.value]?.id ?? "",
      sourceTimeUs: previewSourceTimeUs(clips.value, currentIdx.value, time),
      timelineTimeSec: time,
      transitionId: sample?.transition.id,
      secondaryClipId: sample?.clipB.id,
      secondarySourceTimeUs: sample
        ? previewSourceTimeUs(
            clips.value,
            clips.value.findIndex((clip) => clip.id === sample.clipB.id),
            time,
          )
        : undefined,
    };
    const controller = new AbortController();
    request = controller;
    try {
      const source = video.value;
      if (!source) return;
      const result = sample
        ? await renderTransition(sample, identity, controller.signal)
        : await renderSide(currentIdx.value, source, identity, controller.signal);
      if (disposed || token !== revision || identity.generation !== renderGeneration.value || time !== sampleTime.value) return;
      const size = options.canvasSize.value ?? { width: source.videoWidth, height: source.videoHeight };
      commit(result, size.width, size.height);
      options.onFramePresented(identity);
    } catch (error: unknown) {
      if (!controller.signal.aborted && token === revision && !disposed) fail(error);
    } finally {
      busy = false;
      if (request === controller) request = null;
      if (pending && !disposed) schedule();
    }
  }

  /** 原生播放由解码帧驱动，暂停和 seek 主动补画。 */
  function bindVideo(): void {
    unbindVideo?.();
    const source = video.value;
    if (!source) return;
    let callback = 0;
    let raf = 0;
    let cancelled = false;
    const tick = (): void => {
      if (cancelled || disposed) return;
      drawVideo();
      if (source.requestVideoFrameCallback) callback = source.requestVideoFrameCallback(tick);
      else raf = requestAnimationFrame(tick);
    };
    const redraw = (): void => drawVideo(true);
    const events = ["loadeddata", "seeked", "pause", "resize", "canplay"];
    events.forEach((event) => source.addEventListener(event, redraw));
    tick();
    unbindVideo = (): void => {
      cancelled = true;
      source.cancelVideoFrameCallback?.(callback);
      cancelAnimationFrame(raf);
      events.forEach((event) => source.removeEventListener(event, redraw));
    };
  }

  /** 美颜参数发生实质变化时预热；采样时间变化不重复初始化。 */
  watch(
    [gpuCanvas, () => JSON.stringify(requiredBeauty())],
    async () => {
      const token = ++warmupRevision;
      const levels = requiredBeauty();
      const next = ensureProcessor();
      next?.resetFailure();
      const ready = (await next?.warmup(levels)) ?? false;
      if (!disposed && token === warmupRevision) {
        beautyReady.value = ready;
        invalidate();
        schedule();
      }
    },
    { immediate: true, flush: "post" },
  );

  /** 控制、布局或工程参数变化均废弃旧帧；真实空隙清画布。 */
  watch(
    [
      renderGeneration,
      sampleTime,
      mediaReady,
      isPlaying,
      inGap,
      video,
      () => JSON.stringify(options.transitionTrack.value),
      options.canvasSize,
      options.frame,
    ],
    () => {
      invalidate();
      if (!clips.value.length || inGap.value) {
        const target = canvas.value;
        target?.getContext("2d")?.clearRect(0, 0, target.width, target.height);
        if (!clips.value.length) {
          videoSize.value = null;
          frameReady.value = false;
        }
      } else if (transition.value || beautyReady.value) schedule();
      else drawVideo(true);
    },
    { flush: "sync" },
  );
  /** 解码槽或画布重新挂载后重绑原生帧回调。 */
  watch(
    [video, canvas],
    () => {
      bindVideo();
      drawVideo(true);
    },
    { immediate: true, flush: "post" },
  );
  onUnmounted(() => {
    disposed = true;
    warmupRevision += 1;
    invalidate();
    unbindVideo?.();
    processor?.dispose();
    layers.clear();
    beautyReady.value = false;
  });
  return { videoSize, frameReady, previewError };
}
