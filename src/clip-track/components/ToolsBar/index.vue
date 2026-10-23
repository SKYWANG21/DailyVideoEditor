<template>
  <div class="tools-bar">
    <!-- 左侧：操作按钮区 -->
    <div class="tools-bar__section tools-bar__operations">
      <!-- 前置插槽 -->
      <slot name="operations-prepend" />

      <template v-for="(btn, index) in operationButtons" :key="index">
        <!-- 字符串简写形式 -->
        <button v-if="typeof btn === 'string'" class="tools-bar__btn"
          :class="{ 'tools-bar__btn--disabled': isOperationDisabled(btn) }" :disabled="isOperationDisabled(btn)"
          @click="handleOperation(btn)">
          <span class="tools-bar__icon">{{ getOperationIcon(btn) }}</span>
          <span class="tools-bar__label">{{ getOperationLabel(btn) }}</span>
        </button>
        <!-- 自定义插槽形式 -->
        <slot v-else-if="isCustomButton(btn)" :name="`custom-operation-${(btn as CustomButton).key}`" />
        <!-- 完整配置对象形式 -->
        <button v-else-if="isButtonConfig(btn)" class="tools-bar__btn" :class="[
          { 'tools-bar__btn--disabled': resolveDisabled(btn) },
          (btn as OperationButtonConfig).className
        ]" :disabled="resolveDisabled(btn)" :title="(btn as OperationButtonConfig).title"
          @click="handleConfigButtonClick(btn as OperationButtonConfig)">
          <span class="tools-bar__icon">
            <component v-if="isComponentIcon((btn as OperationButtonConfig).icon)"
              :is="(btn as OperationButtonConfig).icon" />
            <template v-else>{{ (btn as OperationButtonConfig).icon || '' }}</template>
          </span>
          <span class="tools-bar__label">{{ (btn as OperationButtonConfig).label || '' }}</span>
        </button>
      </template>

      <!-- 后置插槽 -->
      <slot name="operations-append" />
    </div>

    <!-- 中间：播放控制区 -->
    <div v-if="showPlayback" class="tools-bar__section tools-bar__playback">
      <!-- 前置插槽 -->
      <slot name="playback-prepend" />

      <button class="tools-bar__btn tools-bar__btn--play" @click="togglePlay">
        <span class="tools-bar__icon" :style="{ marginLeft: isPlaying ? '0' : '2px' }">{{ isPlaying ?
          '⏸'
          : '▶' }}</span>
      </button>
      <div class="tools-bar__time">
        <span class="tools-bar__time-current">{{ formattedCurrentTime }}</span>
        <span class="tools-bar__time-separator">/</span>
        <span class="tools-bar__time-duration">{{ formattedDuration }}</span>
      </div>
      <select v-model="playbackRate" class="tools-bar__select" @change="handlePlaybackRateChange">
        <option v-for="rate in playbackRates" :key="rate" :value="rate">
          {{ rate }}x
        </option>
      </select>

      <!-- 后置插槽 -->
      <slot name="playback-append" />
    </div>

    <!-- 右侧：缩放区 -->
    <div class="tools-bar__section tools-bar__scale">
      <!-- 前置插槽 -->
      <slot name="scale-prepend" />

      <!-- 功能配置按钮 -->
      <div class="tools-bar__scale-config">
        <template v-for="(btn, index) in scaleConfigButtons" :key="index">
          <!-- 字符串简写形式 - snap -->
          <button v-if="typeof btn === 'string' && btn === 'snap'"
            class="tools-bar__btn tools-bar__btn--toggle tools-bar__btn--snap"
            :class="{ 'tools-bar__btn--active': snapEnabled }" :title="snapEnabled ? snapOnTitle : snapOffTitle"
            @click="toggleSnap">
            <SnapIcon class="tools-bar__snap-icon" />
          </button>
          <!-- 自定义插槽形式 -->
          <slot v-else-if="isCustomButton(btn)" :name="`custom-scale-config-${(btn as CustomButton).key}`" />
          <!-- 完整配置对象形式 -->
          <button v-else-if="isScaleButtonConfig(btn)" class="tools-bar__btn tools-bar__btn--toggle" :class="[
            { 'tools-bar__btn--active': resolveActive(btn as ScaleConfigButtonConfig) },
            { 'tools-bar__btn--disabled': resolveDisabled(btn as ScaleConfigButtonConfig) },
            (btn as ScaleConfigButtonConfig).className
          ]" :title="(btn as ScaleConfigButtonConfig).title"
            :disabled="resolveDisabled(btn as ScaleConfigButtonConfig)"
            @click="handleScaleConfigButtonClick(btn as ScaleConfigButtonConfig)">
            <component v-if="isComponentIcon((btn as ScaleConfigButtonConfig).icon)"
              :is="(btn as ScaleConfigButtonConfig).icon" />
            <template v-else>{{ (btn as ScaleConfigButtonConfig).icon || '' }}</template>
          </button>
        </template>
      </div>

      <!-- 缩放控制 -->
      <div v-if="showScaleControl" class="tools-bar__scale-control">
        <button class="tools-bar__btn tools-bar__btn--icon" :disabled="scale <= minScale" @click="zoomOut">
          −
        </button>
        <div class="tools-bar__scale-slider">
          <input type="range" :min="minScale" :max="maxScale" :step="0.1" v-model.number="scale"
            @input="handleScaleChange" />
          <span class="tools-bar__scale-value">{{ scale.toFixed(1) }}x</span>
        </div>
        <button class="tools-bar__btn tools-bar__btn--icon" :disabled="scale >= maxScale" @click="zoomIn">
          +
        </button>
      </div>

      <!-- 后置插槽 -->
      <slot name="scale-append" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, inject, h, watch, type Component, type FunctionalComponent } from 'vue'
