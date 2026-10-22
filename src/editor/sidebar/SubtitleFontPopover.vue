<template>
  <Teleport to="body">
    <div v-if="fontPopoverOpen" class="fixed inset-0 z-[9998]" @click="close" />
    <div
      v-if="fontPopoverOpen === 'family'"
      :style="fontFamilyDropdownStyle"
      class="fixed z-[10000] rounded-md border bg-popover shadow-md p-1"
      @click.stop
    >
      <button
        v-for="o in fontOptions"
        :key="o.v"
        class="block w-full text-left px-3 py-1.5 text-xs rounded-sm transition-colors"
        :class="subtitleStyle.fontFamily === o.v ? 'text-primary font-medium' : 'hover:bg-muted'"
        @click="onSelectFamily(o.v)"
      >
        {{ o.t }}
      </button>
    </div>
    <div
      v-if="fontPopoverOpen === 'style'"
      :style="fontStyleDropdownStyle"
      class="fixed z-[10000] rounded-md border bg-popover shadow-md p-1"
      @click.stop
    >
      <button
        v-for="o in styleOptions"
        :key="o.v"
        class="block w-full text-left px-3 py-1.5 text-xs rounded-sm transition-colors"
        :class="fontStyleKey === o.v ? 'text-primary font-medium' : 'hover:bg-muted'"
        @click="onSelectStyle(o.v)"
      >
        {{ o.t }}
      </button>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import type { CSSProperties } from "vue";
import type { SubtitleStyleConfig } from "@/types/videoCompose";

/** 字体下拉选项 */
export interface FontOption {
  /** ASS 字体名 */
  v: string;
  /** 展示文案 */
  t: string;
}

/** 字形下拉选项 */
export interface StyleOption {
  /** 字形 key */
  v: string;
  /** 展示文案 */
  t: string;
  /** 是否加粗 */
  bold: boolean;
  /** 是否斜体 */
  italic: boolean;
}

defineProps<{
  /** 当前打开的下拉类型，null 为关闭 */
  fontPopoverOpen: "family" | "style" | null;
  /** 字体下拉 fixed 定位样式 */
  fontFamilyDropdownStyle: CSSProperties;
  /** 字形下拉 fixed 定位样式 */
  fontStyleDropdownStyle: CSSProperties;
  /** 字体选项列表 */
  fontOptions: FontOption[];
  /** 字形选项列表 */
  styleOptions: StyleOption[];
  /** 当前字幕样式（用于高亮 fontFamily） */
  subtitleStyle: Pick<SubtitleStyleConfig, "fontFamily">;
  /** 当前字形 key（用于高亮） */
  fontStyleKey: string;
}>();

const emit = defineEmits<{
  "update:fontPopoverOpen": [value: "family" | "style" | null];
  "select-family": [fontFamily: string];
  "select-style": [styleKey: string];
}>();

function close(): void {
  emit("update:fontPopoverOpen", null);
}

function onSelectFamily(fontFamily: string): void {
  emit("select-family", fontFamily);
  emit("update:fontPopoverOpen", null);
}

function onSelectStyle(styleKey: string): void {
  emit("select-style", styleKey);
  emit("update:fontPopoverOpen", null);
}
</script>
