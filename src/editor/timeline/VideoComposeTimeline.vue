<template>
  <div
    ref="timelineRootRef"
    class="video-compose-timeline relative flex h-full min-h-0 flex-col overflow-hidden rounded-[16px] bg-[var(--compose-surface)] shadow-[var(--compose-shadow-card)]"
    :class="{ 'is-readonly': readonly, 'is-catalog-drag-over': catalogDragOver }"
    :style="hScrollbarAlignStyle"
    @pointerdown.capture="onTimelinePointerDown"
    @dragover.capture="onCatalogDragOver"
    @dragleave.capture="onCatalogDragLeave"
    @drop.capture="onCatalogDrop"
  >
    <VideoTrack
      ref="videoTrackRef"
      :operation-buttons="operationButtons"
      :scale-config-buttons="['snap']"
      :show-tools-bar="!readonly"
      :show-playback="false"
      :show-scale-control="false"
      :enable-main-track-mode="true"
      :enable-cross-track-drag="true"
      :enable-snap="true"
      :fps="DEFAULT_COMPOSE_TIMELINE_FPS"
      :pixels-per-second="80"
      :locale="locales['zh-CN']"
      :theme="clipTrackTheme"
      :clip-configs="clipTypeConfigs"
      :track-context-menu="trackContextMenuConfig"
      :clip-context-menu="clipContextMenuConfig"
      @data:changed="scheduleDataChanged"
      @track:added="onTrackAdded"
      @track:removed="onTrackRemoved"
      @clip:drag-end="scheduleDataChanged"
      @clip-move="scheduleDataChanged"
      @clip:added="scheduleDataChanged"
      @clip:removed="onClipRemoved"
      @clip:updated="scheduleDataChanged"
      @clip:resize-end="scheduleDataChanged"
      @clip-delete="onClipDelete"
      @clip-split="scheduleDataChanged"
      @clip-paste="scheduleDataChanged"
      @history:changed="scheduleDataChanged"
      @playback:timeupdate="onTimeUpdate"
      @playback:play="onPlaybackPlay"
      @playback:pause="onPlaybackPause"
      @playback:seek="onPlaybackSeek"
      @playback:ratechange="onPlaybackRateChange"
      @scale:changed="onScaleChanged"
      @scroll="onTrackScroll"
      @viewport:resize="onViewportResize"
      @selection:changed="onSelectionChanged"
      @clip:dblclick="onClipDblClick"
      @drop-media="onDropMedia"
    >
      <template #track-control="{ track }">
        <button
          v-if="track.type === 'audio'"
          type="button"
          class="track-control__btn track-control-extra-btn audio-track-mute-btn"
          :class="{ 'is-muted': isTrackMuted(track) }"
          :title="isTrackMuted(track) ? '取消静音' : '静音整轨'"
          :disabled="readonly"
          @pointerdown.stop
          @click.stop="toggleAudioTrackMute(track)"
        >
          <VolumeX v-if="isTrackMuted(track)" :size="16" />
          <Volume2 v-else :size="16" />
        </button>
        <button
          type="button"
          class="track-control__btn track-control-extra-btn"
          title="向前对齐"
          :disabled="readonly || track.locked"
          @pointerdown.stop
          @click.stop="alignTrackClipsForward(track)"
        >
          <AlignStartHorizontal :size="16" />
        </button>
      </template>

      <!-- 字幕 / 贴图 clip 自定义内容 -->
      <template #clip-content="{ clip }">
        <div
          v-if="clip.type === 'subtitle'"
          class="flex h-full w-full items-center px-1 text-xs text-white"
          :style="subtitleClipContentStyle(clip.id)"
          @mousedown="editingSubtitleId === clip.id && $event.stopPropagation()"
        >
          <div
            v-if="editingSubtitleId === clip.id"
            :ref="(el) => setEditingEl(el)"
            class="w-full break-all whitespace-pre-wrap outline-none text-white"
            contenteditable="true"
            @keydown.enter.prevent="commitSubtitleEdit"
            @keydown.esc.prevent="cancelSubtitleEdit"
            @blur="commitSubtitleEdit"
          />
          <div v-else class="w-full truncate text-white">{{ clipText(clip) }}</div>
        </div>
        <div
          v-else-if="clip.type === 'text'"
          class="flex h-full w-full items-center px-1 text-xs text-white"
          :style="{ background: TEXT_CLIP_BG }"
        >
          <div class="w-full truncate">{{ textClipLabel(clip) }}</div>
        </div>
      </template>
    </VideoTrack>
    <div class="flex h-10 shrink-0 items-center">
      <div class="shrink-0" :style="{ width: `${hScrollbarControlWidthPx}px` }" />
      <VideoComposeZoomBar
        :left-pct="zoomLeftPct"
        :width-pct="zoomWidthPct"
        :min-span-pct="zoomMinSpanPct"
        :disabled="zoomTotal <= 0"
        @change="onZoomChange"
        @end="onZoomEnd"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import { ElMessage } from "element-plus";
import { AlignStartHorizontal, Volume2, VolumeX } from "@lucide/vue";
import VideoComposeZoomBar from "./VideoComposeZoomBar.vue";
import { TIMELINE_END_GAP_PX } from "@/clip-track/utils/helpers";
import {
  VideoTrack,
  locales,
  generateId,
  type Track,
  type ThemeConfig,
  type VideoTrackProjectData,
  type OperationButton,
  type ClipContextMenuConfig,
  type TrackContextMenuConfig,
} from "@/clip-track";
import type {
  ComposeTrack,
  ComposeClip,
  ComposeSubtitleClip,
  VideoClipItem,
  BgmItem,
  SubtitleStyleConfig,
  ComposeSegmentClipAssets,
  ComposeMediaClipConfig,
  ComposeSubtitleAsset,
  ComposeTextTemplateDrag,
  ComposeFrameAspect,
} from "@/types/videoCompose";
import {
  DEFAULT_COMPOSE_TIMELINE_FPS,
  normalizeSubtitleClipStyle,
  mapMediaClipToVideoClipItem,
  COMPOSE_AUDIO_ASSET_DRAG_MIME,
  COMPOSE_SEGMENT_CLIP_DRAG_MIME,
  COMPOSE_SUBTITLE_ASSET_DRAG_MIME,
  COMPOSE_TEXT_TEMPLATE_DRAG_MIME,
  readClipConfig,
  TEXT_TEMPLATE_TRACK_TYPE,
  TEXT_TEMPLATE_TRACK_NAME,
  DEFAULT_TEXT_CLIP_DURATION_SEC,
  createDefaultTextClipRect,
  normalizeComposeTimelineScale,
} from "@/types/videoCompose";
import { normalizeFrameAspect } from "../shared/videoFrame";
import { clampPlaybackRate } from "../shared/playbackRate";
import type { MediaClip, SubtitleClip, TextClip, Clip, ClipTypeConfig } from "@/clip-track";

/** 可批量改属性的 clip 类型 */
export type PatchableClipType = "video" | "audio" | "subtitle" | "text";

/** 批量改 clip 的作用范围：clipId 优先于 trackId，都空则改该类型全部 clip */
export interface PatchClipsByTypeOptions {
  /** 只改这一条 clip */
  clipId?: string;
  /** 只改该轨上匹配 type 的 clip */
  trackId?: string;
}

/** VideoTrack 实例暴露的方法子集 */
interface VideoTrackExpose {
  exportData: () => VideoTrackProjectData;
  importData: (data: VideoTrackProjectData) => void;
  addTrack: (track: Track) => void;
  removeTrack: (trackId: string) => void;
  updateTrack: (trackId: string, updates: Partial<Track>) => void;
  getTracks: () => Track[];
  getMainTrack: () => Track | undefined;
  addClip: (trackId: string, clip: Record<string, unknown>) => void;
  removeClip: (clipId: string) => void;
  updateClip: (clipId: string, updates: Record<string, unknown>) => void;
  getClipById: (clipId: string) => Clip | undefined;
  selectClip: (clipId: string, append?: boolean) => void;
  getSelectedClips: () => Clip[];
  getSelectedClipIds: () => string[];
  getCurrentTime: () => number;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  seekTo: (time: number) => void;
  setPlaybackRate: (rate: number) => void;
  getPlaybackRate: () => number;
  isPlaying: () => boolean;
  getDuration?: () => number;
  getScale?: () => number;
  setScale?: (scale: number) => void;
  getScrollLeft?: () => number;
  setScrollLeft?: (left: number) => void;
  getViewportWidth?: () => number;
  reset: () => void;
}

type TrackWithMute = Track & {
  muted?: boolean;
  frameAspect?: ComposeFrameAspect;
  nativeFrameWidth?: number;
  nativeFrameHeight?: number;
};

/** 时间轴外壳入参。导出后声明文件才能引用，避免生成 d.ts 时 Props 无法命名 */
export interface VideoComposeTimelineProps {
  /** 多轨列表（对齐 ComposeTrack） */
  tracks: ComposeTrack[];
  /** 只读：隐藏工具栏操作与菜单 */
  readonly?: boolean;
  /** 工程持久化的时间轴倍率；缺省 1 */
  scale?: number;
}

const props = withDefaults(defineProps<VideoComposeTimelineProps>(), {
  readonly: false,
  scale: 1,
});

const emit = defineEmits<{
  "update:tracks": [value: ComposeTrack[]];
  "selection-changed": [selectedClipIds: string[]];
  "time-update": [timeSec: number];
  /** 时间线工具栏播放 */
  "playback-play": [];
  /** 时间线工具栏暂停 */
  "playback-pause": [];
  /** 时间线 seek / 拖尺 */
  "playback-seek": [timeSec: number];
  /** 时间线全局倍速变更 */
  "playback-ratechange": [rate: number];
  /** 侧栏素材库版本拖入主轨 */
  "drop-catalog-clip": [payload: { variant: ComposeSegmentClipAssets; startTime: number }];
  /** 音频或音效拖入音频轨 */
  "drop-audio-asset": [payload: { item: BgmItem; startTime: number }];
  /** 字幕素材拖入字幕轨 */
  "drop-subtitle-asset": [payload: { item: ComposeSubtitleAsset; startTime: number }];
  /** 花字拖入贴图轨 */
  "drop-text-template": [payload: { item: ComposeTextTemplateDrag; startTime: number }];
  /** 本地媒体文件拖入轨道（vue-clip-track 原生） */
  "drop-media": [payload: { mediaData: unknown; trackId: string; startTime: number }];
  /** 时间轴显示倍率变更（写入工程 JSON） */
  "update:scale": [scale: number];
  /** 点轨道头或片段时，把轨道/片段类型交给右栏 */
  "inspect-track": [trackType: string];
}>();

