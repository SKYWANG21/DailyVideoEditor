<template>
  <aside
    class="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[16px] bg-[var(--compose-surface)] shadow-[var(--compose-shadow-card)]"
    aria-label="参数设置"
  >
    <template v-if="inspectorKind">
      <div class="shrink-0 px-4 pt-2">
        <VideoComposeUnderlineTabs :tabs="tabLabels" :model-value="tabIndex" @update:model-value="onTabChange" />
      </div>
      <div class="compose-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pt-4 pb-4">
        <VideoComposeTransformPanel
          v-if="showTransform"
          :aspect="frameAspect"
          :frame="videoFrame"
          :can-edit="canEditVideoFrame"
          @update:aspect="emit('update:frame-aspect', $event)"
          @update:frame="emit('update:video-frame', $event)"
        />

        <template v-else-if="inspectorKind === 'video'">
          <div class="flex flex-col gap-2">
            <span class="text-[12px] text-[var(--compose-fg-2)]">{{ videoVolumeLabel || "原视频音量" }}</span>
            <VolumeDbControl :db="videoVolume" @update:db="emit('update:videoVolume', $event)" />
          </div>
          <div class="flex flex-col gap-2">
            <span class="text-[12px] text-[var(--compose-fg-2)]">变速</span>
            <PlaybackRateControl :rate="videoPlaybackRate" @update:rate="emit('update:videoPlaybackRate', $event)" />
          </div>
          <VideoComposeBeautyControls :beauty="beauty" @update:beauty="emit('update:beauty', $event)" />
          <slot name="before-apply-video" />
          <button type="button" :class="applyClass" @click="onApplyGlobal('video')">应用到全局</button>
        </template>

        <template v-else-if="inspectorKind === 'audio'">
          <div class="flex flex-col gap-2">
            <span class="text-[12px] text-[var(--compose-fg-2)]">{{ audioVolumeLabel || "BGM 音量" }}</span>
            <VolumeDbControl :db="bgmVolume" @update:db="emit('update:bgmVolume', $event)" />
          </div>
          <div class="flex flex-col gap-2">
            <span class="text-[12px] text-[var(--compose-fg-2)]">变速</span>
            <PlaybackRateControl :rate="audioPlaybackRate" @update:rate="emit('update:audioPlaybackRate', $event)" />
          </div>
          <p v-if="audioClipCount > 0" class="text-[12px] text-[var(--compose-fg-3)]">已添加 {{ audioClipCount }} 段音频到时间轴</p>
          <slot name="before-apply-audio" />
          <button type="button" :class="applyClass" @click="onApplyGlobal('audio')">应用到全局</button>
        </template>

        <template v-else-if="inspectorKind === 'subtitle'">
          <textarea
            :value="subtitleTextDraft"
            rows="3"
            class="compose-field w-full resize-none px-3 py-2"
            :disabled="!hasSelectedSubtitle"
            :placeholder="hasSelectedSubtitle ? '输入字幕内容' : '请先在时间轴选中一条字幕'"
            @focus="onSubtitleTextFocus"
            @input="onSubtitleTextInput"
            @blur="onSubtitleTextBlur"
          />
          <div class="grid grid-cols-2 gap-3">
            <button
              ref="fontFamilyBtnRef"
              type="button"
              class="compose-field flex items-center justify-between px-3 text-left"
              @click.stop="emit('font-popover-toggle', 'family')"
            >
              <span class="truncate">{{ fontLabel }}</span>
              <ChevronDown :size="16" class="shrink-0 text-[var(--compose-fg-3)]" />
            </button>
            <button
              ref="fontStyleBtnRef"
              type="button"
              class="compose-field flex items-center justify-between px-3 text-left"
              @click.stop="emit('font-popover-toggle', 'style')"
            >
              <span class="truncate">{{ styleLabel }}</span>
              <ChevronDown :size="16" class="shrink-0 text-[var(--compose-fg-3)]" />
            </button>
            <div class="relative">
              <input
                :value="subtitleStyle.fontSize"
                type="number"
                min="1"
                class="compose-field w-full pr-10 pl-3"
                placeholder="字号"
                @input="onFontSizeInput"
              />
              <span class="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[12px] text-[var(--compose-fg-3)]">px</span>
            </div>
            <div class="flex items-center gap-2">
              <div class="relative h-10 w-10 shrink-0 overflow-hidden rounded-[8px] bg-[var(--compose-surface-2)]">
                <input
                  type="color"
                  :value="subtitleStyle.color"
                  class="absolute -inset-2.5 h-[60px] w-[60px] cursor-pointer border-0 p-0"
                  @input="onColorInput"
                />
              </div>
              <input
                :value="subtitleStyle.color"
                maxlength="7"
                class="compose-field min-w-0 flex-1 px-3 font-mono"
                @input="onColorTextInput"
              />
            </div>
            <p class="col-span-2 text-[12px] text-[var(--compose-fg-3)]">位置仅作用于当前字幕；点击应用到全局可同步到全部字幕</p>
          </div>
          <slot name="before-apply-subtitle" />
          <button type="button" :class="applyClass" @click="onApplyGlobal('subtitle')">应用到全局</button>
        </template>

        <template v-else>
          <VideoComposeTextTemplateProps
            v-if="selectedTextClip"
            :text="selectedTextClip.text"
            :font-size="selectedTextClip.fontSize"
            :color="selectedTextClip.color"
            @change="emit('update:text-clip-props', $event)"
          />
          <p v-else class="text-[13px] leading-relaxed text-[var(--compose-fg-3)]">选择贴图后在此编辑。花字从左侧添加。</p>
          <slot name="before-apply-text" />
        </template>
      </div>
    </template>
    <div v-else class="grid min-h-0 flex-1 place-items-center px-10 text-center">
      <div>
        <SlidersHorizontal :size="32" class="mx-auto text-[var(--compose-fg-3)]" />
        <p class="mt-3 text-[13px] leading-relaxed text-[var(--compose-fg-3)]">选择下方轨道或片段后，在此设置参数</p>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { ChevronDown, SlidersHorizontal } from "@lucide/vue";
