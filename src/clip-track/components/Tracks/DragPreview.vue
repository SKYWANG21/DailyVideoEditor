<template>
  <div class="drag-preview" :style="previewStyle">
    <div class="drag-preview__inner" />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useDragStore } from "../../stores/drag";
import { useScaleStore } from "../../stores/scale";
import { useClipTrackPinia } from "../../stores/clipTrackPinia";
import type { Track } from "../../types";

// Props
interface Props {
  track: Track;
}

const props = defineProps<Props>();

const pinia = useClipTrackPinia();
const dragStore = useDragStore(pinia);
const scaleStore = useScaleStore(pinia);

// 计算预览框样式
const previewStyle = computed(() => {
  const preview = dragStore.previewPosition;
  if (!preview.visible) return {};

  const left = preview.startTime * scaleStore.actualPixelsPerSecond;
  const width = (preview.endTime - preview.startTime) * scaleStore.actualPixelsPerSecond;

  // 计算高度
  let height = 32;
  if (props.track.isMain) {
    height = 64;
  } else if (preview.clipType === "video" || props.track.type === "video") {
    height = 48;
  }

  // 计算垂直位置（相对于轨道区域）
  let top = 8;

  // 基础样式
  const style: Record<string, any> = {
    left: `${left}px`,
    width: `${width}px`,
    height: `${height}px`,
    top: `${top}px`,
  };

  return style;
});
</script>

<style scoped>
.drag-preview {
  position: absolute;
  border: 2px dashed var(--color-primary);
  background: hsla(var(--theme-hue), var(--theme-saturation), var(--theme-lightness), 0.15);
  border-radius: var(--radius-sm);
  pointer-events: none;
  z-index: 100;
  box-sizing: border-box;
}

.drag-preview__inner {
  width: 100%;
  height: 100%;
}
</style>
