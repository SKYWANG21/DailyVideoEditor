<template>
  <div class="flex flex-col gap-3">
    <div class="flex items-center gap-3">
      <span class="compose-transform__label">位置</span>
      <label class="compose-transform__field">
        <span>X</span>
        <input disabled value="0" />
      </label>
      <label class="compose-transform__field">
        <span>Y</span>
        <input disabled value="0" />
      </label>
    </div>
    <div class="flex items-center gap-3">
      <span class="compose-transform__label">尺寸</span>
      <label class="compose-transform__field">
        <span>W</span>
        <input disabled :value="sizeText(width)" />
      </label>
      <label class="compose-transform__field">
        <span>H</span>
        <input disabled :value="sizeText(height)" />
      </label>
    </div>
    <div class="flex items-center gap-3">
      <span class="compose-transform__label">缩放</span>
      <label class="compose-transform__field compose-transform__field--solo">
        <input disabled value="100" />
        <em>%</em>
      </label>
    </div>
    <div class="flex items-center gap-3">
      <span class="compose-transform__label">旋转</span>
      <label class="compose-transform__field compose-transform__field--solo">
        <input disabled value="0" />
        <em>°</em>
      </label>
    </div>
    <div class="flex items-center gap-3">
      <span class="compose-transform__label">不透明度</span>
      <div class="h-2 min-w-0 flex-1 rounded-full bg-[var(--compose-surface-3)]">
        <div class="h-full w-full rounded-full bg-[var(--compose-fg-3)]" />
      </div>
      <span class="w-8 shrink-0 text-right text-[12px] text-[var(--compose-fg-3)] tabular-nums">100</span>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  /** 当前画面宽，只展示，不写回 */
  width: number;
  /** 当前画面高，只展示，不写回 */
  height: number;
}>();

/** 没有有效画面尺寸时显示 0 */
function sizeText(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return String(Math.round(value));
}
</script>

<style scoped lang="scss">
.compose-transform__label {
  width: 56px;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--compose-fg-2);
}

.compose-transform__field {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 4px;

  span,
  em {
    flex-shrink: 0;
    font-size: 12px;
    font-style: normal;
    color: var(--compose-fg-3);
  }

  span {
    width: 16px;
  }

  input {
    height: 40px;
    min-width: 0;
    flex: 1;
    border-radius: 8px;
    background: var(--compose-surface-3);
    padding: 0 8px;
    font-size: 14px;
    font-variant-numeric: tabular-nums;
    color: var(--compose-fg-3);
    outline: none;
  }
}
</style>