import type { BeautyParams, ComposeFrameAspect, SubtitleStyleConfig, VideoFrameTransform } from "@/types/videoCompose";
import VideoComposeBeautyControls from "./VideoComposeBeautyControls.vue";
import VideoComposeTextTemplateProps from "./VideoComposeTextTemplateProps.vue";
import VideoComposeTransformPanel from "./VideoComposeTransformPanel.vue";
import VideoComposeUnderlineTabs from "../shared/VideoComposeUnderlineTabs.vue";
import PlaybackRateControl from "./PlaybackRateControl.vue";
import VolumeDbControl from "./VolumeDbControl.vue";

/** 右栏编辑对象，由时间轴选中的片段或轨道决定 */
export type ComposeInspectorKind = "audio" | "video" | "subtitle" | "text";

/** 可「应用到全局」的范围（不含贴图） */
export type ComposeApplyGlobalScope = "audio" | "video" | "subtitle";

/** 选中贴图时侧栏展示的可编辑字段 */
export interface SelectedTextClipProps {
  /** 贴图文案 */
  text: string;
  /** 字号 px */
  fontSize: number;
  /** 颜色 hex */
  color: string;
}

/** 侧栏字幕文案写回：必须带开始编辑时的 clipId，避免切选中后写到新 clip */
export interface SubtitleTextEditPayload {
  /** 开始编辑时锁定的字幕 clip id */
  clipId: string;
  /** 字幕文案（input 为原始输入，commit 为 trim 后） */
  text: string;
}

