<template>
  <div class="flex flex-wrap gap-1.5">
    <p v-if="loading" class="w-full py-2 text-center text-xs text-muted-foreground">加载中...</p>
    <p v-else-if="loadError" class="w-full py-2 text-center text-xs text-muted-foreground">文字模板加载失败</p>
    <template v-else>
      <div v-for="item in catalog" :key="item.url || item.id" class="flex w-[calc((100%-18px)/4)] min-w-0 flex-col gap-1">
        <div
          class="group relative aspect-square overflow-hidden rounded-[6px] border-2 border-transparent bg-muted/40 transition-colors hover:border-primary/40"
        >
          <img :src="item.url" :alt="item.name" class="pointer-events-none h-full w-full object-contain p-1" />
          <div
            v-if="!readonly"
            class="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/85 to-transparent px-1 pb-1 pt-3 opacity-0 transition-opacity group-hover:opacity-100"
            @click.stop
          >
            <button
              type="button"
              class="h-6 w-full rounded-[3px] bg-primary/90 text-[10px] font-medium text-white hover:bg-primary"
              @click="emit('add-to-timeline', item)"
            >
              添加到时间轴
            </button>
          </div>
        </div>
      </div>
      <p v-if="!catalog.length" class="w-full py-2 text-center text-xs text-muted-foreground">暂无文字模板</p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { loadTextTemplateCatalog, textTemplateCatalog, type TextTemplateItem } from "./textTemplateCatalog";

defineProps<{
  /** 只读：隐藏添加到时间轴 */
  readonly?: boolean;
}>();

const emit = defineEmits<{
  "add-to-timeline": [item: TextTemplateItem];
}>();

/** 素材库「系统预设 / 文字模板」中的剪辑素材列表 */
const catalog = textTemplateCatalog;
/** 是否正在从素材库拉取 */
const loading = ref(false);
/** 拉取失败 */
const loadError = ref(false);

onMounted(async () => {
  if (!catalog.value.length) {
    loading.value = true;
  }
  loadError.value = false;
  try {
    await loadTextTemplateCatalog();
  } catch {
    if (!catalog.value.length) {
      loadError.value = true;
    }
  } finally {
    loading.value = false;
  }
});
</script>
