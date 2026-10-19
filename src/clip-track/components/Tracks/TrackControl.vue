<template>
  <div class="track-control">
    <!-- 轨道名称 -->
    <div class="track-control__name">
      <input v-if="isEditingName" v-model="editingName" class="track-control__name-input" @blur="handleNameBlur"
        @keyup.enter="handleNameBlur" @keyup.esc="cancelNameEdit" ref="nameInputRef" />
      <span v-else class="track-control__name-text" @dblclick="startNameEdit">
        {{ track.name }}
      </span>
      <span v-if="track.isMain" class="track-control__badge">{{ locale?.mainBadge || '主' }}</span>
    </div>

    <!-- 控制按钮 -->
    <div class="track-control__actions">
      <!-- 显示/隐藏 -->
      <button class="track-control__btn" :class="{ 'track-control__btn--active': track.visible }" @click="toggleVisible"
        :title="track.visible ? (locale?.hide || '隐藏') : (locale?.show || '显示')">
        {{ track.visible ? '👁' : '👁‍🗨' }}
      </button>

      <!-- 锁定/解锁 -->
      <button class="track-control__btn" :class="{ 'track-control__btn--active': track.locked }" @click="toggleLocked"
        :title="track.locked ? (locale?.unlock || '解锁') : (locale?.lock || '锁定')">
        {{ track.locked ? '🔒' : '🔓' }}
      </button>

      <slot :track="track" />

      <!-- 删除 -->
      <button v-if="!track.isMain" class="track-control__btn track-control__btn--danger" @click="handleDelete"
        :title="locale?.delete || '删除'">
        🗑
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick } from 'vue'
import type { Track } from '../../types'
import type { LocaleConfig } from '../../types/config'

// Props
interface Props {
  track: Track
  locale?: LocaleConfig
}

const props = defineProps<Props>()

// Emits
const emit = defineEmits<{
  update: [trackId: string, updates: Partial<Track>]
  delete: [trackId: string]
}>()

// Refs
const isEditingName = ref(false)
const editingName = ref('')
const nameInputRef = ref<HTMLInputElement>()

// 开始编辑名称
function startNameEdit() {
  isEditingName.value = true
  editingName.value = props.track.name
  nextTick(() => {
    nameInputRef.value?.focus()
    nameInputRef.value?.select()
  })
}

// 完成名称编辑
function handleNameBlur() {
  if (editingName.value.trim() && editingName.value !== props.track.name) {
    emit('update', props.track.id, { name: editingName.value.trim() })
  }
  isEditingName.value = false
}

// 取消名称编辑
function cancelNameEdit() {
  isEditingName.value = false
  editingName.value = ''
}

// 切换显示/隐藏
function toggleVisible() {
  emit('update', props.track.id, { visible: !props.track.visible })
}

// 切换锁定/解锁
function toggleLocked() {
  emit('update', props.track.id, { locked: !props.track.locked })
}

// 删除轨道
function handleDelete() {
  const confirmText = (props.locale?.confirmDeleteTrack || '确定要删除轨道"{name}"吗？').replace('{name}', props.track.name)
  if (confirm(confirmText)) {
    emit('delete', props.track.id)
  }
}
</script>

<style scoped>
.track-control {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 12px;
  padding: 0 12px;
  padding-right: 14px;
  /* 12px + 2px 额外间距，让游标线可见 */
  margin-right: 2px;
  /* 右侧留出 2px 透明区域 */
  border-right: 1px solid var(--color-border);
  height: 100%;
  box-sizing: border-box;
  background-color: var(--color-bg-elevated);
}

.track-control__name {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  /* 允许 flex item 收缩 */
}

.track-control__name-text {
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-primary);
  cursor: text;
  white-space: nowrap;
  /* overflow: hidden; */
  /* 让表格自动撑开，不隐藏 */
  /* text-overflow: ellipsis; */
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
  width: 24px;
  height: 24px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--color-text-tertiary);
  font-size: 13px;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.track-control__btn:hover {
  background: var(--color-bg-medium);
  color: var(--color-text-primary);
}

.track-control__btn--active {
  color: var(--color-primary);
}

.track-control__btn--danger:hover {
  background: var(--color-danger);
  color: #fff;
}
</style>
