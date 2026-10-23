import { ref, computed, watch, onUnmounted, type Ref, type ComputedRef } from "vue";
import type { VideoClipItem, ComposeConfig, PreviewAudioClip } from "@/types/videoCompose";
import { findPreviewVideoAtTime } from "@/types/videoCompose";
import { createPreviewAudioMixer, type PreviewAudioMixerSyncState } from "@/hooks/previewAudioMixer";
import { assignResolvedMediaSrc, mediaElementUsesUrl } from "@/service/resolveComposeMediaUrl";
import { useComposeMediaResolver } from "@/editor/composeRuntime";
import { applyPreviewGain, primePreviewAudioContext } from "@/hooks/previewMediaGain";
import { clampGain } from "@/editor/volumeDb";
import { previewSourceTimeUs, previewTimelineSec } from "@/hooks/previewSourceTime";
import { readBeautyParams } from "@/types/composeMedia";

interface UseVideoComposePreviewOptions {
  /** 双缓冲视频 A。美颜关闭时出画并当时钟；打开时只播原声 */
  videoA: { readonly value: HTMLMediaElement | null };
  /** 双缓冲视频 B */
  videoB: { readonly value: HTMLMediaElement | null };
  /** 模板 legacy BGM audio；timeline 多轨由 previewAudioMixer 池播放 */
  bgmEl: Ref<HTMLAudioElement | null>;
  /** 视频片段列表（按 startTime 排序） */
  clips: Ref<VideoClipItem[]>;
  /** 音频轨片段（按全局时间命中混音） */
  audioClips?: Ref<PreviewAudioClip[]>;
  /** 合成参数（响应式 ref，作 volume / legacy BGM 回退） */
  config: Ref<ComposeConfig>;
  /** 预览静音。只把出声增益打成 0，不改片段音量 */
  previewMuted: Ref<boolean>;
}

/** 等待可播帧的超时（毫秒） */
const VIDEO_READY_TIMEOUT_MS = 8000;

/** 距结束多少秒开始预载待命层（时间轴秒） */
const PREPARE_AHEAD_SEC = 0.35;

/** 距结束多少秒执行可见层切换（时间轴秒） */
const SWAP_AHEAD_SEC = 0.08;

/** 判定游标是否处于时间轴末尾（与 reachedClipEnd 容差一致） */
const TIMELINE_END_EPSILON = 0.04;

/** 暂停后恢复：与媒体已对齐则不再 seek，避免关键帧吸附拖动光标 */
const PLAY_RESUME_SEEK_EPSILON = 0.05;

/** 原声允许超前游标的时间（秒）。超过就先停住，等画面 */
const AUDIO_LEAD_SEC = 0.05;

/** 播放中一帧在时间轴上的步长（秒）。1 倍速对应 30fps */
const FRAME_STEP_SEC = 1 / 30;

/** 片段倍速，兜底 1 */
function clipRate(clip: VideoClipItem | undefined): number {
  const r = clip?.playbackRate;
  return r != null && r > 0 ? r : 1;
}

/** 源入点 */
function clipTrimStart(clip: VideoClipItem | undefined): number {
  return Math.max(0, clip?.trimStart ?? 0);
}

/** 源出点：优先 trimEnd，否则按时间轴时长反推 */
function clipTrimEnd(clip: VideoClipItem | undefined): number {
  if (!clip) return 0;
  const start = clipTrimStart(clip);
  if (clip.trimEnd != null && clip.trimEnd > start) return clip.trimEnd;
  return start + (clip.durationSec || 0) * clipRate(clip);
}

/**
 * 视频合成实时预览：按绝对 startTime/endTime 定位 + 双缓冲切段 + 空隙黑屏。
 * 美颜关闭时游标跟活动层 currentTime；打开时只跟已经画出的帧。
 */
