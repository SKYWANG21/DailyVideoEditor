<template>
  <div class="flex flex-col gap-4">
    <template v-if="groups.length">
      <div v-for="group in groups" :key="group.segmentIndex" class="flex flex-col gap-2">
        <p class="truncate text-[12px] font-medium text-[var(--compose-fg)]" :title="group.segmentTitle">
          {{ group.segmentTitle }}
        </p>
        <div class="grid gap-2" :style="{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }">
          <div
            v-for="variant in group.variants"
            :key="variant.id"
            class="flex flex-col gap-1 min-w-0"
          >
            <div
              :class="[
                'group relative aspect-square overflow-hidden rounded-[12px] bg-[var(--compose-surface-2)] transition-opacity duration-150',
                canDrag(variant) ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
                draggingVariantId === variant.id ? 'opacity-60' : '',
              ]"
              :draggable="canDrag(variant)"
              @click="onCardClick(variant)"
              @dragstart="onVariantDragStart($event, variant)"
              @dragend="onVariantDragEnd"
            >
              <video
                v-if="variant.url"
                :src="variant.url"
                class="w-full h-full object-cover pointer-events-none"
                muted
                playsinline
                preload="metadata"
              />
              <div v-else class="absolute inset-0 flex items-center justify-center text-white/30">
                <Film :size="20" />
              </div>

              <span
                v-if="isOnTimeline(variant)"
                class="absolute top-1.5 left-1.5 z-20 rounded-[4px] bg-[var(--compose-success)] px-1.5 py-0.5 text-[10px] font-medium text-white"
              >
                已使用
              </span>
              <span
                v-else-if="variant.isSelected"
                class="absolute top-1.5 left-1.5 z-20 rounded-[4px] bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white"
              >
                已选中
              </span>
              <button
                v-if="!readonly && isRemovable(variant)"
                type="button"
                class="absolute top-1.5 right-1.5 z-20 flex h-5 w-5 items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition-opacity duration-150 hover:bg-[var(--compose-danger)] group-hover:opacity-100"
                title="从列表移除"
                @click.stop="emit('remove', variant)"
              >
                <X :size="12" />
              </button>

              <div class="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/75 to-transparent px-2 pt-5 pb-1.5">
                <button
                  v-if="!isOnTimeline(variant) && !readonly && variant.url"
                  type="button"
                  class="pointer-events-auto mb-1 h-6 w-full rounded-[4px] bg-white text-[10px] font-semibold text-[#0E0E11]"
                  @click.stop="emit('add-to-timeline', variant)"
                >
                  添加到时间轴
                </button>
                <span class="block truncate text-[12px] font-medium text-white">{{ variant.label || "版本" }}</span>
              </div>
              <span
                class="pointer-events-none absolute inset-0 rounded-[12px] ring-2 ring-inset ring-[var(--compose-accent)] transition-opacity duration-150"
                :class="variant.id === previewClipId ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
              />
            </div>
          </div>
        </div>
      </div>
    </template>
    <p v-else class="py-2 text-center text-[12px] text-[var(--compose-fg-3)]">暂无历史生成片段</p>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { Film, X } from "@lucide/vue";
import {
  COMPOSE_SEGMENT_CLIP_DRAG_MIME,
  type ComposeSegmentClipGroup,
  type ComposeSegmentClipVariant,
} from "@/types/videoCompose";
import { COMPOSE_UPLOAD_CATALOG_SEGMENT_INDEX } from "@/hooks/useComposeUploadCatalog";

const props = withDefaults(
  defineProps<{
    /** 按片段分组的历史版本 */
    groups: ComposeSegmentClipGroup[];
    /** 一行几列。收起素材栏时为 1 */
    columns?: number;
    /** 已在时间轴上的视频 URL 集合 */
    timelineClipUrls?: Set<string>;
    /** 当前主播放器预览中的版本 id */
    previewClipId?: string;
    /** 只读：禁止添加到时间轴 */
    readonly?: boolean;
  }>(),
  { columns: 4 },
);

const emit = defineEmits<{
  preview: [variant: ComposeSegmentClipVariant];
  "add-to-timeline": [variant: ComposeSegmentClipVariant];
  /** 从侧栏素材列表移除（不删后端 Step3 / 素材库数据） */
  remove: [variant: ComposeSegmentClipVariant];
}>();

/** 当前正在拖拽的版本 id（用于样式与抑制误触预览） */
const draggingVariantId = ref<string | null>(null);
/** 本次 pointer 序列是否已发起拖拽，避免 drag 后触发 click 预览 */
let suppressNextClick = false;

/** 是否允许从侧栏列表移除（仅上传片段） */
function isRemovable(variant: ComposeSegmentClipVariant): boolean {
  return variant.segmentIndex === COMPOSE_UPLOAD_CATALOG_SEGMENT_INDEX;
}

/** 是否允许拖入时间轴 */
function canDrag(variant: ComposeSegmentClipVariant): boolean {
  return !props.readonly && Boolean(variant.url?.trim()) && !isOnTimeline(variant);
}

/** 卡片单击：拖拽结束后不触发预览 */
function onCardClick(variant: ComposeSegmentClipVariant): void {
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  emit("preview", variant);
}

/** 开始拖拽：写入素材库版本 payload */
function onVariantDragStart(event: DragEvent, variant: ComposeSegmentClipVariant): void {
  if (!canDrag(variant) || !event.dataTransfer) return;
  suppressNextClick = true;
  draggingVariantId.value = variant.id;
  event.dataTransfer.setData(COMPOSE_SEGMENT_CLIP_DRAG_MIME, JSON.stringify(variant));
  event.dataTransfer.effectAllowed = "copy";
}

/** 结束拖拽 */
function onVariantDragEnd(): void {
  draggingVariantId.value = null;
}

/** 判断该版本是否已在时间轴（按 URL 去重） */
function isOnTimeline(variant: ComposeSegmentClipVariant): boolean {
  if (!variant.url?.trim() || !props.timelineClipUrls?.size) return false;
  return props.timelineClipUrls.has(variant.url.trim());
}
</script>
