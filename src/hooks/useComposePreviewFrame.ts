import { computed, inject, onUnmounted, ref, watch, type Ref } from "vue";
import type { GpuPixelPreview } from "@/utils/beauty/gpuPixelPreview";
import { readBeautyParams, type BeautyParams } from "@/types/composeMedia";
import {
  beautyNeedsFace,
  type BeautyFrameEvent,
  type BeautyWorkerEvent,
  type PreviewFrameIdentity,
  type PreviewVideoSize,
} from "@/types/beautyPreview";
import type { VideoClipItem } from "@/types/videoCompose";
import { previewSourceTimeUs } from "@/hooks/previewSourceTime";
import { seekPreviewVideo, VIDEO_FRAME_TIMEOUT_MS } from "@/hooks/previewVideoFrame";
import { COMPOSE_ALGORITHM_BASE } from "@/editor/composeRuntime";
import BeautyPreviewWorker from "../workers/beautyPreview.worker.ts?worker&inline";

interface UseComposePreviewFrameOptions {
  /** 唯一可见的 2D 画布 */
  canvas: Ref<HTMLCanvasElement | null>;
  /** 独立且稳定挂载的内部 WebGL 画布 */
  gpuCanvas: Ref<HTMLCanvasElement | null>;
  /** 当前活动 video 解码层 */
  video: Ref<HTMLVideoElement | null>;
  /** 活动层已完成换源与定位 */
  mediaReady: Ref<boolean>;
  /** 当前播放列表 */
  clips: Ref<VideoClipItem[]>;
  /** 当前片段下标 */
  currentIdx: Ref<number>;
  /** 当前采样目标（时间轴秒） */
  sampleTime: Ref<number>;
  /** 控制操作代次 */
  renderGeneration: Ref<number>;
  /** 用户播放意图 */
  isPlaying: Ref<boolean>;
  /** 真实时间轴空隙 */
  inGap: Ref<boolean>;
  /** 算法预热完成后才切换时钟 */
  beautyReady: Ref<boolean>;
  /** 最终画面成功提交 */
  onFramePresented: (identity: PreviewFrameIdentity) => void;
  /** 取帧失败时暂停所有实际媒体并提示 */
  onFrameFailed: (message: string) => void;
}

