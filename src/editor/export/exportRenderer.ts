import { drawPreviewCanvasFrame } from "@/hooks/previewCanvasFrame";
import { previewSeekTimeSec } from "@/hooks/previewSourceTime";
import { createTransitionRegistry } from "@/transitions/catalog";
import { TransitionEngine } from "@/transitions/engine";
import { resolveTransitionSeams } from "@/transitions/timing";
import type { TransitionEffectDefinition } from "@/types/transition";
import type { VideoLayerSize, VideoLayerUpscaler } from "@/types/videoExport";
import { ExportBeauty } from "./exportBeauty";
import { clipFrame, layerUpscaleSize } from "./exportGeometry";
import type { ExportMedia, ExportVideoCursor } from "./exportMedia";
import { ExportOverlays } from "./exportOverlays";
import type { ComposeExportSnapshot, ExportVideoClip, ExportVideoTrack, SampleExportSticker } from "./exportProtocol";
import { loadExportWasmTransition } from "./exportTransition";

/** 与编辑器预览一致的输出采样帧率。 */
export const EXPORT_FPS = 30;

/** 区分增强放大失败，使宿主能提供素材档重试。 */
export class ExportUpscaleError extends Error {}

/** 只持有仍在渲染范围内的片段资源。 */
interface ActiveClip {
  cursor: ExportVideoCursor;
  frameIndex: number;
  sourceTimeUs: number;
  enhanced: ImageBitmap | null;
}

/** 当前任务所需的合成参数和 Worker 注册资源。 */
interface RendererOptions {
  snapshot: ComposeExportSnapshot;
  media: ExportMedia;
  base: VideoLayerSize;
  size: VideoLayerSize;
  upscaler: VideoLayerUpscaler | null;
  transitionEffects: readonly TransitionEffectDefinition[];
  signal: AbortSignal;
  sampleSticker: SampleExportSticker;
}

/** 每次合成一帧，输入帧、转场和叠层均留在导出 Worker。 */
export class ExportRenderer {
  readonly canvas: OffscreenCanvas;
  private readonly ctx: OffscreenCanvasRenderingContext2D;
  private readonly layers: [OffscreenCanvasRenderingContext2D, OffscreenCanvasRenderingContext2D];
  private readonly registry: ReturnType<typeof createTransitionRegistry>;
  private readonly transitions: TransitionEngine;
  private readonly overlays: ExportOverlays;
  private readonly beauty: ExportBeauty | null;
  private readonly tracks;
  private readonly active = new Map<string, ActiveClip>();

  constructor(private readonly options: RendererOptions) {
    const { size, base, snapshot, transitionEffects, signal } = options;
    this.ctx = exportContext(size, false);
    this.canvas = this.ctx.canvas;
    this.layers = [exportContext(size, true), exportContext(size, true)];
    this.registry = createTransitionRegistry({
      backend: snapshot.transitionBackend,
      effects: transitionEffects,
      loadWasm: (url) => loadExportWasmTransition(url, signal),
    });
    this.transitions = new TransitionEngine(this.registry);
    this.overlays = new ExportOverlays(snapshot.subtitles, base, size);
    this.tracks = snapshot.tracks.map((track) => ({
      ...track,
      byId: new Map(track.clips.map((clip) => [clip.id, clip])),
      seams: resolveTransitionSeams(track.clips, track.transitions),
    }));
    this.beauty = this.tracks.some(({ clips }) => clips.some((clip) => clip.visible && clip.beauty.enabled))
      ? new ExportBeauty(snapshot.algorithmBaseUrl)
      : null;
  }

  /** 预加载实际使用的效果、花字位图和 GPUPixel。 */
  async prepare(): Promise<void> {
    const { snapshot, signal } = this.options;
    const effects = new Set(
      this.tracks.flatMap(({ transitions, byId }) =>
        transitions.filter((item) => byId.get(item.clipAId)?.visible && byId.get(item.clipBId)?.visible).map((item) => item.effectId),
      ),
    );
    for (const id of effects) {
      signal.throwIfAborted();
      await this.registry.resolve(id);
    }
    await this.overlays.prepare(snapshot.stickers, signal);
    await this.beauty?.prepare();
  }

  /** 黑底承接时间轴空隙，片段活跃范围包括转场预卷。 */
  async draw(frameIndex: number): Promise<void> {
    const time = frameIndex / EXPORT_FPS;
    this.ctx.fillStyle = "#000";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    for (const track of this.tracks) await this.drawTrack(track, time, frameIndex);
    await this.overlays.draw(this.ctx, time, this.options.sampleSticker);
    for (const [id, active] of this.active) {
      if (active.frameIndex === frameIndex) continue;
      active.cursor.close();
      active.enhanced?.close();
      this.beauty?.release(id);
      this.options.upscaler?.releaseClip?.(id);
      this.active.delete(id);
    }
  }

