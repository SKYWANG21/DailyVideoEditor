import { onBeforeUnmount, shallowRef } from "vue";
import type { ResolveMediaUrl } from "@/service/resolveComposeMediaUrl";
import type { ComposeTrack } from "@/types/videoCompose";
import type {
  ComposeVideoExportOptions,
  ComposeVideoExportProgress,
  ComposeVideoExportResolution,
  ComposeVideoExportResult,
} from "@/types/videoExport";
import ExportWorker from "@/workers/composeExport.worker.ts?worker";
import type { ComposeExportSnapshot, ExportResolutionChoice, ExportWorkerCommand, ExportWorkerEvent } from "./exportProtocol";
import { buildExportSnapshot } from "./exportSnapshot";

/** 组件端只读的遮罩状态。 */
export interface ExportCoverState {
  stage: "preparing" | "choosing" | "rendering" | "finalizing" | "cancelling";
  percent: number | null;
  choices: ExportResolutionChoice[];
  notice?: string;
}

/** 编辑器拥有媒体和当前时间轴，导出会话只通过这些入口访问。 */
interface ExportSessionOptions {
  tracks(): ComposeTrack[];
  pause(): void;
  root(): HTMLElement | null;
  algorithmBase(): string;
  transitionBackend(): ComposeExportSnapshot["transitionBackend"];
  resolveMediaUrl(): ResolveMediaUrl | undefined;
  createWorker(): (() => Worker) | undefined;
}

/** 会话的单一进行中任务。 */
interface ActiveExport {
  id: number;
  options: ComposeVideoExportOptions;
  controller: AbortController;
  worker?: Worker;
  timeout?: ReturnType<typeof setTimeout>;
  onExternalAbort: () => void;
  resolve: (result: ComposeVideoExportResult) => void;
  reject: (error: Error) => void;
  previousFocus: HTMLElement | null;
}

/** 运行中增强放大出错时，宿主可以重新请求素材分辨率。 */
export class ComposeVideoExportError extends Error {
  constructor(
    message: string,
    readonly retryAtSource = false,
  ) {
    super(message);
  }
}

