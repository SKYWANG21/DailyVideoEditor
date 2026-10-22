import type { MediaClip, RectConfig, SubtitleClip, TextClip, TrackType } from "@/clip-track";
import { generateId } from "@/clip-track";
import type { BeautyParams, ComposeConfig, PreviewAudioClip, SubtitleItem, SubtitleStyleConfig, VideoClipItem } from "@/types/composeMedia";
import { createDefaultComposeConfig, createDefaultSubtitleStyle, readBeautyParams } from "@/types/composeMedia";
import { clampGain } from "@/editor/volumeDb";

/** 媒体业务类型（本地声明，不请求签名接口） */
export type MediaBizType =
  | "source_video"
  | "source_segment"
  | "create_record"
  | "create_record_result"
  | "ai_creation_merge"
  | "ai_creation_frame"
  | "ai_creation_result"
  | "digital_human"
  | "digital_human_voice"
  | "slice_fission";

export type {
  BeautyParams,
  ComposeConfig,
  SubtitleItem,
  SubtitleStyleConfig,
  VideoClipItem,
  PreviewAudioClip,
  BgmItem,
  SubtitleBoxDraft,
} from "@/types/composeMedia";

export {
  clampBeautyLevel,
  createDefaultBeautyParams,
  createDefaultComposeConfig,
  createDefaultSubtitleStyle,
  readBeautyParams,
  computeVideoNativeFontSize,
  computeScreenFontSize,
  DEFAULT_SUBTITLE_SCREEN_FONT_PX,
  DEFAULT_SUBTITLE_VIDEO_NATIVE_FONT_SIZE,
  ASS_TO_CSS_VISUAL_RATIO,
} from "@/types/composeMedia";

/** Timeline / VideoTrack 默认帧率（不进 model / 请求体） */
export const DEFAULT_COMPOSE_TIMELINE_FPS = 30;

/** vue-clip-track 时间轴倍率下限（与库 minScale 一致） */
export const COMPOSE_TIMELINE_SCALE_MIN = 0.1;

/** vue-clip-track 时间轴倍率上限（与库 maxScale 一致） */
export const COMPOSE_TIMELINE_SCALE_MAX = 10;

/** 时间轴默认显示倍率 */
export const DEFAULT_COMPOSE_TIMELINE_SCALE = 1;

/**
 * 将工程 JSON / 库回调中的倍率收束到合法区间；缺省或非法按 1。
 */
export function normalizeComposeTimelineScale(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_COMPOSE_TIMELINE_SCALE;
  }
  return Math.min(COMPOSE_TIMELINE_SCALE_MAX, Math.max(COMPOSE_TIMELINE_SCALE_MIN, n));
}

/** 分离音轨：MediaClip.config 扩展字段 */
export interface DetachAudioConfig {
  /** video clip：原声已分离到独立音轨 */
  audioDetached?: boolean;
  /** video clip → 对应 audio clip id */
  linkedAudioClipId?: string;
  /** audio clip → 来源 video clip id */
  linkedVideoClipId?: string;
  /** 区分原声轨与 BGM 轨 */
  audioRole?: "original" | "bgm";
  /** 抽轨时的源视频 URL */
  sourceVideoUrl?: string;
  /** 探测无内嵌音轨，避免重复请求抽轨 API */
  hasEmbeddedAudio?: boolean;
  /** 分离进行中 / 失败（刷新后可恢复提示） */
  extractStatus?: "extracting" | "failed";
  /** 最近一次失败原因（可选，供 UI 展示） */
  extractError?: string;
}

/** 一条视频轨共用的画幅。native 为原画，取该轨第一个视频 clip 的像素比 */
export type ComposeFrameAspect = "native" | "16:9" | "9:16" | "4:3" | "3:4";

/**
 * 视频画面在画布中的变换。
 * x/y 相对画布中心，w/h 为缩放前尺寸，scale 为百分比，rotate 为角度。
 */
