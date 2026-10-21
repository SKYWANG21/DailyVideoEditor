import { onUnmounted, ref, watch, type Ref } from "vue";
import { acquireGpuPixelPreview, type GpuPixelPreview } from "@/service/beauty/gpuPixelPreview";
import type { BeautyParams } from "@/types/composeMedia";
import { readBeautyParams } from "@/types/composeMedia";
import { beautyNeedsFace, type BeautyFrameEvent, type BeautyWorkerEvent, type PreviewVideoSize } from "@/types/beautyPreview";
import type { VideoClipItem } from "@/types/videoCompose";
import { previewSourceTimeUs } from "@/hooks/previewSourceTime";

interface UseComposePreviewFrameOptions {
  /** GPUPixel 使用的页面 canvas。调用前不要 getContext */
  canvas: Ref<HTMLCanvasElement | null>;
  /** 当前播放列表 */
  clips: Ref<VideoClipItem[]>;
  /** 当前片段下标 */
  currentIdx: Ref<number>;
  /** 取帧目标（秒）。暂停时等于游标，播放时由预览钩子往前推 */
  sampleTime: Ref<number>;
  /** 取帧目标没变时仍要再解一次。播放重试靠它 */
  renderGeneration: Ref<number>;
  /** 正在播放时立即取帧，暂停时合并连续跳转 */
  isPlaying: Ref<boolean>;
  /** 空隙时不取帧，画面隐藏 */
  inGap: Ref<boolean>;
  /** 一帧已经画到 canvas 上。参数是该帧源时间（微秒） */
  onFramePresented: (sourceTimeUs: number) => void;
  /** 这一时刻没有画面。参数是请求的源时间（微秒） */
  onFrameMissed: (sourceTimeUs: number) => void;
}

/**
 * 美颜总开关打开时，把时间轴交给预览 Worker，再用 GPUPixel 画到 canvas。
 * 开关关闭时不创建 Worker、不画。开着但强度为 0 仍走这条取帧路径。
 */