/** 双 video 统一解码，普通与美颜结果始终提交到同一可见 Canvas */
export function useComposePreviewFrame(options: UseComposePreviewFrameOptions) {
  const { canvas, gpuCanvas, video, mediaReady, clips, currentIdx, sampleTime, renderGeneration, isPlaying, inGap, beautyReady } = options;
  const algorithmBase = inject(
    COMPOSE_ALGORITHM_BASE,
    computed(() => "/algorithm/"),
  );
  const videoSize = ref<PreviewVideoSize | null>(null);
  const frameReady = ref(false);
  const previewError = ref("");
  let disposed = false;
  let worker: Worker | null = null;
  let gpu: GpuPixelPreview | null = null;
  let gpuElement: HTMLCanvasElement | null = null;
  let gpuLoading: Promise<void> | null = null;
  let requestId = 0;
  let warmupId = 0;
  let revision = 0;
  let failed = false;
  let frameFailed = false;
  let reportingFailure = false;
  let busy = false;
  let pendingRender = false;
  let renderTimer = 0;
  let requestAbort: AbortController | null = null;
  let unbindVideo: (() => void) | null = null;
  let lastVideoTime = -1;
  let lastVideo: HTMLVideoElement | null = null;
  let faceWarning = "";
  /** Worker 内只允许一个实际处理请求，取消只作废结果，不积压新帧 */
  let pendingFrame: { identity: PreviewFrameIdentity; resolve: (frame: BeautyFrameEvent) => void; reject: (error: Error) => void } | null =
    null;
  const warmups = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();

  /** 当前美颜参数；读取时不修改外部配置 */
  function currentBeauty(): BeautyParams {
    return readBeautyParams(clips.value[currentIdx.value]?.beauty);
  }

  /** 只有实际绘制成功才更新尺寸和 frameReady；等待时保留原像素 */
  function commit(source: CanvasImageSource, width: number, height: number): void {
    const target = canvas.value;
    if (!target || disposed || width <= 0 || height <= 0) throw new Error("预览画布尚未就绪");
    const context = target.getContext("2d");
    if (!context) throw new Error("当前环境不支持 Canvas 预览");
    if (target.width !== width) target.width = width;
    if (target.height !== height) target.height = height;
    context.drawImage(source, 0, 0, width, height);
    videoSize.value = { width, height };
    frameReady.value = true;
  }

  /** 普通播放和算法预热直接画 video，不做 RGBA 读回或加载美颜模块 */
  function drawVideo(force = false): void {
    const source = video.value;
    if (
      disposed ||
      frameFailed ||
      inGap.value ||
      beautyReady.value ||
      !mediaReady.value ||
      !source ||
      source.seeking ||
      source.readyState < 2
    )
      return;
    if (!force && source === lastVideo && source.currentTime === lastVideoTime) return;
    if (source.videoWidth <= 0 || source.videoHeight <= 0) return;
    try {
      commit(source, source.videoWidth, source.videoHeight);
      lastVideo = source;
      lastVideoTime = source.currentTime;
    } catch (error: unknown) {
      failFrame(error);
    }
  }

  /** 真实空隙清黑；时间轴清空时清除历史画面和尺寸 */
  function clearCanvas(empty: boolean): void {
    const target = canvas.value;
    const context = target?.getContext("2d");
    if (target && context) {
      context.clearRect(0, 0, target.width, target.height);
    }
    lastVideo = null;
    lastVideoTime = -1;
    if (empty) {
      videoSize.value = null;
      frameReady.value = false;
    }
  }

  /** 帧错误必须暂停，不能把空帧当作成功继续采样 */
  function failFrame(error: unknown): void {
    if (reportingFailure) return;
    const message = error instanceof Error ? error.message : "视频取帧失败";
    previewError.value = message;
    frameFailed = true;
    reportingFailure = true;
    try {
      options.onFrameFailed(message);
    } finally {
      reportingFailure = false;
      invalidate();
    }
  }

  /** 算法失败回退普通 Canvas，保留用户的美颜参数 */
  function fallback(error: unknown): void {
    failed = true;
    previewError.value = `美颜已回退普通预览：${error instanceof Error ? error.message : "算法初始化失败"}`;
    beautyReady.value = false;
    invalidate();
    drawVideo(true);
  }

  /** 只接收与正在等待的请求完全一致的 Worker 结果 */
  function onWorkerEvent(event: BeautyWorkerEvent): void {
    if (event.type === "ready") {
      const waiting = warmups.get(event.requestId);
      if (!waiting) return;
      warmups.delete(event.requestId);
      faceWarning = event.warning || "";
      waiting.resolve();
      return;
    }
    const pending = pendingFrame;
    if (
      !pending ||
      event.requestId !== pending.identity.requestId ||
      event.generation !== pending.identity.generation ||
      event.clipId !== pending.identity.clipId ||
      event.sourceTimeUs !== pending.identity.sourceTimeUs
    )
      return;
    pendingFrame = null;
    if (event.type === "error") pending.reject(new Error(event.message));
    else pending.resolve(event);
  }

  /** 懒创建 Worker；普通预览不启动线程 */
  function ensureWorker(): Worker {
    if (worker) return worker;
    const next = new BeautyPreviewWorker();
    next.onmessage = (event: MessageEvent<BeautyWorkerEvent>): void => onWorkerEvent(event.data);
    next.onerror = (): void => {
      const error = new Error("美颜预览线程失败");
      pendingFrame?.reject(error);
      pendingFrame = null;
      for (const pending of warmups.values()) pending.reject(error);
      warmups.clear();
      next.terminate();
      worker = null;
      if (!disposed) fallback(error);
    };
    worker = next;
    return next;
  }

  /** 按播放器内部画布创建独立 GPUPixel；仅脚本加载器可共享 */
  async function ensureGpu(): Promise<void> {
    const element = gpuCanvas.value;
    if (!element) throw new Error("美颜内部画布尚未挂载");
    if (gpuElement === element && gpuLoading) return gpuLoading;
    gpu?.destroy();
    gpu = null;
    gpuElement = element;
    const loading = (async (): Promise<void> => {
      const { acquireGpuPixelPreview } = await import("@/utils/beauty/gpuPixelPreview");
      if (disposed || gpuElement !== element) return;
      const instance = acquireGpuPixelPreview(element);
      gpu = instance;
      await instance.init();
      if (disposed || gpuElement !== element) instance.destroy();
    })();
    gpuLoading = loading;
    try {
      await loading;
    } catch (error: unknown) {
      if (gpuLoading === loading) gpuLoading = null;
      throw error;
    }
  }

  /** 模型加载期间仍使用普通视频时钟，准备好后从当前播放位置开始 */
  async function warmup(): Promise<void> {
    const id = ++warmupId;
    beautyReady.value = false;
    if (!currentBeauty().enabled || !gpuCanvas.value || failed || disposed) return;
    try {
      await Promise.all([
        ensureGpu(),
        new Promise<void>((resolve, reject) => {
          const next = ensureWorker();
          warmups.set(id, { resolve, reject });
          next.postMessage({
            type: "init",
            requestId: id,
            detectFace: beautyNeedsFace(currentBeauty()),
            algorithmBaseUrl: algorithmBase.value,
          });
        }),
      ]);
      if (disposed || id !== warmupId || !currentBeauty().enabled || failed) return;
      previewError.value = faceWarning;
      beautyReady.value = true;
      schedule();
    } catch (error: unknown) {
      if (!disposed && id === warmupId) fallback(error);
    }
  }

  /** 控制操作、暂停及参数调整立即作废旧结果，同时取消尚未发送的等待 */
  function invalidate(): void {
    revision += 1;
    requestAbort?.abort();
    window.clearTimeout(renderTimer);
    renderTimer = 0;
    pendingRender = false;
  }

  /** 暂停拖动合并 80ms 内的连续请求，播放时立刻处理当前采样 */
  function schedule(): void {
    if (disposed || frameFailed || !beautyReady.value || !mediaReady.value || inGap.value || !canvas.value) return;
    window.clearTimeout(renderTimer);
    pendingRender = true;
    renderTimer = window.setTimeout(
      () => {
        renderTimer = 0;
        void render();
      },
      isPlaying.value ? 0 : 80,
    );
  }

  /** 请求同时包含本地序号、控制代次、片段和源时间 */
  function identityForCurrentFrame(): PreviewFrameIdentity {
    return {
      requestId: ++requestId,
      generation: renderGeneration.value,
      clipId: clips.value[currentIdx.value]?.id || "",
      sourceTimeUs: previewSourceTimeUs(clips.value, currentIdx.value, sampleTime.value),
    };
  }

  /** 检查异步阶段是否仍属于相同片段、源时间和控制代次 */
  function isCurrent(identity: PreviewFrameIdentity, token: number, source: HTMLVideoElement): boolean {
    return (
      !disposed &&
      token === revision &&
      identity.generation === renderGeneration.value &&
      identity.clipId === clips.value[currentIdx.value]?.id &&
      source === video.value &&
      identity.sourceTimeUs === previewSourceTimeUs(clips.value, currentIdx.value, sampleTime.value) &&
      beautyReady.value &&
      !inGap.value &&
      mediaReady.value
    );
  }

  /** 转移快照给 Worker，8 秒内未返回则失败；过期帧也等待释放处理槽 */
  function processBitmap(bitmap: ImageBitmap, identity: PreviewFrameIdentity): Promise<BeautyFrameEvent> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pendingFrame = null;
        worker?.terminate();
        worker = null;
        reject(new Error("美颜处理超时（8 秒）"));
      }, VIDEO_FRAME_TIMEOUT_MS);
      pendingFrame = {
        identity,
        resolve: (frame): void => {
          window.clearTimeout(timer);
          resolve(frame);
        },
        reject: (error): void => {
          window.clearTimeout(timer);
          reject(error);
        },
      };
      try {
        ensureWorker().postMessage({ type: "render", ...identity, bitmap, detectFace: beautyNeedsFace(currentBeauty()) }, [bitmap]);
      } catch (error: unknown) {
        window.clearTimeout(timer);
        pendingFrame = null;
        bitmap.close();
        reject(error);
      }
    });
  }

  /** 快照创建也受 8 秒阈值约束；迟到的 bitmap 必须关闭 */
  function captureBitmap(source: HTMLVideoElement, signal: AbortSignal): Promise<ImageBitmap> {
    return new Promise((resolve, reject) => {
      let expired = false;
      /** 取消后立即腾出处理槽；快照若迟到仍由下方回调关闭 */
      const cancel = (): void => {
        expired = true;
        release();
        reject(new DOMException("预览请求已取消", "AbortError"));
      };
      /** 所有退出路径都移除定时器和取消监听 */
      const release = (): void => {
        window.clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
      };
      const timer = window.setTimeout(() => {
        expired = true;
        release();
        reject(new Error("视频快照超时（8 秒）"));
      }, VIDEO_FRAME_TIMEOUT_MS);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) {
        cancel();
        return;
      }
      void createImageBitmap(source).then(
        (bitmap) => {
          release();
          if (expired || disposed) {
            bitmap.close();
            if (!expired) reject(new DOMException("播放器已卸载", "AbortError"));
          } else resolve(bitmap);
        },
        (error: unknown) => {
          release();
          reject(error);
        },
      );
    });
  }

  /** 串行定位、快照、处理和提交；只保留最后一次暂停拖动 */
  async function render(): Promise<void> {
    if (busy || !pendingRender || disposed || !beautyReady.value || !mediaReady.value || inGap.value) return;
    const source = video.value;
    if (!source) return;
    pendingRender = false;
    busy = true;
    const token = revision;
    const identity = identityForCurrentFrame();
    const controller = new AbortController();
    requestAbort = controller;
    let bitmap: ImageBitmap | null = null;
    try {
      await seekPreviewVideo(source, identity.sourceTimeUs / 1e6, controller.signal);
      if (!isCurrent(identity, token, source)) return;
      bitmap = await captureBitmap(source, controller.signal);
      if (!isCurrent(identity, token, source)) return;
      const processing = processBitmap(bitmap, identity);
      bitmap = null;
      const frame = await processing;
      if (!isCurrent(identity, token, source) || !gpu || !gpuCanvas.value) return;
      const beauty = currentBeauty();
      const levels = frame.warning ? { ...beauty, slim: 0, eye: 0 } : beauty;
      try {
        gpu.draw(new Uint8Array(frame.buffer), frame.width, frame.height, levels, frame.landmarks);
      } catch (error: unknown) {
        fallback(error);
        return;
      }
      // WebGL 默认缓冲可能在本轮结束后清除，必须立即复制到可见 2D 画布。
      commit(gpuCanvas.value, frame.width, frame.height);
      previewError.value = frame.warning || faceWarning;
      options.onFramePresented(identity);
    } catch (error: unknown) {
      if (!isCurrent(identity, token, source)) {
        // 过期任务超时后已终止 Worker，新请求必须重新预热其模型。
        if (!worker && !disposed && beautyReady.value) void warmup();
        return;
      }
      failFrame(error);
      if (!worker) {
        failed = true;
        beautyReady.value = false;
      }
    } finally {
      bitmap?.close();
      busy = false;
      if (requestAbort === controller) requestAbort = null;
      if (pendingRender && !disposed) schedule();
    }
  }

  /** 原生视频帧回调优先；不支持时按媒体时间去重的 RAF 回退 */
  function bindVideo(): void {
    unbindVideo?.();
    const source = video.value;
    if (!source) return;
    let frameCallback = 0;
    let animationCallback = 0;
    let cancelled = false;
    /** 播放期间按解码帧提交普通画面 */
    const tick = (): void => {
      if (cancelled || disposed) return;
      drawVideo();
      if (typeof source.requestVideoFrameCallback === "function") frameCallback = source.requestVideoFrameCallback(tick);
      else animationCallback = requestAnimationFrame(tick);
    };
    /** 暂停 seek、首帧加载及尺寸变化主动补画 */
    const redraw = (): void => drawVideo(true);
    const events = ["loadeddata", "seeked", "pause", "resize", "canplay"];
    for (const event of events) source.addEventListener(event, redraw);
    tick();
    unbindVideo = (): void => {
      cancelled = true;
      if (frameCallback) source.cancelVideoFrameCallback?.(frameCallback);
      cancelAnimationFrame(animationCallback);
      for (const event of events) source.removeEventListener(event, redraw);
    };
  }

  /** 只在总开关、人脸需求或内部画布变化时预热，不随每个采样重复加载 */
  watch(
    [gpuCanvas, () => currentBeauty().enabled, () => beautyNeedsFace(currentBeauty())],
    () => {
      failed = false;
      invalidate();
      void warmup();
    },
    { immediate: true, flush: "post" },
  );

  /** 所有操作先使旧快照失效，再安排当前最终目标 */
  watch(
    [renderGeneration, sampleTime, mediaReady, isPlaying, inGap, video, () => JSON.stringify(clips.value[currentIdx.value]?.beauty)],
    () => {
      if (!reportingFailure) frameFailed = false;
      invalidate();
      if (!clips.value.length) clearCanvas(true);
      else if (inGap.value) clearCanvas(false);
      else if (beautyReady.value) schedule();
      else drawVideo(true);
    },
    { flush: "sync" },
  );
  /** 活动 video 或可见画布重新挂载时更新原生帧监听 */
  watch(
    [video, canvas],
    () => {
      bindVideo();
      drawVideo(true);
    },
    { flush: "post", immediate: true },
  );
  /** 退出美颜后补画同一个 Canvas，保持已有帧到定位完成 */
  watch(beautyReady, (ready) => {
    if (!ready) drawVideo(true);
  });

  onUnmounted(() => {
    disposed = true;
    invalidate();
    warmupId += 1;
    unbindVideo?.();
    worker?.postMessage({ type: "dispose" });
    worker?.terminate();
    worker = null;
    pendingFrame?.reject(new DOMException("播放器已卸载", "AbortError"));
    pendingFrame = null;
    for (const pending of warmups.values()) pending.reject(new DOMException("播放器已卸载", "AbortError"));
    warmups.clear();
    gpu?.destroy();
    gpu = null;
    beautyReady.value = false;
  });

  return { videoSize, frameReady, previewError };
}