const videoTrackRef = ref<VideoTrackExpose | null>(null);
/** 时间轴根节点：用于拖放命中与坐标换算 */
const timelineRootRef = ref<HTMLElement | null>(null);
/** 视口尺寸变化时重算缩放条 */
let zoomResizeObserver: ResizeObserver | null = null;
/** 侧栏素材拖入时高亮时间轴 */
const catalogDragOver = ref(false);

/** VideoTrack 每秒像素基数（与 props pixels-per-second 一致） */
const TIMELINE_BASE_PPS = 80;
/** 轨道左侧控制栏宽度（与 props track-control-width 一致） */
const TIMELINE_TRACK_CONTROL_WIDTH = 276;
/** Ctrl/⌘+滚轮缩放底数：deltaY=100 时约 10%（与工具栏在 1x 的 0.1 步接近） */
const TIMELINE_ZOOM_FACTOR = 1.1;

/** 正在就地编辑的字幕 clip id */
const editingSubtitleId = ref<string | null>(null);
/** contenteditable 节点 */
const editingEl = ref<HTMLElement | null>(null);
/** 进入编辑时的原文，取消/空提交时回退 */
let editingOriginText = "";
/** 防止 Enter + blur 双提交 */
let subtitleEditCommitting = false;

/** 避免 data:changed → emit → props 回灌造成循环 */
let suppressEmit = false;
/** 外部 seekTo 回写游标时抑制向上转发，避免与 Player 死循环 */
let suppressSeekEmit = false;
/** 是否已完成首次主轨 bootstrap */
let bootstrapped = false;

/** 合并连发编辑事件的 debounce 定时器 */
let dataChangedTimer: number | null = null;
/** 时间线内 pointerdown 后，等待 pointerup 再同步（兜底裁剪无事件） */
let pendingPointerSync = false;
/** pointerup 兜底同步 debounce */
let pointerSyncTimer: number | null = null;

/** 编辑事件合并间隔（ms） */
const DATA_CHANGED_DEBOUNCE_MS = 50;
/** 裁剪 pointerup 兜底间隔（ms） */
const POINTER_SYNC_DEBOUNCE_MS = 100;

const operationButtons: OperationButton[] = ["undo", "redo", "split", "delete"];

/** 片段色靠近设计稿：视频中性、音频成功、字幕警告、贴图蓝 */
const clipTypeConfigs: ClipTypeConfig = {
  video: {
    backgroundColor: "#1F1F30",
    selected: { borderColor: "#8261FF", boxShadow: "0 0 0 2px rgba(130, 97, 255, 0.45)" },
  },
  audio: {
    backgroundColor: "linear-gradient(135deg, #2FC77E 0%, #1FAE69 100%)",
    selected: { borderColor: "#8261FF", boxShadow: "0 0 0 2px rgba(130, 97, 255, 0.45)" },
  },
  subtitle: {
    backgroundColor: "#E8960F",
    selected: { borderColor: "#8261FF", boxShadow: "0 0 0 2px rgba(130, 97, 255, 0.45)" },
  },
  text: {
    backgroundColor: "#3D7BFF",
    name: "贴图",
    selected: { borderColor: "#8261FF", boxShadow: "0 0 0 2px rgba(130, 97, 255, 0.45)" },
  },
};

/** clip 删除前 config 快照，供删除联动 */
const clipConfigBeforeRemove = new Map<string, ComposeMediaClipConfig>();

/** 删除原声 clip / 原声轨后：解除 video 分离关联，保持静音不恢复内嵌原声 */
function restoreVideoAfterAudioRemoved(videoClipId: string): void {
  const api = videoTrackRef.value;
  if (!api) return;
  const videoClip = findMediaClipById(videoClipId);
  if (!videoClip || videoClip.type !== "video") return;
  const videoConfig = readClipConfig(videoClip.config);
  suppressEmit = true;
  api.updateClip(videoClipId, {
    config: {
      ...videoConfig,
      audioDetached: false,
      linkedAudioClipId: undefined,
    },
  });
  suppressEmit = false;
}

/** 删除 video 后保留原声 clip，仅清除 audio 上的 linkedVideoClipId */
function orphanDetachedAudioAfterVideoRemoved(audioClipId: string): void {
  const api = videoTrackRef.value;
  if (!api) return;
  const audioClip = findMediaClipById(audioClipId);
  if (!audioClip || audioClip.type !== "audio") return;
  const audioConfig = readClipConfig(audioClip.config);
  api.updateClip(audioClipId, {
    config: {
      ...audioConfig,
      linkedVideoClipId: undefined,
    },
  });
}

/** 内置复制/剪切/删除 */
const clipContextMenuConfig = computed((): ClipContextMenuConfig => {
  if (props.readonly) {
    return { showCommonItems: false, commonItems: [] };
  }
  return {
    showCommonItems: true,
    commonItems: ["copy", "cut", "delete"],
  };
});

/** 轨道右键：粘贴 / 锁定 / 删除整轨（主轨由库拦截，不会真正删除） */
const trackContextMenuConfig = computed((): TrackContextMenuConfig => {
  if (props.readonly) {
    return { enabled: false };
  }
  const zh = locales["zh-CN"];
  return {
    enabled: true,
    items: [
      { key: "paste", label: zh.paste || "粘贴", icon: "📋", shortcut: "Ctrl+V" },
      { key: "divider-1", label: "", divider: true },
      { key: "lockTrack", label: zh.lockTrack || "锁定轨道", icon: "🔒" },
      { key: "deleteTrack", label: zh.deleteTrack || "删除轨道", icon: "🗑️", danger: true },
    ],
  };
});

/** 是否处于应用深色模式（跟随 html.dark，由 Main.vue 切换） */
const isDark = ref(typeof document !== "undefined" && document.documentElement.classList.contains("dark"));

/** 监听 html class 变化以同步深/浅色 */
let themeObserver: MutationObserver | null = null;

/**
 * 缩放条左侧留白跟轨道头实宽走。静音、对齐按钮可能把控制栏撑过 180。
 */
const hScrollbarControlWidthPx = ref(TIMELINE_TRACK_CONTROL_WIDTH);

/** 根节点 CSS 变量，缩放条左缘与轨道头对齐 */
const hScrollbarAlignStyle = computed(
  (): Record<string, string> => ({
    "--timeline-track-control-width": `${hScrollbarControlWidthPx.value}px`,
  }),
);

/** 控制栏单元格尺寸变化时更新假横向条左缘 */
let hScrollbarAlignResizeObserver: ResizeObserver | null = null;
/** 轨表晚于 mount 才插入时重绑 ResizeObserver */
let hScrollbarAlignMutationObserver: MutationObserver | null = null;
/** 当前正在观察的控制栏单元格 */
let hScrollbarAlignCell: HTMLElement | null = null;

/** 写入控制栏实宽；无变化则跳过 */
function applyHScrollbarControlWidth(widthPx: number): void {
  if (widthPx <= 0) return;
  const rounded = Math.round(widthPx);
  if (rounded === hScrollbarControlWidthPx.value) return;
  hScrollbarControlWidthPx.value = rounded;
}

/** 绑到当前控制栏单元格；同一节点不重复 observe */
function attachHScrollbarAlignObserver(): void {
  const root = timelineRootRef.value;
  if (!root) return;
  const cell = root.querySelector(".tracks__track-control-cell");
  if (!(cell instanceof HTMLElement)) return;
  if (hScrollbarAlignCell === cell) return;
  hScrollbarAlignCell = cell;
  hScrollbarAlignResizeObserver?.disconnect();
  hScrollbarAlignResizeObserver = new ResizeObserver(() => {
    if (!hScrollbarAlignCell) return;
    applyHScrollbarControlWidth(hScrollbarAlignCell.getBoundingClientRect().width);
  });
  hScrollbarAlignResizeObserver.observe(cell);
  applyHScrollbarControlWidth(cell.getBoundingClientRect().width);
}

/** 启动假横向条对齐：单元格晚出现时靠 MutationObserver 补绑 */
function startHScrollbarAlign(): void {
  const root = timelineRootRef.value;
  if (!root) return;
  attachHScrollbarAlignObserver();
  hScrollbarAlignMutationObserver?.disconnect();
  hScrollbarAlignMutationObserver = new MutationObserver(() => {
    attachHScrollbarAlignObserver();
  });
  hScrollbarAlignMutationObserver.observe(root, { childList: true, subtree: true });
}

/** 卸假横向条对齐观察 */
function stopHScrollbarAlign(): void {
  hScrollbarAlignResizeObserver?.disconnect();
  hScrollbarAlignResizeObserver = null;
  hScrollbarAlignMutationObserver?.disconnect();
  hScrollbarAlignMutationObserver = null;
  hScrollbarAlignCell = null;
}

/** 贴近合成页浅色卡片的主题（边框/弱文字加深刻度与轨控可见） */
const lightTheme: ThemeConfig = {
  primaryColor: "#7650FF",
  primaryHue: 252,
  primarySaturation: 100,
  primaryLightness: 66,
  bgDark: "#F6F6F8",
  bgMedium: "#FFFFFF",
  bgLight: "#F0F0F4",
  bgElevated: "#E6E6EC",
  textPrimary: "#0E0E11",
  textSecondary: "#5B5B66",
  textMuted: "#8E8E99",
  borderColor: "rgba(14, 14, 17, 0.10)",
};

/** 深色表面与强调色，和合成器外壳同一套 */
const darkTheme: ThemeConfig = {
  primaryColor: "#8261FF",
  primaryHue: 255,
  primarySaturation: 100,
  primaryLightness: 69,
  bgDark: "#0A0A0F",
  bgMedium: "#141420",
  bgLight: "#1A1A28",
  bgElevated: "#1F1F30",
  textPrimary: "#FFFFFF",
  textSecondary: "#A3A3AD",
  textMuted: "#6C6C76",
  borderColor: "rgba(255, 255, 255, 0.10)",
};

/** 按应用主题切换传给 VideoTrack 的 ThemeConfig */
const clipTrackTheme = computed(() => (isDark.value ? darkTheme : lightTheme));

