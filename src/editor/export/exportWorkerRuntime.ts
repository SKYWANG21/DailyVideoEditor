import { AudioSampleSource, BufferTarget, CanvasSource, Mp4OutputFormat, Output, canEncodeAudio, canEncodeVideo } from "mediabunny";
import type { TransitionEffectDefinition } from "@/types/transition";
import type { VideoLayerSize, VideoLayerUpscaler, VideoLayerUpscalerFactory } from "@/types/videoExport";
import { EXPORT_AUDIO, ExportAudioMixer } from "./exportAudio";
import { clipFrame, layerUpscaleSize, outputSizes, projectSize } from "./exportGeometry";
import { ExportMedia } from "./exportMedia";
import type { ExportResolutionChoice, ExportWorkerCommand, ExportWorkerEvent } from "./exportProtocol";
import { EXPORT_FPS, ExportRenderer, ExportUpscaleError } from "./exportRenderer";
import { capMp4MovieDuration } from "./mp4Duration";
import { OpenReelUpscaler } from "./openReelUpscaler";

/** 默认使用 OpenReel balanced，source 允许显式跳过增强放大。 */
const BUILTIN_UPSCALER_ID = "balanced";
const WINDOW_FRAMES = 8;

/** 宿主在自定义 Worker 入口登记模型与转场。 */
export interface ComposeExportWorkerOptions {
  /** 算法 ID 到实例工厂。balanced 是内置保留 ID。 */
  upscalers?: Readonly<Record<string, VideoLayerUpscalerFactory>>;
  /** 与宿主编辑器同 ID 的 Worker 版自定义转场。 */
  transitionEffects?: readonly TransitionEffectDefinition[];
}

/** 最小 Worker 消息能力，避免使用 Window 类型。 */
interface ExportScope {
  onmessage: ((event: MessageEvent<ExportWorkerCommand>) => void) | null;
  postMessage(event: ExportWorkerEvent): void;
}

/** 安装串行导出消息入口。每个 Worker 同时处理一个任务。 */
export function installComposeExportWorker(options: ComposeExportWorkerOptions = {}): void {
  const scope = globalThis as unknown as ExportScope;
  let job: ExportJob | null = null;
  scope.onmessage = ({ data }): void => {
    if (data.type === "prepare") {
      if (job) return;
      job = new ExportJob(
        data,
        options,
        (event) => scope.postMessage(event),
        () => {
          job = null;
        },
      );
      void job.prepare();
    } else if (job?.id === data.jobId) {
      if (data.type === "cancel") job.cancel();
      else void job.render(data.resolution);
    }
  };
}

/** 准备、分辨率选择、渲染与封装属于同一任务。 */
class ExportJob {
  private readonly controller = new AbortController();
  private readonly media = new ExportMedia();
  private audio: ExportAudioMixer | null = null;
  private upscaler: VideoLayerUpscaler | null = null;
  private choices: ExportResolutionChoice[] = [];
  private phase: "preparing" | "ready" | "rendering" | "ended" = "preparing";

  constructor(
    private readonly request: Extract<ExportWorkerCommand, { type: "prepare" }>,
    private readonly options: ComposeExportWorkerOptions,
    private readonly post: (event: ExportWorkerEvent) => void,
    private readonly release: () => void,
  ) {}

  /** 与组件侧任务编号对应。 */
  get id(): number {
    return this.request.jobId;
  }

