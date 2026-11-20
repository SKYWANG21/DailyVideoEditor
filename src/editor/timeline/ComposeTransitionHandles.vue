<template>
  <div v-if="track.isMain && track.visible" class="transition-handles">
    <div
      v-for="seam in seams"
      :key="seam.key"
      class="transition-handles__target"
      :style="{ left: `${seam.cut * pixelsPerSecond}px` }"
      @pointerdown.stop
      @mousedown.stop
      @dblclick.stop
      @dragover="onDragOver($event, seam)"
      @dragleave="dragKey = null"
      @drop="onDrop($event, seam)"
    >
      <ElPopover
        width="25vw"
        trigger="click"
        :disabled="disabled"
        :visible="openKey === seam.key"
        @update:visible="(visible: boolean) => (visible ? open(seam) : (openKey = null))"
      >
        <template #reference>
          <button
            type="button"
            class="transition-handles__badge"
            :class="{
              'has-transition': seam.transition,
              'is-active': selectedKey === seam.key || openKey === seam.key || dragKey === seam.key,
            }"
            :disabled="disabled"
            :title="seam.transition ? `${effectName(seam)} · ${seam.transition.durationSec.toFixed(2)} 秒` : '添加转场'"
            :aria-label="seam.transition ? '编辑接缝转场' : '添加接缝转场'"
            :data-transition-id="seam.transition?.id"
            @click.stop="emit('select', seam.key)"
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="6" y="5" width="4" height="14" />
              <rect x="14" y="5" width="4" height="14" />
            </svg>
          </button>
        </template>
        <div v-if="openKey === seam.key" class="transition-menu" @pointerdown.stop @keydown.esc="openKey = null">
          <span class="transition-menu__heading">接缝转场</span>
          <div class="transition-menu__effects">
            <button
              v-for="effect in effects"
              :key="effect.id"
              type="button"
              class="transition-menu__effect"
              :class="{ 'is-selected': seam.transition?.effectId === effect.id }"
              :disabled="disabled"
              :title="effect.name"
              @click="selectEffect(seam, effect.id)"
            >
              {{ effect.name }}
            </button>
          </div>
          <div class="transition-menu__duration">
            <span>时长（秒）</span>
            <div class="transition-menu__duration-control">
              <ElSlider
                :model-value="duration"
                :min="MIN_TRANSITION_DURATION"
                :max="seam.maxDuration"
                :step="0.1"
                :show-tooltip="false"
                :disabled="disabled || seam.maxDuration <= MIN_TRANSITION_DURATION"
                aria-label="转场时长（秒）"
                class="transition-menu__slider"
                @input="onDurationChange(seam, $event)"
              />
              <ElInputNumber
                :model-value="duration"
                size="small"
                controls-position="right"
                :min="MIN_TRANSITION_DURATION"
                :max="seam.maxDuration"
                :step="0.1"
                :precision="3"
                :disabled="disabled"
                aria-label="转场时长（秒）"
                class="transition-menu__duration-input"
                @change="onDurationChange(seam, $event)"
              />
            </div>
          </div>
          <button
            v-if="seam.transition"
            type="button"
            class="transition-menu__remove"
            @click="
              emit('remove', seam);
              openKey = null;
            "
          >
            删除转场
          </button>
        </div>
      </ElPopover>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { ElInputNumber, ElPopover, ElSlider } from "element-plus";
import type { Track } from "@/clip-track";
import type { TransitionSeam } from "@/types/transition";
import { useComposeTransitionRegistry } from "@/editor/composeRuntime";
import { MIN_TRANSITION_DURATION, resolveTransitionSeams, TRANSITION_DRAG_MIME } from "@/transitions/timing";

