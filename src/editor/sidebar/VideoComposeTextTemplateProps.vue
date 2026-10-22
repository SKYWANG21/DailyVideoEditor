<template>
  <div class="flex flex-col gap-3">
    <span class="text-[12px] text-[var(--compose-fg-2)]">贴图属性</span>
    <div class="flex flex-col gap-2">
      <label class="text-[12px] text-[var(--compose-fg-2)]">文案</label>
      <input
        :value="text"
        maxlength="64"
        class="h-10 w-full rounded-[8px] border border-transparent bg-[var(--compose-surface-2)] px-3 text-[14px] text-[var(--compose-fg)] outline-none transition-[border-color,box-shadow] duration-150 focus:border-[var(--compose-accent)] focus:shadow-[var(--compose-focus)]"
        @input="onTextInput"
      />
    </div>
    <div class="grid grid-cols-2 gap-2">
      <div class="relative">
        <input
          :value="fontSize"
          type="number"
          min="1"
          class="h-10 w-full rounded-[8px] border border-transparent bg-[var(--compose-surface-2)] px-3 pr-10 text-[14px] text-[var(--compose-fg)] outline-none transition-[border-color,box-shadow] duration-150 focus:border-[var(--compose-accent)] focus:shadow-[var(--compose-focus)]"
          @input="onFontSizeInput"
        />
        <span class="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[12px] text-[var(--compose-fg-3)]">px</span>
      </div>
      <div class="flex items-center gap-2">
        <el-color-picker
          :model-value="pickerColor"
          color-format="hex"
          size="large"
          class="text-template-color-picker shrink-0"
          @update:model-value="onPickerColor"
        />
        <input
          :value="colorDraft"
          maxlength="7"
          class="h-10 min-w-0 flex-1 rounded-[8px] border border-transparent bg-[var(--compose-surface-2)] px-3 font-mono text-[14px] text-[var(--compose-fg)] outline-none transition-[border-color,box-shadow] duration-150 focus:border-[var(--compose-accent)] focus:shadow-[var(--compose-focus)]"
          @input="onColorTextInput"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { isCssHexColor } from "../shared/textTemplateCatalog";

const props = defineProps<{
  /** 贴图文案 */
  text: string;
  /** 字号 px */
  fontSize: number;
  /** 颜色 hex；空串表示沿用模板 fill（含渐变） */
  color: string;
}>();

const emit = defineEmits<{
  change: [patch: { text?: string; fontSize?: number; color?: string }];
}>();

/** 色板只吃 hex；`url(#id)` 等传 null，触发器留空 */
const pickerColor = computed((): string | null => (isCssHexColor(props.color) ? props.color.trim() : null));

/** hex 文本框草稿：非 hex 时空白，输入中未成形的字符不立刻写回 clip */
const colorDraft = ref("");

watch(
  () => props.color,
  (color) => {
    colorDraft.value = isCssHexColor(color) ? color.trim() : "";
  },
  { immediate: true },
);

function onTextInput(e: Event): void {
  emit("change", { text: (e.target as HTMLInputElement).value });
}

function onFontSizeInput(e: Event): void {
  const fontSize = Math.max(1, Number((e.target as HTMLInputElement).value) || props.fontSize);
  emit("change", { fontSize });
}

/** 清空为 ""，预览不覆盖模板渐变 fill */
function onPickerColor(val: string | null): void {
  emit("change", { color: val ?? "" });
}

function onColorTextInput(e: Event): void {
  const raw = (e.target as HTMLInputElement).value;
  colorDraft.value = raw;
  const trimmed = raw.trim();
  if (trimmed === "" || isCssHexColor(trimmed)) {
    emit("change", { color: trimmed });
  }
}
</script>

<style scoped lang="scss">
.text-template-color-picker {
  :deep(.el-color-picker__trigger) {
    width: 40px;
    height: 40px;
    padding: 4px;
    border-radius: var(--radius-sm, 4px);
  }
}
</style>
