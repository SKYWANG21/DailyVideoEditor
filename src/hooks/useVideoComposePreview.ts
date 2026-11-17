import { computed, onUnmounted, ref, watch, type Ref } from "vue";
import type { ComposeConfig, ComposeTrack, PreviewAudioClip, VideoClipItem } from "@/types/videoCompose";
import type { PreviewVideoSize } from "@/types/beautyPreview";
import type { TransitionSample } from "@/types/transition";
import type {
  DecodedPreviewFrame,
  PreparedPreviewFrame,
  PreviewFrameRenderer,
  PreviewPlaybackClock,
  PreviewRenderRequest,
} from "@/types/previewPlayback";
import { createPreviewAudioMixer, type PreviewAudioMixerSyncState } from "./previewAudioMixer";
import { useComposeMediaResolver, useComposeTransitionRegistry } from "@/editor/composeRuntime";
import { primePreviewAudioContext } from "./previewMediaGain";
import { clampGain } from "@/editor/volumeDb";
import { previewClipStartSec } from "./previewSourceTime";
import { normalizeTrackTransitions, resolveTransitionAtTime, resolveTransitionSeams } from "@/transitions/timing";
import { readVideoFrameTransform } from "@/editor/shared/videoFrame";
import { PreviewVideoDecoder } from "./previewVideoDecoder";
import { PREVIEW_FPS, PREVIEW_RESUME_FRAMES, PreviewFrameScheduler } from "./previewFrameScheduler";
import { createPreviewPlaybackClock } from "./previewPlaybackClock";

/**
 * 预览采用静音双 video 连续解码，原声与 BGM/音轨独立跟随展示时钟。普通、美颜和转场统一通过完成帧队列展示，画面提交后才更新时间轴、字幕和贴图；缺帧或音频未就绪时共同缓冲，恢复后不追赶等待期间的墙钟时间。
 * 播放器与时间轴共享每个编辑器独立的展示时钟，时间轴被动读取已提交时间；点击、拖动和快捷键只发送控制命令。
 * 定位期间保留旧画面与游标，目标帧展示后一起更新；拖动期间暂停，松手后恢复拖动前的播放意图。素材库预览使用独立时钟。
 * 原始快照每槽最多 3 帧，完成队列最多 6 帧，开始/恢复前准备 3 帧；高水位停产后降到 3 帧再恢复解码。
 * 预览最长边为 1920，低分辨率不放大，工程尺寸、画面坐标及导出配置保持原值。这些队列与原声媒体仅属于运行时，不写入 `modelValue`。
 * 默认输出采样率为 30fps，复用浏览器原生选帧，不保证捕获每个源视频帧。
 */

/** 原生解码、完成帧展示与音频的协调输入，不把逐帧任务交给 Vue watch。 */
interface UseVideoComposePreviewOptions {
  /** 当前预览的展示时钟；工程和素材预览使用不同对象。 */
  clock?: Ref<PreviewPlaybackClock>;
  /** 素材库单片预览为空。 */
  transitionTrack: Ref<ComposeTrack | undefined>;
  /** 两个始终静音的原生解码槽。 */
  videoA: Ref<HTMLVideoElement | null>;
  videoB: Ref<HTMLVideoElement | null>;
  /** legacy BGM 元素。 */
  bgmEl: Ref<HTMLAudioElement | null>;
  /** 有效视频列表及工程音轨。 */
  clips: Ref<VideoClipItem[]>;
  audioClips?: Ref<PreviewAudioClip[]>;
  /** 合成参数与预览独立静音。 */
  config: Ref<ComposeConfig>;
  previewMuted: Ref<boolean>;
  /** 处理器晚于控制器挂载，节点就绪后才开始准备。 */
  renderer: Ref<PreviewFrameRenderer | null>;
  /** 项目尺寸或单片变换变化时重建输出，尺寸不会进入持久化预览配置。 */
  renderConfig?: Ref<unknown>;
}

