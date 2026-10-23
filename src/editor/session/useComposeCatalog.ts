import { computed, nextTick, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  composeMediaLikeKey,
  type BgmItem,
  type ComposeConfig,
  type ComposeSegmentClipAssets,
  type ComposeSubtitleAsset,
  type ComposeTextTemplateDrag,
  type MediaRef,
  type VideoClipItem,
} from "@/types/videoCompose";
import {
  inferUploadedVariantsFromTracks,
  mergeUploadedCatalogVariants,
  resolveCatalogVariantPlayUrl,
} from "@/hooks/useComposeUploadCatalog";
import {
  COMPOSE_CLIP_PLACEHOLDER_DURATION_SEC,
  isComposeClipDurationProbeable,
  probeAudioDuration,
  probeClipDurationsWithRetry,
  probeVideoDuration,
} from "@/hooks/useResolveComposeClips";
import { appendUploadedTextTemplate, findTextTemplateById, setHostTextTemplates, textTemplateCatalog } from "../shared/textTemplateCatalog";
import type { UploadedComposeClip } from "../modals/VideoClipUploadModal.vue";
import type { ComposeEditorEmit, ComposeEditorProps, ComposeEditorState } from "./createComposeEditorState";
import type { ComposeEditorPorts } from "./ports";

/** 素材库预览、上传和拖入时间轴。退出预览后的 nextTick 仍由这里发出，播放桥只负责接着播 */
export function useComposeCatalog(
  props: ComposeEditorProps,
  state: ComposeEditorState,
  ports: ComposeEditorPorts,
  emit: ComposeEditorEmit,
) {
  /** 宿主未接管时，从 model / 主轨恢复唯一内部视频列表（兼容旧草稿；不再依赖 clips 入参） */
  function restoreInternalVideoVariantsFromModel(): void {
    if (props.videoAssets) return;
    state.uploadedCatalogVariants.value = mergeUploadedCatalogVariants(
      props.modelValue.uploadedClipCatalog,
      inferUploadedVariantsFromTracks(props.modelValue.tracks),
    );
  }

  /** 从工程恢复已喜欢的视频媒体。键没变时不替换数组，避免轨道保存把爱心刷掉 */
  function restoreLikedMediaFromModel(): void {
    const next = (props.modelValue.likedMedia ?? [])
      .filter((item) => item.liked !== false && composeMediaLikeKey(item))
      .map((item) => ({ ...item, liked: true }));
    const prevKeys = state.likedMedia.value.map((item) => composeMediaLikeKey(item)).join("|");
    const nextKeys = next.map((item) => composeMediaLikeKey(item)).join("|");
    if (prevKeys === nextKeys) return;
    state.likedMedia.value = next;
  }

  restoreInternalVideoVariantsFromModel();
  restoreLikedMediaFromModel();
  setHostTextTemplates(props.textTemplates);

  /** 侧栏视频：宿主 props 优先，否则唯一内部列表 */
  const videoCatalogVariants = computed<ComposeSegmentClipAssets[]>(() => props.videoAssets ?? state.uploadedCatalogVariants.value);

  /** 侧栏音频 / 音效 / 花字：宿主 props 优先 */
  const panelAudioAssets = computed(() => props.audioAssets ?? state.audioAssets.value);
  const panelSfxAssets = computed(() => props.sfxAssets ?? state.sfxAssets.value);
  const panelTextTemplates = computed(() => props.textTemplates ?? textTemplateCatalog.value);

  /** 已喜欢媒体的匹配键，供侧栏卡片点亮爱心 */
  const likedMediaKeys = computed(() => {
    const keys = new Set<string>();
    for (const item of state.likedMedia.value) {
      const key = composeMediaLikeKey(item);
      if (key) keys.add(key);
    }
    return keys;
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

  /** 侧栏单击：主播放器预览（不改时间轴） */
  function onCatalogPreview(variant: ComposeSegmentClipAssets): void {
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
    variant: ComposeSegmentClipAssets,
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
    const clipId = `${variant.id}-tl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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

    if (!props.videoAssets && playUrl !== variant.url.trim()) {
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

  /** 从侧栏视频列表移除（已在时间轴则确认后一并移除） */
  async function onRemoveCatalogVariant(variant: ComposeSegmentClipAssets): Promise<void> {
    if (props.readonly) return;

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

    emit("remove-catalog-clip", variant);

    if (!props.videoAssets) {
      state.uploadedCatalogVariants.value = state.uploadedCatalogVariants.value.filter((item) => item.id !== variant.id);
      ports.persistUploadCatalogNow();
    }

    ElMessage.success("已从片段列表移除");
  }

  /** 拖拽：在松手位置插入主轨 */
  async function onTimelineDropCatalogClip(payload: { variant: ComposeSegmentClipAssets; startTime: number }): Promise<void> {
    await addCatalogVariantToTimeline(payload.variant, { startTime: payload.startTime });
  }

  /**
   * 占位时长的音频 clip：异步探测真实时长后拉宽，并回写侧栏同 URL 条目。
   */
  async function probeAndWidenAudioClip(clipId: string | undefined, item: BgmItem): Promise<void> {
    if (!clipId || !item.url?.trim()) return;
    if (!isComposeClipDurationProbeable(item.durationSec)) return;

    const durationSec = await probeAudioDuration(item.url);
    if (durationSec <= COMPOSE_CLIP_PLACEHOLDER_DURATION_SEC) return;

    state.timelineRef.value?.updateAudioClipDuration?.(clipId, durationSec);
    ports.syncDerivedClipsFromTimeline();

    /** 宿主接管列表时不改 props，只拉宽时间轴 */
    if (props.audioAssets || props.sfxAssets) return;

    const patchList = (list: BgmItem[]): BgmItem[] => list.map((entry) => (entry.url === item.url ? { ...entry, durationSec } : entry));
    state.sfxAssets.value = patchList(state.sfxAssets.value);
    state.audioAssets.value = patchList(state.audioAssets.value);
  }

  /** 音频或音效拖入音频轨；时长未就绪时上轴后再探并拉宽 */
  function onTimelineDropAudioAsset(payload: { item: BgmItem; startTime: number }): void {
    if (props.readonly) return;
    const clipId = state.timelineRef.value?.addAudioClip({ ...payload.item }, payload.startTime);
    ElMessage.success("已添加到时间轴");
    void probeAndWidenAudioClip(clipId, payload.item);
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

  /** 侧栏上传音频 → 音频轨追加 clip；若时长仍占位则异步探测拉宽 */
  function onAudioUploaded(bgm: BgmItem): void {
    const clipId = state.timelineRef.value?.addAudioClip({ ...bgm });
    if (!props.audioAssets) {
      state.audioAssets.value = [...state.audioAssets.value, bgm];
    }
    void probeAndWidenAudioClip(clipId, bgm);
  }

  /** 切换侧栏视频的喜欢态，并立即写入工程 */
  function onToggleCatalogLike(variant: ComposeSegmentClipAssets): void {
    if (props.readonly) return;
    const key = composeMediaLikeKey(variant);
    if (!key) return;
    const rest = state.likedMedia.value.filter((item) => composeMediaLikeKey(item) !== key);
    if (likedMediaKeys.value.has(key)) {
      state.likedMedia.value = rest;
    } else {
      const entry: MediaRef = {
        url: variant.url?.trim() || undefined,
        mediaId: variant.mediaId,
        liked: true,
      };
      state.likedMedia.value = [...rest, entry];
    }
    ports.persistUploadCatalogNow();
  }

  /** 本地 SVG 进入花字列表，留在当前会话（仅未接管花字时） */
  async function onFancyUploaded(file: File): Promise<void> {
    if (props.onRequestUploadFancy) return;
    try {
      await appendUploadedTextTemplate(file);
      ElMessage.success("已添加到花字列表");
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法读取该花字文件";
      ElMessage.warning(message);
    }
  }

  /** 上传音效进入侧栏列表，不直接上轴 */
  function onSfxUploaded(bgm: BgmItem): void {
    if (props.sfxAssets) return;
    state.sfxAssets.value = [...state.sfxAssets.value, bgm];
  }

  /** 内置弹窗上传视频 → 写入唯一内部列表（宿主接管时不会走到） */
  function onClipUploaded(clips: UploadedComposeClip[]): void {
    if (props.videoAssets || props.onRequestUploadClip) return;
    if (!clips.length) return;
    for (const clip of clips) {
      if (!clip.url?.trim()) continue;
      state.uploadedCatalogVariants.value.push({
        id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        segmentIndex: 0,
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

  /** 点击上传视频：宿主回调优先 */
  function onUploadClipClick(): void {
    if (props.readonly) return;
    if (props.onRequestUploadClip) {
      props.onRequestUploadClip();
      return;
    }
    state.uploadClipModalOpen.value = true;
  }

  /** 点击上传音频 */
  function onUploadAudioClick(): void {
    if (props.readonly) return;
    if (props.onRequestUploadAudio) {
      props.onRequestUploadAudio();
      return;
    }
    state.uploadAudioModalOpen.value = true;
  }

  /** 点击上传音效 */
  function onUploadSfxClick(): void {
    if (props.readonly) return;
    if (props.onRequestUploadSfx) {
      props.onRequestUploadSfx();
      return;
    }
    state.uploadSfxModalOpen.value = true;
  }

  /** 点击上传花字：宿主回调优先，否则由外壳选文件 */
  function onUploadFancyClick(): void {
    if (props.readonly) return;
    if (props.onRequestUploadFancy) {
      props.onRequestUploadFancy();
    }
  }

  watch(
    () =>
      [
        props.modelValue.uploadedClipCatalog,
        props.modelValue.tracks,
        props.modelValue.composeExtractAudioUrls,
        props.modelValue.likedMedia,
      ] as const,
    () => {
      restoreInternalVideoVariantsFromModel();
      restoreLikedMediaFromModel();
      state.syncRegistryFromTracks(props.modelValue.tracks || []);
    },
    { deep: true },
  );

  watch(
    () => props.textTemplates,
    (list) => {
      setHostTextTemplates(list);
    },
    { deep: true },
  );

  ports.afterExitCatalogPreview = afterExitCatalogPreview;

  return {
    videoCatalogVariants,
    panelAudioAssets,
    panelSfxAssets,
    panelTextTemplates,
    likedMediaKeys,
    onToggleCatalogLike,
    onFancyUploaded,
    onSfxUploaded,
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
    onUploadClipClick,
    onUploadAudioClick,
    onUploadSfxClick,
    onUploadFancyClick,
  };
}
