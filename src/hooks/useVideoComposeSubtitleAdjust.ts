import { ref, computed, nextTick, watch, onMounted, onBeforeUnmount, type Ref, type CSSProperties } from "vue";
import type { PreviewVideoSize } from "@/types/beautyPreview";
import type { SubtitleStyleConfig, SubtitleBoxDraft } from "@/types/videoCompose";
import { computeVideoNativeFontSize, computeScreenFontSize, DEFAULT_SUBTITLE_SCREEN_FONT_PX } from "@/types/composeMedia";

/** object-contain 后视频在预览容器里的显示区域 */
export interface VideoContentRect {
  /** 显示区域相对容器的水平偏移 */
  offsetX: number;
  /** 显示区域相对容器的垂直偏移 */
  offsetY: number;
  /** 显示宽度 */
  displayW: number;
  /** 显示高度 */
  displayH: number;
  /** 视频像素宽 */
  videoW: number;
  /** 视频像素高 */
  videoH: number;
  /** 显示像素 / 视频像素 */
  scale: number;
}

/** 字幕框写回的边距（视频像素） */
export interface SubtitlePositionMargins {
  /** 左边距 */
  marginL: number;
  /** 右边距 */
  marginR: number;
  /** 底边距 */
  marginV: number;
}

/** 拖动结束写回：边距 + 当前字号（四角缩放会改字号） */
export interface SubtitleAdjustCommit extends SubtitlePositionMargins {
  /** 视频原生字号 */
  fontSize: number;
}

/** 调整框描边 / 手柄色，与 draft 虚线一致 */
export const SUBTITLE_ADJUST_ACCENT = "#8e51ff";

const MIN_BOX_WIDTH = 60;
/** 四角拖拽时屏幕预览字号下限（CSS px），避免缩到不可读 */
const MIN_SUBTITLE_SCREEN_FONT_PX = 12;
const SNAP_THRESHOLD = 8;

/** 预览字幕字体（不含边距） */
type SubtitlePreviewFont = Pick<SubtitleStyleConfig, "fontFamily" | "fontSize" | "color" | "bold" | "italic">;

/**
 * 按该条边距和 object-contain 区域算预览层 left/right/bottom。
 * @param margins 视频像素边距
 * @param rect 未测到视频时为 null，退回原始像素
 */
export function buildSubtitleOverlayStyle(margins: SubtitlePositionMargins, rect: VideoContentRect | null): CSSProperties {
  if (!rect) {
    return { left: `${margins.marginL}px`, right: `${margins.marginR}px`, bottom: `${margins.marginV}px` };
  }
  const { offsetX, offsetY, scale } = rect;
  return {
    left: `${offsetX + margins.marginL * scale}px`,
    right: `${offsetX + margins.marginR * scale}px`,
    bottom: `${offsetY + margins.marginV * scale}px`,
  };
}

/**
 * 按该条字体把 ASS 字号换成屏幕 CSS px。
 * @param style 该条字体
 * @param scale object-contain 显示比例；未知时传 1
 */
export function buildSubtitleTextStyle(style: SubtitlePreviewFont, scale: number): CSSProperties {
  const screenFontPx = style.fontSize > 0 ? computeScreenFontSize(style.fontSize, scale) : DEFAULT_SUBTITLE_SCREEN_FONT_PX;
  return {
    color: style.color,
    fontFamily: style.fontFamily,
    fontWeight: style.bold ? "bold" : "normal",
    fontStyle: style.italic ? "italic" : "normal",
    fontSize: `${screenFontPx}px`,
    lineHeight: 1,
    textShadow: "0 2px 4px rgba(0,0,0,0.8)",
  };
}

/** CSS font 串，供 canvas.measureText 与预览一致 */
function buildSubtitleCanvasFont(style: SubtitlePreviewFont, screenFontPx: number): string {
  const weight = style.bold ? "bold" : "normal";
  const italic = style.italic ? "italic" : "normal";
  return `${italic} ${weight} ${screenFontPx}px ${style.fontFamily}`;
}

/**
 * 按预览字体测字幕屏幕宽度。多行取最宽一行。
 * @param text 当前调整框文案
 * @param style 字体样式
 * @param scale object-contain 比例
 */
