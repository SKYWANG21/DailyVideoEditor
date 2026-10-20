import { ref, computed, nextTick, watch, onMounted, onBeforeUnmount, type Ref, type CSSProperties } from "vue";
import type { PreviewVideoSize } from "@/types/beautyPreview";
import type { SubtitleStyleConfig, SubtitleBoxDraft } from "@/types/videoCompose";
import { computeVideoNativeFontSize, computeScreenFontSize, DEFAULT_SUBTITLE_SCREEN_FONT_PX } from "@/types/composeMedia";

interface VideoContentRect {
  offsetX: number;
  offsetY: number;
  displayW: number;
  displayH: number;
  videoW: number;
  videoH: number;
  scale: number;
}

interface UseVideoComposeSubtitleAdjustOptions {
  /** WebCodecs 回报的视频像素尺寸 */
  videoSize: Ref<PreviewVideoSize | null>;
  /** 预览容器，用来量 object-contain 的显示区域 */
  containerEl: Ref<HTMLElement | null>;
  /** 字幕样式。调整结束时就地写回边距和字号 */
  style: SubtitleStyleConfig;
  /** 进入调整前暂停播放 */
  onEnter?: () => void;
}

type DragMode = "move" | "left" | "right" | "top" | "bottom";

const MIN_BOX_WIDTH = 60;
const MIN_BOX_HEIGHT = 24;
const SNAP_THRESHOLD = 8;
const ACCENT = "#8e51ff";

/** 字幕位置调整：object-contain 坐标换算、draft 框 drag/resize、写回 marginL/R/V */
export function useVideoComposeSubtitleAdjust(options: UseVideoComposeSubtitleAdjustOptions) {
  const { videoSize, containerEl, style, onEnter } = options;

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
    const { scale, videoW, videoH } = rect;
    const boxWidthVideo = Math.max(MIN_BOX_WIDTH / scale, videoW - style.marginL - style.marginR);
    const boxBottomVideo = videoH - style.marginV;
    const width = boxWidthVideo * scale;
    const screenFontPx = style.fontSize > 0 ? computeScreenFontSize(style.fontSize, scale) : DEFAULT_SUBTITLE_SCREEN_FONT_PX;
    const height = Math.max(MIN_BOX_HEIGHT, screenFontPx * 1.6);
    const bottomDisplay = boxBottomVideo * scale;
    draft.value = {
      left: style.marginL * scale,
      top: bottomDisplay - height,
      width,
      height,
    };
    clampDraft();
  }

  function clampDraft(): void {
    const rect = contentRect.value;
    const d = draft.value;
    if (!rect || !d) return;
    d.width = Math.min(Math.max(MIN_BOX_WIDTH, d.width), rect.displayW);
    d.height = Math.min(Math.max(MIN_BOX_HEIGHT, d.height), rect.displayH);
    d.left = Math.min(Math.max(0, d.left), rect.displayW - d.width);
    d.top = Math.min(Math.max(0, d.top), rect.displayH - d.height);
  }

  async function enter(): Promise<void> {
    onEnter?.();
    isAdjusting.value = true;
    await nextTick();
    measure();
    initDraftFromStyle();
  }

  function commit(): void {
    const rect = contentRect.value;
    const d = draft.value;
    if (rect && d) {
      const { scale, videoW, videoH } = rect;
      const boxLeftVideo = d.left / scale;
      const boxWidthVideo = d.width / scale;
      const boxBottomVideo = (d.top + d.height) / scale;
      style.marginL = Math.max(0, Math.round(boxLeftVideo));
      style.marginR = Math.max(0, Math.round(videoW - boxLeftVideo - boxWidthVideo));
      style.marginV = Math.max(0, Math.round(videoH - boxBottomVideo));
    }
    isAdjusting.value = false;
    draft.value = null;
  }

  function toggle(): void {
    if (isAdjusting.value) commit();
    else void enter();
  }

  function startBoxDrag(e: MouseEvent, mode: DragMode): void {
    const rect = contentRect.value;
    const d = draft.value;
    if (!rect || !d) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const origin: SubtitleBoxDraft = { ...d };

    const onMove = (ev: MouseEvent) => {
      applyDrag(mode, origin, ev.clientX - startX, ev.clientY - startY);
    };
    const onUp = () => {
      snapHorizontalCenter();
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function applyDrag(mode: DragMode, origin: SubtitleBoxDraft, dx: number, dy: number): void {
    const d = draft.value;
    if (!d) return;
    if (mode === "move") {
      d.left = origin.left + dx;
      d.top = origin.top + dy;
    } else if (mode === "left") {
      d.left = origin.left + dx;
      d.width = origin.width - dx;
    } else if (mode === "right") {
      d.width = origin.width + dx;
    } else if (mode === "bottom") {
      d.height = origin.height + dy;
    } else if (mode === "top") {
      d.top = origin.top + dy;
      d.height = origin.height - dy;
    }
    clampDraft();
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

  const overlayStyle = computed<CSSProperties>(() => {
    const rect = contentRect.value;
    if (!rect) {
      return { left: `${style.marginL}px`, right: `${style.marginR}px`, bottom: `${style.marginV}px` };
    }
    const { offsetX, offsetY, scale } = rect;
    return {
      left: `${offsetX + style.marginL * scale}px`,
      right: `${offsetX + style.marginR * scale}px`,
      bottom: `${offsetY + style.marginV * scale}px`,
    };
  });

  const draftBoxStyle = computed<CSSProperties>(() => {
    const rect = contentRect.value;
    const d = draft.value;
    if (!rect || !d) return { display: "none" };
    return {
      left: `${rect.offsetX + d.left}px`,
      top: `${rect.offsetY + d.top}px`,
      width: `${d.width}px`,
      height: `${d.height}px`,
      border: `1px dashed ${ACCENT}`,
    };
  });

  const centerLineStyle = computed<CSSProperties>(() => {
    const rect = contentRect.value;
    if (!rect) return { display: "none" };
    return {
      left: `${rect.offsetX + rect.displayW / 2}px`,
      top: `${rect.offsetY}px`,
      height: `${rect.displayH}px`,
      borderLeft: `1px dashed ${ACCENT}`,
    };
  });

  /** 预览字幕文本样式：ASS 字号经视觉系数换算为屏幕 CSS px，与成片观感对齐 */
  const subtitleTextStyle = computed<CSSProperties>(() => {
    const scale = contentRect.value?.scale ?? 1;
    const screenFontPx = style.fontSize > 0 ? computeScreenFontSize(style.fontSize, scale) : DEFAULT_SUBTITLE_SCREEN_FONT_PX;
    return {
      color: style.color,
      fontFamily: style.fontFamily,
      fontWeight: style.bold ? "bold" : "normal",
      fontStyle: style.italic ? "italic" : "normal",
      fontSize: `${screenFontPx}px`,
      textShadow: "0 2px 4px rgba(0,0,0,0.8)",
    };
  });

  return {
    isAdjusting,
    draft,
    videoReady,
    measure,
    enter,
    commit,
    toggle,
    startBoxDrag,
    overlayStyle,
    draftBoxStyle,
    centerLineStyle,
    subtitleTextStyle,
  };
}