/** 库 Clip → ComposeClip（MediaClip | ComposeSubtitleClip） */
function mapLibClipToCompose(clip: Track["clips"][number]): ComposeClip | null {
  if (clip.type === "subtitle") {
    const sub = clip as SubtitleClip & Partial<SubtitleStyleConfig> & { visible?: boolean };
    const style = normalizeSubtitleClipStyle(sub);
    const result: ComposeSubtitleClip = {
      id: sub.id,
      trackId: sub.trackId,
      type: "subtitle",
      name: sub.name,
      text: sub.text || "",
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      color: style.color,
      bold: style.bold,
      italic: style.italic,
      alignment: style.alignment,
      marginL: style.marginL,
      marginR: style.marginR,
      marginV: style.marginV,
      backgroundColor: sub.backgroundColor,
      textAlign: sub.textAlign,
      startTime: sub.startTime,
      endTime: sub.endTime,
      selected: Boolean(sub.selected),
      visible: style.visible,
      opacity: sub.opacity,
      rect: sub.rect,
      config: sub.config,
    };
    return result;
  }
  if (clip.type === "text") {
    const textClip = clip as TextClip;
    const result: TextClip = {
      id: textClip.id,
      trackId: textClip.trackId,
      type: "text",
      name: textClip.name,
      text: textClip.text || "",
      fontFamily: textClip.fontFamily,
      fontSize: textClip.fontSize,
      color: textClip.color,
      backgroundColor: textClip.backgroundColor,
      startTime: textClip.startTime,
      endTime: textClip.endTime,
      selected: Boolean(textClip.selected),
      visible: textClip.visible,
      opacity: textClip.opacity,
      rect: textClip.rect,
      config: textClip.config,
      zIndex: textClip.zIndex,
      animations: textClip.animations,
    };
    return result;
  }
  if (clip.type !== "video" && clip.type !== "audio") return null;
  const media = clip as MediaClip;
  return {
    id: media.id,
    trackId: media.trackId,
    type: media.type,
    name: media.name,
    sourceUrl: media.sourceUrl || "",
    originalDuration: media.originalDuration ?? Math.max(0.1, media.endTime - media.startTime),
    trimStart: media.trimStart ?? 0,
    trimEnd: media.trimEnd ?? media.originalDuration ?? media.endTime - media.startTime,
    playbackRate: media.playbackRate ?? 1,
    volume: media.volume,
    startTime: media.startTime,
    endTime: media.endTime,
    selected: Boolean(media.selected),
    visible: media.visible,
    opacity: media.opacity,
    rect: media.rect,
    thumbnails: media.thumbnails,
    waveformData: media.waveformData,
    config: media.config,
  };
}

/** 库 Track → ComposeTrack */
function mapLibTrackToCompose(track: Track): ComposeTrack | null {
  if (track.type !== "video" && track.type !== "audio" && track.type !== "subtitle" && track.type !== TEXT_TEMPLATE_TRACK_TYPE) {
    return null;
  }
  const clips = (track.clips || []).map((c) => mapLibClipToCompose(c)).filter((c): c is ComposeClip => Boolean(c));
  return {
    id: track.id,
    type: track.type,
    name: track.name,
    isMain: track.isMain,
    visible: track.visible !== false,
    locked: Boolean(track.locked),
    muted: Boolean((track as TrackWithMute).muted),
    clips,
    order: track.order ?? 0,
    frameAspect: readTrackFrameAspect(track),
    nativeFrameWidth: readPositiveFrameSize(track, "nativeFrameWidth"),
    nativeFrameHeight: readPositiveFrameSize(track, "nativeFrameHeight"),
  };
}

/** exportData → ComposeTrack[] */
function exportTracks(): ComposeTrack[] {
  const api = videoTrackRef.value;
  if (!api) return [];
  const project = api.exportData();
  return (project.tracks || []).map((t) => mapLibTrackToCompose(t as Track)).filter((t): t is ComposeTrack => Boolean(t));
}

/**
 * 将库内最新 tracks 同步给父级。
 * vue-clip-track 的 data:changed 仅在 importData 时触发，拖动/删除等需靠其它事件主动调用。
 */
function onDataChanged(): void {
  if (suppressEmit) return;
  removeEmptyNonMainTracks();
  refreshClipConfigCache();
  emit("update:tracks", exportTracks());
  if (!zoomGesture) readZoomView();
}

/** 非主轨且无有效 clip（忽略 transition）则删除 */
function removeEmptyNonMainTracks(): void {
  const api = videoTrackRef.value;
  if (!api) return;
  const emptyIds = api
    .getTracks()
    .filter((track) => !track.isMain && !(track.clips || []).some((clip) => clip.type !== "transition"))
    .map((track) => track.id);
  for (const id of emptyIds) {
    api.removeTrack(id);
  }
}

/** 音频轨是否整轨静音 */
function isTrackMuted(track: Track): boolean {
  return Boolean((track as TrackWithMute).muted);
}

/** 切换音频轨静音并同步预览 / 持久化 */
function toggleAudioTrackMute(track: Track): void {
  if (props.readonly || track.type !== "audio") return;
  const api = videoTrackRef.value;
  if (!api) return;
  api.updateTrack(track.id, { muted: !isTrackMuted(track) } as Partial<Track>);
  onDataChanged();
}

/**
 * 将轨道内 clip 向前对齐：按 startTime 排序后从 0 起依次贴紧，消除间隙。
 * 只改 startTime/endTime，单段时长不变；不联动其它轨（含分离原声）。
 */
function alignTrackClipsForward(track: Track): void {
  if (props.readonly || track.locked) return;
  const api = videoTrackRef.value;
  if (!api) return;

  const live = api.getTracks().find((item) => item.id === track.id) || track;
  if (live.locked) return;

  const sorted = [...(live.clips || [])].filter((clip) => clip.type !== "transition").sort((a, b) => a.startTime - b.startTime);
  if (!sorted.length) return;

  let cursor = 0;
  let moved = false;
  suppressEmit = true;
  for (const clip of sorted) {
    const duration = Math.max(0.1, clip.endTime - clip.startTime);
    if (Math.abs(clip.startTime - cursor) > 1e-3) {
      api.updateClip(clip.id, {
        startTime: cursor,
        endTime: cursor + duration,
      });
      moved = true;
    }
    cursor += duration;
  }
  suppressEmit = false;
  if (moved) onDataChanged();
}

/** 缓存各 clip.config，clip:removed 时仍可读到关联 id */
function refreshClipConfigCache(): void {
  clipConfigBeforeRemove.clear();
  const api = videoTrackRef.value;
  if (!api) return;
  for (const track of api.getTracks()) {
    for (const clip of track.clips) {
      const cfg = readClipConfig(clip.config);
      if (Object.keys(cfg).length > 0) {
        clipConfigBeforeRemove.set(clip.id, { ...cfg });
      }
    }
  }
}

/** 合并短时间连发的编辑事件，减少 Editor resync 抖动 */
function scheduleDataChanged(): void {
  if (suppressEmit || props.readonly) return;
  if (dataChangedTimer != null) window.clearTimeout(dataChangedTimer);
  dataChangedTimer = window.setTimeout(() => {
    dataChangedTimer = null;
    onDataChanged();
  }, DATA_CHANGED_DEBOUNCE_MS);
}

/** 时间线内按下：标记可能发生裁剪/拖动，松手后兜底同步。点轨道头或片段时通知右栏 */
function onTimelinePointerDown(e: PointerEvent): void {
  if (props.readonly || suppressEmit) return;
  // 仅响应主键，忽略滚动条等非编辑指针
  if (e.button !== 0) return;
  pendingPointerSync = true;
  emitInspectTarget(e);
}

/** 点片段或轨道名称时切换右栏。轨道上的按钮仍走原来的静音、锁定、删除 */
function emitInspectTarget(e: PointerEvent): void {
  const target = e.target;
  if (!(target instanceof Element)) return;
  const clipId = target.closest("[data-clip-id]")?.getAttribute("data-clip-id");
  if (clipId) {
    const clipType = findClipType(clipId);
    if (clipType) emit("inspect-track", clipType);
    return;
  }
  if (target.closest("button, input, textarea, select")) return;
  const cell = target.closest(".tracks__track-control-cell");
  if (!cell) return;
  const trackId = cell.closest(".tracks__track")?.getAttribute("data-track-id");
  if (!trackId) return;
  const track = videoTrackRef.value?.getTracks?.().find((item) => item.id === trackId);
  if (!track?.type) return;
  emit("inspect-track", track.type);
}

/** 从当前轨道列表里找片段类型 */
function findClipType(clipId: string): string | null {
  const tracks = videoTrackRef.value?.getTracks?.() ?? [];
  for (const track of tracks) {
    const clip = track.clips.find((item) => item.id === clipId);
    if (clip?.type) return clip.type;
  }
  return null;
}

/** window pointerup：裁剪结束库往往不发事件，靠此兜底 export */
function onWindowPointerUp(): void {
  if (!pendingPointerSync) return;
  pendingPointerSync = false;
  if (props.readonly || suppressEmit) return;
  if (pointerSyncTimer != null) window.clearTimeout(pointerSyncTimer);
  pointerSyncTimer = window.setTimeout(() => {
    pointerSyncTimer = null;
    onDataChanged();
  }, POINTER_SYNC_DEBOUNCE_MS);
}

function onTimeUpdate(time: number): void {
  if (suppressSeekEmit) return;
  emit("time-update", time);
}

function onPlaybackPlay(): void {
  emit("playback-play");
}

function onPlaybackPause(): void {
  emit("playback-pause");
}

function onPlaybackSeek(time: number): void {
  if (suppressSeekEmit) return;
  emit("playback-seek", time);
}

function onPlaybackRateChange(rate: number): void {
  emit("playback-ratechange", rate);
}

/** 库倍率变更；挂载 reset 期间不向上抛，避免空轨覆盖工程 JSON */
function onScaleChanged(scale: number): void {
  if (!bootstrapped) return;
  emit("update:scale", normalizeComposeTimelineScale(scale));
  if (!zoomGesture) readZoomView();
}

/** 缩放条拖动中，忽略滚动回写，避免滑块被自己的 setScrollLeft 拽回去 */
let zoomGesture = false;
/** 可视区间（秒） */
const zoomView = ref({ v0: 0, v1: 0, total: 0 });
/** 区间最短秒数。再短就看不清片段 */
const ZOOM_MIN_SPAN_SEC = 2;

const zoomTotal = computed(() => zoomView.value.total);
const zoomLeftPct = computed(() => (zoomView.value.total > 0 ? (zoomView.value.v0 / zoomView.value.total) * 100 : 0));
const zoomWidthPct = computed(() => {
  if (zoomView.value.total <= 0) return 100;
  return ((zoomView.value.v1 - zoomView.value.v0) / zoomView.value.total) * 100;
});
/** 两端不能拖到比最短区间更近 */
const zoomMinSpanPct = computed(() => {
  if (zoomView.value.total <= 0) return 100;
  const raw = videoTrackRef.value?.getViewportWidth?.() ?? 1;
  const viewW = Math.max(1, raw - TIMELINE_END_GAP_PX);
  const minByScale = viewW / (TIMELINE_BASE_PPS * 10);
  const minSpan = Math.min(zoomView.value.total, Math.max(ZOOM_MIN_SPAN_SEC, minByScale));
  return (minSpan / zoomView.value.total) * 100;
});