export function measureSubtitleScreenWidth(text: string, style: SubtitlePreviewFont, scale: number): number {
  const screenFontPx = style.fontSize > 0 ? computeScreenFontSize(style.fontSize, scale) : DEFAULT_SUBTITLE_SCREEN_FONT_PX;
  const lines = (text || " ").split("\n");
  if (typeof document === "undefined") {
    return Math.max(MIN_BOX_WIDTH, ...lines.map((line) => Math.ceil(Math.max(1, line.length) * screenFontPx * 0.6)));
  }
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return MIN_BOX_WIDTH;
  ctx.font = buildSubtitleCanvasFont(style, screenFontPx);
  let maxWidth = 0;
  for (const line of lines) {
    maxWidth = Math.max(maxWidth, ctx.measureText(line.length ? line : " ").width);
  }
  return Math.ceil(maxWidth);
}

interface UseVideoComposeSubtitleAdjustOptions {
  /** WebCodecs 回报的视频像素尺寸 */
  videoSize: Ref<PreviewVideoSize | null>;
  /** 预览容器，用来量 object-contain 的显示区域 */
  containerEl: Ref<HTMLElement | null>;
  /** 字幕样式。拖动结束时就地写回边距 */
  style: SubtitleStyleConfig;
  /** 当前调整框文案，用于测宽贴字 */
  previewText: Ref<string>;
  /** 调整框内文案节点，用于按宽换行后量高 */
  contentEl: Ref<HTMLElement | null>;
  /** 用户主动选中或开始拖框时暂停播放；播放路过进调整态不调 */
  onPausePlayback?: () => void;
  /** 拖动结束后的边距和字号，由调用方写入当前字幕 clip */
  onPositionChange?: (commit: SubtitleAdjustCommit) => void;
}

/** 进入调整态的可选行为 */
export interface EnterSubtitleAdjustOptions {
  /** true 时暂停播放（主动选中）；缺省不暂停 */
  pausePlayback?: boolean;
}

type DragMode = "move" | "left" | "right" | "nw" | "ne" | "sw" | "se";

type CornerDragMode = Extract<DragMode, "nw" | "ne" | "sw" | "se">;

/** 是否四角缩放（等比改框并改字号） */
function isCornerDrag(mode: DragMode): mode is CornerDragMode {
  return mode === "nw" || mode === "ne" || mode === "sw" || mode === "se";
}

/** 框的某一角（display 像素） */
function boxCorner(box: SubtitleBoxDraft, mode: CornerDragMode): { x: number; y: number } {
  const right = box.left + box.width;
  const bottom = box.top + box.height;
  if (mode === "nw") return { x: box.left, y: box.top };
  if (mode === "ne") return { x: right, y: box.top };
  if (mode === "sw") return { x: box.left, y: bottom };
  return { x: right, y: bottom };
}

/** 拖拽角的对角，缩放时固定不动 */
function oppositeCorner(mode: CornerDragMode): CornerDragMode {
  if (mode === "nw") return "se";
  if (mode === "ne") return "sw";
  if (mode === "sw") return "ne";
  return "nw";
}

/**
 * 把缩放比限制在最小框、最小字号和画面内。
 * @param minHeightPx 框高下限（与最小屏幕字号一致，高度贴字号）
 */
function clampCornerFactor(
  origin: SubtitleBoxDraft,
  mode: CornerDragMode,
  factor: number,
  displayW: number,
  displayH: number,
  minHeightPx: number,
): number {
  const anchor = boxCorner(origin, oppositeCorner(mode));
  const minFactor = Math.max(MIN_BOX_WIDTH / origin.width, minHeightPx / Math.max(1, origin.height));
  let maxFactor = Number.POSITIVE_INFINITY;
  if (mode === "nw" || mode === "sw") maxFactor = Math.min(maxFactor, anchor.x / origin.width);
  else maxFactor = Math.min(maxFactor, (displayW - anchor.x) / origin.width);
  if (mode === "nw" || mode === "ne") maxFactor = Math.min(maxFactor, anchor.y / origin.height);
  else maxFactor = Math.min(maxFactor, (displayH - anchor.y) / origin.height);
  if (!Number.isFinite(maxFactor) || maxFactor <= 0) return minFactor;
  return Math.min(Math.max(factor, minFactor), maxFactor);
}

