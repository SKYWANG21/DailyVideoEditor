<template>
  <div
    class="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[10px] border border-border/40 bg-card/60 shadow-lg backdrop-blur-xl"
  >
    <!-- timeline 多轨混音在 preview hook 的 audio 池；此节点仅 legacy composeConfig.bgm -->
    <audio ref="bgmAudioRef" preload="auto" crossorigin="anonymous" class="hidden" />

    <div ref="playerContainerRef" class="relative min-h-0 w-full flex-1 overflow-hidden rounded-t-[10px] bg-black">
      <!-- 原声时钟。画面由 WebCodecs + GPUPixel 画到下面的 canvas，不能对 canvas 调用 getContext -->
      <audio ref="audioARef" preload="auto" class="hidden" />
      <audio ref="audioBRef" preload="auto" class="hidden" />
      <canvas
        :id="GPU_PIXEL_CANVAS_ID"
        ref="previewCanvasRef"
        class="pointer-events-none absolute inset-0 z-0 h-full w-full object-contain"
        :class="showPreviewFrame ? 'opacity-100' : 'opacity-0'"
      />
      <template v-if="effectiveClips.length">
        <VideoComposeTextStickerOverlay
          v-if="!catalogPreviewActive && overlayVideoWidth > 0"
          :class="isAdjusting ? '[&_*]:!pointer-events-none' : undefined"
          :clips="textClips"
          :current-time="globalTime"
          :selected-id="selectedTextClipId"
          :video-width="overlayVideoWidth"
          :video-height="overlayVideoHeight"
          @update:rect="emit('update:text-clip-rect', $event)"
          @select="emit('select-text-clip', $event)"
        />
      </template>
      <template v-else>
        <div class="absolute inset-0 z-0 flex flex-col items-center justify-center text-white/20">
          <Video :size="48" class="mb-2" />
          <span class="text-sm">尚未生成视频内容</span>
        </div>
      </template>
      <p
        v-if="previewError && effectiveClips.length"
        class="pointer-events-none absolute inset-x-0 top-2 z-30 truncate px-3 text-center text-[11px] text-white/70"
      >
        {{ previewError }}
      </p>

      <div
        v-if="catalogPreviewActive"
        class="pointer-events-auto absolute inset-x-0 top-0 z-40 flex items-center justify-center gap-2 bg-black/70 px-3 py-2"
      >
        <span class="truncate text-xs text-white/90">正在预览素材 · {{ catalogPreviewLabel }}</span>
        <button
          type="button"
          class="shrink-0 rounded-[4px] bg-primary px-2.5 py-1 text-[11px] font-medium text-white hover:bg-primary/90"
          @click="emit('clear-catalog-preview')"
        >
          返回时间轴
        </button>
      </div>

      <!-- 字幕低于贴图 z-[15]；编辑中抬到 z-[20] 以免贴图挡住 contenteditable -->
      <div
        v-if="!isAdjusting"
        class="pointer-events-none absolute inset-x-0 overflow-hidden"
        :class="editingSubtitleId ? 'z-[20]' : 'z-[5]'"
        :style="overlayStyle"
      >
        <div
          v-if="showSubtitles && previewSubtitles.length"
          class="flex flex-col items-center justify-end text-center"
          :style="subtitleTextStyle"
        >
          <template v-for="sub in previewSubtitles" :key="sub.id">
            <div
              v-if="editingSubtitleId === sub.id"
              :ref="(el) => setEditingEl(el)"
              class="w-full whitespace-pre-wrap outline-none"
              :class="readonly ? undefined : 'pointer-events-auto cursor-text'"
              contenteditable="true"
              @mousedown.stop
              @input="onSubtitleEditInput"
              @keydown.enter="onSubtitleEditEnter($event, sub.id)"
              @keydown.esc.prevent="cancelSubtitleEdit"
              @blur="commitSubtitleEdit(sub.id)"
            />
            <div
              v-else
              class="w-full whitespace-pre-wrap outline-none"
              :class="readonly ? undefined : 'pointer-events-auto cursor-text'"
              @dblclick.stop="onSubtitleDblClick(sub)"
            >
              {{ sub.text }}
            </div>
          </template>
        </div>
      </div>

      <template v-else>
        <div class="pointer-events-none absolute z-[5]" :style="centerLineStyle" />
        <div
          class="absolute z-[5] flex cursor-move select-none flex-col items-center justify-end"
          :style="draftBoxStyle"
          @mousedown="startBoxDrag($event, 'move')"
        >
          <div class="pointer-events-none w-full overflow-hidden text-center" :style="subtitleTextStyle">
            <div v-for="sub in adjustPreviewSubtitles" :key="sub.id">{{ sub.text }}</div>
          </div>
          <div class="-ml-1 absolute bottom-0 left-0 top-0 w-2 cursor-ew-resize" @mousedown="startBoxDrag($event, 'left')" />
          <div class="-mr-1 absolute bottom-0 right-0 top-0 w-2 cursor-ew-resize" @mousedown="startBoxDrag($event, 'right')" />
          <div class="-mt-1 absolute left-0 right-0 top-0 h-2 cursor-ns-resize" @mousedown="startBoxDrag($event, 'top')" />
          <div class="-mb-1 absolute bottom-0 left-0 right-0 h-2 cursor-ns-resize" @mousedown="startBoxDrag($event, 'bottom')" />
        </div>
      </template>
    </div>

    <div
      v-if="effectiveClips.length && !catalogPreviewActive"
      class="flex shrink-0 items-center gap-3 rounded-b-[10px] bg-[#000] px-4 py-2"
    >
      <div class="flex shrink-0 items-center gap-2">
        <span class="whitespace-nowrap text-xs text-white/80">循环当前片段</span>
        <button
          type="button"
          class="relative h-4 w-7 rounded-full transition-colors"
          :class="loopCurrent ? 'bg-primary' : 'bg-white/30'"
          @click="emit('update:loopCurrent', !loopCurrent)"
        >
          <div
            class="absolute bottom-0.5 top-0.5 w-3 rounded-full bg-white transition-all"
            :class="loopCurrent ? 'left-[14px]' : 'left-0.5'"
          />
        </button>
      </div>
      <div class="flex min-w-0 flex-1 cursor-pointer gap-1">
        <div
          v-for="(clip, i) in effectiveClips"
          :key="clip.id"
          class="relative h-1.5 flex-1 overflow-hidden rounded-full"
          :class="i < playingIdx ? 'bg-primary' : 'bg-white/20'"
          @click.stop="selectClip(i)"
        >
          <div
            v-if="i === playingIdx"
            class="absolute bottom-0 left-0 top-0 rounded-full bg-primary"
            :style="{ width: currentClipProgressPct + '%' }"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, toRef, onBeforeUnmount } from "vue";
