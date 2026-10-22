import { computed, nextTick, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import type {
  BgmItem,
  ComposeConfig,
  ComposeSegmentClipGroup,
  ComposeSegmentClipVariant,
  ComposeSubtitleAsset,
  ComposeTextTemplateDrag,
  VideoClipItem,
} from "@/types/videoCompose";
import {
  COMPOSE_UPLOAD_CATALOG_SEGMENT_INDEX,
  collectStep3InputClipIds,
  inferUploadedVariantsFromTracks,
  mergeUploadedCatalogVariants,
  resolveCatalogVariantPlayUrl,
} from "@/hooks/useComposeUploadCatalog";
import { COMPOSE_CLIP_PLACEHOLDER_DURATION_SEC, probeClipDurationsWithRetry, probeVideoDuration } from "@/hooks/useResolveComposeClips";
import { findTextTemplateById } from "../shared/textTemplateCatalog";
import type { UploadedComposeClip } from "../modals/VideoClipUploadModal.vue";
import type { ComposeEditorProps, ComposeEditorState } from "./createComposeEditorState";
import type { ComposeEditorPorts } from "./ports";

/** 素材库预览、上传和拖入时间轴。退出预览后的 nextTick 仍由这里发出，播放桥只负责接着播 */
export function useComposeCatalog(props: ComposeEditorProps, state: ComposeEditorState, ports: ComposeEditorPorts) {
  const uploadSegmentIndex = COMPOSE_UPLOAD_CATALOG_SEGMENT_INDEX;

  /** 从 model / 主轨恢复侧栏「上传片段」列表 */
  function restoreUploadedCatalogFromModel(): void {
    state.uploadedCatalogVariants.value = mergeUploadedCatalogVariants(
      props.modelValue.uploadedClipCatalog,
      inferUploadedVariantsFromTracks(props.modelValue.tracks, collectStep3InputClipIds(props.clips)),
    );
  }

  restoreUploadedCatalogFromModel();

  /** Step3 历史 + 本地上传合并后的侧栏素材库 */
  const mergedSegmentCatalog = computed<ComposeSegmentClipGroup[]>(() => {
    const base = props.segmentCatalog ?? [];
    if (!state.uploadedCatalogVariants.value.length) return base;
    const uploadGroup: ComposeSegmentClipGroup = {
      segmentIndex: uploadSegmentIndex,
      segmentTitle: "上传片段",
      variants: state.uploadedCatalogVariants.value,
    };
    return [uploadGroup, ...base];
  });

  /** 是否处于素材库预览（用于静音 BGM 轨） */
  const catalogPreviewActive = computed(() => !!state.previewCatalogVariant.value);

  /** 主播放器 override：素材库预览单 clip */
  const previewOverrideClips = computed<VideoClipItem[] | null>(() => {
    const variant = state.previewCatalogVariant.value;
    if (!variant?.url) return null;
    return [
      {
        id: `catalog-preview-${variant.id}`,
        title: variant.segmentTitle,
        url: variant.url,
        taskId: variant.taskId,
        durationSec: state.previewClipDuration.value || 0.1,
        src: variant.poster,
      },
    ];
  });

  /** 素材库预览顶栏文案 */
  const previewCatalogLabel = computed(() => {
    const variant = state.previewCatalogVariant.value;
    if (!variant) return "";
    return variant.label ? `${variant.segmentTitle} · ${variant.label}` : variant.segmentTitle;
  });

  /** 时间轴已有视频 URL，供侧栏「已添加」标记 */
  const timelineClipUrls = computed(() => {
    const urls = new Set<string>();
    for (const clip of state.derivedMainClips.value) {
      if (clip.url?.trim()) urls.add(clip.url.trim());
    }
    return urls;
  });

  /** 素材库预览：仅播 video 内嵌原声，禁用时间轴分离原声 / BGM 的 fallback */
  const catalogPreviewComposeConfig = computed<ComposeConfig>(() => ({
    ...state.derivedComposeConfig.value,
    bgm: null,
    bgmStartTime: 0,
    bgmSourceStartTime: 0,
  }));

  /** 拉取侧栏素材库预览片段时长 */
  function probeCatalogPreviewDuration(url: string): void {
    if (!url) return;
    const video = document.createElement("video");
    video.preload = "metadata";
    video.src = url;
    video.onloadedmetadata = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        state.previewClipDuration.value = video.duration;
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
    state.clock.playSeq += 1;
    state.clock.playInFlight = false;
    state.clock.playerDrivingTimeline = false;
    state.playerRef.value?.pause();
    ports.syncTimelinePlaybackUi(false);
    state.previewClipDuration.value = 0;
    state.previewCatalogVariant.value = variant;
    probeCatalogPreviewDuration(variant.url);
    void nextTick(() => {
      void state.playerRef.value?.seek?.(0);
      void state.playerRef.value?.play?.();
    });
  }

  /** 清除素材库预览态（不 resync；由后续时间轴 seek/play 接管） */
  function exitCatalogPreviewIfNeeded(): boolean {
    if (!state.previewCatalogVariant.value) return false;
    state.previewCatalogVariant.value = null;
    state.previewClipDuration.value = 0;
    state.clock.playerDrivingTimeline = false;
    state.clock.playInFlight = false;
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
    const timeSec = state.timelineRef.value?.getCurrentTime?.() ?? state.globalTime.value;
    void nextTick(() => {
      void state.playerRef.value?.resync?.(timeSec);
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
    /** 每次上轴独立 id，避免删除后复用 variant.id 导致缩略图缓存不刷新 */
    const catalogClipKey = variant.segmentIndex === uploadSegmentIndex ? variant.id : `hist-${variant.segmentIndex}-${variant.id}`;
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
      state.timelineRef.value?.insertClipToMainAt(clipItem, options.startTime ?? 0);
    } else {
      state.timelineRef.value?.addClipToMain(clipItem);
    }
    ports.syncDerivedClipsFromTimeline();

    /** 添加后重建 clip，触发时间轴重新生成缩略图条 */
    const refreshClipThumbnails = (probedDuration: number) => {
      ports.rebuildMainClipThumbnail(clipId, probedDuration);
      ports.syncDerivedClipsFromTimeline();
    };

    if (variant.segmentIndex === uploadSegmentIndex && playUrl !== variant.url.trim()) {
      const idx = state.uploadedCatalogVariants.value.findIndex((item) => item.id === variant.id);
      if (idx >= 0) {
        state.uploadedCatalogVariants.value[idx] = { ...state.uploadedCatalogVariants.value[idx], url: playUrl };
        ports.persistUploadCatalogNow();
      }
    }

    if (durationSec <= COMPOSE_CLIP_PLACEHOLDER_DURATION_SEC) {
      const target = state.derivedMainClips.value.find((clip) => clip.id === clipId);
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

  /** 从上传片段列表移除（已在时间轴则确认后一并移除） */
  async function onRemoveCatalogVariant(variant: ComposeSegmentClipVariant): Promise<void> {
    if (props.readonly) return;
    if (variant.segmentIndex !== uploadSegmentIndex) return;

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
      state.timelineRef.value?.removeMainClipsByUrl(url);
      ports.syncDerivedClipsFromTimeline();
    }

    if (state.previewCatalogVariant.value?.id === variant.id) {
      clearCatalogPreview();
    }

    state.uploadedCatalogVariants.value = state.uploadedCatalogVariants.value.filter((item) => item.id !== variant.id);
    ports.persistUploadCatalogNow();
    ElMessage.success("已从片段列表移除");
  }

  /** 拖拽：在松手位置插入主轨 */
  async function onTimelineDropCatalogClip(payload: { variant: ComposeSegmentClipVariant; startTime: number }): Promise<void> {
    await addCatalogVariantToTimeline(payload.variant, { startTime: payload.startTime });
  }

  /** 音频或音效拖入音频轨 */
  function onTimelineDropAudioAsset(payload: { item: BgmItem; startTime: number }): void {
    if (props.readonly) return;
    state.timelineRef.value?.addAudioClip({ ...payload.item }, payload.startTime);
    ElMessage.success("已添加到时间轴");
  }

  /** 字幕素材拖入字幕轨 */
  function onTimelineDropSubtitleAsset(payload: { item: ComposeSubtitleAsset; startTime: number }): void {
    if (props.readonly) return;
    state.timelineRef.value?.addSubtitleClip({
      text: payload.item.text,
      durationSec: payload.item.durationSec,
      startTime: payload.startTime,
    });
    ElMessage.success("已添加到时间轴");
  }

  /** 花字拖入贴图轨。按 id 找回完整模板，尺寸仍走预览画面 */
  function onTimelineDropTextTemplate(payload: { item: ComposeTextTemplateDrag; startTime: number }): void {
    const item = findTextTemplateById(payload.item.id);
    if (!item) {
      ElMessage.warning("找不到该花字模板");
      return;
    }
    ports.onAddTextTemplate(item, payload.startTime);
  }

  /** 侧栏上传音频 → 音频轨追加 clip */
  function onAudioUploaded(bgm: BgmItem): void {
    state.timelineRef.value?.addAudioClip({ ...bgm });
  }

  function onClipUploaded(clips: UploadedComposeClip[]): void {
    if (!clips.length) return;
    for (const clip of clips) {
      if (!clip.url?.trim()) continue;
      state.uploadedCatalogVariants.value.push({
        id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        segmentIndex: uploadSegmentIndex,
        segmentTitle: "上传片段",
        url: clip.url.trim(),
        label: clip.name?.trim() || "上传片段",
        mediaId: clip.mediaId,
      });
    }
    ports.persistUploadCatalogNow();
    ElMessage.success(clips.length > 1 ? `已添加 ${clips.length} 个视频到片段列表` : "已添加到视频片段列表");
  }

  function onAddSubtitle(): void {
    state.timelineRef.value?.addSubtitleClip({ text: "新建字幕", durationSec: 2 });
  }

  watch(
    () => [props.modelValue.uploadedClipCatalog, props.modelValue.tracks, props.modelValue.composeExtractAudioUrls] as const,
    () => {
      restoreUploadedCatalogFromModel();
      state.syncRegistryFromTracks(props.modelValue.tracks || []);
    },
    { deep: true },
  );

  ports.afterExitCatalogPreview = afterExitCatalogPreview;

  return {
    mergedSegmentCatalog,
    catalogPreviewActive,
    previewOverrideClips,
    previewCatalogLabel,
    timelineClipUrls,
    catalogPreviewComposeConfig,
    onCatalogPreview,
    clearCatalogPreview,
    onRemoveCatalogVariant,
    onTimelineDropCatalogClip,
    onTimelineDropAudioAsset,
    onTimelineDropSubtitleAsset,
    onTimelineDropTextTemplate,
    onAudioUploaded,
    onClipUploaded,
    onAddSubtitle,
  };
}