export interface VideoFrameTransform {
  /** 相对画布中心的水平偏移（画布像素） */
  x: number;
  /** 相对画布中心的垂直偏移（画布像素） */
  y: number;
  /** 缩放前宽度（画布像素） */
  w: number;
  /** 缩放前高度（画布像素） */
  h: number;
  /** 缩放百分比。100 为原始 w/h */
  scale: number;
  /** 旋转角度（度） */
  rotate: number;
}

/** 视频/音频 clip 的 config 业务扩展 */
export type ComposeMediaClipConfig = DetachAudioConfig & {
  /** Step3 视频生成任务 ID */
  taskId?: string;
  /** 预览美颜。只对视频 clip 有意义 */
  beauty?: BeautyParams;
  /** 视频画面变换。没有则按当前画布等比适配，不写入 */
  frame?: VideoFrameTransform;
  /** 该片段视频原始宽度，供原画适配 */
  sourceWidth?: number;
  /** 该片段视频原始高度，供原画适配 */
  sourceHeight?: number;
};

/** 安全读取 clip.config */
export function readClipConfig(config: unknown): ComposeMediaClipConfig {
  if (config && typeof config === "object") {
    return config as ComposeMediaClipConfig;
  }
  return {};
}

/** ASS 扩展字段（SubtitleClip 本体没有的烧录样式） */
export type SubtitleAssExtras = Pick<SubtitleStyleConfig, "bold" | "italic" | "alignment" | "marginL" | "marginR" | "marginV">;

/**
 * 项目字幕 clip：以 vue-clip-track SubtitleClip 为主，
 * 叠加 ASS 扩展；fontFamily/fontSize/color/visible 直接用 SubtitleClip 字段。
 */
export type ComposeSubtitleClip = SubtitleClip & SubtitleAssExtras;

/** 本期支持的 Clip */
export type ComposeClip = MediaClip | ComposeSubtitleClip | TextClip;

/** 贴图轨类型（vue-clip-track TrackType，展示名「贴图」） */
export const TEXT_TEMPLATE_TRACK_TYPE = "text";

/** 贴图轨默认展示名 */
export const TEXT_TEMPLATE_TRACK_NAME = "贴图";

/** 文字模板 clip 默认时长（秒） */
export const DEFAULT_TEXT_CLIP_DURATION_SEC = 3;

/** 无视频元数据时的贴图 rect 回退画布（竖屏短视频） */
export const TEXT_CLIP_FALLBACK_VIDEO_WIDTH = 1080;
export const TEXT_CLIP_FALLBACK_VIDEO_HEIGHT = 1920;

/** TextClip.config：文字模板资源 */
export interface ComposeTextClipConfig {
  /** 素材库剪辑素材 rawId */
  templateId?: string;
  /** 文字模板 SVG 的 OSS 原链 */
  sourceUrl?: string;
}

/** 将 config 字段收成非空字符串（兼容 number rawId） */
function readConfigText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

/** 安全读取 TextClip.config.templateId / sourceUrl */
export function readTextClipConfig(config: unknown): ComposeTextClipConfig {
  if (!config || typeof config !== "object") {
    return {};
  }
  const raw = config as Record<string, unknown>;
  const result: ComposeTextClipConfig = {};
  const templateId = readConfigText(raw.templateId);
  if (templateId) {
    result.templateId = templateId;
  }
  const sourceUrl = readConfigText(raw.sourceUrl);
  if (sourceUrl) {
    result.sourceUrl = sourceUrl;
  }
  return result;
}

/**
 * 默认贴图空间属性：居中、短边约 28%、锁定宽高比、无旋转。
 * 坐标为视频原始像素，供 clip.rect / WebAV 使用。
 */
