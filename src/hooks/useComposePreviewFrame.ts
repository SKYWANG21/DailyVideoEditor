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
  /** 时间轴时间（秒） */
  globalTime: Ref<number>;
  /** 空隙时不取帧，画面隐藏 */
  inGap: Ref<boolean>;
}

/**
 * 把时间轴时钟交给预览 Worker，再用主线程 GPUPixel 把返回的 RGBA 画到 canvas。
 */
export function useComposePreviewFrame(options: UseComposePreviewFrameOptions) {
  const { canvas, clips, currentIdx, globalTime, inGap } = options;
  const videoSize = ref<PreviewVideoSize | null>(null);
  const frameReady = ref(false);
  const previewError = ref("");

  let worker: Worker | null = null;
  let gpu: GpuPixelPreview | null = null;
  let gpuReady: Promise<void> | null = null;
  let requestId = 0;
  let appliedId = 0;
  let queued = false;
  let disposed = false;
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

  /** 只画最新一帧。GPUPixel 还没好时先把帧留着 */
  function onWorkerEvent(event: BeautyWorkerEvent): void {
    if (event.type === "error") {
      previewError.value = event.message;
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

  /** 按当前片段的美颜参数把最近一帧画上去 */
  async function drawLatest(): Promise<void> {
    const frame = latestFrame;
    const ready = ensureGpu();
    if (!frame || !ready || !gpu) return;
    try {
      await ready;
    } catch {
      return;
    }
    if (latestFrame !== frame || !gpu) return;
    const beauty = currentBeauty();
    gpu.draw(new Uint8Array(frame.buffer), frame.width, frame.height, beauty, frame.landmarks);
  }

  /** 当前片段的美颜。没有片段时用关闭 */
  function currentBeauty(): BeautyParams {
    return readBeautyParams(clips.value[currentIdx.value]?.beauty);
  }

  /** 同一轮响应里多次改动只发一次取帧 */
  function schedule(): void {
    if (queued || disposed) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      postRender();
    });
  }

  /** 把当前源时间和是否检测人脸发给 Worker */
  function postRender(): void {
    if (disposed || inGap.value) return;
    const list = clips.value;
    const index = currentIdx.value;
    const clip = list[index];
    if (!clip?.url) return;
    const beauty = readBeautyParams(clip.beauty);
    requestId += 1;
    ensureWorker().postMessage({
      type: "render",
      requestId,
      clipId: clip.id,
      url: clip.url,
      sourceTimeUs: previewSourceTimeUs(list, index, globalTime.value),
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
        globalTime.value,
        inGap.value,
        beauty?.enabled ?? false,
        beauty?.smooth ?? 0,
        beauty?.whiten ?? 0,
        beauty?.slim ?? 0,
        beauty?.eye ?? 0,
      ].join("|");
    },
    () => {
      schedule();
      if (latestFrame) void drawLatest();
    },
    { immediate: true },
  );

  watch(canvas, () => {
    void ensureGpu()?.then(() => drawLatest()).catch(() => undefined);
  });

  onUnmounted(() => {
    disposed = true;
    worker?.postMessage({ type: "dispose" });
    worker?.terminate();
    worker = null;
  });

  return { videoSize, frameReady, previewError };
}