const props = defineProps<{
  /** 原视频/原声音量（dB）；null 为静音 */
  videoVolume: number | null;
  /** 当前视频片段的美颜参数 */
  beauty: BeautyParams;
  /** 视频音量文案 */
  videoVolumeLabel?: string;
  /** 音轨音量文案 */
  audioVolumeLabel?: string;
  /** BGM/音频轨音量（dB）；null 为静音 */
  bgmVolume: number | null;
  /** 当前视频 clip 变速倍率 */
  videoPlaybackRate: number;
  /** 当前音频 clip 变速倍率 */
  audioPlaybackRate: number;
  /** 已添加到时间轴的音频 clip 数量 */
  audioClipCount: number;
  /** 字体展示文案 */
  fontLabel: string;
  /** 字形展示文案 */
  styleLabel: string;
  /** 字幕样式配置（字段对齐 SubtitleClip） */
  subtitleStyle: SubtitleStyleConfig;
  /** 当前编辑对象；空则提示先选择轨道或片段 */
  inspectorKind?: ComposeInspectorKind | null;
  /** 主视频轨画幅 */
  frameAspect: ComposeFrameAspect;
  /** 画面变换正在编辑的片段变换 */
  videoFrame: VideoFrameTransform;
  /** 有视频片段时才允许改位置和尺寸 */
  canEditVideoFrame?: boolean;
  /** 选中的贴图属性；有值时展示属性 */
  selectedTextClip?: SelectedTextClipProps | null;
  /** 当前选中字幕 clip 的文案；未选中为空 */
  selectedSubtitleText?: string;
  /** 当前选中字幕 clip id；未选中为空。写回与切选中时以它为准 */
  selectedSubtitleId?: string;
  /** 时间轴是否选中了一条字幕 clip */
  hasSelectedSubtitle?: boolean;
}>();

const emit = defineEmits<{
  "update:videoVolume": [value: number | null];
  /** 美颜开关或滑杆变化 */
  "update:beauty": [value: BeautyParams];
  "update:bgmVolume": [value: number | null];
  "update:videoPlaybackRate": [value: number];
  "update:audioPlaybackRate": [value: number];
  "update:subtitleStyle": [value: SubtitleStyleConfig];
  /** 侧栏输入：非空时实时写回锁定的字幕 clip */
  "update:subtitle-text": [payload: SubtitleTextEditPayload];
  /** 侧栏失焦/切选中提交（空文案由 Editor 拒绝并提示） */
  "commit:subtitle-text": [payload: SubtitleTextEditPayload];
  "update:text-clip-props": [patch: { text?: string; fontSize?: number; color?: string }];
  "font-popover-toggle": [type: "family" | "style"];
  "apply-global": [scope: ComposeApplyGlobalScope];
  "update:frame-aspect": [value: ComposeFrameAspect];
  "update:video-frame": [patch: Partial<VideoFrameTransform>];
}>();

/** 视频 clip 才有「画面变换」，记住上次页签 */
const videoTab = ref(0);

const tabLabels = computed(() => (props.inspectorKind === "video" ? ["基础", "画面变换"] : ["基础"]));
const tabIndex = computed(() => (props.inspectorKind === "video" ? videoTab.value : 0));
const showTransform = computed(() => props.inspectorKind === "video" && videoTab.value === 1);

/** 主题色主按钮中号：高 40、水平 padding 16，宽度跟文案，不随侧栏拉满 */
const applyClass =
  "h-10 shrink-0 w-auto whitespace-nowrap rounded-[8px] bg-[var(--compose-accent)] px-4 text-[13px] font-semibold text-white transition-[background-color,transform] duration-200 hover:bg-[var(--compose-accent-hover)] active:scale-[0.97]";

/** 视频页签切换。其它类型只有基础 */
function onTabChange(index: number): void {
  if (props.inspectorKind !== "video") return;
  videoTab.value = index === 1 ? 1 : 0;
}

const fontFamilyBtnRef = ref<HTMLButtonElement | null>(null);
const fontStyleBtnRef = ref<HTMLButtonElement | null>(null);

/** 字幕文案输入是否聚焦（聚焦期间用本地 draft，避免播放/选中变化抢输入） */
const subtitleTextFocused = ref(false);
/** 聚焦时锁定的字幕 clip id；input/blur 写回用它，不读当下选中 */
const editingSubtitleClipId = ref<string | null>(null);
/** 切选中时已提交旧 clip，随后的 textarea blur 跳过写回 */
let subtitleEditSelectionSwitched = false;
/** 字幕文案输入框展示值 */
const subtitleTextDraft = ref(props.selectedSubtitleText || "");

/** 把输入框同步为当前选中字幕文案 */
function syncDraftFromSelected(): void {
  subtitleTextDraft.value = props.selectedSubtitleText || "";
}

watch(
  () => props.selectedSubtitleText,
  () => {
    if (!subtitleTextFocused.value) {
      syncDraftFromSelected();
    }
  },
);