/** 快照、Worker 结果和遮罩共享组件任务生命周期。 */
export function useComposeVideoExport(session: ExportSessionOptions) {
  const cover = shallowRef<ExportCoverState | null>(null);
  let active: ActiveExport | null = null;
  let nextId = 0;

  /** 浏览器仅在活动导出期间注册原生离开确认。 */
  function beforeUnload(event: BeforeUnloadEvent): void {
    event.preventDefault();
    event.returnValue = true;
  }

  /** 全局快捷键无法触及被遮罩的编辑器内容。 */
  function guardEditorKeys(event: KeyboardEvent): void {
    const root = session.root();
    const target = event.target;
    if (target instanceof Element && target.closest("[data-compose-export-cover]") && root?.contains(target)) return;
    if (target === document.body || (target instanceof Node && root?.contains(target))) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  /** 成功、失败和取消都执行相同的清理，只结算当前任务。 */
  function finish(task: ActiveExport, value: ComposeVideoExportResult | Error, restoreFocus = true): void {
    if (active !== task) return;
    active = null;
    if (task.timeout !== undefined) clearTimeout(task.timeout);
    task.worker?.terminate();
    task.options.signal?.removeEventListener("abort", task.onExternalAbort);
    window.removeEventListener("beforeunload", beforeUnload);
    window.removeEventListener("keydown", guardEditorKeys, true);
    cover.value = null;
    if (restoreFocus && task.previousFocus?.isConnected) {
      const previousFocus = task.previousFocus;
      requestAnimationFrame(() => {
        if (!active) previousFocus.focus();
      });
    }
    if (value instanceof Error) task.reject(value);
    else task.resolve(value);
  }

  /** 等待 Worker 协作取消，遇到卡住的编解码器时终止线程。 */
  function cancelExport(): void {
    const task = active;
    if (!task || task.controller.signal.aborted) return;
    task.controller.abort();
    const reason = new DOMException("已取消导出", "AbortError");
    if (!task.worker) {
      finish(task, reason);
      return;
    }
    cover.value = { stage: "cancelling", percent: null, choices: [] };
    task.timeout = setTimeout(() => finish(task, reason), 2000);
    post(task, { type: "cancel", jobId: task.id });
  }

  /** 通知宿主和组件同一份进度，订阅者异常不会影响渲染。 */
  function progress(task: ActiveExport, update: ComposeVideoExportProgress): void {
    if (update.stage !== "complete") {
      cover.value = { stage: update.stage, percent: update.percent, choices: [], notice: cover.value?.notice };
    }
    try {
      task.options.onProgress?.(update);
    } catch (error: unknown) {
      console.warn("视频导出进度回调失败", error);
    }
  }

  /** 把所选档位提交给已经准备好的同一个 Worker。 */
  function selectResolution(resolution: ComposeVideoExportResolution): void {
    const task = active;
    if (!task || cover.value?.stage !== "choosing" || !cover.value.choices.some((item) => item.resolution === resolution)) return;
    startRender(task, resolution);
  }

  /** 渲染前保留准备状态，首帧编码后才有确定的进度。 */
  function startRender(task: ActiveExport, resolution: ComposeVideoExportResolution): void {
    progress(task, { stage: "preparing", percent: null });
    post(task, { type: "render", jobId: task.id, resolution });
  }

  /** 消息传输失败与 Worker 异常按任务失败处理。 */
  function post(task: ActiveExport, command: ExportWorkerCommand): void {
    try {
      task.worker?.postMessage(command);
    } catch (error: unknown) {
      finish(task, error instanceof Error ? error : new Error("导出消息发送失败"));
    }
  }

  /** 预检结果、进度和终态都通过任务编号与当前遮罩对应。 */
  function onWorkerEvent(task: ActiveExport, event: ExportWorkerEvent): void {
    if (active !== task || event.jobId !== task.id) return;
    if (task.controller.signal.aborted || event.type === "cancelled") {
      if (event.type === "complete" || event.type === "error" || event.type === "cancelled") {
        finish(task, new DOMException("已取消导出", "AbortError"));
      }
      return;
    }
    switch (event.type) {
      case "ready": {
        const requested = task.options.resolution;
        const sourceOnly = event.choices.length === 1 && event.choices[0].resolution === "source";
        cover.value = { stage: "choosing", percent: null, choices: event.choices, notice: event.notice };
        if (requested && !event.modelFallback && event.choices.some((item) => item.resolution === requested)) startRender(task, requested);
        else if (sourceOnly && (!task.options.upscalerId || task.options.upscalerId === "balanced")) startRender(task, "source");
        break;
      }
      case "progress":
        progress(task, event.progress);
        break;
      case "complete":
        finish(task, { ...event.result, fileName: `成片-${new Date().toISOString().replace(/[:.]/g, "-")}.mp4` });
        progress(task, { stage: "complete", percent: 100 });
        break;
      case "error":
        finish(task, new ComposeVideoExportError(event.message, event.retryAtSource));
    }
  }

  /** 准备完成前不创建 Worker。迟到的资源解析不得重新启动已取消的任务。 */
  async function prepare(task: ActiveExport): Promise<void> {
    try {
      const snapshot = await buildExportSnapshot(session.tracks(), {
        algorithmBaseUrl: session.algorithmBase(),
        transitionBackend: session.transitionBackend(),
        resolveMediaUrl: session.resolveMediaUrl(),
        signal: task.controller.signal,
      });
      if (active !== task) return;
      const createWorker = session.createWorker();
      const worker = createWorker ? createWorker() : new ExportWorker({ name: "compose-video-export" });
      task.worker = worker;
      worker.onmessage = ({ data }: MessageEvent<ExportWorkerEvent>): void => onWorkerEvent(task, data);
      worker.onerror = (event): void => {
        event.preventDefault();
        finish(
          task,
          task.controller.signal.aborted
            ? new DOMException("已取消导出", "AbortError")
            : new Error(event.message || "视频导出 Worker 失败"),
        );
      };
      worker.onmessageerror = (): void => finish(task, new Error("无法读取视频导出 Worker 的结果"));
      post(task, {
        type: "prepare",
        jobId: task.id,
        snapshot,
        upscalerId: task.options.upscalerId ?? "balanced",
        sourceOnly: task.options.resolution === "source",
      });
    } catch (error: unknown) {
      finish(task, error instanceof Error ? error : new Error("导出素材准备失败"));
    }
  }

  /** 组件公开入口。调用时暂停编辑器并冻结快照。 */
  async function exportVideo(options: ComposeVideoExportOptions = {}): Promise<ComposeVideoExportResult> {
    if (active) throw new Error("已有一个视频正在导出");
    if (options.signal?.aborted) throw new DOMException("已取消导出", "AbortError");
    const focus = document.activeElement;
    if (focus instanceof HTMLElement && session.root()?.contains(focus)) focus.blur();
    session.pause();
    return new Promise((resolve, reject) => {
      const task: ActiveExport = {
        id: ++nextId,
        options,
        controller: new AbortController(),
        onExternalAbort: cancelExport,
        previousFocus: focus instanceof HTMLElement ? focus : null,
        resolve,
        reject,
      };
      active = task;
      options.signal?.addEventListener("abort", task.onExternalAbort, { once: true });
      window.addEventListener("beforeunload", beforeUnload);
      window.addEventListener("keydown", guardEditorKeys, true);
      progress(task, { stage: "preparing", percent: null });
      if (active === task) void prepare(task);
    });
  }

  onBeforeUnmount(() => {
    const task = active;
    if (!task) return;
    task.controller.abort();
    finish(task, new DOMException("编辑器已关闭", "AbortError"), false);
  });

  return { cover, exportVideo, cancelExport, selectResolution };
}
