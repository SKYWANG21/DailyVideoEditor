<template>
  <div class="flex items-center gap-3">
    <div class="relative h-9 flex flex-1 items-center">
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
        :model-value="db"
        :min="VOLUME_DB_MIN"
        :max="VOLUME_DB_MAX"
        :step="VOLUME_DB_INPUT_STEP"
        :precision="1"
        :value-on-clear="null"
        size="small"
        controls-position="right"
        placeholder="静音"
        class="volume-db-input"
        @mousedown="primePreviewAudioContext"
        @change="onInputChange"
      />
      <span class="text-[12px] text-[var(--compose-fg-3,#8e8e99)]">dB</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { primePreviewAudioContext } from "@/hooks/previewMediaGain";
import {
  VOLUME_DB_INPUT_STEP,
  VOLUME_DB_MAX,
  VOLUME_DB_MIN,
  clampDb,
  dbToSliderRatio,
  roundDb,
  sliderRatioToDb,
} from "./volumeDb";

const props = defineProps<{
  /** 当前音量（dB）；null 为静音 */
  db: number | null;
}>();

const emit = defineEmits<{
  /** 用户拖动滑块或改数字后的分贝；null 为静音 */
  "update:db": [value: number | null];
}>();

/** 滑块轨道，用来把指针位置换算成分贝 */
const trackRef = ref<HTMLElement | null>(null);

/** 填充宽度。静音为 0，+12 dB 为 100% */
const fillPercent = computed(() => `${dbToSliderRatio(props.db) * 100}%`);

/** 拇指左边缘。与旧滑条一样用半径把圆心对齐到刻度 */
const thumbLeft = computed(() => `calc(${dbToSliderRatio(props.db) * 100}% - 8px)`);

/** 指针相对轨道的 0～1 位置 */
function ratioFromClientX(clientX: number): number {
  const track = trackRef.value;
  if (!track) return 0;
  const rect = track.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  return (clientX - rect.left) / rect.width;
}

/**
 * 按下轨道：点在拇指外立即按 1 dB 吸附；点在拇指上则等到拖动再改，避免吃掉 0.1 dB。
 */
function onTrackPointerDown(e: MouseEvent): void {
  primePreviewAudioContext();
  const track = trackRef.value;
  const width = track?.getBoundingClientRect().width ?? 0;
  const ratio = ratioFromClientX(e.clientX);
  const awayFromThumb = Math.abs(ratio - dbToSliderRatio(props.db)) * width > 9;
  if (awayFromThumb) emit("update:db", sliderRatioToDb(ratio));

  const onMove = (ev: MouseEvent) => {
    emit("update:db", sliderRatioToDb(ratioFromClientX(ev.clientX)));
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

/** 数字框按 0.1 dB 取整后写出；清空为静音 */
function onInputChange(value: number | null | undefined): void {
  primePreviewAudioContext();
  if (value == null || !Number.isFinite(value)) {
    emit("update:db", null);
    return;
  }
  emit("update:db", clampDb(roundDb(value, VOLUME_DB_INPUT_STEP)));
}
</script>

<style scoped lang="scss">
.volume-db-input {
  width: 108px;
}
</style>
