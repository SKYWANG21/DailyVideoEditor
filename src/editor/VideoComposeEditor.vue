<template>
  <div class="relative isolate h-full w-full min-h-0 overflow-hidden">
    <div class="grid h-full w-full min-h-0 grid-rows-2 grid-rows-[3fr_2fr] gap-2 overflow-hidden">
      <div class="grid min-h-0 grid-cols-[2fr_1fr] gap-4 overflow-hidden">
        <VideoComposePlayer
          ref="playerRef"
          class="h-full min-h-0"
          :class="{ 'col-span-2': readonly }"
          :video-clips="derivedMainClips"
          :override-clips="previewOverrideClips"
          :catalog-preview-active="!!previewCatalogVariant"
          :catalog-preview-label="previewCatalogLabel"
          :audio-clips="catalogPreviewActive ? [] : derivedAudioClips"
          :compose-config="catalogPreviewActive ? catalogPreviewComposeConfig : derivedComposeConfig"
          :loop-current="loopCurrent"
          :show-subtitles="!previewCatalogVariant"
          :visible-preview-subtitles="visiblePreviewSubtitles"
          :adjust-preview-subtitles="adjustPreviewSubtitles"
          :subtitle-style="subtitleStyle"
          :text-clips="textOverlayClips"
          :selected-text-clip-id="activeTextClipId"
          :readonly="readonly"
          @update:loop-current="loopCurrent = $event"
          @update:playing-idx="playingIdx = $event"
          @global-time-update="onPlayerGlobalTimeUpdate"
          @update:is-adjusting="onIsAdjustingUpdate"
          @update:video-ready="videoReady = $event"
          @clear-catalog-preview="clearCatalogPreview"
          @update:text-clip-rect="onTextClipRectUpdate"
          @select-text-clip="onSelectTextClip"
          @select-subtitle-clip="onSelectSubtitleClip"
          @update:subtitle-text="onPreviewSubtitleTextUpdate"
        />

        <VideoComposeSidebar
          v-if="!readonly"
          ref="sidebarRef"
          class="h-full min-h-0"
          :video-volume="videoVolume"
          :beauty="beauty"
          :video-volume-label="videoVolumeLabel"
          :audio-volume-label="audioVolumeLabel"
          :bgm-volume="bgmVolume"
          :audio-clip-count="audioClipCount"
          :font-label="fontLabel"
          :style-label="styleLabel"
          :subtitle-style="subtitleStyle"
          :subtitle-visible="subtitleVisible"
          :is-adjusting="isAdjusting"
          :video-ready="videoReady"
          :is-transcribing="isTranscribing"
          :segment-catalog="mergedSegmentCatalog"
          :timeline-clip-urls="timelineClipUrls"
          :preview-clip-id="previewCatalogVariant?.id"
          :readonly="readonly"
          :active-tab="sidebarTab"
          :selected-text-clip="selectedTextClipProps"
          :selected-subtitle-text="selectedSubtitleText"
          :selected-subtitle-id="activeSubtitleId"
          :has-selected-subtitle="Boolean(activeSubtitleId)"
          @open-upload-bgm="uploadAudioModalOpen = true"
          @upload-clip="uploadClipModalOpen = true"
          @regenerate-subtitles="onRegenerateSubtitles"
          @add-subtitle="onAddSubtitle"
          @preview-clip="onCatalogPreview"
          @add-clip-to-timeline="onCatalogAddToTimeline"
          @remove-catalog-clip="onRemoveCatalogVariant"
          @update:video-volume="onVideoVolumeChange"
          @update:beauty="onBeautyChange"
          @update:bgm-volume="onBgmVolumeChange"
          @update:subtitle-style="onSubtitleStyleChange"
          @update:subtitle-visible="onSubtitleVisibleChange"
          @update:subtitle-text="onSubtitleTextChange"
          @commit:subtitle-text="onSubtitleTextCommit"
          @update:active-tab="sidebarTab = $event"
          @add-text-template="onAddTextTemplate"
          @update:text-clip-props="onTextClipPropsChange"
          @font-popover-toggle="onFontPopoverToggle"
          @toggle-adjust-position="toggleAdjustSubPosition"
          @apply-global="onApplyGlobal"
        />
      </div>

      <VideoComposeTimeline
        ref="timelineRef"
        class="h-full min-h-0"
        :tracks="tracks"
        :readonly="readonly"
        :detaching-clip-ids="detachingClipIds"
        :scale="modelValue.scale"
        @update:tracks="onTracksUpdate"
        @update:scale="onTimelineScaleUpdate"
        @selection-changed="onSelectionChanged"
        @playback-play="onTimelinePlay"
        @playback-pause="onTimelinePause"
        @playback-seek="onTimelineSeek"
        @time-update="onTimelineTimeUpdate"
        @playback-ratechange="onTimelineRateChange"
        @drop-catalog-clip="onTimelineDropCatalogClip"
        @detach-audio="onTimelineDetachAudio"
      />
    </div>

    <BgmUploadModal v-model:open="uploadAudioModalOpen" :submitting="false" @uploaded="onAudioUploaded" />

    <VideoClipUploadModal v-if="!readonly" v-model:open="uploadClipModalOpen" @uploaded="onClipUploaded" />

    <SubtitleFontPopover
      v-model:font-popover-open="fontPopoverOpen"
      :font-family-dropdown-style="fontFamilyDropdownStyle"
      :font-style-dropdown-style="fontStyleDropdownStyle"
      :font-options="fontOptions"
      :style-options="styleOptions"
      :subtitle-style="subtitleStyle"
      :font-style-key="fontStyleKey"
      @select-family="onFontOptionSelect"
      @select-style="onStyleOptionSelect"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, reactive, nextTick, onBeforeUnmount, onMounted, type CSSProperties } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import VideoComposePlayer from "./VideoComposePlayer.vue";
import VideoComposeSidebar from "./VideoComposeSidebar.vue";
import VideoComposeTimeline from "./VideoComposeTimeline.vue";
import BgmUploadModal from "./BgmUploadModal.vue";
import VideoClipUploadModal, { type UploadedComposeClip } from "./VideoClipUploadModal.vue";
import SubtitleFontPopover from "./SubtitleFontPopover.vue";
import type { MediaClip, RectConfig, TextClip } from "@/clip-track";
import type {
  VideoComposeClipInput,
  VideoComposeEditorModel,
  VideoClipItem,
  PreviewAudioClip,
  SubtitleItem,
  BgmItem,
  ComposeTrack,
  ComposeConfig,
  ComposeSubtitleClip,
  SubtitleStyleConfig,
  ComposeSegmentClipGroup,
  ComposeSegmentClipVariant,
  ComposeTextOverlayClip,
  BeautyParams,
} from "@/types/videoCompose";
import {
  hasTimelineSubtitles,
  mapTracksToComposeConfig,
  mapTracksToPreviewAudioClips,
  mapMainTrackToVideoClips,
  mapTracksToTextOverlayClips,
  countAudioClips,
  getDefaultSubtitleStyleSnapshot,
  pickSubtitleStyleFromClip,
  createDefaultSubtitleStyle,
  createDefaultBeautyParams,
  readBeautyParams,
  readClipConfig,
  readTextClipConfig,
  normalizeComposeTimelineScale,
} from "@/types/videoCompose";
import type { ComposeApplyGlobalScope, ComposeSidebarTab, SelectedTextClipProps, SubtitleTextEditPayload } from "./VideoComposeSidebar.vue";
import { dbToGain, gainToDb } from "./volumeDb";
import type { PatchableClipType } from "./VideoComposeTimeline.vue";
import {
  findTextTemplateById,
  getTextTemplateAspect,
  isCssHexColor,
  loadTextTemplateCatalog,
  type TextTemplateItem,
} from "./textTemplateCatalog";
import {
  buildComposeClipInputsSignature,
  probeClipDurationsWithRetry,
  probeVideoDuration,
  COMPOSE_CLIP_PLACEHOLDER_DURATION_SEC,
  isComposeClipDurationProbeable,
  resolveComposeClips,
} from "@/hooks/useResolveComposeClips";
import {
  COMPOSE_UPLOAD_CATALOG_SEGMENT_INDEX,
  collectStep3InputClipIds,
  inferUploadedVariantsFromTracks,
  mergeUploadedCatalogVariants,
  resolveCatalogVariantPlayUrl,
} from "@/hooks/useComposeUploadCatalog";
import { buildMockVideoClips, isVideoComposeMockEnabled } from "./videoComposeMockClips";
import { formatSubtitleClock, parseSubtitleClock } from "@/hooks/useVideoComposeTimelineScale";
import { useComposeDetachAudio } from "@/hooks/useComposeDetachAudio";
import { useComposeExtractAudioCleanup } from "@/hooks/useComposeExtractAudioCleanup";

