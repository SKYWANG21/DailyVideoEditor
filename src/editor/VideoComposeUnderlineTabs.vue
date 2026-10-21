<template>
  <div class="flex min-w-0 gap-4 overflow-x-auto" role="tablist">
    <button
      v-for="(tab, index) in tabs"
      :key="`${tab}-${index}`"
      type="button"
      role="tab"
      class="relative shrink-0 pb-2 text-[13px] font-medium transition-colors duration-150"
      :class="index === modelValue ? 'text-[var(--compose-fg)]' : 'text-[var(--compose-fg-3)] hover:text-[var(--compose-fg-2)]'"
      :aria-selected="index === modelValue"
      @click="emit('update:modelValue', index)"
    >
      {{ tab }}
      <span v-if="index === modelValue" class="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-[var(--compose-accent)]" />
    </button>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  /** 页签文案，顺序即下标 */
  tabs: string[];
  /** 当前页签下标 */
  modelValue: number;
}>();

const emit = defineEmits<{
  "update:modelValue": [index: number];
}>();
</script>

<style scoped lang="scss">
[role="tablist"] {
  scrollbar-width: none;
}

[role="tablist"]::-webkit-scrollbar {
  display: none;
}
</style>