export function createDefaultTextClipRect(videoW: number, videoH: number, aspect = 1): RectConfig {
  const safeW = videoW > 0 ? videoW : TEXT_CLIP_FALLBACK_VIDEO_WIDTH;
  const safeH = videoH > 0 ? videoH : TEXT_CLIP_FALLBACK_VIDEO_HEIGHT;
  const ratio = aspect > 0 ? aspect : 1;
  let w = Math.max(48, Math.min(safeW, safeH) * 0.28);
  let h = Math.max(48, w / ratio);
  if (h > safeH * 0.9) {
    h = safeH * 0.9;
    w = h * ratio;
  }
  if (w > safeW * 0.9) {
    w = safeW * 0.9;
    h = w / ratio;
  }
  return {
    x: Math.max(0, (safeW - w) / 2),
    y: Math.max(0, (safeH - h) / 2),
    w,
    h,
    angle: 0,
    fixedAspectRatio: true,
  };
}

/** 播放器贴图 overlay 所需字段（由 tracks 派生） */
export interface ComposeTextOverlayClip {
  /** clip id */
  id: string;
  /** 模板 SVG 的 OSS 原链；预览与成片均按此下载，不查素材库 */
  sourceUrl: string;
  /** 展示文案 */
  text: string;
  /** 字号（px，写入 SVG font-size） */
  fontSize: number;
  /** 文字颜色；null 表示沿用模板 SVG 原色 */
  color: string | null;
  /** 时间轴开始（秒） */
  startTime: number;
  /** 时间轴结束（秒） */
  endTime: number;
  /** 画布空间属性；缺省时 overlay 按视频尺寸回退 */
  rect?: RectConfig;
}

/** 从字幕 clip 取出样式切片（喂 Sidebar / Player） */
export function pickSubtitleStyleFromClip(clip: ComposeSubtitleClip): SubtitleStyleConfig {
  return {
    fontFamily: clip.fontFamily,
    fontSize: clip.fontSize,
    color: clip.color,
    bold: clip.bold,
    italic: clip.italic,
    alignment: clip.alignment,
    marginL: clip.marginL,
    marginR: clip.marginR,
    marginV: clip.marginV,
  };
}

/** 创建字幕 clip 时的默认 ASS 扩展 + 基础样式字段 */
export function createDefaultSubtitleClipStyle(): SubtitleStyleConfig & { visible: boolean } {
  return {
    ...createDefaultSubtitleStyle(),
    visible: true,
  };
}

/** 将库/持久化字幕对象补齐为 ComposeSubtitleClip 样式字段 */
export function normalizeSubtitleClipStyle(
  partial: Partial<SubtitleStyleConfig & { visible?: boolean; fontFamily?: string; fontSize?: number; color?: string }>,
): SubtitleStyleConfig & { visible: boolean } {
  const defaults = createDefaultSubtitleStyle();
  return {
    fontFamily: partial.fontFamily || defaults.fontFamily,
    fontSize: partial.fontSize ?? defaults.fontSize,
    color: partial.color || defaults.color,
    bold: partial.bold ?? defaults.bold,
    italic: partial.italic ?? defaults.italic,
    alignment: partial.alignment ?? defaults.alignment,
    marginL: partial.marginL ?? defaults.marginL,
    marginR: partial.marginR ?? defaults.marginR,
    marginV: partial.marginV ?? defaults.marginV,
    visible: partial.visible !== false,
  };
}

/** 对齐 vue-clip-track Track，clips 收窄为 ComposeClip */
export interface ComposeTrack {
  /** 轨道唯一 id */
  id: string;
  /** 轨道类型 */
  type: TrackType;
  /** 展示名 */
  name: string;
  /** 是否主视频轨 */
  isMain?: boolean;
  /** 是否可见（字幕轨可见性可表示是否烧录/预览字幕） */
  visible: boolean;
  /** 是否锁定 */
  locked: boolean;
  /**
   * 音频轨整轨静音；缺省 / false 为正常播放。
   * 仅 type=audio 有意义。成片混音跳过静音轨；预览列表仍保留 clip，由 mixer 静音。
   */
  muted?: boolean;
  /** 轨道上的片段 */
  clips: ComposeClip[];
  /** 轨道排序 */
  order: number;
  /** 视频轨画幅。缺省原画。一条视频轨只有一种 */
  frameAspect?: ComposeFrameAspect;
  /** 原画宽度。取该轨第一个视频 clip 的 videoWidth */
  nativeFrameWidth?: number;
  /** 原画高度。取该轨第一个视频 clip 的 videoHeight */
  nativeFrameHeight?: number;
}

