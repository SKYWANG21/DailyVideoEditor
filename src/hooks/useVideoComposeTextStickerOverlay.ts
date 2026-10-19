import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties, type Ref } from "vue";
import type { RectConfig } from "@/clip-track";
import type { ComposeTextOverlayClip } from "@/types/videoCompose";
import { createDefaultTextClipRect } from "@/types/videoCompose";
import { applyTextTemplateSvg } from "@/editor/applyTextTemplateSvg";
import {
  getCachedTextTemplateSvg,
  loadTextTemplateSvg,
  parseSvgAspect,
  textTemplateCatalog,
} from "@/editor/textTemplateCatalog";

/** object-contain 后的视频画面在容器中的矩形 */
export interface TextStickerContentRect {
  offsetX: number;
  offsetY: number;
  displayW: number;
  displayH: number;
  videoW: number;
  videoH: number;
  scale: number;
}

/** 贴图变换拖拽模式 */
export type TextStickerDragMode = "move" | "rotate" | "nw" | "ne" | "sw" | "se";

const MIN_SIZE = 24;
const HANDLE = 8;
const ACCENT = "#8e51ff";

interface UseTextStickerOverlayOptions {
  layerEl: Ref<HTMLElement | null>;
  videoWidth: Ref<number>;
  videoHeight: Ref<number>;
  clips: Ref<ComposeTextOverlayClip[]>;
  currentTime: Ref<number>;
  selectedId: Ref<string | null | undefined>;
  onCommitRect: (clipId: string, rect: RectConfig) => void;
}

function rotatePoint(lx: number, ly: number, angle: number): { x: number; y: number } {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: lx * c - ly * s, y: lx * s + ly * c };
}

