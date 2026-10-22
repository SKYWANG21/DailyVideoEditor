import { nextTick, onBeforeUnmount, watch } from "vue";
import { ElMessage } from "element-plus";
import type { ComposeTrack, VideoClipItem, VideoComposeEditorModel } from "@/types/videoCompose";
import { hasTimelineSubtitles, normalizeComposeTimelineScale } from "@/types/videoCompose";
import {
  buildComposeClipInputsSignature,
  COMPOSE_CLIP_PLACEHOLDER_DURATION_SEC,
  isComposeClipDurationProbeable,
  probeClipDurationsWithRetry,
  resolveComposeClips,
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
  /** 防止重复触发；首次 clips 就绪后尝试一次自动转录 */
  let didAttemptAutoTranscribe = false;
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

  /** 时间轴右键「分离音轨」：唯一分离入口 */
  async function onTimelineDetachAudio(payload: { clipId: string; sourceUrl: string }): Promise<void> {
    void payload.sourceUrl;
    await state.detachAudioForVideoClip(payload.clipId);
    ports.syncDerivedClipsFromTimeline();
    ports.syncSidebarFromTracks();
    flush();
  }

  function buildModelValue(): VideoComposeEditorModel {
    const exported = state.timelineRef.value?.exportTracks?.() || state.tracks.value;
    return {
      id: props.modelValue.id,
      bizType: props.modelValue.bizType,
      bizId: props.modelValue.bizId,
      tracks: JSON.parse(JSON.stringify(exported)),
      uploadedClipCatalog: JSON.parse(JSON.stringify(state.uploadedCatalogVariants.value)),
      composeExtractAudioUrls: [...state.composeExtractAudioUrls.value],
      scale: normalizeComposeTimelineScale(state.timelineRef.value?.getScale?.() ?? props.modelValue.scale),
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

  /** 重新识别：清空字幕轨后按主轨顺序写入全局时间 */
  async function onRegenerateSubtitles(): Promise<void> {
    await transcribeMainTrackToSubtitles(true);
  }

  /** 本地不请求转录 */
  async function transcribeMainTrackToSubtitles(_showSuccess: boolean): Promise<void> {
    ElMessage.info("暂无");
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

  /**
   * 把 resolveComposeClips 已探到的时长写回仍占位的主轨 clip，避免 import 后再探一轮和抽帧抢 video。
   */
  function applyResolvedDurationsToMain(resolved: VideoClipItem[]): void {
    const byId = new Map(resolved.map((clip) => [clip.id, clip]));
    const mains = state.timelineRef.value?.getMainVideoClips?.() || [];
    for (const clip of mains) {
      if (!isComposeClipDurationProbeable(clip.durationSec)) continue;
      const hit = byId.get(clip.id);
      if (!hit || isComposeClipDurationProbeable(hit.durationSec)) continue;
      rebuildMainClipThumbnail(clip.id, hit.durationSec);
    }
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

  async function loadClips(): Promise<void> {
    state.playerRef.value?.pause();
    await nextTick();
    await waitForTimeline();

    clearDurationProbeRetry();
    durationProbeSeq += 1;
    const seq = durationProbeSeq;

    let clips: VideoClipItem[];

    if (isVideoComposeMockEnabled()) {
      clips = buildMockVideoClips();
      await probeClipDurationsWithRetry(clips);
      state.timelineRef.value?.bootstrapMainFromClips(clips);
    } else {
      clips = await resolveComposeClips(props.clips);
      const hasPersisted = Boolean(props.modelValue.tracks?.some((track) => track.clips.length > 0));
      if (hasPersisted && !didBootstrap) {
        state.timelineRef.value?.importTracks(props.modelValue.tracks);
        state.tracks.value = JSON.parse(JSON.stringify(props.modelValue.tracks));
        applyResolvedDurationsToMain(clips);
      } else if (!hasPersisted) {
        state.timelineRef.value?.bootstrapMainFromClips(clips);
      }
    }

    didBootstrap = true;
    state.syncRegistryFromTracks(state.tracks.value);
    ports.syncDerivedClipsFromTimeline();
    ports.syncSidebarFromTracks();
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

  async function maybeAutoTranscribe(): Promise<void> {
    if (!props.autoTranscribe || hasTimelineSubtitles(props.modelValue.tracks)) return;
    const clips = state.timelineRef.value?.getMainVideoClips?.() || state.derivedMainClips.value;
    if (clips.some((clip) => isComposeClipDurationProbeable(clip.durationSec))) return;
    await transcribeMainTrackToSubtitles(false);
  }

  function validate(): string | null {
    const clips = state.timelineRef.value?.getMainVideoClips?.() || state.derivedMainClips.value;
    if (!clips.length) return "尚未生成视频内容，请先完成片段生成";
    if (clips.some((clip) => !clip.url)) return "存在未就绪的视频片段，请返回上一步检查";
    if (state.isTranscribing.value) return "正在识别字幕，请稍候";
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

  watch(
    () => buildComposeClipInputsSignature(props.clips),
    (sig) => {
      if (isVideoComposeMockEnabled()) {
        void loadClips();
        return;
      }
      if (!sig) {
        state.derivedMainClips.value = [];
        return;
      }
      didBootstrap = false;
      void loadClips();
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    clearDurationProbeRetry();
  });

  return {
    onTracksUpdate,
    onTimelineScaleUpdate,
    onTimelineDetachAudio,
    onRegenerateSubtitles,
    validate,
    flush,
  };
}
