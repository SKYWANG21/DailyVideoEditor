import { mapMainTrackToVideoClips, mapTracksToPreviewAudioClips } from "@/types/videoCompose";
import type { TimelinePlaybackCommand } from "@/types/previewPlayback";
import type { ComposeEditorState } from "./createComposeEditorState";
import type { ComposeEditorPorts } from "./ports";

/** 只转发用户控制意图；展示时间由协调器直接写入共享时钟。 */
export function useComposePlaybackBridge(state: ComposeEditorState, ports: ComposeEditorPorts) {
  const { clock } = state;
  let pendingSeek: Promise<void> = Promise.resolve();

  /** 素材库与工程播放器共用控制入口，但各自保存展示时间。 */
  function isPlayerPlaying(): boolean {
    return Boolean(state.playerRef.value?.isPlaying);
  }

  /** 空工程不启动播放，纯音频工程仍允许播放。 */
  function hasPlayableTimelineMedia(): boolean {
    return state.derivedMainClips.value.length > 0 || state.derivedAudioClips.value.length > 0;
  }

  /** 清空工程是显式重置，不需要伪装成一次时间轴跳转。 */
  function resetTimelinePlaybackWhenEmpty(): void {
    clock.playSeq += 1;
    clock.playInFlight = false;
    if (!state.previewCatalogVariant.value) {
      state.playerRef.value?.pause();
      state.playerRef.value?.refreshBgm();
    }
    state.playbackClock.presentedTime = 0;
    state.playbackClock.isPlaying = false;
    state.playbackClock.state = "paused";
    state.playbackClock.revision += 1;
  }

  /** 工程媒体结构变化只更新输入，不通过时间轴控制 API 同步游标。 */
  function syncDerivedClipsFromTimeline(): void {
    const fromApi = state.timelineRef.value?.getMainVideoClips?.();
    state.derivedMainClips.value = fromApi?.length ? fromApi : mapMainTrackToVideoClips(state.tracks.value);
    state.derivedAudioClips.value = mapTracksToPreviewAudioClips(state.tracks.value);
    if (!hasPlayableTimelineMedia()) resetTimelinePlaybackWhenEmpty();
  }

  /** 控制命令共享取消代次，定位完成后才按最新意图恢复播放。 */
  function requestPlayback(timeSec: number | undefined, resume: boolean, releasedAt?: number): void {
    const seq = ++clock.playSeq;
    clock.playInFlight = resume;
    ports.afterExitCatalogPreview((exitedPreview) => {
      if (seq !== clock.playSeq) return;
      const player = state.playerRef.value;
      const target = timeSec ?? (exitedPreview ? state.globalTime.value : undefined);
      if (target !== undefined) {
        const args: [number, number?] = releasedAt === undefined ? [target] : [target, releasedAt];
        pendingSeek = (exitedPreview ? player?.resync(...args) : player?.seek(...args)) ?? Promise.resolve();
      }
      void (async (): Promise<void> => {
        try {
          await pendingSeek;
          if (seq === clock.playSeq && resume) await player?.play();
        } finally {
          if (seq === clock.playSeq) clock.playInFlight = false;
        }
      })();
    });
  }

  /** 暂停续播直接复用队列，播放结束后的回头定位仍由协调器处理。 */
  function onTimelinePlay(): void {
    if (hasPlayableTimelineMedia()) requestPlayback(undefined, true);
  }

  /** 暂停同时使尚未完成的恢复播放请求失效。 */
  function onTimelinePause(): void {
    clock.playSeq += 1;
    clock.playInFlight = false;
    state.playerRef.value?.pause();
  }

  /** 连续跳转以后一次请求为准，准备期间不提前修改已展示时间。 */
  function onTimelineSeek(timeSec: number, resume = state.playbackClock.isPlaying || clock.playInFlight): void {
    requestPlayback(timeSec, resume);
  }

  /** 所有时间轴入口统一发命令，共享时钟变化不会进入这里。 */
  function onTimelineCommand(command: TimelinePlaybackCommand): void {
    switch (command.type) {
      case "play":
        onTimelinePlay();
        break;
      case "pause":
      case "scrub-start":
        onTimelinePause();
        break;
      case "seek":
        onTimelineSeek(command.time);
        break;
      case "scrub-end":
        requestPlayback(command.time, command.resume, performance.now());
        break;
      case "rate":
        state.playerRef.value?.setPlaybackRate(command.rate);
        break;
    }
  }

  /** 预览播放按钮直接控制当前预览，不借时间轴 API 修改显示态。 */
  function onPreviewTogglePlayback(): void {
    if (isPlayerPlaying() || clock.playInFlight) onTimelinePause();
    else if (state.previewCatalogVariant.value) void state.playerRef.value?.play();
    else onTimelinePlay();
  }

  /** 素材库跳转留在素材预览内，工程跳转使用统一控制入口。 */
  function onPreviewSeek(timeSec: number): void {
    const duration = state.previewDurationSec.value;
    const next = Math.max(0, Math.min(timeSec, duration > 0 ? duration : 0));
    if (state.previewCatalogVariant.value) void state.playerRef.value?.seek(next);
    else onTimelineSeek(next);
  }

  ports.syncDerivedClipsFromTimeline = syncDerivedClipsFromTimeline;
  return { onTimelineCommand, onTimelinePlay, onTimelinePause, onTimelineSeek, onPreviewTogglePlayback, onPreviewSeek };
}