/** 从 tracks 收集贴图轨上的 TextClip，供播放器按时间预览 */
export function mapTracksToTextOverlayClips(tracks: ComposeTrack[]): ComposeTextOverlayClip[] {
  const items: ComposeTextOverlayClip[] = [];
  const stickerTracks = [...tracks]
    .filter((t) => t.type === TEXT_TEMPLATE_TRACK_TYPE && t.visible !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const track of stickerTracks) {
    for (const clip of track.clips) {
      if (clip.type !== "text" || clip.visible === false) continue;
      const sourceUrl = readTextClipConfig(clip.config).sourceUrl;
      if (!sourceUrl) continue;
      const color = clip.color?.trim() ? clip.color : null;
      items.push({
        id: clip.id,
        sourceUrl,
        text: clip.text || "",
        fontSize: clip.fontSize ?? 32,
        color,
        startTime: clip.startTime,
        endTime: clip.endTime,
        rect: clip.rect,
      });
    }
  }
  return items;
}

/** 侧栏素材库：某片段下的单个历史生成版本 */
export interface ComposeSegmentClipVariant {
  /** 版本唯一 id（Step3 clip id 或 result id 字符串化） */
  id: string;
  /** 片段序号（0-based） */
  segmentIndex: number;
  /** 片段展示标题 */
  segmentTitle: string;
  /** 可播放视频 URL */
  url: string;
  /** Step3 视频生成任务 ID */
  taskId?: string;
  /** 展示标签，如「生成 1」 */
  label?: string;
  /** 生成状态（自主创作为 string，爆款复刻为 number） */
  status?: string | number;
  /** 缩略图 / 关键帧 */
  poster?: string;
  /** Step3 当前选中版本 */
  isSelected?: boolean;
  /** 素材库 source_video 主键（可选，用于 signed-url） */
  mediaId?: number;
}

/** 侧栏素材库卡片拖入时间轴时 dataTransfer 的 MIME 类型 */
export const COMPOSE_SEGMENT_CLIP_DRAG_MIME = "application/x-compose-segment-clip+json";

/** 音频、音效卡片拖入时间轴。两者都进音频轨 */
export const COMPOSE_AUDIO_ASSET_DRAG_MIME = "application/x-compose-audio-asset+json";

/** 字幕素材卡片拖入时间轴 */
export const COMPOSE_SUBTITLE_ASSET_DRAG_MIME = "application/x-compose-subtitle-asset+json";

/** 花字卡片拖入时间轴 */
export const COMPOSE_TEXT_TEMPLATE_DRAG_MIME = "application/x-compose-text-template+json";

/** 字幕素材。拖入后按文案和时长插入字幕轨 */
export interface ComposeSubtitleAsset {
  /** 素材 id */
  id: string;
  /** 入轨文案 */
  text: string;
  /** 期望时长（秒） */
  durationSec: number;
}

/** 花字拖放载荷。只带入轨需要的字段，不含 SVG 原文 */
export interface ComposeTextTemplateDrag {
  /** 模板 id */
  id: string;
  /** 卡片标题 */
  name: string;
  /** 默认文案 */
  defaultText: string;
  /** 默认字号 */
  defaultFontSize: number;
  /** 默认颜色 */
  defaultColor: string;
  /** 模板地址 */
  sourceUrl: string;
}