export function useVideoComposePreview(options: UseVideoComposePreviewOptions) {
  const { videoA, videoB, bgmEl, clips, previewMuted } = options;
  const composeConfig = options.config;
  const audioClips = options.audioClips;
  const mediaResolver = useComposeMediaResolver();
  const audioMixer = createPreviewAudioMixer(mediaResolver);

  const isPlaying = ref(false);
  /** 作废进行中的异步 play()，避免暂停后旧 play 又把视频拉起 */
  let playGeneration = 0;
  const currentIdx = ref(0);
  const globalTime = ref(0);
  /** 取帧目标（秒）。暂停时等于游标；播放中比已画出的帧超前一个步长 */
  const sampleTime = ref(0);
  /** sampleTime 没变时仍强制再解一帧 */
  const renderGeneration = ref(0);
  /** 工具栏全局倍速（与 clip.playbackRate 相乘） */
  const globalPlaybackRate = ref(1);
  /** 当前可见层：0 = videoA，1 = videoB */
  const activeSlot = ref<0 | 1>(0);
  /** 是否处于无视频覆盖的空隙（黑屏推进游标） */
  const inGap = ref(false);
  /** 从美颜切回视频后，活动层已对齐游标，可以出画 */
  const directVideoAligned = ref(true);
  /** 对齐 seek 迟迟不来时的兜底。0 表示没有在等 */
  let directAlignTimer = 0;

  /** 音频轨 / legacy BGM 在时间轴上的最远终点（秒） */
  function maxAudioTimelineEndSec(): number {
    let maxEnd = 0;
    for (const a of audioClips?.value || []) {
      if (Number.isFinite(a.endTime) && a.endTime > maxEnd) maxEnd = a.endTime;
    }
    if (composeConfig.value.bgm?.url) {
      const bgmEnd = composeConfig.value.bgmStartTime + (composeConfig.value.bgm.durationSec || 0);
      if (bgmEnd > maxEnd) maxEnd = bgmEnd;
    }
    return maxEnd;
  }

  /** 主视频轨在时间轴上的最远终点（秒） */
  function maxVideoTimelineEndSec(): number {
    const list = clips.value;
    if (!list.length) return 0;
    let maxEnd = 0;
    let hasAbs = false;
    for (const c of list) {
      if (c.endTime != null) {
        hasAbs = true;
        maxEnd = Math.max(maxEnd, c.endTime);
      }
    }
    if (hasAbs) return maxEnd;
    return list.reduce((sum, c) => sum + (c.durationSec || 0), 0);
  }

  /** 预览时间轴总长：取视频与音频轨并集，支持无视频纯音轨预览 */
  const totalDurationSec = computed(() => Math.max(maxVideoTimelineEndSec(), maxAudioTimelineEndSec()));

  /** 无视频 clip、仅有音轨/BGM 时的纯音频预览 */
  const isAudioOnlyPreview = computed(() => !clips.value.length && maxAudioTimelineEndSec() > 0);

  const activeVideoEl: ComputedRef<HTMLMediaElement | null> = computed(() => (activeSlot.value === 0 ? videoA.value : videoB.value));

  const standbyVideoEl: ComputedRef<HTMLMediaElement | null> = computed(() => (activeSlot.value === 0 ? videoB.value : videoA.value));

  let rafId = 0;
  let boundVideoEl: HTMLMediaElement | null = null;
  /** 切换片段 / 程序化 seek 时忽略原生 play/pause，避免状态抖动 */
  let suppressMediaEvents = false;
  /** 活动层程序化 currentTime 尚未被 seeked 消费的次数。这些回写不改预览时间 */
  let pendingProgrammaticSeeks = 0;
  /** 空帧后推迟要下一帧的定时器。0 表示没有在等 */
  let missStepTimer = 0;
  /** 为了等画面而暂停原声的次数。这些 pause 不应当成用户暂停 */
  let pendingProgrammaticPauses = 0;
  /** 出帧后把原声拉回游标的 play 次数。不当成用户按下播放 */
  let pendingProgrammaticPlays = 0;
  /** 待命层已准备好的片段索引；-1 表示未就绪 */
  let standbyReadyIdx = -1;
  /** 正在 prepare 的片段索引，避免重复触发 */
  let preparingIdx = -1;
  /** 本轮软切是否已执行，避免 RAF 重复 swap */
  let softSwappedForIdx = -1;
  /** 空隙墙钟起点（performance.now） */
  let gapWallStartMs = 0;
  /** 进入空隙时的全局时间 */
  let gapGlobalStart = 0;

  /** 顺序累加起点（无绝对时间时的回退） */
  function prevDuration(idx: number): number {
    let acc = 0;
    for (let i = 0; i < idx; i += 1) acc += clips.value[i]?.durationSec || 0;
    return acc;
  }

  /** clip 时间轴起点 */
  function clipAbsStart(clip: VideoClipItem | undefined, idx: number): number {
    if (clip?.startTime != null) return clip.startTime;
    return prevDuration(idx);
  }

  /** clip 时间轴终点 */
  function clipAbsEnd(clip: VideoClipItem | undefined, idx: number): number {
    if (clip?.endTime != null) return clip.endTime;
    return clipAbsStart(clip, idx) + (clip?.durationSec || 0);
  }

  /** 列表是否带绝对时间 */
  function hasAbsoluteTimeline(): boolean {
    return clips.value.some((c) => c.startTime != null && c.endTime != null);
  }

  /** 按全局时间解析片段索引；空隙返回 -1 */
  function findClipIndexAtTime(timeSec: number): number {
    const list = clips.value;
    if (!list.length) return -1;
    if (hasAbsoluteTimeline()) {
      const hit = findPreviewVideoAtTime(list, timeSec);
      if (!hit) return -1;
      return list.findIndex((c) => c.id === hit.id);
    }
    let acc = 0;
    for (let i = 0; i < list.length; i += 1) {
      const d = list[i].durationSec || 0;
      if (timeSec < acc + d || i === list.length - 1) return i;
      acc += d;
    }
    return list.length - 1;
  }

  /** 当前片段之后的下一个索引（按列表顺序，已按 startTime 排序） */
  function nextClipIndex(fromIdx: number): number {
    const next = fromIdx + 1;
    return next < clips.value.length ? next : -1;
  }

  /** 有效播放速率 = clipRate * globalRate */
  function effectiveRate(clip: VideoClipItem | undefined): number {
    return clipRate(clip) * (globalPlaybackRate.value > 0 ? globalPlaybackRate.value : 1);
  }

  /**
   * 内嵌 audio 能否当时钟。
   * 还在等元数据时先当作可以，避免无声视频在加载完成前被墙钟抢走。
   */
  function mediaElementCanClock(el: HTMLMediaElement): boolean {
    if (el.error) return false;
    if (el.readyState < HTMLMediaElement.HAVE_METADATA) return true;
    return Number.isFinite(el.duration) && el.duration > 0;
  }

  /** 当前片段美颜总开关。强度为 0 也算打开，预览仍按帧推进 */
  function currentClipBeautyEnabled(): boolean {
    return readBeautyParams(clips.value[currentIdx.value]?.beauty).enabled;
  }

  /** 美颜打开且正在播放：游标只跟已画出的帧，不跟原声或墙钟 */
  function framePacedPlayback(): boolean {
    return isPlaying.value && !inGap.value && !isAudioOnlyPreview.value && clips.value.length > 0 && currentClipBeautyEnabled();
  }

  /** 对齐结束，活动层可以出画 */
  function finishDirectVideoAlign(): void {
    window.clearTimeout(directAlignTimer);
    directAlignTimer = 0;
    directVideoAligned.value = true;
  }

  /** 美颜关掉后如果原声被画面拖停，出画后再继续播 */
  function resumeActiveVideoIfPlaying(media: HTMLMediaElement): void {
    if (!isPlaying.value || !media.paused || inGap.value || currentClipBeautyEnabled()) return;
    pendingProgrammaticPlays += 1;
    void media.play().catch(() => {
      pendingProgrammaticPlays = Math.max(0, pendingProgrammaticPlays - 1);
    });
  }

  /** 对齐完成：先出画，再把被拖停的原声继续播起来 */
  function revealDirectVideo(): void {
    finishDirectVideoAlign();
    const media = activeVideoEl.value;
    if (media) resumeActiveVideoIfPlaying(media);
  }

  /**
   * 从美颜切回视频：把活动层 currentTime 对齐到当前游标，对齐完成后再出画。
   */
  function alignActiveLayerToPlayhead(): void {
    const media = activeVideoEl.value;
    const index = currentIdx.value;
    const clip = clips.value[index];
    if (!media || !clip || inGap.value) {
      finishDirectVideoAlign();
      return;
    }
    const local = Math.max(0, globalTime.value - clipAbsStart(clip, index));
    const sourceTime = timelineOffsetToSource(clip, local);
    const delta = Math.abs((media.currentTime || 0) - sourceTime);
    if (delta <= PLAY_RESUME_SEEK_EPSILON && media.readyState >= HTMLMediaElement.HAVE_METADATA) {
      revealDirectVideo();
      return;
    }
    directVideoAligned.value = false;
    window.clearTimeout(directAlignTimer);
    directAlignTimer = window.setTimeout(revealDirectVideo, 400);
    try {
      assignActiveCurrentTime(media, sourceTime);
    } catch {
      revealDirectVideo();
    }
  }

  /** 美颜关闭时用活动层 currentTime 写游标。还在 seek 或没有元数据时游标停住 */
  function writePlayheadFromActiveVideo(media: HTMLMediaElement): void {
    if (!directVideoAligned.value || media.seeking) return;
    if (media.readyState < HTMLMediaElement.HAVE_METADATA) return;
    if (!mediaElementCanClock(media)) return;
    globalTime.value = computeGlobalFromVideo(media, currentIdx.value);
  }

  /** 下一帧的时间轴步长。工具栏倍速按同样比例放大，1 倍速仍是 1/30 秒 */
  function frameStepSec(): number {
    const rate = globalPlaybackRate.value > 0 ? globalPlaybackRate.value : 1;
    return FRAME_STEP_SEC * rate;
  }

  /** 取消还没发出的空帧续播 */
  function clearMissStep(): void {
    window.clearTimeout(missStepTimer);
    missStepTimer = 0;
  }

  /** 设置取帧目标。时间没变时也加一代，让预览再解一次 */
  function requestSample(timeSec: number): void {
    if (timeSec === sampleTime.value) renderGeneration.value += 1;
    else sampleTime.value = timeSec;
  }

  /** 游标和取帧目标一起放到这个时间轴时刻 */
  function placePlayhead(timeSec: number): void {
    clearMissStep();
    globalTime.value = timeSec;
    requestSample(timeSec);
  }

  /**
   * 再往前一帧的源时间是否仍被夹在同一微秒。
   * 是的话这段已经没有更多画面。
   */
  function clipSourceExhausted(index: number, sourceTimeUs: number): boolean {
    const list = clips.value;
    const timeline = previewTimelineSec(list, index, sourceTimeUs);
    return previewSourceTimeUs(list, index, timeline + frameStepSec()) === sourceTimeUs;
  }

  /** 原声时间轴位置减去游标（秒）。正数表示原声超前 */
  function embeddedAudioLeadSec(): number {
    const media = activeVideoEl.value;
    if (!media) return 0;
    return computeGlobalFromVideo(media, currentIdx.value) - globalTime.value;
  }

  /** 原声超前超过阈值就暂停，等画面追上 */
  function holdEmbeddedAudioIfAhead(): void {
    const media = activeVideoEl.value;
    if (!media || media.paused) return;
    if (embeddedAudioLeadSec() <= AUDIO_LEAD_SEC) return;
    pendingProgrammaticPauses += 1;
    media.pause();
  }

  /** 新帧画上后，原声从游标继续。偏差超过阈值时先对齐再播 */
  function syncEmbeddedAudioToPicture(): void {
    const media = activeVideoEl.value;
    const clip = clips.value[currentIdx.value];
    if (!media || !clip || !framePacedPlayback()) return;
    if (Math.abs(embeddedAudioLeadSec()) > AUDIO_LEAD_SEC) {
      const local = Math.max(0, globalTime.value - clipAbsStart(clip, currentIdx.value));
      try {
        assignActiveCurrentTime(media, timelineOffsetToSource(clip, local));
      } catch {
        /* ignore */
      }
    }
    if (!media.paused) return;
    pendingProgrammaticPlays += 1;
    void media.play().catch(() => {
      pendingProgrammaticPlays = Math.max(0, pendingProgrammaticPlays - 1);
    });
  }

  /**
   * 一帧已经画上。播放中把游标改成这一帧的时间，并再要下一帧。
   * 暂停时的跳转不在这里改游标。
   */
  function onFramePresented(sourceTimeUs: number): void {
    if (!framePacedPlayback()) return;
    clearMissStep();
    const list = clips.value;
    const index = currentIdx.value;
    if (sourceTimeUs !== previewSourceTimeUs(list, index, sampleTime.value)) return;
    const timeline = previewTimelineSec(list, index, sourceTimeUs);
    globalTime.value = timeline;
    if (clipSourceExhausted(index, sourceTimeUs)) {
      advancePastClip(index);
      return;
    }
    requestSample(timeline + frameStepSec());
    syncEmbeddedAudioToPicture();
  }

  /**
   * 这一时刻没有画面。播放中过一帧再要，避免游标停住。
   * 源时间已经到片段末尾时切下一段。
   */
  function onFrameMissed(sourceTimeUs: number): void {
    if (!framePacedPlayback()) return;
    const list = clips.value;
    const index = currentIdx.value;
    if (sourceTimeUs !== previewSourceTimeUs(list, index, sampleTime.value)) return;
    const timeline = previewTimelineSec(list, index, sourceTimeUs);
    if (clipSourceExhausted(index, sourceTimeUs)) {
      clearMissStep();
      globalTime.value = Math.max(globalTime.value, timeline);
      advancePastClip(index);
      return;
    }
    const next = timeline + frameStepSec();
    clearMissStep();
    missStepTimer = window.setTimeout(() => {
      missStepTimer = 0;
      if (!framePacedPlayback()) return;
      if (previewSourceTimeUs(clips.value, currentIdx.value, sampleTime.value) !== sourceTimeUs) return;
      globalTime.value = Math.max(globalTime.value, timeline);
      requestSample(next);
      syncEmbeddedAudioToPicture();
    }, 32);
  }

  /** 开始按帧推进。上一帧已在画面上时，直接要下一帧 */
  function beginFramePace(): void {
    if (!framePacedPlayback()) return;
    requestSample(globalTime.value + frameStepSec());
  }

  /** 源时间 → 片段内时间轴偏移 */
  function sourceToTimelineOffset(clip: VideoClipItem | undefined, sourceSec: number): number {
    const rate = clipRate(clip);
    const trim0 = clipTrimStart(clip);
    return Math.max(0, (sourceSec - trim0) / rate);
  }

  /** 片段内时间轴偏移 → 源时间 */
  function timelineOffsetToSource(clip: VideoClipItem | undefined, offsetSec: number): number {
    return clipTrimStart(clip) + Math.max(0, offsetSec) * clipRate(clip);
  }

  /** 当前活动层源时间推算全局时间轴时间 */
  function computeGlobalFromVideo(v: HTMLMediaElement, idx: number): number {
    const clip = clips.value[idx];
    return clipAbsStart(clip, idx) + sourceToTimelineOffset(clip, v.currentTime || 0);
  }

  function waitForPlayable(v: HTMLMediaElement, timeoutMs = VIDEO_READY_TIMEOUT_MS): Promise<void> {
    if (v.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        v.removeEventListener("canplay", onReady);
        v.removeEventListener("loadeddata", onReady);
        v.removeEventListener("error", onReady);
        window.clearTimeout(timer);
        resolve();
      };
      const onReady = () => {
        if (v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) finish();
      };
      const timer = window.setTimeout(finish, timeoutMs);
      v.addEventListener("canplay", onReady);
      v.addEventListener("loadeddata", onReady);
      v.addEventListener("error", onReady);
    });
  }

  function waitForMetadata(v: HTMLMediaElement, timeoutMs = VIDEO_READY_TIMEOUT_MS): Promise<void> {
    if (v.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        v.removeEventListener("loadedmetadata", onReady);
        v.removeEventListener("error", onReady);
        window.clearTimeout(timer);
        resolve();
      };
      const onReady = () => finish();
      const timer = window.setTimeout(finish, timeoutMs);
      v.addEventListener("loadedmetadata", onReady);
      v.addEventListener("error", onReady);
    });
  }

  function mediaUrlMatches(el: HTMLMediaElement, url: string): boolean {
    if (!url) return false;
    if (el.src === url) return true;
    try {
      return el.src === new URL(url, window.location.href).href;
    } catch {
      return false;
    }
  }

  function urlMatches(v: HTMLMediaElement, url: string): boolean {
    if (mediaUrlMatches(v, url)) return true;
    const peeked = mediaResolver.peek(url);
    return peeked ? mediaElementUsesUrl(v, peeked) : false;
  }

  /** 设置 video 源。跨域先解析成可 CORS 的地址，并打开 anonymous */
  async function applyVideoElementSrc(v: HTMLMediaElement, url: string): Promise<boolean> {
    return assignResolvedMediaSrc(v, url, mediaResolver);
  }

  function unbindVideoEvents(): void {
    if (!boundVideoEl) return;
    boundVideoEl.removeEventListener("ended", onEnded);
    boundVideoEl.removeEventListener("loadedmetadata", onVideoMeta);
    boundVideoEl.removeEventListener("play", onNativePlay);
    boundVideoEl.removeEventListener("pause", onNativePause);
    boundVideoEl.removeEventListener("seeked", onNativeSeeked);
    boundVideoEl = null;
  }

  function bindVideoEvents(v: HTMLMediaElement | null): void {
    if (!v || boundVideoEl === v) return;
    unbindVideoEvents();
    v.addEventListener("ended", onEnded);
    v.addEventListener("loadedmetadata", onVideoMeta);
    v.addEventListener("play", onNativePlay);
    v.addEventListener("pause", onNativePause);
    v.addEventListener("seeked", onNativeSeeked);
    boundVideoEl = v;
  }

  /**
   * 在已绑定 seeked 的活动层上设置源时间。
   * 浏览器稍后的 seeked 常吸到关键帧；时间没变时不会触发 seeked，因此不计数。
   */
  function assignActiveCurrentTime(media: HTMLMediaElement, sourceTime: number): void {
    const willSeek = media.currentTime !== sourceTime;
    if (willSeek) pendingProgrammaticSeeks += 1;
    try {
      media.currentTime = sourceTime;
    } catch (error) {
      if (willSeek) pendingProgrammaticSeeks -= 1;
      throw error;
    }
  }

  /** 分离原声或 volume=0 时强制静音内嵌音轨，原声走独立 audio clip */
  function shouldMuteVideoEmbeddedAudio(clip: VideoClipItem | undefined, vol: number): boolean {
    return clip?.audioDetached === true || vol <= 0;
  }

  /** 应用当前片段音量与有效倍速到指定 video */
  function applyClipMediaParams(v: HTMLMediaElement, clip: VideoClipItem | undefined): void {
    const fallbackVol = clampGain(composeConfig.value.videoVolume);
    const vol = clip?.volume != null && Number.isFinite(clip.volume) ? clampGain(clip.volume) : fallbackVol;
    const muteEmbedded = previewMuted.value || shouldMuteVideoEmbeddedAudio(clip, vol);
    v.muted = muteEmbedded;
    applyPreviewGain(v, muteEmbedded ? 0 : vol);
    v.playbackRate = effectiveRate(clip);
  }

  /** 进入空隙：暂停视频、静音，用墙钟推进 globalTime */
  function enterGap(atTime: number): void {
    inGap.value = true;
    gapGlobalStart = atTime;
    gapWallStartMs = performance.now();
    globalTime.value = atTime;
    const v = activeVideoEl.value;
    if (v) {
      if (!v.paused) pendingProgrammaticPauses += 1;
      suppressMediaEvents = true;
      try {
        v.pause();
        v.muted = true;
      } finally {
        suppressMediaEvents = false;
      }
    }
    softSwappedForIdx = -1;
    standbyReadyIdx = -1;
  }

  function exitGap(): void {
    inGap.value = false;
  }

  /**
   * 在待命层预加载指定片段，不切换可见层。
   * @param localTimeSec 片段内时间轴偏移（非源时间）
   */
  async function prepareStandby(clipIdx: number, localTimeSec = 0): Promise<boolean> {
    const clip = clips.value[clipIdx];
    const standby = standbyVideoEl.value;
    if (!clip?.url || !standby) return false;
    if (standbyReadyIdx === clipIdx && urlMatches(standby, clip.url)) return true;
    if (preparingIdx === clipIdx) return standbyReadyIdx === clipIdx;

    preparingIdx = clipIdx;
    standbyReadyIdx = -1;
    standby.muted = true;
    try {
      const srcChanged = await applyVideoElementSrc(standby, clip.url);
      if (srcChanged || standby.readyState < HTMLMediaElement.HAVE_METADATA) {
        await waitForMetadata(standby);
      }
      const sourceTime = timelineOffsetToSource(clip, localTimeSec);
      try {
        standby.currentTime = sourceTime;
      } catch {
        /* ignore */
      }
      applyClipMediaParams(standby, clip);
      await waitForPlayable(standby);
      if (preparingIdx !== clipIdx) return false;
      standbyReadyIdx = clipIdx;
      return true;
    } finally {
      if (preparingIdx === clipIdx) preparingIdx = -1;
    }
  }

  /**
   * 将待命层升为可见层并播放；旧活动层降为待命并静音暂停。
   */
  async function swapToStandby(nextIdx: number, autoplay: boolean): Promise<void> {
    const next = standbyVideoEl.value;
    const prev = activeVideoEl.value;
    const clip = clips.value[nextIdx];
    if (!next) return;

    exitGap();
    suppressMediaEvents = true;
    try {
      const newSlot: 0 | 1 = activeSlot.value === 0 ? 1 : 0;
      applyClipMediaParams(next, clip);
      if (autoplay) await next.play().catch(() => undefined);

      activeSlot.value = newSlot;
      currentIdx.value = nextIdx;
      if (!framePacedPlayback() && mediaElementCanClock(next)) {
        globalTime.value = computeGlobalFromVideo(next, nextIdx);
      }

      if (prev) {
        prev.pause();
        prev.muted = true;
      }

      bindVideoEvents(next);
      standbyReadyIdx = -1;
      softSwappedForIdx = nextIdx;
    } finally {
      suppressMediaEvents = false;
      if (autoplay && next && !next.paused) {
        isPlaying.value = true;
        startLoop();
        syncBgm();
      } else if (!autoplay) {
        syncBgm();
      }
    }

    const n = nextClipIndex(nextIdx);
    if (n >= 0) {
      void prepareStandby(n);
    }
  }

  /**
   * 在当前活动层加载片段（首帧 / 待命未就绪 fallback）。
   * @param localTimeSec 片段内时间轴偏移
   */
  async function loadOnActive(idx: number, autoplay: boolean, localTimeSec = 0): Promise<void> {
    const v = activeVideoEl.value;
    const clip = clips.value[idx];
    if (!v || !clip) return;
    exitGap();
    bindVideoEvents(v);
    suppressMediaEvents = true;
    try {
      const srcChanged = await applyVideoElementSrc(v, clip.url);
      if (srcChanged || v.readyState < HTMLMediaElement.HAVE_METADATA) {
        await waitForMetadata(v);
      }
      const sourceTime = timelineOffsetToSource(clip, localTimeSec);
      try {
        assignActiveCurrentTime(v, sourceTime);
      } catch {
        /* ignore */
      }
      applyClipMediaParams(v, clip);
      await waitForPlayable(v);
      currentIdx.value = idx;
      placePlayhead(clipAbsStart(clip, idx) + localTimeSec);
      if (autoplay) await v.play().catch(() => undefined);
    } finally {
      suppressMediaEvents = false;
      if (v && !v.paused) {
        isPlaying.value = true;
        startLoop();
        syncBgm();
      }
    }
    softSwappedForIdx = -1;
    const n = nextClipIndex(idx);
    if (n >= 0) {
      void prepareStandby(n);
    }
  }

  /** 跨片段切换：优先待命层准备后 swap，避免可见层换源闪黑 */
  async function switchToClip(idx: number, autoplay: boolean, localTimeSec = 0): Promise<void> {
    const clip = clips.value[idx];
    const active = activeVideoEl.value;
    if (!clip || !active) return;

    const sourceTime = timelineOffsetToSource(clip, localTimeSec);

    // 同片段仅 seek + 刷新音量/倍速
    if (idx === currentIdx.value && !inGap.value && urlMatches(active, clip.url)) {
      exitGap();
      suppressMediaEvents = true;
      try {
        assignActiveCurrentTime(active, sourceTime);
        applyClipMediaParams(active, clip);
        placePlayhead(clipAbsStart(clip, idx) + localTimeSec);
        if (autoplay) await active.play().catch(() => undefined);
      } finally {
        suppressMediaEvents = false;
        if (!active.paused) {
          isPlaying.value = true;
          startLoop();
          syncBgm();
        }
      }
      return;
    }

    const ready = await prepareStandby(idx, localTimeSec);
    if (ready && standbyReadyIdx === idx) {
      await swapToStandby(idx, autoplay);
      const v = activeVideoEl.value;
      if (v) {
        if (Math.abs(v.currentTime - sourceTime) > 0.05) {
          try {
            assignActiveCurrentTime(v, sourceTime);
          } catch {
            /* ignore */
          }
          if (!framePacedPlayback()) placePlayhead(clipAbsStart(clip, idx) + localTimeSec);
        }
        applyClipMediaParams(v, clip);
      }
      return;
    }
    await loadOnActive(idx, autoplay, localTimeSec);
  }

  function syncVolumes(): void {
    if (inGap.value) return;
    const clip = clips.value[currentIdx.value];
    const v = activeVideoEl.value;
    if (v) {
      applyClipMediaParams(v, clip);
    }
    const standby = standbyVideoEl.value;
    if (standby) standby.muted = true;
  }

  /** 组装 mixer 所需的当前播放态 */
  function mixerState(): PreviewAudioMixerSyncState {
    const silent = previewMuted.value;
    const rawClips = audioClips?.value || [];
    return {
      audioClips: silent ? rawClips.map((clip) => ({ ...clip, volume: 0, muted: true })) : rawClips,
      globalTime: globalTime.value,
      isPlaying: isPlaying.value,
      globalPlaybackRate: globalPlaybackRate.value,
      composeConfig: silent ? { ...composeConfig.value, bgmVolume: 0 } : composeConfig.value,
      bgmEl: bgmEl.value,
    };
  }

  /** 按全局时间对齐全部重叠音轨（及 legacy BGM） */
  function syncBgm(): void {
    audioMixer.sync(mixerState());
  }

  /** 时间轴 audio clip 变更后 reconcile 池并重新对齐 */
  function refreshBgm(): void {
    audioMixer.refresh(mixerState());
  }

  /** 游标是否已到当前片段的时间轴终点。不看原声，避免声音先走完把画面截掉 */
  function reachedClipEnd(clip: VideoClipItem | undefined, idx: number): boolean {
    if (!clip) return false;
    return globalTime.value >= clipAbsEnd(clip, idx) - TIMELINE_END_EPSILON;
  }

  /** 到达段尾：下一段 / 空隙 / 结束 */
  function advancePastClip(fromIdx: number): void {
    const clip = clips.value[fromIdx];
    const nextIdx = nextClipIndex(fromIdx);
    if (nextIdx < 0) {
      pause();
      placePlayhead(totalDurationSec.value);
      return;
    }

    const next = clips.value[nextIdx];
    const curEnd = clipAbsEnd(clip, fromIdx);
    const nextStart = clipAbsStart(next, nextIdx);
    // 有空隙则进入 gap，否则直接切段
    if (nextStart > curEnd + 0.02) {
      enterGap(curEnd);
      // 预载下一段
      void prepareStandby(nextIdx);
      return;
    }

    if (standbyReadyIdx === nextIdx) void swapToStandby(nextIdx, true);
    else void switchToClip(nextIdx, true, 0);
  }

  /** RAF：提前 prepare/软切。游标不在这里推进 */
  function tickSoftCut(v: HTMLMediaElement): void {
    const clip = clips.value[currentIdx.value];
    if (!clip || inGap.value) return;

    if (reachedClipEnd(clip, currentIdx.value)) {
      if (suppressMediaEvents) return;
      advancePastClip(currentIdx.value);
      return;
    }

    if (suppressMediaEvents) return;
    const nextIdx = nextClipIndex(currentIdx.value);
    if (nextIdx < 0) return;

    const remain = clipAbsEnd(clip, currentIdx.value) - globalTime.value;

    if (remain <= PREPARE_AHEAD_SEC && standbyReadyIdx !== nextIdx && preparingIdx !== nextIdx) {
      void prepareStandby(nextIdx);
    }

    const nextStart = clipAbsStart(clips.value[nextIdx], nextIdx);
    const curEnd = clipAbsEnd(clip, currentIdx.value);
    // 无缝时才软切；有空隙走 advancePastClip → enterGap
    if (nextStart <= curEnd + 0.02 && remain <= SWAP_AHEAD_SEC && standbyReadyIdx === nextIdx && softSwappedForIdx !== nextIdx) {
      softSwappedForIdx = nextIdx;
      void swapToStandby(nextIdx, true);
    }
  }

  /** 空隙 / 纯音轨预览：墙钟推进 globalTime，音频由 syncBgm 同步 */
  function tickGap(): void {
    if ((!inGap.value && !isAudioOnlyPreview.value) || !isPlaying.value) return;
    if (totalDurationSec.value <= 0) {
      pause();
      return;
    }
    const rate = globalPlaybackRate.value > 0 ? globalPlaybackRate.value : 1;
    const elapsed = ((performance.now() - gapWallStartMs) / 1000) * rate;
    const t = gapGlobalStart + elapsed;
    globalTime.value = t;

    if (totalDurationSec.value > 0 && t >= totalDurationSec.value) {
      pause();
      globalTime.value = totalDurationSec.value;
      return;
    }

    const idx = findClipIndexAtTime(t);
    if (idx >= 0) {
      const clip = clips.value[idx];
      const local = Math.max(0, t - clipAbsStart(clip, idx));
      void switchToClip(idx, true, local);
      return;
    }

    // 预载即将到来的下一段
    const upcoming = clips.value.findIndex((c, i) => clipAbsStart(c, i) > t);
    if (upcoming >= 0 && standbyReadyIdx !== upcoming && preparingIdx !== upcoming) {
      const remain = clipAbsStart(clips.value[upcoming], upcoming) - t;
      if (remain <= PREPARE_AHEAD_SEC) void prepareStandby(upcoming);
    }
  }

  /** 播放循环。美颜打开时等出帧并拦住超前的原声；关掉时游标跟活动层 */
  function loop(): void {
    if (inGap.value || isAudioOnlyPreview.value) {
      tickGap();
    } else if (isPlaying.value) {
      const v = activeVideoEl.value;
      if (v) {
        if (framePacedPlayback()) holdEmbeddedAudioIfAhead();
        else writePlayheadFromActiveVideo(v);
        tickSoftCut(v);
      }
    }
    syncBgm();
    rafId = requestAnimationFrame(loop);
  }

  function startLoop(): void {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(loop);
  }

  /** 游标是否在时间轴末尾（播放结束后再次 play 应从头重播） */
  function isAtTimelineEnd(timeSec: number): boolean {
    const total = totalDurationSec.value;
    return total > 0 && timeSec >= total - TIMELINE_END_EPSILON;
  }

  /** 目标时间是否已与当前视频/空隙时钟对齐（暂停恢复时跳过 seek） */
  function isPlayheadAlignedWithMedia(targetSec: number): boolean {
    if (inGap.value || isAudioOnlyPreview.value) {
      return Math.abs(globalTime.value - targetSec) <= PLAY_RESUME_SEEK_EPSILON;
    }
    const v = activeVideoEl.value;
    const idx = currentIdx.value;
    const clip = clips.value[idx];
    if (!v || !clip || !urlMatches(v, clip.url)) return false;
    return Math.abs(computeGlobalFromVideo(v, idx) - targetSec) <= PLAY_RESUME_SEEK_EPSILON;
  }

  async function play(): Promise<void> {
    primePreviewAudioContext();
    if (totalDurationSec.value <= 0) {
      pause();
      return;
    }
    const resumeFromEnd = !isPlaying.value && isAtTimelineEnd(globalTime.value);
    const gen = ++playGeneration;
    isPlaying.value = true;
    // 仅在「已暂停且处于末尾」时回到起点重播
    if (resumeFromEnd) {
      placePlayhead(0);
      exitGap();
      await seek(0);
    } else if (!isPlayheadAlignedWithMedia(globalTime.value)) {
      await seek(globalTime.value);
    }
    if (gen !== playGeneration) return;
    if (inGap.value || isAudioOnlyPreview.value) {
      if (!inGap.value) enterGap(globalTime.value);
      gapWallStartMs = performance.now();
      gapGlobalStart = globalTime.value;
      startLoop();
      syncBgm();
      return;
    }
    syncVolumes();
    const v = activeVideoEl.value;
    if (v) {
      applyClipMediaParams(v, clips.value[currentIdx.value]);
      await waitForPlayable(v);
      if (gen !== playGeneration) return;
      await v.play().catch(() => undefined);
    }
    if (gen !== playGeneration) {
      activeVideoEl.value?.pause();
      audioMixer.pauseAll(bgmEl.value);
      return;
    }
    startLoop();
    beginFramePace();
  }

  function pause(): void {
    playGeneration += 1;
    clearMissStep();
    isPlaying.value = false;
    sampleTime.value = globalTime.value;
    activeVideoEl.value?.pause();
    audioMixer.pauseAll(bgmEl.value);
    cancelAnimationFrame(rafId);
  }

  function toggle(): void {
    if (isPlaying.value) pause();
    else void play();
  }

  /** 设置工具栏全局倍速，并刷新当前媒体元素 */
  function setPlaybackRate(rate: number): void {
    globalPlaybackRate.value = rate > 0 ? rate : 1;
    if (inGap.value) {
      // 重置空隙墙钟，避免倍速跳变
      gapGlobalStart = globalTime.value;
      gapWallStartMs = performance.now();
    }
    const v = activeVideoEl.value;
    if (v && !inGap.value) applyClipMediaParams(v, clips.value[currentIdx.value]);
    syncBgm();
  }

  function onEnded(): void {
    if (suppressMediaEvents || framePacedPlayback()) return;
    advancePastClip(currentIdx.value);
  }

  function onVideoMeta(): void {
    const v = activeVideoEl.value;
    const clip = clips.value[currentIdx.value];
    if (v && clip && !clip.durationSec && Number.isFinite(v.duration)) clip.durationSec = v.duration;
  }

  function onNativePlay(): void {
    if (pendingProgrammaticPlays > 0) {
      pendingProgrammaticPlays -= 1;
      return;
    }
    if (suppressMediaEvents || inGap.value) return;
    isPlaying.value = true;
    syncVolumes();
    startLoop();
    syncBgm();
  }

  function onNativePause(): void {
    if (pendingProgrammaticPauses > 0) {
      pendingProgrammaticPauses -= 1;
      return;
    }
    if (suppressMediaEvents || inGap.value || framePacedPlayback()) return;
    const active = activeVideoEl.value;
    if (boundVideoEl && active && boundVideoEl !== active) return;
    if (active && !active.paused) return;
    isPlaying.value = false;
    audioMixer.pauseAll(bgmEl.value);
    cancelAnimationFrame(rafId);
  }

  function onNativeSeeked(): void {
    const revealing = !directVideoAligned.value;
    if (pendingProgrammaticSeeks > 0) {
      pendingProgrammaticSeeks -= 1;
      if (revealing) revealDirectVideo();
      return;
    }
    if (revealing) revealDirectVideo();
    if (suppressMediaEvents || inGap.value || framePacedPlayback()) return;
    const v = activeVideoEl.value;
    if (!v) return;
    globalTime.value = computeGlobalFromVideo(v, currentIdx.value);
    syncBgm();
  }

  async function seek(globalSec: number): Promise<void> {
    const total = totalDurationSec.value;
    const t = Math.max(0, Math.min(globalSec, total || globalSec));
    placePlayhead(t);

    const idx = findClipIndexAtTime(t);
    if (idx < 0) {
      // 空隙、纯音轨或末尾之外：墙钟推进 globalTime，音频由 syncBgm 驱动
      enterGap(t);
      syncBgm();
      return;
    }

    const clip = clips.value[idx];
    const localTime = Math.max(0, t - clipAbsStart(clip, idx));
    await switchToClip(idx, isPlaying.value, localTime);
    placePlayhead(t);
    syncBgm();
  }

  async function seekToClip(idx: number): Promise<void> {
    const clip = clips.value[idx];
    if (!clip) return;
    await switchToClip(idx, isPlaying.value, 0);
    placePlayhead(clipAbsStart(clip, idx));
    syncBgm();
  }

  /**
   * 结构/属性变更后按指定（或当前）全局时间重新对齐，保持播放态。
   */
  async function resync(keepGlobalTime?: number): Promise<void> {
    const t = keepGlobalTime != null ? keepGlobalTime : globalTime.value;
    const wasPlaying = isPlaying.value;
    softSwappedForIdx = -1;
    standbyReadyIdx = -1;
    preparingIdx = -1;
    await seek(t);
    if (wasPlaying && !isPlaying.value) {
      isPlaying.value = true;
      if (inGap.value || isAudioOnlyPreview.value) {
        if (!inGap.value) enterGap(globalTime.value);
        gapWallStartMs = performance.now();
        gapGlobalStart = globalTime.value;
        startLoop();
      } else {
        const v = activeVideoEl.value;
        if (v) {
          applyClipMediaParams(v, clips.value[currentIdx.value]);
          await v.play().catch(() => undefined);
        }
        startLoop();
        beginFramePace();
      }
    }
    syncVolumes();
    syncBgm();
  }

  function init(): void {
    standbyReadyIdx = -1;
    preparingIdx = -1;
    softSwappedForIdx = -1;

    const a = videoA.value;
    const b = videoB.value;
    if (clips.value.length && a && b) {
      b.muted = true;
      a.muted = false;
      activeSlot.value = 0;
      exitGap();
      bindVideoEvents(a);
      void seek(globalTime.value);
    } else if (isAudioOnlyPreview.value || maxAudioTimelineEndSec() > 0) {
      unbindVideoEvents();
      void seek(globalTime.value);
    } else {
      exitGap();
    }

    refreshBgm();
    syncVolumes();
  }

  function destroy(): void {
    clearMissStep();
    window.clearTimeout(directAlignTimer);
    directAlignTimer = 0;
    cancelAnimationFrame(rafId);
    unbindVideoEvents();
    videoA.value?.pause();
    videoB.value?.pause();
    audioMixer.destroy(bgmEl.value);
  }

  watch(() => [composeConfig.value.videoVolume, composeConfig.value.bgmVolume], syncVolumes);
  /** 预览静音开关：内嵌原声和音轨一起跟着变，不写回片段音量 */
  watch(previewMuted, () => {
    syncVolumes();
    syncBgm();
  });
  watch(() => composeConfig.value.bgm?.url, refreshBgm);
  /** clips 音量/倍速变更时刷新当前段（结构变更由 Player/Editor 调 resync） */
  watch(
    () =>
      clips.value
        .map((c) => `${c.id}:${c.volume ?? ""}:${c.playbackRate ?? ""}:${c.trimStart ?? ""}:${c.trimEnd ?? ""}:${c.audioDetached ?? ""}`)
        .join("|"),
    () => {
      if (!inGap.value) {
        syncVolumes();
        const v = activeVideoEl.value;
        if (v) applyClipMediaParams(v, clips.value[currentIdx.value]);
      }
    },
  );
  watch(
    () =>
      (audioClips?.value || [])
        .map((c) => `${c.id}:${c.volume}:${c.playbackRate}:${c.startTime}:${c.endTime}:${c.url}:${c.muted ? 1 : 0}`)
        .join("|"),
    () => {
      refreshBgm();
    },
  );

  /** 空隙、暂停、纯音频、美颜关闭时取帧目标跟着游标。美颜播放的步长由出帧回调单独推进 */
  watch(globalTime, (timeSec) => {
    if (framePacedPlayback()) return;
    sampleTime.value = timeSec;
  });

  /** 美颜总开关从开到关时，先把活动层对齐到游标再出画 */
  watch(
    () => currentClipBeautyEnabled(),
    (enabled, prev) => {
      if (prev === true && !enabled) {
        alignActiveLayerToPlayhead();
        return;
      }
      if (enabled) {
        window.clearTimeout(directAlignTimer);
        directAlignTimer = 0;
        directVideoAligned.value = true;
      }
    },
  );

  onUnmounted(destroy);

  return {
    isPlaying,
    currentIdx,
    globalTime,
    sampleTime,
    renderGeneration,
    onFramePresented,
    onFrameMissed,
    totalDurationSec,
    activeSlot,
    activeVideoEl,
    directVideoAligned,
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