import { usePlaybackStore } from '../../stores/playback'
import { useScaleStore } from '../../stores/scale'
import { useHistoryStore } from '../../stores/history'
import { useTracksStore } from '../../stores/tracks'
import { useClipTrackPinia } from '../../stores/clipTrackPinia'
import type { OperationButton, ScaleConfigButton, LocaleConfig, OperationButtonConfig, ScaleConfigButtonConfig, CustomButton } from '../../types'
import SnapIcon from './icons/SnapIcon.vue'

// Props
interface Props {
  operationButtons?: OperationButton[]
  scaleConfigButtons?: ScaleConfigButton[]
  locale?: LocaleConfig
  /** 是否显示播放钮、时间和倍速 */
  showPlayback?: boolean
  /** 是否显示缩放加减和倍率滑杆。吸附按钮不受影响 */
  showScaleControl?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  operationButtons: () => ['reset', 'undo', 'redo', 'split', 'delete'],
  scaleConfigButtons: () => ['snap'],
  locale: () => ({}),
  showPlayback: true,
  showScaleControl: true
})

// Emits
const emit = defineEmits<{
  operation: [operation: string]
  'playback:play': []
  'playback:pause': []
}>()

// Stores
const pinia = useClipTrackPinia()
const playbackStore = usePlaybackStore(pinia)
const scaleStore = useScaleStore(pinia)
const historyStore = useHistoryStore(pinia)
const tracksStore = useTracksStore(pinia)

// Inject config
const config = inject<any>('config', {})

// Computed
const isPlaying = computed(() => playbackStore.isPlaying)
const formattedCurrentTime = computed(() => playbackStore.formattedCurrentTime)
const formattedDuration = computed(() => playbackStore.formattedDuration)
const snapEnabled = computed(() => scaleStore.snapEnabled)
const minScale = computed(() => scaleStore.minScale)
const maxScale = computed(() => scaleStore.maxScale)

// Local state
const playbackRate = ref(playbackStore.playbackRate)
const playbackRates = computed(() => config.playbackRates || [0.5, 1, 2, 4])
const scale = ref(scaleStore.scale)
watch(
  () => scaleStore.scale,
  (value) => {
    scale.value = value
  },
)

// Locale computed values
const snapOnTitle = computed(() => props.locale?.snapOn || '关闭自动吸附')
const snapOffTitle = computed(() => props.locale?.snapOff || '开启自动吸附')

// 类型判断辅助函数
function isCustomButton(btn: OperationButton | ScaleConfigButton): btn is CustomButton {
  return typeof btn === 'object' && 'type' in btn && btn.type === 'custom'
}

function isButtonConfig(btn: OperationButton): btn is OperationButtonConfig {
  return typeof btn === 'object' && !('type' in btn) && 'key' in btn
}

function isScaleButtonConfig(btn: ScaleConfigButton): btn is ScaleConfigButtonConfig {
  return typeof btn === 'object' && !('type' in btn) && 'key' in btn
}

function isComponentIcon(icon: string | Component | FunctionalComponent | undefined): icon is Component | FunctionalComponent {
  return typeof icon === 'object' || typeof icon === 'function'
}

