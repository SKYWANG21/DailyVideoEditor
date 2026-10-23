/** 预览与字幕样式。从主工程 step4 类型中摘出，不含向导字段。 */

/** 视频片段（时间轴上的一个轨道块） */
export interface VideoClipItem {
  /** 片段唯一 id */
  id: string;
  /** 片段标题，如「片段 1」 */
  title: string;
  /** 可播放地址（本地为 blob URL） */
  url: string;
  /** 生成任务 ID，本地上传通常为空 */
  taskId?: string;
  /** 时间轴占用时长（秒） */
  durationSec: number;
  /** 缩略图，可选 */
  src?: string;
  /** 原声线性增益。0 为静音，1 为 0 dB */
  volume?: number;
  /** 片段播放倍速，默认 1 */
  playbackRate?: number;
  /** 源内入点（秒） */
  trimStart?: number;
  /** 源内出点（秒） */
  trimEnd?: number;
  /** 时间轴起点（秒） */
  startTime?: number;
  /** 时间轴终点（秒） */
  endTime?: number;
  /** 原声已分离：预览只播画面 */
  audioDetached?: boolean;
  /** 预览美颜。缺省为关闭 */
  beauty?: BeautyParams;
}

/** 预览美颜参数。关闭时四项强度仍保留，方便再次打开 */
export interface BeautyParams {
  /** 总开关 */
  enabled: boolean;
  /** 磨皮，0–10 */
  smooth: number;
  /** 美白，0–10 */
  whiten: number;
  /** 瘦脸，0–10 */
  slim: number;
  /** 大眼，0–10 */
  eye: number;
}

/** 默认关闭美颜，强度为 0 */
export function createDefaultBeautyParams(): BeautyParams {
  return { enabled: false, smooth: 0, whiten: 0, slim: 0, eye: 0 };
}

/** 把滑杆值收进 0–10 */
export function clampBeautyLevel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(10, Math.max(0, value));
}

/** 从 clip.config 读取美颜。缺字段或类型不对时用默认值 */
export function readBeautyParams(value: unknown): BeautyParams {
  const defaults = createDefaultBeautyParams();
  if (!value || typeof value !== "object") return defaults;
  const raw = value as Partial<BeautyParams>;
  return {
    enabled: raw.enabled === true,
    smooth: clampBeautyLevel(Number(raw.smooth ?? 0)),
    whiten: clampBeautyLevel(Number(raw.whiten ?? 0)),
    slim: clampBeautyLevel(Number(raw.slim ?? 0)),
    eye: clampBeautyLevel(Number(raw.eye ?? 0)),
  };
}

/** 预览用音频片段（按全局时间命中后混音） */
export interface PreviewAudioClip {
  /** 片段 id */
  id: string;
  /** 音频 URL */
  url: string;
  /** 时间轴起点（秒） */
  startTime: number;
  /** 时间轴终点（秒） */
  endTime: number;
  /** 源内入点（秒） */
  trimStart: number;
  /** 线性增益。0 为静音，1 为 0 dB */
  volume: number;
  /** 片段倍速，默认 1 */
  playbackRate: number;
  /** 所属音频轨整轨静音 */
  muted?: boolean;
}

/** BGM 资源 */
export interface BgmItem {
  /** 展示名称 */
  name: string;
  /** 音频 URL */
  url: string;
  /** 时长（秒） */
  durationSec: number;
}

/** 合成参数 */
export interface ComposeConfig {
  /** 选中的 BGM，未选择时为 null */
  bgm: BgmItem | null;
  /** BGM 相对视频首帧的延迟（秒） */
  bgmStartTime: number;
  /** BGM 源前奏跳过（秒） */
  bgmSourceStartTime: number;
  /** 原视频线性增益 */
  videoVolume: number;
  /** BGM 线性增益 */
  bgmVolume: number;
}

/** 创建默认合成参数 */
export function createDefaultComposeConfig(): ComposeConfig {
  return {
    bgm: null,
    bgmStartTime: 0,
    bgmSourceStartTime: 0,
    videoVolume: 0.8,
    bgmVolume: 0.5,
  };
}

