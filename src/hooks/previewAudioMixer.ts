import { findPreviewAudiosAtTime, type ComposeConfig, type PreviewAudioClip } from "@/types/videoCompose";
import { applyPreviewGain } from "@/hooks/previewMediaGain";

/** 暂停/scrub 时强制 seek 的偏差阈值（秒） */
const AUDIO_SYNC_TOLERANCE_SCRUB = 0.05;

/** 播放中允许音视频时钟自然漂移，超过才强制 seek（秒） */
const AUDIO_SYNC_TOLERANCE_PLAYING = 0.25;

/** 距 clip 入点多少秒开始预 seek 待命元素（与视频 PREPARE_AHEAD_SEC 对齐） */
const AUDIO_PREPARE_AHEAD_SEC = 0.35;

/** seek 锁兜底超时，防止 seeked 未触发导致永久无法纠偏 */
const SEEK_LOCK_TIMEOUT_MS = 2000;

/** mixer.sync / refresh 所需的播放态快照 */
export interface PreviewAudioMixerSyncState {
  /** 时间轴音频 clip（可为空，空时走 legacy BGM） */
  audioClips: PreviewAudioClip[];
  /** 当前全局时间（秒） */
  globalTime: number;
  /** 是否正在播放 */
  isPlaying: boolean;
  /** 工具栏全局倍速 */
  globalPlaybackRate: number;
  /** 合成参数（legacy BGM 回退） */
  composeConfig: ComposeConfig;
  /** 模板里的 legacy BGM 元素 */
  bgmEl: HTMLAudioElement | null;
}

