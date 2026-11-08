import { ref, computed, watch, onUnmounted, type Ref, type ComputedRef } from "vue";
import type { VideoClipItem, ComposeConfig, PreviewAudioClip, ComposeTrack } from "@/types/videoCompose";
import type { PreviewFrameIdentity } from "@/types/beautyPreview";
import { createPreviewAudioMixer, type PreviewAudioMixerSyncState } from "@/hooks/previewAudioMixer";
import { applyMediaCrossOrigin, mediaElementUsesUrl } from "@/service/resolveComposeMediaUrl";
import { useComposeMediaResolver } from "@/editor/composeRuntime";
import { applyPreviewGain, primePreviewAudioContext } from "@/hooks/previewMediaGain";
import { clampGain } from "@/editor/volumeDb";
import { previewClipStartSec, previewSourceTimeUs, previewSeekTimeSec } from "@/hooks/previewSourceTime";
import { readBeautyParams } from "@/types/composeMedia";
import { seekPreviewVideo } from "@/hooks/previewVideoFrame";
import { normalizeTrackTransitions, resolveTransitionAtTime, resolveTransitionSeams } from "@/transitions/timing";
import { createTransitionRegistry } from "@/transitions/catalog";
import type { TransitionSample } from "@/types/transition";

interface UseVideoComposePreviewOptions {
  /** 当前主轨配置，素材库单片预览不传。 */
  transitionTrack: Ref<ComposeTrack | undefined>;
  /** 双缓冲 video 同时负责解码和原声，画面统一由 Canvas 显示 */
  videoA: Ref<HTMLVideoElement | null>;
  /** 双缓冲视频 B */
  videoB: Ref<HTMLVideoElement | null>;
  /** 模板 legacy BGM；timeline 多轨由 mixer 池播放 */
  bgmEl: Ref<HTMLAudioElement | null>;
  /** 按时间轴排序的视频片段 */
  clips: Ref<VideoClipItem[]>;
  /** 时间轴多轨混音 */
  audioClips?: Ref<PreviewAudioClip[]>;
  /** 合成参数 */
  config: Ref<ComposeConfig>;
  /** 只影响预览的静音开关 */
  previewMuted: Ref<boolean>;
  /** Worker、GPUPixel 和当前所需模型预热完成 */
  beautyReady: Ref<boolean>;
}

/** 时间轴预览采样率 */
const FRAME_STEP_SEC = 1 / 30;
/** 普通播放提前预加载和软切的时间轴秒数 */
const PREPARE_AHEAD_SEC = 0.35;
const SWAP_AHEAD_SEC = 0.08;

/** 片段倍速，兜底 1 */
function clipRate(clip: VideoClipItem | undefined): number {
  return clip?.playbackRate && clip.playbackRate > 0 ? clip.playbackRate : 1;
}