/** 时间像素可用的视口：扣掉右侧留白，铺满时滑块才能贴边 */
function timeViewportWidth(api: VideoTrackExpose): number {
  const viewW = Math.max(api.getViewportWidth?.() ?? 1, 1);
  return Math.max(1, viewW - TIMELINE_END_GAP_PX);
}

/** 用当前倍率和滚动反推可视区间 */
function readZoomView(): void {
  const api = videoTrackRef.value;
  const total = Math.max(0, api?.getDuration?.() ?? 0);
  if (!api || total <= 0) {
    zoomView.value = { v0: 0, v1: 0, total: 0 };
    return;
  }
  const viewW = timeViewportWidth(api);
  const scale = normalizeComposeTimelineScale(api.getScale?.() ?? 1);
  const pps = TIMELINE_BASE_PPS * scale;
  const span = Math.min(total, Math.max(viewW / pps, 0.001));
  const v0 = Math.min(Math.max(0, (api.getScrollLeft?.() ?? 0) / pps), Math.max(0, total - span));
  zoomView.value = { v0, v1: v0 + span, total };
}

/** 滑块百分比写回倍率和平移。盖住全部时长时按真实时长铺满并留出右侧空白 */
function applyZoomRange(leftPct: number, rightPct: number): void {
  const api = videoTrackRef.value;
  const total = zoomView.value.total;
  if (!api || total <= 0) return;
  const viewW = timeViewportWidth(api);
  const coversAll = rightPct - leftPct >= 99.5;
  if (coversAll) {
    const scale = normalizeComposeTimelineScale(viewW / total / TIMELINE_BASE_PPS);
    api.setScale?.(scale);
    api.setScrollLeft?.(0);
    zoomView.value = { v0: 0, v1: total, total };
    return;
  }
  const minByScale = viewW / (TIMELINE_BASE_PPS * 10);
  const maxByScale = viewW / (TIMELINE_BASE_PPS * 0.1);
  let span = ((rightPct - leftPct) / 100) * total;
  span = Math.min(total, Math.max(span, Math.min(total, Math.max(ZOOM_MIN_SPAN_SEC, minByScale))));
  span = Math.min(span, maxByScale);
  let v0 = (leftPct / 100) * total;
  v0 = Math.min(Math.max(0, v0), Math.max(0, total - span));
  const scale = normalizeComposeTimelineScale(viewW / span / TIMELINE_BASE_PPS);
  api.setScale?.(scale);
  const pps = TIMELINE_BASE_PPS * (api.getScale?.() ?? scale);
  api.setScrollLeft?.(v0 * pps);
  zoomView.value = { v0, v1: v0 + span, total };
}

/** 拖动中先记住手势，避免滚动事件把滑块打回旧位置 */
function onZoomChange(leftPct: number, rightPct: number): void {
  zoomGesture = true;
  applyZoomRange(leftPct, rightPct);
}

/** 松手后按真实倍率重读一次 */
function onZoomEnd(): void {
  zoomGesture = false;
  readZoomView();
}

/** 轨道自己滚动时，滑块跟着走 */
function onTrackScroll(): void {
  if (zoomGesture) return;
  readZoomView();
}

/** 视口变宽变窄时重算滑块。拖动中不打断手势 */
function onViewportResize(): void {
  if (zoomGesture) return;
  readZoomView();
}

/** 把工程 JSON 的倍率写回库（reset 会清 store / localStorage） */
function applyProjectScale(): void {
  videoTrackRef.value?.setScale?.(normalizeComposeTimelineScale(props.scale));
}

/** 把 wheel 的 line/page 增量换算成像素，便于统一灵敏度 */
function normalizeWheelDeltaY(event: WheelEvent): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * 100;
  return event.deltaY;
}

/**
 * Ctrl/⌘+滚轮缩放时间轴；只改倍率、不改 scrollLeft，与工具栏 +/- 一致（t=0 首帧不位移）。
 * 未按修饰键不拦截，保留轨道区竖向滚动。
 */
function onTimelineWheel(event: WheelEvent): void {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  event.stopPropagation();

  const api = videoTrackRef.value;
  if (!api?.setScale || !api.getScale) return;

  const oldScale = normalizeComposeTimelineScale(api.getScale());
  const factor = TIMELINE_ZOOM_FACTOR ** (-normalizeWheelDeltaY(event) / 100);
  const newScale = normalizeComposeTimelineScale(oldScale * factor);
  if (newScale === oldScale) return;

  api.setScale(newScale);
}

/** 清 Pinia 轨残留后立刻恢复工程倍率 */
function resetTimelineKeepingScale(): void {
  const api = videoTrackRef.value;
  if (!api) return;
  api.reset();
  ensureMainTrack();
  applyProjectScale();
}

/** 由 Player 时钟回写时间线游标（不反向触发 seek Player） */
function seekTo(timeSec: number): void {
  const api = videoTrackRef.value;
  if (!api?.seekTo) return;
  suppressSeekEmit = true;
  try {
    api.seekTo(timeSec);
  } finally {
    // 下一帧再放开，避免同 tick 内 timeupdate/seek 回灌
    requestAnimationFrame(() => {
      suppressSeekEmit = false;
    });
  }
}

/** 长按方向键：延迟后再加速 */
const PLAYHEAD_HOLD_DELAY_MS = 400;
/** 长按步进间隔 */
const PLAYHEAD_HOLD_INTERVAL_MS = 50;
/** 长按每次跳动的帧数 */
const PLAYHEAD_HOLD_FRAMES = 8;

let playheadHoldDelayTimer: number | null = null;
let playheadHoldIntervalTimer: number | null = null;
let playheadHoldDir: -1 | 1 | null = null;

/** 输入框 / 字幕编辑中不抢方向键 */
function isEditableKeyTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }
  if (target.isContentEditable || target.getAttribute("contenteditable") === "true") return true;
  return Boolean(target.closest("[contenteditable='true']"));
}

/** 清长按加速定时器 */
function clearPlayheadHold(): void {
  if (playheadHoldDelayTimer != null) {
    window.clearTimeout(playheadHoldDelayTimer);
    playheadHoldDelayTimer = null;
  }
  if (playheadHoldIntervalTimer != null) {
    window.clearInterval(playheadHoldIntervalTimer);
    playheadHoldIntervalTimer = null;
  }
  playheadHoldDir = null;
}

/**
 * 键盘移动光标：调库 seekTo 且不设 suppressSeekEmit，以便 playback:seek 驱动预览。
 * 用整数帧对齐，避免 ±1/fps 浮点漂移。
 */
function seekPlayheadFromKeyboard(deltaFrames: number): void {
  const api = videoTrackRef.value;
  if (!api?.seekTo) return;
  const current = api.getCurrentTime?.() ?? 0;
  const duration = api.getDuration?.() ?? 0;
  const fps = DEFAULT_COMPOSE_TIMELINE_FPS;
  const frame = Math.round(current * fps) + deltaFrames;
  const maxTime = duration > 0 ? duration : Number.POSITIVE_INFINITY;
  const next = Math.max(0, Math.min(frame / fps, maxTime));
  api.seekTo(next);
}

/** document capture：拦住库 adjustTime(±0.1)，组件挂载期间全局生效（不要求 hover） */
function onDocumentPlayheadKeyDown(event: KeyboardEvent): void {
  if (event.code !== "ArrowLeft" && event.code !== "ArrowRight") return;
  if (isEditableKeyTarget(event.target)) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat) return;
  const dir: -1 | 1 = event.code === "ArrowLeft" ? -1 : 1;
  clearPlayheadHold();
  playheadHoldDir = dir;
  seekPlayheadFromKeyboard(dir);
  playheadHoldDelayTimer = window.setTimeout(() => {
    playheadHoldDelayTimer = null;
    playheadHoldIntervalTimer = window.setInterval(() => {
      if (playheadHoldDir == null) return;
      seekPlayheadFromKeyboard(playheadHoldDir * PLAYHEAD_HOLD_FRAMES);
    }, PLAYHEAD_HOLD_INTERVAL_MS);
  }, PLAYHEAD_HOLD_DELAY_MS);
}

function onWindowPlayheadKeyUp(event: KeyboardEvent): void {
  if (event.code !== "ArrowLeft" && event.code !== "ArrowRight") return;
  clearPlayheadHold();
}

function onWindowPlayheadBlur(): void {
  clearPlayheadHold();
}

function onPlayheadVisibilityChange(): void {
  if (document.visibilityState !== "visible") clearPlayheadHold();
}

/** 选中变化：通知父级以驱动侧栏作用域 */
function onSelectionChanged(selectedClipIds: string[]): void {
  emit("selection-changed", selectedClipIds || []);
}

/** 对齐 vue-clip-track `.subtitle-clip` 的黄底（仅正常态） */
const SUBTITLE_CLIP_BG = "#E8960F";
/** 贴图 TextClip 色块底（与 clipTypeConfigs.text.backgroundColor 一致） */
const TEXT_CLIP_BG = "#3D7BFF";

/**
 * 字幕 slot 外层样式：正常态黄底白字；编辑态不加黄底（保留现状），字色仍为白。
 */
function subtitleClipContentStyle(clipId: string): Record<string, string> {
  const base: Record<string, string> = {
    pointerEvents: "auto",
    color: "#fff",
  };
  if (editingSubtitleId.value === clipId) return base;
  return { ...base, background: SUBTITLE_CLIP_BG };
}

/** 读取字幕文案（slot 内展示） */
function clipText(clip: Clip): string {
  if (clip.type !== "subtitle") return "";
  return (clip as SubtitleClip).text || "";
}

/** 贴图 clip 时间轴色块文案 */
function textClipLabel(clip: Clip): string {
  if (clip.type !== "text") return "";
  const textClip = clip as TextClip;
  return textClip.text?.trim() || textClip.name || TEXT_TEMPLATE_TRACK_NAME;
}

/** 绑定 contenteditable ref（v-for/条件渲染下的动态 ref） */
function setEditingEl(el: unknown): void {
  editingEl.value = el instanceof HTMLElement ? el : null;
}

/**
 * 双击 clip：仅字幕进入就地编辑（字幕类型不 seek 播放头）。
 */
