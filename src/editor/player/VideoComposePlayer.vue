<template>
  <div
    class="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[16px] bg-[var(--compose-surface)] shadow-[var(--compose-shadow-card)]"
  >
    <!-- timeline 多轨混音在 preview hook 的 audio 池；此节点仅 legacy composeConfig.bgm -->
    <audio ref="bgmAudioRef" preload="auto" crossorigin="anonymous" class="hidden" />

    <div ref="playerContainerRef" class="relative mx-4 mt-4 min-h-0 min-w-0 flex-1 overflow-hidden rounded-[4px] bg-[var(--compose-stage)]">
      <!-- 美颜关闭时双 video 出画；打开时只出声。canvas 交给 GPUPixel，不要 getContext -->
      <video
        ref="videoARef"
        preload="auto"
        playsinline
        class="pointer-events-none absolute inset-0 z-0 h-full w-full object-contain"
        :class="directVideoLayerClass(0)"
        @loadedmetadata="onDirectVideoMetadata"
      />
      <video
        ref="videoBRef"
        preload="auto"
        playsinline
        class="pointer-events-none absolute inset-0 z-0 h-full w-full object-contain"
        :class="directVideoLayerClass(1)"
        @loadedmetadata="onDirectVideoMetadata"
      />
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
        <div class="absolute inset-0 z-0 flex flex-col items-center justify-center text-[var(--compose-fg-3)]">
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
        class="pointer-events-auto absolute inset-x-3 top-3 z-40 flex items-center justify-center gap-2 rounded-full bg-[var(--compose-surface)]/80 px-3 py-1 shadow-[var(--compose-shadow-1)] backdrop-blur-md"
      >
        <span class="truncate text-[12px] text-[var(--compose-fg)]">正在预览素材 · {{ catalogPreviewLabel }}</span>
        <button
          type="button"
          class="shrink-0 rounded-[8px] bg-[var(--compose-accent)] px-3 py-1 text-[12px] font-semibold text-white transition-colors duration-200 hover:bg-[var(--compose-accent-hover)]"
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

    <div v-if="!catalogPreviewActive" class="grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center px-4">
      <span class="text-[13px] text-[var(--compose-fg-3)] tabular-nums">
        <span class="text-[var(--compose-fg)]">{{ fmtClock(globalTime) }}</span>
        / {{ fmtClock(durationSec) }}
      </span>
      <div class="flex items-center gap-2">
        <button type="button" :class="transportBtnClass" aria-label="转到开始" title="转到开始" @click="emit('seek-playback', 0)">
          <SkipBack :size="16" />
        </button>
        <button
          type="button"
          class="grid size-9 place-items-center rounded-full bg-[var(--compose-accent)] text-white transition-[filter,transform] duration-200 hover:brightness-110 active:scale-95"
          :aria-label="isPlaying ? '暂停' : '播放'"
          :title="isPlaying ? '暂停（空格）' : '播放（空格）'"
          @click="emit('toggle-playback')"
        >
          <Pause v-if="isPlaying" :size="16" />
          <Play v-else :size="16" class="translate-x-px" />
        </button>
        <button type="button" :class="transportBtnClass" aria-label="转到结束" title="转到结束" @click="emit('seek-playback', durationSec)">
          <SkipForward :size="16" />
        </button>
      </div>
      <div class="flex justify-end">
        <button
          type="button"
          :class="[transportBtnClass, previewMuted ? 'text-[var(--compose-accent)]' : '']"
          :aria-label="previewMuted ? '取消静音' : '静音'"
          :title="previewMuted ? '取消静音' : '静音'"
          @click="previewMuted = !previewMuted"
        >
          <VolumeX v-if="previewMuted" :size="16" />
          <Volume2 v-else :size="16" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, toRef, onBeforeUnmount } from "vue";
import { Pause, Play, SkipBack, SkipForward, Video, Volume2, VolumeX } from "@lucide/vue";
import type {
  ComposeConfig,
  ComposeTextOverlayClip,
  PreviewAudioClip,
  SubtitleItem,
  SubtitleStyleConfig,
  VideoClipItem,
} from "@/types/videoCompose";
import { readBeautyParams } from "@/types/composeMedia";
import type { PreviewVideoSize } from "@/types/beautyPreview";
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
  /** 时间轴总时长（秒），只用于播放条展示和跳到结尾 */
  durationSec: number;
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
  /** 播放 / 暂停。由父级走时间轴时钟，不在这里直接 play */
  "toggle-playback": [];
  /** 跳到时间轴上的秒数 */
  "seek-playback": [timeSec: number];
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

const videoARef = ref<HTMLVideoElement | null>(null);
const videoBRef = ref<HTMLVideoElement | null>(null);
const previewCanvasRef = ref<HTMLCanvasElement | null>(null);
const playerContainerRef = ref<HTMLElement | null>(null);
/** 模板 legacy BGM 元素；timeline 多轨由 preview mixer 池播放 */
const bgmAudioRef = ref<HTMLAudioElement | null>(null);

