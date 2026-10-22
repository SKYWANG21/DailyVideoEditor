import { mapMainTrackToVideoClips, mapTracksToPreviewAudioClips } from "@/types/videoCompose";
import type { ComposeEditorState } from "./createComposeEditorState";
import type { ComposeEditorPorts } from "./ports";

/** 预览与时间轴对钟。抑制回环的标志和 rAF 必须跟这些处理函数留在同一次闭包里 */
export function useComposePlaybackBridge(state: ComposeEditorState, ports: ComposeEditorPorts) {
  const { clock } = state;

  /** 读取 Player 是否正在播放（expose 的 ref 在父级已解包为 boolean） */
  function isPlayerPlaying(): boolean {
    const player = state.playerRef.value as { isPlaying?: boolean | { value: boolean } } | null;
    if (!player) return false;
    const playing = player.isPlaying;
    if (typeof playing === "boolean") return playing;
    return Boolean(playing?.value);
  }

  /** 时间轴是否存在可播放的视频或音轨 clip */
  function hasPlayableTimelineMedia(): boolean {
    return state.derivedMainClips.value.length > 0 || state.derivedAudioClips.value.length > 0;
  }

  /** 同步时间轴工具栏播放/暂停图标（不触发 playback 事件回环） */
  function syncTimelinePlaybackUi(playing: boolean): void {
    if (playing && !hasPlayableTimelineMedia() && !state.previewCatalogVariant.value) {
      playing = false;
    }
    if (playing === clock.timelineUiPlaying) return;
    clock.timelineUiPlaying = playing;
    clock.suppressTimelinePlaybackEmit = true;
    try {
      if (playing) state.timelineRef.value?.play?.();
      else state.timelineRef.value?.pause?.();
    } finally {
      requestAnimationFrame(() => {
        clock.suppressTimelinePlaybackEmit = false;
      });
    }
  }

  /** 时间轴清空后：停止播放并将游标归零，避免空轴墙钟空转 */
  function resetTimelinePlaybackWhenEmpty(): void {
    if (state.globalTime.value <= 0.001 && !isPlayerPlaying() && !clock.playInFlight) return;
    clock.playSeq += 1;
    clock.playInFlight = false;
    clock.playerDrivingTimeline = false;
    state.globalTime.value = 0;
    state.playerRef.value?.pause?.();
    state.playerRef.value?.refreshBgm?.();
    clock.suppressTimelineSeekToPlayer = true;
    state.timelineRef.value?.seekTo?.(0);
    requestAnimationFrame(() => {
      clock.suppressTimelineSeekToPlayer = false;
    });
    syncTimelinePlaybackUi(false);
  }

  /** 从时间轴命令读主轨和音轨。空轴时把游标收回 0 */
  function syncDerivedClipsFromTimeline(): void {
    const fromApi = state.timelineRef.value?.getMainVideoClips?.();
    state.derivedMainClips.value = fromApi?.length ? fromApi : mapMainTrackToVideoClips(state.tracks.value);
    state.derivedAudioClips.value = mapTracksToPreviewAudioClips(state.tracks.value);
    if (!hasPlayableTimelineMedia()) {
      resetTimelinePlaybackWhenEmpty();
    }
  }

  /** 主轨时间轴总时长（秒） */
  function mainTimelineTotalSec(): number {
    const clips = state.derivedMainClips.value;
    if (!clips.length) return 0;
    let maxEnd = 0;
    let hasAbs = false;
    for (const clip of clips) {
      if (clip.endTime != null) {
        hasAbs = true;
        maxEnd = Math.max(maxEnd, clip.endTime);
      }
    }
    if (hasAbs) return maxEnd;
    return clips.reduce((sum, clip) => sum + (clip.durationSec || 0), 0);
  }

  /** 游标是否在时间轴末尾（播放结束后点播放应从头重播） */
  function isTimelineAtEnd(timeSec: number): boolean {
    const total = mainTimelineTotalSec();
    return total > 0 && timeSec >= total - 0.04;
  }

  /** 时间线播放 → Player（以时间轴游标为准；play 内部按需 seek，避免连 seek 两次） */
  function onTimelinePlay(): void {
    if (clock.suppressTimelinePlaybackEmit) return;

    if (!hasPlayableTimelineMedia() && !state.previewCatalogVariant.value) {
      resetTimelinePlaybackWhenEmpty();
      return;
    }

    const inCatalogPreview = !!state.previewCatalogVariant.value;
    if (!inCatalogPreview && isPlayerPlaying()) return;

    if (inCatalogPreview) {
      clock.playSeq += 1;
      state.playerRef.value?.pause?.();
    }

    ports.afterExitCatalogPreview((exitedPreview) => {
      const seq = ++clock.playSeq;
      clock.playInFlight = true;
      clock.playerDrivingTimeline = true;
      let timeSec = state.timelineRef.value?.getCurrentTime?.() ?? state.globalTime.value;
      if (isTimelineAtEnd(timeSec)) {
        timeSec = 0;
        state.globalTime.value = 0;
        clock.suppressTimelineSeekToPlayer = true;
        state.timelineRef.value?.seekTo?.(0);
        requestAnimationFrame(() => {
          clock.suppressTimelineSeekToPlayer = false;
        });
      } else {
        state.globalTime.value = timeSec;
      }
      void (async () => {
        try {
          if (exitedPreview) {
            await state.playerRef.value?.resync?.(timeSec);
            if (seq !== clock.playSeq) return;
          }
          await state.playerRef.value?.play?.();
          if (seq !== clock.playSeq) return;
          syncTimelinePlaybackUi(true);
        } finally {
          if (seq === clock.playSeq) clock.playInFlight = false;
        }
      })();
    });
  }

  function onTimelinePause(): void {
    if (clock.suppressTimelinePlaybackEmit) return;
    clock.playSeq += 1;
    clock.playInFlight = false;
    state.playerRef.value?.pause?.();
    clock.playerDrivingTimeline = false;
    const timeSec = state.globalTime.value;
    clock.suppressTimelineSeekToPlayer = true;
    state.timelineRef.value?.seekTo?.(timeSec);
    requestAnimationFrame(() => {
      clock.suppressTimelineSeekToPlayer = false;
    });
    syncTimelinePlaybackUi(false);
  }

  /** 时间线拖尺 / seek → Player（播放中由 Player 主时钟时忽略 time-update） */
  function onTimelineSeek(timeSec: number): void {
    if (clock.suppressTimelineSeekToPlayer) return;
    ports.afterExitCatalogPreview((exitedPreview) => {
      clock.playerDrivingTimeline = false;
      if (exitedPreview) {
        void state.playerRef.value?.resync?.(timeSec);
      } else {
        void state.playerRef.value?.seek?.(timeSec);
      }
    });
  }

  function onTimelineTimeUpdate(timeSec: number): void {
    if (clock.playerDrivingTimeline || clock.suppressTimelineSeekToPlayer) return;
    if (isPlayerPlaying()) return;
    ports.afterExitCatalogPreview((exitedPreview) => {
      if (exitedPreview) {
        void state.playerRef.value?.resync?.(timeSec);
      } else {
        void state.playerRef.value?.seek?.(timeSec);
      }
    });
  }

  function onTimelineRateChange(rate: number): void {
    state.playerRef.value?.setPlaybackRate?.(rate);
  }

  /** 预览播放条：走时间轴 play/pause，空格键同一条路径 */
  function onPreviewTogglePlayback(): void {
    if (isPlayerPlaying()) state.timelineRef.value?.pause?.();
    else state.timelineRef.value?.play?.();
  }

  /** 预览播放条跳转。时间轴 seek 会再驱动预览 */
  function onPreviewSeek(timeSec: number): void {
    const duration = state.timelineRef.value?.getDuration?.() ?? state.previewDurationSec.value;
    const next = Math.max(0, Math.min(timeSec, duration > 0 ? duration : 0));
    state.timelineRef.value?.seekTo?.(next);
  }

  /**
   * Player 全局时间 → 时间线游标。
   * 素材库预览时主播放器独立播放，不同步时间轴游标。
   */
  function onPlayerGlobalTimeUpdate(timeSec: number): void {
    if (state.previewCatalogVariant.value) return;

    state.globalTime.value = timeSec;
    const playing = isPlayerPlaying();

    if (!playing) {
      if (clock.playInFlight) return;
      if (clock.playerDrivingTimeline) {
        clock.playerDrivingTimeline = false;
      }
      syncTimelinePlaybackUi(false);
      return;
    }

    if (!hasPlayableTimelineMedia()) {
      resetTimelinePlaybackWhenEmpty();
      return;
    }

    syncTimelinePlaybackUi(true);
    clock.playerDrivingTimeline = true;

    clock.suppressTimelineSeekToPlayer = true;
    state.timelineRef.value?.seekTo?.(timeSec);
    requestAnimationFrame(() => {
      clock.suppressTimelineSeekToPlayer = false;
    });
  }

  ports.syncTimelinePlaybackUi = syncTimelinePlaybackUi;
  ports.syncDerivedClipsFromTimeline = syncDerivedClipsFromTimeline;

  return {
    onTimelinePlay,
    onTimelinePause,
    onTimelineSeek,
    onTimelineTimeUpdate,
    onTimelineRateChange,
    onPreviewTogglePlayback,
    onPreviewSeek,
    onPlayerGlobalTimeUpdate,
  };
}
