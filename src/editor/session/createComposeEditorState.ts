import { computed, reactive, ref, type ComputedRef, type Ref } from "vue";
import type { MediaClip, TextClip } from "@/clip-track";
import type {
  BeautyParams,
  BgmItem,
  ComposeConfig,
  ComposeSegmentClipVariant,
  ComposeSubtitleAsset,
  ComposeSubtitleClip,
  ComposeTextOverlayClip,
  ComposeTrack,
  PreviewAudioClip,
  SubtitleItem,
  SubtitleStyleConfig,
  VideoClipItem,
  VideoComposeClipInput,
  VideoComposeEditorModel,
  ComposeSegmentClipGroup,
} from "@/types/videoCompose";
import {
  countAudioClips,
  createDefaultBeautyParams,
  getDefaultSubtitleStyleSnapshot,
  mapTracksToComposeConfig,
  mapTracksToTextOverlayClips,
  readClipConfig,
  readTextClipConfig,
} from "@/types/videoCompose";
import { formatSubtitleClock, parseSubtitleClock } from "@/hooks/useVideoComposeTimelineScale";
import type VideoComposePlayer from "../player/VideoComposePlayer.vue";
import type VideoComposeSidebar from "../sidebar/VideoComposeSidebar.vue";
import type VideoComposeTimeline from "../timeline/VideoComposeTimeline.vue";
import type { SelectedTextClipProps, ComposeInspectorKind } from "../sidebar/VideoComposeSidebar.vue";
import { findTextTemplateById, isCssHexColor } from "../shared/textTemplateCatalog";
import { gainToDb } from "../shared/volumeDb";
import { findClipById, findSelectedIdOfType, firstClipOfType, getLinkedOriginalAudioIdForVideo, tracksStructureSig } from "./trackLookup";

/** 编辑器入参。可选字段由 withDefaults 在运行时补齐 */
export interface ComposeEditorProps {
  /** 视频片段入参 */
  clips: VideoComposeClipInput[];
  /** 编辑器聚合状态 */
  modelValue: VideoComposeEditorModel;
  /** 无已有字幕时挂载后自动转录 */
  autoTranscribe?: boolean;
  /** 只读模式 */
  readonly?: boolean;
  /** 各片段历史版本素材库 */
  segmentCatalog?: ComposeSegmentClipGroup[];
}

/** 外壳向外抛出的事件 */
export interface ComposeEditorEmit {
  (event: "update:modelValue", value: VideoComposeEditorModel): void;
  (event: "ready"): void;
}

/** 预览和时间轴对钟用的可变标志。必须留在同一次会话里，不能做成模块级变量 */
export interface ComposeClock {
  /** 播放中由 Player 驱动时间线游标；暂停时允许时间线 scrub 驱动 Player */
  playerDrivingTimeline: boolean;
  /** 递增以作废进行中的异步 play（连点暂停/播放） */
  playSeq: number;
  /** seek+play 尚未完成，避免 timeupdate 把刚点的播放立刻暂停 */
  playInFlight: boolean;
  /** 避免 timeline seek ↔ player seek 回环 */
  suppressTimelineSeekToPlayer: boolean;
  /** 程序化同步时间轴播放 UI，避免反向触发 playback-play */
  suppressTimelinePlaybackEmit: boolean;
  /** 时间轴工具栏是否处于「播放中」展示态（与 Player 对齐） */
  timelineUiPlaying: boolean;
  /** 从 tracks 同步到侧栏时置位，避免回写循环 */
  syncingFromTracks: boolean;
}