import { Video } from "@lucide/vue";
import type {
  ComposeConfig,
  ComposeTextOverlayClip,
  PreviewAudioClip,
  SubtitleItem,
  SubtitleStyleConfig,
  VideoClipItem,
} from "@/types/videoCompose";
import { useVideoComposePreview } from "@/hooks/useVideoComposePreview";
import { useComposePreviewFrame } from "@/hooks/useComposePreviewFrame";
import { useVideoComposeSubtitleAdjust } from "@/hooks/useVideoComposeSubtitleAdjust";
import { GPU_PIXEL_CANVAS_ID } from "@/service/beauty/gpuPixelPreview";
import VideoComposeTextStickerOverlay from "./VideoComposeTextStickerOverlay.vue";
import type { RectConfig } from "@/clip-track";

const props = defineProps<{
  /** 视频片段列表（时间轴派生） */
  videoClips: VideoClipItem[];
  /** 素材库预览时临时 override 主播放器（单 clip） */
  overrideClips?: VideoClipItem[] | null;
  /** 是否处于素材库预览态 */
  catalogPreviewActive?: boolean;
  /** 素材库预览展示文案 */
  catalogPreviewLabel?: string;
  /** 音频轨片段（按全局时间命中混音） */
  audioClips?: PreviewAudioClip[];
  /** 合成参数（BGM、音量等，与父级共享 reactive） */
  composeConfig: ComposeConfig;
  /** 是否循环当前片段 */
  loopCurrent: boolean;
  /** 是否显示字幕 */
  showSubtitles: boolean;
  /** 预览区当前可见字幕 */
  visiblePreviewSubtitles: SubtitleItem[];
  /** 调整模式预览字幕 */
  adjustPreviewSubtitles: SubtitleItem[];
  /** 字幕样式配置 */
  subtitleStyle: SubtitleStyleConfig;
  /** 贴图轨 TextClip（按时间在 overlay 显示） */
  textClips?: ComposeTextOverlayClip[];
  /** 当前选中的贴图 clip id */
  selectedTextClipId?: string | null;
  /** 只读模式：禁止预览区双击改字幕 */
  readonly?: boolean;
}>();