/** 锚点固定，按统一比例得到新框和字号 */
function scaleDraftFromCorner(
  mode: CornerDragMode,
  origin: SubtitleBoxDraft,
  dx: number,
  dy: number,
  originFontSize: number,
  displayW: number,
  displayH: number,
  scale: number,
): { left: number; top: number; width: number; height: number; fontSize: number } | null {
  const anchor = boxCorner(origin, oppositeCorner(mode));
  const start = boxCorner(origin, mode);
  const originDist = Math.hypot(start.x - anchor.x, start.y - anchor.y);
  if (originDist < 1) return null;
  const raw = Math.hypot(start.x + dx - anchor.x, start.y + dy - anchor.y) / originDist;
  const factor = clampCornerFactor(origin, mode, raw, displayW, displayH, MIN_SUBTITLE_SCREEN_FONT_PX);
  const width = origin.width * factor;
  const height = origin.height * factor;
  const anchorRight = mode === "nw" || mode === "sw";
  const anchorBottom = mode === "nw" || mode === "ne";
  const minVideoFont = computeVideoNativeFontSize(MIN_SUBTITLE_SCREEN_FONT_PX, scale);
  const nextFont = Math.round((originFontSize > 0 ? originFontSize : minVideoFont) * factor);
  return {
    left: anchorRight ? anchor.x - width : anchor.x,
    top: anchorBottom ? anchor.y - height : anchor.y,
    width,
    height,
    fontSize: Math.max(minVideoFont, nextFont),
  };
}

