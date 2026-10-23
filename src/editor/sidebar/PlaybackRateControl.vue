<template>
  <div class="flex items-center gap-3">
    <div class="relative flex h-9 flex-1 items-center">
      <div
        ref="trackRef"
        class="relative h-2 w-full cursor-pointer rounded-full bg-[var(--compose-surface-3,#e6e6ec)]"
        @mousedown.prevent="onTrackPointerDown"
      >
        <div class="absolute inset-y-0 left-0 rounded-full bg-[var(--compose-accent,#8261FF)]" :style="{ width: fillPercent }" />
        <div
          class="absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-white bg-[var(--compose-accent,#8261FF)] shadow-[var(--compose-shadow-1)]"
          :style="{ left: thumbLeft }"
        />
      </div>
    </div>
    <div class="flex shrink-0 items-center gap-1">
      <el-input-number
        :model-value="rate"
        :min="PLAYBACK_RATE_MIN"
        :max="PLAYBACK_RATE_MAX"
        :step="PLAYBACK_RATE_STEP"
        :precision="1"
        size="small"
        controls-position="right"
        class="playback-rate-input"
        @change="onInputChange"
      />
      <span class="text-[12px] text-[var(--compose-fg-3,#8e8e99)]">x</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import {
  PLAYBACK_RATE_MAX,
  PLAYBACK_RATE_MIN,
  PLAYBACK_RATE_STEP,
  clampPlaybackRate,
  playbackRateToRatio,
  ratioToPlaybackRate,
} from "../shared/playbackRate";

const props = defineProps<{
  /** 当前变速倍率 */
  rate: number;
}>();

const emit = defineEmits<{
  /** 用户拖动滑块或改数字后的倍率 */
  "update:rate": [value: number];
}>();

/** 滑块轨道，用来把指针位置换算成倍率 */
const trackRef = ref<HTMLElement | null>(null);

/** 填充宽度。0.1x 为 0，2.0x 为 100% */
const fillPercent = computed(() => `${playbackRateToRatio(props.rate) * 100}%`);

/** 拇指左边缘。用半径把圆心对齐到刻度 */
const thumbLeft = computed(() => `calc(${playbackRateToRatio(props.rate) * 100}% - 8px)`);

/** 指针相对轨道的 0～1 位置 */
function ratioFromClientX(clientX: number): number {
  const track = trackRef.value;
  if (!track) return 0;
  const rect = track.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  return (clientX - rect.left) / rect.width;
}

/** 按下轨道：点在拇指外立即吸附；点在拇指上则拖动后再改 */
function onTrackPointerDown(e: MouseEvent): void {
  const track = trackRef.value;
  const width = track?.getBoundingClientRect().width ?? 0;
  const ratio = ratioFromClientX(e.clientX);
  const awayFromThumb = Math.abs(ratio - playbackRateToRatio(props.rate)) * width > 9;
  if (awayFromThumb) emit("update:rate", ratioToPlaybackRate(ratio));

  const onMove = (ev: MouseEvent) => {
    emit("update:rate", ratioToPlaybackRate(ratioFromClientX(ev.clientX)));
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

/** 数字框按 0.1 取整后写出 */
function onInputChange(value: number | null | undefined): void {
  emit("update:rate", clampPlaybackRate(value ?? 1));
}
</script>

<style scoped lang="scss">
.playback-rate-input {
  width: 108px;
}
</style>