/** 单条字幕（start/end 为 MM:SS.mmm）。预览按本条边距和字体各自定位，不跟共享 subtitleStyle */
export interface SubtitleItem {
  /** 字幕唯一 id */
  id: string;
  /** 开始时间 */
  start: string;
  /** 结束时间 */
  end: string;
  /** 字幕文本 */
  text: string;
  /** 左边距（视频原生像素） */
  marginL: number;
  /** 右边距（视频原生像素） */
  marginR: number;
  /** 底边距（视频原生像素） */
  marginV: number;
  /** 字体名 */
  fontFamily: string;
  /** 字号（视频原生像素）；0 表示待预览换算 */
  fontSize: number;
  /** 字体颜色 #RRGGBB */
  color: string;
  /** 是否加粗 */
  bold: boolean;
  /** 是否斜体 */
  italic: boolean;
}

/** 字幕样式，对齐 ASS 烧录字段 */
export interface SubtitleStyleConfig {
  /** 字体名 */
  fontFamily: string;
  /** 字号（视频原生像素）；0 表示待预览换算 */
  fontSize: number;
  /** 字体颜色 #RRGGBB */
  color: string;
  /** 是否加粗 */
  bold: boolean;
  /** 是否斜体 */
  italic: boolean;
  /** 对齐方式 */
  alignment: "BOTTOM_CENTER";
  /** 左边距（视频原生像素） */
  marginL: number;
  /** 右边距（视频原生像素） */
  marginR: number;
  /** 垂直边距（视频原生像素） */
  marginV: number;
}

/** 预览区字幕默认屏幕字号（CSS px） */
export const DEFAULT_SUBTITLE_SCREEN_FONT_PX = 14;

/** ASS Fontsize 相对同数值 CSS font-size 的视觉比例 */
export const ASS_TO_CSS_VISUAL_RATIO = 0.72;

/**
 * 将屏幕 CSS 字号换算为视频原生字号。
 * @param screenFontPx 目标屏幕像素字号
 * @param scale object-contain 显示比例
 */
export function computeVideoNativeFontSize(screenFontPx: number, scale: number): number {
  const safeScreen = Math.max(1, screenFontPx);
  if (scale <= 0) return Math.max(1, Math.round(safeScreen / ASS_TO_CSS_VISUAL_RATIO));
  return Math.max(1, Math.round(safeScreen / (scale * ASS_TO_CSS_VISUAL_RATIO)));
}

/**
 * 将视频原生 ASS 字号换算为屏幕预览 CSS px。
 * @param videoNativeFontSize ASS Fontsize
 * @param scale object-contain 显示比例
 */
export function computeScreenFontSize(videoNativeFontSize: number, scale: number): number {
  if (videoNativeFontSize <= 0) return DEFAULT_SUBTITLE_SCREEN_FONT_PX;
  const safeScale = scale > 0 ? scale : 1;
  return Math.max(1, videoNativeFontSize * safeScale * ASS_TO_CSS_VISUAL_RATIO);
}

/** 未测量到视频时的兜底字号 */
export const DEFAULT_SUBTITLE_VIDEO_NATIVE_FONT_SIZE = 56;

/** 创建默认字幕样式 */
export function createDefaultSubtitleStyle(): SubtitleStyleConfig {
  return {
    fontFamily: "Noto Sans CJK SC",
    fontSize: 0,
    color: "#FFFFFF",
    bold: false,
    italic: false,
    alignment: "BOTTOM_CENTER",
    marginL: 20,
    marginR: 20,
    marginV: 20,
  };
}

/** 字幕调整模式下的临时框（display 像素） */
export interface SubtitleBoxDraft {
  /** 框左边缘 X */
  left: number;
  /** 框上边缘 Y */
  top: number;
  /** 框宽度 */
  width: number;
  /** 框高度 */
  height: number;
}