  /** 使用当前区间的转场或普通 Clip 画面。 */
  private async drawTrack(
    track: ExportVideoTrack & { byId: Map<string, ExportVideoClip>; seams: ReturnType<typeof resolveTransitionSeams> },
    time: number,
    frameIndex: number,
  ): Promise<void> {
    for (const seam of track.seams) {
      if (!seam.transition) continue;
      const duration = seam.transition.durationSec;
      const start = seam.cut - duration / 2;
      if (time < start || time >= start + duration) continue;
      const left = track.byId.get(seam.clipA.id)!;
      const right = track.byId.get(seam.clipB.id)!;
      if (!left.visible || !right.visible) break;
      for (const [index, clip] of [left, right].entries()) {
        const ctx = this.layers[index];
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        await this.drawClip(ctx, clip, time, frameIndex);
      }
      const result = await this.transitions.render({
        effectId: seam.transition.effectId,
        params: seam.transition.params,
        progress: (time - start) / duration,
        width: this.canvas.width,
        height: this.canvas.height,
        outgoing: this.layers[0].canvas,
        incoming: this.layers[1].canvas,
      });
      this.ctx.drawImage(result, 0, 0);
      return;
    }
    const clip = track.clips.find((item) => item.visible && time >= item.startTime && time < item.endTime);
    if (clip) await this.drawClip(this.ctx, clip, time, frameIndex);
  }

  /** 先处理视频本身的像素，再应用项目坐标中的位置、尺寸和旋转。 */
  private async drawClip(ctx: OffscreenCanvasRenderingContext2D, clip: ExportVideoClip, time: number, frameIndex: number): Promise<void> {
    const { media, signal, base, size, upscaler } = this.options;
    signal.throwIfAborted();
    let active = this.active.get(clip.id);
    if (!active) {
      active = { cursor: media.videoCursor(clip), frameIndex: -2, sourceTimeUs: -1, enhanced: null };
      this.active.set(clip.id, active);
    }
    const resetHistory = active.frameIndex !== frameIndex - 1;
    active.frameIndex = frameIndex;
    const sourceTime = previewSeekTimeSec([clip], 0, time);
    const decoded = await active.cursor.at(sourceTime);
    if (!decoded) throw new Error(`素材「${clip.title}」在源时间 ${sourceTime.toFixed(3)} 秒无法取得视频帧`);
    const source = media.size(clip);
    const frame = clipFrame(clip, base, source);
    const target = upscaler ? layerUpscaleSize(frame, source, base, size) : null;
    const sourceTimeUs = Math.round(decoded.timestamp * 1e6);
    if (sourceTimeUs !== active.sourceTimeUs || resetHistory) {
      active.enhanced?.close();
      active.enhanced = null;
      active.enhanced = await this.enhance(decoded.canvas, clip, target, sourceTimeUs, resetHistory || sourceTimeUs < active.sourceTimeUs);
      active.sourceTimeUs = sourceTimeUs;
    }
    ctx.save();
    ctx.scale(size.width / base.width, size.height / base.height);
    try {
      drawPreviewCanvasFrame(ctx, active.enhanced ?? decoded.canvas, source.width, source.height, base.width, base.height, frame);
    } finally {
      ctx.restore();
    }
  }

  /** 美颜和模型之间只保留一个所有权明确的位图。 */
  private async enhance(
    source: CanvasImageSource,
    clip: ExportVideoClip,
    target: VideoLayerSize | null,
    sourceTimeUs: number,
    resetHistory: boolean,
  ): Promise<ImageBitmap | null> {
    const { upscaler, signal } = this.options;
    if (!clip.beauty.enabled && !target) return null;
    let bitmap: ImageBitmap | null = await createImageBitmap(source);
    try {
      if (clip.beauty.enabled && this.beauty) {
        const result = await this.beauty.apply(bitmap, clip.beauty, clip.id, sourceTimeUs, signal);
        bitmap.close();
        bitmap = result;
      }
      if (!target || !upscaler) {
        const result = bitmap;
        bitmap = null;
        return result;
      }
      try {
        const result = await upscaler.upscale({ frame: bitmap, targetSize: target, clipId: clip.id, sourceTimeUs, resetHistory, signal });
        if (result === bitmap || result.width !== target.width || result.height !== target.height || signal.aborted) {
          result.close();
          signal.throwIfAborted();
          throw new Error("增强放大返回了无效的图层位图");
        }
        return result;
      } catch (error: unknown) {
        signal.throwIfAborted();
        throw new ExportUpscaleError(`${clip.title}增强放大失败：${error instanceof Error ? error.message : "图层处理失败"}`);
      }
    } finally {
      bitmap?.close();
    }
  }

  /** 清理渲染与叠层资源。 */
  dispose(): void {
    for (const item of this.active.values()) {
      item.cursor.close();
      item.enhanced?.close();
    }
    this.active.clear();
    this.beauty?.dispose();
    this.overlays.dispose();
    this.registry.dispose();
  }
}

/** 构建导出用画布。 */
function exportContext(size: VideoLayerSize, alpha: boolean): OffscreenCanvasRenderingContext2D {
  const context = new OffscreenCanvas(size.width, size.height).getContext("2d", { alpha });
  if (!context) throw new Error("当前浏览器不支持离屏导出画布");
  context.imageSmoothingQuality = "high";
  return context;
}