function onClipDblClick(clip: Clip): void {
  if (props.readonly || clip.type !== "subtitle") return;
  editingOriginText = (clip as SubtitleClip).text || "";
  editingSubtitleId.value = clip.id;
  void nextTick(() => {
    const el = editingEl.value;
    if (!el) return;
    el.textContent = editingOriginText;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
}

/** 退出编辑态 */
function exitSubtitleEdit(): void {
  editingSubtitleId.value = null;
  editingEl.value = null;
  editingOriginText = "";
}

/** Esc：不写回 */
function cancelSubtitleEdit(): void {
  if (!editingSubtitleId.value) return;
  exitSubtitleEdit();
}

/** Enter / blur：trim 后写回；空文案提示并恢复原文 */
function commitSubtitleEdit(): void {
  if (subtitleEditCommitting) return;
  const clipId = editingSubtitleId.value;
  const el = editingEl.value;
  if (!clipId || !el) return;

  subtitleEditCommitting = true;
  try {
    const text = (el.textContent || "").trim();
    if (!text) {
      ElMessage.warning("字幕内容不能为空,请输入字幕后重试");
      el.textContent = editingOriginText;
      exitSubtitleEdit();
      return;
    }
    if (text !== editingOriginText.trim()) {
      const api = videoTrackRef.value;
      if (api) {
        suppressEmit = true;
        api.updateClip(clipId, { text });
        suppressEmit = false;
        onDataChanged();
      }
    }
    exitSubtitleEdit();
  } finally {
    // 同 tick 内 blur 可能紧随 Enter，短延时解除锁
    window.setTimeout(() => {
      subtitleEditCommitting = false;
    }, 0);
  }
}

/**
 * 按类型批量/单条更新 clip 属性。
 * @param type video | audio | subtitle | text
 * @param patch 写入 updateClip 的字段
 * @param options.clipId 有值则只改该 clip
 * @param options.trackId 无 clipId 时只改该轨上匹配 type 的 clip；都空则改该类型全部 clip
 */
function patchClipsByType(type: PatchableClipType, patch: Record<string, unknown>, options?: PatchClipsByTypeOptions): void {
  const api = videoTrackRef.value;
  if (!api) return;
  const matchedTracks = api.getTracks().filter((t) => {
    if (type === "video") return Boolean(t.isMain) || t.type === "video";
    if (type === "text") return t.type === TEXT_TEMPLATE_TRACK_TYPE || t.type === "text";
    return t.type === type;
  });

  let targets: Clip[];
  if (options?.clipId) {
    targets = matchedTracks.flatMap((t) => t.clips).filter((c) => c.type === type && c.id === options.clipId);
  } else if (options?.trackId) {
    const track = matchedTracks.find((t) => t.id === options.trackId);
    targets = (track?.clips || []).filter((c) => c.type === type);
  } else {
    targets = matchedTracks.flatMap((t) => t.clips).filter((c) => c.type === type);
  }
  if (!targets.length) return;

  suppressEmit = true;
  for (const c of targets) {
    api.updateClip(c.id, patch);
  }
  suppressEmit = false;
  onDataChanged();
}

function getSelectedClipIds(): string[] {
  return videoTrackRef.value?.getSelectedClipIds?.() || [];
}

function getSelectedClips(): Clip[] {
  return videoTrackRef.value?.getSelectedClips?.() || [];
}

/** 音频轨按创建顺序命名为 音频1、音频2…；主轨固定为「视频」 */
function onTrackAdded(track: Track): void {
  const api = videoTrackRef.value;
  if (!api) return;
  if (track.type === "audio") {
    if (track.name.startsWith("原声")) return;
    const audioCount = api.getTracks().filter((t) => t.type === "audio" && !t.name.startsWith("原声")).length;
    api.updateTrack(track.id, { name: `音频${audioCount}` });
  } else if (track.isMain || track.type === "video") {
    if (track.name !== "视频") {
      api.updateTrack(track.id, { name: "视频" });
    }
  } else if (track.type === "subtitle" && track.name !== "字幕") {
    api.updateTrack(track.id, { name: "字幕" });
  } else if (track.type === TEXT_TEMPLATE_TRACK_TYPE && track.name !== TEXT_TEMPLATE_TRACK_NAME) {
    api.updateTrack(track.id, { name: TEXT_TEMPLATE_TRACK_NAME });
  }
}

/** 确保存在主视频轨 */
function ensureMainTrack(): Track {
  const api = videoTrackRef.value!;
  let main = api.getMainTrack();
  if (main) {
    if (main.name !== "视频") api.updateTrack(main.id, { name: "视频" });
    return main;
  }
  const id = `track-main-${generateId()}`;
  api.addTrack({
    id,
    type: "video",
    name: "视频",
    visible: true,
    locked: false,
    clips: [],
    order: 0,
    isMain: true,
  });
  return api.getMainTrack()!;
}

/** 确保存在字幕轨，返回其 id */
function ensureSubtitleTrack(): string {
  const api = videoTrackRef.value!;
  const existing = api.getTracks().find((t) => t.type === "subtitle");
  if (existing) return existing.id;
  const id = `track-subtitle-${generateId()}`;
  api.addTrack({
    id,
    type: "subtitle",
    name: "字幕",
    visible: true,
    locked: false,
    clips: [],
    order: 10,
  });
  return id;
}

/** 当前光标是否落在 clip 时间范围内（左闭右开） */
function clipCoversTime(clip: { startTime: number; endTime: number }, timeSec: number): boolean {
  return clip.startTime <= timeSec && timeSec < clip.endTime;
}

/**
 * 复用光标处无 clip 的贴图轨；否则新建一条「贴图」轨。
 */
function ensureStickerTrackAtTime(timeSec: number): Track {
  const api = videoTrackRef.value!;
  const stickers = api.getTracks().filter((t) => t.type === TEXT_TEMPLATE_TRACK_TYPE);
  const free = stickers.find((t) => !t.clips.some((c) => clipCoversTime(c, timeSec)));
  if (free) return free;
  const n = stickers.length + 1;
  const id = `track-sticker-${generateId()}`;
  api.addTrack({
    id,
    type: TEXT_TEMPLATE_TRACK_TYPE,
    name: TEXT_TEMPLATE_TRACK_NAME,
    visible: true,
    locked: false,
    clips: [],
    order: 20 + n,
  });
  const created = api.getTracks().find((t) => t.id === id);
  if (created) return created;
  return {
    id,
    type: TEXT_TEMPLATE_TRACK_TYPE,
    name: TEXT_TEMPLATE_TRACK_NAME,
    visible: true,
    locked: false,
    clips: [],
    order: 20 + n,
  };
}

/** 计算贴图插入时长：默认 3s，若同轨后续有 clip 则收缩避免重叠 */
function resolveTextClipDuration(clips: Array<{ startTime: number; endTime: number }>, start: number, preferred: number): number {
  const next = [...clips].filter((c) => c.startTime > start).sort((a, b) => a.startTime - b.startTime)[0];
  if (!next) return preferred;
  return Math.max(0.1, Math.min(preferred, next.startTime - start));
}

export interface AddTextClipOptions {
  /** 素材库剪辑素材 rawId */
  templateId: string;
  /** 文字模板 SVG 的 OSS 原链 */
  sourceUrl?: string;
  /** 轨道色块 / clip 名称 */
  name?: string;
  /** 默认文案 */
  text: string;
  /** 字号 */
  fontSize: number;
  /** 颜色；null 表示沿用模板 SVG 原色 */
  color: string | null;
  /** 模板宽高比 */
  aspect?: number;
  /** 视频宽，用于默认 rect */
  videoWidth?: number;
  /** 视频高，用于默认 rect */
  videoHeight?: number;
  /** 指定起点；缺省用 playhead */
  startTime?: number;
  /** 期望时长 */
  durationSec?: number;
}

/** 在贴图轨 playhead 插入 TextClip */
function addTextClip(options: AddTextClipOptions): string {
  const api = videoTrackRef.value!;
  const cursor = options.startTime ?? api.getCurrentTime?.() ?? 0;
  const start = Math.max(0, cursor);
  const track = ensureStickerTrackAtTime(start);
  const duration = resolveTextClipDuration(track.clips, start, options.durationSec ?? DEFAULT_TEXT_CLIP_DURATION_SEC);
  const clipId = `text-${generateId()}`;
  const rect = createDefaultTextClipRect(options.videoWidth ?? 0, options.videoHeight ?? 0, options.aspect ?? 1);
  suppressEmit = true;
  api.addClip(track.id, {
    id: clipId,
    trackId: track.id,
    type: "text",
    name: options.name || options.text || TEXT_TEMPLATE_TRACK_NAME,
    text: options.text,
    fontSize: options.fontSize,
    color: options.color,
    startTime: start,
    endTime: start + duration,
    selected: true,
    visible: true,
    rect,
    config: {
      templateId: options.templateId,
      ...(options.sourceUrl?.trim() ? { sourceUrl: options.sourceUrl.trim() } : {}),
    },
  });
  api.selectClip?.(clipId);
  suppressEmit = false;
  onDataChanged();
  emit("selection-changed", [clipId]);
  return clipId;
}

/** 选中指定 clip（预览区点选贴图时与时间轴选中态对齐） */
function selectClipById(clipId: string): void {
  const api = videoTrackRef.value;
  if (!api) return;
  api.selectClip?.(clipId);
  emit("selection-changed", [clipId]);
}

/** 创建或复用下一个空音频轨；若末轨已有 clip 则新建 */
function ensureNextAudioTrack(): Track {
  const api = videoTrackRef.value!;
  const audios = api.getTracks().filter((t) => t.type === "audio");
  const last = audios[audios.length - 1];
  if (last && last.clips.length === 0) return last;
  const n = audios.length + 1;
  const id = `track-audio-${generateId()}`;
  const track: Track = {
    id,
    type: "audio",
    name: `音频${n}`,
    visible: true,
    locked: false,
    clips: [],
    order: 100 + n,
  };
  api.addTrack(track);
  return api.getTracks().find((t) => t.id === id) || track;
}

/** 按 id 查找 video/audio clip */
function findMediaClipById(clipId: string): MediaClip | null {
  const api = videoTrackRef.value;
  if (!api) return null;
  for (const track of api.getTracks()) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip && (clip.type === "video" || clip.type === "audio")) {
      return clip as MediaClip;
    }
  }
  return null;
}

/** 删除 clip 时同步清理 linked video/audio 关联 */
function cleanupLinkedClipsOnRemove(clipId: string, removedClip?: Clip): void {
  const config = readClipConfig(clipConfigBeforeRemove.get(clipId) ?? removedClip?.config);
  clipConfigBeforeRemove.delete(clipId);
  const api = videoTrackRef.value;
  if (!api || (!config.linkedAudioClipId && !config.linkedVideoClipId)) return;

  suppressEmit = true;
  if (config.linkedAudioClipId && findMediaClipById(config.linkedAudioClipId)) {
    orphanDetachedAudioAfterVideoRemoved(config.linkedAudioClipId);
  }
  if (config.linkedVideoClipId) {
    restoreVideoAfterAudioRemoved(config.linkedVideoClipId);
  }
  suppressEmit = false;
}