  /** 逐个探测媒体、音频编码与允许选择的输出档位。 */
  async prepare(): Promise<void> {
    const { snapshot, upscalerId, sourceOnly } = this.request;
    const { signal } = this.controller;
    try {
      if (typeof OffscreenCanvas === "undefined") throw new Error("当前浏览器不支持离屏画布");
      if (!globalThis.isSecureContext) throw new Error("视频导出需要 HTTPS 或 localhost");
      await this.media.prepare(snapshot, signal);
      this.audio = new ExportAudioMixer(snapshot.audio, this.media);
      if (this.audio.hasAudio) await prepareAac();
      const base = projectSize(snapshot, this.media);
      const encodable: ExportResolutionChoice[] = [];
      for (const size of outputSizes(base, snapshot.mainClips, this.media)) {
        signal.throwIfAborted();
        if (sourceOnly && size.resolution !== "source") continue;
        if (await canEncodeVideo("avc", { width: size.width, height: size.height, frameRate: EXPORT_FPS, bitrate: videoBitrate(size) })) {
          encodable.push(size);
        }
      }
      const presetSizes = encodable.filter((size) => size.resolution !== "source");
      const modelSelected = upscalerId !== BUILTIN_UPSCALER_ID && !sourceOnly;
      let presets = presetSizes.length ? await this.prepareUpscaler(upscalerId, presetSizes, base) : [];
      const modelFallback = modelSelected && presets.length === 0;
      if (modelFallback && presetSizes.length) presets = await this.prepareUpscaler(BUILTIN_UPSCALER_ID, presetSizes, base);
      const sourceChoices = !presets.length || modelFallback ? encodable.filter((size) => size.resolution === "source") : [];
      this.choices = [...presets, ...sourceChoices];
      signal.throwIfAborted();
      if (!this.choices.length) throw new Error("当前浏览器无法使用 H.264 编码所需的输出尺寸");
      this.phase = "ready";
      this.post({
        type: "ready",
        jobId: this.id,
        choices: this.choices,
        modelFallback,
        notice: modelFallback
          ? "所选模型不支持当前工程，可选择当前可用的增强放大或素材分辨率。"
          : !sourceOnly && !presets.length
            ? "当前设备无法使用增强放大，将采用素材分辨率。"
            : undefined,
      });
    } catch (error: unknown) {
      await this.fail(error);
    }
  }

  /** 实例化指定算法，并在呈现档位前验证实际处理能力。 */
  private async prepareUpscaler(id: string, sizes: ExportResolutionChoice[], base: VideoLayerSize): Promise<ExportResolutionChoice[]> {
    await this.upscaler?.dispose();
    const factory = this.options.upscalers?.[id];
    if (id !== BUILTIN_UPSCALER_ID && typeof factory !== "function") throw new Error(`未注册增强放大实现：${id}`);
    const upscaler = id === BUILTIN_UPSCALER_ID ? new OpenReelUpscaler() : factory!();
    this.upscaler = upscaler;
    if (id === BUILTIN_UPSCALER_ID && !(await upscaler.probe({ width: 8, height: 8 }, { width: 16, height: 16 }, this.controller.signal))) {
      return [];
    }
    const choices: ExportResolutionChoice[] = [];
    const cache = new Map<string, boolean>();
    for (const size of sizes) {
      if (await this.probeUpscale(size, base, cache)) choices.push(size);
    }
    return choices;
  }

  /** 分辨率锁定后按有限窗口串行渲染、混音、封装。 */
  async render(resolution: ExportResolutionChoice["resolution"]): Promise<void> {
    if (this.phase !== "ready") return;
    const size = this.choices.find((item) => item.resolution === resolution);
    if (!size) {
      await this.fail(new Error("所选输出分辨率没有通过预检"));
      return;
    }
    this.phase = "rendering";
    const { snapshot } = this.request;
    const { signal } = this.controller;
    let renderer: ExportRenderer | undefined;
    let output: Output | undefined;
    try {
      const target = new BufferTarget();
      const movie: { box?: { bytes: Uint8Array; position: number } } = {};
      output = new Output({
        format: new Mp4OutputFormat({
          fastStart: false,
          onMoov(bytes, position) {
            movie.box = { bytes, position };
          },
        }),
        target,
      });
      renderer = new ExportRenderer({
        snapshot,
        size,
        base: projectSize(snapshot, this.media),
        media: this.media,
        upscaler: resolution === "source" ? null : this.upscaler,
        transitionEffects: this.options.transitionEffects ?? [],
        signal,
      });
      await renderer.prepare();
      signal.throwIfAborted();
      const video = new CanvasSource(renderer.canvas, { codec: "avc", bitrate: videoBitrate(size) });
      const audio = this.audio?.hasAudio ? new AudioSampleSource({ codec: "aac", bitrate: EXPORT_AUDIO.bitrate }) : null;
      output.addVideoTrack(video);
      if (audio) output.addAudioTrack(audio);
      await output.start();
      await this.encode(renderer, video, audio);
      video.close();
      audio?.close();
      this.post({ type: "progress", jobId: this.id, progress: { stage: "finalizing", percent: null } });
      await output.finalize();
      signal.throwIfAborted();
      if (!target.buffer || !movie.box) throw new Error("MP4 封装没有返回文件和时长元数据");
      const { bytes, position } = movie.box;
      const blob = new Blob(
        [
          new Uint8Array(target.buffer, 0, position),
          capMp4MovieDuration(bytes, snapshot.durationSec),
          new Uint8Array(target.buffer, position + bytes.length),
        ],
        { type: "video/mp4" },
      );
      await this.finish(
        {
          type: "complete",
          jobId: this.id,
          result: { width: size.width, height: size.height, durationSec: snapshot.durationSec, blob },
        },
        renderer,
      );
    } catch (error: unknown) {
      await output?.cancel().catch(() => undefined);
      await this.fail(error, renderer);
    }
  }