const emit = defineEmits<{
  "update:loopCurrent": [value: boolean];
  /** 当前播放片段索引变化 */
  "update:playing-idx": [index: number];
  /** 全局播放时间变化（秒） */
  "global-time-update": [timeSec: number];
  /** 进入/退出字幕位置调整模式 */
  "update:is-adjusting": [value: boolean];
  /** 视频元数据是否就绪 */
  "update:video-ready": [value: boolean];
  /** 退出素材库预览，恢复时间轴播放 */
  "clear-catalog-preview": [];
  /** 贴图拖拽结束，写回 rect */
  "update:text-clip-rect": [payload: { clipId: string; rect: RectConfig }];
  /** 预览区点选贴图 */
  "select-text-clip": [clipId: string];
  /** 预览区双击字幕：选中对应 clip 并切到字幕设置 */
  "select-subtitle-clip": [clipId: string];
  /** 预览区字幕就地编辑提交（空文案由 Editor 拒绝并提示） */
  "update:subtitle-text": [payload: { clipId: string; text: string }];
}>();

/** 实际喂给预览引擎的 clip 列表 */
const effectiveClips = computed<VideoClipItem[]>(() => {
  if (props.overrideClips?.length) return props.overrideClips;
  return props.videoClips;
});

const audioARef = ref<HTMLMediaElement | null>(null);
const audioBRef = ref<HTMLMediaElement | null>(null);
const previewCanvasRef = ref<HTMLCanvasElement | null>(null);
const playerContainerRef = ref<HTMLElement | null>(null);
/** 模板 legacy BGM 元素；timeline 多轨由 preview mixer 池播放 */
const bgmAudioRef = ref<HTMLAudioElement | null>(null);

const audioClipsRef = computed(() => props.audioClips || []);

const composeConfigRef = toRef(props, "composeConfig");

const {
  currentIdx: playingIdx,
  globalTime,
  isPlaying,
  inGap,
  sampleTime,
  renderGeneration,
  onFramePresented,
  onFrameMissed,
  pause,
  play,
  toggle,
  seek,
  seekToClip,
  setPlaybackRate,
  resync,
  init,
  refreshBgm,
} = useVideoComposePreview({
  videoA: audioARef,
  videoB: audioBRef,
  bgmEl: bgmAudioRef,
  clips: effectiveClips,
  audioClips: audioClipsRef,
  config: composeConfigRef,
  loopCurrent: toRef(props, "loopCurrent"),
});

const {
  videoSize,
  frameReady,
  previewError,
} = useComposePreviewFrame({
  canvas: previewCanvasRef,
  clips: effectiveClips,
  currentIdx: playingIdx,
  sampleTime,
  renderGeneration,
  isPlaying,
  inGap,
  onFramePresented,
  onFrameMissed,
});

/** 有解码帧且不在时间轴空隙时才显示画面 */
const showPreviewFrame = computed(() => effectiveClips.value.length > 0 && !inGap.value && frameReady.value);

/** 贴图 overlay 使用的视频原始尺寸 */
const overlayVideoWidth = computed(() => videoSize.value?.width || 0);
const overlayVideoHeight = computed(() => videoSize.value?.height || 0);

/** 传给 overlay 的贴图列表 */
const textClips = computed<ComposeTextOverlayClip[]>(() => props.textClips || []);

/** 当前选中贴图 id */
const selectedTextClipId = computed(() => props.selectedTextClipId ?? null);

/** 添加贴图时用的视频像素尺寸 */
function getVideoSize(): { width: number; height: number } | null {
  const size = videoSize.value;
  if (!size || size.width <= 0 || size.height <= 0) return null;
  return { width: size.width, height: size.height };
}

