<template>
  <div
    class="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[16px] bg-[var(--compose-surface)] shadow-[var(--compose-shadow-card)]"
  >
    <!-- timeline 多轨混音在 preview hook 的 audio 池；此节点仅 legacy composeConfig.bgm -->
    <audio ref="bgmAudioRef" preload="auto" crossorigin="anonymous" class="hidden" />

    <div ref="playerContainerRef" class="relative mx-4 mt-4 min-h-0 min-w-0 flex-1 overflow-hidden rounded-[4px] bg-[var(--compose-stage)]">
      <div
        v-if="effectiveClips.length && stageFit.width"
        ref="canvasHostRef"
        class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[4px] bg-black"
        :style="stageStyle"
      >
        <!-- 美颜关闭时双 video 出画；打开时只出声。canvas 交给 GPUPixel，不要 getContext -->
        <div
          class="absolute"
          :class="catalogPreviewActive ? 'inset-0 overflow-hidden' : undefined"
          :style="catalogPreviewActive ? undefined : videoBoxStyle"
        >
          <video
            ref="videoARef"
            preload="auto"
            playsinline
            crossorigin="anonymous"
            class="pointer-events-none absolute inset-0 h-full w-full"
            :class="[directVideoLayerClass(0), catalogPreviewActive ? 'object-contain' : 'object-cover']"
            @loadedmetadata="onDirectVideoMetadata"
          />
          <video
            ref="videoBRef"
            preload="auto"
            playsinline
            crossorigin="anonymous"
            class="pointer-events-none absolute inset-0 h-full w-full"
            :class="[directVideoLayerClass(1), catalogPreviewActive ? 'object-contain' : 'object-cover']"
            @loadedmetadata="onDirectVideoMetadata"
          />
          <canvas
            :id="GPU_PIXEL_CANVAS_ID"
            ref="previewCanvasRef"
            class="pointer-events-none absolute inset-0 h-full w-full"
            :class="[showPreviewFrame ? 'opacity-100' : 'opacity-0', catalogPreviewActive ? 'object-contain' : 'object-cover']"
          />
        </div>

        <!-- 拖动热区在贴图、字幕之下。点空白画面才移动视频；画幅外靠浮层手柄 -->
        <div
          v-if="!catalogPreviewActive && !readonly && videoFrame"
          class="absolute z-[1] cursor-move"
          :style="videoBoxStyle"
          @pointerdown="onVideoFramePointerDown"
        />

        <VideoComposeTextStickerOverlay
          v-if="!catalogPreviewActive && (canvasWidth || 0) > 0"
          :class="isAdjusting ? '[&_*]:!pointer-events-none' : undefined"
          :clips="textClips"
          :current-time="globalTime"
          :selected-id="selectedTextClipId"
          :video-width="canvasWidth || 0"
          :video-height="canvasHeight || 0"
          @update:rect="emit('update:text-clip-rect', $event)"
          @select="emit('select-text-clip', $event)"
        />

        <!-- 按时间命中的字幕各一层；正在调位置的那条改由 draft 框绘制 -->
        <template v-if="showSubtitles">
          <div
            v-for="sub in passivePreviewSubtitles"
            :key="sub.id"
            class="pointer-events-none absolute overflow-hidden"
            :class="editingSubtitleId === sub.id ? 'z-[20]' : 'z-[5]'"
            :style="subtitleLayerStyle(sub)"
          >
            <div class="flex flex-col items-center justify-end text-center" :style="subtitleLayerTextStyle(sub)">
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
            </div>
          </div>
        </template>
        <template v-if="isAdjusting">
          <div class="pointer-events-none absolute z-[6]" :style="centerLineStyle" />
          <div
            class="absolute z-[6] flex cursor-move flex-col items-center justify-end select-none"
            :style="draftBoxStyle"
            @mousedown="startBoxDrag($event, 'move')"
          >
            <div
              ref="adjustSubtitleContentRef"
              class="w-full overflow-visible text-center break-words"
              :style="subtitleTextStyle"
            >
              <template v-for="sub in adjustPreviewSubtitles" :key="sub.id">
                <div
                  v-if="editingSubtitleId === sub.id"
                  :ref="(el) => setEditingEl(el)"
                  class="w-full cursor-text whitespace-pre-wrap break-words outline-none"
                  contenteditable="true"
                  @mousedown.stop
                  @input="onSubtitleEditInput"
                  @keydown.enter="onSubtitleEditEnter($event, sub.id)"
                  @keydown.esc.prevent="cancelSubtitleEdit"
                  @blur="commitSubtitleEdit(sub.id)"
                />
                <div
                  v-else
                  class="w-full cursor-move whitespace-pre-wrap break-words outline-none"
                  @dblclick.stop="beginSubtitleEdit(sub, true)"
                >
                  {{ sub.text }}
                </div>
              </template>
            </div>
            <div class="absolute top-0 bottom-0 -left-1 w-2 cursor-ew-resize" @mousedown.stop="startBoxDrag($event, 'left')" />
            <div class="absolute top-0 -right-1 bottom-0 w-2 cursor-ew-resize" @mousedown.stop="startBoxDrag($event, 'right')" />
            <button
              v-for="handle in subtitleCornerHandles"
              :key="handle.mode"
              type="button"
              class="absolute z-10 size-2 -translate-x-1/2 -translate-y-1/2 rounded-[1px] border border-white p-0"
              :style="{ left: handle.left, top: handle.top, cursor: handle.cursor, background: SUBTITLE_ADJUST_ACCENT }"
              :aria-label="handle.mode"
              @mousedown.stop="startBoxDrag($event, handle.mode)"
            />
          </div>
        </template>
      </div>

      <VideoComposeFrameBox
        ref="frameBoxRef"
        v-if="effectiveClips.length && stageFit.width && !catalogPreviewActive && !readonly && videoFrame"
        :frame="videoFrame"
        :canvas-width="canvasWidth || 0"
        :canvas-height="canvasHeight || 0"
        :stage-scale="stageScale"
        :offset-x="stageOffset.x"
        :offset-y="stageOffset.y"
        :stage-width="stageFit.width"
        :stage-height="stageFit.height"
        :active="showVideoFrameBox"
        @select="visibleClipId && emit('select-video-clip', visibleClipId)"
        @update:frame="emit('update:video-frame', $event)"
      />

      <div v-if="!effectiveClips.length" class="absolute inset-0 z-0 flex flex-col items-center justify-center text-[var(--compose-fg-3)]">
        <Video :size="48" class="mb-2" />
        <span class="text-sm">尚未生成视频内容</span>
      </div>
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
import { ref, computed, watch, nextTick, toRef, onBeforeUnmount, onMounted, type CSSProperties } from "vue";
import { Pause, Play, SkipBack, SkipForward, Video, Volume2, VolumeX } from "@lucide/vue";
import type {
  ComposeConfig,
  ComposeTextOverlayClip,
  PreviewAudioClip,
  SubtitleItem,
  SubtitleStyleConfig,
  VideoClipItem,
  VideoFrameTransform,
} from "@/types/videoCompose";
import { readBeautyParams } from "@/types/composeMedia";
import type { PreviewVideoSize } from "@/types/beautyPreview";
import { useVideoComposePreview } from "@/hooks/useVideoComposePreview";
import { useComposePreviewFrame } from "@/hooks/useComposePreviewFrame";
import {
  buildSubtitleOverlayStyle,
  buildSubtitleTextStyle,
  SUBTITLE_ADJUST_ACCENT,
  useVideoComposeSubtitleAdjust,
  type EnterSubtitleAdjustOptions,
  type SubtitleAdjustCommit,
} from "@/hooks/useVideoComposeSubtitleAdjust";
import { GPU_PIXEL_CANVAS_ID } from "@/utils/beauty/gpuPixelPreview";
import VideoComposeTextStickerOverlay from "./VideoComposeTextStickerOverlay.vue";
import VideoComposeFrameBox from "./VideoComposeFrameBox.vue";
import { containFrameStage, frameBoxStyle } from "../shared/videoFrame";
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
  /** 只读模式：禁止预览区双击改字幕，也不出调整框 */
  readonly?: boolean;
  /** 画布宽。字幕和贴图按这个像素定位 */
  canvasWidth?: number;
  /** 画布高 */
  canvasHeight?: number;
  /** 当前画面上的视频变换 */
  videoFrame?: VideoFrameTransform | null;
  /** 当前画面片段已选中 */
  showVideoFrameBox?: boolean;
  /** 当前画面上的视频 clip id */
  visibleClipId?: string;
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
  /** 拖动字幕框结束，边距和字号属于当前选中字幕 */
  "update:subtitle-position": [commit: SubtitleAdjustCommit];
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
  /** 点视频画面，选中当前片段 */
  "select-video-clip": [clipId: string];
  /** 拖拽或缩放后的画面变换 */
  "update:video-frame": [frame: VideoFrameTransform];
  /** 活动视频的原始像素 */
  "update:source-size": [payload: { clipId: string; width: number; height: number }];
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
/** 画幅画布。字幕和贴图相对它的边缘定位 */
const canvasHostRef = ref<HTMLElement | null>(null);
const frameBoxRef = ref<InstanceType<typeof VideoComposeFrameBox> | null>(null);
/** 预览区内容盒，用来把画布等比放进去 */
const stageBox = ref({ width: 0, height: 0 });
let stageObserver: ResizeObserver | null = null;

