<template>
  <div class="flex flex-col gap-4">
    <template v-if="groups.length">
      <div v-for="group in groups" :key="group.segmentIndex" class="flex flex-col gap-2">
        <p class="text-xs font-medium text-foreground truncate" :title="group.segmentTitle">
          {{ group.segmentTitle }}
        </p>
        <div class="grid grid-cols-4 gap-1.5">
          <div
            v-for="variant in group.variants"
            :key="variant.id"
            class="flex flex-col gap-1 min-w-0"
          >
            <div
              :class="[
                'group relative aspect-[3/4] rounded-[6px] overflow-hidden bg-black border-2 transition-colors',
                canDrag(variant) ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
                variant.id === previewClipId ? 'border-primary' : 'border-transparent hover:border-primary/40',
                isOnTimeline(variant) && variant.id !== previewClipId ? 'ring-1 ring-primary/30' : '',
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

              <button
                v-if="!readonly && isRemovable(variant)"
                type="button"
                class="absolute top-1 right-1 z-20 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity hover:bg-destructive group-hover:opacity-100"
                title="从列表移除"
                @click.stop="emit('remove', variant)"
              >
                <X :size="12" />
              </button>

              <div
                v-if="showBottomBar(variant)"
                class="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/85 to-transparent px-1 pb-1 pt-3"
                @click.stop
              >
                <button
                  v-if="!isOnTimeline(variant) && !readonly && variant.url"
                  type="button"
                  class="w-full h-6 rounded-[3px] text-[10px] font-medium text-white bg-primary/90 hover:bg-primary"
                  @click="emit('add-to-timeline', variant)"
                >
                  添加到时间轴
                </button>
                <span
                  v-else
                  class="block w-full text-center text-[10px] font-medium text-white/95 py-0.5 truncate"
                >
                  {{ bottomStatusLabel(variant) }}
                </span>
              </div>
            </div>
            <el-tooltip
              :content="variant.label || '版本'"
              placement="top"
              effect="dark"
              :show-after="200"
              :disabled="!(variant.label || '').trim()"
            >
              <span class="block w-full min-w-0 text-[11px] text-muted-foreground text-center truncate px-0.5">
                {{ variant.label || "版本" }}
              </span>
            </el-tooltip>
          </div>
        </div>
      </div>
    </template>
    <p v-else class="text-xs text-muted-foreground text-center py-2">暂无历史生成片段</p>
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

const props = defineProps<{
  /** 按片段分组的历史版本 */
  groups: ComposeSegmentClipGroup[];
  /** 已在时间轴上的视频 URL 集合 */
  timelineClipUrls?: Set<string>;
  /** 当前主播放器预览中的版本 id */
  previewClipId?: string;
  /** 只读：禁止添加到时间轴 */
  readonly?: boolean;
}>();

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

/** 底部唯一状态文案：已在时间轴 > 已选中 */
function bottomStatusLabel(variant: ComposeSegmentClipVariant): string {
  if (isOnTimeline(variant)) return "已在时间轴";
  if (variant.isSelected) return "已选中";
  return "";
}

/** 是否展示底部状态条 */
function showBottomBar(variant: ComposeSegmentClipVariant): boolean {
  if (isOnTimeline(variant) || variant.isSelected) return true;
  return !props.readonly && Boolean(variant.url?.trim());
}
</script>