/** 删除 video 时保留 linked audio 并解除关联；删 audio 时解除 video 关联并保持静音 */
function onClipRemoved(payload: Clip | string): void {
  const removedClip = typeof payload === "string" ? undefined : payload;
  const clipId = typeof payload === "string" ? payload : payload?.id;
  if (!clipId) {
    scheduleDataChanged();
    return;
  }
  cleanupLinkedClipsOnRemove(clipId, removedClip);
  scheduleDataChanged();
}

/** 工具栏/右键删除仅 emit clip-delete，需与 onClipRemoved 同样联动清理 */
function onClipDelete(payload: Clip | string): void {
  const removedClip = typeof payload === "string" ? undefined : payload;
  const clipId = typeof payload === "string" ? payload : payload?.id;
  if (clipId) {
    cleanupLinkedClipsOnRemove(clipId, removedClip);
  }
  scheduleDataChanged();
}

/** 删除整条音轨时，对其上原声 clip 逐个解除与 video 的关联 */
function onTrackRemoved(track: Track): void {
  if (!track?.clips?.length) {
    scheduleDataChanged();
    return;
  }
  suppressEmit = true;
  for (const clip of track.clips) {
    const config = readClipConfig(clip.config);
    if (config.linkedVideoClipId) {
      restoreVideoAfterAudioRemoved(config.linkedVideoClipId);
    }
  }
  suppressEmit = false;
  scheduleDataChanged();
}

/** 主轨末尾时间（秒） */
function mainTrackEndTime(): number {
  const main = videoTrackRef.value?.getMainTrack();
  if (!main?.clips?.length) return 0;
  return Math.max(...main.clips.map((c) => c.endTime));
}

/**
 * 向主视频轨指定时间点插入 clip（主轨模式下库会自动后移重叠片段）。
 * @param item 已解析的视频片段
 * @param startTime 轨道内起始时间（秒）
 */
function insertClipToMainAt(
  item: { id?: string; title?: string; url: string; durationSec: number; taskId?: string },
  startTime: number,
): string {
  const api = videoTrackRef.value!;
  const main = ensureMainTrack();
  const duration = Math.max(0.1, item.durationSec || 0.1);
  const clipId = item.id || `clip-${generateId()}`;
  const t = Math.max(0, startTime);

  const sorted = [...main.clips].filter((c) => c.type !== "transition").sort((a, b) => a.startTime - b.startTime);
  const insertIndex = sorted.findIndex((c) => c.startTime >= t);

  suppressEmit = true;

  let startAt: number;
  if (insertIndex === -1) {
    const last = sorted[sorted.length - 1];
    startAt = last ? Math.max(last.endTime, t) : t;
  } else {
    startAt = t;
    for (let i = insertIndex; i < sorted.length; i++) {
      const c = sorted[i];
      const cDuration = c.endTime - c.startTime;
      const newStart = c.startTime + duration;
      api.updateClip(c.id, {
        startTime: newStart,
        endTime: newStart + cDuration,
      });
    }
  }

  api.addClip(main.id, {
    id: clipId,
    trackId: main.id,
    type: "video",
    name: item.title || "视频片段",
    sourceUrl: item.url,
    originalDuration: duration,
    trimStart: 0,
    trimEnd: duration,
    playbackRate: 1,
    volume: 0.8,
    startTime: startAt,
    endTime: startAt + duration,
    selected: false,
    config: item.taskId ? { taskId: item.taskId } : undefined,
  });
  suppressEmit = false;
  onDataChanged();
  return clipId;
}

/** 将拖放坐标换算为轨道时间（秒），算法对齐 vue-clip-track TrackArea.handleDrop */
function resolveDropTimeSec(event: DragEvent): number {
  const root = timelineRootRef.value;
  if (!root) return 0;

  const scale = videoTrackRef.value?.getScale?.() ?? 1;
  const pps = TIMELINE_BASE_PPS * scale;

  const hitEl = (event.target as HTMLElement | null) ?? (document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null);

  const trackArea = hitEl?.closest(".track-area") ?? root.querySelector(".track-area");
  if (trackArea instanceof HTMLElement) {
    const rect = trackArea.getBoundingClientRect();
    const x = event.clientX - rect.left + trackArea.scrollLeft;
    return Math.max(0, x / pps);
  }

  const rulerContent = hitEl?.closest(".ruler__content") ?? root.querySelector(".ruler__content");
  const rulerWrapper = root.querySelector(".ruler__wrapper");
  if (rulerContent instanceof HTMLElement && rulerWrapper instanceof HTMLElement) {
    const rect = rulerContent.getBoundingClientRect();
    const x = event.clientX - rect.left - TIMELINE_TRACK_CONTROL_WIDTH + rulerWrapper.scrollLeft;
    return Math.max(0, x / pps);
  }

  return mainTrackEndTime();
}

/** 侧栏卡片拖放使用的 MIME */
const CATALOG_DRAG_MIMES = [
  COMPOSE_SEGMENT_CLIP_DRAG_MIME,
  COMPOSE_AUDIO_ASSET_DRAG_MIME,
  COMPOSE_SUBTITLE_ASSET_DRAG_MIME,
  COMPOSE_TEXT_TEMPLATE_DRAG_MIME,
];

/** 这次拖动是不是侧栏素材 */
function isCatalogDrag(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  return CATALOG_DRAG_MIMES.some((mime) => types.includes(mime));
}