export function useComposePreviewFrame(options: UseComposePreviewFrameOptions) {
  const { canvas, clips, currentIdx, sampleTime, renderGeneration, isPlaying, inGap, onFramePresented, onFrameMissed } = options;
  const videoSize = ref<PreviewVideoSize | null>(null);
  const frameReady = ref(false);
  const previewError = ref("");

  let worker: Worker | null = null;
  let gpu: GpuPixelPreview | null = null;
  let gpuReady: Promise<void> | null = null;
  let requestId = 0;
  let appliedId = 0;
  /** 已经画上 canvas 的请求序号。同一帧重画不再回调 */
  let presentedRequestId = 0;
  let queued = false;
  let disposed = false;
  /** 暂停取帧的定时器。0 表示没有在等 */
  let pausedRenderTimer = 0;
  let latestFrame: BeautyFrameEvent | null = null;
  let prefetchedId = "";

  /** 懒创建 Worker。页面卸载时在 onUnmounted 里关掉 */
  function ensureWorker(): Worker {
    if (worker) return worker;
    const next = new Worker(new URL("../workers/beautyPreview.worker.ts", import.meta.url), { type: "module" });
    next.onmessage = (event: MessageEvent<BeautyWorkerEvent>) => {
      onWorkerEvent(event.data);
    };
    next.onerror = () => {
      previewError.value = previewError.value || "预览线程启动失败";
    };
    worker = next;
    return next;
  }

  /** 等 canvas 挂上后再加载 GPUPixel */
  function ensureGpu(): Promise<void> | null {
    const el = canvas.value;
    if (!el) return null;
    if (!gpu || gpuReady == null) {
      gpu = acquireGpuPixelPreview(el);
      gpuReady = gpu.init().catch((error: unknown) => {
        gpuReady = null;
        previewError.value = error instanceof Error ? error.message : "美颜模块加载失败";
        throw error;
      });
    }
    return gpuReady;
  }

  /** 只画最新一帧。美颜关掉后的过期结果直接丢掉 */
  function onWorkerEvent(event: BeautyWorkerEvent): void {
    if (!clipBeautyEnabled()) return;
    if (event.type === "error") {
      previewError.value = event.message;
      return;
    }
    if (event.type === "miss") {
      if (event.requestId < appliedId) return;
      appliedId = event.requestId;
      onFrameMissed(event.sourceTimeUs);
      return;
    }
    if (event.requestId < appliedId) return;
    appliedId = event.requestId;
    latestFrame = event;
    videoSize.value = { width: event.width, height: event.height };
    frameReady.value = true;
    previewError.value = "";
    void drawLatest();
  }

  /** 按当前片段的美颜参数把最近一帧画上去。总开关关闭时不画 */
  async function drawLatest(): Promise<void> {
    if (!clipBeautyEnabled()) return;
    const frame = latestFrame;
    const ready = ensureGpu();
    if (!frame || !ready || !gpu) return;
    try {
      await ready;
    } catch {
      return;
    }
    if (disposed || latestFrame !== frame || !gpu) return;
    const beauty = currentBeauty();
    gpu.draw(new Uint8Array(frame.buffer), frame.width, frame.height, beauty, frame.landmarks);
    if (frame.requestId === presentedRequestId) return;
    presentedRequestId = frame.requestId;
    onFramePresented(frame.sourceTimeUs);
  }

  /** 当前片段的美颜。没有片段时用关闭 */
  function currentBeauty(): BeautyParams {
    return readBeautyParams(clips.value[currentIdx.value]?.beauty);
  }

  /** 当前片段美颜总开关。强度为 0 也算打开 */
  function clipBeautyEnabled(): boolean {
    return currentBeauty().enabled;
  }

  /** 暂停拖动时合并取帧的等待（毫秒）。只解最后一次 */
  const PAUSED_RENDER_DELAY_MS = 80;

  /** 取消暂停期间还没发出的取帧 */
  function clearPausedRender(): void {
    window.clearTimeout(pausedRenderTimer);
    pausedRenderTimer = 0;
  }

  /**
   * 安排一次取帧。
   * 播放中用微任务立刻发；暂停时等 80 毫秒，期间又改时间就只保留最后一次。
   */
  function schedule(): void {
    if (disposed) return;
    if (isPlaying.value) {
      clearPausedRender();
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        postRender();
      });
      return;
    }
    clearPausedRender();
    pausedRenderTimer = window.setTimeout(() => {
      pausedRenderTimer = 0;
      postRender();
    }, PAUSED_RENDER_DELAY_MS);
  }

  /**
   * 把当前源时间和是否检测人脸发给 Worker。
   * 总开关关闭时直接返回，不创建 Worker。开着但强度为 0 仍然取帧。
   */
  function postRender(): void {
    if (disposed || inGap.value) return;
    const list = clips.value;
    const index = currentIdx.value;
    const clip = list[index];
    if (!clip?.url) return;
    const beauty = readBeautyParams(clip.beauty);
    if (!beauty.enabled) return;
    requestId += 1;
    ensureWorker().postMessage({
      type: "render",
      requestId,
      clipId: clip.id,
      url: clip.url,
      sourceTimeUs: previewSourceTimeUs(list, index, sampleTime.value),
      detectFace: beautyNeedsFace(beauty),
    });
    const next = list[index + 1];
    if (next?.url && next.id !== prefetchedId) {
      prefetchedId = next.id;
      ensureWorker().postMessage({ type: "prefetch", clipId: next.id, url: next.url });
    }
  }

  watch(
    () => {
      const clip = clips.value[currentIdx.value];
      const beauty = clip?.beauty;
      return [
        clip?.id ?? "",
        clip?.url ?? "",
        sampleTime.value,
        renderGeneration.value,
        inGap.value,
        beauty?.enabled ?? false,
        beauty?.smooth ?? 0,
        beauty?.whiten ?? 0,
        beauty?.slim ?? 0,
        beauty?.eye ?? 0,
      ].join("|");
    },
    () => {
      if (!clipBeautyEnabled()) {
        clearPausedRender();
        frameReady.value = false;
        return;
      }
      schedule();
      if (latestFrame) void drawLatest();
    },
    { immediate: true },
  );

  watch(canvas, () => {
    if (!clipBeautyEnabled()) return;
    void ensureGpu()
      ?.then(() => drawLatest())
      .catch(() => undefined);
  });

  onUnmounted(() => {
    disposed = true;
    clearPausedRender();
    worker?.postMessage({ type: "dispose" });
    worker?.terminate();
    worker = null;
  });

  return { videoSize, frameReady, previewError };
}
