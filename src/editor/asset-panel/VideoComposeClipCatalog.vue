<template>
  <div class="flex flex-col gap-4">
    <div v-if="variants.length" class="grid gap-2" style="grid-template-columns: repeat(auto-fill, 72px)">
      <div
        v-for="variant in variants"
        :key="`${variant.segmentIndex}:${variant.id}`"
        :class="[
          'group relative h-[72px] w-[72px] overflow-hidden rounded-[12px] bg-[var(--compose-surface-2)] transition-opacity duration-150',
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
          class="pointer-events-none h-full w-full object-cover"
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
          v-if="showLikeButton(variant)"
          type="button"
          class="absolute top-1.5 z-20 grid size-6 place-items-center rounded-full bg-black/55 text-[var(--compose-like)] backdrop-blur-sm transition-[right,opacity] duration-150 disabled:cursor-default disabled:opacity-100"
          :class="likeButtonClass(variant)"
          :title="likeTitle(variant)"
          :disabled="readonly"
          draggable="false"
          @click.stop="onToggleLike(variant)"
          @mousedown.stop
          @dragstart.prevent.stop
        >
          <Heart :size="16" :fill="isLiked(variant) ? 'currentColor' : 'none'" />
        </button>
        <button
          v-if="!readonly && isRemovable(variant)"
          type="button"
          class="pointer-events-none absolute top-1.5 right-1.5 z-20 flex h-5 w-5 items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-[var(--compose-danger)]"
          title="从列表移除"
          @click.stop="emit('remove', variant)"
        >
          <X :size="12" />
        </button>

        <div class="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/75 to-transparent px-2 pt-4 pb-1.5">
          <span class="block truncate text-[12px] font-medium text-white">{{ variant.label || "版本" }}</span>
        </div>
        <span
          class="pointer-events-none absolute inset-0 rounded-[12px] ring-2 ring-inset ring-[var(--compose-accent)] transition-opacity duration-150"
          :class="variant.id === previewClipId ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
        />
      </div>
    </div>
    <p v-else class="py-2 text-center text-[12px] text-[var(--compose-fg-3)]">暂无视频</p>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { Film, Heart, X } from "@lucide/vue";
import { COMPOSE_UPLOAD_CATALOG_SEGMENT_INDEX } from "@/hooks/useComposeUploadCatalog";
import { COMPOSE_SEGMENT_CLIP_DRAG_MIME, composeMediaLikeKey, type ComposeSegmentClipVariant } from "@/types/videoCompose";

const props = defineProps<{
  /** 扁平视频素材，本地上传与历史版本同一套卡片 */
  variants: ComposeSegmentClipVariant[];
  /** 已喜欢媒体的匹配键 */
  likedKeys?: Set<string>;
  /** 已在时间轴上的视频 URL 集合 */
  timelineClipUrls?: Set<string>;
  /** 当前主播放器预览中的版本 id */
  previewClipId?: string;
  /** 只读：禁止拖入时间轴，已喜欢的心只展示 */
  readonly?: boolean;
}>();

const emit = defineEmits<{
  preview: [variant: ComposeSegmentClipVariant];
  /** 从侧栏素材列表移除（不删后端 Step3 / 素材库数据） */
  remove: [variant: ComposeSegmentClipVariant];
  /** 切换喜欢 */
  "toggle-like": [variant: ComposeSegmentClipVariant];
}>();

/** 当前正在拖拽的版本 id（用于样式与抑制误触预览） */
const draggingVariantId = ref<string | null>(null);
/** 本次 pointer 序列是否已发起拖拽，避免 drag 后触发 click 预览 */
let suppressNextClick = false;

/** 是否允许从侧栏列表移除（仅上传片段） */
function isRemovable(variant: ComposeSegmentClipVariant): boolean {
  return variant.segmentIndex === COMPOSE_UPLOAD_CATALOG_SEGMENT_INDEX;
}

/** 该版本是否已标记喜欢 */
function isLiked(variant: ComposeSegmentClipVariant): boolean {
  const key = composeMediaLikeKey(variant);
  return Boolean(key && props.likedKeys?.has(key));
}

/** 只读时只展示已喜欢；可编辑时始终留出可点的爱心 */
function showLikeButton(variant: ComposeSegmentClipVariant): boolean {
  return !props.readonly || isLiked(variant);
}

/** 悬浮且可删除时，爱心让到删除按钮左侧 */
function likeButtonClass(variant: ComposeSegmentClipVariant): string[] {
  const shift = !props.readonly && isRemovable(variant) ? "right-1.5 group-hover:right-[30px]" : "right-1.5";
  if (isLiked(variant)) return [shift, "opacity-100"];
  return [shift, "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100"];
}

/** 爱心提示 */
function likeTitle(variant: ComposeSegmentClipVariant): string {
  if (props.readonly) return "已喜欢";
  return isLiked(variant) ? "取消喜欢" : "喜欢";
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

/** 喜欢不进入预览，也不开始拖拽 */
function onToggleLike(variant: ComposeSegmentClipVariant): void {
  if (props.readonly) return;
  emit("toggle-like", variant);
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
