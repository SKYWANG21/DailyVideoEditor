<template>
  <div class="flex flex-col gap-3">
    <div class="flex items-center justify-between">
      <span class="text-[14px] font-medium text-[var(--compose-fg)]">调色</span>
      <button type="button" class="text-[12px] text-[var(--compose-fg-2)] disabled:opacity-50" :disabled="disabled" @click="reset">
        重置
      </button>
    </div>
    <div v-for="field in fields" :key="field.key" class="flex flex-col gap-1">
      <span class="text-[12px] text-[var(--compose-fg-2)]">{{ field.label }}</span>
      <div class="flex items-center gap-3">
        <el-slider
          :model-value="draft[field.key]"
          :aria-label="field.label"
          :min="field.min"
          :max="100"
          :step="1"
          :disabled="disabled"
          :show-tooltip="false"
          class="color-adjustment-slider"
          @input="updateDraft(field.key, $event)"
          @change="commit(field.key, $event)"
        />
        <el-input-number
          :model-value="draft[field.key]"
          :aria-label="field.label"
          :min="field.min"
          :max="100"
          :step="1"
          :disabled="disabled"
          :value-on-clear="0"
          size="small"
          controls-position="right"
          class="color-adjustment-input tabular-nums"
          @change="commit(field.key, $event)"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { readVideoAdjustments, type VideoAdjustments } from "@/types/videoAdjustments";

const props = defineProps<{
  /** 当前选中片段的持久化参数。 */
  adjustments: VideoAdjustments;
  /** 选中目标变更时取消控件草稿。 */
  clipId: string;
  /** 未选中视频片段时禁用。 */
  disabled: boolean;
}>();
const emit = defineEmits<{
  /** 完成调节或重置后提交完整参数。 */
  change: [value: VideoAdjustments];
}>();
const fields: { key: keyof VideoAdjustments; label: string; min: number }[] = [
  { key: "temperature", label: "色温", min: -100 },
  { key: "tint", label: "色调", min: -100 },
  { key: "saturation", label: "饱和度", min: -100 },
  { key: "brightness", label: "亮度", min: -100 },
  { key: "contrast", label: "对比度", min: -100 },
  { key: "highlights", label: "高光", min: -100 },
  { key: "shadows", label: "阴影", min: -100 },
  { key: "sharpen", label: "锐化", min: 0 },
  { key: "grain", label: "颗粒", min: 0 },
];
const draft = ref(readVideoAdjustments(props.adjustments));
/** 切换选中片段或撤销后从项目重新填充控件。 */
watch(
  () => [props.clipId, props.adjustments],
  () => {
    draft.value = readVideoAdjustments(props.adjustments);
  },
);

/** 拖动时同步数字框，只更新草稿以免反复重启解码队列。 */
function updateDraft(key: keyof VideoAdjustments, value: number | number[]): void {
  draft.value = readVideoAdjustments({ ...draft.value, [key]: Array.isArray(value) ? value[0] : value });
}

/** 滑块操作或数字输入完成时写回当前片段。 */
function commit(key: keyof VideoAdjustments, value: number | number[] | null | undefined): void {
  if (props.disabled || value == null) return;
  updateDraft(key, value);
  emit("change", { ...draft.value });
}

/** 将九项参数恢复到中性值。 */
function reset(): void {
  if (props.disabled) return;
  draft.value = readVideoAdjustments();
  emit("change", { ...draft.value });
}
</script>

<style scoped lang="scss">
.color-adjustment-slider {
  --el-slider-height: 8px;
  --el-slider-button-size: 16px;
  --el-slider-button-wrapper-offset: calc((var(--el-slider-height) - var(--el-slider-button-wrapper-size)) / 2);
  --el-slider-border-radius: 9999px;
  --el-slider-main-bg-color: var(--compose-accent, var(--el-color-primary));
  --el-slider-runway-bg-color: var(--compose-surface-3, var(--el-border-color-light));
  flex: 1;
  min-width: 0;
  height: 36px;
}

.color-adjustment-slider :deep(.el-slider__bar) {
  border-radius: var(--el-slider-border-radius);
}

.color-adjustment-slider :deep(.el-slider__runway:not(.is-disabled) .el-slider__button) {
  border-color: var(--el-color-white);
  background: var(--el-slider-main-bg-color);
  box-shadow: var(--compose-shadow-1, var(--el-box-shadow-lighter));
}

.color-adjustment-input {
  flex-shrink: 0;
  width: 108px;
}
</style>
