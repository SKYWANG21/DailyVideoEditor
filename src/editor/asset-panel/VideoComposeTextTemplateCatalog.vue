<template>
  <div>
    <div v-if="showGrid" class="grid gap-2" style="grid-template-columns: repeat(auto-fill, 72px)">
      <!-- 与卡片同网格：上传按钮等前置操作 -->
      <slot name="leading" />
      <div
        v-for="item in items"
        :key="item.id"
        class="group relative h-[72px] w-[72px] overflow-hidden rounded-[12px] bg-[var(--compose-surface-2)]"
        :class="[canDrag ? 'cursor-grab active:cursor-grabbing' : '', draggingId === item.id ? 'opacity-60' : '']"
        :draggable="canDrag"
        @dragstart="onDragStart($event, item)"
        @dragend="draggingId = ''"
      >
        <img :src="item.url" :alt="item.name" class="pointer-events-none h-full w-full object-contain p-1" />
        <div class="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/75 to-transparent px-2 pt-5 pb-1.5">
          <span class="block truncate text-[12px] font-medium text-white">{{ item.name }}</span>
        </div>
      </div>
    </div>
    <p v-if="!items.length" class="py-2 text-center text-[12px] text-[var(--compose-fg-3)]">暂无文字模板</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, useSlots } from "vue";
import { COMPOSE_TEXT_TEMPLATE_DRAG_MIME, type ComposeTextTemplateDrag } from "@/types/videoCompose";
import type { TextTemplateItem } from "../shared/textTemplateCatalog";

const props = defineProps<{
  /** 父组件传入的花字列表 */
  items?: TextTemplateItem[];
  /** 只读时不可拖 */
  readonly?: boolean;
}>();

/** 正在拖的模板 id */
const draggingId = ref("");

const slots = useSlots();

/** 列表缺省为空 */
const items = computed(() => props.items ?? []);

/** 有模板或前置操作时展示网格 */
const showGrid = computed(() => items.value.length > 0 || Boolean(slots.leading));

/** 未只读才允许拖入贴图轨 */
const canDrag = computed(() => !props.readonly);

/** 花字开始拖入时间轴。不带 SVG 原文 */
function onDragStart(event: DragEvent, item: TextTemplateItem): void {
  if (!canDrag.value || !event.dataTransfer) {
    event.preventDefault();
    return;
  }
  draggingId.value = item.id;
  const payload: ComposeTextTemplateDrag = {
    id: item.id,
    name: item.name,
    defaultText: item.defaultText,
    defaultFontSize: item.defaultFontSize,
    defaultColor: item.defaultColor,
    sourceUrl: item.sourceUrl,
  };
  event.dataTransfer.setData(COMPOSE_TEXT_TEMPLATE_DRAG_MIME, JSON.stringify(payload));
  event.dataTransfer.effectAllowed = "copy";
}
</script>
