<template>
  <div class="tracks" ref="tracksRef">
    <!-- 空状态提示 -->
    <div v-if="sortedTracks.length === 0" class="tracks__empty">
      <div class="tracks__empty-content">
        <span class="tracks__empty-icon">🎬</span>
        <span class="tracks__empty-text">{{ locale?.emptyTip || "拖拽媒体文件到此处添加" }}</span>
      </div>
    </div>

    <!-- 轨道滚动容器 -->
    <div v-else class="tracks__scroll-container" ref="scrollContainerRef" @scroll="handleScrollContainerScroll">
      <!-- 轨道表格 -->
      <div class="tracks__table" ref="tableRef">
        <!-- 轨道列表 -->
        <div
          v-for="(track, index) in sortedTracks"
          :key="track.id"
          class="tracks__track"
          :class="{
            'tracks__track--locked': track.locked,
            'tracks__track--hidden': !track.visible,
          }"
          :data-track-id="track.id"
        >
          <!-- 轨道操作栏 -->
          <div class="tracks__track-control-cell" :ref="(el) => setControlCellRef(el, index)">
            <TrackControl :track="track" :locale="locale" @update="handleTrackUpdate" @delete="handleTrackDelete">
              <slot name="track-control" :track="track" />
            </TrackControl>
          </div>

          <!-- 轨道区域 -->
          <div class="tracks__track-area-cell">
            <TrackArea
              :track="track"
              :scroll-left="scrollLeft"
              @scroll="handleAreaScroll"
              @context-menu="handleContextMenu"
              @track-context-menu="handleTrackContextMenu"
              @add-transition="handleAddTransition"
              @drop-media="handleDropMedia"
              @seek="handleSeek"
              @clip:dblclick="(clip, time) => emit('clip:dblclick', clip, time)"
            >
              <template #clip-content="slotProps">
                <slot name="clip-content" v-bind="slotProps" />
              </template>
            </TrackArea>
          </div>
        </div>
        <div v-if="seamLineStyle" class="tracks__seam-line" :style="seamLineStyle" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, inject, provide, onMounted, onUnmounted, nextTick, watch } from "vue";
import { useTracksStore } from "../../stores/tracks";
import { useHistoryStore } from "../../stores/history";
import { useDragStore } from "../../stores/drag";
import { useClipTrackPinia } from "../../stores/clipTrackPinia";
import TrackControl from "./TrackControl.vue";
import TrackArea from "./TrackArea.vue";
import type { Track } from "../../types";
import type { LocaleConfig } from "../../types/config";

// Props
interface Props {
  scrollLeft?: number;
  locale?: LocaleConfig;
}

const props = withDefaults(defineProps<Props>(), {
  scrollLeft: 0,
  locale: () => ({}),
});

// Emits
const emit = defineEmits<{
  scroll: [left: number];
  contextMenu: [clip: any, event: MouseEvent];
  trackContextMenu: [track: Track, time: number, event: MouseEvent];
  trackDelete: [trackId: string];
  addTransition: [beforeClipId: string, afterClipId: string];
  dropMedia: [mediaData: any, trackId: string, startTime: number];
  "update:trackControlWidth": [width: number];
  seek: [time: number];
  "clip:dblclick": [clip: any, time: number];
}>();

// Stores
const pinia = useClipTrackPinia();
const tracksStore = useTracksStore(pinia);
const historyStore = useHistoryStore(pinia);
const dragStore = useDragStore(pinia);

// Inject config from parent
const config = inject<any>("config", {});

// Refs
const tracksRef = ref<HTMLElement>();
const scrollContainerRef = ref<HTMLElement>();
const tableRef = ref<HTMLElement>();
const scrollLeft = ref(props.scrollLeft);
const isScrollingSelf = ref(false);
const firstControlCell = ref<HTMLElement | null>(null);

// Computed
const sortedTracks = computed(() => tracksStore.sortedTracks);

