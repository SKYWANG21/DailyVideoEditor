<template>
  <div
    class="relative flex h-[72px] w-[72px] items-end overflow-hidden rounded-[12px] bg-[var(--compose-surface-2)] p-1.5"
    :class="[canDrag ? 'cursor-grab active:cursor-grabbing' : '', dragging ? 'opacity-60' : '']"
    :draggable="canDrag"
    @dragstart="onDragStart"
    @dragend="dragging = false"
  >
    <span class="line-clamp-3 text-[12px] font-medium leading-snug text-[var(--compose-fg)]">{{ label }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{
  /** 卡片上的名称或文案 */
  label: string;
  /** 只读时不可拖 */
  readonly?: boolean;
}>();

const emit = defineEmits<{
  /** 开始拖拽，由父级写入 dataTransfer */
  "drag-start": [event: DragEvent];
}>();

/** 正在拖这张卡片 */
const dragging = ref(false);

/** 有文案且未只读才允许拖入时间轴 */
const canDrag = computed(() => !props.readonly && Boolean(props.label.trim()));

/** 开始拖拽 */
function onDragStart(event: DragEvent): void {
  if (!canDrag.value) {
    event.preventDefault();
    return;
  }
  dragging.value = true;
  emit("drag-start", event);
}
</script>
