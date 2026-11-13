<template>
  <div
    ref="dialog"
    class="export-cover"
    data-compose-export-cover
    role="dialog"
    aria-modal="true"
    :aria-labelledby="titleId"
    tabindex="-1"
    @keydown.stop
    @keyup.stop
  >
    <div class="export-panel">
      <h2 :id="titleId">{{ stageTitle }}</h2>
      <p v-if="state.notice" class="export-notice" role="status">{{ state.notice }}</p>
      <label v-if="state.stage === 'choosing'" class="export-field">
        导出分辨率
        <select v-model="resolution">
          <option v-for="choice in state.choices" :key="choice.resolution" :value="choice.resolution">
            {{ labels[choice.resolution] }} · {{ choice.width }} × {{ choice.height }}
          </option>
        </select>
      </label>
      <div v-else class="export-progress">
        <progress aria-label="视频导出进度" :value="state.percent ?? undefined" max="100" />
        <span v-if="state.percent !== null">{{ state.percent }}%</span>
      </div>
      <div class="export-actions">
        <button type="button" :disabled="state.stage === 'cancelling'" @click="emit('cancel')">取消导出</button>
        <button v-if="state.stage === 'choosing'" type="button" class="export-primary" @click="emit('select', resolution)">开始导出</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, useId, watch } from "vue";
import type { ComposeVideoExportResolution } from "@/types/videoExport";
import type { ExportCoverState } from "./useComposeVideoExport";

const props = defineProps<{ state: ExportCoverState }>();
const emit = defineEmits<{ cancel: []; select: [resolution: ComposeVideoExportResolution] }>();
const dialog = ref<HTMLElement | null>(null);
const titleId = useId();
const resolution = ref<ComposeVideoExportResolution>("source");

/** 各阶段使用明确可读的遮罩标题。 */
const stageTitle = computed(
  (): string =>
    ({
      preparing: "正在准备导出",
      choosing: "导出视频",
      rendering: "正在导出视频",
      finalizing: "正在生成 MP4",
      cancelling: "正在取消导出",
    })[props.state.stage],
);

const labels: Record<ComposeVideoExportResolution, string> = { "2k": "2K", "1080p": "1080p", "720p": "720p", source: "素材分辨率" };

/** 默认选 1080p，其次选已通过预检的首个档位。 */
watch(
  () => props.state.choices,
  (choices) => {
    resolution.value = choices.find((choice) => choice.resolution === "1080p")?.resolution ?? choices[0]?.resolution ?? "source";
  },
  { immediate: true },
);

onMounted(() => dialog.value?.focus());
</script>

<style scoped>
.export-cover {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  padding: 16px;
  background: color-mix(in srgb, var(--compose-surface) 62%, transparent);
  backdrop-filter: blur(12px);
  outline: none;
}

.export-panel {
  display: grid;
  gap: 16px;
  width: min(100%, 360px);
  padding: 24px;
  border-radius: 16px;
  background: var(--compose-surface);
  color: var(--compose-fg);
}

.export-panel h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.3;
}

.export-notice {
  margin: 0;
  color: var(--compose-fg-2);
  font-size: 14px;
}

.export-field {
  display: grid;
  gap: 8px;
  font-size: 14px;
}

.export-field select,
.export-actions button {
  min-height: 40px;
  padding: 0 16px;
  border: 0;
  border-radius: 8px;
  background: var(--compose-surface-3);
  color: var(--compose-fg);
}

.export-progress,
.export-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.export-progress progress {
  width: 100%;
  min-width: 0;
  accent-color: var(--compose-accent);
}

.export-progress span {
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}

.export-actions {
  justify-content: flex-end;
}

.export-actions button {
  white-space: nowrap;
  cursor: pointer;
}

.export-actions button:disabled {
  cursor: default;
  color: var(--compose-fg-3);
}

.export-actions .export-primary {
  background: var(--compose-accent);
  color: white;
}
</style>
