import { defineStore, getActivePinia } from "pinia";
import { ref, computed, shallowRef, watch } from "vue";
import type { PreviewPlaybackClock, TimelinePlaybackCommand } from "@/types/previewPlayback";
import { createPreviewPlaybackClock } from "@/hooks/previewPlaybackClock";
import { useTracksStore } from "./tracks";

/** 受控时间轴只读展示时钟；独立时间轴保留本地播放状态。 */
export const usePlaybackStore = defineStore("playback", () => {
  const pinia = getActivePinia();
  if (!pinia) throw new Error("playback store 需要 Pinia 实例");
  const localClock = createPreviewPlaybackClock();
  const source = shallowRef<Readonly<PreviewPlaybackClock>>();
  const onCommand = shallowRef<(command: TimelinePlaybackCommand) => void>();
  const duration = ref(0);
  const requestedTime = ref<number | null>(null);
  let scrubWasPlaying = false;

  /** 全部显示及编辑位置读取同一个已展示时间，不维护游标副本。 */
  const currentTime = computed(() => (source.value ?? localClock).presentedTime);
  const isPlaying = computed(() => (source.value ?? localClock).isPlaying);
  const playbackRate = computed(() => (source.value ?? localClock).playbackRate);
  const seekTime = computed(() => requestedTime.value ?? currentTime.value);
  const effectiveDuration = computed(() => Math.max(useTracksStore(pinia).totalDuration, duration.value));
  const formattedCurrentTime = computed(() => formatTime(currentTime.value));
  const formattedDuration = computed(() => formatTime(effectiveDuration.value));

  /** 目标帧提交或定位失败后结束草稿，数值相同的重定位也能完成。 */
  watch(
    () => [source.value?.revision, source.value?.state] as const,
    ([revision, state], previous) => {
      if (revision !== previous[0] || state === "error") requestedTime.value = null;
    },
    { flush: "sync" },
  );

  /** 绑定只读展示源和统一命令出口，绑定过程不会触发播放命令。 */
  function connect(clock: Readonly<PreviewPlaybackClock> | undefined, dispatch: (command: TimelinePlaybackCommand) => void): void {
    source.value = clock;
    onCommand.value = dispatch;
    requestedTime.value = null;
  }

  /** 格式化工程帧时间。 */
  function formatTime(seconds: number, fps = 30): string {
    const totalFrames = Math.floor(seconds * fps);
    const hours = Math.floor(totalFrames / (fps * 3600));
    const minutes = Math.floor((totalFrames % (fps * 3600)) / (fps * 60));
    const secs = Math.floor((totalFrames % (fps * 60)) / fps);
    const frames = totalFrames % fps;
    return [hours, minutes, secs, frames].map((value) => String(value).padStart(2, "0")).join(":");
  }

  /** 播放按钮只发意图，受控模式等待协调器更新状态。 */
  function play(): void {
    if (!source.value) localClock.isPlaying = true;
    onCommand.value?.({ type: "play" });
  }

  /** 暂停不回写游标，也不启动时间轴自己的计时循环。 */
  function pause(): void {
    if (!source.value) localClock.isPlaying = false;
    onCommand.value?.({ type: "pause" });
  }

  /** 切换以权威播放意图为准。 */
  function togglePlay(): void {
    if (isPlaying.value) pause();
    else play();
  }

  /** 跳转草稿供连续键盘操作累加；受控模式不提前推动主游标。 */
  function seekTo(time: number): void {
    const maxTime = effectiveDuration.value > 0 ? effectiveDuration.value : Infinity;
    const target = Math.max(0, Math.min(Number.isFinite(time) ? time : 0, maxTime));
    if (source.value) requestedTime.value = target;
    else localClock.presentedTime = target;
    onCommand.value?.({ type: "seek", time: target });
  }

  /** 倍速请求交给协调器，显示值不抢先改变。 */
  function setPlaybackRate(rate: number): void {
    const target = Number.isFinite(rate) && rate > 0 ? rate : 1;
    if (!source.value) localClock.playbackRate = target;
    onCommand.value?.({ type: "rate", rate: target });
  }

  /** 时长只参与标尺范围，不推进播放时间。 */
  function setDuration(value: number): void {
    duration.value = value;
  }

  /** 连续步进从未完成的目标累加，避免慢帧时按键丢失。 */
  function adjustTime(delta: number): void {
    seekTo(seekTime.value + delta);
  }

  /** 拖动开始记录播放意图，协调器负责真正暂停。 */
  function beginScrub(): void {
    scrubWasPlaying = isPlaying.value;
    if (!source.value) localClock.isPlaying = false;
    onCommand.value?.({ type: "scrub-start" });
  }

  /** 松手提交最终目标，恢复动作由协调器在目标画面展示后执行。 */
  function endScrub(time: number): void {
    if (!source.value) localClock.isPlaying = scrubWasPlaying;
    onCommand.value?.({ type: "scrub-end", time, resume: scrubWasPlaying });
  }

  /** 数据重置不通过播放命令修改外部时钟，工程清空由会话协调。 */
  function reset(): void {
    localClock.isPlaying = false;
    localClock.presentedTime = 0;
    localClock.playbackRate = 1;
    duration.value = 0;
    requestedTime.value = null;
  }

  return {
    isPlaying,
    currentTime,
    playbackRate,
    duration,
    effectiveDuration,
    seekTime,
    formattedCurrentTime,
    formattedDuration,
    connect,
    formatTime,
    play,
    pause,
    togglePlay,
    seekTo,
    setPlaybackRate,
    setDuration,
    adjustTime,
    beginScrub,
    endScrub,
    reset,
  };
});
