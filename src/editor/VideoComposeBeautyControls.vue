<template>
  <div class="flex flex-col gap-3">
    <div class="flex items-center justify-between">
      <span class="flex items-center gap-2 text-[14px] font-medium text-[var(--compose-fg)]">
        <Sparkles :size="16" class="text-[var(--compose-accent)]" />
        美颜
      </span>
      <el-switch :model-value="beauty.enabled" @change="onEnabled" />
    </div>
    <template v-if="beauty.enabled">
      <div v-for="field in fields" :key="field.key" class="flex flex-col gap-1">
        <div class="flex items-center justify-between text-[12px] text-[var(--compose-fg-2)]">
          <span>{{ field.label }}</span>
          <span>{{ formatLevel(beauty[field.key]) }}</span>
        </div>
        <el-slider
          :model-value="beauty[field.key]"
          :min="0"
          :max="10"
          :step="0.1"
          :show-tooltip="false"
          @input="onLevel(field.key, $event)"
        />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { Sparkles } from "@lucide/vue";
import type { BeautyParams } from "@/types/composeMedia";
import { clampBeautyLevel } from "@/types/composeMedia";

/** 一条美颜滑杆 */
interface BeautyField {
  /** 参数字段 */
  key: "smooth" | "whiten" | "slim" | "eye";
  /** 滑杆标题 */
  label: string;
}

const fields: BeautyField[] = [
  { key: "smooth", label: "磨皮" },
  { key: "whiten", label: "美白" },
  { key: "slim", label: "瘦脸" },
  { key: "eye", label: "大眼" },
];

const props = defineProps<{
  /** 当前视频片段的美颜参数 */
  beauty: BeautyParams;
}>();

const emit = defineEmits<{
  /** 开关或滑杆变化后的完整参数 */
  "update:beauty": [value: BeautyParams];
}>();

/** 滑杆右侧的一位小数 */
function formatLevel(value: number): string {
  return clampBeautyLevel(value).toFixed(1);
}

/** 总开关。关闭后仍保留四项强度 */
function onEnabled(value: string | number | boolean): void {
  emit("update:beauty", { ...props.beauty, enabled: value === true });
}

/** 单项强度。Element Plus 的 input 可能给出数组 */
function onLevel(key: BeautyField["key"], value: number | number[]): void {
  const raw = Array.isArray(value) ? value[0] : value;
  emit("update:beauty", { ...props.beauty, [key]: clampBeautyLevel(raw) });
}
</script>
