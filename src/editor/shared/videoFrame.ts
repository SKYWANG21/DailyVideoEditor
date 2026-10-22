import type { CSSProperties } from "vue";
import type { ComposeFrameAspect, ComposeMediaClipConfig, VideoFrameTransform } from "@/types/videoCompose";
import { readClipConfig } from "@/types/videoCompose";

/** 画幅下拉选项 */
export const COMPOSE_FRAME_ASPECT_OPTIONS: Array<{ value: ComposeFrameAspect; label: string }> = [
  { value: "native", label: "原画" },
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
  { value: "4:3", label: "4:3" },
  { value: "3:4", label: "3:4" },
];

/** 预设画布像素。原画不用这份表 */
const FRAME_PRESET_SIZE: Record<Exclude<ComposeFrameAspect, "native">, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "4:3": { width: 1440, height: 1080 },
  "3:4": { width: 1080, height: 1440 },
};

/** 还没探到原画像素时的画布 */
export const COMPOSE_FRAME_FALLBACK = { width: 1080, height: 1920 };

/** 移动和拉边吸附阈值（画布像素） */
export const FRAME_SNAP_PX = 32;

/** 旋转吸附阈值（度） */
export const FRAME_ROTATE_SNAP_DEG = 5;

/** 吸附时画出的参考线 */
export type FrameSnapGuide = "v" | "h" | "left" | "right" | "top" | "bottom";

/** 调整框拖拽模式。四角改缩放，四边改宽或高 */
export type FrameDragMode = "move" | "rotate" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const HANDLE_SIGN: Record<Exclude<FrameDragMode, "move" | "rotate">, [number, number]> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
};

/** 把未知值收成画幅枚举 */
export function normalizeFrameAspect(value: unknown): ComposeFrameAspect {
  if (value === "16:9" || value === "9:16" || value === "4:3" || value === "3:4" || value === "native") return value;
  return "native";
}

/** 画布像素。原画用第一个 clip 的尺寸，没有则用竖屏兜底 */
export function resolveComposeCanvasSize(
  aspect: ComposeFrameAspect,
  nativeWidth?: number,
  nativeHeight?: number,
): { width: number; height: number } {
  if (aspect !== "native") return FRAME_PRESET_SIZE[aspect];
  if (nativeWidth && nativeHeight && nativeWidth > 0 && nativeHeight > 0) {
    return { width: nativeWidth, height: nativeHeight };
  }
  return COMPOSE_FRAME_FALLBACK;
}

/** 读取已保存的画面变换。字段不完整则视为还没编辑过 */
export function readVideoFrameTransform(config: unknown): VideoFrameTransform | null {
  const frame = readClipConfig(config).frame;
  if (!frame) return null;
  if (![frame.x, frame.y, frame.w, frame.h, frame.scale, frame.rotate].every((n) => typeof n === "number" && Number.isFinite(n))) {
    return null;
  }
  if (frame.w <= 0 || frame.h <= 0 || frame.scale <= 0) return null;
  return { x: frame.x, y: frame.y, w: frame.w, h: frame.h, scale: frame.scale, rotate: frame.rotate };
}

/** 读取片段原始像素。还没探到时为空 */
export function readClipSourceSize(config: unknown): { width: number; height: number } | null {
  const raw = readClipConfig(config) as ComposeMediaClipConfig;
  if (!raw.sourceWidth || !raw.sourceHeight || raw.sourceWidth <= 0 || raw.sourceHeight <= 0) return null;
  return { width: raw.sourceWidth, height: raw.sourceHeight };
}

/** 把视频内容等比放进画布并居中。scale 为 100，旋转为 0 */
export function fitVideoFrame(canvasW: number, canvasH: number, videoW: number, videoH: number): VideoFrameTransform {
  const ratio = videoW > 0 && videoH > 0 ? videoW / videoH : canvasW / Math.max(1, canvasH);
  const canvasRatio = canvasW / Math.max(1, canvasH);
  const w = ratio > canvasRatio ? canvasW : canvasH * ratio;
  const h = ratio > canvasRatio ? canvasW / ratio : canvasH;
  return {
    x: 0,
    y: 0,
    w: Math.max(1, Math.round(w)),
    h: Math.max(1, Math.round(h)),
    scale: 100,
    rotate: 0,
  };
}

/** 有保存值就用保存值，否则按当前画布适配，不写回 */
export function resolveVideoFrame(
  config: unknown,
  canvasW: number,
  canvasH: number,
  sourceW?: number,
  sourceH?: number,
): VideoFrameTransform {
  return readVideoFrameTransform(config) ?? fitVideoFrame(canvasW, canvasH, sourceW ?? canvasW, sourceH ?? canvasH);
}