const audioClipsRef = computed(() => props.audioClips || []);

const composeConfigRef = toRef(props, "composeConfig");
/** 预览静音。不写回片段音量 */
const previewMuted = ref(false);

const {
  currentIdx: playingIdx,
  globalTime,
  isPlaying,
  inGap,
  activeSlot,
  activeVideoEl,
  directVideoAligned,
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
  videoA: videoARef,
  videoB: videoBRef,
  bgmEl: bgmAudioRef,
  clips: effectiveClips,
  audioClips: audioClipsRef,
  config: composeConfigRef,
  previewMuted,
});

/** 播放条两侧的次按钮 */
const transportBtnClass =
  "grid size-8 place-items-center rounded-[8px] text-[var(--compose-fg-2)] transition-colors duration-200 hover:bg-[var(--compose-surface-2)] hover:text-[var(--compose-fg)]";

/** 秒数显示成 m:ss 或 h:mm:ss */
function fmtClock(sec: number): string {
  const whole = Number.isFinite(sec) ? Math.max(0, Math.floor(sec + 1e-6)) : 0;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

const { videoSize, frameReady, previewError } = useComposePreviewFrame({
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

/** 当前片段美颜总开关。强度为 0 仍显示 canvas */
const beautyPreviewOn = computed(() => readBeautyParams(effectiveClips.value[playingIdx.value]?.beauty).enabled);

/** 美颜打开且已经画出一帧时才显示 canvas。空隙保持黑屏 */
const showPreviewFrame = computed(() => effectiveClips.value.length > 0 && !inGap.value && beautyPreviewOn.value && frameReady.value);

/** 活动 video 的像素尺寸。美颜关闭时贴图按它对齐 */
const directVideoSize = ref<PreviewVideoSize | null>(null);

/** 读取 video 的原始像素尺寸。还没有元数据时返回空 */
function readDirectVideoSize(el: HTMLMediaElement | null): PreviewVideoSize | null {
  if (!(el instanceof HTMLVideoElement) || el.videoWidth <= 0 || el.videoHeight <= 0) return null;
  return { width: el.videoWidth, height: el.videoHeight };
}

/** 活动层元数据就绪后记下贴图像素尺寸 */
function onDirectVideoMetadata(event: Event): void {
  const target = event.currentTarget;
  if (!(target instanceof HTMLVideoElement) || target !== activeVideoEl.value) return;
  directVideoSize.value = readDirectVideoSize(target);
}

/** 切到另一层时，用该 video 上已经加载好的像素尺寸 */
watch(activeVideoEl, (el) => {
  directVideoSize.value = readDirectVideoSize(el);
});

/** 该缓冲层是否直接出画：活动层、美颜关闭、不在空隙、且已对齐游标 */
function directVideoLayerClass(slot: 0 | 1): string {
  const visible =
    activeSlot.value === slot && !beautyPreviewOn.value && !inGap.value && directVideoAligned.value && effectiveClips.value.length > 0;
  return visible ? "opacity-100" : "opacity-0";
}

/** 贴图像素尺寸：美颜用 Worker 回传，否则用活动 video */
const overlayVideoSize = computed<PreviewVideoSize | null>(() => (beautyPreviewOn.value ? videoSize.value : directVideoSize.value));

/** 贴图 overlay 使用的视频原始尺寸 */
const overlayVideoWidth = computed(() => overlayVideoSize.value?.width || 0);
const overlayVideoHeight = computed(() => overlayVideoSize.value?.height || 0);

/** 传给 overlay 的贴图列表 */
const textClips = computed<ComposeTextOverlayClip[]>(() => props.textClips || []);

/** 当前选中贴图 id */
const selectedTextClipId = computed(() => props.selectedTextClipId ?? null);

/** 添加贴图时用的视频像素尺寸。美颜关闭时取活动 video，打开时取 Worker */
function getVideoSize(): { width: number; height: number } | null {
  const size = overlayVideoSize.value;
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
  videoSize: overlayVideoSize,
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

watch(playingIdx, (i) => emit("update:playing-idx", i), { immediate: true });
watch(globalTime, (t) => emit("global-time-update", t));
watch(isAdjusting, (v) => emit("update:is-adjusting", v));
watch(videoReady, (v) => emit("update:video-ready", v), { immediate: true });

async function tryInit(): Promise<void> {
  if (!hasTimelineMedia.value) return;

  if (effectiveClips.value.length) {
    await nextTick();
    if (!videoARef.value || !videoBRef.value) await nextTick();
    if (!videoARef.value || !videoBRef.value) return;
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

/** 双 video 晚于 clips 挂载时补一次 init；纯音轨预览由 mixer 池驱动 */
watch([videoARef, videoBRef], ([a, b]) => {
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