export interface PreviewAudioMixer {
  /** 按全局时间对齐池内各轨；无 timeline clip 时驱动 legacy BGM */
  sync: (state: PreviewAudioMixerSyncState) => void;
  /** 暂停池 + bgmEl，不卸源 */
  pauseAll: (bgmEl: HTMLAudioElement | null) => void;
  /** 按 clip 列表 reconcile 池后 sync */
  refresh: (state: PreviewAudioMixerSyncState) => void;
  /** 卸载全部池元素与 bgmEl */
  destroy: (bgmEl: HTMLAudioElement | null) => void;
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

/** 暂停并卸 src，避免残留可播文件 */
function unloadAudioEl(el: HTMLAudioElement): void {
  el.pause();
  el.removeAttribute("src");
  el.load();
}

function createPoolAudio(): HTMLAudioElement {
  const el = new Audio();
  el.crossOrigin = "anonymous";
  el.preload = "auto";
  return el;
}

/** 值变化才写增益/playbackRate，避免每帧赋值引起音轨抖动 */
function applyPlaybackParams(el: HTMLAudioElement, volume: number, rate: number): void {
  applyPreviewGain(el, volume);
  const playbackRate = rate > 0 ? rate : 1;
  if (el.playbackRate !== playbackRate) el.playbackRate = playbackRate;
}

/** clip 在全局时间对应的源时间 */
function clipSourceTime(clip: PreviewAudioClip, globalTime: number): number {
  const timelineOffset = globalTime - clip.startTime;
  return clip.trimStart + timelineOffset * clip.playbackRate;
}

/** 即将入点、需预 seek 的 clip（不含已命中） */
function findUpcomingAudios(audios: PreviewAudioClip[], globalTime: number): PreviewAudioClip[] {
  return audios.filter((a) => {
    if (a.muted) return false;
    const remain = a.startTime - globalTime;
    return remain > 0 && remain <= AUDIO_PREPARE_AHEAD_SEC;
  });
}

/**
 * 写 currentTime 期间加锁，避免 rAF 连环 seek。
 */
function createSeekLock(): {
  trySeek: (el: HTMLAudioElement, target: number, tolerance: number) => void;
  unlock: (el: HTMLAudioElement) => void;
  clearAll: () => void;
} {
  const locked = new Set<HTMLAudioElement>();
  const timers = new Map<HTMLAudioElement, number>();
  const listeners = new Map<HTMLAudioElement, { seeked: () => void; error: () => void }>();

  const unlock = (el: HTMLAudioElement): void => {
    const timer = timers.get(el);
    if (timer != null) window.clearTimeout(timer);
    timers.delete(el);
    const pair = listeners.get(el);
    if (pair) {
      el.removeEventListener("seeked", pair.seeked);
      el.removeEventListener("error", pair.error);
      listeners.delete(el);
    }
    locked.delete(el);
  };

  const isLocked = (el: HTMLAudioElement): boolean => el.seeking || locked.has(el);

  const trySeek = (el: HTMLAudioElement, target: number, tolerance: number): void => {
    const t = Math.max(0, target);
    if (Math.abs((el.currentTime || 0) - t) <= tolerance) return;
    if (isLocked(el)) return;
    const seeked = (): void => unlock(el);
    const error = (): void => unlock(el);
    locked.add(el);
    listeners.set(el, { seeked, error });
    el.addEventListener("seeked", seeked);
    el.addEventListener("error", error);
    timers.set(
      el,
      window.setTimeout(() => unlock(el), SEEK_LOCK_TIMEOUT_MS),
    );
    try {
      el.currentTime = t;
      if (!el.seeking) unlock(el);
    } catch {
      unlock(el);
    }
  };

  const clearAll = (): void => {
    for (const el of [...locked]) unlock(el);
  };

  return { trySeek, unlock, clearAll };
}

/**
 * 预览音频混音器：按 clip.id 持有 HTMLAudioElement 池，重叠轨同时播放。
 * 切 clip 前预 seek 下一段，交界先 play 再 pause 旧段。
 * legacy composeConfig.bgm 仍走传入的 bgmEl。
 */
export function createPreviewAudioMixer(): PreviewAudioMixer {
  const pool = new Map<string, HTMLAudioElement>();
  const seekLock = createSeekLock();

  function ensureClipAudio(clip: PreviewAudioClip): HTMLAudioElement {
    let el = pool.get(clip.id);
    if (!el) {
      el = createPoolAudio();
      pool.set(clip.id, el);
    }
    if (!mediaUrlMatches(el, clip.url)) {
      seekLock.unlock(el);
      el.src = clip.url;
    }
    return el;
  }

  function pausePool(): void {
    for (const el of pool.values()) {
      if (!el.paused) el.pause();
    }
  }

  /** 删除已不在列表中的池元素，并为新 clip 预载 */
  function reconcile(clips: PreviewAudioClip[]): void {
    const ids = new Set(clips.map((c) => c.id));
    for (const [id, el] of pool) {
      if (ids.has(id)) continue;
      seekLock.unlock(el);
      unloadAudioEl(el);
      pool.delete(id);
    }
    for (const clip of clips) {
      ensureClipAudio(clip);
    }
  }

  /** 下一段入点前预 seek 到 trimStart，保持 pause */
  function prepareUpcoming(clip: PreviewAudioClip, globalRate: number): void {
    const el = ensureClipAudio(clip);
    applyPlaybackParams(el, clip.volume, clip.playbackRate * (globalRate > 0 ? globalRate : 1));
    seekLock.trySeek(el, clip.trimStart, AUDIO_SYNC_TOLERANCE_SCRUB);
  }

  /**
   * 命中 clip：播放中宽纠偏；已预卷到位则只 play。
   * muted 只暂停，不改 currentTime。
   */
  function syncHit(hit: PreviewAudioClip, globalTime: number, isPlaying: boolean, globalRate: number): void {
    const el = ensureClipAudio(hit);
    const target = clipSourceTime(hit, globalTime);
    const audible = isPlaying && !hit.muted && globalTime >= hit.startTime && globalTime < hit.endTime;
    applyPlaybackParams(el, hit.volume, hit.playbackRate * (globalRate > 0 ? globalRate : 1));
    const tolerance = isPlaying ? AUDIO_SYNC_TOLERANCE_PLAYING : AUDIO_SYNC_TOLERANCE_SCRUB;
    seekLock.trySeek(el, target, tolerance);
    if (!audible) {
      if (!el.paused) el.pause();
      return;
    }
    if (el.paused) el.play().catch(() => undefined);
  }

  function syncLegacyBgm(
    bgmEl: HTMLAudioElement | null,
    composeConfig: ComposeConfig,
    globalTime: number,
    isPlaying: boolean,
    globalRate: number,
  ): void {
    const a = bgmEl;
    if (!a) return;
    if (!composeConfig.bgm) {
      seekLock.unlock(a);
      unloadAudioEl(a);
      return;
    }
    if (!mediaUrlMatches(a, composeConfig.bgm.url)) {
      seekLock.unlock(a);
      a.crossOrigin = "anonymous";
      a.src = composeConfig.bgm.url;
    }
    const target = globalTime - composeConfig.bgmStartTime + composeConfig.bgmSourceStartTime;
    const dur = a.duration || composeConfig.bgm.durationSec || 0;
    const audible = isPlaying && globalTime >= composeConfig.bgmStartTime && target >= 0 && (dur === 0 || target < dur);
    applyPlaybackParams(a, composeConfig.bgmVolume, globalRate);
    if (!audible) {
      if (!a.paused) a.pause();
      return;
    }
    const tolerance = isPlaying ? AUDIO_SYNC_TOLERANCE_PLAYING : AUDIO_SYNC_TOLERANCE_SCRUB;
    seekLock.trySeek(a, target, tolerance);
    if (a.paused) a.play().catch(() => undefined);
  }

  /** 先 play 命中，再 pause 离开的；upcoming 保持预卷不被 pause */
  function syncPool(state: PreviewAudioMixerSyncState): void {
    const { audioClips, globalTime, isPlaying, globalPlaybackRate } = state;
    const hits = findPreviewAudiosAtTime(audioClips, globalTime);
    const upcoming = findUpcomingAudios(audioClips, globalTime);
    const keepIds = new Set([...hits, ...upcoming].map((c) => c.id));

    for (const clip of upcoming) {
      prepareUpcoming(clip, globalPlaybackRate);
    }
    for (const hit of hits) {
      syncHit(hit, globalTime, isPlaying, globalPlaybackRate);
    }
    for (const [id, el] of pool) {
      if (keepIds.has(id) || el.paused) continue;
      el.pause();
    }
  }

  function sync(state: PreviewAudioMixerSyncState): void {
    const { audioClips, globalTime, isPlaying, globalPlaybackRate, composeConfig, bgmEl } = state;
    if (audioClips.length) {
      if (bgmEl && !bgmEl.paused) bgmEl.pause();
      syncPool(state);
      return;
    }
    pausePool();
    syncLegacyBgm(bgmEl, composeConfig, globalTime, isPlaying, globalPlaybackRate);
  }

  function pauseAll(bgmEl: HTMLAudioElement | null): void {
    pausePool();
    if (bgmEl && !bgmEl.paused) bgmEl.pause();
    seekLock.clearAll();
  }

  function refresh(state: PreviewAudioMixerSyncState): void {
    reconcile(state.audioClips);
    if (!state.audioClips.length) {
      const a = state.bgmEl;
      const url = state.composeConfig.bgm?.url;
      if (a && url && !mediaUrlMatches(a, url)) {
        seekLock.unlock(a);
        a.src = url;
      } else if (a && !url) {
        seekLock.unlock(a);
        unloadAudioEl(a);
      }
    } else if (state.bgmEl && !state.bgmEl.paused) {
      state.bgmEl.pause();
    }
    sync(state);
  }

  function destroy(bgmEl: HTMLAudioElement | null): void {
    seekLock.clearAll();
    for (const el of pool.values()) {
      unloadAudioEl(el);
    }
    pool.clear();
    if (bgmEl) unloadAudioEl(bgmEl);
  }

  return { sync, pauseAll, refresh, destroy };
}