const {
  isAdjusting,
  videoReady,
  toggle: toggleAdjustSubPosition,
  startBoxDrag,
  overlayStyle,
  draftBoxStyle,
  centerLineStyle,
  subtitleTextStyle,
} = useVideoComposeSubtitleAdjust({
  videoSize,
  containerEl: playerContainerRef,
  style: props.subtitleStyle,
  onEnter: pause,
});

/** 正在就地编辑的预览字幕 clip id；有值时渲染独立 contenteditable 节点 */
const editingSubtitleId = ref<string | null>(null);
/** 进入编辑时钉住的字幕，时间走出区间时仍保留节点以免卸载丢字 */
const pinnedEditingSubtitle = ref<SubtitleItem | null>(null);
/** 当前编辑节点（与 Timeline 相同：单 ref，模板无 Vue 文本子节点） */
const editingEl = ref<HTMLElement | null>(null);
/** 进入编辑时的原文，取消/空提交时回退 */
let editingOriginText = "";
/** 编辑过程草稿；节点已卸时 commit 仍可读 */
let editingDraft = "";
/** 防止 Enter + blur 双提交 */
let subtitleEditCommitting = false;

/**
 * 预览字幕列表：编辑中若当前时间已离开该 clip 区间，仍追加 pinned 条。
 */
const previewSubtitles = computed<SubtitleItem[]>(() => {
  const list = props.visiblePreviewSubtitles;
  const id = editingSubtitleId.value;
  const pinned = pinnedEditingSubtitle.value;
  if (!id || !pinned || pinned.id !== id) return list;
  if (list.some((item) => item.id === id)) return list;
  return [...list, pinned];
});

/** 绑定当前 contenteditable 节点；旧节点卸载时勿冲掉已挂上的新节点 */
function setEditingEl(el: unknown): void {
  if (el instanceof HTMLElement) {
    editingEl.value = el;
    return;
  }
  if (editingEl.value && !editingEl.value.isConnected) {
    editingEl.value = null;
  }
}

/** 是否允许预览区双击编辑字幕 */
function canEditPreviewSubtitle(): boolean {
  return !props.readonly && !props.catalogPreviewActive && !isAdjusting.value;
}

/** 退出预览字幕编辑态 */
function exitSubtitleEdit(): void {
  editingSubtitleId.value = null;
  pinnedEditingSubtitle.value = null;
  editingEl.value = null;
  editingOriginText = "";
  editingDraft = "";
}

