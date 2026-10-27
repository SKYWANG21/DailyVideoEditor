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
        <div class="h-10 w-10 shrink-0 rounded-[4px] border border-[var(--el-border-color,#dcdfe6)] bg-[var(--compose-surface)] p-1">
          <div class="relative h-full w-full overflow-hidden rounded-[2px]">
            <input
              type="color"
              :value="swatchColor"
              class="absolute -inset-2.5 h-[60px] w-[60px] cursor-pointer border-0 p-0"
              @input="onColorInput"
            />
          </div>
        </div>
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

/** 原生 color 在非 hex（空串 / 渐变）时的占位色 */
const SWATCH_FALLBACK = "#000000";

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

/** 色块展示值；非 hex 时用占位，避免原生 color 失效 */
const swatchColor = computed(() => (isCssHexColor(props.color) ? props.color.trim() : SWATCH_FALLBACK));

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

/** 取色器写回贴图颜色 */
function onColorInput(e: Event): void {
  emit("change", { color: (e.target as HTMLInputElement).value });
}

/** 清空为 ""，预览不覆盖模板渐变 fill；合法 hex 才写回 */
function onColorTextInput(e: Event): void {
  const raw = (e.target as HTMLInputElement).value;
  colorDraft.value = raw;
  const trimmed = raw.trim();
  if (trimmed === "" || isCssHexColor(trimmed)) {
    emit("change", { color: trimmed });
  }
}
</script>