/** 侧栏素材库：按片段分组 */
export interface ComposeSegmentClipGroup {
  /** 片段序号（0-based） */
  segmentIndex: number;
  /** 片段展示标题 */
  segmentTitle: string;
  /** 该片段全部历史版本 */
  variants: ComposeSegmentClipVariant[];
}

/** 编辑器聚合状态（v-model / 持久化 / 合成请求真相源） */
export interface VideoComposeEditorModel {
  /** 合成草稿主键 */
  id: string;
  /** 业务类型（如 ai_creation_merge） */
  bizType: MediaBizType;
  /** 业务实体 id */
  bizId: string | number;
  /** 多轨列表 */
  tracks: ComposeTrack[];
  /** 侧栏「上传片段」素材库（持久化，避免步骤切换丢失） */
  uploadedClipCatalog?: ComposeSegmentClipVariant[];
  /**
   * 本会话/工程内曾生成的 compose_extract 原声 OSS URL；
   * 离开/保存时与 tracks 对比，删除未引用孤儿文件（删 clip 不立刻删 OSS，便于 undo）。
   */
  composeExtractAudioUrls?: string[];
  /**
   * 时间轴显示倍率（vue-clip-track scale，与 pixelsPerSecond 相乘）。
   * 成片渲染忽略；旧稿缺省按 {@link DEFAULT_COMPOSE_TIMELINE_SCALE}。
   */
  scale?: number;
}

/** 媒体引用：url 与 mediaId 二选一 */
export interface MediaRef {
  /** 可直接播放的 URL */
  url?: string;
  /** 素材库 ID，走 signed-url 解析 */
  mediaId?: number;
  /** 签名业务类型，默认 source_video */
  bizType?: MediaBizType;
  /** 签名字段，默认 videoUrl */
  field?: string;
}

/** 编辑器视频片段入参 */
export interface VideoComposeClipInput {
  /** 片段唯一 id */
  id: string;
  /** Step3 视频生成任务 ID */
  taskId?: string;
  /** 展示标题 */
  title?: string;
  /** 视频媒体引用 */
  video: MediaRef;
  /** 缩略图 URL */
  poster?: string;
}

/** 创建编辑器默认聚合状态（空轨；不兼容旧持久化） */
export function createDefaultVideoComposeEditorModel(options: {
  /** 业务类型 */
  bizType: MediaBizType;
  /** 业务实体 id */
  bizId: string | number;
  /** 草稿主键，缺省自动生成 */
  id?: string;
}): VideoComposeEditorModel {
  return {
    id: options.id || `compose-${generateId()}`,
    bizType: options.bizType,
    bizId: options.bizId,
    tracks: [],
    scale: DEFAULT_COMPOSE_TIMELINE_SCALE,
  };
}

/** 字幕轨中是否存在非空且可见的文案 */
export function hasTimelineSubtitles(tracks: ComposeTrack[] | undefined): boolean {
  return (tracks || []).some(
    (track) =>
      track.type === "subtitle" &&
      track.visible !== false &&
      track.clips.some((c) => c.type === "subtitle" && c.visible !== false && Boolean(c.text?.trim())),
  );
}

/** @deprecated 旧按片二维字幕 */
export function hasExistingSubtitles(subtitles: SubtitleItem[][] | undefined): boolean {
  return (subtitles || []).some((list) => (list?.length ?? 0) > 0);
}

/** 从已解析的 VideoClipItem 映射为编辑器入参 */
export function mapClipsToInputs(clips: VideoClipItem[]): VideoComposeClipInput[] {
  return clips.map((clip) => ({
    id: clip.id,
    taskId: clip.taskId,
    title: clip.title,
    video: { url: clip.url },
    poster: clip.src,
  }));
}

