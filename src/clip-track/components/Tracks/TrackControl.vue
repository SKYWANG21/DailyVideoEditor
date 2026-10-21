<template>
  <div class="track-control">
    <span class="track-control__type" :class="typeTone" role="img" :aria-label="typeLabel" :title="typeLabel">
      <component :is="typeIcon" :size="16" />
    </span>
    <div class="track-control__name">
      <input
        v-if="isEditingName"
        v-model="editingName"
        class="track-control__name-input"
        @blur="handleNameBlur"
        @keyup.enter="handleNameBlur"
        @keyup.esc="cancelNameEdit"
        ref="nameInputRef"
      />
      <span v-else class="track-control__name-text" :title="track.name" @dblclick="startNameEdit">
        {{ track.name }}
      </span>
      <span v-if="track.isMain" class="track-control__badge">{{ locale?.mainBadge || "主" }}</span>
    </div>

    <div class="track-control__actions">
      <button
        class="track-control__btn"
        :class="{ 'track-control__btn--active': track.locked }"
        type="button"
        :aria-pressed="track.locked"
        :aria-label="track.locked ? locale?.unlock || '解锁' : locale?.lock || '锁定'"
        :title="track.locked ? locale?.unlock || '解锁' : locale?.lock || '锁定'"
        @click="toggleLocked"
      >
        <Lock v-if="track.locked" :size="16" />
        <Unlock v-else :size="16" />
      </button>
      <button
        class="track-control__btn"
        :class="{ 'track-control__btn--active': !track.visible }"
        type="button"
        :aria-pressed="!track.visible"
        :aria-label="track.visible ? locale?.hide || '隐藏' : locale?.show || '显示'"
        :title="track.visible ? locale?.hide || '隐藏' : locale?.show || '显示'"
        @click="toggleVisible"
      >
        <EyeOff v-if="!track.visible" :size="16" />
        <Eye v-else :size="16" />
      </button>

      <slot :track="track" />

      <button
        v-if="!track.isMain"
        class="track-control__btn track-control__btn--danger"
        type="button"
        :disabled="track.locked"
        :title="track.locked ? '轨道已锁定，解锁后可删除' : locale?.delete || '删除'"
        :aria-label="locale?.delete || '删除'"
        @click="handleDelete"
      >
        <Trash2 :size="16" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, nextTick, type Component } from "vue";
import { AudioLines, Captions, Eye, EyeOff, Lock, Trash2, Type, Unlock, Video } from "@lucide/vue";
import type { Track } from "../../types";
import type { LocaleConfig } from "../../types/config";

/** 轨道类型图标。贴图在库里可能是 text 或 sticker */
const TYPE_ICON: Record<string, Component> = {
  video: Video,
  audio: AudioLines,
  subtitle: Captions,
  text: Type,
  sticker: Type,
};

/** 图标悬停文案 */
const TYPE_LABEL: Record<string, string> = {
  video: "视频轨",
  audio: "音频轨",
  subtitle: "字幕轨",
  text: "贴图轨",
  sticker: "贴图轨",
};

// Props
interface Props {
  track: Track;
  locale?: LocaleConfig;
}

const props = defineProps<Props>();

// Emits
const emit = defineEmits<{
  update: [trackId: string, updates: Partial<Track>];
  delete: [trackId: string];
}>();

// Refs
const isEditingName = ref(false);
const editingName = ref("");
const nameInputRef = ref<HTMLInputElement>();

/** 当前轨道类型图标 */
const typeIcon = computed(() => TYPE_ICON[props.track.type] ?? Video);
/** 类型图标悬停名 */
const typeLabel = computed(() => TYPE_LABEL[props.track.type] ?? props.track.name);
/** 类型色：音频成功、字幕警告、贴图蓝 */
const typeTone = computed(() => {
  if (props.track.type === "audio") return "is-audio";
  if (props.track.type === "subtitle") return "is-subtitle";
  if (props.track.type === "text" || props.track.type === "sticker") return "is-text";
  return "is-video";
});

// 开始编辑名称
function startNameEdit() {
  isEditingName.value = true;
  editingName.value = props.track.name;
  nextTick(() => {
    nameInputRef.value?.focus();
    nameInputRef.value?.select();
  });
}

// 完成名称编辑
function handleNameBlur() {
  if (editingName.value.trim() && editingName.value !== props.track.name) {
    emit("update", props.track.id, { name: editingName.value.trim() });
  }
  isEditingName.value = false;
}

// 取消名称编辑
function cancelNameEdit() {
  isEditingName.value = false;
  editingName.value = "";
}

// 切换显示/隐藏
function toggleVisible() {
  emit("update", props.track.id, { visible: !props.track.visible });
}

// 切换锁定/解锁
function toggleLocked() {
  emit("update", props.track.id, { locked: !props.track.locked });
}

// 删除轨道
function handleDelete() {
  const confirmText = (props.locale?.confirmDeleteTrack || '确定要删除轨道"{name}"吗？').replace("{name}", props.track.name);
  if (confirm(confirmText)) {
    emit("delete", props.track.id);
  }
}
</script>

<style scoped>
.track-control {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 4px;
  height: 100%;
  margin: 0 8px;
  padding: 0 4px 0 8px;
  box-sizing: border-box;
  border-radius: 8px;
  background: var(--compose-surface-2, var(--color-bg-medium));
}

.track-control__type {
  display: grid;
  flex-shrink: 0;
  place-items: center;
}

.track-control__type.is-video {
  color: var(--compose-fg-2, var(--color-text-secondary));
}

.track-control__type.is-audio {
  color: var(--compose-success, #2fc77e);
}

.track-control__type.is-subtitle {
  color: var(--compose-warning, #ffb547);
}

.track-control__type.is-text {
  color: #3d7bff;
}

.track-control__name {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
  margin-right: auto;
}

.track-control__name-text {
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  font-weight: 500;
  color: var(--compose-fg, var(--color-text-primary));
  cursor: text;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.track-control__name-input {
  width: 100%;
  padding: 4px 8px;
  background: var(--color-bg-dark);
  border: 1px solid var(--color-primary);
  border-radius: var(--radius-sm);
  color: var(--color-text-primary);
  font-size: 12px;
  font-weight: 500;
  outline: none;
}

.track-control__badge {
  padding: 2px 6px;
  background: var(--color-primary);
  border-radius: var(--radius-sm);
  font-size: 9px;
  color: #fff;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  flex-shrink: 0;
}

.track-control__actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.track-control__btn {
  width: 28px;
  height: 28px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 0;
  border-radius: 4px;
  color: var(--compose-fg-3, var(--color-text-tertiary));
  cursor: pointer;
  transition:
    background-color 200ms cubic-bezier(0.25, 0.8, 0.25, 1),
    color 150ms cubic-bezier(0.25, 0.8, 0.25, 1);
}

.track-control__btn:hover:not(:disabled) {
  background: var(--compose-surface-3, var(--color-bg-elevated));
  color: var(--compose-fg, var(--color-text-primary));
}

.track-control__btn--active {
  background: var(--compose-accent-soft, rgba(130, 97, 255, 0.14));
  color: var(--compose-accent, var(--color-primary));
}

.track-control__btn--danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--compose-danger, var(--color-danger, #ff4d5e)) 15%, transparent);
  color: var(--compose-danger, var(--color-danger, #ff4d5e));
}

.track-control__btn:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}
</style>