/** 字幕位置调整：object-contain 坐标换算、draft 框 drag/resize、写回 marginL/R/V */
export function useVideoComposeSubtitleAdjust(options: UseVideoComposeSubtitleAdjustOptions) {
  const { videoSize, containerEl, style, previewText, contentEl, onPausePlayback, onPositionChange } = options;

  const isAdjusting = ref(false);
  const draft = ref<SubtitleBoxDraft | null>(null);
  const contentRect = ref<VideoContentRect | null>(null);
  const videoReady = ref(false);

  /** 有视频像素尺寸后才允许调整字幕位置 */
  function syncVideoMetaReady(): void {
    const size = videoSize.value;
    videoReady.value = !!size && size.width > 0 && size.height > 0;
  }

  function onWindowResize(): void {
    measure();
  }

  let containerObserver: ResizeObserver | null = null;

  /** 预览容器尺寸变化后重测 object-contain 比例（布局晚于 metadata 时补一次） */
  function bindContainerEl(el: HTMLElement | null): void {
    containerObserver?.disconnect();
    containerObserver = null;
    if (!el) return;
    if (typeof ResizeObserver !== "undefined") {
      containerObserver = new ResizeObserver(() => {
        measure();
      });
      containerObserver.observe(el);
    }
    measure();
  }

  watch(
    videoSize,
    () => {
      syncVideoMetaReady();
      measure();
    },
    { immediate: true },
  );
  watch(containerEl, bindContainerEl, { immediate: true });
  /** fontSize=0 表示待按屏幕默认 CSS 字号反推 ASS；scale 已知时立即换算 */
  watch(
    () => style.fontSize,
    (fontSize) => {
      if (fontSize <= 0) measure();
    },
  );

  onMounted(() => {
    window.addEventListener("resize", onWindowResize);
  });

  onBeforeUnmount(() => {
    window.removeEventListener("resize", onWindowResize);
    containerObserver?.disconnect();
    containerObserver = null;
  });

  function measure(): void {
    const size = videoSize.value;
    const c = containerEl.value;
    const cw = c?.clientWidth ?? 0;
    const ch = c?.clientHeight ?? 0;
    if (!size || !c || size.width <= 0 || size.height <= 0 || cw <= 0 || ch <= 0) {
      contentRect.value = null;
      return;
    }
    const vw = size.width;
    const vh = size.height;
    const scale = Math.min(cw / vw, ch / vh);
    const displayW = vw * scale;
    const displayH = vh * scale;
    contentRect.value = {
      offsetX: (cw - displayW) / 2,
      offsetY: (ch - displayH) / 2,
      displayW,
      displayH,
      videoW: vw,
      videoH: vh,
      scale,
    };
    if (style.fontSize <= 0 && scale > 0) {
      style.fontSize = computeVideoNativeFontSize(DEFAULT_SUBTITLE_SCREEN_FONT_PX, scale);
    }
    if (isAdjusting.value) initDraftFromStyle();
  }

  function initDraftFromStyle(): void {
    const rect = contentRect.value;
    if (!rect) return;
    const { scale, videoW, videoH, displayW } = rect;
    const screenFontPx = style.fontSize > 0 ? computeScreenFontSize(style.fontSize, scale) : DEFAULT_SUBTITLE_SCREEN_FONT_PX;
    const height = screenFontPx;
    const spanVideo = Math.max(0, videoW - style.marginL - style.marginR);
    // 默认通栏边距（约 20+20）才按单行测字贴宽；否则用已保存 margin 还原缩窄/换行后的框
    const isDefaultWide = style.marginL <= 20 && style.marginR <= 20 && spanVideo >= videoW - 41;
    let width: number;
    let left: number;
    if (isDefaultWide) {
      const measured = Math.max(MIN_BOX_WIDTH, measureSubtitleScreenWidth(previewText.value, style, scale));
      width = Math.min(displayW, measured);
      left = (displayW - width) / 2;
    } else {
      width = Math.min(displayW, Math.max(MIN_BOX_WIDTH, spanVideo * scale));
      left = style.marginL * scale;
    }
    const bottomDisplay = (videoH - style.marginV) * scale;
    draft.value = {
      left,
      top: bottomDisplay - height,
      width,
      height,
    };
    clampDraft();
    void nextTick(() => syncDraftHeightToContent());
  }

  function clampDraft(): void {
    const rect = contentRect.value;
    const d = draft.value;
    if (!rect || !d) return;
    d.width = Math.min(Math.max(MIN_BOX_WIDTH, d.width), rect.displayW);
    // 高度由字号/换行决定，下限 1
    d.height = Math.min(Math.max(1, d.height), rect.displayH);
    d.left = Math.min(Math.max(0, d.left), rect.displayW - d.width);
    d.top = Math.min(Math.max(0, d.top), rect.displayH - d.height);
  }

  /** 按文案节点实际高度更新框高，钉住底边（换行向上长） */
  function syncDraftHeightToContent(): void {
    const rect = contentRect.value;
    const d = draft.value;
    const el = contentEl.value;
    if (!rect || !d || !el) return;
    const screenFontPx = style.fontSize > 0 ? computeScreenFontSize(style.fontSize, rect.scale) : DEFAULT_SUBTITLE_SCREEN_FONT_PX;
    const nextH = Math.min(rect.displayH, Math.max(screenFontPx, el.scrollHeight));
    const bottom = d.top + d.height;
    d.height = nextH;
    d.top = bottom - d.height;
    d.top = Math.min(Math.max(0, d.top), rect.displayH - d.height);
  }

  /** 把 draft 框换算成视频像素边距和字号并写入 style */
  function writeDraftToStyle(): SubtitleAdjustCommit | null {
    const rect = contentRect.value;
    const box = draft.value;
    if (!rect || !box || rect.scale <= 0) return null;
    const { scale, videoW, videoH } = rect;
    const boxLeftVideo = box.left / scale;
    const boxWidthVideo = box.width / scale;
    const boxBottomVideo = (box.top + box.height) / scale;
    const commit: SubtitleAdjustCommit = {
      marginL: Math.max(0, Math.round(boxLeftVideo)),
      marginR: Math.max(0, Math.round(videoW - boxLeftVideo - boxWidthVideo)),
      marginV: Math.max(0, Math.round(videoH - boxBottomVideo)),
      fontSize: Math.max(computeVideoNativeFontSize(MIN_SUBTITLE_SCREEN_FONT_PX, scale), Math.round(style.fontSize)),
    };
    style.marginL = commit.marginL;
    style.marginR = commit.marginR;
    style.marginV = commit.marginV;
    style.fontSize = commit.fontSize;
    return commit;
  }

  /** 拖动结束或退出调整时，把当前框写回并通知外部 */
  function flushPosition(): void {
    const commit = writeDraftToStyle();
    if (commit) onPositionChange?.(commit);
  }

  /** 进入调整。已在调整中则只按当前样式重铺 draft */
  async function enter(opts?: EnterSubtitleAdjustOptions): Promise<void> {
    if (opts?.pausePlayback) onPausePlayback?.();
    isAdjusting.value = true;
    await nextTick();
    measure();
    initDraftFromStyle();
  }

  /** 退出调整。未在拖动中途丢失的 draft 会先写回 */
  function exit(): void {
    if (isAdjusting.value) flushPosition();
    isAdjusting.value = false;
    draft.value = null;
  }

  function toggle(): void {
    if (isAdjusting.value) exit();
    else void enter();
  }

  function startBoxDrag(e: MouseEvent, mode: DragMode): void {
    const rect = contentRect.value;
    const d = draft.value;
    if (!rect || !d) return;
    // 双击进编辑时 detail>1，勿当成拖框
    if (mode === "move" && e.detail > 1) return;
    e.preventDefault();
    e.stopPropagation();
    onPausePlayback?.();
    const startX = e.clientX;
    const startY = e.clientY;
    const origin: SubtitleBoxDraft = { ...d };
    const originFontSize = style.fontSize;

    const onMove = (ev: MouseEvent) => {
      applyDrag(mode, origin, ev.clientX - startX, ev.clientY - startY, originFontSize);
    };
    const onUp = () => {
      snapHorizontalCenter();
      flushPosition();
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function applyDrag(mode: DragMode, origin: SubtitleBoxDraft, dx: number, dy: number, originFontSize: number): void {
    const d = draft.value;
    if (!d) return;
    if (isCornerDrag(mode)) {
      const rect = contentRect.value;
      if (!rect) return;
      const scaled = scaleDraftFromCorner(mode, origin, dx, dy, originFontSize, rect.displayW, rect.displayH, rect.scale);
      if (!scaled) return;
      // 钉住原底边：四角只改宽与字号，高度随后按换行重算
      const bottom = origin.top + origin.height;
      d.left = scaled.left;
      d.width = scaled.width;
      style.fontSize = scaled.fontSize;
      const screenFontPx = computeScreenFontSize(style.fontSize, rect.scale);
      d.height = screenFontPx;
      d.top = bottom - d.height;
      clampDraft();
      void nextTick(() => syncDraftHeightToContent());
      return;
    }
    if (mode === "move") {
      d.left = origin.left + dx;
      d.top = origin.top + dy;
      clampDraft();
      return;
    }
    if (mode === "left") {
      d.left = origin.left + dx;
      d.width = origin.width - dx;
    } else if (mode === "right") {
      d.width = origin.width + dx;
    }
    clampDraft();
    void nextTick(() => syncDraftHeightToContent());
  }

  function snapHorizontalCenter(): void {
    const rect = contentRect.value;
    const d = draft.value;
    if (!rect || !d) return;
    const boxCenter = d.left + d.width / 2;
    const videoCenter = rect.displayW / 2;
    if (Math.abs(boxCenter - videoCenter) < SNAP_THRESHOLD) {
      d.left = (rect.displayW - d.width) / 2;
      clampDraft();
    }
  }

  const draftBoxStyle = computed<CSSProperties>(() => {
    const rect = contentRect.value;
    const d = draft.value;
    if (!rect || !d) return { display: "none" };
    return {
      left: `${rect.offsetX + d.left}px`,
      top: `${rect.offsetY + d.top}px`,
      width: `${d.width}px`,
      height: `${d.height}px`,
      boxSizing: "border-box",
      padding: "0",
      border: "none",
      outline: `1px dashed ${SUBTITLE_ADJUST_ACCENT}`,
      outlineOffset: "0px",
    };
  });

  const centerLineStyle = computed<CSSProperties>(() => {
    const rect = contentRect.value;
    if (!rect) return { display: "none" };
    return {
      left: `${rect.offsetX + rect.displayW / 2}px`,
      top: `${rect.offsetY}px`,
      height: `${rect.displayH}px`,
      borderLeft: `1px dashed ${SUBTITLE_ADJUST_ACCENT}`,
    };
  });

  /** 调整态文本样式：仍用选中 clip 写回的共享 subtitleStyle */
  const subtitleTextStyle = computed<CSSProperties>(() => buildSubtitleTextStyle(style, contentRect.value?.scale ?? 1));

  return {
    isAdjusting,
    draft,
    contentRect,
    videoReady,
    measure,
    enter,
    exit,
    toggle,
    startBoxDrag,
    syncDraftHeightToContent,
    draftBoxStyle,
    centerLineStyle,
    subtitleTextStyle,
  };
}