/** 取第一个有 sourceUrl 的音频 MediaClip */
export function findFirstAudioClip(tracks: ComposeTrack[]): MediaClip | null {
  for (const track of tracks) {
    if (track.type !== "audio") continue;
    for (const clip of track.clips) {
      if (clip.type === "audio" && clip.sourceUrl?.trim()) return clip;
    }
  }
  return null;
}

/** 取第一个音频轨 id */
export function findFirstAudioTrackId(tracks: ComposeTrack[]): string | null {
  const track = tracks.find((t) => t.type === "audio");
  return track?.id ?? null;
}

/**
 * 从 tracks 临时派生旧 ComposeConfig，仅供播放器预览回退（非持久化）。
 * 音频自全部 audio 轨扁平化后取 clip；成片合成由后端合并全部 audio 轨。
 * @param options.videoClipId 指定视频 clip 取 volume；缺省取主轨首段
 * @param options.audioClipId 指定音频 clip 取 volume/BGM；缺省取扁平化列表首段
 */
export function mapTracksToComposeConfig(tracks: ComposeTrack[], options?: { videoClipId?: string; audioClipId?: string }): ComposeConfig {
  const mainTrack = tracks.find((t) => t.isMain || t.type === "video");
  const mainVideos = (mainTrack?.clips || []).filter((c): c is MediaClip => c.type === "video");
  const mainVideo = (options?.videoClipId ? mainVideos.find((c) => c.id === options.videoClipId) : undefined) || mainVideos[0];

  const audioClips = tracks
    .filter((t) => t.type === "audio")
    .flatMap((t) => t.clips)
    .filter((c): c is MediaClip => c.type === "audio" && Boolean(c.sourceUrl?.trim()));
  const firstAudio = (options?.audioClipId ? audioClips.find((c) => c.id === options.audioClipId) : undefined) || audioClips[0] || null;

  const videoVolume = clampGain(mainVideo?.volume ?? 0.8);
  const bgmVolume = clampGain(firstAudio?.volume ?? 0.5);

  if (!firstAudio?.sourceUrl) {
    return {
      ...createDefaultComposeConfig(),
      videoVolume,
      bgmVolume,
    };
  }

  const durationSec = Math.max(
    0,
    (firstAudio.trimEnd ?? firstAudio.originalDuration ?? firstAudio.endTime - firstAudio.startTime) - (firstAudio.trimStart ?? 0),
  );

  return {
    bgm: {
      name: firstAudio.name || "音频",
      url: firstAudio.sourceUrl,
      durationSec: firstAudio.originalDuration ?? durationSec,
    },
    bgmStartTime: Math.max(0, firstAudio.startTime),
    bgmSourceStartTime: Math.max(0, firstAudio.trimStart ?? 0),
    videoVolume,
    bgmVolume,
  };
}

/** MediaClip → 预览用 VideoClipItem（时长取时间轴占用，携带绝对时间与 volume/rate/trim） */
export function mapMediaClipToVideoClipItem(c: MediaClip, index: number): VideoClipItem {
  const timelineDur = Math.max(0.1, c.endTime - c.startTime);
  const rate = c.playbackRate > 0 ? c.playbackRate : 1;
  const trimStart = Math.max(0, c.trimStart ?? 0);
  const trimEnd = c.trimEnd != null && c.trimEnd > trimStart ? c.trimEnd : trimStart + timelineDur * rate;
  const config = readClipConfig(c.config);
  return {
    id: c.id,
    title: c.name || `片段 ${index + 1}`,
    url: c.sourceUrl || "",
    durationSec: timelineDur,
    volume: c.volume != null && Number.isFinite(c.volume) ? clampGain(c.volume) : 0.8,
    playbackRate: rate,
    trimStart,
    trimEnd,
    startTime: c.startTime,
    endTime: c.endTime,
    audioDetached: config.audioDetached === true,
    beauty: readBeautyParams(config.beauty),
  };
}

