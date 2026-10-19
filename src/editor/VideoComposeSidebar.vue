<template>
  <div
    class="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[10px] border border-border/40 bg-card/60 shadow-lg backdrop-blur-xl"
  >
    <el-tabs v-model="activeTab" class="compose-sidebar-tabs flex-1 min-h-0 flex flex-col">
      <!-- 视频设置 -->
      <el-tab-pane label="视频设置" name="video" class="flex flex-col flex-1 min-h-0">
        <div class="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-5 scrollbar-hide">
          <div class="flex flex-col gap-3">
            <span class="text-sm font-medium text-foreground flex items-center gap-2">
              <Film :size="16" class="text-primary" />
              视频片段
            </span>
            <button
              v-if="!readonly"
              type="button"
              class="w-full border border-dashed h-[48px] gap-2 text-xs text-muted-foreground hover:text-primary hover:border-primary/50 rounded-lg flex items-center justify-center transition-colors"
              @click="emit('upload-clip')"
            >
              <UploadCloud :size="16" />
              上传视频片段
            </button>
            <VideoComposeClipCatalog
              v-if="segmentCatalog?.length"
              :groups="segmentCatalog"
              :timeline-clip-urls="timelineClipUrls"
              :preview-clip-id="previewClipId"
              :readonly="readonly"
              @preview="emit('preview-clip', $event)"
              @add-to-timeline="emit('add-clip-to-timeline', $event)"
              @remove="emit('remove-catalog-clip', $event)"
            />
          </div>

          <div class="flex flex-col gap-3">
            <span class="text-sm font-medium text-foreground flex items-center gap-2">
              <Volume2 :size="16" class="text-primary" />
              {{ videoVolumeLabel || "原视频音量" }}
            </span>
            <VolumeDbControl :db="videoVolume" @update:db="emit('update:videoVolume', $event)" />
          </div>

          <button
            type="button"
            class="w-full text-xs h-10 rounded-md border border-border bg-background hover:bg-muted transition-colors"
            @click="onApplyGlobal('video')"
          >
            应用到全局
          </button>
        </div>
      </el-tab-pane>

      <!-- 音轨设置 -->
      <el-tab-pane label="音轨设置" name="audio" class="flex flex-col flex-1 min-h-0">
        <div class="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-5 scrollbar-hide">
          <div class="flex flex-col gap-3">
            <span class="text-sm font-medium text-foreground flex items-center gap-2">
              <Music :size="16" class="text-primary" />
              BGM
            </span>
            <button
              type="button"
              class="w-full border border-dashed h-[48px] gap-2 text-xs text-muted-foreground hover:text-primary hover:border-primary/50 rounded-lg flex items-center justify-center transition-colors"
              @click="emit('open-upload-bgm')"
            >
              <UploadCloud :size="16" />
              上传音频
            </button>
            <p v-if="audioClipCount > 0" class="text-[11px] text-muted-foreground">已添加 {{ audioClipCount }} 段音频到时间轴</p>
          </div>

          <div class="flex flex-col gap-3">
            <span class="text-sm font-medium text-foreground flex items-center gap-2">
              <Volume2 :size="16" class="text-primary" />
              {{ audioVolumeLabel || "BGM 音量" }}
            </span>
            <VolumeDbControl :db="bgmVolume" @update:db="emit('update:bgmVolume', $event)" />
          </div>

          <button
            type="button"
            class="w-full text-xs h-10 rounded-md border border-border bg-background hover:bg-muted transition-colors"
            @click="onApplyGlobal('audio')"
          >
            应用到全局
          </button>
        </div>
      </el-tab-pane>

      <!-- 字幕设置 -->
      <el-tab-pane label="字幕设置" name="subtitle" class="flex flex-col flex-1 min-h-0">
        <div class="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-5 scrollbar-hide">
          <div class="flex flex-col gap-3">
            <span class="text-sm font-medium text-foreground flex items-center gap-2">
              <Type :size="16" class="text-primary" />
              字幕设置
            </span>
            <textarea
              :value="subtitleTextDraft"
              rows="3"
              class="w-full resize-none rounded-md border border-border bg-transparent px-2 py-2 text-xs outline-none transition-colors focus:border-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="!hasSelectedSubtitle"
              :placeholder="hasSelectedSubtitle ? '输入字幕内容' : '请先在时间轴选中一条字幕'"
              @focus="onSubtitleTextFocus"
              @input="onSubtitleTextInput"
              @blur="onSubtitleTextBlur"
            />
            <div class="grid grid-cols-2 gap-2">
              <div class="relative">
                <button
                  ref="fontFamilyBtnRef"
                  type="button"
                  class="h-10 text-xs rounded-md border border-border bg-transparent px-2 w-full text-left flex items-center justify-between outline-none hover:border-primary/50 transition-colors"
                  @click.stop="emit('font-popover-toggle', 'family')"
                >
                  <span>{{ fontLabel }}</span>
                  <ChevronDown :size="14" class="text-muted-foreground" />
                </button>
              </div>
              <div class="relative">
                <button
                  ref="fontStyleBtnRef"
                  type="button"
                  class="h-10 text-xs rounded-md border border-border bg-transparent px-2 w-full text-left flex items-center justify-between outline-none hover:border-primary/50 transition-colors"
                  @click.stop="emit('font-popover-toggle', 'style')"
                >
                  <span>{{ styleLabel }}</span>
                  <ChevronDown :size="14" class="text-muted-foreground" />
                </button>
              </div>
              <div class="relative">
                <input
                  :value="subtitleStyle.fontSize"
                  type="number"
                  min="1"
                  class="h-10 text-xs rounded-md border border-border bg-transparent px-2 pr-10 w-full outline-none focus:border-primary/50 transition-colors"
                  placeholder="字号"
                  @input="onFontSizeInput"
                />
                <span class="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">px</span>
              </div>
              <div class="flex items-center gap-2">
                <div class="relative w-10 h-10 rounded border border-border/50 shadow-sm overflow-hidden shrink-0">
                  <input
                    type="color"
                    :value="subtitleStyle.color"
                    class="absolute inset-[-10px] w-[60px] h-[60px] p-0 border-0 cursor-pointer"
                    @input="onColorInput"
                  />
                </div>
                <input
                  :value="subtitleStyle.color"
                  maxlength="7"
                  class="flex-1 h-10 text-xs font-mono rounded-md border border-border bg-transparent px-2 outline-none focus:border-primary/50 transition-colors"
                  @input="onColorTextInput"
                />
              </div>
              <button
                type="button"
                class="col-span-2 w-full text-xs rounded-md border h-10 transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                :class="
                  isAdjusting ? 'bg-[#8E51FF] text-white border-[#8E51FF] hover:bg-[#7940d9]' : 'border-border bg-background hover:bg-muted'
                "
                :disabled="!videoReady"
                @click="emit('toggle-adjust-position')"
              >
                <Move :size="14" />
                {{ isAdjusting ? "完成" : "调整字幕位置" }}
              </button>
              <p class="col-span-2 text-[11px] text-muted-foreground">
                {{ hasSelectedSubtitle ? "完成后将应用到当前字幕轨" : "完成后将应用到全部字幕轨" }}
              </p>
              <div class="col-span-2">
                <button
                  type="button"
                  class="w-full text-xs h-10 rounded-md border hover:bg-muted transition-colors flex items-center justify-center gap-2"
                  :class="subtitleVisible ? 'bg-[#8E51FF] text-white border-[#8E51FF] hover:bg-[#7940d9]' : 'border-border bg-background'"
                  @click="emit('update:subtitleVisible', !subtitleVisible)"
                >
                  <Eye v-if="subtitleVisible" :size="14" />
                  <EyeOff v-else :size="14" />
                  {{ subtitleVisible ? "隐藏字幕" : "显示字幕" }}
                </button>
              </div>
            </div>
          </div>

          <div class="flex flex-col gap-2">
            <button
              type="button"
              class="w-full text-xs h-10 rounded-md border border-border bg-background hover:bg-muted transition-colors disabled:opacity-50"
              :disabled="isTranscribing"
              @click="emit('regenerate-subtitles')"
            >
              {{ isTranscribing ? "识别中…" : "重新识别字幕" }}
            </button>
            <button
              type="button"
              class="w-full text-xs h-10 rounded-md border border-border bg-background hover:bg-muted transition-colors"
              @click="emit('add-subtitle')"
            >
              添加字幕
            </button>
          </div>

          <button
            type="button"
            class="w-full text-xs h-10 rounded-md border border-border bg-background hover:bg-muted transition-colors"
            @click="onApplyGlobal('subtitle')"
          >
            应用到全局
          </button>
        </div>
      </el-tab-pane>

      <!-- 文字模板 -->
      <el-tab-pane label="文字模板" name="textTemplate" class="flex flex-col flex-1 min-h-0">
        <div class="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-5 scrollbar-hide">
          <VideoComposeTextTemplateProps
            v-if="selectedTextClip"
            :text="selectedTextClip.text"
            :font-size="selectedTextClip.fontSize"
            :color="selectedTextClip.color"
            @change="emit('update:text-clip-props', $event)"
          />
          <template v-else>
            <span class="text-sm font-medium text-foreground flex items-center gap-2">
              <Sticker :size="16" class="text-primary" />
              文字模板
            </span>
            <VideoComposeTextTemplateCatalog :readonly="readonly" @add-to-timeline="emit('add-text-template', $event)" />
          </template>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { ChevronDown, Eye, EyeOff, Film, Move, Music, Sticker, Type, UploadCloud, Volume2 } from "@lucide/vue";
