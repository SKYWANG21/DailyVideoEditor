<template>
  <div class="pointer-events-none absolute inset-0 z-30">
    <!-- 坐标原点仍是黑色画布，但本层不裁切，画幅外的手柄留在预览区里 -->
    <div ref="canvasRef" class="absolute" :style="canvasOriginStyle">
      <div v-if="guides.includes('v')" class="absolute top-0 bottom-0 w-px bg-[var(--compose-accent)]" :style="{ left: '50%' }" />
      <div v-if="guides.includes('h')" class="absolute right-0 left-0 h-px bg-[var(--compose-accent)]" :style="{ top: '50%' }" />
      <div v-if="guides.includes('left')" class="absolute top-0 bottom-0 left-0 w-px bg-[var(--compose-accent)]" />
      <div v-if="guides.includes('right')" class="absolute top-0 right-0 bottom-0 w-px bg-[var(--compose-accent)]" />
      <div v-if="guides.includes('top')" class="absolute top-0 right-0 left-0 h-px bg-[var(--compose-accent)]" />
      <div v-if="guides.includes('bottom')" class="absolute right-0 bottom-0 left-0 h-px bg-[var(--compose-accent)]" />

      <div class="pointer-events-auto absolute cursor-move" :style="boxStyle" @pointerdown="onPointerDown($event, 'move')" />

      <div v-if="active" class="pointer-events-none absolute z-30" :style="boxStyle">
        <span class="absolute inset-0 border border-[var(--compose-accent)]" />
        <button
          type="button"
          class="pointer-events-auto absolute left-1/2 z-10 size-3 -translate-x-1/2 cursor-grab rounded-full border-2 border-white bg-[var(--compose-accent)]"
          style="top: -22px"
          aria-label="旋转画面"
          @pointerdown="onPointerDown($event, 'rotate')"
        />
        <span class="absolute left-1/2 w-px -translate-x-1/2 bg-[var(--compose-accent)]" style="top: -16px; height: 16px" />
        <button
          v-for="handle in handles"
          :key="handle.mode"
          type="button"
          class="pointer-events-auto absolute z-10 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-[var(--compose-accent)]"
          :style="{ left: handle.left, top: handle.top, cursor: handle.cursor }"
          :aria-label="handle.label"
          @pointerdown="onPointerDown($event, handle.mode)"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { VideoFrameTransform } from "@/types/videoCompose";
import { applyFramePointerDelta, frameBoxStyle, snapFrameRotate, type FrameDragMode, type FrameSnapGuide } from "../shared/videoFrame";

const props = defineProps<{
  /** 当前画面变换 */
  frame: VideoFrameTransform;
  /** 画布宽（画布像素） */
  canvasWidth: number;
  /** 画布高（画布像素） */
  canvasHeight: number;
  /** 画布像素到屏幕像素的比例 */
  stageScale: number;
  /** 黑色画布左上角相对预览区的偏移 */
  offsetX: number;
  /** 黑色画布左上角相对预览区的偏移 */
  offsetY: number;
  /** 黑色画布在预览区里的显示宽度 */
  stageWidth: number;
  /** 黑色画布在预览区里的显示高度 */
  stageHeight: number;
  /** 当前画面上的片段已被选中，才显示调整框 */
  active?: boolean;
}>();

const emit = defineEmits<{
  select: [];
  "update:frame": [frame: VideoFrameTransform];
}>();

/** 黑色画布在浮层中的矩形，旋转按它换算指针，不用整块预览区 */
const canvasRef = ref<HTMLElement | null>(null);
const dragging = ref<VideoFrameTransform | null>(null);
const guides = ref<FrameSnapGuide[]>([]);

const shown = computed(() => dragging.value ?? props.frame);

const canvasOriginStyle = computed(() => ({
  left: `${props.offsetX}px`,
  top: `${props.offsetY}px`,
  width: `${props.stageWidth}px`,
  height: `${props.stageHeight}px`,
}));

const boxStyle = computed(() => frameBoxStyle(shown.value, props.canvasWidth, props.canvasHeight, props.stageScale || 1));

const handles: Array<{ mode: Exclude<FrameDragMode, "move" | "rotate">; left: string; top: string; cursor: string; label: string }> = [
  { mode: "nw", left: "0%", top: "0%", cursor: "nwse-resize", label: "左上缩放" },
  { mode: "n", left: "50%", top: "0%", cursor: "ns-resize", label: "上边缩放" },
  { mode: "ne", left: "100%", top: "0%", cursor: "nesw-resize", label: "右上缩放" },
  { mode: "e", left: "100%", top: "50%", cursor: "ew-resize", label: "右边缩放" },
  { mode: "se", left: "100%", top: "100%", cursor: "nwse-resize", label: "右下缩放" },
  { mode: "s", left: "50%", top: "100%", cursor: "ns-resize", label: "下边缩放" },
  { mode: "sw", left: "0%", top: "100%", cursor: "nesw-resize", label: "左下缩放" },
  { mode: "w", left: "0%", top: "50%", cursor: "ew-resize", label: "左边缩放" },
];

/** 拖动画面、缩放或旋转。位移先换算成画布像素 */
function onPointerDown(event: PointerEvent, mode: FrameDragMode): void {
  if (event.button !== 0 || props.stageScale <= 0) return;
  event.stopPropagation();
  event.preventDefault();
  emit("select");
  const base = { ...props.frame };
  const x0 = event.clientX;
  const y0 = event.clientY;
  const startAngle = mode === "rotate" ? pointerAngle(event, base) : 0;
  dragging.value = base;

  const onMove = (ev: PointerEvent) => {
    if (mode === "rotate") {
      const nextAngle = pointerAngle(ev, base);
      const snapped = snapFrameRotate(base.rotate + ((nextAngle - startAngle) * 180) / Math.PI);
      dragging.value = { ...base, rotate: snapped.rotate };
      guides.value = [];
    } else {
      const dx = (ev.clientX - x0) / props.stageScale;
      const dy = (ev.clientY - y0) / props.stageScale;
      const next = applyFramePointerDelta(base, dx, dy, mode, props.canvasWidth, props.canvasHeight);
      dragging.value = next.frame;
      guides.value = next.guides;
    }
    if (dragging.value) emit("update:frame", dragging.value);
  };
  const onUp = () => {
    dragging.value = null;
    guides.value = [];
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

/** 指针相对画面中心的角度（弧度） */
function pointerAngle(event: PointerEvent, frame: VideoFrameTransform): number {
  const layer = canvasRef.value;
  if (!layer) return 0;
  const rect = layer.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return 0;
  const x = ((event.clientX - rect.left) / rect.width) * props.canvasWidth;
  const y = ((event.clientY - rect.top) / rect.height) * props.canvasHeight;
  const cx = props.canvasWidth / 2 + frame.x;
  const cy = props.canvasHeight / 2 + frame.y;
  return Math.atan2(y - cy, x - cx);
}
</script>