/** 侧栏数字夹进可调范围 */
export function clampVideoFrame(frame: VideoFrameTransform): VideoFrameTransform {
  return {
    x: clampNum(frame.x, -99999, 99999),
    y: clampNum(frame.y, -99999, 99999),
    w: clampNum(frame.w, 1, 100000),
    h: clampNum(frame.h, 1, 100000),
    scale: Math.round(clampNum(frame.scale, 1, 1000) * 10) / 10,
    rotate: clampNum(frame.rotate, -360, 360),
  };
}

/** 缩放后的显示宽高（画布像素） */
export function frameDisplaySize(frame: VideoFrameTransform): { w: number; h: number } {
  return {
    w: (frame.w * frame.scale) / 100,
    h: (frame.h * frame.scale) / 100,
  };
}

/** 画面盒子在画布显示像素中的位置。旋转绕盒子中心 */
export function frameBoxStyle(frame: VideoFrameTransform, canvasW: number, canvasH: number, scale: number): CSSProperties {
  const dw = ((frame.w * frame.scale) / 100) * scale;
  const dh = ((frame.h * frame.scale) / 100) * scale;
  const left = (canvasW / 2 + frame.x) * scale - dw / 2;
  const top = (canvasH / 2 + frame.y) * scale - dh / 2;
  return {
    left: `${left}px`,
    top: `${top}px`,
    width: `${dw}px`,
    height: `${dh}px`,
    transform: `rotate(${frame.rotate}deg)`,
  };
}

/** 预览区里按画幅留白后的画布盒子 */
export function containFrameStage(
  containerW: number,
  containerH: number,
  canvasW: number,
  canvasH: number,
): { width: number; height: number; scale: number } {
  if (containerW <= 0 || containerH <= 0 || canvasW <= 0 || canvasH <= 0) {
    return { width: 0, height: 0, scale: 0 };
  }
  const scale = Math.min(containerW / canvasW, containerH / canvasH);
  return { width: canvasW * scale, height: canvasH * scale, scale };
}

/** 移动或拉边后的变换，带吸附参考线 */
export function applyFramePointerDelta(
  base: VideoFrameTransform,
  dx: number,
  dy: number,
  mode: Exclude<FrameDragMode, "rotate">,
  canvasW: number,
  canvasH: number,
): { frame: VideoFrameTransform; guides: FrameSnapGuide[] } {
  if (mode === "move") return snapFrameMove({ ...base, x: base.x + dx, y: base.y + dy }, canvasW, canvasH);
  return resizeFrame(base, dx, dy, HANDLE_SIGN[mode], canvasW, canvasH);
}

/** 旋转到最近的直角。5° 内吸到 0/90/180/-90 */
export function snapFrameRotate(deg: number): { rotate: number; snapped: boolean } {
  const wrapped = ((((deg + 180) % 360) + 360) % 360) - 180;
  const stops = [0, 90, 180, -90, -180];
  for (const stop of stops) {
    const delta = Math.abs(wrapped - stop);
    if (delta <= FRAME_ROTATE_SNAP_DEG || Math.abs(delta - 360) <= FRAME_ROTATE_SNAP_DEG) {
      return { rotate: stop === -180 ? 180 : stop, snapped: true };
    }
  }
  return { rotate: Math.round(wrapped), snapped: false };
}

/** 探测视频原始像素。失败返回空，不抛错 */
export function probeVideoPixelSize(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    if (!url.trim()) {
      resolve(null);
      return;
    }
    const video = document.createElement("video");
    video.preload = "metadata";
    const finish = (size: { width: number; height: number } | null) => {
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute("src");
      video.load();
      resolve(size);
    };
    video.onloadedmetadata = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) finish({ width: video.videoWidth, height: video.videoHeight });
      else finish(null);
    };
    video.onerror = () => finish(null);
    video.src = url;
  });
}

