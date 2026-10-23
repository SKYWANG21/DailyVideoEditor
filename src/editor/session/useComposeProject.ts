import { nextTick, onBeforeUnmount, watch } from "vue";
import type { ComposeTrack, VideoClipItem, VideoComposeEditorModel } from "@/types/videoCompose";
import { hasTimelineSubtitles, normalizeComposeTimelineScale } from "@/types/videoCompose";
import {
  COMPOSE_CLIP_PLACEHOLDER_DURATION_SEC,
  isComposeClipDurationProbeable,
  probeClipDurationsWithRetry,
} from "@/hooks/useResolveComposeClips";
import { buildMockVideoClips, isVideoComposeMockEnabled } from "../shared/videoComposeMockClips";
import type { ComposeEditorEmit, ComposeEditorProps, ComposeEditorState } from "./createComposeEditorState";
import type { ComposeEditorPorts } from "./ports";
import { tracksStructureSig } from "./trackLookup";

/** 轨道副本、草稿持久化和首次上轴。不把 tracks 回灌进时间轴 */
export function useComposeProject(
  props: ComposeEditorProps,
  state: ComposeEditorState,
  ports: ComposeEditorPorts,
  emit: ComposeEditorEmit,
) {
  /** 主轨布局签名：拖动/裁剪/换序等会影响预览定位 */
  let lastMainLayoutSig = "";
  /** 同会话只 import 一次 tracks，不因 clips 变化重置 */
  let didBootstrap = false;
  /** 占位时长二次探测间隔（ms） */
  const DURATION_PROBE_RETRY_MS = 1000;
  /** 作废进行中的时长回填 / 延迟探测 */
  let durationProbeSeq = 0;
  let durationProbeRetryTimer: number | null = null;
  let persistTimer: number | null = null;
  const TRACKS_PERSIST_DEBOUNCE_MS = 400;

  /** 把时间轴总时长同步到预览播放条 */
  function syncPreviewDuration(): void {
    state.previewDurationSec.value = Math.max(0, state.timelineRef.value?.getDuration?.() ?? 0);
  }

  /** 主轨布局签名。音量、美颜不进签名，避免拖滑块时重同步预览 */
  function mainVideoLayoutSig(list: VideoClipItem[]): string {
    return list
      .map(
        (clip) =>
          `${clip.id}:${clip.url}:${clip.startTime ?? ""}:${clip.endTime ?? ""}:${clip.durationSec}:${clip.trimStart ?? ""}:${clip.trimEnd ?? ""}:${clip.playbackRate ?? ""}`,
      )
      .join("|");
  }

  function onTracksUpdate(next: ComposeTrack[]): void {
    state.tracks.value = next;
    ports.syncDerivedClipsFromTimeline();
    syncPreviewDuration();
    if (!state.clock.syncingFromTracks) ports.syncSidebarFromTracks();

    const sig = mainVideoLayoutSig(state.derivedMainClips.value);
    if (sig === lastMainLayoutSig) return;
    lastMainLayoutSig = sig;
    const timeSec = state.timelineRef.value?.getCurrentTime?.() ?? state.globalTime.value;
    void nextTick(() => {
      void state.playerRef.value?.resync?.(timeSec);
    });
  }

  /** 时间轴倍率变更：写入工程 JSON（与 tracks 共用 debounce persist） */
  function onTimelineScaleUpdate(_scale: number): void {
    scheduleTracksPersist();
  }

  function buildModelValue(): VideoComposeEditorModel {
    const exported = state.timelineRef.value?.exportTracks?.() || state.tracks.value;
    return {
      id: props.modelValue.id,
      bizType: props.modelValue.bizType,
      bizId: props.modelValue.bizId,
      tracks: JSON.parse(JSON.stringify(exported)),
      likedMedia: JSON.parse(JSON.stringify(state.likedMedia.value)),
      composeExtractAudioUrls: [...state.composeExtractAudioUrls.value],
      scale: normalizeComposeTimelineScale(state.timelineRef.value?.getScale?.() ?? props.modelValue.scale),
    };
  }

  /**
   * 用指定工程整页重置时间轴与会话态。侧栏视频/音频/音效/花字以宿主 props 为准，不从 model 回灌。
   */
  async function reload(model: VideoComposeEditorModel): Promise<void> {
    state.playerRef.value?.pause();
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    clearDurationProbeRetry();
    durationProbeSeq += 1;

    emit("update:modelValue", JSON.parse(JSON.stringify(model)));
    await nextTick();
    await waitForTimeline();

    const tracks = model.tracks?.length ? JSON.parse(JSON.stringify(model.tracks)) : [];
    state.tracks.value = tracks;
    state.lastPersistedStructureSig = tracksStructureSig(tracks);
    state.likedMedia.value = (model.likedMedia ?? [])
      .filter((item) => item.liked !== false)
      .map((item) => ({ ...item, liked: true as const }));
    state.composeExtractAudioUrls.value = [...(model.composeExtractAudioUrls || [])];

    state.timelineRef.value?.importTracks(tracks);
    state.syncRegistryFromTracks(tracks);
    ports.syncDerivedClipsFromTimeline();
    ports.syncSidebarFromTracks();
    syncPreviewDuration();
    lastMainLayoutSig = mainVideoLayoutSig(state.derivedMainClips.value);
    didBootstrap = true;
    emit("ready");

    const seq = durationProbeSeq;
    await applyProbedMainClipDurations();
    if (seq !== durationProbeSeq) return;
    if (!mainClipsStillProbeable()) return;
    durationProbeRetryTimer = window.setTimeout(() => {
      durationProbeRetryTimer = null;
      if (seq !== durationProbeSeq) return;
      void applyProbedMainClipDurations();
    }, DURATION_PROBE_RETRY_MS);
  }

  /** 立即写入 model（喜欢态等，不依赖 tracks 防抖） */
  function persistUploadCatalogNow(): void {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    emit("update:modelValue", buildModelValue());
  }

  function scheduleTracksPersist(immediate = false): void {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (immediate) {
      state.lastPersistedStructureSig = tracksStructureSig(state.tracks.value);
      emit("update:modelValue", buildModelValue());
      return;
    }
    persistTimer = window.setTimeout(() => {
      persistTimer = null;
      state.lastPersistedStructureSig = tracksStructureSig(state.tracks.value);
      emit("update:modelValue", buildModelValue());
    }, TRACKS_PERSIST_DEBOUNCE_MS);
  }

  function flush(): void {
    scheduleTracksPersist(true);
    const exported = state.timelineRef.value?.exportTracks?.() || state.tracks.value;
    state.scheduleOrphanComposeExtractCleanup(exported);
  }

  function clearDurationProbeRetry(): void {
    if (durationProbeRetryTimer != null) {
      window.clearTimeout(durationProbeRetryTimer);
      durationProbeRetryTimer = null;
    }
  }

  /** 主轨是否仍有未探测真实时长的 clip */
  function mainClipsStillProbeable(): boolean {
    return (state.timelineRef.value?.getMainVideoClips?.() || []).some(
      (clip) => isComposeClipDurationProbeable(clip.durationSec) && Boolean(clip.url),
    );
  }

  /** 单个主轨 clip 时长就绪后重建，触发时间轴重新抽帧 */
  function rebuildMainClipThumbnail(clipId: string, durationSec: number): void {
    if (durationSec <= COMPOSE_CLIP_PLACEHOLDER_DURATION_SEC) return;
    state.timelineRef.value?.rebuildMainClipAt(clipId, durationSec);
  }

  /**
   * 探测仍占位的主轨 clip；探到一条立刻 rebuild（改时长并重抽帧），不等整批结束。
   */
  async function applyProbedMainClipDurations(): Promise<void> {
    const targets = (state.timelineRef.value?.getMainVideoClips?.() || []).filter(
      (clip) => isComposeClipDurationProbeable(clip.durationSec) && Boolean(clip.url),
    );
    if (!targets.length) return;

    await probeClipDurationsWithRetry(targets, (clip) => {
      rebuildMainClipThumbnail(clip.id, clip.durationSec);
      ports.syncDerivedClipsFromTimeline();
    });
  }

  /** 等到时间轴挂载清空结束再上轴，避免 reset 抹掉刚写入的主轨 */
  function waitForTimeline(): Promise<void> {
    return new Promise((resolve) => {
      let tries = 0;
      const tick = () => {
        const ready = state.timelineRef.value?.whenReady?.();
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

  /** 会话启动一次建轨。Mock 用样片建主轨；非 mock 只 import tracks，空轨不建主轨 */
  async function bootstrapTimeline(): Promise<void> {
    state.playerRef.value?.pause();
    await nextTick();
    await waitForTimeline();

    clearDurationProbeRetry();
    durationProbeSeq += 1;
    const seq = durationProbeSeq;

    if (isVideoComposeMockEnabled()) {
      const clips = buildMockVideoClips();
      await probeClipDurationsWithRetry(clips);
      state.timelineRef.value?.bootstrapMainFromClips(clips);
    } else if (!didBootstrap) {
      didBootstrap = true;
      const tracks = props.modelValue.tracks;
      const hasTracks = Boolean(tracks?.some((track) => track.clips.length > 0));
      if (hasTracks && tracks) {
        state.timelineRef.value?.importTracks(tracks);
        state.tracks.value = JSON.parse(JSON.stringify(tracks));
      }
    }

    didBootstrap = true;
    state.syncRegistryFromTracks(state.tracks.value);
    ports.syncDerivedClipsFromTimeline();
    ports.syncSidebarFromTracks();
    emit("ready");

    await applyProbedMainClipDurations();
    if (seq !== durationProbeSeq) return;
    if (!mainClipsStillProbeable()) return;

    durationProbeRetryTimer = window.setTimeout(() => {
      durationProbeRetryTimer = null;
      if (seq !== durationProbeSeq) return;
      void applyProbedMainClipDurations();
    }, DURATION_PROBE_RETRY_MS);
  }

  function validate(): string | null {
    const clips = state.timelineRef.value?.getMainVideoClips?.() || state.derivedMainClips.value;
    if (!clips.length) return "尚未生成视频内容，请先完成片段生成";
    if (clips.some((clip) => !clip.url)) return "存在未就绪的视频片段，请返回上一步检查";
    if (hasTimelineSubtitles(state.tracks.value) && clips.length > 1 && clips.some((clip) => !clip.durationSec)) {
      return "视频时长加载中，请稍候再试";
    }
    return null;
  }

  ports.persistUploadCatalogNow = persistUploadCatalogNow;
  ports.flush = flush;
  ports.rebuildMainClipThumbnail = rebuildMainClipThumbnail;

  watch(
    state.tracks,
    () => {
      const structureChanged = tracksStructureSig(state.tracks.value) !== state.lastPersistedStructureSig;
      scheduleTracksPersist(structureChanged);
    },
    { deep: true },
  );

  /** 深监听整份 model，保持与拆分前相同的依赖收集 */
  watch(
    () => props.modelValue,
    (val) => {
      void val;
    },
    { deep: true },
  );

  /** 只在会话启动时建轨一次。不监听 clips，避免入参变化重灌主轨 */
  watch(
    () => true,
    () => {
      void bootstrapTimeline();
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    clearDurationProbeRetry();
  });

  return {
    onTracksUpdate,
    onTimelineScaleUpdate,
    validate,
    flush,
    reload,
  };
}