/** 侧栏素材拖入：允许 drop */
function onCatalogDragOver(event: DragEvent): void {
  if (props.readonly || !isCatalogDrag(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  catalogDragOver.value = true;
}

/** 侧栏素材拖离时间轴 */
function onCatalogDragLeave(event: DragEvent): void {
  const root = timelineRootRef.value;
  const related = event.relatedTarget;
  if (root && related instanceof Node && root.contains(related)) return;
  catalogDragOver.value = false;
}

/** 读出某种拖放载荷。没有这种 MIME 时返回 null */
function readCatalogDrag<T>(event: DragEvent, mime: string): T | null {
  const raw = event.dataTransfer?.getData(mime);
  if (!raw) return null;
  return JSON.parse(raw) as T;
}

/** 侧栏素材松手：按种类上报，起点都是松手时间 */
function onCatalogDrop(event: DragEvent): void {
  catalogDragOver.value = false;
  if (props.readonly || !isCatalogDrag(event)) return;
  event.preventDefault();
  event.stopPropagation();
  const startTime = resolveDropTimeSec(event);
  try {
    const variant = readCatalogDrag<ComposeSegmentClipAssets>(event, COMPOSE_SEGMENT_CLIP_DRAG_MIME);
    if (variant) {
      emit("drop-catalog-clip", { variant, startTime });
      return;
    }
    const audio = readCatalogDrag<BgmItem>(event, COMPOSE_AUDIO_ASSET_DRAG_MIME);
    if (audio) {
      emit("drop-audio-asset", { item: audio, startTime });
      return;
    }
    const subtitle = readCatalogDrag<ComposeSubtitleAsset>(event, COMPOSE_SUBTITLE_ASSET_DRAG_MIME);
    if (subtitle) {
      emit("drop-subtitle-asset", { item: subtitle, startTime });
      return;
    }
    const text = readCatalogDrag<ComposeTextTemplateDrag>(event, COMPOSE_TEXT_TEMPLATE_DRAG_MIME);
    if (text) {
      emit("drop-text-template", { item: text, startTime });
    }
  } catch {
    ElMessage.warning("无法识别该素材，请检查格式后重新拖入");
  }
}

/** vue-clip-track 原生文件拖入，转交 Editor 处理 */
function onDropMedia(mediaData: unknown, trackId: string, startTime: number): void {
  if (props.readonly) return;
  emit("drop-media", { mediaData, trackId, startTime });
}

/**
 * 向主视频轨追加 clip（无缝拼接）。
 * @param item 已解析的视频片段
 */
function addClipToMain(item: { id?: string; title?: string; url: string; durationSec: number; taskId?: string }): string {
  return insertClipToMainAt(item, mainTrackEndTime());
}

/**
 * 向音频轨追加 clip（可多次，对应音频1…N）。
 */
function addAudioClip(bgm: BgmItem, startTime = 0): string {
  const api = videoTrackRef.value!;
  const track = ensureNextAudioTrack();
  const duration = Math.max(0.1, bgm.durationSec || 0.1);
  const clipId = `audio-${generateId()}`;
  suppressEmit = true;
  api.addClip(track.id, {
    id: clipId,
    trackId: track.id,
    type: "audio",
    name: bgm.name || track.name,
    sourceUrl: bgm.url,
    originalDuration: duration,
    trimStart: 0,
    trimEnd: duration,
    playbackRate: 1,
    startTime,
    endTime: startTime + duration,
    selected: false,
    volume: 0.5,
    config: { audioRole: "bgm" },
  });
  suppressEmit = false;
  onDataChanged();
  return clipId;
}

/** 字幕插入可用空隙下限（秒），过短则跳到下一条之后 */
const MIN_SUBTITLE_INSERT_GAP_SEC = 0.05;

/**
 * 计算字幕轨插入窗口：游标落在已有 clip 上则插到其后，并按后续空隙收缩时长避免重叠。
 * @param clips 字幕轨已有片段
 * @param cursor 游标或指定起点（秒）
 * @param preferredDuration 期望时长（秒）
 */
function resolveSubtitleInsertRange(
  clips: Array<{ startTime: number; endTime: number }>,
  cursor: number,
  preferredDuration: number,
): { start: number; duration: number } {
  const sorted = [...clips]
    .filter((c) => Number.isFinite(c.startTime) && Number.isFinite(c.endTime) && c.endTime > c.startTime)
    .sort((a, b) => a.startTime - b.startTime);
  let start = Math.max(0, cursor);
  const preferred = preferredDuration > 0 ? preferredDuration : 2;

  for (let i = 0; i < sorted.length + 1; i += 1) {
    const covering = sorted.find((c) => c.startTime <= start && start < c.endTime);
    if (covering) {
      start = covering.endTime;
      continue;
    }
    const next = sorted.find((c) => c.startTime >= start);
    if (!next) return { start, duration: preferred };
    const gap = next.startTime - start;
    if (gap < MIN_SUBTITLE_INSERT_GAP_SEC) {
      start = next.endTime;
      continue;
    }
    return { start, duration: Math.min(preferred, gap) };
  }
  return { start, duration: preferred };
}

/** 插入字幕 clip 的可选文案、时间与样式（样式缺省走 normalizeSubtitleClipStyle） */
type AddSubtitleClipOptions = {
  text?: string;
  startTime?: number;
  durationSec?: number;
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
};

/**
 * 在字幕轨 playhead（或指定时间）插入字幕 clip。
 * 游标落在已有字幕上时插到该 clip 之后，且不与同轨其他字幕重叠。
 */
function addSubtitleClip(options?: AddSubtitleClipOptions): string {
  const api = videoTrackRef.value!;
  const trackId = ensureSubtitleTrack();
  const track = api.getTracks().find((t) => t.id === trackId);
  const cursor = options?.startTime ?? api.getCurrentTime?.() ?? 0;
  const { start, duration } = resolveSubtitleInsertRange(track?.clips || [], cursor, options?.durationSec ?? 2);
  const clipId = `sub-${generateId()}`;
  const style = normalizeSubtitleClipStyle({
    fontFamily: options?.fontFamily,
    fontSize: options?.fontSize,
    color: options?.color,
    bold: options?.bold,
    italic: options?.italic,
  });
  suppressEmit = true;
  api.addClip(trackId, {
    id: clipId,
    trackId,
    type: "subtitle",
    name: "字幕",
    text: options?.text ?? "新建字幕",
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    color: style.color,
    bold: style.bold,
    italic: style.italic,
    alignment: style.alignment,
    marginL: style.marginL,
    marginR: style.marginR,
    marginV: style.marginV,
    visible: style.visible,
    startTime: start,
    endTime: start + duration,
    selected: false,
  });
  suppressEmit = false;
  onDataChanged();
  return clipId;
}

/** 清空字幕轨全部 clip 后写入全局时间轴字幕 */
function replaceSubtitleClips(items: Array<{ start: number; end: number; text: string }>): void {
  const api = videoTrackRef.value!;
  const trackId = ensureSubtitleTrack();
  const track = api.getTracks().find((t) => t.id === trackId);
  const style = normalizeSubtitleClipStyle({});
  suppressEmit = true;
  if (track) {
    [...track.clips].forEach((c) => api.removeClip(c.id));
  }
  for (const item of items) {
    if (!item.text?.trim() || item.start >= item.end) continue;
    api.addClip(trackId, {
      id: `sub-${generateId()}`,
      trackId,
      type: "subtitle",
      name: "字幕",
      text: item.text.trim(),
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      color: style.color,
      bold: style.bold,
      italic: style.italic,
      alignment: style.alignment,
      marginL: style.marginL,
      marginR: style.marginR,
      marginV: style.marginV,
      visible: style.visible,
      startTime: item.start,
      endTime: item.end,
      selected: false,
    });
  }
  suppressEmit = false;
  onDataChanged();
}

/** 清空主轨 clips 后按序重建（保留音频/字幕轨） */
function bootstrapMainFromClips(clips: VideoClipItem[]): void {
  const api = videoTrackRef.value;
  if (!api) return;
  suppressEmit = true;
  let main = api.getMainTrack();
  if (!main) {
    resetTimelineKeepingScale();
    main = api.getMainTrack();
  }
  if (!main) return;
  if (main.name !== "视频") api.updateTrack(main.id, { name: "视频" });
  // 仅清空主轨片段，避免 wipe 音频/字幕轨
  [...main.clips].forEach((c) => api.removeClip(c.id));
  let cursor = 0;
  for (const clip of clips) {
    if (!clip.url) continue;
    const duration = Math.max(0.1, clip.durationSec || 0.1);
    api.addClip(main.id, {
      id: clip.id || `clip-${generateId()}`,
      trackId: main.id,
      type: "video",
      name: clip.title || "视频片段",
      sourceUrl: clip.url,
      originalDuration: duration,
      trimStart: 0,
      trimEnd: duration,
      playbackRate: clip.playbackRate && clip.playbackRate > 0 ? clip.playbackRate : 1,
      volume: clip.volume != null ? clip.volume : 0.8,
      startTime: cursor,
      endTime: cursor + duration,
      selected: false,
      config: clip.taskId ? { taskId: clip.taskId } : undefined,
    });
    cursor += duration;
  }
  bootstrapped = true;
  suppressEmit = false;
  onDataChanged();
}

/** 从持久化 tracks 回灌 */
function importTracks(tracks: ComposeTrack[]): void {
  const api = videoTrackRef.value;
  if (!api) return;
  suppressEmit = true;
  if (tracks?.length) {
    const projectTracks: Track[] = tracks.map((t, order) => {
      const row: TrackWithMute = {
        id: t.id,
        type: t.type,
        name: t.name,
        isMain: t.isMain,
        visible: t.visible !== false,
        locked: Boolean(t.locked),
        muted: t.muted === true,
        order: t.order ?? order,
        clips: t.clips as Track["clips"],
        frameAspect: t.frameAspect,
        nativeFrameWidth: t.nativeFrameWidth,
        nativeFrameHeight: t.nativeFrameHeight,
      };
      return row;
    });
    api.importData({
      version: "0.1.0",
      tracks: projectTracks,
      currentTime: 0,
      scale: normalizeComposeTimelineScale(props.scale),
      snapEnabled: true,
    });
  } else {
    resetTimelineKeepingScale();
  }
  bootstrapped = true;
  suppressEmit = false;
}

/** 主轨视频 URL 顺序列表（给播放器 / 合成） */
function getMainVideoUrlsInOrder(): string[] {
  const main = videoTrackRef.value?.getMainTrack();
  if (!main) return [];
  return [...main.clips]
    .filter((c) => c.type === "video")
    .sort((a, b) => a.startTime - b.startTime)
    .map((c) => ("sourceUrl" in c ? String(c.sourceUrl) : ""))
    .filter(Boolean);
}

/** 主轨派生 VideoClipItem 列表（含 volume/rate/trim，时长为时间轴占用） */
function getMainVideoClips(): VideoClipItem[] {
  const main = videoTrackRef.value?.getMainTrack();
  if (!main) return [];
  return [...main.clips]
    .filter((c): c is MediaClip => c.type === "video")
    .sort((a, b) => a.startTime - b.startTime)
    .map((c, i) => mapMediaClipToVideoClipItem(c as MediaClip, i));
}

/**
 * 主轨 clip 按原 startTime 拆掉重建（触发缩略图重抽帧）。
 * 后续片段只平移时长差值，避免 insertClipToMainAt 按整段新时长再推一次。
 */
function rebuildMainClipAt(clipId: string, durationSec: number): void {
  const api = videoTrackRef.value;
  if (!api || durationSec <= 0.1) return;
  const main = api.getMainTrack();
  if (!main) return;
  const clip = main.clips.find((c) => c.id === clipId);
  if (!clip || clip.type !== "video") return;

  const media = clip as MediaClip;
  const startTime = clip.startTime;
  const oldEnd = clip.endTime;
  const oldDuration = Math.max(0, oldEnd - startTime);
  const duration = durationSec;
  const delta = duration - oldDuration;
  const playbackRate = media.playbackRate && media.playbackRate > 0 ? media.playbackRate : 1;
  const volume = media.volume != null ? media.volume : 0.8;

  suppressEmit = true;
  // 先挪开后续 clip，避免新时长与旧邻接片段重叠
  if (Math.abs(delta) > 0.001) {
    for (const c of main.clips) {
      if (c.id === clipId || c.type === "transition") continue;
      if (c.startTime >= oldEnd - 0.001) {
        api.updateClip(c.id, {
          startTime: c.startTime + delta,
          endTime: c.endTime + delta,
        });
      }
    }
  }
  api.removeClip(clipId);
  api.addClip(main.id, {
    id: clipId,
    trackId: main.id,
    type: "video",
    name: clip.name || "视频片段",
    sourceUrl: media.sourceUrl || "",
    originalDuration: duration,
    trimStart: 0,
    trimEnd: duration,
    playbackRate,
    volume,
    startTime,
    endTime: startTime + duration,
    selected: false,
    config: media.config,
  });
  suppressEmit = false;
  onDataChanged();
}

/** 主轨已有 clip 时更新时长（probe 回填），保留 startTime 并后移同轨后续片段 */
function updateMainClipDuration(clipId: string, durationSec: number): void {
  const api = videoTrackRef.value;
  if (!api || durationSec <= 0) return;
  const main = api.getMainTrack();
  if (!main) return;
  const clip = main.clips.find((c) => c.id === clipId);
  if (!clip || clip.type !== "video") return;

  const oldEnd = clip.endTime;
  const newEnd = clip.startTime + durationSec;
  const delta = newEnd - oldEnd;

  suppressEmit = true;
  api.updateClip(clipId, {
    originalDuration: durationSec,
    trimEnd: durationSec,
    endTime: newEnd,
  });
  if (Math.abs(delta) > 0.001) {
    for (const c of main.clips) {
      if (c.id === clipId || c.type === "transition") continue;
      if (c.startTime >= oldEnd - 0.001) {
        api.updateClip(c.id, {
          startTime: c.startTime + delta,
          endTime: c.endTime + delta,
        });
      }
    }
  }
  suppressEmit = false;
  onDataChanged();
}

/** 音频轨 clip 时长回填（拖入后异步探测），保留 startTime 并后移同轨后续片段 */
function updateAudioClipDuration(clipId: string, durationSec: number): void {
  const api = videoTrackRef.value;
  if (!api || durationSec <= 0.1) return;

  let hostTrack: Track | null = null;
  let clip: Clip | null = null;
  for (const track of api.getTracks()) {
    if (track.type !== "audio") continue;
    const hit = track.clips.find((c) => c.id === clipId);
    if (hit && hit.type === "audio") {
      hostTrack = track;
      clip = hit;
      break;
    }
  }
  if (!hostTrack || !clip) return;

  const oldEnd = clip.endTime;
  const newEnd = clip.startTime + durationSec;
  const delta = newEnd - oldEnd;

  suppressEmit = true;
  api.updateClip(clipId, {
    originalDuration: durationSec,
    trimStart: 0,
    trimEnd: durationSec,
    endTime: newEnd,
  });
  if (Math.abs(delta) > 0.001) {
    for (const c of hostTrack.clips) {
      if (c.id === clipId) continue;
      if (c.startTime >= oldEnd - 0.001) {
        api.updateClip(c.id, {
          startTime: c.startTime + delta,
          endTime: c.endTime + delta,
        });
      }
    }
  }
  suppressEmit = false;
  onDataChanged();
}

/** 改 video/audio clip 倍速：保持源 trim，按倍率重算时间轴长度，并后移同轨后续片段 */
function setMediaClipPlaybackRate(clipId: string, rate: number): void {
  const api = videoTrackRef.value;
  if (!api || !clipId) return;
  const nextRate = clampPlaybackRate(rate);

  let hostTrack: Track | null = null;
  let clip: MediaClip | null = null;
  for (const track of api.getTracks()) {
    const hit = track.clips.find((item) => item.id === clipId);
    if (hit && (hit.type === "video" || hit.type === "audio")) {
      hostTrack = track;
      clip = hit as MediaClip;
      break;
    }
  }
  if (!hostTrack || !clip) return;

  const oldRate = clip.playbackRate > 0 ? clip.playbackRate : 1;
  const trimStart = Math.max(0, clip.trimStart ?? 0);
  const timelineDur = Math.max(0.1, clip.endTime - clip.startTime);
  const trimEnd = clip.trimEnd != null && clip.trimEnd > trimStart ? clip.trimEnd : trimStart + timelineDur * oldRate;
  const sourceDur = Math.max(0.1, trimEnd - trimStart);
  const newDur = Math.max(0.1, sourceDur / nextRate);
  const oldEnd = clip.endTime;
  const newEnd = clip.startTime + newDur;
  const delta = newEnd - oldEnd;

  suppressEmit = true;
  api.updateClip(clipId, {
    playbackRate: nextRate,
    endTime: newEnd,
  });
  if (Math.abs(delta) > 0.001) {
    for (const item of hostTrack.clips) {
      if (item.id === clipId || item.type === "transition") continue;
      if (item.startTime >= oldEnd - 0.001) {
        api.updateClip(item.id, {
          startTime: item.startTime + delta,
          endTime: item.endTime + delta,
        });
      }
    }
  }
  suppressEmit = false;
  onDataChanged();
}

/** 按 sourceUrl 移除主轨上全部视频 clip */
function removeMainClipsByUrl(url: string): void {
  const api = videoTrackRef.value;
  if (!api) return;
  const main = api.getMainTrack();
  if (!main) return;
  const normalized = url.trim();
  if (!normalized) return;

  suppressEmit = true;
  for (const clip of [...main.clips]) {
    if (clip.type === "video" && clip.sourceUrl?.trim() === normalized) {
      api.removeClip(clip.id);
    }
  }
  suppressEmit = false;
  onDataChanged();
}

/** 挂载清空结束后 resolve，编辑器须等它再 bootstrap */
let resolveTimelineReady: (() => void) | null = null;
const timelineReady: Promise<void> = new Promise((resolve) => {
  resolveTimelineReady = resolve;
});

/** 只放行一次，卸载时也要解开，避免 bootstrapTimeline 一直等 */
function settleTimelineReady(): void {
  resolveTimelineReady?.();
  resolveTimelineReady = null;
}

/** 时间轴完成首次清空后可上轴 */
function whenReady(): Promise<void> {
  return timelineReady;
}

onMounted(async () => {
  isDark.value = document.documentElement.classList.contains("dark");
  themeObserver = new MutationObserver(() => {
    isDark.value = document.documentElement.classList.contains("dark");
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

  window.addEventListener("pointerup", onWindowPointerUp, true);
  window.addEventListener("pointercancel", onWindowPointerUp, true);
  document.addEventListener("keydown", onDocumentPlayheadKeyDown, true);
  window.addEventListener("keyup", onWindowPlayheadKeyUp, true);
  window.addEventListener("blur", onWindowPlayheadBlur);
  document.addEventListener("visibilitychange", onPlayheadVisibilityChange);
  // capture + 非 passive：才能拦住 Ctrl+滚轮的浏览器页缩放
  timelineRootRef.value?.addEventListener("wheel", onTimelineWheel, { capture: true, passive: false });
  if (timelineRootRef.value) {
    zoomResizeObserver = new ResizeObserver(() => {
      if (!zoomGesture) readZoomView();
    });
    zoomResizeObserver.observe(timelineRootRef.value);
  }

  try {
    await nextTick();
    if (!videoTrackRef.value) return;
    // 编辑器可能已抢先 bootstrap；再 reset 会静默抹掉主轨，预览仍留着旧片段
    if (!bootstrapped) {
      suppressEmit = true;
      resetTimelineKeepingScale();
      suppressEmit = false;
    }
    await nextTick();
    startHScrollbarAlign();
    readZoomView();
  } finally {
    settleTimelineReady();
  }
});

onBeforeUnmount(() => {
  settleTimelineReady();
  themeObserver?.disconnect();
  themeObserver = null;
  zoomResizeObserver?.disconnect();
  zoomResizeObserver = null;
  stopHScrollbarAlign();
  window.removeEventListener("pointerup", onWindowPointerUp, true);
  window.removeEventListener("pointercancel", onWindowPointerUp, true);
  document.removeEventListener("keydown", onDocumentPlayheadKeyDown, true);
  window.removeEventListener("keyup", onWindowPlayheadKeyUp, true);
  window.removeEventListener("blur", onWindowPlayheadBlur);
  document.removeEventListener("visibilitychange", onPlayheadVisibilityChange);
  timelineRootRef.value?.removeEventListener("wheel", onTimelineWheel, true);
  clearPlayheadHold();
  if (dataChangedTimer != null) {
    window.clearTimeout(dataChangedTimer);
    dataChangedTimer = null;
  }
  if (pointerSyncTimer != null) {
    window.clearTimeout(pointerSyncTimer);
    pointerSyncTimer = null;
  }
});

watch(
  () => props.tracks,
  (tracks) => {
    if (!bootstrapped || !tracks || suppressEmit) return;
    // 外部强制回灌时才 import；日常由内部 emit 驱动，不回灌
  },
);

/** 视频轨画幅。非视频轨或未写过时不带上，读取方按原画处理 */
function readTrackFrameAspect(track: Track): ComposeFrameAspect | undefined {
  if (track.type !== "video") return undefined;
  const raw = (track as TrackWithMute).frameAspect;
  if (raw == null) return undefined;
  return normalizeFrameAspect(raw);
}

/** 原画像素。非正数视为还没探到 */
function readPositiveFrameSize(track: Track, key: "nativeFrameWidth" | "nativeFrameHeight"): number | undefined {
  const value = (track as TrackWithMute)[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

/** 写入主视频轨画幅或原画像素。updateTrack 会保留这些额外字段 */
function setMainTrackFrame(patch: { frameAspect?: ComposeFrameAspect; nativeFrameWidth?: number; nativeFrameHeight?: number }): void {
  const api = videoTrackRef.value;
  if (!api) return;
  const main = ensureMainTrack();
  api.updateTrack(main.id, patch as Partial<Track>);
  onDataChanged();
}

defineExpose({
  getMainTrack: () => videoTrackRef.value?.getMainTrack(),
  addClipToMain,
  insertClipToMainAt,
  addAudioClip,
  addSubtitleClip,
  addTextClip,
  selectClipById,
  replaceSubtitleClips,
  exportTracks,
  importTracks,
  bootstrapMainFromClips,
  whenReady,
  getMainVideoUrlsInOrder,
  getMainVideoClips,
  ensureSubtitleTrack,
  ensureNextAudioTrack,
  getCurrentTime: () => videoTrackRef.value?.getCurrentTime?.() ?? 0,
  getDuration: () => videoTrackRef.value?.getDuration?.() ?? 0,
  getScale: () => normalizeComposeTimelineScale(videoTrackRef.value?.getScale?.()),
  seekTo,
  play: () => videoTrackRef.value?.play?.(),
  pause: () => videoTrackRef.value?.pause?.(),
  isPlaying: () => videoTrackRef.value?.isPlaying?.() ?? false,
  setPlaybackRate: (rate: number) => videoTrackRef.value?.setPlaybackRate?.(rate),
  updateMainClipDuration,
  updateAudioClipDuration,
  setMediaClipPlaybackRate,
  rebuildMainClipAt,
  removeMainClipsByUrl,
  patchClipsByType,
  getSelectedClipIds,
  getSelectedClips,
  setMainTrackFrame,
});
</script>

<style scoped lang="scss">
.video-compose-timeline {
  height: 100%;
  min-height: 0;

  /* 浅色对比度：补齐 ThemeConfig 无法写入的 token（深色由 html.dark 隔离 CSS 覆盖） */
  --color-border-light: var(--compose-split, rgba(14, 14, 17, 0.08));
  --color-border-strong: var(--compose-line, rgba(14, 14, 17, 0.16));
  --color-text-tertiary: var(--compose-fg-3, #8e8e99);

  /* 竖向滚动条与轨道内容固定 10px；刻度尺按「间隙 + 细条宽度」右缩，避免尺与 clip 错位 */
  --timeline-v-scroll-gap: 10px;
  --timeline-v-scrollbar-width: 8px;
  /* 假横向条左缘；JS 按控制栏实宽覆盖，缺省与 track-control-width 一致 */
  --timeline-track-control-width: 276px;

  :deep(.video-track) {
    flex: 1;
    height: auto;
    min-height: 0;
    border-radius: 0;
  }

  :deep(.tracks__scroll-container) {
    padding-right: var(--timeline-v-scroll-gap);
    scrollbar-gutter: stable;
    scrollbar-width: thin;
    box-sizing: border-box;

    &::-webkit-scrollbar {
      width: var(--timeline-v-scrollbar-width);
    }
  }

  :deep(.ruler) {
    padding-right: calc(var(--timeline-v-scroll-gap) + var(--timeline-v-scrollbar-width));
    box-sizing: border-box;
  }

  // 隐藏全局倍速调整器
  :deep(.tools-bar__select) {
    display: none;
  }

  // 隐藏 clip 选中后出现的「添加转场」按钮
  :deep(.clip__transition-btn) {
    display: none !important;
  }

  :deep(.ruler__mark) {
    width: 1px;
    opacity: 1;
  }

  :deep(.ruler__mark--major) {
    width: 2px;
  }

  :deep(.ruler__mark-label) {
    color: var(--color-text-secondary);
  }

  /* slot 按钮与轨道头 28px 图标按钮对齐 */
  .track-control-extra-btn {
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
  }

  .track-control-extra-btn:hover:not(:disabled) {
    background: var(--color-bg-medium);
    color: var(--color-text-primary);
  }

  .track-control-extra-btn:disabled {
    cursor: default;
    opacity: 0.45;
  }

  .audio-track-mute-btn.is-muted {
    background: var(--compose-accent-soft, rgba(130, 97, 255, 0.14));
    color: var(--compose-accent, var(--color-primary));
  }

  &.is-readonly {
    :deep(.tools-bar),
    :deep(.video-track__toolbar) {
      pointer-events: none;
      opacity: 0.6;
    }
  }

  &.is-catalog-drag-over {
    outline: 2px solid var(--compose-accent, #8261ff);
    outline-offset: -2px;
  }
}
</style>