function clampNum(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** 移动时贴齐画布四边，中心贴齐水平/垂直中线。取更近的那条 */
function snapFrameMove(
  frame: VideoFrameTransform,
  canvasW: number,
  canvasH: number,
): { frame: VideoFrameTransform; guides: FrameSnapGuide[] } {
  const { w, h } = frameDisplaySize(frame);
  const guides: FrameSnapGuide[] = [];
  const x = snapAxis(frame.x, [
    { value: 0, guide: "v" },
    { value: w / 2 - canvasW / 2, guide: "left" },
    { value: canvasW / 2 - w / 2, guide: "right" },
  ]);
  const y = snapAxis(frame.y, [
    { value: 0, guide: "h" },
    { value: h / 2 - canvasH / 2, guide: "top" },
    { value: canvasH / 2 - h / 2, guide: "bottom" },
  ]);
  if (x.guide) guides.push(x.guide);
  if (y.guide) guides.push(y.guide);
  return { frame: { ...frame, x: Math.round(x.value), y: Math.round(y.value) }, guides };
}

function snapAxis(
  current: number,
  targets: Array<{ value: number; guide: FrameSnapGuide }>,
): { value: number; guide: FrameSnapGuide | null } {
  let best = current;
  let guide: FrameSnapGuide | null = null;
  let bestDist = FRAME_SNAP_PX;
  for (const target of targets) {
    const dist = Math.abs(current - target.value);
    if (dist <= bestDist) {
      bestDist = dist;
      best = target.value;
      guide = target.guide;
    }
  }
  return { value: best, guide };
}

/** 四角等比缩放，四边改宽或高。拉边时活动边贴齐画布边 */
function resizeFrame(
  base: VideoFrameTransform,
  dx: number,
  dy: number,
  sign: [number, number],
  canvasW: number,
  canvasH: number,
): { frame: VideoFrameTransform; guides: FrameSnapGuide[] } {
  const [sx, sy] = sign;
  const scale = base.scale / 100;
  const hw = (base.w * scale) / 2;
  const hh = (base.h * scale) / 2;
  const rad = (base.rotate * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const lx = dx * cos + dy * sin;
  const ly = -dx * sin + dy * cos;
  const next = { ...base };
  let cx = 0;
  let cy = 0;
  if (sx && sy) {
    const grown = growUniformScale(base.scale, hw, hh, sx, sy, lx, ly);
    next.scale = grown.scale;
    cx = grown.cx;
    cy = grown.cy;
  } else if (sx) {
    const grown = growEdge(hw, lx, sx);
    next.w = Math.max(1, Math.round(grown.size / scale));
    cx = grown.shift;
  } else {
    const grown = growEdge(hh, ly, sy);
    next.h = Math.max(1, Math.round(grown.size / scale));
    cy = grown.shift;
  }
  next.x = Math.round(base.x + cx * cos - cy * sin);
  next.y = Math.round(base.y + cx * sin + cy * cos);
  return snapResizedEdge(next, sign, canvasW, canvasH);
}

function growUniformScale(
  scale: number,
  hw: number,
  hh: number,
  sx: number,
  sy: number,
  lx: number,
  ly: number,
): { scale: number; cx: number; cy: number } {
  const ux = 2 * sx * hw;
  const uy = 2 * sy * hh;
  const denom = ux * ux + uy * uy;
  const factor = denom > 0 ? Math.max(0.05, ((ux + lx) * ux + (uy + ly) * uy) / denom) : 1;
  const nextScale = Math.round(clampNum(scale * factor, 1, 1000) * 10) / 10;
  const applied = scale > 0 ? nextScale / scale : 1;
  return {
    scale: nextScale,
    cx: sx * hw * (applied - 1),
    cy: sy * hh * (applied - 1),
  };
}

function growEdge(half: number, localDelta: number, sign: number): { size: number; shift: number } {
  const size = Math.max(16, 2 * half + sign * localDelta);
  return { size, shift: (sign * (size - 2 * half)) / 2 };
}

/** 活动边靠近画布边时贴齐，并保持对边不动 */
function snapResizedEdge(
  frame: VideoFrameTransform,
  sign: [number, number],
  canvasW: number,
  canvasH: number,
): { frame: VideoFrameTransform; guides: FrameSnapGuide[] } {
  const [sx, sy] = sign;
  if (sx && sy) return { frame, guides: [] };
  const { w, h } = frameDisplaySize(frame);
  const guides: FrameSnapGuide[] = [];
  let next = frame;
  if (sx) {
    const snapped = snapOneEdge(frame.x, w, canvasW, sx, "left", "right");
    if (snapped.guide) {
      guides.push(snapped.guide);
      const scale = frame.scale / 100;
      next = { ...next, x: Math.round(snapped.center), w: Math.max(1, Math.round(snapped.size / scale)) };
    }
  }
  if (sy) {
    const snapped = snapOneEdge(frame.y, h, canvasH, sy, "top", "bottom");
    if (snapped.guide) {
      guides.push(snapped.guide);
      const scale = frame.scale / 100;
      next = { ...next, y: Math.round(snapped.center), h: Math.max(1, Math.round(snapped.size / scale)) };
    }
  }
  return { frame: next, guides };
}

function snapOneEdge(
  center: number,
  size: number,
  canvas: number,
  sign: number,
  startGuide: FrameSnapGuide,
  endGuide: FrameSnapGuide,
): { center: number; size: number; guide: FrameSnapGuide | null } {
  const start = canvas / 2 + center - size / 2;
  const end = start + size;
  if (sign < 0 && Math.abs(start) <= FRAME_SNAP_PX) {
    return { center: end / 2 - canvas / 2, size: end, guide: startGuide };
  }
  if (sign > 0 && Math.abs(end - canvas) <= FRAME_SNAP_PX) {
    return { center: (start + canvas) / 2 - canvas / 2, size: canvas - start, guide: endGuide };
  }
  return { center, size, guide: null };
}