import type { ComposeSegmentClipGroup, ComposeSegmentClipVariant, SubtitleStyleConfig } from "@/types/videoCompose";
import VideoComposeClipCatalog from "./VideoComposeClipCatalog.vue";
import VideoComposeTextTemplateCatalog from "./VideoComposeTextTemplateCatalog.vue";
import VideoComposeTextTemplateProps from "./VideoComposeTextTemplateProps.vue";
import VolumeDbControl from "./VolumeDbControl.vue";
import type { TextTemplateItem } from "./textTemplateCatalog";

/** 侧栏 Tab：音轨 / 视频 / 字幕 / 文字模板 */
export type ComposeSidebarTab = "audio" | "video" | "subtitle" | "textTemplate";

/** 可「应用到全局」的范围（不含文字模板） */
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
  /** 视频 Tab 音量文案 */
  videoVolumeLabel?: string;
  /** 音轨 Tab 音量文案 */
  audioVolumeLabel?: string;
  /** BGM/音频轨音量（dB）；null 为静音 */
  bgmVolume: number | null;
  /** 已添加到时间轴的音频 clip 数量（弱提示） */
  audioClipCount: number;
  /** 字体展示文案 */
  fontLabel: string;
  /** 字形展示文案 */
  styleLabel: string;
  /** 字幕样式配置（字段对齐 SubtitleClip） */
  subtitleStyle: SubtitleStyleConfig;
  /** 当前作用目标字幕是否可见（SubtitleClip.visible） */
  subtitleVisible: boolean;
  /** 是否处于字幕位置调整模式 */
  isAdjusting: boolean;
  /** 预览视频是否就绪 */
  videoReady: boolean;
  /** 字幕识别中 */
  isTranscribing?: boolean;
  /** 各片段历史版本素材库 */
  segmentCatalog?: ComposeSegmentClipGroup[];
  /** 时间轴已有视频 URL（用于「已添加」标记） */
  timelineClipUrls?: Set<string>;
  /** 当前预览中的历史版本 id */
  previewClipId?: string;
  /** 只读模式 */
  readonly?: boolean;
  /** 当前侧栏 Tab（由 Editor 在选中 TextClip 时切到文字模板） */
  activeTab?: ComposeSidebarTab;
  /** 选中的贴图属性；有值时 Tab 展示属性面板 */
  selectedTextClip?: SelectedTextClipProps | null;
  /** 当前选中字幕 clip 的文案；未选中为空 */
  selectedSubtitleText?: string;
  /** 当前选中字幕 clip id；未选中为空。写回与切选中时以它为准 */
  selectedSubtitleId?: string;
  /** 时间轴是否选中了一条字幕 clip */
  hasSelectedSubtitle?: boolean;
}>();

