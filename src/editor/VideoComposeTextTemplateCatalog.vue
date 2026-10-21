<template>
  <div>
    <p v-if="loading" class="py-2 text-center text-[12px] text-[var(--compose-fg-3)]">加载中...</p>
    <p v-else-if="loadError" class="py-2 text-center text-[12px] text-[var(--compose-fg-3)]">文字模板加载失败</p>
    <div v-else class="grid gap-2" style="grid-template-columns: repeat(auto-fill, 72px)">
      <div v-for="item in catalog" :key="item.url || item.id" class="group relative h-[72px] w-[72px] overflow-hidden rounded-[12px] bg-[var(--compose-surface-2)]">
        <img :src="item.url" :alt="item.name" class="pointer-events-none h-full w-full object-contain p-1" />
        <div class="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/75 to-transparent px-2 pt-5 pb-1.5">
          <button
            v-if="!readonly"
            type="button"
            class="pointer-events-auto mb-1 h-6 w-full rounded-[4px] bg-white text-[10px] font-semibold text-[#0E0E11]"
            @click="emit('add-to-timeline', item)"
          >
            添加到时间轴
          </button>
          <span class="block truncate text-[12px] font-medium text-white">{{ item.name }}</span>
        </div>
      </div>
      <p v-if="!catalog.length" class="col-span-full py-2 text-center text-[12px] text-[var(--compose-fg-3)]">暂无文字模板</p>
    </div>
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
