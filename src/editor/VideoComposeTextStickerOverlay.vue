<template>
  <div
    ref="layerRef"
    class="pointer-events-none absolute inset-0 z-[15]"
  >
    <div
      v-for="clip in clips"
      :key="clip.id"
      v-show="isClipVisible(clip.id)"
      class="text-sticker select-none"
      :class="{ 'text-sticker--enter': isEntering(clip.id) }"
      :style="isClipVisible(clip.id) ? boxStyle(clip) : undefined"
      @mousedown="onBoxMouseDown($event, clip)"
    >
      <div
        class="pointer-events-none h-full w-full"
        :ref="(el) => setSvgHost(clip.id, el)"
        v-html="svgHtmlById[clip.id] || ''"
      />
      <template v-if="clip.id === selectedId && isClipVisible(clip.id)">
        <div
          class="absolute left-1/2 z-10 h-3 w-3 -translate-x-1/2 cursor-grab rounded-full border-2 border-white"
          :style="{ top: '-22px', background: accent }"
          @mousedown.stop="startDrag($event, clip, 'rotate')"
        />
        <div
          class="pointer-events-none absolute left-1/2 w-px -translate-x-1/2"
          :style="{ top: '-16px', height: '16px', background: accent }"
        />
        <div
          v-for="handle in cornerHandles"
          :key="handle.mode"
          class="absolute z-10 cursor-nwse-resize rounded-[1px] border border-white"
          :style="handleStyle(handle)"
          @mousedown.stop="startDrag($event, clip, handle.mode)"
        />
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { RectConfig } from "@/clip-track";
import type { ComposeTextOverlayClip } from "@/types/videoCompose";
import { useVideoComposeTextStickerOverlay, type TextStickerDragMode } from "@/hooks/useVideoComposeTextStickerOverlay";

const props = defineProps<{
  /** 全部贴图 clip（节点常驻，按时间 v-show） */
  clips: ComposeTextOverlayClip[];
  /** 当前预览时间（秒） */
  currentTime: number;
  /** 时间轴选中的 TextClip id */
  selectedId?: string | null;
  /** 视频原始宽度 */
  videoWidth: number;
  /** 视频原始高度 */
  videoHeight: number;
}>();

const emit = defineEmits<{
  "update:rect": [payload: { clipId: string; rect: RectConfig }];
  select: [clipId: string];
}>();

const layerRef = ref<HTMLElement | null>(null);

const clipsRef = computed(() => props.clips);
const currentTimeRef = computed(() => props.currentTime);
const selectedIdRef = computed(() => props.selectedId);
const videoWidthRef = computed(() => props.videoWidth);
const videoHeightRef = computed(() => props.videoHeight);

const { isClipVisible, isEntering, setSvgHost, svgHtmlById, boxStyle, startDrag, handleSize, accent } = useVideoComposeTextStickerOverlay({
  layerEl: layerRef,
  videoWidth: videoWidthRef,
  videoHeight: videoHeightRef,
  clips: clipsRef,
  currentTime: currentTimeRef,
  selectedId: selectedIdRef,
  onCommitRect: (clipId, rect) => emit("update:rect", { clipId, rect }),
});

/** 四角缩放手柄 */
const cornerHandles: Array<{ mode: Extract<TextStickerDragMode, "nw" | "ne" | "sw" | "se">; cursor: string }> = [
  { mode: "nw", cursor: "nwse-resize" },
  { mode: "ne", cursor: "nesw-resize" },
  { mode: "sw", cursor: "nesw-resize" },
  { mode: "se", cursor: "nwse-resize" },
];

function handleStyle(handle: (typeof cornerHandles)[number]): Record<string, string> {
  const size = `${handleSize}px`;
  const offset = `-${handleSize / 2}px`;
  const pos: Record<string, string> = {
    width: size,
    height: size,
    background: accent,
    cursor: handle.cursor,
  };
  if (handle.mode.includes("n")) pos.top = offset;
  else pos.bottom = offset;
  if (handle.mode.includes("w")) pos.left = offset;
  else pos.right = offset;
  return pos;
}

/** 点选贴图；已选中则进入平移 */
function onBoxMouseDown(e: MouseEvent, clip: ComposeTextOverlayClip): void {
  if (e.button !== 0) return;
  if (clip.id !== props.selectedId) {
    emit("select", clip.id);
    return;
  }
  startDrag(e, clip, "move");
}
</script>