/** 拖到轨道缝上时，横贯轨道区的高亮线 */
const seamLineStyle = computed((): { top: string; left: string } | null => {
  const preview = dragStore.previewPosition;
  if (!dragStore.isDragging || !preview.needNewTrack || preview.insertIndex < 0) return null;
  const table = tableRef.value;
  if (!table) return null;
  const rows = table.querySelectorAll<HTMLElement>(".tracks__track");
  if (!rows.length) return null;
  const index = preview.insertIndex;
  const tableTop = table.getBoundingClientRect().top;
  const edge =
    index <= 0
      ? rows[0].getBoundingClientRect().top
      : index >= rows.length
        ? rows[rows.length - 1].getBoundingClientRect().bottom
        : rows[index].getBoundingClientRect().top;
  const control = firstControlCell.value?.getBoundingClientRect().width ?? 0;
  return { top: `${edge - tableTop}px`, left: `${control}px` };
});

// 控制栏宽度
const trackControlWidth = ref(200);

// Watchers
watch(
  () => props.scrollLeft,
  (newVal) => {
    if (!isScrollingSelf.value && newVal !== scrollLeft.value) {
      scrollLeft.value = newVal;
    }
  },
);

// 监听轨道变化，当从空变为有轨道时设置 ResizeObserver
watch(
  sortedTracks,
  (newTracks, oldTracks) => {
    const wasEmpty = !oldTracks || oldTracks.length === 0;
    const hasTracksNow = newTracks && newTracks.length > 0;

    if (wasEmpty && hasTracksNow) {
      // 从空变为有轨道，需要重新设置 ResizeObserver
      nextTick(() => {
        if (tableRef.value && !resizeObserver) {
          resizeObserver = new ResizeObserver(() => {
            measureControlWidth();
          });
          resizeObserver.observe(tableRef.value);
        }
        // 立即测量一次
        measureControlWidth();
        bindEdgeScroll();
      });
    }
  },
  { immediate: true },
);

// 设置第一个控制单元格的 ref
function setControlCellRef(el: any, index: number) {
  if (index === 0) {
    firstControlCell.value = el as HTMLElement;
  }
}

// 测量控制栏宽度
let resizeObserver: ResizeObserver | null = null;

// 边缘滚动回调 - 当拖拽时边缘滚动触发，更新 scrollLeft 状态
function handleEdgeScroll(left: number) {
  if (!isScrollingSelf.value) {
    isScrollingSelf.value = true;
    scrollLeft.value = left;
    emit("scroll", left);
    requestAnimationFrame(() => {
      isScrollingSelf.value = false;
    });
  }
}

onMounted(() => {
  if (tableRef.value) {
    resizeObserver = new ResizeObserver(() => {
      measureControlWidth();
    });
    resizeObserver.observe(tableRef.value);
  }

  nextTick(() => {
    bindEdgeScroll();
  });

  // 初始滚动到主轨道
  nextTick(() => {
    scrollToMainTrack();
  });
});

onUnmounted(() => {
  if (resizeObserver) {
    resizeObserver.disconnect();
  }
});

/** 贴边拖拽滚动第一条轨道区，其它轨道靠 scrollLeft 同步 */
function bindEdgeScroll() {
  const area = tracksRef.value?.querySelector(".track-area");
  dragStore.setScrollContainers(tracksRef.value || null, area instanceof HTMLElement ? area : null, handleEdgeScroll);
}

function measureControlWidth() {
  if (firstControlCell.value) {
    const width = firstControlCell.value.getBoundingClientRect().width;
    trackControlWidth.value = width;
    emit("update:trackControlWidth", width);
  }
}