/**
 * 选中字幕切换：编辑中则先把草稿交给旧 clip，再载入新 clip 文案。
 * flush sync 保证在时间轴 mousedown 改选中的同一同步栈内完成，早于随后的 textarea blur。
 */
watch(
  () => props.selectedSubtitleId,
  (nextId, prevId) => {
    if (nextId === prevId) return;
    if (subtitleTextFocused.value) {
      const targetId = editingSubtitleClipId.value || prevId;
      if (targetId && targetId !== nextId) {
        emit("commit:subtitle-text", { clipId: targetId, text: subtitleTextDraft.value.trim() });
        subtitleEditSelectionSwitched = true;
      }
      editingSubtitleClipId.value = nextId || null;
      if (!nextId) {
        subtitleTextFocused.value = false;
      }
    }
    syncDraftFromSelected();
  },
  { flush: "sync" },
);

/** 聚焦字幕文案：锁定 draft 与 clipId，避免外部同步打断输入 */
function onSubtitleTextFocus(): void {
  subtitleTextFocused.value = true;
  subtitleEditSelectionSwitched = false;
  editingSubtitleClipId.value = props.selectedSubtitleId || null;
  syncDraftFromSelected();
}

/** 输入非空时实时写回锁定 clip；空串留到 blur 再校验 */
function onSubtitleTextInput(e: Event): void {
  const text = (e.target as HTMLTextAreaElement).value;
  subtitleTextDraft.value = text;
  const clipId = editingSubtitleClipId.value;
  if (clipId && text.trim()) {
    emit("update:subtitle-text", { clipId, text });
  }
}

/** 失焦提交锁定 clip；若切选中已提交过则只同步展示，避免写到新 clip */
function onSubtitleTextBlur(): void {
  const switched = subtitleEditSelectionSwitched;
  subtitleEditSelectionSwitched = false;
  const clipId = editingSubtitleClipId.value;
  const text = subtitleTextDraft.value.trim();
  subtitleTextFocused.value = false;
  editingSubtitleClipId.value = null;
  if (!switched && clipId) {
    emit("commit:subtitle-text", { clipId, text });
  }
  syncDraftFromSelected();
}

/** 字号写回当前字幕样式 */
function onFontSizeInput(e: Event): void {
  const raw = (e.target as HTMLInputElement).value;
  const fontSize = Math.max(1, Number(raw) || props.subtitleStyle.fontSize);
  emit("update:subtitleStyle", { ...props.subtitleStyle, fontSize });
}

/** 取色器写回字幕颜色 */
function onColorInput(e: Event): void {
  const color = (e.target as HTMLInputElement).value;
  emit("update:subtitleStyle", { ...props.subtitleStyle, color });
}

/** 十六进制文本写回字幕颜色 */
function onColorTextInput(e: Event): void {
  const color = (e.target as HTMLInputElement).value;
  emit("update:subtitleStyle", { ...props.subtitleStyle, color });
}

/** 应用到全局并提示成功 */
function onApplyGlobal(scope: ComposeApplyGlobalScope): void {
  emit("apply-global", scope);
  const messages: Record<ComposeApplyGlobalScope, string> = {
    video: "已应用到全部视频片段",
    audio: "已应用到全部音频片段",
    subtitle: "已应用到全部字幕",
  };
  ElMessage.success(messages[scope]);
}

defineExpose({
  fontFamilyBtnRef,
  fontStyleBtnRef,
});
</script>

<style scoped lang="scss">
.compose-field {
  height: 40px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: var(--compose-surface-2);
  font-size: 14px;
  color: var(--compose-fg);
  outline: none;
  transition:
    border-color 150ms cubic-bezier(0.25, 0.8, 0.25, 1),
    box-shadow 150ms cubic-bezier(0.25, 0.8, 0.25, 1);
}

textarea.compose-field {
  height: auto;
  min-height: 72px;
}

.compose-field:focus {
  border-color: var(--compose-accent);
  box-shadow: var(--compose-focus);
}

.compose-field:disabled {
  cursor: not-allowed;
  background: var(--compose-surface-3);
  color: var(--compose-fg-3);
}
</style>