const props = withDefaults(
  defineProps<{
    /** 视频片段入参 */
    clips: VideoComposeClipInput[];
    /** 编辑器聚合状态 */
    modelValue: VideoComposeEditorModel;
    /** 无已有字幕时挂载后自动转录 */
    autoTranscribe?: boolean;
    /** 只读模式 */
    readonly?: boolean;
    /** 各片段历史版本素材库（侧栏展示，不自动上轴） */
    segmentCatalog?: ComposeSegmentClipGroup[];
  }>(),
  {
    autoTranscribe: true,
    readonly: false,
    segmentCatalog: () => [],
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: VideoComposeEditorModel];
  ready: [];
}>();

const playerRef = ref<InstanceType<typeof VideoComposePlayer> | null>(null);
const sidebarRef = ref<InstanceType<typeof VideoComposeSidebar> | null>(null);
const timelineRef = ref<InstanceType<typeof VideoComposeTimeline> | null>(null);

/** 分离原声 OSS 注册表；离开/保存时异步清理未引用 compose_extract 文件 */
const { composeExtractAudioUrls, registerComposeExtractAudioUrl, syncRegistryFromTracks, scheduleOrphanComposeExtractCleanup } =
  useComposeExtractAudioCleanup(props.modelValue.composeExtractAudioUrls || []);

/** 右键「分离音轨」：FIFO 队列 + 重试 + 状态（唯一入口） */
const { detachAudioForVideoClip, detachingClipIds } = useComposeDetachAudio(() => timelineRef.value, registerComposeExtractAudioUrl);

/** 派生主轨片段（喂播放器，含 volume/rate/trim） */
const derivedMainClips = ref<VideoClipItem[]>([]);
/** 派生音频片段（按全局时间命中混音） */
const derivedAudioClips = ref<PreviewAudioClip[]>([]);
/** 播放器当前片段索引 */
const playingIdx = ref(0);
const globalTime = ref(0);
const isAdjusting = ref(false);
const videoReady = ref(false);
const loopCurrent = ref(false);
const isTranscribing = ref(false);

/** 本地上传/素材库选中片段在侧栏 catalog 的分组序号（与 Step3 片段区分） */
const UPLOAD_CATALOG_SEGMENT_INDEX = COMPOSE_UPLOAD_CATALOG_SEGMENT_INDEX;

/** 本地上传或素材库选中的片段（侧栏展示，不自动上轴） */
const uploadedCatalogVariants = ref<ComposeSegmentClipVariant[]>([]);

/** 从 model / 主轨恢复侧栏「上传片段」列表 */
function restoreUploadedCatalogFromModel(): void {
  uploadedCatalogVariants.value = mergeUploadedCatalogVariants(
    props.modelValue.uploadedClipCatalog,
    inferUploadedVariantsFromTracks(props.modelValue.tracks, collectStep3InputClipIds(props.clips)),
  );
}

restoreUploadedCatalogFromModel();

/** Step3 历史 + 本地上传合并后的侧栏素材库 */
const mergedSegmentCatalog = computed<ComposeSegmentClipGroup[]>(() => {
  const base = props.segmentCatalog ?? [];
  if (!uploadedCatalogVariants.value.length) return base;

  const uploadGroup: ComposeSegmentClipGroup = {
    segmentIndex: UPLOAD_CATALOG_SEGMENT_INDEX,
    segmentTitle: "上传片段",
    variants: uploadedCatalogVariants.value,
  };
  return [uploadGroup, ...base];
});

/** 侧栏素材库当前预览中的历史版本 */
const previewCatalogVariant = ref<ComposeSegmentClipVariant | null>(null);

/** 是否处于素材库预览（用于静音 BGM 轨） */
const catalogPreviewActive = computed(() => !!previewCatalogVariant.value);

const previewClipDuration = ref(0);

/** 主播放器 override：素材库预览单 clip */
const previewOverrideClips = computed<VideoClipItem[] | null>(() => {
  const v = previewCatalogVariant.value;
  if (!v?.url) return null;
  return [
    {
      id: `catalog-preview-${v.id}`,
      title: v.segmentTitle,
      url: v.url,
      taskId: v.taskId,
      durationSec: previewClipDuration.value || 0.1,
      src: v.poster,
    },
  ];
});

/** 素材库预览顶栏文案 */
const previewCatalogLabel = computed(() => {
  const v = previewCatalogVariant.value;
  if (!v) return "";
  return v.label ? `${v.segmentTitle} · ${v.label}` : v.segmentTitle;
});

/** 时间轴已有视频 URL，供侧栏「已添加」标记 */
const timelineClipUrls = computed(() => {
  const urls = new Set<string>();
  for (const clip of derivedMainClips.value) {
    if (clip.url?.trim()) urls.add(clip.url.trim());
  }
  return urls;
});

/** 拉取侧栏素材库预览片段时长 */
function probeCatalogPreviewDuration(url: string): void {
  if (!url) return;
  const video = document.createElement("video");
  video.preload = "metadata";
  video.src = url;
  video.onloadedmetadata = () => {
    if (Number.isFinite(video.duration) && video.duration > 0) {
      previewClipDuration.value = video.duration;
    }
    video.removeAttribute("src");
    video.load();
  };
}

/** 侧栏单击：主播放器预览历史版本（不改时间轴） */
function onCatalogPreview(variant: ComposeSegmentClipVariant): void {
  if (!variant.url?.trim()) {
    ElMessage.warning("该版本暂无可用视频");
    return;
  }
  playSeq += 1;
  playInFlight = false;
  playerDrivingTimeline = false;
  playerRef.value?.pause();
  syncTimelinePlaybackUi(false);
  previewClipDuration.value = 0;
  previewCatalogVariant.value = variant;
  probeCatalogPreviewDuration(variant.url);
  void nextTick(() => {
    void playerRef.value?.seek?.(0);
    void playerRef.value?.play?.();
  });
}

/** 清除素材库预览态（不 resync；由后续时间轴 seek/play 接管） */
function exitCatalogPreviewIfNeeded(): boolean {
  if (!previewCatalogVariant.value) return false;
  previewCatalogVariant.value = null;
  previewClipDuration.value = 0;
  playerDrivingTimeline = false;
  playInFlight = false;
  return true;
}

/** 退出预览后等待 Player 切回时间轴 clip，再执行回调 */
function afterExitCatalogPreview(action: (exitedPreview: boolean) => void): void {
  const exited = exitCatalogPreviewIfNeeded();
  if (exited) {
    void nextTick(() => action(true));
    return;
  }
  action(false);
}