function rotatedAabb(rect: RectConfig): { minX: number; minY: number; maxX: number; maxY: number } {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const hw = rect.w / 2;
  const hh = rect.h / 2;
  const corners = [
    rotatePoint(-hw, -hh, rect.angle),
    rotatePoint(hw, -hh, rect.angle),
    rotatePoint(hw, hh, rect.angle),
    rotatePoint(-hw, hh, rect.angle),
  ];
  const xs = corners.map((p) => cx + p.x);
  const ys = corners.map((p) => cy + p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/** 将旋转后 AABB 限制在视频画面内；过大时改为约束中心 */
function clampRectToVideo(rect: RectConfig, videoW: number, videoH: number): RectConfig {
  const next: RectConfig = { ...rect, w: Math.max(MIN_SIZE, rect.w), h: Math.max(MIN_SIZE, rect.h) };
  const aabb = rotatedAabb(next);
  const aw = aabb.maxX - aabb.minX;
  const ah = aabb.maxY - aabb.minY;
  let dx = 0;
  let dy = 0;
  if (aw >= videoW) dx = videoW / 2 - (aabb.minX + aw / 2);
  else if (aabb.minX < 0) dx = -aabb.minX;
  else if (aabb.maxX > videoW) dx = videoW - aabb.maxX;
  if (ah >= videoH) dy = videoH / 2 - (aabb.minY + ah / 2);
  else if (aabb.minY < 0) dy = -aabb.minY;
  else if (aabb.maxY > videoH) dy = videoH - aabb.maxY;
  next.x += dx;
  next.y += dy;
  return next;
}

/** 优先用 clip.rect；缺省时按 SVG 宽高比生成居中默认框 */
function resolveClipRect(clip: ComposeTextOverlayClip, videoW: number, videoH: number, aspect = 1): RectConfig {
  if (clip.rect && clip.rect.w > 0 && clip.rect.h > 0) {
    return {
      x: clip.rect.x,
      y: clip.rect.y,
      w: clip.rect.w,
      h: clip.rect.h,
      angle: clip.rect.angle || 0,
      fixedAspectRatio: clip.rect.fixedAspectRatio !== false,
    };
  }
  return createDefaultTextClipRect(videoW, videoH, aspect);
}

/** 贴图 overlay：object-contain 映射、拖拽缩放旋转、写回 rect */
export function useVideoComposeTextStickerOverlay(options: UseTextStickerOverlayOptions) {
  const { layerEl, videoWidth, videoHeight, clips, currentTime, selectedId, onCommitRect } = options;

  const contentRect = ref<TextStickerContentRect | null>(null);
  const draftById = ref<Record<string, RectConfig>>({});
  /** sourceUrl → SVG 原文；加载完成后触发预览改写 */
  const svgRawByUrl = ref<Record<string, string>>({});
  let layerObserver: ResizeObserver | null = null;

  function measure(): void {
    const layer = layerEl.value;
    const vw = videoWidth.value;
    const vh = videoHeight.value;
    const cw = layer?.clientWidth ?? 0;
    const ch = layer?.clientHeight ?? 0;
    if (!layer || vw <= 0 || vh <= 0 || cw <= 0 || ch <= 0) {
      contentRect.value = null;
      return;
    }
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
  }

  watch(
    [layerEl, videoWidth, videoHeight],
    () => {
      layerObserver?.disconnect();
      layerObserver = null;
      const layer = layerEl.value;
      if (layer && typeof ResizeObserver !== "undefined") {
        layerObserver = new ResizeObserver(() => measure());
        layerObserver.observe(layer);
      }
      measure();
    },
    { immediate: true },
  );

  onMounted(() => {
    window.addEventListener("resize", measure);
    measure();
  });

  onBeforeUnmount(() => {
    window.removeEventListener("resize", measure);
    layerObserver?.disconnect();
    layerObserver = null;
  });

  /** 当前贴图 clip 的去重 sourceUrl */
  function overlaySourceUrls(): string[] {
    return [...new Set(clips.value.map((c) => c.sourceUrl).filter(Boolean))];
  }

  /** 把模块缓存里已有的 SVG 灌进本地 ref（目录加载完成后补齐竞态） */
  function hydrateSvgRawFromCache(urls: string[]): void {
    let changed = false;
    const next = { ...svgRawByUrl.value };
    for (const url of urls) {
      if (next[url]) continue;
      const cached = getCachedTextTemplateSvg(url);
      if (!cached) continue;
      next[url] = cached;
      changed = true;
    }
    if (changed) svgRawByUrl.value = next;
  }

  /** 缓存未命中则按 sourceUrl 拉取，与成片下载同一条链 */
  function requestMissingSvgRaws(urls: string[]): void {
    hydrateSvgRawFromCache(urls);
    for (const url of urls) {
      if (svgRawByUrl.value[url]) continue;
      void loadTextTemplateSvg(url).then((raw) => {
        if (!raw) return;
        svgRawByUrl.value = { ...svgRawByUrl.value, [url]: raw };
      });
    }
  }

  watch(
    overlaySourceUrls,
    (urls) => {
      requestMissingSvgRaws(urls);
    },
    { immediate: true },
  );

  /** 素材目录把 SVG 写入模块缓存后，再按 sourceUrl 灌一次，避免目录与预览竞态 */
  watch(textTemplateCatalog, () => {
    hydrateSvgRawFromCache(overlaySourceUrls());
  });

  /** 当前时间落在 clip 区间内（含 start，不含 end） */
  function isClipInRange(clip: ComposeTextOverlayClip, timeSec: number): boolean {
    return timeSec >= clip.startTime && timeSec < clip.endTime;
  }

  const visibleIdSet = computed(() => {
    const t = currentTime.value;
    const ids = new Set<string>();
    for (const clip of clips.value) {
      if (isClipInRange(clip, t)) ids.add(clip.id);
    }
    return ids;
  });

  /** 刚进入可见区间：打一次 class，供 SVG CSS 动画重跑 */
  const enteringIdSet = ref<Set<string>>(new Set());

  const svgHostById = new Map<string, HTMLElement>();

  /** v-html 宿主 ref，用于进入时 restart 模板内 @keyframes */
  function setSvgHost(clipId: string, el: unknown): void {
    if (el instanceof HTMLElement) svgHostById.set(clipId, el);
    else svgHostById.delete(clipId);
  }

  /** 重跑 SVG 内 CSS 动画，不重新 parse v-html */
  function restartSvgCssAnimations(host: HTMLElement): void {
    const svg = host.querySelector("svg");
    if (!svg) return;
    const targets: Element[] = [svg, ...Array.from(svg.querySelectorAll("*"))];
    let restarted = false;
    for (const el of targets) {
      const anims = typeof el.getAnimations === "function" ? el.getAnimations() : [];
      for (const anim of anims) {
        anim.cancel();
        anim.play();
        restarted = true;
      }
    }
    if (!restarted) {
      svg.replaceWith(svg.cloneNode(true));
    }
  }

  let prevVisibleIds = new Set<string>();
  watch(
    visibleIdSet,
    async (next) => {
      const entered: string[] = [];
      for (const id of next) {
        if (!prevVisibleIds.has(id)) entered.push(id);
      }
      const left: string[] = [];
      for (const id of prevVisibleIds) {
        if (!next.has(id)) left.push(id);
      }
      prevVisibleIds = new Set(next);
      if (left.length) {
        const flags = new Set(enteringIdSet.value);
        for (const id of left) flags.delete(id);
        enteringIdSet.value = flags;
      }
      if (!entered.length) return;
      await nextTick();
      const flags = new Set(enteringIdSet.value);
      for (const id of entered) flags.add(id);
      enteringIdSet.value = flags;
      await nextTick();
      for (const id of entered) {
        const host = svgHostById.get(id);
        if (host) restartSvgCssAnimations(host);
      }
    },
    { immediate: true },
  );

  /** 将 clip.rect 或默认框映射到 object-contain 后的 overlay 像素 */
  function displayRectOf(clip: ComposeTextOverlayClip): RectConfig {
    const cr = contentRect.value;
    const vw = cr?.videoW ?? videoWidth.value;
    const vh = cr?.videoH ?? videoHeight.value;
    const raw = clip.sourceUrl ? svgRawByUrl.value[clip.sourceUrl] : "";
    const aspect = raw ? parseSvgAspect(raw) : 1;
    return draftById.value[clip.id] || resolveClipRect(clip, vw, vh, aspect);
  }

  function boxStyle(clip: ComposeTextOverlayClip): CSSProperties {
    const cr = contentRect.value;
    if (!cr) return { display: "none" };
    const rect = displayRectOf(clip);
    const deg = ((rect.angle || 0) * 180) / Math.PI;
    const selected = clip.id === selectedId.value;
    return {
      position: "absolute",
      left: `${cr.offsetX + rect.x * cr.scale}px`,
      top: `${cr.offsetY + rect.y * cr.scale}px`,
      width: `${rect.w * cr.scale}px`,
      height: `${rect.h * cr.scale}px`,
      transform: `rotate(${deg}deg)`,
      transformOrigin: "center center",
      pointerEvents: "auto",
      cursor: selected ? "move" : "pointer",
      outline: selected ? `1px dashed ${ACCENT}` : "none",
      boxSizing: "border-box",
    };
  }

  const svgHtmlById = computed(() => {
    const map: Record<string, string> = {};
    const raws = svgRawByUrl.value;
    for (const clip of clips.value) {
      const raw = clip.sourceUrl ? raws[clip.sourceUrl] : "";
      if (!raw) continue;
      map[clip.id] = applyTextTemplateSvg(raw, {
        text: clip.text,
        color: clip.color,
        fontSize: clip.fontSize,
        idPrefix: clip.id,
      });
    }
    return map;
  });

  /** 仅在 SVG 原文到达时重跑动画，避免改文案/配色打断 CSS */
  watch(svgRawByUrl, async () => {
    await nextTick();
    const htmlMap = svgHtmlById.value;
    for (const id of visibleIdSet.value) {
      if (!htmlMap[id]) continue;
      const host = svgHostById.get(id);
      if (host) restartSvgCssAnimations(host);
    }
  });

  function clientToVideo(clientX: number, clientY: number): { x: number; y: number } | null {
    const cr = contentRect.value;
    const layer = layerEl.value;
    if (!cr || !layer) return null;
    const box = layer.getBoundingClientRect();
    return {
      x: (clientX - box.left - cr.offsetX) / cr.scale,
      y: (clientY - box.top - cr.offsetY) / cr.scale,
    };
  }

  function applyResize(origin: RectConfig, mode: "nw" | "ne" | "sw" | "se", videoPt: { x: number; y: number }): RectConfig {
    const aspect = origin.h > 0 ? origin.w / origin.h : 1;
    const angle = origin.angle || 0;
    const cx = origin.x + origin.w / 2;
    const cy = origin.y + origin.h / 2;
    const hw = origin.w / 2;
    const hh = origin.h / 2;
    const oppositeLocal = {
      nw: { x: hw, y: hh },
      ne: { x: -hw, y: hh },
      sw: { x: hw, y: -hh },
      se: { x: -hw, y: -hh },
    }[mode];
    const oppWorld = rotatePoint(oppositeLocal.x, oppositeLocal.y, angle);
    const ox = cx + oppWorld.x;
    const oy = cy + oppWorld.y;
    const toMouse = rotatePoint(videoPt.x - ox, videoPt.y - oy, -angle);
    let newW = Math.max(MIN_SIZE, Math.abs(toMouse.x));
    let newH = newW / aspect;
    if (newH < MIN_SIZE) {
      newH = MIN_SIZE;
      newW = newH * aspect;
    }
    const moveLocal = {
      nw: { x: -newW, y: -newH },
      ne: { x: newW, y: -newH },
      sw: { x: -newW, y: newH },
      se: { x: newW, y: newH },
    }[mode];
    const midWorld = rotatePoint(moveLocal.x / 2, moveLocal.y / 2, angle);
    return {
      ...origin,
      x: ox + midWorld.x - newW / 2,
      y: oy + midWorld.y - newH / 2,
      w: newW,
      h: newH,
    };
  }

  function startDrag(e: MouseEvent, clip: ComposeTextOverlayClip, mode: TextStickerDragMode): void {
    const cr = contentRect.value;
    if (!cr) return;
    e.preventDefault();
    e.stopPropagation();
    const origin = { ...displayRectOf(clip) };
    const startVideo = clientToVideo(e.clientX, e.clientY);
    if (!startVideo) return;
    const startAngle = Math.atan2(startVideo.y - (origin.y + origin.h / 2), startVideo.x - (origin.x + origin.w / 2));

    const onMove = (ev: MouseEvent) => {
      const pt = clientToVideo(ev.clientX, ev.clientY);
      if (!pt) return;
      let next: RectConfig;
      if (mode === "move") {
        next = {
          ...origin,
          x: origin.x + (pt.x - startVideo.x),
          y: origin.y + (pt.y - startVideo.y),
        };
      } else if (mode === "rotate") {
        const now = Math.atan2(pt.y - (origin.y + origin.h / 2), pt.x - (origin.x + origin.w / 2));
        next = { ...origin, angle: origin.angle + (now - startAngle) };
      } else {
        next = applyResize(origin, mode, pt);
      }
      draftById.value = { ...draftById.value, [clip.id]: clampRectToVideo(next, cr.videoW, cr.videoH) };
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const committed = draftById.value[clip.id];
      if (committed) {
        onCommitRect(clip.id, committed);
        const copy = { ...draftById.value };
        delete copy[clip.id];
        draftById.value = copy;
      }
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  /** clip 是否处于当前预览时间且 SVG 已就绪 */
  function isClipVisible(clipId: string): boolean {
    return visibleIdSet.value.has(clipId) && Boolean(svgHtmlById.value[clipId]);
  }

  /** 本轮刚进入可见，用于 text-sticker--enter */
  function isEntering(clipId: string): boolean {
    return enteringIdSet.value.has(clipId);
  }

  return {
    contentRect,
    isClipVisible,
    isEntering,
    setSvgHost,
    svgHtmlById,
    boxStyle,
    startDrag,
    handleSize: HANDLE,
    accent: ACCENT,
  };
}
