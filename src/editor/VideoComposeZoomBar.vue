<template>
  <div
    ref="barRef"
    class="relative mr-4 h-6 min-w-0 flex-1"
    :class="disabled ? 'pointer-events-none opacity-40' : ''"
    @pointerdown="onJump"
  >
    <span class="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-[var(--compose-surface-2)]" />
    <div
      class="compose-zoom__thumb absolute top-1/2 h-4 -translate-y-1/2 cursor-grab rounded-full active:cursor-grabbing"
      :style="{ left: `${leftPct}%`, width: `${Math.max(0, widthPct)}%` }"
      @pointerdown.stop="onPress($event, 'm')"
    >
      <span
        class="absolute inset-y-0 left-0 w-2.5 cursor-ew-resize rounded-full bg-[var(--compose-accent)]"
        aria-label="调整可视区间起点"
        @pointerdown.stop="onPress($event, 'l')"
      />
      <span
        class="absolute inset-y-0 right-0 w-2.5 cursor-ew-resize rounded-full bg-[var(--compose-accent)]"
        aria-label="调整可视区间终点"
        @pointerdown.stop="onPress($event, 'r')"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";

const props = defineProps<{
  /** 可视区间左缘，相对总时长的百分比 */
  leftPct: number;
  /** 可视区间宽度百分比 */
  widthPct: number;
  /** 区间最短占比，避免缩成一条线 */
  minSpanPct: number;
  /** 没有时长时不可拖 */
  disabled?: boolean;
}>();

const emit = defineEmits<{
  /** 拖动或点击后的左右百分比 */
  change: [leftPct: number, rightPct: number];
  /** 手势结束 */
  end: [];
}>();

const barRef = ref<HTMLElement | null>(null);

/** 百分比夹在 0–100 */
function clampPct(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 点轨道空白：区间中心移到点击处 */
function onJump(event: PointerEvent): void {
  if (props.disabled || event.button !== 0) return;
  const bar = barRef.value;
  if (!bar || bar.clientWidth <= 0) return;
  const rect = bar.getBoundingClientRect();
  const center = ((event.clientX - rect.left) / rect.width) * 100;
  const span = props.widthPct;
  const left = clampPct(center - span / 2, 0, 100 - span);
  emit("change", left, left + span);
  emit("end");
}

/** 拖中间平移，拖两端改区间长度 */
function onPress(event: PointerEvent, mode: "l" | "r" | "m"): void {
  if (props.disabled || event.button !== 0) return;
  event.preventDefault();
  const bar = barRef.value;
  if (!bar || bar.clientWidth <= 0) return;
  const width = bar.clientWidth;
  const originX = event.clientX;
  const startLeft = props.leftPct;
  const startRight = props.leftPct + props.widthPct;
  const minSpan = Math.min(100, Math.max(0, props.minSpanPct));

  const onMove = (ev: PointerEvent) => {
    const delta = ((ev.clientX - originX) / width) * 100;
    if (mode === "m") {
      const span = startRight - startLeft;
      const left = clampPct(startLeft + delta, 0, 100 - span);
      emit("change", left, left + span);
      return;
    }
    if (mode === "l") {
      const left = clampPct(startLeft + delta, 0, startRight - minSpan);
      emit("change", left, startRight);
      return;
    }
    const right = clampPct(startRight + delta, startLeft + minSpan, 100);
    emit("change", startLeft, right);
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    emit("end");
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}
</script>

<style scoped lang="scss">
.compose-zoom__thumb {
  background: var(--compose-accent-soft);
  transition: background-color 200ms cubic-bezier(0.25, 0.8, 0.25, 1);
}

.compose-zoom__thumb:hover {
  background: color-mix(in srgb, var(--compose-accent) 35%, transparent);
}
</style>