/** 按全局时间命中第一条覆盖中的视频 clip（须带 startTime/endTime） */
export function findPreviewVideoAtTime(clips: VideoClipItem[], timeSec: number): VideoClipItem | null {
  for (const c of clips) {
    const start = c.startTime;
    const end = c.endTime;
    if (start == null || end == null) continue;
    if (timeSec >= start && timeSec < end) return c;
  }
  return null;
}

/** 音频轨 MediaClip → 预览用 PreviewAudioClip 列表（按 startTime 排序；静音轨仍保留条目） */
export function mapTracksToPreviewAudioClips(tracks: ComposeTrack[]): PreviewAudioClip[] {
  const items: PreviewAudioClip[] = [];
  for (const track of tracks) {
    if (track.type !== "audio" || track.visible === false) continue;
    const trackMuted = track.muted === true;
    for (const clip of track.clips) {
      if (clip.type !== "audio" || !clip.sourceUrl?.trim()) continue;
      items.push({
        id: clip.id,
        url: clip.sourceUrl,
        startTime: clip.startTime,
        endTime: clip.endTime,
        trimStart: Math.max(0, clip.trimStart ?? 0),
        volume: clip.volume != null && Number.isFinite(clip.volume) ? clampGain(clip.volume) : 0.5,
        playbackRate: clip.playbackRate > 0 ? clip.playbackRate : 1,
        muted: trackMuted,
      });
    }
  }
  return items.sort((a, b) => a.startTime - b.startTime);
}

/** 按全局时间命中全部覆盖中的音频 clip（多轨重叠时全部返回，供预览混音） */
export function findPreviewAudiosAtTime(audios: PreviewAudioClip[], timeSec: number): PreviewAudioClip[] {
  return audios.filter((a) => timeSec >= a.startTime && timeSec < a.endTime);
}

/** 按全局时间命中第一条覆盖中的音频 clip */
export function findPreviewAudioAtTime(audios: PreviewAudioClip[], timeSec: number): PreviewAudioClip | null {
  return findPreviewAudiosAtTime(audios, timeSec)[0] ?? null;
}

/** 字幕轨 clips → 成片全局时间轴 segments（秒） */
export function mapTracksToSegments(tracks: ComposeTrack[]): Array<{ start: number; end: number; text: string }> {
  const segments: Array<{ start: number; end: number; text: string }> = [];
  for (const track of tracks) {
    if (track.type !== "subtitle" || track.visible === false) continue;
    for (const clip of track.clips) {
      if (clip.type !== "subtitle" || clip.visible === false) continue;
      const text = clip.text?.trim();
      if (!text) continue;
      if (clip.startTime < 0 || clip.startTime >= clip.endTime) continue;
      segments.push({ start: clip.startTime, end: clip.endTime, text });
    }
  }
  return segments;
}

/** 主视频轨 clips → 播放器用有序 VideoClipItem（含 volume/rate/trim，时长为时间轴占用） */
export function mapMainTrackToVideoClips(tracks: ComposeTrack[]): VideoClipItem[] {
  const main = tracks.find((t) => t.isMain || (t.type === "video" && t.clips.some((c) => c.type === "video")));
  if (!main) return [];
  return [...main.clips]
    .filter((c): c is MediaClip => c.type === "video" && Boolean(c.sourceUrl?.trim()))
    .sort((a, b) => a.startTime - b.startTime)
    .map((c, i) => mapMediaClipToVideoClipItem(c, i));
}

/** 统计音频轨上的 clip 数量（侧栏弱提示） */
export function countAudioClips(tracks: ComposeTrack[]): number {
  return tracks
    .filter((t) => t.type === "audio")
    .reduce((sum, t) => sum + t.clips.filter((c) => c.type === "audio" && c.sourceUrl).length, 0);
}

/** 默认字幕样式快照（Sidebar/Player 本轮只读展示用，不写回 model） */
export function getDefaultSubtitleStyleSnapshot(): SubtitleStyleConfig {
  return createDefaultSubtitleStyle();
}
