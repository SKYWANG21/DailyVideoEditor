<template>
  <div class="flex flex-col gap-3">
    <div class="flex items-center gap-3">
      <span class="compose-transform__label">画幅</span>
      <select class="compose-transform__input" :value="aspect" @change="onAspectChange">
        <option v-for="option in aspectOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
    </div>
    <div class="flex items-center gap-3">
      <span class="compose-transform__label">位置</span>
      <label class="compose-transform__field">
        <span>X</span>
        <input :value="textOf(frame.x)" inputmode="decimal" :disabled="!canEdit" @change="onNumberChange('x', $event, -99999, 99999)" />
      </label>
      <label class="compose-transform__field">
        <span>Y</span>
        <input :value="textOf(frame.y)" inputmode="decimal" :disabled="!canEdit" @change="onNumberChange('y', $event, -99999, 99999)" />
      </label>
    </div>
    <div class="flex items-center gap-3">
      <span class="compose-transform__label">尺寸</span>
      <label class="compose-transform__field">
        <span>W</span>
        <input :value="textOf(frame.w)" inputmode="decimal" :disabled="!canEdit" @change="onNumberChange('w', $event, 1, 100000)" />
      </label>
      <label class="compose-transform__field">
        <span>H</span>
        <input :value="textOf(frame.h)" inputmode="decimal" :disabled="!canEdit" @change="onNumberChange('h', $event, 1, 100000)" />
      </label>
    </div>
    <div class="flex items-center gap-3">
      <span class="compose-transform__label">缩放</span>
      <label class="compose-transform__field compose-transform__field--solo">
        <input
          :value="textOf(frame.scale, 1)"
          inputmode="decimal"
          :disabled="!canEdit"
          @change="onNumberChange('scale', $event, 1, 1000)"
        />
        <em>%</em>
      </label>
    </div>
    <div class="flex items-center gap-3">
      <span class="compose-transform__label">旋转</span>
      <label class="compose-transform__field compose-transform__field--solo">
        <input
          :value="textOf(frame.rotate)"
          inputmode="decimal"
          :disabled="!canEdit"
          @change="onNumberChange('rotate', $event, -360, 360)"
        />
        <em>°</em>
      </label>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ComposeFrameAspect, VideoFrameTransform } from "@/types/videoCompose";
import { COMPOSE_FRAME_ASPECT_OPTIONS } from "../shared/videoFrame";

const props = defineProps<{
  /** 当前视频轨画幅 */
  aspect: ComposeFrameAspect;
  /** 正在编辑的视频画面。没有片段时只展示，不能改 */
  frame: VideoFrameTransform;
  /** 是否有可写回的视频片段 */
  canEdit?: boolean;
}>();

const emit = defineEmits<{
  "update:aspect": [value: ComposeFrameAspect];
  "update:frame": [patch: Partial<VideoFrameTransform>];
}>();

const aspectOptions = COMPOSE_FRAME_ASPECT_OPTIONS;

/** 数字展示。缩放保留一位小数 */
function textOf(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return "0";
  const factor = 10 ** digits;
  return String(Math.round(value * factor) / factor);
}

function onAspectChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (value === "native" || value === "16:9" || value === "9:16" || value === "4:3" || value === "3:4") {
    emit("update:aspect", value);
  }
}

/** 合法数字立即写回并夹取。空输入或非法数字不改轨道 */
function onNumberChange(key: keyof VideoFrameTransform, event: Event, min: number, max: number): void {
  if (!props.canEdit) return;
  const raw = (event.target as HTMLInputElement).value.trim();
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return;
  const next = Math.min(max, Math.max(min, parsed));
  emit("update:frame", { [key]: next });
}
</script>

<style scoped lang="scss">
.compose-transform__label {
  width: 56px;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--compose-fg-2);
}

.compose-transform__input,
.compose-transform__field input {
  height: 40px;
  min-width: 0;
  flex: 1;
  border: 0;
  border-radius: 8px;
  background: var(--compose-surface-3);
  padding: 0 8px;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  color: var(--compose-fg);
  outline: none;
}

.compose-transform__input {
  width: 100%;
}

.compose-transform__field input:disabled,
.compose-transform__input:disabled {
  color: var(--compose-fg-3);
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
}
</style>