/** 退出素材库预览，恢复时间轴同步播放 */
function clearCatalogPreview(): void {
  if (!exitCatalogPreviewIfNeeded()) return;
  const t = timelineRef.value?.getCurrentTime?.() ?? globalTime.value;
  void nextTick(() => {
    void playerRef.value?.resync?.(t);
  });
}

/** 将素材库版本写入主轨（按钮追加末尾 / 拖拽指定时间） */
async function addCatalogVariantToTimeline(
  variant: ComposeSegmentClipVariant,
  options?: { startTime?: number; successMessage?: string },
): Promise<void> {
  if (props.readonly) return;
  if (!variant.url?.trim()) {
    ElMessage.warning("该版本暂无可用视频");
    return;
  }

  exitCatalogPreviewIfNeeded();

  const playUrl = await resolveCatalogVariantPlayUrl(variant);
  if (!playUrl?.trim()) {
    ElMessage.warning("该版本暂无可用视频");
    return;
  }
  if (timelineClipUrls.value.has(playUrl.trim())) {
    ElMessage.info("该版本已在时间轴中");
    return;
  }

  const durationSec = await probeVideoDuration(playUrl);
  /** 每次上轴独立 id，避免删除后复用 variant.id 导致 vue-clip-track 缩略图缓存不刷新 */
  const catalogClipKey = variant.segmentIndex === UPLOAD_CATALOG_SEGMENT_INDEX ? variant.id : `hist-${variant.segmentIndex}-${variant.id}`;
  const clipId = `${catalogClipKey}-tl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const clipItem = {
    id: clipId,
    title: `${variant.segmentTitle}${variant.label ? ` · ${variant.label}` : ""}`,
    url: playUrl,
    durationSec: Math.max(COMPOSE_CLIP_PLACEHOLDER_DURATION_SEC, durationSec || COMPOSE_CLIP_PLACEHOLDER_DURATION_SEC),
    taskId: variant.taskId,
  };

  const isDragInsert = options?.startTime != null && options.startTime >= 0;

  if (isDragInsert) {
    timelineRef.value?.insertClipToMainAt(clipItem, options.startTime ?? 0);
  } else {
    timelineRef.value?.addClipToMain(clipItem);
  }
  syncDerivedClipsFromTimeline();

  /** 添加后重建 clip，触发 vue-clip-track 重新生成缩略图条（点击/拖拽统一） */
  const refreshClipThumbnails = (probedDuration: number) => {
    rebuildMainClipThumbnail(clipId, probedDuration);
    syncDerivedClipsFromTimeline();
  };

  if (variant.segmentIndex === UPLOAD_CATALOG_SEGMENT_INDEX && playUrl !== variant.url.trim()) {
    const idx = uploadedCatalogVariants.value.findIndex((v) => v.id === variant.id);
    if (idx >= 0) {
      uploadedCatalogVariants.value[idx] = { ...uploadedCatalogVariants.value[idx], url: playUrl };
      persistUploadCatalogNow();
    }
  }

  if (durationSec <= COMPOSE_CLIP_PLACEHOLDER_DURATION_SEC) {
    const target = derivedMainClips.value.find((c) => c.id === clipId);
    if (target) {
      await probeClipDurationsWithRetry([target], (clip) => {
        const probed = clip.durationSec ?? 0;
        if (probed <= COMPOSE_CLIP_PLACEHOLDER_DURATION_SEC) return;
        refreshClipThumbnails(probed);
      });
    }
  } else {
    await nextTick();
    refreshClipThumbnails(clipItem.durationSec);
  }

  ElMessage.success(options?.successMessage ?? "已添加到时间轴");
}

/** 侧栏：将历史版本追加到时间轴主轨末尾 */
async function onCatalogAddToTimeline(variant: ComposeSegmentClipVariant): Promise<void> {
  await addCatalogVariantToTimeline(variant);
}

/** 侧栏：从上传片段列表移除（已在时间轴则确认后一并移除） */
async function onRemoveCatalogVariant(variant: ComposeSegmentClipVariant): Promise<void> {
  if (props.readonly) return;
  if (variant.segmentIndex !== UPLOAD_CATALOG_SEGMENT_INDEX) return;

  const url = variant.url?.trim();
  if (url && timelineClipUrls.value.has(url)) {
    try {
      await ElMessageBox.confirm("该片段已在时间轴中，是否一并移除？", "移除片段", {
        type: "warning",
        confirmButtonText: "移除",
        cancelButtonText: "取消",
      });
    } catch {
      return;
    }
    timelineRef.value?.removeMainClipsByUrl(url);
    syncDerivedClipsFromTimeline();
  }

  if (previewCatalogVariant.value?.id === variant.id) {
    clearCatalogPreview();
  }

  uploadedCatalogVariants.value = uploadedCatalogVariants.value.filter((v) => v.id !== variant.id);

  persistUploadCatalogNow();
  ElMessage.success("已从片段列表移除");
}

/** 侧栏拖拽：在松手位置插入主轨 */
async function onTimelineDropCatalogClip(payload: { variant: ComposeSegmentClipVariant; startTime: number }): Promise<void> {
  await addCatalogVariantToTimeline(payload.variant, { startTime: payload.startTime });
}

/** 时间轴右键「分离音轨」：唯一分离入口，委托 Hook 调后端并写轨 */
async function onTimelineDetachAudio(payload: { clipId: string; sourceUrl: string }): Promise<void> {
  void payload.sourceUrl;
  await detachAudioForVideoClip(payload.clipId);
  syncDerivedClipsFromTimeline();
  syncSidebarFromTracks();
  flush();
}

/** 播放中由 Player 驱动时间线游标；暂停时允许时间线 scrub 驱动 Player */
let playerDrivingTimeline = false;
/** 递增以作废进行中的异步 play（连点暂停/播放） */
let playSeq = 0;
/** seek+play 尚未完成，避免 timeupdate 把刚点的播放立刻暂停 */
let playInFlight = false;
/** 避免 timeline seek ↔ player seek 回环 */
let suppressTimelineSeekToPlayer = false;
/** 程序化同步时间轴播放 UI，避免反向触发 playback-play */
let suppressTimelinePlaybackEmit = false;
/** 时间轴工具栏是否处于「播放中」展示态（与 Player 对齐） */
let timelineUiPlaying = false;

/** 多轨真相源（与 model.tracks 同步） */
const tracks = ref<ComposeTrack[]>(props.modelValue.tracks?.length ? JSON.parse(JSON.stringify(props.modelValue.tracks)) : []);

/** 时间轴当前选中 clip id 列表 */
const selectedClipIds = ref<string[]>([]);

/** 侧栏当前 Tab */
const sidebarTab = ref<ComposeSidebarTab>();

/** Sidebar / Player 展示用样式（从目标 clip 同步；调整位置时就地写回） */
const subtitleStyle = reactive<SubtitleStyleConfig>(getDefaultSubtitleStyleSnapshot());
/** 当前作用目标的字幕可见性（SubtitleClip.visible） */
const subtitleVisible = ref(true);
/** 侧栏视频音量（dB）；null 为静音。默认对应线性增益 0.8 */
const videoVolume = ref<number | null>(gainToDb(0.8));
/** 侧栏美颜。写入当前视频 clip 的 config.beauty */
const beauty = ref<BeautyParams>(createDefaultBeautyParams());
/** 侧栏音轨音量（dB）；null 为静音。默认对应线性增益 0.5 */
const bgmVolume = ref<number | null>(gainToDb(0.5));

/** 从 tracks 同步到侧栏时置位，避免回写循环 */
let syncingFromTracks = false;

const audioClipCount = computed(() => countAudioClips(tracks.value));

/** 播放器仍吃旧 ComposeConfig（由 tracks + 当前播片段临时派生） */
const derivedComposeConfig = computed<ComposeConfig>(() => {
  const videoId = derivedMainClips.value[playingIdx.value]?.id || activeVideoId.value;
  const audioId = activeAudioId.value;
  return mapTracksToComposeConfig(tracks.value, {
    videoClipId: videoId,
    audioClipId: audioId,
  });
});

/** 素材库预览：仅播 video 内嵌原声，禁用 syncBgm 对时间轴分离原声/BGM 的 fallback */
const catalogPreviewComposeConfig = computed<ComposeConfig>(() => ({
  ...derivedComposeConfig.value,
  bgm: null,
  bgmStartTime: 0,
  bgmSourceStartTime: 0,
}));

/** 当前播放主轨片段在时间轴上的 [start, end] */
const currentMainClipRange = computed<{ start: number; end: number } | null>(() => {
  const clip = derivedMainClips.value[playingIdx.value];
  if (!clip) return null;
  const start = clip.startTime ?? derivedMainClips.value.slice(0, playingIdx.value).reduce((s, c) => s + (c.durationSec || 0), 0);
  const end = clip.endTime ?? start + (clip.durationSec || 0);
  return { start, end };
});

/** 选中且类型匹配的 audio / video / subtitle clip id；否则 undefined（表示全轨） */
const activeAudioId = computed(() => findSelectedIdOfType("audio"));
const activeVideoId = computed(() => findSelectedIdOfType("video"));
const activeSubtitleId = computed(() => findSelectedIdOfType("subtitle"));
const activeTextClipId = computed(() => findSelectedIdOfType("text"));

function findSelectedIdOfType(type: "audio" | "video" | "subtitle" | "text"): string | undefined {
  if (!selectedClipIds.value.length) return undefined;
  for (const id of selectedClipIds.value) {
    for (const track of tracks.value) {
      const clip = track.clips.find((c) => c.id === id);
      if (clip && clip.type === type) return id;
    }
  }
  return undefined;
}

function findClipById(id: string | undefined): ComposeTrack["clips"][number] | undefined {
  if (!id) return undefined;
  for (const track of tracks.value) {
    const clip = track.clips.find((c) => c.id === id);
    if (clip) return clip;
  }
  return undefined;
}

/** 根据 clip id 找所在轨道 id */
function findTrackIdByClipId(clipId: string | undefined): string | undefined {
  if (!clipId) return undefined;
  for (const track of tracks.value) {
    if (track.clips.some((c) => c.id === clipId)) return track.id;
  }
  return undefined;
}

/** 已分离原声时，video clip 对应的 linked audio clip id */
function getLinkedOriginalAudioIdForVideo(videoClipId: string | undefined): string | undefined {
  if (!videoClipId) return undefined;
  const clip = findClipById(videoClipId);
  if (!clip || clip.type !== "video") return undefined;
  const config = readClipConfig(clip.config);
  if (!config.audioDetached || !config.linkedAudioClipId) return undefined;
  return config.linkedAudioClipId;
}

/** 侧栏视频 Tab 音量文案：分离后内嵌音轨已静音，原声在音轨 Tab 独立调节 */
const videoVolumeLabel = computed(() => {
  const videoId = activeVideoId.value || firstClipOfType("video")?.id;
  return getLinkedOriginalAudioIdForVideo(videoId) ? "视频音量" : "原视频音量";
});

function firstClipOfType(type: "audio" | "video" | "subtitle" | "text"): ComposeTrack["clips"][number] | undefined {
  for (const track of tracks.value) {
    if (type === "video" && !(track.isMain || track.type === "video")) continue;
    if (type === "text" && track.type !== "sticker" && track.type !== "text") continue;
    if (type !== "video" && type !== "text" && track.type !== type) continue;
    const clip = track.clips.find((c) => c.type === type);
    if (clip) return clip;
  }
  return undefined;
}

/** 选中贴图的侧栏属性；未选中为 null（展示资源列表） */
const selectedTextClipProps = computed<SelectedTextClipProps | null>(() => {
  const clip = findClipById(activeTextClipId.value);
  if (!clip || clip.type !== "text") return null;
  const textClip = clip as TextClip;
  const templateId = readTextClipConfig(textClip.config).templateId;
  const fallbackColor = (templateId && findTextTemplateById(templateId)?.defaultColor) || "";
  const resolvedColor = (textClip.color || fallbackColor).trim();
  return {
    text: textClip.text || "",
    fontSize: textClip.fontSize ?? 32,
    color: isCssHexColor(resolvedColor) ? resolvedColor : "",
  };
});

/** 当前选中字幕 clip 的文案；未选中为空字符串 */
const selectedSubtitleText = computed(() => {
  const clip = findClipById(activeSubtitleId.value);
  if (!clip || clip.type !== "subtitle") return "";
  return (clip as ComposeSubtitleClip).text || "";
});

/** 播放器贴图 overlay 数据 */
const textOverlayClips = computed<ComposeTextOverlayClip[]>(() => mapTracksToTextOverlayClips(tracks.value));

/** 音轨 Tab 滑条目标：优先当前选中的 audio clip，未选中则 fallback 第一个 audio */
function resolveActiveAudioVolumeClip(): MediaClip | undefined {
  const selected = findClipById(activeAudioId.value);
  if (selected?.type === "audio") {
    return selected as MediaClip;
  }
  return firstClipOfType("audio") as MediaClip | undefined;
}

/** 侧栏音轨 Tab 音量文案：随选中 clip 的 audioRole 变化 */
const audioVolumeLabel = computed(() => {
  const clip = findClipById(activeAudioId.value);
  if (clip?.type !== "audio") {
    return "BGM 音量";
  }
  const role = readClipConfig(clip.config).audioRole;
  if (role === "original") {
    return "原声音量";
  }
  if (role === "bgm") {
    return "BGM 音量";
  }
  return "音轨音量";
});

/**
 * 片段线性增益 → 侧栏分贝。
 * 缺省才用 fallback；显式 0 保持静音，不把已存增益收成展示值回写。
 */
function volumeToDb(volume: number | undefined, fallbackGain: number): number | null {
  if (volume == null || !Number.isFinite(volume)) return gainToDb(fallbackGain);
  return gainToDb(volume);
}

/** 从 tracks / 选中态同步侧栏展示值 */
function syncSidebarFromTracks(): void {
  syncingFromTracks = true;
  const videoClip = (findClipById(activeVideoId.value) || firstClipOfType("video")) as MediaClip | undefined;
  const audioClip = resolveActiveAudioVolumeClip();
  const subClip = (findClipById(activeSubtitleId.value) || firstClipOfType("subtitle")) as ComposeSubtitleClip | undefined;

  videoVolume.value = volumeToDb(videoClip?.volume, 0.8);
  beauty.value = readBeautyParams(readClipConfig(videoClip?.config).beauty);
  // 无音轨 clip 时保留用户侧栏已调值，避免 tracks 同步时用默认 -6 dB 覆盖
  if (audioClip) {
    bgmVolume.value = volumeToDb(audioClip.volume, 0.5);
  }

  if (subClip && subClip.type === "subtitle") {
    Object.assign(subtitleStyle, pickSubtitleStyleFromClip(subClip));
    subtitleVisible.value = subClip.visible !== false;
  } else {
    Object.assign(subtitleStyle, createDefaultSubtitleStyle());
    subtitleVisible.value = true;
  }
  void nextTick(() => {
    syncingFromTracks = false;
  });
}

function patchClips(type: PatchableClipType, patch: Record<string, unknown>, clipId?: string): void {
  timelineRef.value?.patchClipsByType(type, patch, clipId ? { clipId } : undefined);
}

/** 侧栏视频分贝写回当前视频 clip 的线性增益 */
function onVideoVolumeChange(db: number | null): void {
  videoVolume.value = db;
  patchClips("video", { volume: dbToGain(db) }, activeVideoId.value);
}

/** 侧栏美颜写回当前视频 clip。未选中时与音量一样写到全部视频片段 */
function onBeautyChange(next: BeautyParams): void {
  beauty.value = next;
  patchClips("video", { config: { beauty: { ...next } } }, activeVideoId.value);
}

/** 侧栏音轨分贝写回当前音频 clip 的线性增益 */
function onBgmVolumeChange(db: number | null): void {
  bgmVolume.value = db;
  const target = resolveActiveAudioVolumeClip();
  patchClips("audio", { volume: dbToGain(db) }, target?.id);
}

function onSubtitleStyleChange(style: SubtitleStyleConfig): void {
  Object.assign(subtitleStyle, style);
  patchClips("subtitle", { ...style }, activeSubtitleId.value);
}

function onSubtitleVisibleChange(visible: boolean): void {
  subtitleVisible.value = visible;
  patchClips("subtitle", { visible }, activeSubtitleId.value);
}

/** 侧栏输入非空时写回 payload.clipId（聚焦时锁定，避免切选中写到新 clip） */
function onSubtitleTextChange(payload: SubtitleTextEditPayload): void {
  if (!payload.clipId || !payload.text.trim()) return;
  patchClips("subtitle", { text: payload.text }, payload.clipId);
}

/** 侧栏失焦/切选中提交；空文案拒绝并提示，不写回 */
function onSubtitleTextCommit(payload: SubtitleTextEditPayload): void {
  if (!payload.clipId) return;
  const trimmed = payload.text.trim();
  if (!trimmed) {
    ElMessage.warning("字幕内容不能为空，请输入字幕后重试");
    return;
  }
  patchClips("subtitle", { text: trimmed }, payload.clipId);
}

/** 预览区双击字幕：同步时间轴选中态，侧栏切到字幕设置 */
function onSelectSubtitleClip(clipId: string): void {
  if (props.readonly) return;
  timelineRef.value?.selectClipById?.(clipId);
  selectedClipIds.value = [clipId];
  sidebarTab.value = "subtitle";
}

/** 预览区字幕就地编辑提交；空文案拒绝并提示 */
function onPreviewSubtitleTextUpdate(payload: { clipId: string; text: string }): void {
  const trimmed = payload.text.trim();
  if (!trimmed) {
    ElMessage.warning("字幕内容不能为空，请输入字幕后重试");
    return;
  }
  patchClips("subtitle", { text: trimmed }, payload.clipId);
}

/** 将当前侧栏值强制同步到对应轨道全部 clip */
function onApplyGlobal(scope: ComposeApplyGlobalScope): void {
  if (scope === "audio") {
    patchClips("audio", { volume: dbToGain(bgmVolume.value) });
    return;
  }
  if (scope === "video") {
    patchClips("video", {
      volume: dbToGain(videoVolume.value),
      config: { beauty: { ...beauty.value } },
    });
    return;
  }
  patchClips("subtitle", {
    ...subtitleStyle,
    visible: subtitleVisible.value,
  });
}

/** 侧栏：将文字模板添加到贴图轨光标处 */
function onAddTextTemplate(item: TextTemplateItem): void {
  if (props.readonly) return;
  const size = playerRef.value?.getVideoSize?.() ?? null;
  const clipId = timelineRef.value?.addTextClip({
    templateId: item.id,
    sourceUrl: item.sourceUrl,
    name: item.name,
    text: item.defaultText,
    fontSize: item.defaultFontSize,
    color: null,
    aspect: getTextTemplateAspect(item.id),
    videoWidth: size?.width,
    videoHeight: size?.height,
  });
  if (!clipId) return;
  sidebarTab.value = "textTemplate";
  ElMessage.success("已添加到时间轴");
}

/** 侧栏：更新选中 TextClip 的 text / fontSize / color */
function onTextClipPropsChange(patch: { text?: string; fontSize?: number; color?: string }): void {
  const clipId = activeTextClipId.value;
  if (!clipId) return;
  patchClips("text", patch, clipId);
}

/** 预览区拖拽贴图结束，写回 rect */
function onTextClipRectUpdate(payload: { clipId: string; rect: RectConfig }): void {
  patchClips("text", { rect: payload.rect }, payload.clipId);
}

/** 预览区点选贴图：同步时间轴选中态，侧栏切到属性面板 */
function onSelectTextClip(clipId: string): void {
  timelineRef.value?.selectClipById?.(clipId);
  selectedClipIds.value = [clipId];
  sidebarTab.value = "textTemplate";
}

function toggleAdjustSubPosition(): void {
  playerRef.value?.toggleAdjustSubPosition();
}

/** 退出调整模式时：位置写回整轨（未选中字幕则全部字幕轨），字号仍按原 clip 范围 */
function onIsAdjustingUpdate(next: boolean): void {
  const wasAdjusting = isAdjusting.value;
  isAdjusting.value = next;
  if (wasAdjusting && !next) {
    const positionPatch = {
      marginL: subtitleStyle.marginL,
      marginR: subtitleStyle.marginR,
      marginV: subtitleStyle.marginV,
    };
    const selectedId = activeSubtitleId.value;
    const trackId = findTrackIdByClipId(selectedId);
    if (trackId) {
      timelineRef.value?.patchClipsByType("subtitle", positionPatch, { trackId });
    } else {
      patchClips("subtitle", positionPatch, selectedId);
    }
    patchClips("subtitle", { fontSize: subtitleStyle.fontSize }, selectedId);
  }
}

function syncDerivedClipsFromTimeline(): void {
  const fromApi = timelineRef.value?.getMainVideoClips?.();
  derivedMainClips.value = fromApi?.length ? fromApi : mapMainTrackToVideoClips(tracks.value);
  derivedAudioClips.value = mapTracksToPreviewAudioClips(tracks.value);
  if (!hasPlayableTimelineMedia()) {
    resetTimelinePlaybackWhenEmpty();
  }
}

/** 时间轴是否存在可播放的视频或音轨 clip */
function hasPlayableTimelineMedia(): boolean {
  return derivedMainClips.value.length > 0 || derivedAudioClips.value.length > 0;
}

/** 时间轴清空后：停止播放并将游标归零，避免空轴墙钟空转 */
function resetTimelinePlaybackWhenEmpty(): void {
  if (globalTime.value <= 0.001 && !isPlayerPlaying() && !playInFlight) return;
  playSeq += 1;
  playInFlight = false;
  playerDrivingTimeline = false;
  globalTime.value = 0;
  playerRef.value?.pause?.();
  playerRef.value?.refreshBgm?.();
  suppressTimelineSeekToPlayer = true;
  timelineRef.value?.seekTo?.(0);
  requestAnimationFrame(() => {
    suppressTimelineSeekToPlayer = false;
  });
  syncTimelinePlaybackUi(false);
}

/** 主轨布局签名：拖动/裁剪/换序等会影响预览定位 */
function mainVideoLayoutSig(list: VideoClipItem[]): string {
  return list
    .map(
      (c) =>
        `${c.id}:${c.url}:${c.startTime ?? ""}:${c.endTime ?? ""}:${c.durationSec}:${c.trimStart ?? ""}:${c.trimEnd ?? ""}:${c.playbackRate ?? ""}`,
    )
    .join("|");
}

let lastMainLayoutSig = "";

function onTracksUpdate(next: ComposeTrack[]): void {
  tracks.value = next;
  syncDerivedClipsFromTimeline();
  if (!syncingFromTracks) syncSidebarFromTracks();

  const sig = mainVideoLayoutSig(derivedMainClips.value);
  if (sig === lastMainLayoutSig) return;
  lastMainLayoutSig = sig;
  const t = timelineRef.value?.getCurrentTime?.() ?? globalTime.value;
  void nextTick(() => {
    void playerRef.value?.resync?.(t);
  });
}

/** 时间轴倍率变更：写入工程 JSON（与 tracks 共用 debounce persist） */
function onTimelineScaleUpdate(_scale: number): void {
  scheduleTracksPersist();
}

function onSelectionChanged(ids: string[]): void {
  selectedClipIds.value = ids || [];
  syncSidebarFromTracks();
  if (findSelectedIdOfType("text")) {
    sidebarTab.value = "textTemplate";
  }
}

/** 主轨时间轴总时长（秒） */
function mainTimelineTotalSec(): number {
  const clips = derivedMainClips.value;
  if (!clips.length) return 0;
  let maxEnd = 0;
  let hasAbs = false;
  for (const c of clips) {
    if (c.endTime != null) {
      hasAbs = true;
      maxEnd = Math.max(maxEnd, c.endTime);
    }
  }
  if (hasAbs) return maxEnd;
  return clips.reduce((sum, c) => sum + (c.durationSec || 0), 0);
}

/** 游标是否在时间轴末尾（播放结束后点播放应从头重播） */
function isTimelineAtEnd(timeSec: number): boolean {
  const total = mainTimelineTotalSec();
  return total > 0 && timeSec >= total - 0.04;
}

/** 读取 Player 是否正在播放（expose 的 ref 在父级已解包为 boolean） */
function isPlayerPlaying(): boolean {
  const p = playerRef.value as { isPlaying?: boolean | { value: boolean } } | null;
  if (!p) return false;
  const v = p.isPlaying;
  if (typeof v === "boolean") return v;
  return Boolean(v?.value);
}

/** 同步时间轴工具栏播放/暂停图标（不触发 playback 事件回环） */
function syncTimelinePlaybackUi(playing: boolean): void {
  if (playing && !hasPlayableTimelineMedia() && !previewCatalogVariant.value) {
    playing = false;
  }
  if (playing === timelineUiPlaying) return;
  timelineUiPlaying = playing;
  suppressTimelinePlaybackEmit = true;
  try {
    if (playing) timelineRef.value?.play?.();
    else timelineRef.value?.pause?.();
  } finally {
    requestAnimationFrame(() => {
      suppressTimelinePlaybackEmit = false;
    });
  }
}

/** 时间线播放 → Player（以时间轴游标为准；play 内部按需 seek，避免连 seek 两次） */
function onTimelinePlay(): void {
  if (suppressTimelinePlaybackEmit) return;

  if (!hasPlayableTimelineMedia() && !previewCatalogVariant.value) {
    resetTimelinePlaybackWhenEmpty();
    return;
  }

  const inCatalogPreview = !!previewCatalogVariant.value;
  if (!inCatalogPreview && isPlayerPlaying()) return;

  if (inCatalogPreview) {
    playSeq += 1;
    playerRef.value?.pause?.();
  }

  afterExitCatalogPreview((exitedPreview) => {
    const seq = ++playSeq;
    playInFlight = true;
    playerDrivingTimeline = true;
    let t = timelineRef.value?.getCurrentTime?.() ?? globalTime.value;
    if (isTimelineAtEnd(t)) {
      t = 0;
      globalTime.value = 0;
      suppressTimelineSeekToPlayer = true;
      timelineRef.value?.seekTo?.(0);
      requestAnimationFrame(() => {
        suppressTimelineSeekToPlayer = false;
      });
    } else {
      globalTime.value = t;
    }
    void (async () => {
      try {
        if (exitedPreview) {
          await playerRef.value?.resync?.(t);
          if (seq !== playSeq) return;
        }
        await playerRef.value?.play?.();
        if (seq !== playSeq) return;
        syncTimelinePlaybackUi(true);
      } finally {
        if (seq === playSeq) playInFlight = false;
      }
    })();
  });
}

function onTimelinePause(): void {
  if (suppressTimelinePlaybackEmit) return;
  playSeq += 1;
  playInFlight = false;
  playerRef.value?.pause?.();
  playerDrivingTimeline = false;
  const t = globalTime.value;
  suppressTimelineSeekToPlayer = true;
  timelineRef.value?.seekTo?.(t);
  requestAnimationFrame(() => {
    suppressTimelineSeekToPlayer = false;
  });
  syncTimelinePlaybackUi(false);
}

/** 时间线拖尺 / seek → Player（播放中由 Player 主时钟时忽略 time-update） */
function onTimelineSeek(timeSec: number): void {
  if (suppressTimelineSeekToPlayer) return;
  afterExitCatalogPreview((exitedPreview) => {
    playerDrivingTimeline = false;
    if (exitedPreview) {
      void playerRef.value?.resync?.(timeSec);
    } else {
      void playerRef.value?.seek?.(timeSec);
    }
  });
}

function onTimelineTimeUpdate(timeSec: number): void {
  if (playerDrivingTimeline || suppressTimelineSeekToPlayer) return;
  if (isPlayerPlaying()) return;
  afterExitCatalogPreview((exitedPreview) => {
    if (exitedPreview) {
      void playerRef.value?.resync?.(timeSec);
    } else {
      void playerRef.value?.seek?.(timeSec);
    }
  });
}

function onTimelineRateChange(rate: number): void {
  playerRef.value?.setPlaybackRate?.(rate);
}

/**
 * Player 全局时间 → 时间线游标；loopCurrent 时强制在当前片段内回环。
 * 素材库预览时主播放器独立播放，不同步时间轴游标。
 */
function onPlayerGlobalTimeUpdate(timeSec: number): void {
  if (previewCatalogVariant.value) return;

  globalTime.value = timeSec;
  const playing = isPlayerPlaying();

  if (!playing) {
    if (playInFlight) return;
    if (playerDrivingTimeline) {
      playerDrivingTimeline = false;
    }
    syncTimelinePlaybackUi(false);
    return;
  }

  if (!hasPlayableTimelineMedia()) {
    resetTimelinePlaybackWhenEmpty();
    return;
  }

  syncTimelinePlaybackUi(true);
  playerDrivingTimeline = true;

  if (loopCurrent.value) {
    const range = currentMainClipRange.value;
    if (range && timeSec >= range.end - 0.02) {
      suppressTimelineSeekToPlayer = true;
      timelineRef.value?.seekTo?.(range.start);
      requestAnimationFrame(() => {
        suppressTimelineSeekToPlayer = false;
      });
      return;
    }
  }

  suppressTimelineSeekToPlayer = true;
  timelineRef.value?.seekTo?.(timeSec);
  requestAnimationFrame(() => {
    suppressTimelineSeekToPlayer = false;
  });
}

function isSubtitleActive(sub: SubtitleItem, timeSec: number): boolean {
  const start = parseSubtitleClock(sub.start);
  const end = parseSubtitleClock(sub.end);
  return timeSec >= start && timeSec < end;
}

/** 字幕轨可见 clip → 预览用 SubtitleItem */
const subtitleItemsFromTrack = computed<SubtitleItem[]>(() => {
  const items: SubtitleItem[] = [];
  for (const track of tracks.value) {
    if (track.type !== "subtitle") continue;
    for (const clip of track.clips) {
      if (clip.type !== "subtitle" || clip.visible === false || !clip.text?.trim()) continue;
      items.push({
        id: clip.id,
        start: formatSubtitleClock(clip.startTime),
        end: formatSubtitleClock(clip.endTime),
        text: clip.text,
      });
    }
  }
  return items;
});

const visiblePreviewSubtitles = computed(() => {
  const t = globalTime.value;
  return subtitleItemsFromTrack.value.filter((sub) => sub.text.trim() && isSubtitleActive(sub, t));
});

const adjustPreviewSubtitles = computed<SubtitleItem[]>(() => {
  if (visiblePreviewSubtitles.value.length) return visiblePreviewSubtitles.value;
  // 调整模式：即使全部隐藏，也用首条有文案的字幕做框预览
  for (const track of tracks.value) {
    if (track.type !== "subtitle") continue;
    for (const clip of track.clips) {
      if (clip.type === "subtitle" && clip.text?.trim()) {
        return [
          {
            id: clip.id,
            start: formatSubtitleClock(clip.startTime),
            end: formatSubtitleClock(clip.endTime),
            text: clip.text,
          },
        ];
      }
    }
  }
  return [{ id: "placeholder", start: "00:00.000", end: "00:00.000", text: "字幕预览" }];
});

const uploadAudioModalOpen = ref(false);
const uploadClipModalOpen = ref(false);

const fontPopoverOpen = ref<"family" | "style" | null>(null);
const popoverLayoutTick = ref(0);

const fontOptions = [
  { v: "Noto Sans CJK SC", t: "思源黑体" },
  { v: "SimHei", t: "黑体" },
  { v: "SimSun", t: "宋体" },
  { v: "Arial", t: "Arial" },
];

const styleOptions = [
  { v: "normal", t: "常规", bold: false, italic: false },
  { v: "bold", t: "加粗", bold: true, italic: false },
  { v: "italic", t: "斜体", bold: false, italic: true },
  { v: "bold-italic", t: "加粗斜体", bold: true, italic: true },
];

const fontLabel = computed(() => fontOptions.find((o) => o.v === subtitleStyle.fontFamily)?.t || "微软雅黑");
const fontStyleKey = computed(
  () => styleOptions.find((o) => o.bold === subtitleStyle.bold && o.italic === subtitleStyle.italic)?.v || "normal",
);
const styleLabel = computed(() => styleOptions.find((o) => o.v === fontStyleKey.value)?.t || "常规");

function popoverAnchorStyle(btn: HTMLButtonElement | null): CSSProperties {
  if (!btn) return { display: "none" };
  const rect = btn.getBoundingClientRect();
  return { top: `${rect.bottom + 4}px`, left: `${rect.left}px`, width: `${rect.width}px` };
}

const fontFamilyDropdownStyle = computed(() => {
  popoverLayoutTick.value;
  return popoverAnchorStyle(sidebarRef.value?.fontFamilyBtnRef ?? null);
});

const fontStyleDropdownStyle = computed(() => {
  popoverLayoutTick.value;
  return popoverAnchorStyle(sidebarRef.value?.fontStyleBtnRef ?? null);
});

function onFontPopoverToggle(type: "family" | "style"): void {
  fontPopoverOpen.value = fontPopoverOpen.value === type ? null : type;
  if (fontPopoverOpen.value)
    void nextTick(() => {
      popoverLayoutTick.value += 1;
    });
}

function onFontOptionSelect(fontFamily: string): void {
  onSubtitleStyleChange({ ...subtitleStyle, fontFamily });
}

function onStyleOptionSelect(key: string): void {
  const opt = styleOptions.find((o) => o.v === key);
  if (!opt) return;
  onSubtitleStyleChange({ ...subtitleStyle, bold: opt.bold, italic: opt.italic });
}

/** 侧栏上传音频 → 音频轨追加 clip */
function onAudioUploaded(bgm: BgmItem): void {
  timelineRef.value?.addAudioClip({ ...bgm });
}

function onClipUploaded(clips: UploadedComposeClip[]): void {
  if (!clips.length) return;
  for (const c of clips) {
    if (!c.url?.trim()) continue;
    uploadedCatalogVariants.value.push({
      id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      segmentIndex: UPLOAD_CATALOG_SEGMENT_INDEX,
      segmentTitle: "上传片段",
      url: c.url.trim(),
      label: c.name?.trim() || "上传片段",
      mediaId: c.mediaId,
    });
  }
  persistUploadCatalogNow();
  ElMessage.success(clips.length > 1 ? `已添加 ${clips.length} 个视频到片段列表` : "已添加到视频片段列表");
}

function onAddSubtitle(): void {
  timelineRef.value?.addSubtitleClip({ text: "新建字幕", durationSec: 2 });
}

/** 重新识别：清空字幕轨后按主轨顺序写入全局时间 */
async function onRegenerateSubtitles(): Promise<void> {
  await transcribeMainTrackToSubtitles(true);
}

/** 本地不请求转录 */
async function transcribeMainTrackToSubtitles(_showSuccess: boolean): Promise<void> {
  ElMessage.info("暂无");
}

function buildModelValue(): VideoComposeEditorModel {
  const exported = timelineRef.value?.exportTracks?.() || tracks.value;
  return {
    id: props.modelValue.id,
    bizType: props.modelValue.bizType,
    bizId: props.modelValue.bizId,
    tracks: JSON.parse(JSON.stringify(exported)),
    uploadedClipCatalog: JSON.parse(JSON.stringify(uploadedCatalogVariants.value)),
    composeExtractAudioUrls: [...composeExtractAudioUrls.value],
    scale: normalizeComposeTimelineScale(timelineRef.value?.getScale?.() ?? props.modelValue.scale),
  };
}

/** 立即将上传 catalog 写入 model（不依赖 tracks 防抖） */
function persistUploadCatalogNow(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  emit("update:modelValue", buildModelValue());
}

let persistTimer: number | null = null;
const TRACKS_PERSIST_DEBOUNCE_MS = 400;

/** 轨道/片段 id 与类型签名：用于区分结构性变更（增删轨/clip）与属性微调 */
function tracksStructureSig(list: ComposeTrack[]): string {
  return list.map((t) => `${t.id}:${t.type}:${t.clips.map((c) => `${c.id}:${c.type}`).join(",")}`).join("|");
}

let lastPersistedStructureSig = tracksStructureSig(tracks.value);

function scheduleTracksPersist(immediate = false): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (immediate) {
    lastPersistedStructureSig = tracksStructureSig(tracks.value);
    emit("update:modelValue", buildModelValue());
    return;
  }
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    lastPersistedStructureSig = tracksStructureSig(tracks.value);
    emit("update:modelValue", buildModelValue());
  }, TRACKS_PERSIST_DEBOUNCE_MS);
}

function flush(): void {
  scheduleTracksPersist(true);
  const exported = timelineRef.value?.exportTracks?.() || tracks.value;
  scheduleOrphanComposeExtractCleanup(exported);
}

watch(
  tracks,
  () => {
    const structureChanged = tracksStructureSig(tracks.value) !== lastPersistedStructureSig;
    scheduleTracksPersist(structureChanged);
  },
  { deep: true },
);

/** 外部 composeProject 回填时恢复上传 catalog（如 Step4 重新挂载） */
watch(
  () => [props.modelValue.uploadedClipCatalog, props.modelValue.tracks, props.modelValue.composeExtractAudioUrls] as const,
  () => {
    restoreUploadedCatalogFromModel();
    syncRegistryFromTracks(props.modelValue.tracks || []);
  },
  { deep: true },
);

/** 预览自动换算字号后写回（measure 可能改 fontSize） */
watch(
  () => subtitleStyle.fontSize,
  (fontSize) => {
    if (syncingFromTracks || isAdjusting.value || fontSize <= 0) return;
    patchClips("subtitle", { fontSize }, activeSubtitleId.value);
  },
);

/** 防止重复触发；首次 clips 就绪后尝试一次自动转录 */
let didAttemptAutoTranscribe = false;
let didBootstrap = false;
/** 占位时长二次探测间隔（ms） */
const DURATION_PROBE_RETRY_MS = 1000;
/** 作废进行中的时长回填 / 延迟探测 */
let durationProbeSeq = 0;
let durationProbeRetryTimer: number | null = null;

function clearDurationProbeRetry(): void {
  if (durationProbeRetryTimer != null) {
    window.clearTimeout(durationProbeRetryTimer);
    durationProbeRetryTimer = null;
  }
}

/** 主轨是否仍有未探测真实时长的 clip */
function mainClipsStillProbeable(): boolean {
  return (timelineRef.value?.getMainVideoClips?.() || []).some((c) => isComposeClipDurationProbeable(c.durationSec) && Boolean(c.url));
}

/**
 * 探测仍占位的主轨 clip；探到一条立刻 rebuild（改时长并重抽帧），不等整批结束。
 */
async function applyProbedMainClipDurations(): Promise<void> {
  const targets = (timelineRef.value?.getMainVideoClips?.() || []).filter(
    (c) => isComposeClipDurationProbeable(c.durationSec) && Boolean(c.url),
  );
  if (!targets.length) return;

  await probeClipDurationsWithRetry(targets, (clip) => {
    rebuildMainClipThumbnail(clip.id, clip.durationSec);
    syncDerivedClipsFromTimeline();
  });
}

/**
 * 把 resolveComposeClips 已探到的时长写回仍占位的主轨 clip，避免 import 后再探一轮和抽帧抢 video。
 */
function applyResolvedDurationsToMain(resolved: VideoClipItem[]): void {
  const byId = new Map(resolved.map((clip) => [clip.id, clip]));
  const mains = timelineRef.value?.getMainVideoClips?.() || [];
  for (const clip of mains) {
    if (!isComposeClipDurationProbeable(clip.durationSec)) continue;
    const hit = byId.get(clip.id);
    if (!hit || isComposeClipDurationProbeable(hit.durationSec)) continue;
    rebuildMainClipThumbnail(clip.id, hit.durationSec);
  }
}

/** 单个主轨 clip 时长就绪后重建，触发 vue-clip-track 重新抽帧 */
function rebuildMainClipThumbnail(clipId: string, durationSec: number): void {
  if (durationSec <= COMPOSE_CLIP_PLACEHOLDER_DURATION_SEC) return;
  timelineRef.value?.rebuildMainClipAt(clipId, durationSec);
}

async function loadClips(): Promise<void> {
  playerRef.value?.pause();
  await nextTick();
  await waitForTimeline();

  clearDurationProbeRetry();
  durationProbeSeq += 1;
  const seq = durationProbeSeq;

  let clips: VideoClipItem[];

  // mock：忽略 props.clips / 持久化轨，先探真实时长再 bootstrap，避免 0.1 秒细线
  if (isVideoComposeMockEnabled()) {
    clips = buildMockVideoClips();
    await probeClipDurationsWithRetry(clips);
    timelineRef.value?.bootstrapMainFromClips(clips);
  } else {
    clips = await resolveComposeClips(props.clips);
    const hasPersisted = Boolean(props.modelValue.tracks?.some((t) => t.clips.length > 0));
    if (hasPersisted && !didBootstrap) {
      timelineRef.value?.importTracks(props.modelValue.tracks);
      tracks.value = JSON.parse(JSON.stringify(props.modelValue.tracks));
      applyResolvedDurationsToMain(clips);
    } else if (!hasPersisted) {
      timelineRef.value?.bootstrapMainFromClips(clips);
    }
  }

  didBootstrap = true;
  syncRegistryFromTracks(tracks.value);
  syncDerivedClipsFromTimeline();
  syncSidebarFromTracks();
  emit("ready");

  await applyProbedMainClipDurations();
  if (seq !== durationProbeSeq) return;

  const hasClips = clips.length > 0;
  if (!didAttemptAutoTranscribe && hasClips && !mainClipsStillProbeable()) {
    didAttemptAutoTranscribe = true;
    await maybeAutoTranscribe();
  }
  if (seq !== durationProbeSeq) return;
  if (!mainClipsStillProbeable()) return;

  durationProbeRetryTimer = window.setTimeout(() => {
    durationProbeRetryTimer = null;
    if (seq !== durationProbeSeq) return;
    void applyProbedMainClipDurations().then(() => {
      if (seq !== durationProbeSeq) return;
      if (!didAttemptAutoTranscribe && hasClips && !mainClipsStillProbeable()) {
        didAttemptAutoTranscribe = true;
        void maybeAutoTranscribe();
      }
    });
  }, DURATION_PROBE_RETRY_MS);
}

/** 等到时间轴挂载清空结束再上轴，避免 reset 抹掉刚写入的主轨 */
function waitForTimeline(): Promise<void> {
  return new Promise((resolve) => {
    let tries = 0;
    const tick = () => {
      const ready = timelineRef.value?.whenReady?.();
      if (ready) {
        void ready.then(() => resolve());
        return;
      }
      if (tries > 40) {
        resolve();
        return;
      }
      tries += 1;
      window.setTimeout(tick, 50);
    };
    tick();
  });
}

watch(
  () => buildComposeClipInputsSignature(props.clips),
  (sig) => {
    if (isVideoComposeMockEnabled()) {
      void loadClips();
      return;
    }
    if (!sig) {
      derivedMainClips.value = [];
      return;
    }
    didBootstrap = false;
    void loadClips();
  },
  { immediate: true },
);

watch(
  () => props.modelValue,
  (val) => {
    void val;
  },
  { deep: true },
);

function validate(): string | null {
  const clips = timelineRef.value?.getMainVideoClips?.() || derivedMainClips.value;
  if (!clips.length) return "尚未生成视频内容，请先完成片段生成";
  if (clips.some((c) => !c.url)) return "存在未就绪的视频片段，请返回上一步检查";
  if (isTranscribing.value) return "正在识别字幕，请稍候";
  if (hasTimelineSubtitles(tracks.value) && clips.length > 1 && clips.some((c) => !c.durationSec)) {
    return "视频时长加载中，请稍候再试";
  }
  return null;
}

async function maybeAutoTranscribe(): Promise<void> {
  if (!props.autoTranscribe || hasTimelineSubtitles(props.modelValue.tracks)) return;
  const clips = timelineRef.value?.getMainVideoClips?.() || derivedMainClips.value;
  // 时长未就绪时跳过自动转录，用户稍后可点「重新识别」
  if (clips.some((c) => isComposeClipDurationProbeable(c.durationSec))) return;
  await transcribeMainTrackToSubtitles(false);
}

onBeforeUnmount(() => {
  clearDurationProbeRetry();
});

defineExpose({
  validate,
  flush,
  getResolvedClips: () => timelineRef.value?.getMainVideoClips?.() || derivedMainClips.value,
  validateBeforeCompose: validate,
  syncBeforeCompose: flush,
  getComposeClips: () => timelineRef.value?.getMainVideoClips?.() || derivedMainClips.value,
  /** 打开上传视频片段弹窗（供顶栏按钮调用） */
  openUploadClipModal: () => {
    if (props.readonly) return;
    uploadClipModalOpen.value = true;
  },
});

onMounted(() => {
  void loadTextTemplateCatalog();
  nextTick(() => {
    timelineRef.value?.recoverStaleExtractStatuses?.();
    console.log("props.modelValue", props.modelValue);
  });
});

onBeforeUnmount(() => {
  flush();
});
</script>