  /** 关闭输入以中断待处理的媒体读取，等待中的任务直接结束。 */
  cancel(): void {
    this.controller.abort();
    this.media.dispose();
    if (this.phase === "ready") void this.fail(this.controller.signal.reason);
  }

  /** 转场和绘制同样按输出帧递增，同步提交同窗口的音频。 */
  private async encode(renderer: ExportRenderer, video: CanvasSource, audio: AudioSampleSource | null): Promise<void> {
    const { durationSec } = this.request.snapshot;
    const { signal } = this.controller;
    const totalFrames = Math.max(1, Math.ceil(durationSec * EXPORT_FPS - 1e-8));
    let lastProgress = -1;
    for (let frame = 0; frame < totalFrames; frame += 1) {
      signal.throwIfAborted();
      const timestamp = frame / EXPORT_FPS;
      const end = Math.min(durationSec, (frame + 1) / EXPORT_FPS);
      await renderer.draw(frame);
      signal.throwIfAborted();
      await video.add(timestamp, end - timestamp);
      if ((frame + 1) % WINDOW_FRAMES === 0 || frame + 1 === totalFrames) {
        if (audio) await this.audio?.writeUntil(end, audio, signal);
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
      }
      const progress = Math.min(99, Math.floor(((frame + 1) / totalFrames) * 100));
      if (progress !== lastProgress) {
        lastProgress = progress;
        this.post({ type: "progress", jobId: this.id, progress: { stage: "rendering", percent: progress } });
      }
    }
    signal.throwIfAborted();
  }

  /** 相同尺寸组合只探测一次，只有需要放大的图层调用算法。 */
  private async probeUpscale(size: ExportResolutionChoice, base: VideoLayerSize, cache: Map<string, boolean>): Promise<boolean> {
    const { signal } = this.controller;
    const upscaler = this.upscaler;
    if (!upscaler) return false;
    const clips = this.request.snapshot.tracks.flatMap((track) => track.clips.filter((clip) => clip.visible));
    for (const clip of clips) {
      signal.throwIfAborted();
      const source = this.media.size(clip);
      const target = layerUpscaleSize(clipFrame(clip, base, source), source, base, size);
      if (!target) continue;
      const key = `${source.width}x${source.height}:${target.width}x${target.height}`;
      if (!cache.has(key)) {
        const supported = await upscaler.probe(source, target, signal).catch(() => false);
        signal.throwIfAborted();
        cache.set(key, supported);
      }
      if (!cache.get(key)) return false;
    }
    return true;
  }

  /** 封装和清理结束后，只向组件结算一次结果。 */
  private async finish(event: ExportWorkerEvent, renderer?: ExportRenderer): Promise<void> {
    if (this.phase === "ended") return;
    this.phase = "ended";
    try {
      renderer?.dispose();
      this.audio?.dispose();
      this.media.dispose();
      await this.upscaler?.dispose();
    } finally {
      this.release();
      this.post(this.controller.signal.aborted ? { type: "cancelled", jobId: this.id } : event);
    }
  }

  /** 保留失败原因并区分主动取消。 */
  private fail(error: unknown, renderer?: ExportRenderer): Promise<void> {
    return this.finish(
      {
        type: "error",
        jobId: this.id,
        message: error instanceof Error ? error.message : "视频导出失败",
        retryAtSource: error instanceof ExportUpscaleError,
      },
      renderer,
    );
  }
}

/** 同一尺寸在能力探测和实际编码中使用相同码率。 */
function videoBitrate(size: { width: number; height: number }): number {
  return Math.max(1000000, Math.round(size.width * size.height * 4));
}

/** 优先用原生 AAC，缺失时按需加载软件 AAC-LC。 */
async function prepareAac(): Promise<void> {
  if (await canEncodeAudio("aac", EXPORT_AUDIO)) return;
  const { registerAacEncoder } = await import("@mediabunny/aac-encoder");
  registerAacEncoder();
  if (!(await canEncodeAudio("aac", EXPORT_AUDIO))) throw new Error("当前浏览器无法编码 AAC-LC 音频");
}