// 解析 disabled 状态
function resolveDisabled(btn: OperationButtonConfig | ScaleConfigButtonConfig): boolean {
  const disabled = btn.disabled
  if (typeof disabled === 'function') {
    return disabled()
  }
  return disabled ?? false
}

// 解析 active 状态
function resolveActive(btn: ScaleConfigButtonConfig): boolean {
  const active = btn.active
  if (typeof active === 'function') {
    return active()
  }
  return active ?? false
}

// 处理配置对象按钮点击
function handleConfigButtonClick(btn: OperationButtonConfig) {
  if (btn.onClick) {
    btn.onClick()
  } else if (btn.key) {
    emit('operation', btn.key)
  }
}

// 处理缩放配置按钮点击
function handleScaleConfigButtonClick(btn: ScaleConfigButtonConfig) {
  if (btn.onClick) {
    btn.onClick()
  }
}

// 操作按钮图标
function getOperationIcon(operation: string): string {
  const icons: Record<string, string> = {
    reset: '↺',
    undo: '↶',
    redo: '↷',
    split: '✂',
    delete: '🗑'
  }
  return icons[operation] || ''
}

// 操作按钮标签
function getOperationLabel(operation: string): string {
  const localeLabels = props.locale || {}
  const defaultLabels: Record<string, string> = {
    reset: '重置',
    undo: '撤销',
    redo: '重做',
    split: '分割',
    delete: '删除'
  }
  return (localeLabels as Record<string, string>)[operation] || defaultLabels[operation] || operation
}

// 判断操作是否禁用
function isOperationDisabled(operation: string): boolean {
  switch (operation) {
    case 'undo':
      return !historyStore.canUndo
    case 'redo':
      return !historyStore.canRedo
    case 'split':
      // split 禁用条件：没有选中的 clip
      return tracksStore.selectedClipIds.size === 0
    default:
      return false
  }
}

// 处理操作
function handleOperation(operation: string) {
  emit('operation', operation)
}

// 切换播放/暂停
function togglePlay() {
  if (playbackStore.isPlaying) {
    playbackStore.pause()
    emit('playback:pause')
  } else {
    playbackStore.play()
    emit('playback:play')
  }
}

// 处理播放速率变化
function handlePlaybackRateChange() {
  playbackStore.setPlaybackRate(playbackRate.value)
}

// 切换吸附
function toggleSnap() {
  scaleStore.toggleSnap()
}

// 放大
function zoomIn() {
  scaleStore.zoomIn(0.1)
  scale.value = scaleStore.scale
}

// 缩小
function zoomOut() {
  scaleStore.zoomOut(0.1)
  scale.value = scaleStore.scale
}

// 处理缩放变化
function handleScaleChange() {
  scaleStore.setScale(scale.value)
}
</script>

<style scoped>
.tools-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  background: var(--color-bg-medium);
  border-bottom: 1px solid var(--color-border);
  gap: 20px;
  box-sizing: border-box;
  flex-shrink: 0;
  min-height: 50px;
  box-shadow: var(--shadow-sm);
  transition: background-color var(--transition-base);
}

.tools-bar__section {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tools-bar__operations {
  flex: 1;
  min-width: 0;
}

.tools-bar__playback {
  flex: 0 0 auto;
}

.tools-bar__scale {
  flex: 1;
  justify-content: flex-end;
  min-width: 0;
}

.tools-bar__btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  color: var(--color-text-secondary);
  font-size: 13px;
  font-weight: 400;
  cursor: pointer;
  transition: all var(--transition-fast);
  white-space: nowrap;
}

.tools-bar__btn:hover:not(:disabled) {
  background: var(--color-bg-light);
  color: var(--color-text-primary);
  border-color: var(--color-border);
}

.tools-bar__btn:active:not(:disabled) {
  transform: scale(0.97);
}

.tools-bar__btn--disabled,
.tools-bar__btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.tools-bar__btn--play {
  width: 34px;
  height: 34px;
  padding: 0;
  justify-content: center;
  align-items: center;
  border-radius: 50%;
  background: var(--color-primary);
  border: none;
  color: #fff;
  box-shadow: var(--shadow-md);
}

.tools-bar__btn--play:hover {
  background: var(--color-primary-hover);
  box-shadow: var(--shadow-lg), var(--shadow-glow);
}

.tools-bar__btn--play:active {
  transform: scale(0.95);
}

