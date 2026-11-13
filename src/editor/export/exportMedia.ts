import {
  ALL_FORMATS,
  BlobSource,
  CanvasSink,
  Input,
  UrlSource,
  type InputAudioTrack,
  type InputVideoTrack,
  type WrappedCanvas,
} from "mediabunny";
import type { VideoLayerSize } from "@/types/videoExport";
import type { ComposeExportSnapshot, ExportAudioClip, ExportVideoClip } from "./exportProtocol";

/** 同一素材共享输入和音视频时间原点。 */
interface MediaSource {
  input: Input;
  start: number;
  audio: InputAudioTrack | null;
  video: { track: InputVideoTrack; size: VideoLayerSize; end: number } | null;
}

/** 导出素材按 URL 去重，结束时中止读取并释放解码器。 */
export class ExportMedia {
  private readonly items = new Map<string, MediaSource>();

  /** 解析实际轨道、解码能力与显示像素，准备阶段就报告不可用素材。 */
  async prepare(snapshot: ComposeExportSnapshot, signal: AbortSignal): Promise<void> {
    const videoUrls = new Map(
      [...snapshot.mainClips, ...snapshot.tracks.flatMap((track) => track.clips.filter((clip) => clip.visible))].map((clip) => [
        clip.url,
        clip.title,
      ]),
    );
    for (const { url, input } of snapshot.sources) {
      signal.throwIfAborted();
      const media = new Input({
        formats: ALL_FORMATS,
        source:
          typeof input === "string"
            ? new UrlSource(input, { parallelism: 1, getRetryDelay: (attempt) => (attempt < 1 ? 0.25 : null), maxCacheSize: 8 * 1024 ** 2 })
            : new BlobSource(input),
      });
      const source: MediaSource = { input: media, start: 0, audio: null, video: null };
      this.items.set(url, source);
      try {
        const video = await media.getPrimaryVideoTrack();
        source.audio = await media.getPrimaryAudioTrack();
        source.start = await media.getFirstTimestamp();
        if (videoUrls.has(url)) {
          if (!video || !(await video.canDecode())) throw new Error("当前浏览器无法解码视频轨");
          const width = await video.getDisplayWidth();
          const height = await video.getDisplayHeight();
          const end = (await video.getDurationFromMetadata()) ?? (await video.computeDuration());
          source.video = { track: video, size: { width, height }, end };
        }
        const audio = snapshot.audio.filter((clip) => clip.url === url);
        if (audio.some((clip) => !clip.embedded) && !source.audio) throw new Error("素材没有可用音轨");
        if (audio.length && source.audio && !(await source.audio.canDecode())) throw new Error("当前浏览器无法解码音轨");
      } catch (error: unknown) {
        signal.throwIfAborted();
        const name = videoUrls.get(url) ?? "音频素材";
        throw new Error(`${name}读取失败：${error instanceof Error ? error.message : "格式或跨域读取不可用"}`);
      }
    }
  }

  /** 素材方向校正后的显示尺寸。 */
  size(clip: ExportVideoClip): VideoLayerSize {
    return this.video(clip).size;
  }

  /** 创建独立的片段取帧游标，转场双方可交替消费而不覆盖缓冲。 */
  videoCursor(clip: ExportVideoClip): ExportVideoCursor {
    const source = this.get(clip.url);
    const video = this.video(clip);
    // Canvas 池属于 Sink。相同媒体同时出现在转场两侧时，各游标需有独立的池。
    return new ExportVideoCursor(new CanvasSink(video.track, { poolSize: 2 }), source.start, video.end);
  }

  /** 取得音轨和素材时间原点，纯视频的内嵌原声返回空。 */
  audio(clip: ExportAudioClip): { track: InputAudioTrack; start: number } | null {
    const { audio, start } = this.get(clip.url);
    return audio ? { track: audio, start } : null;
  }

  /** 释放所有输入，包括仍在进行的网络读。 */
  dispose(): void {
    for (const item of this.items.values()) item.input.dispose();
    this.items.clear();
  }

  /** URL 来自预检快照。 */
  private get(url: string): MediaSource {
    const source = this.items.get(url);
    if (!source) throw new Error("导出素材尚未准备");
    return source;
  }

  /** 视频素材缺轨在预检时失败。 */
  private video(clip: ExportVideoClip): NonNullable<MediaSource["video"]> {
    const video = this.get(clip.url).video;
    if (!video) throw new Error(`${clip.title}没有视频轨`);
    return video;
  }
}

/** 连续取帧复用同一个解码迭代器，只保留当前帧和下一帧。 */
export class ExportVideoCursor {
  private iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
  private current: WrappedCanvas | null = null;
  private next: WrappedCanvas | null = null;

  constructor(
    private readonly sink: CanvasSink,
    private readonly start: number,
    private readonly end: number,
  ) {}

  /** 选取实际 PTS 覆盖源时间的帧，容许素材首尾解码时间和项目时间不同。 */
  async at(seconds: number): Promise<WrappedCanvas | null> {
    const time = Math.min(this.start + seconds, this.end - 0.000001);
    if (!this.iterator) {
      this.iterator = this.sink.canvases(time);
      this.next = (await this.iterator.next()).value ?? null;
      if (!this.next || this.next.timestamp > time) {
        this.current = await this.sink.getCanvas(time);
      }
    }
    while (this.next && this.next.timestamp <= time + 0.000001) {
      this.current = this.next;
      this.next = (await this.iterator.next()).value ?? null;
    }
    return this.current;
  }

  /** 片段离开渲染范围时关闭生成器，避免长项目持有多路解码。 */
  close(): void {
    void this.iterator?.return().catch(() => undefined);
    this.iterator = null;
    this.current = this.next = null;
  }
}
