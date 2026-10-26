<template>
  <div
    class="relative flex h-[72px] w-[72px] overflow-hidden rounded-[12px] bg-[var(--compose-surface-2)]"
    :class="cardClass"
    :draggable="canDrag"
    @dragstart="onDragStart"
    @dragend="onDragEnd"
    @click="onClick"
  >
    <template v-if="isAudio">
      <img :src="audioSvg" alt="" class="pointer-events-none h-full w-full object-cover" draggable="false" />
      <div
        class="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-end gap-1 bg-gradient-to-t from-black/75 to-transparent px-1.5 pt-5 pb-1.5"
      >
        <span class="pointer-events-auto min-w-0 flex-1 truncate text-[12px] font-medium text-white" :title="label">
          {{ label }}
        </span>
        <span class="shrink-0 text-[10px] leading-4 font-medium text-white/90 tabular-nums">{{ durationLabel }}</span>
      </div>
    </template>
    <span
      v-else
      class="overflow-hidden break-words p-1.5 text-[12px] font-medium"
      :class="isSubtitle ? 'line-clamp-3 text-center leading-tight' : 'line-clamp-3 leading-snug text-[var(--compose-fg)]'"
      :style="labelStyle"
      :title="label"
    >
      {{ label }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import audioSvg from "@/assets/svg/audio.svg";

/** 素材卡片类型。subtitle 居中文案；audio 波形图 + 时长 */
type AssetCardType = "default" | "subtitle" | "audio";

/** 与合成占位时长对齐：未就绪时右下角显示 -- */
const PLACEHOLDER_DURATION_SEC = 0.1;

const props = withDefaults(
  defineProps<{
    /** 卡片上的名称或文案 */
    label: string;
    /** 卡片类型。字幕卡居中预览文案；音频卡展示波形与时长 */
    cardType?: AssetCardType;
    /** 文案颜色（#RRGGBB）；仅字幕预览使用 */
    textColor?: string;
    /** 是否加粗；仅字幕预览使用 */
    textBold?: boolean;
    /** 是否斜体；仅字幕预览使用 */
    textItalic?: boolean;
    /** 音频时长（秒）；仅音频卡右下角展示 */
    durationSec?: number;
    /** 是否正在试听；仅音频卡高亮 */
    playing?: boolean;
    /** 只读时不可拖 */
    readonly?: boolean;
  }>(),
  {
    cardType: "default",
  },
);

const emit = defineEmits<{
  /** 开始拖拽，由父级写入 dataTransfer */
  "drag-start": [event: DragEvent];
  /** 点击试听（未发生拖拽时） */
  preview: [];
}>();

/** 正在拖这张卡片 */
const dragging = ref(false);
/** 本次交互是否发生过拖拽，用于区分 click */
const didDrag = ref(false);

/** 是否为字幕预览卡 */
const isSubtitle = computed(() => props.cardType === "subtitle");
/** 是否为音频 / 音效预览卡 */
const isAudio = computed(() => props.cardType === "audio");

/** 根节点布局与拖拽态 class */
const cardClass = computed(() => [
  isSubtitle.value ? "items-center justify-center p-1.5" : isAudio.value ? "" : "items-end p-1.5",
  canDrag.value ? "cursor-grab active:cursor-grabbing" : isAudio.value ? "cursor-pointer" : "",
  dragging.value ? "opacity-60" : "",
  props.playing ? "compose-asset-card--playing" : "",
]);

/** 字幕预览字色 / 粗斜体；默认卡不注入内联样式 */
const labelStyle = computed(() => {
  if (!isSubtitle.value) return undefined;
  return {
    color: props.textColor || "var(--compose-fg)",
    fontWeight: props.textBold ? 700 : 500,
    fontStyle: props.textItalic ? "italic" : "normal",
  };
});

/** 右下角时长文案。占位或无效时为 -- */
const durationLabel = computed(() => {
  const sec = props.durationSec;
  if (sec == null || !Number.isFinite(sec) || sec <= PLACEHOLDER_DURATION_SEC) return "--";
  return formatClock(sec);
});

/** 有文案且未只读才允许拖入时间轴 */
const canDrag = computed(() => !props.readonly && Boolean(props.label.trim()));

/** 秒数显示成 m:ss 或 h:mm:ss */
function formatClock(sec: number): string {
  const whole = Math.max(0, Math.floor(sec + 1e-6));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

/** 开始拖拽 */
function onDragStart(event: DragEvent): void {
  if (!canDrag.value) {
    event.preventDefault();
    return;
  }
  didDrag.value = true;
  dragging.value = true;
  emit("drag-start", event);
}

/** 拖拽结束。短暂保留 didDrag，吞掉拖拽后的尾随 click */
function onDragEnd(): void {
  dragging.value = false;
  window.setTimeout(() => {
    didDrag.value = false;
  }, 50);
}

/** 点击试听；拖过则忽略 */
function onClick(): void {
  if (didDrag.value) return;
  if (!isAudio.value) return;
  emit("preview");
}
</script>

<style scoped lang="scss">
/* 试听中：inset 边框明暗闪烁，不挤占 72px 布局 */
.compose-asset-card--playing {
  box-shadow: inset 0 0 0 2px var(--compose-accent);
  animation: compose-asset-card-pulse 1s ease-in-out infinite;
}

@keyframes compose-asset-card-pulse {
  0%,
  100% {
    box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--compose-accent) 35%, transparent);
  }

  50% {
    box-shadow: inset 0 0 0 2px var(--compose-accent);
  }
}

@media (prefers-reduced-motion: reduce) {
  .compose-asset-card--playing {
    animation: none;
    box-shadow: inset 0 0 0 2px var(--compose-accent);
  }
}
</style>