const stageFit = computed(() =>
  containFrameStage(stageBox.value.width, stageBox.value.height, props.canvasWidth || 0, props.canvasHeight || 0),
);

const stageScale = computed(() => stageFit.value.scale);

const stageStyle = computed(() => ({
  width: `${stageFit.value.width}px`,
  height: `${stageFit.value.height}px`,
}));

/** 黑色画布在预览区里的左上角。调整框按它偏移，才能画出画幅外 */
const stageOffset = computed(() => ({
  x: (stageBox.value.width - stageFit.value.width) / 2,
  y: (stageBox.value.height - stageFit.value.height) / 2,
}));

const videoBoxStyle = computed(() => {
  const frame = props.videoFrame;
  if (!frame || stageScale.value <= 0) return undefined;
  return frameBoxStyle(frame, props.canvasWidth || 0, props.canvasHeight || 0, stageScale.value);
});

/** 空白画面上的拖动。贴图和字幕盖在这层上面，不会被它抢走 */
function onVideoFramePointerDown(event: PointerEvent): void {
  frameBoxRef.value?.startDrag(event, "move");
}

/** 字幕和贴图用画布像素，不用视频元素的包围盒 */
const canvasSizeRef = computed<PreviewVideoSize | null>(() => {
  const width = props.canvasWidth || 0;
  const height = props.canvasHeight || 0;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
});
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