/** 一次编辑器实例的共享状态。区域组件仍通过外壳 props 读写，不各自持有一份轨道 */
export interface ComposeEditorState {
  playerRef: Ref<InstanceType<typeof VideoComposePlayer> | null>;
  sidebarRef: Ref<InstanceType<typeof VideoComposeSidebar> | null>;
  timelineRef: Ref<InstanceType<typeof VideoComposeTimeline> | null>;
  /** 播放对钟标志 */
  clock: ComposeClock;
  /** 派生主轨片段（喂播放器，含 volume/rate/trim） */
  derivedMainClips: Ref<VideoClipItem[]>;
  /** 派生音频片段（按全局时间命中混音） */
  derivedAudioClips: Ref<PreviewAudioClip[]>;
  /** 播放器当前片段索引 */
  playingIdx: Ref<number>;
  globalTime: Ref<number>;
  isAdjusting: Ref<boolean>;
  videoReady: Ref<boolean>;
  /** 播放条总时长，跟时间轴 getDuration */
  previewDurationSec: Ref<number>;
  isTranscribing: Ref<boolean>;
  /** 多轨副本。日常编辑以时间轴内部 store 为准，这里只接 emit，不回灌 */
  tracks: Ref<ComposeTrack[]>;
  /** 上次已写入 model 的轨道结构签名 */
  lastPersistedStructureSig: string;
  audioAssets: Ref<BgmItem[]>;
  sfxAssets: Ref<BgmItem[]>;
  subtitleAssets: Ref<ComposeSubtitleAsset[]>;
  /** 时间轴当前选中 clip id 列表 */
  selectedClipIds: Ref<string[]>;
  /** 右栏当前编辑对象；未选中轨道或片段时为空 */
  inspectorKind: Ref<ComposeInspectorKind | null>;
  subtitleStyle: SubtitleStyleConfig;
  subtitleVisible: Ref<boolean>;
  /** 侧栏视频音量（dB）；null 为静音 */
  videoVolume: Ref<number | null>;
  /** 侧栏美颜 */
  beauty: Ref<BeautyParams>;
  /** 侧栏音轨音量（dB）；null 为静音 */
  bgmVolume: Ref<number | null>;
  uploadedCatalogVariants: Ref<ComposeSegmentClipVariant[]>;
  /** 侧栏素材库当前预览中的历史版本 */
  previewCatalogVariant: Ref<ComposeSegmentClipVariant | null>;
  previewClipDuration: Ref<number>;
  uploadAudioModalOpen: Ref<boolean>;
  uploadClipModalOpen: Ref<boolean>;
  composeExtractAudioUrls: Ref<string[]>;
  registerComposeExtractAudioUrl: (url: string | undefined | null) => void;
  syncRegistryFromTracks: (tracks: ComposeTrack[]) => void;
  scheduleOrphanComposeExtractCleanup: (tracks: ComposeTrack[]) => void;
  detachAudioForVideoClip: (videoClipId: string) => Promise<string | null>;
  detachingClipIds: Ref<Set<string>>;
  audioClipCount: ComputedRef<number>;
  activeAudioId: ComputedRef<string | undefined>;
  activeVideoId: ComputedRef<string | undefined>;
  activeSubtitleId: ComputedRef<string | undefined>;
  activeTextClipId: ComputedRef<string | undefined>;
  /** 播放器仍吃旧 ComposeConfig（由 tracks + 当前播片段临时派生） */
  derivedComposeConfig: ComputedRef<ComposeConfig>;
  videoVolumeLabel: ComputedRef<string>;
  audioVolumeLabel: ComputedRef<string>;
  selectedTextClipProps: ComputedRef<SelectedTextClipProps | null>;
  selectedSubtitleText: ComputedRef<string>;
  /** 播放器贴图 overlay 数据 */
  textOverlayClips: ComputedRef<ComposeTextOverlayClip[]>;
  /** 画面变换只展示当前预览尺寸，不参与写回 */
  frameSize: ComputedRef<{ width: number; height: number }>;
  /** 字幕轨可见 clip → 预览用 SubtitleItem */
  visiblePreviewSubtitles: ComputedRef<SubtitleItem[]>;
  adjustPreviewSubtitles: ComputedRef<SubtitleItem[]>;
}

/** 字幕是否盖住当前时间。沿用原半开区间 */
function isSubtitleActive(sub: SubtitleItem, timeSec: number): boolean {
  const start = parseSubtitleClock(sub.start);
  const end = parseSubtitleClock(sub.end);
  return timeSec >= start && timeSec < end;
}