// 滚动到主轨道
function scrollToMainTrack() {
  const mainTrack = tracksStore.mainTrack;
  if (!mainTrack || !tableRef.value) return;

  const trackEl = tableRef.value.querySelector(`[data-track-id="${mainTrack.id}"]`);
  if (trackEl) {
    trackEl.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

// 监听主轨道变化，自动滚动
watch(
  () => tracksStore.mainTrack,
  (newVal) => {
    if (newVal) {
      nextTick(() => {
        scrollToMainTrack();
      });
    }
  },
);

// 处理滚动容器滚动（垂直滚动）
function handleScrollContainerScroll() {
  // 竖向滚动不改横向位置
}

/** 某条轨道横向滚动后，同步到刻度尺和其它轨道 */
function handleAreaScroll(left: number) {
  if (!isScrollingSelf.value) {
    isScrollingSelf.value = true;
    scrollLeft.value = left;
    emit("scroll", left);
    requestAnimationFrame(() => {
      isScrollingSelf.value = false;
    });
  }
}

// 处理轨道更新
function handleTrackUpdate(trackId: string, updates: Partial<Track>) {
  tracksStore.updateTrack(trackId, updates);
  historyStore.pushSnapshot("更新轨道");
}

// 处理轨道删除
function handleTrackDelete(trackId: string) {
  const track = tracksStore.tracks.find((t) => t.id === trackId);
  if (track?.isMain) {
    alert("主轨道不能删除");
    return;
  }

  tracksStore.removeTrack(trackId);
  historyStore.pushSnapshot("删除轨道");
  emit("trackDelete", trackId);
}

// 处理 Clip 右键菜单
function handleContextMenu(clip: any, event: MouseEvent) {
  emit("contextMenu", clip, event);
}

// 处理轨道空白区域右键菜单
function handleTrackContextMenu(track: Track, time: number, event: MouseEvent) {
  emit("trackContextMenu", track, time, event);
}

// 处理添加转场
function handleAddTransition(beforeClipId: string, afterClipId: string) {
  emit("addTransition", beforeClipId, afterClipId);
}

// 处理拖放媒体
function handleDropMedia(mediaData: any, trackId: string, startTime: number) {
  emit("dropMedia", mediaData, trackId, startTime);
}

// 处理 seek 事件
function handleSeek(time: number) {
  emit("seek", time);
}

// 提供配置给子组件
provide("config", config);
</script>

<style scoped>
.tracks {
  flex: 1;
  overflow: hidden;
  background: var(--color-bg-medium);
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  transition: background-color var(--transition-base);
  position: relative;
}

.tracks__scroll-container {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 0;
}

.tracks__table {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
}

.tracks__seam-line {
  position: absolute;
  right: 0;
  z-index: 40;
  height: 2px;
  margin-top: -1px;
  border-radius: 999px;
  background: var(--color-primary);
  box-shadow: 0 0 8px var(--color-primary);
  pointer-events: none;
}

.tracks__track {
  display: flex;
  align-items: stretch;
  width: 100%;
  min-height: 48px;
  border-bottom: 1px solid var(--color-border);
  transition: all var(--transition-fast);
}

.tracks__track:hover {
  background: hsla(var(--theme-hue), var(--theme-saturation), var(--theme-lightness), 0.02);
}

.tracks__track--locked {
  opacity: 0.5;
  background: repeating-linear-gradient(45deg, transparent, transparent 10px, var(--color-bg-light) 10px, var(--color-bg-light) 11px);
}

.tracks__track--hidden {
  opacity: 0.25;
}

.tracks__track-control-cell {
  display: flex;
  flex: 0 0 auto;
  align-items: stretch;
  white-space: nowrap;
  border-bottom: 1px solid var(--color-border);
  background-color: transparent;
  /* 确保 track-control 在拖拽 clip 之上 */
  position: relative;
  z-index: 200;
}

.tracks__track-area-cell {
  display: flex;
  flex: 1 1 auto;
  align-items: stretch;
  min-width: 0;
  border-bottom: 1px solid var(--color-border);
}

/* 轨道区跟着行高拉伸，并允许内部横向滚动 */
.tracks__track-area-cell :deep(.track-area) {
  flex: 1 1 auto;
  align-self: stretch;
  min-width: 0;
  height: auto;
  min-height: 48px;
}

/* 轨道头在文档流里撑满行高，避免绝对定位把列宽挤没 */
.tracks__track-control-cell :deep(.track-control) {
  position: static;
  flex: 0 0 200px;
  align-self: stretch;
  width: 200px;
  height: auto;
  min-height: 48px;
}

/* 空状态提示 */
.tracks__empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
  background: var(--color-bg-dark);
  border: 2px dashed var(--color-border);
  border-radius: var(--radius-lg);
  margin: 16px;
}

.tracks__empty-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--color-text-muted);
}

.tracks__empty-icon {
  font-size: 48px;
  opacity: 0.5;
}

.tracks__empty-text {
  font-size: 14px;
  font-weight: 500;
}
</style>