.tools-bar__btn--icon {
  width: 30px;
  height: 30px;
  padding: 0;
  justify-content: center;
  font-size: 16px;
  font-weight: 600;
  border-radius: var(--radius-md);
}

.tools-bar__btn--toggle.tools-bar__btn--active {
  background: var(--color-primary);
  color: #fff;
  border-color: var(--color-primary);
  box-shadow: var(--shadow-sm);
}

.tools-bar__btn--snap {
  padding: 6px 10px;
}

.tools-bar__snap-icon {
  font-size: 18px;
  line-height: 1;
}

.tools-bar__icon {
  font-size: 14px;
  line-height: 1;
}

.tools-bar__label {
  font-size: 13px;
  line-height: 1;
}

.tools-bar__time {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-family: 'SF Mono', 'Monaco', 'Courier New', monospace;
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-primary);
  background: var(--color-bg-light);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  letter-spacing: 0.02em;
}

.tools-bar__time-separator {
  color: var(--color-text-tertiary);
}

.tools-bar__select {
  padding: 6px 12px;
  background: var(--color-bg-light);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
  font-size: 13px;
  font-weight: 400;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.tools-bar__select:hover {
  background: var(--color-bg-lighter);
  border-color: var(--color-border-light);
}

.tools-bar__select:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px hsla(var(--theme-hue), var(--theme-saturation), var(--theme-lightness), 0.1);
}

.tools-bar__scale-config {
  display: flex;
  gap: 8px;
}

.tools-bar__scale-control {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tools-bar__scale-slider {
  display: flex;
  align-items: center;
  gap: 10px;
}

.tools-bar__scale-slider input[type='range'] {
  width: 120px;
  height: 4px;
  background: var(--color-border);
  border-radius: 2px;
  outline: none;
  cursor: pointer;
  border: none;
  -webkit-appearance: none;
  appearance: none;
}

.tools-bar__scale-slider input[type='range']::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  background: var(--color-primary);
  border: 2px solid white;
  border-radius: 50%;
  cursor: pointer;
  box-shadow: var(--shadow-md);
  transition: all var(--transition-fast);
}

.tools-bar__scale-slider input[type='range']::-webkit-slider-thumb:hover {
  transform: scale(1.15);
  box-shadow: var(--shadow-lg);
}

.tools-bar__scale-slider input[type='range']::-moz-range-thumb {
  width: 16px;
  height: 16px;
  background: var(--color-primary);
  border: 2px solid white;
  border-radius: 50%;
  cursor: pointer;
  border: none;
  box-shadow: var(--shadow-md);
  transition: all var(--transition-fast);
}

.tools-bar__scale-slider input[type='range']::-moz-range-thumb:hover {
  transform: scale(1.15);
  box-shadow: var(--shadow-lg);
}

.tools-bar__scale-value {
  min-width: 38px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-primary);
  text-align: center;
  font-family: 'Courier New', monospace;
}

.tools-bar__scale-custom {
  display: flex;
  gap: 8px;
}

/* 响应式优化 */
/* 中等屏幕 (1024px - 1279px) - 紧凑布局 */
@media (max-width: 1279px) {
  .tools-bar {
    gap: 12px;
    padding: 8px 12px;
  }

  .tools-bar__section {
    gap: 6px;
  }

  /* 隐藏操作按钮的文本标签，仅保留图标 */
  .tools-bar__operations .tools-bar__label {
    display: none;
  }

  .tools-bar__operations .tools-bar__btn {
    padding: 6px 10px;
    min-width: 32px;
    justify-content: center;
  }

  /* 缩小播放控制区的间距 */
  .tools-bar__time {
    padding: 5px 10px;
    font-size: 12px;
  }

  .tools-bar__select {
    padding: 5px 10px;
    font-size: 12px;
  }

  /* 缩放控制区优化 */
  .tools-bar__scale-config .tools-bar__label {
    display: none;
  }

  .tools-bar__scale-slider input[type='range'] {
    width: 100px;
  }
}

/* 小屏幕 (1024px - 1150px) - 进一步压缩 */
@media (max-width: 1150px) {
  .tools-bar {
    gap: 8px;
    padding: 8px;
  }

  .tools-bar__section {
    gap: 4px;
  }

  .tools-bar__operations .tools-bar__btn {
    padding: 6px 8px;
  }

  .tools-bar__scale-slider input[type='range'] {
    width: 80px;
  }

  .tools-bar__scale-value {
    min-width: 32px;
    font-size: 11px;
  }
}
</style>