/** 连续解码生产完成帧，只有画面提交能推进对外游标。 */
export function useVideoComposePreview(options: UseVideoComposePreviewOptions) {
  const mediaResolver = useComposeMediaResolver();
  const audioMixer = createPreviewAudioMixer(mediaResolver, fail);
  const registry = useComposeTransitionRegistry();
  const scheduler = new PreviewFrameScheduler();
  const clock = options.clock ?? ref(createPreviewPlaybackClock());
  /** 播放状态直接读写当前会话，不通过时间轴事件回写。 */
  const isPlaying = computed({
    get: () => clock.value.isPlaying,
    set: (value: boolean) => {
      clock.value.isPlaying = value;
    },
  });
  const currentIdx = ref(0);
  /** 只有展示提交和播放结束能推进对外时间。 */
  const globalTime = computed({
    get: () => clock.value.presentedTime,
    set: (value: number) => {
      clock.value.presentedTime = value;
    },
  });
  const presentedFrameVersion = computed(() => clock.value.revision);
  const globalPlaybackRate = computed({
    get: () => clock.value.playbackRate,
    set: (value: number) => {
      clock.value.playbackRate = value;
    },
  });
  const renderGeneration = ref(0);
  const playbackState = computed({
    get: () => clock.value.state,
    set: (value: PreviewPlaybackClock["state"]) => {
      clock.value.state = value;
    },
  });
  const mediaReady = ref(false);
  const playbackWaiting = ref(false);
  const playbackError = ref("");
  const inGap = ref(false);
  const presentedSourceSize = ref<PreviewVideoSize | null>(null);
  const previewStats = { produced: 0, presented: 0, bufferingCount: 0, maxQueued: 0 };
  let decoder: PreviewVideoDecoder | null = null;
  let decoderVideos: HTMLVideoElement[] = [];
  let controller = new AbortController();
  let productionController: AbortController | null = null;
  let firstPending = false;
  let settleSeek: (() => void) | null = null;
  let produceTime = 0;
  let requestId = 0;
  let busy = false;
  let producerBackpressured = false;
  let resuming = false;
  let audioPreparation: AbortController | null = null;
  let transportVersion = 0;
  let raf = 0;
  let disposed = false;

  /** 视频主轨决定终点，纯音频取音轨/BGM 的最远终点。 */
  const totalDurationSec = computed(() => {
    if (options.clips.value.length) return Math.max(...options.clips.value.map((clip, index) => clipEnd(index)));
    const config = options.config.value;
    return Math.max(
      0,
      config.bgm ? config.bgmStartTime + config.bgm.durationSec : 0,
      ...(options.audioClips?.value ?? []).map((clip) => clip.endTime),
    );
  });
  const isAudioOnlyPreview = computed(() => !options.clips.value.length && totalDurationSec.value > 0);

  /** 片段在项目时间轴的绝对入点。 */
  function clipStart(index: number): number {
    return previewClipStartSec(options.clips.value, index);
  }

  /** 兼容未携带绝对出点的素材库临时片段。 */
  function clipEnd(index: number): number {
    return options.clips.value[index]?.endTime ?? clipStart(index) + (options.clips.value[index]?.durationSec || 0);
  }

  /** 末尾定位保留末帧，真实轨道空隙返回 -1。 */
  function findClip(time: number): number {
    return options.clips.value.findIndex(
      (_, index) =>
        time >= clipStart(index) &&
        (time < clipEnd(index) || (index === options.clips.value.length - 1 && Math.abs(time - clipEnd(index)) < 1e-6)),
    );
  }

  /** 转场命中基于项目时间，独立于后台解码槽的预卷进度。 */
  function transitionAt(time: number): TransitionSample | null {
    const track = options.transitionTrack.value;
    return track ? resolveTransitionAtTime(track.clips, track.transitions ?? [], time) : null;
  }

  /** 原声单独播放，隐藏 video 的预卷不会提前发声。 */
  function mixerState(time = scheduler.time(performance.now())): PreviewAudioMixerSyncState {
    const muted = options.previewMuted.value;
    const config = options.config.value;
    return {
      audioClips: (options.audioClips?.value ?? []).map((clip) => (muted ? { ...clip, muted: true, volume: 0 } : clip)),
      originalAudioClips: options.clips.value
        .filter((clip) => !clip.audioDetached)
        .map((clip) => {
          const index = options.clips.value.indexOf(clip);
          return {
            id: clip.id,
            url: clip.url,
            startTime: clipStart(index),
            endTime: clipEnd(index),
            trimStart: clip.trimStart ?? 0,
            volume: muted ? 0 : clampGain(clip.volume ?? config.videoVolume),
            playbackRate: clip.playbackRate || 1,
            muted,
          };
        }),
      globalTime: time,
      isPlaying: isPlaying.value,
      playbackWaiting: playbackWaiting.value,
      globalPlaybackRate: globalPlaybackRate.value,
      composeConfig: muted ? { ...config, bgmVolume: 0 } : config,
      bgmEl: options.bgmEl.value,
    };
  }

  /** 真实 DOM 解码节点改变才重建资源；展示片段切换不重建。 */
  function ensureDecoder(): PreviewVideoDecoder | null {
    if (!options.clips.value.length) return null;
    const videos = [options.videoA.value, options.videoB.value].filter((video): video is HTMLVideoElement => Boolean(video));
    if (videos.length !== 2) return null;
    if (!decoder || videos.some((video, index) => video !== decoderVideos[index])) {
      decoder?.dispose();
      decoder = new PreviewVideoDecoder(videos, mediaResolver);
      decoderVideos = videos;
    }
    return decoder;
  }

  /** 帧区间不跨越片段或转场边界，避免提前换片或音频越界。 */
  function nextSample(time: number): number {
    let next = Math.min(totalDurationSec.value, time + globalPlaybackRate.value / PREVIEW_FPS);
    const track = options.transitionTrack.value;
    const boundaries = options.clips.value.flatMap((_, index) => [clipStart(index), clipEnd(index)]);
    if (track) {
      for (const seam of resolveTransitionSeams(track.clips, normalizeTrackTransitions(track.clips, track.transitions))) {
        if (seam.transition) boundaries.push(seam.cut - seam.transition.durationSec / 2, seam.cut + seam.transition.durationSec / 2);
      }
    }
    for (const boundary of boundaries) if (boundary > time + 1e-6 && boundary < next) next = boundary;
    return next;
  }

  /** 入口前按墙钟 350ms 预算预热，边界缓存允许双槽提前复用给连续转场。 */
  function prewarm(time: number, indices: readonly number[]): void {
    const track = options.transitionTrack.value;
    const lead = 0.35 * globalPlaybackRate.value;
    const protectedIndices = decoder?.protectedIndices(options.clips.value, indices, time) ?? [];
    if (track) {
      const upcoming = resolveTransitionSeams(track.clips, normalizeTrackTransitions(track.clips, track.transitions)).find(
        (seam) =>
          seam.transition &&
          seam.cut - seam.transition.durationSec / 2 > time + 1e-6 &&
          seam.cut - seam.transition.durationSec / 2 - time <= lead,
      );
      if (upcoming?.transition) {
        const index = options.clips.value.findIndex((clip) => clip.id === upcoming.clipB.id);
        void registry.resolve(upcoming.transition.effectId).catch(() => undefined);
        if (index >= 0) {
          void options.renderer.value?.warmup([...indices, index]);
          decoder?.prewarm(
            options.clips.value,
            index,
            upcoming.cut - upcoming.transition.durationSec / 2,
            globalPlaybackRate.value,
            protectedIndices,
            controller.signal,
          );
        }
        return;
      }
    }
    const next = options.clips.value.findIndex((_, index) => clipStart(index) > time + 1e-6 && clipStart(index) - time <= lead);
    if (next >= 0)
      decoder?.prewarm(options.clips.value, next, clipStart(next), globalPlaybackRate.value, protectedIndices, controller.signal);
  }

  /** 展示成功后同步身份和时间，不能在解码或处理完成时提前写游标。 */
  function present(frame: PreparedPreviewFrame): void {
    try {
      options.renderer.value!.present(frame);
      scheduler.presented(frame);
      inGap.value = frame.clipIndex < 0;
      if (frame.clipIndex >= 0) currentIdx.value = frame.clipIndex;
      const size = frame.sourceSize ?? null;
      if (size?.width !== presentedSourceSize.value?.width || size?.height !== presentedSourceSize.value?.height)
        presentedSourceSize.value = size;
      mediaReady.value = true;
      globalTime.value = frame.time;
      clock.value.revision += 1;
      previewStats.presented += 1;
    } finally {
      frame.bitmap?.close();
    }
  }

  /** 借用双侧快照并生成一次固定采样，任一失败都归还已取得的输入。 */
  async function prepareFrame(
    time: number,
    signal: AbortSignal,
    sessionSignal: AbortSignal,
  ): Promise<{ frame: PreparedPreviewFrame; indices: number[] }> {
    const clipIndex = findClip(time);
    const transition = transitionAt(time);
    const indices = transition
      ? [transition.clipA.id, transition.clipB.id].map((id) => options.clips.value.findIndex((clip) => clip.id === id))
      : clipIndex < 0
        ? []
        : [clipIndex];
    if (indices.some((index) => index < 0)) throw new Error("转场关联片段不存在");
    const inputs: DecodedPreviewFrame[] = [];
    let acceptingInputs = true;
    const generation = renderGeneration.value;
    try {
      const protectedIndices = decoder?.protectedIndices(options.clips.value, indices, time) ?? [];
      await Promise.all([
        ...indices.map(async (index, slot) => {
          const input = await decoder!.acquire(
            options.clips.value,
            index,
            time,
            globalPlaybackRate.value,
            protectedIndices,
            signal,
            sessionSignal,
          );
          if (!acceptingInputs || signal.aborted) {
            input.release();
            throw new DOMException("采样已取消", "AbortError");
          }
          inputs[slot] = input;
        }),
        options.renderer.value!.warmup(indices),
      ]);
      signal.throwIfAborted();
      const primary = transition && options.clips.value[clipIndex]?.id === transition.clipB.id ? inputs[1] : inputs[0];
      const request: PreviewRenderRequest = {
        identity: {
          generation,
          requestId: ++requestId,
          clipId: options.clips.value[clipIndex]?.id ?? "",
          sourceTimeUs: primary?.sourceTimeUs ?? 0,
          timelineTimeSec: time,
          transitionId: transition?.transition.id,
          secondaryClipId: transition?.clipB.id,
          secondarySourceTimeUs: inputs[1]?.sourceTimeUs,
        },
        time,
        duration: Math.max(0, nextSample(time) - time),
        clipIndex,
        outgoing: inputs[0],
        incoming: inputs[1],
        transition,
      };
      return { frame: await options.renderer.value!.render(request, signal), indices };
    } finally {
      acceptingInputs = false;
      for (const input of inputs) input?.release();
    }
  }

  /** 单一生产任务可提前填充六帧，不等待每一帧展示后才开始下一次处理。 */
  async function pump(): Promise<void> {
    if (busy || disposed || controller.signal.aborted || !options.renderer.value || (options.clips.value.length && !ensureDecoder()))
      return;
    if ((!firstPending && !isPlaying.value) || scheduler.full || scheduler.productionEnded) return;
    // 高水位停产后必须降到低水位再恢复，不能每腾出一帧就 play/pause 一次。
    if (producerBackpressured && scheduler.size > PREVIEW_RESUME_FRAMES) return;
    producerBackpressured = false;
    busy = true;
    const activeController = controller;
    const production = new AbortController();
    productionController = production;
    const abort = (): void => production.abort();
    activeController.signal.addEventListener("abort", abort, { once: true });
    const generation = renderGeneration.value;
    decoder?.setRunning(isPlaying.value);
    try {
      while (
        !disposed &&
        activeController === controller &&
        (firstPending || isPlaying.value) &&
        !scheduler.full &&
        !scheduler.productionEnded
      ) {
        const time = produceTime;
        const { frame, indices } = await prepareFrame(time, production.signal, activeController.signal);
        if (production.signal.aborted || generation !== renderGeneration.value || disposed) {
          frame.bitmap?.close();
          break;
        }
        previewStats.produced += 1;
        if (firstPending) {
          firstPending = false;
          present(frame);
          settleSeek?.();
          settleSeek = null;
          playbackWaiting.value = isPlaying.value;
          playbackState.value = isPlaying.value ? "preparing" : "paused";
        } else scheduler.enqueue(frame);
        previewStats.maxQueued = Math.max(previewStats.maxQueued, scheduler.size);
        produceTime = time + frame.duration;
        if (produceTime >= totalDurationSec.value - 1e-6) scheduler.productionEnded = true;
        prewarm(time, indices);
      }
    } catch (error: unknown) {
      if (!production.signal.aborted && activeController === controller && !disposed)
        fail(error instanceof Error ? error.message : "预览处理失败");
    } finally {
      activeController.signal.removeEventListener("abort", abort);
      if (productionController === production) productionController = null;
      busy = false;
      if (scheduler.full) producerBackpressured = true;
      decoder?.setRunning(isPlaying.value && !producerBackpressured && !scheduler.productionEnded);
      if (!disposed && !controller.signal.aborted && (firstPending || (isPlaying.value && !scheduler.full && !scheduler.productionEnded)))
        queueMicrotask(() => void pump());
    }
  }

  /** 只在真正开始或缓冲恢复时校准音频，完成帧的处理耗时不进入播放时长。 */
  async function resumeTransport(): Promise<void> {
    if (resuming || !isPlaying.value || !mediaReady.value || !(scheduler.ready || scheduler.productionEnded)) return;
    resuming = true;
    const version = transportVersion;
    const activeController = controller;
    const preparation = new AbortController();
    audioPreparation = preparation;
    const abort = (): void => preparation.abort();
    activeController.signal.addEventListener("abort", abort, { once: true });
    try {
      await audioMixer.prepare(mixerState(), preparation.signal);
      if (disposed || !isPlaying.value || version !== transportVersion || controller !== activeController) return;
      scheduler.resume(performance.now());
      playbackWaiting.value = false;
      playbackState.value = "playing";
      audioMixer.sync(mixerState());
    } catch (error: unknown) {
      if (!preparation.signal.aborted && version === transportVersion && !disposed)
        fail(error instanceof Error ? error.message : "音频准备失败");
    } finally {
      activeController.signal.removeEventListener("abort", abort);
      if (audioPreparation === preparation) audioPreparation = null;
      resuming = false;
    }
  }

  /** RAF 只负责截止时间展示，不能跳过完成帧去追赶现实经过的时间。 */
  function loop(): void {
    if (disposed || !isPlaying.value) return;
    const now = performance.now();
    try {
      if (scheduler.running && !audioMixer.ready(mixerState())) waitForBuffer(now);
      if (!scheduler.running) void resumeTransport();
      const frame = scheduler.takeDue(now);
      if (frame) present(frame);
      if (scheduler.exhausted(now)) {
        if (scheduler.productionEnded) {
          finish();
          return;
        }
        waitForBuffer(now);
      }
      if (scheduler.running) audioMixer.sync(mixerState());
      void pump();
    } catch (error: unknown) {
      fail(error instanceof Error ? error.message : "预览展示失败");
    }
    if (isPlaying.value) raf = requestAnimationFrame(loop);
  }

  /** 视频与音频任一供给不足，共同冻结时钟；生产者仍可填充有限队列。 */
  function waitForBuffer(now: number): void {
    scheduler.freeze(now);
    audioMixer.pauseAll(options.bgmEl.value);
    playbackWaiting.value = true;
    playbackState.value = "buffering";
    previewStats.bufferingCount += 1;
  }

  function startLoop(): void {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
  }

  /** 定位保留旧画面和游标，直到目标帧真正提交；旧 Promise 取消后也能结束。 */
  async function seek(timeSec: number): Promise<void> {
    if (disposed) return;
    transportVersion += 1;
    controller.abort();
    controller = new AbortController();
    settleSeek?.();
    renderGeneration.value += 1;
    audioMixer.pauseAll(options.bgmEl.value);
    decoder?.reset();
    options.renderer.value?.reset();
    produceTime = Math.max(0, Math.min(timeSec, totalDurationSec.value || timeSec));
    scheduler.reset(produceTime, globalPlaybackRate.value);
    producerBackpressured = false;
    firstPending = true;
    mediaReady.value = false;
    playbackWaiting.value = true;
    playbackState.value = "seeking";
    playbackError.value = "";
    const ready = new Promise<void>((resolve) => {
      settleSeek = resolve;
    });
    void pump();
    if (isPlaying.value) startLoop();
    await ready;
  }

  /** 续播复用队列，不重新定位已就绪的两个 video。 */
  async function play(): Promise<void> {
    primePreviewAudioContext();
    if (disposed || isPlaying.value || totalDurationSec.value <= 0) return;
    isPlaying.value = true;
    playbackWaiting.value = true;
    playbackState.value = "preparing";
    transportVersion += 1;
    if (!mediaReady.value || controller.signal.aborted || globalTime.value >= totalDurationSec.value - 1e-6)
      await seek(globalTime.value >= totalDurationSec.value - 1e-6 ? 0 : globalTime.value);
    decoder?.setRunning(!producerBackpressured && !scheduler.productionEnded);
    void pump();
    startLoop();
  }

  /** 用户暂停保持队列，但所有迟到 play/prepare 都必须核对播放意图。 */
  function pause(): void {
    transportVersion += 1;
    productionController?.abort();
    audioPreparation?.abort();
    scheduler.freeze(performance.now());
    isPlaying.value = false;
    playbackWaiting.value = false;
    playbackState.value = "paused";
    decoder?.setRunning(false);
    audioMixer.pauseAll(options.bgmEl.value);
    cancelAnimationFrame(raf);
  }

  /** 完整播完末帧有效区间后收敛到项目终点。 */
  function finish(): void {
    pause();
    playbackState.value = "ended";
    globalTime.value = totalDurationSec.value;
  }

  /** 错误保留最后一次提交的画面，取消生产并结束待处理控制请求。 */
  function fail(message: string): void {
    if (disposed) return;
    pause();
    controller.abort();
    firstPending = false;
    settleSeek?.();
    settleSeek = null;
    playbackState.value = "error";
    playbackError.value = message;
  }

  /** 播放按钮切换用户意图，不把缓冲误认为用户暂停。 */
  function toggle(): void {
    if (isPlaying.value) pause();
    else void play();
  }

  /** 显式跳到片段入点。 */
  async function seekToClip(index: number): Promise<void> {
    if (options.clips.value[index]) await seek(clipStart(index));
  }

  /** 倍速改变后重新建立采样网格和音频位置。 */
  function setPlaybackRate(rate: number): void {
    globalPlaybackRate.value = Number.isFinite(rate) && rate > 0 ? rate : 1;
    void seek(globalTime.value);
  }

  /** 工程配置变化后保持已展示位置重建代次。 */
  async function resync(time = globalTime.value): Promise<void> {
    await seek(time);
  }

  /** 仅刷新音量、静音与音轨结构，不废弃视频队列。 */
  function refreshBgm(): void {
    audioMixer.refresh(mixerState());
  }

  /** DOM 节点或媒体结构首次就绪时准备展示首帧。 */
  function init(): void {
    if (disposed) return;
    refreshBgm();
    void seek(globalTime.value);
  }

  /** 释放本播放器全部媒体、帧所有权与等待，不影响其他播放器。 */
  function destroy(): void {
    if (disposed) return;
    pause();
    disposed = true;
    controller.abort();
    scheduler.reset(globalTime.value, globalPlaybackRate.value);
    decoder?.dispose();
    decoder = null;
    settleSeek?.();
    settleSeek = null;
    audioMixer.destroy(options.bgmEl.value);
  }

  /** 帧循环不走响应式 watch，仅实质性的媒体、效果或布局变化重建代次。 */
  watch(
    () =>
      JSON.stringify([
        options.clips.value.map((clip) => [
          clip.id,
          clip.url,
          clip.durationSec,
          clip.startTime,
          clip.endTime,
          clip.trimStart,
          clip.trimEnd,
          clip.playbackRate,
          clip.beauty,
          clip.adjustments,
        ]),
        options.transitionTrack.value?.transitions,
        options.transitionTrack.value?.clips.map((clip) => [clip.id, readVideoFrameTransform(clip.config)]),
        options.renderConfig?.value,
      ]),
    () => {
      if (!disposed) void resync();
    },
  );
  watch(
    () =>
      JSON.stringify([
        options.audioClips?.value,
        options.config.value,
        options.previewMuted.value,
        options.clips.value.map((clip) => [clip.id, clip.volume, clip.audioDetached]),
      ]),
    refreshBgm,
  );
  watch(options.renderer, () => {
    if (firstPending) void pump();
  });
  onUnmounted(destroy);

  return {
    isPlaying,
    currentIdx,
    globalTime,
    presentedFrameVersion,
    globalPlaybackRate,
    renderGeneration,
    playbackState,
    mediaReady,
    playbackWaiting,
    playbackError,
    inGap,
    presentedSourceSize,
    previewStats,
    totalDurationSec,
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
