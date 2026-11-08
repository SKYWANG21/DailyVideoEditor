<template>
  <div v-if="track.isMain && track.visible" class="transition-handles">
    <div
      v-for="seam in seams"
      :key="seam.key"
      class="transition-handles__target"
      :class="{ 'is-drag-over': dragKey === seam.key }"
      :style="{ left: `${seam.cut * pixelsPerSecond}px` }"
      @pointerdown.stop
      @mousedown.stop
      @dblclick.stop
      @dragover="onDragOver($event, seam)"
      @dragleave="dragKey = null"
      @drop="onDrop($event, seam)"
    >
      <ElPopover
        :width="200"
        trigger="click"
        :disabled="disabled"
        :visible="openKey === seam.key"
        @update:visible="(visible: boolean) => (visible ? open(seam) : (openKey = null))"
      >
        <template #reference>
          <button
            type="button"
            class="transition-handles__badge"
            :class="{ 'is-active': seam.transition || selectedKey === seam.key || openKey === seam.key }"
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
        <div class="transition-menu" @pointerdown.stop @keydown.esc="openKey = null">
          <span class="transition-menu__heading">接缝转场</span>
          <button
            v-for="effect in effects"
            :key="effect.id"
            type="button"
            class="transition-menu__effect"
            :class="{ 'is-selected': selectedEffect === effect.id }"
            @click="selectedEffect = effect.id"
          >
            {{ effect.name }}
          </button>
          <label class="transition-menu__duration">
            时长（秒）
            <ElInputNumber
              v-model="duration"
              size="small"
              :min="MIN_TRANSITION_DURATION"
              :max="seam.maxDuration"
              :step="0.1"
              :precision="3"
            />
          </label>
          <button type="button" class="transition-menu__effect" @click="apply(seam)">应用</button>
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
import { ElInputNumber, ElPopover } from "element-plus";
import type { Track } from "@/clip-track";
import type { TransitionSeam } from "@/types/transition";
import { createTransitionRegistry } from "@/transitions/catalog";
import { MIN_TRANSITION_DURATION, resolveTransitionSeams, TRANSITION_DRAG_MIME } from "@/transitions/timing";

/** 轨道内容内的接缝覆盖层，随滚动与倍率自然移动。 */
const props = defineProps<{ track: Track; pixelsPerSecond: number; readonly: boolean; selectedKey: string | null }>();
const emit = defineEmits<{
  select: [key: string];
  apply: [effectId: string, key: string, duration?: number];
  remove: [seam: TransitionSeam];
}>();
const registry = createTransitionRegistry();
const effects = registry.list();
/** 只读或锁定时保留展示，禁止编辑。 */
const disabled = computed(() => props.readonly || props.track.locked);
/** 临时拖动布局只影响展示，不清除持久化转场。 */
const seams = computed(() => resolveTransitionSeams(props.track.clips, props.track.transitions));
const openKey = ref<string | null>(null);
const dragKey = ref<string | null>(null);
const duration = ref(1);
const selectedEffect = ref("crossfade");
/** 每次打开读取最新工程状态。 */
function open(seam: TransitionSeam): void {
  openKey.value = seam.key;
  selectedEffect.value = registry.get(seam.transition?.effectId ?? "")?.id ?? "crossfade";
  duration.value = Math.min(seam.maxDuration, seam.transition?.durationSec ?? 1);
}
/** 单次确认只产生一条历史。 */
function apply(seam: TransitionSeam): void {
  emit("apply", selectedEffect.value, seam.key, duration.value);
  openKey.value = null;
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
  pointer-events: auto;
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
}
.transition-handles__badge.is-active,
.is-drag-over .transition-handles__badge {
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
  gap: 8px;
  font-size: 13px;
}
.transition-menu__heading {
  font-size: 12px;
  color: var(--el-text-color-secondary);
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
.transition-menu__remove {
  color: var(--el-color-danger);
}
.transition-menu__duration {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