/** 轨道内容内的接缝覆盖层，随滚动与倍率自然移动。 */
const props = defineProps<{ track: Track; pixelsPerSecond: number; readonly: boolean; selectedKey: string | null }>();
const emit = defineEmits<{
  select: [key: string];
  apply: [effectId: string, key: string, duration?: number];
  remove: [seam: TransitionSeam];
}>();
const registry = useComposeTransitionRegistry();
const effects = registry.list();
/** 只读或锁定时保留展示，禁止编辑。 */
const disabled = computed(() => props.readonly || props.track.locked);
/** 临时拖动布局只影响展示，不清除持久化转场。 */
const seams = computed(() => resolveTransitionSeams(props.track.clips, props.track.transitions));
const openKey = ref<string | null>(null);
const dragKey = ref<string | null>(null);
const duration = ref(1);
/** 每次打开只同步时长；效果高亮直接读接缝已保存的 effectId。 */
function open(seam: TransitionSeam): void {
  openKey.value = seam.key;
  duration.value = Math.min(seam.maxDuration, seam.transition?.durationSec ?? 1);
}
/** 选择效果后立即写入当前接缝，保持弹窗打开供连续调整。 */
function selectEffect(seam: TransitionSeam, effectId: string): void {
  apply(seam, effectId);
}
/** 滑条与数字框共用时长校验。清空、无效输入，或接缝还没有转场时不写入。 */
function onDurationChange(seam: TransitionSeam, value: number | number[] | null | undefined): void {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  duration.value = Math.max(MIN_TRANSITION_DURATION, Math.min(seam.maxDuration, value));
  const effectId = seam.transition?.effectId;
  if (!effectId) return;
  apply(seam, effectId);
}
/** 参数实际变化时自动应用，避免重复选择产生无效历史。 */
function apply(seam: TransitionSeam, effectId: string): void {
  if (disabled.value) return;
  if (seam.transition?.effectId === effectId && seam.transition.durationSec === duration.value) return;
  emit("apply", effectId, seam.key, duration.value);
}
/** 未知效果保留标识供用户辨认。 */
function effectName(seam: TransitionSeam): string {
  return registry.get(seam.transition?.effectId ?? "")?.name ?? seam.transition?.effectId ?? "转场";
}
/** 转场拖放不传递给底层媒体拖放。 */
function onDragOver(event: DragEvent, seam: TransitionSeam): void {
  if (disabled.value || !event.dataTransfer?.types.includes(TRANSITION_DRAG_MIME)) return;
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = "copy";
  dragKey.value = seam.key;
}
/** 只接收已注册效果。 */
function onDrop(event: DragEvent, seam: TransitionSeam): void {
  dragKey.value = null;
  if (disabled.value || !event.dataTransfer?.types.includes(TRANSITION_DRAG_MIME)) return;
  event.preventDefault();
  event.stopPropagation();
  const id = event.dataTransfer.getData(TRANSITION_DRAG_MIME);
  if (registry.get(id)) emit("apply", id, seam.key);
}
</script>

<style scoped>
.transition-handles {
  position: absolute;
  inset: 0;
  z-index: 30;
  pointer-events: none;
}
.transition-handles__target {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 24px;
  margin-left: -12px;
  display: grid;
  place-items: center;
  /* 接缝按钮以外的区域透传给底层片段裁剪手柄。 */
  pointer-events: none;
}
.transition-handles__badge {
  width: 18px;
  height: 18px;
  padding: 0;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 5px;
  background: var(--compose-fg);
  color: var(--compose-surface);
  box-shadow: var(--compose-shadow-card);
  cursor: pointer;
  pointer-events: auto;
}
.transition-handles__badge.has-transition:not(.is-active) {
  background: var(--compose-accent);
  color: var(--el-color-white);
}
.transition-handles__badge.is-active {
  outline: 2px solid var(--compose-accent);
  outline-offset: 2px;
}
.transition-handles__badge:disabled {
  cursor: default;
  opacity: 0.6;
}
.transition-menu {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 13px;
}
.transition-menu__heading {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.transition-menu__effects {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.transition-menu__effect,
.transition-menu__remove {
  padding: 8px 12px;
  border: 0;
  border-radius: 8px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-primary);
  cursor: pointer;
  text-align: left;
}
.transition-menu__effect.is-selected {
  color: var(--el-color-primary);
}
.transition-menu__effect {
  flex: 0 0 96px;
  min-width: 0;
  overflow: hidden;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.transition-menu__remove {
  color: var(--el-color-danger);
}
.transition-menu__duration {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.transition-menu__duration-control {
  display: flex;
  align-items: center;
  gap: 12px;
}
.transition-menu__slider {
  --el-slider-height: 8px;
  --el-slider-button-size: 16px;
  --el-slider-main-bg-color: var(--compose-accent, var(--el-color-primary));
  --el-slider-runway-bg-color: var(--compose-surface-3, var(--el-border-color-light));
  flex: 1;
  min-width: 0;
  height: 36px;
}
.transition-menu__slider :deep(.el-slider__button) {
  border-color: var(--el-color-white);
  background: var(--compose-accent, var(--el-color-primary));
  box-shadow: var(--compose-shadow-1, var(--el-box-shadow-lighter));
}
.transition-menu__duration-input {
  flex: 0 0 108px;
  width: 108px;
}
</style>