/** 创建一次编辑会话的状态。调用方必须在 setup 里同步执行 */
export function createComposeEditorState(props: ComposeEditorProps): ComposeEditorState {
  const tracks = ref<ComposeTrack[]>(props.modelValue.tracks?.length ? JSON.parse(JSON.stringify(props.modelValue.tracks)) : []);
  const selectedClipIds = ref<string[]>([]);
  const derivedMainClips = ref<VideoClipItem[]>([]);
  const playingIdx = ref(0);
  const globalTime = ref(0);
  const videoReady = ref(false);
  const playerRef = ref<InstanceType<typeof VideoComposePlayer> | null>(null);
  const subtitleStyle = reactive<SubtitleStyleConfig>(getDefaultSubtitleStyleSnapshot());

  const activeAudioId = computed(() => findSelectedIdOfType(tracks.value, selectedClipIds.value, "audio"));
  const activeVideoId = computed(() => findSelectedIdOfType(tracks.value, selectedClipIds.value, "video"));
  const activeSubtitleId = computed(() => findSelectedIdOfType(tracks.value, selectedClipIds.value, "subtitle"));
  const activeTextClipId = computed(() => findSelectedIdOfType(tracks.value, selectedClipIds.value, "text"));

  const derivedComposeConfig = computed<ComposeConfig>(() => {
    const videoId = derivedMainClips.value[playingIdx.value]?.id || activeVideoId.value;
    const audioId = activeAudioId.value;
    return mapTracksToComposeConfig(tracks.value, {
      videoClipId: videoId,
      audioClipId: audioId,
    });
  });

  const videoVolumeLabel = computed(() => {
    const videoId = activeVideoId.value || firstClipOfType(tracks.value, "video")?.id;
    return getLinkedOriginalAudioIdForVideo(tracks.value, videoId) ? "视频音量" : "原视频音量";
  });

  const audioVolumeLabel = computed(() => {
    const clip = findClipById(tracks.value, activeAudioId.value);
    if (clip?.type !== "audio") return "BGM 音量";
    const role = readClipConfig(clip.config).audioRole;
    if (role === "original") return "原声音量";
    if (role === "bgm") return "BGM 音量";
    return "音轨音量";
  });

  const selectedTextClipProps = computed<SelectedTextClipProps | null>(() => {
    const clip = findClipById(tracks.value, activeTextClipId.value);
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

  const selectedSubtitleText = computed(() => {
    const clip = findClipById(tracks.value, activeSubtitleId.value);
    if (!clip || clip.type !== "subtitle") return "";
    return (clip as ComposeSubtitleClip).text || "";
  });

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
    const timeSec = globalTime.value;
    return subtitleItemsFromTrack.value.filter((sub) => sub.text.trim() && isSubtitleActive(sub, timeSec));
  });

  const adjustPreviewSubtitles = computed<SubtitleItem[]>(() => {
    if (visiblePreviewSubtitles.value.length) return visiblePreviewSubtitles.value;
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

  const frameSize = computed(() => {
    void videoReady.value;
    const size = playerRef.value?.getVideoSize?.() ?? null;
    return {
      width: size?.width ?? 0,
      height: size?.height ?? 0,
    };
  });

  return {
    playerRef,
    sidebarRef: ref(null),
    timelineRef: ref(null),
    clock: {
      playerDrivingTimeline: false,
      playSeq: 0,
      playInFlight: false,
      suppressTimelineSeekToPlayer: false,
      suppressTimelinePlaybackEmit: false,
      timelineUiPlaying: false,
      syncingFromTracks: false,
    },
    derivedMainClips,
    derivedAudioClips: ref<PreviewAudioClip[]>([]),
    playingIdx,
    globalTime,
    isAdjusting: ref(false),
    videoReady,
    previewDurationSec: ref(0),
    isTranscribing: ref(false),
    tracks,
    lastPersistedStructureSig: tracksStructureSig(tracks.value),
    audioAssets: ref<BgmItem[]>([]),
    sfxAssets: ref<BgmItem[]>([]),
    subtitleAssets: ref<ComposeSubtitleAsset[]>([]),
    selectedClipIds,
    inspectorKind: ref<ComposeInspectorKind | null>(null),
    subtitleStyle,
    subtitleVisible: ref(true),
    videoVolume: ref<number | null>(gainToDb(0.8)),
    beauty: ref<BeautyParams>(createDefaultBeautyParams()),
    bgmVolume: ref<number | null>(gainToDb(0.5)),
    uploadedCatalogVariants: ref<ComposeSegmentClipVariant[]>([]),
    previewCatalogVariant: ref<ComposeSegmentClipVariant | null>(null),
    previewClipDuration: ref(0),
    uploadAudioModalOpen: ref(false),
    uploadClipModalOpen: ref(false),
    composeExtractAudioUrls: ref<string[]>([]),
    registerComposeExtractAudioUrl: () => undefined,
    syncRegistryFromTracks: () => undefined,
    scheduleOrphanComposeExtractCleanup: () => undefined,
    detachAudioForVideoClip: () => Promise.resolve(null),
    detachingClipIds: ref<Set<string>>(new Set()),
    audioClipCount: computed(() => countAudioClips(tracks.value)),
    activeAudioId,
    activeVideoId,
    activeSubtitleId,
    activeTextClipId,
    derivedComposeConfig,
    videoVolumeLabel,
    audioVolumeLabel,
    selectedTextClipProps,
    selectedSubtitleText,
    textOverlayClips: computed(() => mapTracksToTextOverlayClips(tracks.value)),
    frameSize,
    visiblePreviewSubtitles,
    adjustPreviewSubtitles,
  };
}