const emit = defineEmits<{
  "open-upload-bgm": [];
  "upload-clip": [];
  "regenerate-subtitles": [];
  "add-subtitle": [];
  "update:videoVolume": [value: number | null];
  "update:bgmVolume": [value: number | null];
  "update:subtitleStyle": [value: SubtitleStyleConfig];
  "update:subtitleVisible": [value: boolean];
  /** 侧栏输入：非空时实时写回锁定的字幕 clip */
  "update:subtitle-text": [payload: SubtitleTextEditPayload];
  /** 侧栏失焦/切选中提交（空文案由 Editor 拒绝并提示） */
  "commit:subtitle-text": [payload: SubtitleTextEditPayload];
  "update:activeTab": [value: ComposeSidebarTab];
  "update:text-clip-props": [patch: { text?: string; fontSize?: number; color?: string }];
  "add-text-template": [item: TextTemplateItem];
  "font-popover-toggle": [type: "family" | "style"];
  "toggle-adjust-position": [];
  "apply-global": [scope: ComposeApplyGlobalScope];
  "preview-clip": [variant: ComposeSegmentClipVariant];
  "add-clip-to-timeline": [variant: ComposeSegmentClipVariant];
  "remove-catalog-clip": [variant: ComposeSegmentClipVariant];
}>();

/** 当前激活 Tab（受控） */
const activeTab = computed({
  get: () => props.activeTab || "video",
  set: (value: ComposeSidebarTab) => emit("update:activeTab", value),
});

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

function onFontSizeInput(e: Event): void {
  const raw = (e.target as HTMLInputElement).value;
  const fontSize = Math.max(1, Number(raw) || props.subtitleStyle.fontSize);
  emit("update:subtitleStyle", { ...props.subtitleStyle, fontSize });
}

function onColorInput(e: Event): void {
  const color = (e.target as HTMLInputElement).value;
  emit("update:subtitleStyle", { ...props.subtitleStyle, color });
}

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
.compose-sidebar-tabs {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.compose-sidebar-tabs :deep(.el-tabs__header) {
  margin-bottom: 0;
  flex-shrink: 0;
  padding: 0 8px;
}

.compose-sidebar-tabs :deep(.el-tabs__nav-wrap::after) {
  display: none;
}

.compose-sidebar-tabs :deep(.el-tabs__nav) {
  float: none;
  display: flex;
  width: 100%;
}

.compose-sidebar-tabs :deep(.el-tabs__item) {
  flex: 1;
  justify-content: center;
  text-align: center;
  padding: 0 4px;
  font-size: 12px;
}

.compose-sidebar-tabs :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.compose-sidebar-tabs :deep(.el-tab-pane) {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.scrollbar-hide {
  scrollbar-width: none;
}

.scrollbar-hide::-webkit-scrollbar {
  display: none;
}
</style>