/** 全选 contenteditable 内文案 */
function selectElementText(el: HTMLElement): void {
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** 同步草稿，供卸载后 commit 使用 */
function onSubtitleEditInput(e: Event): void {
  const target = e.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  editingDraft = target.textContent || "";
}

/** 双击预览字幕：暂停、选中 clip、挂载空编辑节点并全选 */
function onSubtitleDblClick(sub: SubtitleItem): void {
  if (!canEditPreviewSubtitle()) return;
  if (editingSubtitleId.value === sub.id) return;
  if (editingSubtitleId.value) {
    commitSubtitleEdit(editingSubtitleId.value);
  }
  pause();
  emit("select-subtitle-clip", sub.id);
  editingOriginText = sub.text || "";
  editingDraft = editingOriginText;
  pinnedEditingSubtitle.value = sub;
  editingSubtitleId.value = sub.id;
  void nextTick(() => {
    const el = editingEl.value;
    if (!el) return;
    el.textContent = editingOriginText;
    selectElementText(el);
  });
}

/** Esc：还原原文并退出，不写回 */
function cancelSubtitleEdit(): void {
  if (!editingSubtitleId.value) return;
  const el = editingEl.value;
  if (el) el.textContent = editingOriginText;
  editingDraft = editingOriginText;
  exitSubtitleEdit();
}

/** Enter 提交；输入法组字中的 Enter 不提交 */
function onSubtitleEditEnter(e: KeyboardEvent, clipId: string): void {
  if (e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  commitSubtitleEdit(clipId);
}

/**
 * Enter / blur：读 textContent（或草稿）提交；空文案仍 emit 以便 Editor 提示。
 * expectedId 与当前编辑 id 不一致时视为旧节点残留 blur，忽略。
 */
function commitSubtitleEdit(expectedId?: string): void {
  if (subtitleEditCommitting) return;
  const clipId = editingSubtitleId.value;
  if (!clipId) return;
  if (expectedId && expectedId !== clipId) return;

  subtitleEditCommitting = true;
  try {
    const el = editingEl.value;
    const text = (el?.textContent ?? editingDraft).trim();
    if (!text) {
      emit("update:subtitle-text", { clipId, text: "" });
      if (el) el.textContent = editingOriginText;
      exitSubtitleEdit();
      return;
    }
    if (text !== editingOriginText.trim()) {
      emit("update:subtitle-text", { clipId, text });
    }
    exitSubtitleEdit();
  } finally {
    queueMicrotask(() => {
      subtitleEditCommitting = false;
    });
  }
}

watch(isAdjusting, (adjusting) => {
  if (adjusting && editingSubtitleId.value) {
    cancelSubtitleEdit();
  }
});

watch(
  () => props.catalogPreviewActive,
  (active) => {
    if (active && editingSubtitleId.value) {
      cancelSubtitleEdit();
    }
  },
);

onBeforeUnmount(() => {
  if (editingSubtitleId.value) {
    commitSubtitleEdit(editingSubtitleId.value);
  }
});

const currentClipProgressPct = computed(() => {
  const idx = playingIdx.value;
  const clip = effectiveClips.value[idx];
  if (!clip) return 0;
  const start = clip.startTime ?? effectiveClips.value.slice(0, idx).reduce((s, c) => s + (c.durationSec || 0), 0);
  const end = clip.endTime ?? start + (clip.durationSec || 0);
  const dur = end - start;
  if (!dur) return 0;
  const within = globalTime.value - start;
  return Math.max(0, Math.min(100, (within / dur) * 100));
});

function selectClip(i: number): void {
  void seekToClip(i);
}

watch(playingIdx, (i) => emit("update:playing-idx", i), { immediate: true });
watch(globalTime, (t) => emit("global-time-update", t));
watch(isAdjusting, (v) => emit("update:is-adjusting", v));
watch(videoReady, (v) => emit("update:video-ready", v), { immediate: true });

async function tryInit(): Promise<void> {
  if (!hasTimelineMedia.value) return;

  if (effectiveClips.value.length) {
    await nextTick();
    if (!audioARef.value || !audioBRef.value) await nextTick();
    if (!audioARef.value || !audioBRef.value) return;
  } else {
    await nextTick();
  }

  init();
}

/** 是否存在可预览的时间轴媒体（视频或音轨） */
const hasTimelineMedia = computed(
  () => effectiveClips.value.length > 0 || (props.audioClips?.length ?? 0) > 0 || Boolean(composeConfigRef.value.bgm?.url),
);

/** 预览引擎 bootstrap 签名（视频结构 + 音轨布局） */
function previewBootstrapSig(): string {
  const videoPart = effectiveClips.value.map((c) => `${c.id}:${c.url}`).join("|");
  const audioPart = (props.audioClips || []).map((c) => `${c.id}:${c.startTime}:${c.endTime}:${c.url}`).join("|");
  const bgmPart = composeConfigRef.value.bgm?.url ?? "";
  return `${videoPart}::${audioPart}::${bgmPart}`;
}

let prevBootstrapSig = "";

/** 时间轴无可预览媒体时停止播放并清 mixer 池 / legacy BGM */
watch(hasTimelineMedia, (has) => {
  if (has) return;
  pause();
  refreshBgm();
});

watch(
  () => previewBootstrapSig(),
  (sig) => {
    if (!hasTimelineMedia.value) {
      prevBootstrapSig = "";
      return;
    }
    if (sig === prevBootstrapSig) return;
    prevBootstrapSig = sig;
    void tryInit();
  },
  { immediate: true },
);

/** 双 audio 晚于 clips 挂载时补一次 init；纯音轨预览由 mixer 池驱动 */
watch([audioARef, audioBRef], ([a, b]) => {
  if (!hasTimelineMedia.value) return;
  if (effectiveClips.value.length && (!a || !b)) return;
  init();
});

defineExpose({
  play,
  pause,
  toggle,
  seek,
  seekToClip,
  setPlaybackRate,
  resync,
  refreshBgm,
  isPlaying,
  init,
  toggleAdjustSubPosition,
  startBoxDrag,
  isAdjusting,
  videoReady,
  getVideoSize,
});
</script>