/** 统一视频时钟、双 video 预加载及美颜逐帧等待，不向外改变播放控制接口 */
export function useVideoComposePreview(options: UseVideoComposePreviewOptions) {
  const { videoA, videoB, bgmEl, clips, previewMuted, beautyReady } = options;
  const composeConfig = options.config;
  const transitionRegistry = createTransitionRegistry();
  const mediaResolver = useComposeMediaResolver();
  const audioMixer = createPreviewAudioMixer(mediaResolver);
  const isPlaying = ref(false);
  const currentIdx = ref(0);
  const globalTime = ref(0);
  /** 当前画面请求的时间轴采样点 */
  const sampleTime = ref(0);
  /** 控制操作作废所有旧画面和续播任务 */
  const renderGeneration = ref(0);
  const globalPlaybackRate = ref(1);
  const activeSlot = ref<0 | 1>(0);
  const inGap = ref(false);
  /** 视频加载和跨片段定位完成前保留旧 Canvas */
  const mediaReady = ref(false);
  /** 等待处理时保留用户播放意图，但停止所有实际媒体 */
  const playbackWaiting = ref(false);
  const playbackError = ref("");

  /** 当前活动解码层 */
  const activeVideoEl: ComputedRef<HTMLVideoElement | null> = computed(() => (activeSlot.value === 0 ? videoA.value : videoB.value));
  /** 下一片段的预加载层 */
  const standbyVideoEl = computed(() => (activeSlot.value === 0 ? videoB.value : videoA.value));
  let navigation: AbortController | null = null;
  let preparation: AbortController | null = null;
  let preparationTask: Promise<boolean> | null = null;
  let preparingVideo: HTMLVideoElement | null = null;
  let preparingIdx = -1;
  let preparingTime = 0;
  let standbyReadyIdx = -1;
  let standbyTime = 0;
  let paceTimer = 0;
  let rafId = 0;
  let disposed = false;
  let gapWallStartMs = 0;
  let gapGlobalStart = 0;
  /** 正常播放期间对齐混音时钟；美颜播放时仅在一帧提交后短暂推进 */
  let audioWindowStartMs = 0;
  let audioWindowStartTime = 0;
  let audioWindowEndTime = 0;

  /** 片段的时间轴起点 */
  function clipStart(index: number): number {
    return previewClipStartSec(clips.value, index);
  }

  /** 片段的时间轴终点 */
  function clipEnd(index: number): number {
    const clip = clips.value[index];
    return clip?.endTime ?? clipStart(index) + (clip?.durationSec || 0);
  }

  /** 音频轨 / legacy BGM 最远终点 */
  function audioEnd(): number {
    const bgm = composeConfig.value.bgm;
    return Math.max(
      0,
      bgm ? composeConfig.value.bgmStartTime + (bgm.durationSec || 0) : 0,
      ...(options.audioClips?.value || []).map((c) => c.endTime),
    );
  }

  /** 有视频时遵循主轨终点；纯音频时用音轨终点 */
  const totalDurationSec = computed<number>(() => (clips.value.length ? Math.max(...clips.value.map((_, i) => clipEnd(i))) : audioEnd()));
  /** 纯音频预览走空隙墙钟 */
  const isAudioOnlyPreview = computed<boolean>(() => !clips.value.length && audioEnd() > 0);

  /** 末尾 seek 仍定位最后片段，播放结束保留末帧 */
  function findClipIndex(time: number): number {
    const last = clips.value.length - 1;
    return clips.value.findIndex(
      (_, i) => time >= clipStart(i) && (time < clipEnd(i) || (i === last && Math.abs(time - clipEnd(i)) < 0.000001)),
    );
  }

  /** 当前参数已预热才接管时钟；首次加载继续普通播放 */
  function framePaced(): boolean {
    return (
      Boolean(transitionAt(sampleTime.value)) ||
      (beautyReady.value && readBeautyParams(clips.value[currentIdx.value]?.beauty).enabled && !inGap.value)
    );
  }

  /** 时间窗命中独立于自然片段所属；未知效果由绘制层提示回退。 */
  function transitionAt(time: number): TransitionSample | null {
    const track = options.transitionTrack.value;
    return track ? resolveTransitionAtTime(track.clips, track.transitions ?? [], time) : null;
  }

  /** 当前片段的出场窗口；预热以窗口起点而不是硬切点计时。 */
  function outgoingTransition(): TransitionSample | null {
    const track = options.transitionTrack.value;
    if (!track) return null;
    const seam = resolveTransitionSeams(track.clips, normalizeTrackTransitions(track.clips, track.transitions)).find(
      (item) => item.transition && item.clipA.id === clips.value[currentIdx.value]?.id,
    );
    return seam?.transition ? transitionAt(seam.cut - seam.transition.durationSec / 2) : null;
  }

  /** 只预热待命槽，不暂停或重新定位正在播放的一侧。 */
  function prepareUpcoming(time: number): void {
    if (transitionAt(sampleTime.value)) return;
    const upcoming = outgoingTransition();
    if (upcoming) {
      if (upcoming.start - time > PREPARE_AHEAD_SEC) return;
      void transitionRegistry.resolve(upcoming.transition.effectId).catch(() => undefined);
      const index = clips.value.findIndex((clip) => clip.id === upcoming.clipB.id);
      if (index >= 0) void prepareStandby(index, upcoming.start);
    } else if (currentIdx.value + 1 < clips.value.length && clipEnd(currentIdx.value) - time <= PREPARE_AHEAD_SEC) {
      void prepareStandby(currentIdx.value + 1);
    }
  }

  /** 全局倍速与片段倍速相乘 */
  function effectiveRate(clip: VideoClipItem | undefined): number {
    return clipRate(clip) * globalPlaybackRate.value;
  }

  /** 当前 video 对应的时间轴位置 */
  function mediaTime(video: HTMLMediaElement): number {
    const clip = clips.value[currentIdx.value];
    return Math.min(
      clipEnd(currentIdx.value),
      clipStart(currentIdx.value) + Math.max(0, video.currentTime - (clip?.trimStart || 0)) / clipRate(clip),
    );
  }

  /** 原声分离、静音及片段增益沿用编辑器现有规则 */
  function applyClipMediaParams(video: HTMLMediaElement, clip: VideoClipItem | undefined): void {
    const volume = clampGain(clip?.volume ?? composeConfig.value.videoVolume);
    video.muted = previewMuted.value || clip?.audioDetached === true || volume <= 0;
    applyPreviewGain(video, video.muted ? 0 : volume);
    video.playbackRate = effectiveRate(clip);
  }

  /** 刷新活动层音量；待命层始终静音 */
  function syncVolumes(): void {
    if (!inGap.value && activeVideoEl.value) applyClipMediaParams(activeVideoEl.value, clips.value[currentIdx.value]);
    if (standbyVideoEl.value) standbyVideoEl.value.muted = true;
  }

  /** 混音实际播放时间在采样间隔内推进，处理等待时保持提交位置 */
  function mixerState(): PreviewAudioMixerSyncState {
    const raw = options.audioClips?.value || [];
    let time = globalTime.value;
    if (framePaced() && !playbackWaiting.value && isPlaying.value) {
      time = Math.min(
        audioWindowEndTime,
        audioWindowStartTime + ((performance.now() - audioWindowStartMs) / 1000) * globalPlaybackRate.value,
      );
    }
    return {
      audioClips: previewMuted.value ? raw.map((clip) => ({ ...clip, volume: 0, muted: true })) : raw,
      globalTime: time,
      isPlaying: isPlaying.value,
      playbackWaiting: playbackWaiting.value,
      globalPlaybackRate: globalPlaybackRate.value,
      composeConfig: previewMuted.value ? { ...composeConfig.value, bgmVolume: 0 } : composeConfig.value,
      bgmEl: bgmEl.value,
    };
  }

  /** 同步全部重叠音轨和 legacy BGM */
  function syncBgm(): void {
    audioMixer.sync(mixerState());
  }

  /** 音轨结构变化时刷新媒体池 */
  function refreshBgm(): void {
    audioMixer.refresh(mixerState());
  }

  /** 只暂停实际媒体，不改变用户的播放意图 */
  function holdMedia(): void {
    videoA.value?.pause();
    videoB.value?.pause();
    audioMixer.pauseAll(bgmEl.value);
  }

  /** 取消采样续播并使异步结果失效 */
  function invalidateFrames(): void {
    window.clearTimeout(paceTimer);
    paceTimer = 0;
    renderGeneration.value += 1;
  }

  /** 加载当前片段所需的地址后才写 src，取消的解析不能覆盖新请求 */
  async function loadVideo(video: HTMLVideoElement, index: number, time: number, signal: AbortSignal): Promise<void> {
    const clip = clips.value[index];
    if (!clip?.url) throw new Error("视频地址不可用");
    const resolved = await mediaResolver.resolve(clip.url);
    if (signal.aborted) throw new DOMException("预览请求已取消", "AbortError");
    applyMediaCrossOrigin(video, resolved);
    if (!mediaElementUsesUrl(video, resolved)) video.src = resolved;
    video.pause();
    video.muted = true;
    await seekPreviewVideo(video, previewSeekTimeSec(clips.value, index, time), signal);
  }

  /** 同一源采样复用已完成或进行中的准备，入口不取消预热任务。 */
  function prepareStandby(index: number, time = clipStart(index)): Promise<boolean> {
    const video = standbyVideoEl.value;
    if (!video || !clips.value[index]) return Promise.resolve(false);
    const sourceTime = previewSeekTimeSec(clips.value, index, time);
    if (standbyReadyIdx === index && Math.abs(standbyTime - sourceTime) < 0.000001 && !video.seeking && video.readyState >= 2)
      return Promise.resolve(true);
    if (preparationTask && preparingVideo === video && preparingIdx === index && Math.abs(preparingTime - sourceTime) < 0.000001)
      return preparationTask;
    preparation?.abort();
    const controller = new AbortController();
    preparation = controller;
    preparingVideo = video;
    preparingIdx = index;
    preparingTime = sourceTime;
    standbyReadyIdx = -1;
    preparationTask = (async (): Promise<boolean> => {
      try {
        await loadVideo(video, index, time, controller.signal);
        if (controller.signal.aborted || video !== standbyVideoEl.value || disposed) return false;
        standbyReadyIdx = index;
        standbyTime = sourceTime;
        return true;
      } catch {
        return false;
      } finally {
        if (preparation === controller) {
          preparingIdx = -1;
          preparingVideo = null;
          preparationTask = null;
        }
      }
    })();
    return preparationTask;
  }

  /** 自然播放进入转场时保留活动槽，只等待另一侧预热，不执行完整跳转。 */
  async function enterTransition(time: number): Promise<void> {
    const sample = transitionAt(time);
    if (!sample || findClipIndex(time) !== currentIdx.value) {
      await seek(time);
      return;
    }
    navigation?.abort();
    const controller = new AbortController();
    navigation = controller;
    playbackWaiting.value = true;
    mediaReady.value = false;
    holdMedia();
    invalidateFrames();
    const otherId = clips.value[currentIdx.value]?.id === sample.clipA.id ? sample.clipB.id : sample.clipA.id;
    const otherIndex = clips.value.findIndex((clip) => clip.id === otherId);
    try {
      const ready = await prepareStandby(otherIndex, time);
      if (controller.signal.aborted || disposed) return;
      if (!ready) throw new Error("转场关联视频尚未就绪");
      sampleTime.value = time;
      mediaReady.value = true;
      syncVolumes();
      requestSample(time);
      if (isPlaying.value) startLoop();
    } catch (error: unknown) {
      if (!controller.signal.aborted && !disposed) onFrameFailed(error instanceof Error ? error.message : "转场准备失败");
    }
  }

  /** 播放器错误暂停所有媒体，旧画面继续保留 */
  function onFrameFailed(message: string): void {
    pause();
    playbackError.value = message;
  }

  /** 普通模式恢复真实媒体播放；异步 play 不得在暂停后续播 */
  async function resumeMedia(): Promise<void> {
    const video = activeVideoEl.value;
    if (!video || !isPlaying.value || inGap.value || playbackWaiting.value || !mediaReady.value) return;
    const generation = renderGeneration.value;
    applyClipMediaParams(video, clips.value[currentIdx.value]);
    try {
      await video.play();
      if (disposed || !isPlaying.value || playbackWaiting.value || video !== activeVideoEl.value) video.pause();
    } catch (error: unknown) {
      if (generation === renderGeneration.value && isPlaying.value) onFrameFailed(error instanceof Error ? error.message : "视频播放失败");
    }
  }

  /** 为当前目标暂停媒体；快照钩子负责 seek、处理和最终提交 */
  function requestSample(time: number): void {
    if (!mediaReady.value) return;
    const nextTransition = transitionAt(time);
    // 相接窗口会直接从一项转场进入另一项，必须重新准备新的另一侧视频。
    if (nextTransition && nextTransition.transition.id !== transitionAt(sampleTime.value)?.transition.id) {
      void enterTransition(time);
      return;
    }
    if (!nextTransition && !(beautyReady.value && readBeautyParams(clips.value[currentIdx.value]?.beauty).enabled)) {
      void seek(time);
      return;
    }
    playbackWaiting.value = true;
    holdMedia();
    sampleTime.value = time;
    invalidateFrames();
    syncBgm();
  }

  /** 有效画面提交后才推进游标，再播放一个采样间隔的原声和混音 */
  function onFramePresented(identity: PreviewFrameIdentity): void {
    const clip = clips.value[currentIdx.value];
    if (disposed || identity.generation !== renderGeneration.value || identity.clipId !== clip?.id) return;
    if (identity.sourceTimeUs !== previewSourceTimeUs(clips.value, currentIdx.value, sampleTime.value) || !framePaced()) return;
    const transition = transitionAt(sampleTime.value);
    if (
      identity.transitionId !== transition?.transition.id ||
      (identity.timelineTimeSec != null && identity.timelineTimeSec !== sampleTime.value)
    )
      return;
    if (
      transition &&
      (identity.secondaryClipId !== transition.clipB.id ||
        identity.secondarySourceTimeUs !==
          previewSourceTimeUs(
            clips.value,
            clips.value.findIndex((item) => item.id === transition.clipB.id),
            sampleTime.value,
          ))
    )
      return;
    if (!isPlaying.value) {
      playbackWaiting.value = false;
      return;
    }
    // 同一采样因画幅/参数变化重绘时替换续播计时器，不能重复推进。
    window.clearTimeout(paceTimer);
    globalTime.value = sampleTime.value;
    const index = currentIdx.value;
    const end = clipEnd(index);
    const next = Math.min(end, sampleTime.value + FRAME_STEP_SEC * globalPlaybackRate.value);
    const generation = renderGeneration.value;
    playbackWaiting.value = false;
    audioWindowStartTime = globalTime.value;
    audioWindowEndTime = next;
    audioWindowStartMs = performance.now();
    void (async (): Promise<void> => {
      await resumeMedia();
      if (generation !== renderGeneration.value || !isPlaying.value || disposed) return;
      audioWindowStartMs = performance.now();
      syncBgm();
      paceTimer = window.setTimeout(
        () => {
          paceTimer = 0;
          if (generation !== renderGeneration.value || !isPlaying.value || !framePaced()) return;
          playbackWaiting.value = true;
          holdMedia();
          // 只在当前片段最后一个有效采样提交并播完后切段，禁用 80ms 软切。
          if (next >= end - 0.000001) advancePastClip(index);
          else requestSample(next);
        },
        Math.max(0, ((next - globalTime.value) / globalPlaybackRate.value) * 1000),
      );
    })();
  }

  /** 控制操作作废旧请求，双侧媒体并行定位完成后再交接解码槽。 */
  async function seek(timeSec: number): Promise<void> {
    navigation?.abort();
    preparation?.abort();
    preparingIdx = -1;
    preparingVideo = null;
    preparationTask = null;
    invalidateFrames();
    const controller = new AbortController();
    navigation = controller;
    const time = Math.max(0, Math.min(timeSec, totalDurationSec.value || timeSec));
    const index = findClipIndex(time);
    playbackWaiting.value = true;
    mediaReady.value = false;
    holdMedia();
    globalTime.value = time;
    sampleTime.value = time;
    playbackError.value = "";
    if (index < 0) {
      inGap.value = true;
      playbackWaiting.value = false;
      gapGlobalStart = time;
      gapWallStartMs = performance.now();
      syncBgm();
      if (isPlaying.value) startLoop();
      return;
    }
    inGap.value = false;
    try {
      const active = activeVideoEl.value;
      const clip = clips.value[index];
      const resolved = mediaResolver.peek(clip.url);
      const same = index === currentIdx.value && active && resolved && mediaElementUsesUrl(active, resolved);
      const target = same ? active : standbyVideoEl.value || active;
      if (!target) return;
      const preloaded =
        target === standbyVideoEl.value &&
        standbyReadyIdx === index &&
        Math.abs(standbyTime - previewSeekTimeSec(clips.value, index, time)) < 0.000001;
      const transition = transitionAt(time);
      const tasks: Promise<void>[] = [];
      if (!preloaded) tasks.push(loadVideo(target, index, time, controller.signal));
      if (transition) {
        const otherId = clip.id === transition.clipA.id ? transition.clipB.id : transition.clipA.id;
        const otherIndex = clips.value.findIndex((item) => item.id === otherId);
        const other = target === active ? standbyVideoEl.value : active;
        if (!other || otherIndex < 0) throw new Error("转场关联视频尚未就绪");
        tasks.push(loadVideo(other, otherIndex, time, controller.signal));
      }
      await Promise.all(tasks);
      if (controller.signal.aborted || disposed) return;
      if (target !== active) {
        active?.pause();
        if (active) active.muted = true;
        activeSlot.value = activeSlot.value === 0 ? 1 : 0;
      }
      currentIdx.value = index;
      standbyReadyIdx = -1;
      mediaReady.value = true;
      syncVolumes();
      playbackWaiting.value = false;
      if (framePaced()) requestSample(time);
      else if (isPlaying.value) await resumeMedia();
      if (controller.signal.aborted || disposed) return;
      if (isPlaying.value) startLoop();
      syncBgm();
      if (!transition) prepareUpcoming(time);
    } catch (error: unknown) {
      if (!controller.signal.aborted && !disposed) {
        controller.abort();
        onFrameFailed(error instanceof Error ? error.message : "视频画面读取失败");
      }
    }
  }

  /** 当前片段播放完毕后进入下一段、真实空隙或结束 */
  function advancePastClip(index: number): void {
    const end = clipEnd(index);
    const next = index + 1;
    if (next >= clips.value.length) {
      pause();
      globalTime.value = totalDurationSec.value;
      return;
    }
    if (clipStart(next) > end + 0.000001) {
      invalidateFrames();
      holdMedia();
      inGap.value = true;
      playbackWaiting.value = false;
      globalTime.value = end;
      gapGlobalStart = end;
      gapWallStartMs = performance.now();
      syncBgm();
    } else {
      void seek(clipStart(next));
    }
  }

  /** 空隙和纯音轨使用墙钟，实际空隙由显示画布清黑 */
  function tickGap(): void {
    const time = gapGlobalStart + ((performance.now() - gapWallStartMs) / 1000) * globalPlaybackRate.value;
    globalTime.value = Math.min(time, totalDurationSec.value);
    if (time >= totalDurationSec.value) {
      pause();
      return;
    }
    const index = findClipIndex(time);
    if (index >= 0) void seek(time);
  }

  /** 普通 video 时钟及预加载；美颜等待时不会推进游标或重新拉起音轨 */
  function loop(): void {
    if (disposed || !isPlaying.value) return;
    if (inGap.value || isAudioOnlyPreview.value) tickGap();
    else if (mediaReady.value && !framePaced() && !playbackWaiting.value) {
      const video = activeVideoEl.value;
      if (video && !video.seeking) globalTime.value = mediaTime(video);
      if (transitionAt(globalTime.value)) {
        void enterTransition(globalTime.value);
        return;
      }
      const index = currentIdx.value;
      const remain = clipEnd(index) - globalTime.value;
      const next = index + 1;
      const seamless = next < clips.value.length && clipStart(next) <= clipEnd(index) + 0.000001;
      const upcoming = outgoingTransition();
      if (remain <= 0.001 || video?.ended || (seamless && !upcoming && remain <= SWAP_AHEAD_SEC && standbyReadyIdx === next))
        advancePastClip(index);
    }
    if (mediaReady.value && !playbackWaiting.value) prepareUpcoming(globalTime.value);
    syncBgm();
    if (isPlaying.value) rafId = requestAnimationFrame(loop);
  }

  /** 只维护一个播放 RAF */
  function startLoop(): void {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(loop);
  }

  /** 从当前位置播放，末尾重播从起点开始 */
  async function play(): Promise<void> {
    primePreviewAudioContext();
    if (disposed || totalDurationSec.value <= 0) return;
    if (isPlaying.value) return;
    isPlaying.value = true;
    const atEnd = globalTime.value >= totalDurationSec.value - 0.000001;
    await seek(atEnd ? 0 : globalTime.value);
  }

  /** 用户暂停同时作废旧处理与异步续播 */
  function pause(): void {
    invalidateFrames();
    isPlaying.value = false;
    playbackWaiting.value = false;
    holdMedia();
    cancelAnimationFrame(rafId);
    sampleTime.value = globalTime.value;
  }

  /** 切换用户播放意图 */
  function toggle(): void {
    if (isPlaying.value) pause();
    else void play();
  }

  /** 跳到片段起点 */
  async function seekToClip(index: number): Promise<void> {
    if (clips.value[index]) await seek(clipStart(index));
  }

  /** 全局倍速改变后重新定位同一画面，旧采样和音频窗口均失效 */
  function setPlaybackRate(rate: number): void {
    globalPlaybackRate.value = rate > 0 ? rate : 1;
    void seek(globalTime.value);
  }

  /** 结构、裁剪和倍速变化后保持当前位置和播放意图 */
  async function resync(time = globalTime.value): Promise<void> {
    standbyReadyIdx = -1;
    await seek(time);
  }

  /** clips 或 video 节点挂载后初始化 */
  function init(): void {
    if (disposed) return;
    standbyReadyIdx = -1;
    refreshBgm();
    if (clips.value.length && (!videoA.value || !videoB.value)) return;
    void seek(globalTime.value);
  }

  /** 卸载时取消所有后台等待及媒体资源 */
  function destroy(): void {
    disposed = true;
    navigation?.abort();
    preparation?.abort();
    pause();
    audioMixer.destroy(bgmEl.value);
  }

  /** 预热完成时采用此刻视频位置，不重放预热期间产生的旧帧 */
  watch(
    beautyReady,
    (ready, previous) => {
      if (disposed || inGap.value || !mediaReady.value) return;
      if (ready && framePaced()) {
        if (isPlaying.value && activeVideoEl.value) globalTime.value = mediaTime(activeVideoEl.value);
        requestSample(globalTime.value);
      } else if (previous) {
        void seek(globalTime.value);
      }
    },
    { flush: "sync" },
  );

  /** 配置变化保持游标重建双侧定位，删除时恢复普通播放。 */
  watch(
    () => JSON.stringify(options.transitionTrack.value?.transitions),
    () => {
      if (!disposed && clips.value.length) void resync(globalTime.value);
    },
  );

  /** 参数改变作废处理中的画面，保留当前游标重新取样 */
  watch(
    () => JSON.stringify(clips.value[currentIdx.value]?.beauty),
    () => {
      invalidateFrames();
      if (disposed || !mediaReady.value || inGap.value) return;
      if (framePaced()) requestSample(globalTime.value);
      else if (isPlaying.value && !beautyReady.value) {
        playbackWaiting.value = false;
        void resumeMedia();
      }
    },
    { flush: "sync" },
  );

  /** 音量只影响实际媒体，不触发重复取帧 */
  watch(
    () => [
      composeConfig.value.videoVolume,
      previewMuted.value,
      clips.value[currentIdx.value]?.volume,
      clips.value[currentIdx.value]?.audioDetached,
    ],
    syncVolumes,
  );
  /** 音轨与 legacy BGM 更新时同步媒体池 */
  watch(() => JSON.stringify([options.audioClips?.value, composeConfig.value.bgm, composeConfig.value.bgmVolume]), refreshBgm);
  /** 普通播放的取帧目标跟随 video；美颜采样目标由提交回调推进 */
  watch(globalTime, (time) => {
    if (!framePaced()) sampleTime.value = time;
  });
  onUnmounted(destroy);

  return {
    isPlaying,
    currentIdx,
    globalTime,
    sampleTime,
    renderGeneration,
    onFramePresented,
    onFrameFailed,
    totalDurationSec,
    activeSlot,
    activeVideoEl,
    standbyVideoEl,
    mediaReady,
    playbackWaiting,
    playbackError,
    globalPlaybackRate,
    inGap,
    isAudioOnlyPreview,
    play,
    pause,
    toggle,
    seek,
    seekToClip,
    setPlaybackRate,
    resync,
    refreshBgm,
    init,
    destroy,
  };
}
