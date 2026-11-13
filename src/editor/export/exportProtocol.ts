import type {
  BeautyParams,
  ComposeFrameAspect,
  ComposeTextOverlayClip,
  SubtitleStyleConfig,
  VideoClipItem,
  VideoFrameTransform,
} from "@/types/videoCompose";
import type { ComposeTransition } from "@/types/transition";
import type {
  ComposeVideoExportProgress,
  ComposeVideoExportResolution,
  ComposeVideoExportResult,
  VideoLayerSize,
} from "@/types/videoExport";

/** 时间轴上的半开区间（秒）。 */
export interface ExportInterval {
  startTime: number;
  endTime: number;
}

/** 已归一化的主轨或叠加视频片段。 */
export interface ExportVideoClip extends VideoClipItem {
  type: "video";
  startTime: number;
  endTime: number;
  visible: boolean;
  frame: VideoFrameTransform | null;
  beauty: BeautyParams;
}

/** 按合成顺序绘制的视频轨。 */
export interface ExportVideoTrack {
  clips: ExportVideoClip[];
  transitions: ComposeTransition[];
}

/** 可听音源，source 由 url 关联素材表。 */
export interface ExportAudioClip extends ExportInterval {
  id: string;
  url: string;
  trimStart: number;
  playbackRate: number;
  volume: number;
  embedded: boolean;
}

/** 已应用编辑器样式的字幕。 */
export interface ExportSubtitle extends ExportInterval, SubtitleStyleConfig {
  text: string;
}

/** 在页面端栅格化的静态花字，Worker 按输出像素绘制。 */
export interface ExportSticker extends ComposeTextOverlayClip {
  image: Blob;
  aspect: number;
}

/** 与编辑器状态隔离的导出工程。 */
export interface ComposeExportSnapshot {
  mainClips: ExportVideoClip[];
  aspect: ComposeFrameAspect;
  durationSec: number;
  tracks: ExportVideoTrack[];
  audio: ExportAudioClip[];
  subtitles: ExportSubtitle[];
  stickers: ExportSticker[];
  sources: Array<{ url: string; input: string | Blob }>;
  algorithmBaseUrl: string;
  transitionBackend: "canvas" | "wasm";
}

/** 预检通过、可以交给用户选择的分辨率。 */
export interface ExportResolutionChoice extends VideoLayerSize {
  resolution: ComposeVideoExportResolution;
}

/** 同一任务先准备，收到所选档位后再编码。 */
export type ExportWorkerCommand =
  | { type: "prepare"; jobId: number; snapshot: ComposeExportSnapshot; upscalerId: string; sourceOnly: boolean }
  | { type: "render"; jobId: number; resolution: ComposeVideoExportResolution }
  | { type: "cancel"; jobId: number };

/** 事件携带任务 ID，避免迟到的结果覆盖新任务。 */
export type ExportWorkerEvent =
  | { type: "ready"; jobId: number; choices: ExportResolutionChoice[]; notice?: string; modelFallback?: boolean }
  | { type: "progress"; jobId: number; progress: ComposeVideoExportProgress }
  | { type: "complete"; jobId: number; result: Omit<ComposeVideoExportResult, "fileName"> }
  | { type: "cancelled"; jobId: number }
  | { type: "error"; jobId: number; message: string; retryAtSource?: boolean };