/** 活动层元数据就绪后记下原始像素，并交给画幅适配 */
function onDirectVideoMetadata(event: Event): void {
  const target = event.currentTarget;
  if (!(target instanceof HTMLVideoElement) || target !== activeVideoEl.value) return;
  directVideoSize.value = readDirectVideoSize(target);
  const clipId = effectiveClips.value[playingIdx.value]?.id;
  const size = directVideoSize.value;
  if (!clipId || !size) return;
  emit("update:source-size", { clipId, width: size.width, height: size.height });
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

/** 贴图像素尺寸：美颜用 Worker 回传，否则用活动 video。画布定位不使用它 */
const overlayVideoSize = computed<PreviewVideoSize | null>(() => (beautyPreviewOn.value ? videoSize.value : directVideoSize.value));

/** 添加贴图时用画布像素，使默认框钉在画幅上 */
function getVideoSize(): { width: number; height: number } | null {
  const width = props.canvasWidth || 0;
  const height = props.canvasHeight || 0;
  if (width > 0 && height > 0) return { width, height };
  const size = overlayVideoSize.value;
  if (!size || size.width <= 0 || size.height <= 0) return null;
  return { width: size.width, height: size.height };
}
const textClips = computed<ComposeTextOverlayClip[]>(() => props.textClips || []);

/** 当前选中贴图 id */
const selectedTextClipId = computed(() => props.selectedTextClipId ?? null);

/** 调整框测宽用文案（当前选中且命中时刻的字幕） */
const adjustPreviewText = computed(() => props.adjustPreviewSubtitles.map((sub) => sub.text).join("\n"));
/** 调整框文案容器，供换行后量高 */
const adjustSubtitleContentRef = ref<HTMLElement | null>(null);

const {
  isAdjusting,
  videoReady,
  enter,
  exit,
  startBoxDrag,
  syncDraftHeightToContent,
  contentRect,
  draftBoxStyle,
  centerLineStyle,
  subtitleTextStyle,
} = useVideoComposeSubtitleAdjust({
  videoSize: canvasSizeRef,
  containerEl: canvasHostRef,
  style: props.subtitleStyle,
  previewText: adjustPreviewText,
  contentEl: adjustSubtitleContentRef,
  onPausePlayback: pause,
  onPositionChange: (commit) => emit("update:subtitle-position", commit),
});

/** 进入字幕位置调整。pausePlayback 仅主动选中时传 true */
function enterAdjustSubPosition(opts?: EnterSubtitleAdjustOptions): void {
  if (props.readonly) return;
  void enter(opts);
}

/** 取消选中或离开字幕时退出位置调整 */
function exitAdjustSubPosition(): void {
  exit();
}

/** 非调整态：该条字幕的 absolute 定位 */
function subtitleLayerStyle(sub: SubtitleItem): CSSProperties {
  return buildSubtitleOverlayStyle({ marginL: sub.marginL, marginR: sub.marginR, marginV: sub.marginV }, contentRect.value);
}

/** 非调整态：该条字幕的屏幕字号与字色 */
function subtitleLayerTextStyle(sub: SubtitleItem): CSSProperties {
  return buildSubtitleTextStyle(sub, contentRect.value?.scale ?? 1);
}

/** 调整框四角缩放手柄。拖拽等比改框并改字号 */
const subtitleCornerHandles: Array<{ mode: "nw" | "ne" | "sw" | "se"; left: string; top: string; cursor: string }> = [
  { mode: "nw", left: "0%", top: "0%", cursor: "nwse-resize" },
  { mode: "ne", left: "100%", top: "0%", cursor: "nesw-resize" },
  { mode: "sw", left: "0%", top: "100%", cursor: "nesw-resize" },
  { mode: "se", left: "100%", top: "100%", cursor: "nwse-resize" },
];

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

/** 调整态仍显示其他命中字幕；正在拖的那条只留在 draft 框里 */
const passivePreviewSubtitles = computed<SubtitleItem[]>(() => {
  if (!isAdjusting.value) return previewSubtitles.value;
  const adjustingId = props.adjustPreviewSubtitles[0]?.id;
  if (!adjustingId) return previewSubtitles.value;
  return previewSubtitles.value.filter((sub) => sub.id !== adjustingId);
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

/** 是否允许预览区双击编辑字幕（调整态在 draft 框内改字） */
function canEditPreviewSubtitle(): boolean {
  return !props.readonly && !props.catalogPreviewActive;
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

/** 同步草稿，供卸载后 commit 使用；超长按框宽换行后钉底边长高 */
function onSubtitleEditInput(e: Event): void {
  const target = e.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  editingDraft = target.textContent || "";
  void nextTick(() => syncDraftHeightToContent());
}

/**
 * 进入预览字幕编辑。
 * @param selectAll 是否全选；调整框点击进入时不全选，避免抢焦点打断拖框
 */
function beginSubtitleEdit(sub: SubtitleItem, selectAll: boolean): void {
  if (props.readonly || props.catalogPreviewActive) return;
  if (editingSubtitleId.value === sub.id) return;
  if (editingSubtitleId.value) {
    commitSubtitleEdit(editingSubtitleId.value);
  }
  editingOriginText = sub.text || "";
  editingDraft = editingOriginText;
  pinnedEditingSubtitle.value = sub;
  editingSubtitleId.value = sub.id;
  void nextTick(() => {
    const el = editingEl.value;
    if (!el) return;
    el.textContent = editingOriginText;
    if (selectAll) selectElementText(el);
  });
}

/** 双击预览字幕：暂停、选中 clip、挂载编辑节点并全选 */
function onSubtitleDblClick(sub: SubtitleItem): void {
  if (!canEditPreviewSubtitle() || isAdjusting.value) return;
  pause();
  emit("select-subtitle-clip", sub.id);
  beginSubtitleEdit(sub, true);
}

/** Esc：还原原文；调整态保留编辑节点，非调整态退出 */
function cancelSubtitleEdit(): void {
  if (!editingSubtitleId.value) return;
  const el = editingEl.value;
  if (el) el.textContent = editingOriginText;
  editingDraft = editingOriginText;
  if (isAdjusting.value) {
    el?.blur();
    return;
  }
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
 * 调整态提交后保留编辑节点，便于继续改字。
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
    const stayAdjustEdit = isAdjusting.value;
    if (!text) {
      emit("update:subtitle-text", { clipId, text: "" });
      if (el) el.textContent = editingOriginText;
      editingDraft = editingOriginText;
      if (!stayAdjustEdit) exitSubtitleEdit();
      return;
    }
    if (text !== editingOriginText.trim()) {
      emit("update:subtitle-text", { clipId, text });
    }
    if (stayAdjustEdit) {
      editingOriginText = text;
      editingDraft = text;
      if (pinnedEditingSubtitle.value?.id === clipId) {
        pinnedEditingSubtitle.value = { ...pinnedEditingSubtitle.value, text };
      }
      return;
    }
    exitSubtitleEdit();
  } finally {
    queueMicrotask(() => {
      subtitleEditCommitting = false;
    });
  }
}

/** 退出调整或换选中条时提交编辑；进调整不自动改字，需双击框内文案 */
watch(
  () => [isAdjusting.value, props.adjustPreviewSubtitles[0]?.id ?? ""] as const,
  ([adjusting, subId], previous) => {
    if (!adjusting) {
      if (previous?.[0] && editingSubtitleId.value) {
        commitSubtitleEdit(editingSubtitleId.value);
      }
      return;
    }
    if (!subId) {
      if (editingSubtitleId.value) exitSubtitleEdit();
      return;
    }
    if (editingSubtitleId.value && editingSubtitleId.value !== subId) {
      commitSubtitleEdit(editingSubtitleId.value);
    }
  },
);

watch(
  () => props.catalogPreviewActive,
  (active) => {
    if (active && editingSubtitleId.value) {
      cancelSubtitleEdit();
    }
  },
);

onMounted(() => {
  const el = playerContainerRef.value;
  if (!el) return;
  const measure = () => {
    const host = playerContainerRef.value;
    if (!host) return;
    stageBox.value = { width: host.clientWidth, height: host.clientHeight };
  };
  stageObserver = new ResizeObserver(measure);
  stageObserver.observe(el);
  measure();
});

onBeforeUnmount(() => {
  stageObserver?.disconnect();
  stageObserver = null;
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
  enterAdjustSubPosition,
  exitAdjustSubPosition,
  startBoxDrag,
  isAdjusting,
  videoReady,
  getVideoSize,
});
</script>
