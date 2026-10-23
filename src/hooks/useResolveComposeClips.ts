import type { VideoClipItem } from "@/types/videoCompose";

/** 占位时长（秒）：addClipToMain 在 metadata 未就绪时使用 */
export const COMPOSE_CLIP_PLACEHOLDER_DURATION_SEC = 0.1;

/** 时长探测同时进行的路数，避免一次创建过多 video 元素 */
const DURATION_PROBE_CONCURRENCY = 3;
/** 单条探测超时（ms）；片段多时 metadata 晚到，过短会把时长写成 0 再按 0.1s 上轴 */
const DURATION_PROBE_TIMEOUT_MS = 8000;
/** 仍占位的 clip 再探轮数（含首轮） */
const DURATION_PROBE_ROUNDS = 3;
/** 轮次间隔（ms），随轮次递增，给解码器喘息 */
const DURATION_PROBE_RETRY_GAP_MS = 500;

/** 是否为尚未探测真实时长的 clip（含占位 0.1） */
export function isComposeClipDurationProbeable(durationSec?: number): boolean {
  return (durationSec ?? 0) <= COMPOSE_CLIP_PLACEHOLDER_DURATION_SEC;
}

/** 读取 video.duration；Infinity / NaN / ≤0 视为未就绪 */
function readFiniteDuration(el: HTMLVideoElement): number {
  const duration = el.duration;
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

/**
 * 异步探测单个视频 URL 的真实时长（秒）。
 * loadedmetadata 时 duration 可能仍是 Infinity/NaN，需等 durationchange，或 seek 逼出真实值。
 * @param url 视频地址
 * @returns 时长；失败或超时仍无有效值时返回 0
 */
export function probeVideoDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    if (!url?.trim()) {
      resolve(0);
      return;
    }
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.muted = true;
    probe.playsInline = true;
    let settled = false;
    const finish = (sec: number) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      probe.ondurationchange = null;
      probe.onloadedmetadata = null;
      probe.ontimeupdate = null;
      probe.onerror = null;
      probe.removeAttribute("src");
      probe.load();
      resolve(sec);
    };
    const tryFinish = () => {
      const duration = readFiniteDuration(probe);
      if (duration > 0) finish(duration);
    };
    const timer = window.setTimeout(() => finish(readFiniteDuration(probe)), DURATION_PROBE_TIMEOUT_MS);
    probe.ondurationchange = tryFinish;
    probe.ontimeupdate = tryFinish;
    probe.onloadedmetadata = () => {
      if (readFiniteDuration(probe) > 0) {
        tryFinish();
        return;
      }
      // 部分浏览器 metadata 时 duration 仍为 Infinity，跳到末尾逼出真实时长
      try {
        probe.currentTime = 1e101;
      } catch {
        // ignore
      }
    };
    probe.onerror = () => finish(0);
    probe.src = url;
  });
}

/**
 * 异步探测单个音频 URL 的真实时长（秒）。
 * @param url 音频地址
 * @returns 时长；失败或超时仍无有效值时返回 0
 */
export function probeAudioDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    if (!url?.trim()) {
      resolve(0);
      return;
    }
    const probe = document.createElement("audio");
    probe.preload = "metadata";
    let settled = false;
    const finish = (sec: number) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      probe.onloadedmetadata = null;
      probe.onerror = null;
      probe.removeAttribute("src");
      probe.load();
      resolve(sec);
    };
    const timer = window.setTimeout(() => {
      const duration = probe.duration;
      finish(Number.isFinite(duration) && duration > 0 ? duration : 0);
    }, DURATION_PROBE_TIMEOUT_MS);
    probe.onloadedmetadata = () => {
      const duration = probe.duration;
      finish(Number.isFinite(duration) && duration > 0 ? duration : 0);
    };
    probe.onerror = () => finish(0);
    probe.src = url;
  });
}

/**
 * 探测各片段时长，供时间轴宽度计算。限流并发，单条超时后继续，避免整批挂死。
 * @param clips 待探测列表（就地写入 durationSec）
 * @param onAllDone 全部结束（成功、失败或超时）后回调
 * @param onClipReady 单条探测到有效时长时回调，便于立刻 rebuild
 */
export function probeClipDurations(clips: VideoClipItem[], onAllDone?: () => void, onClipReady?: (clip: VideoClipItem) => void): void {
  const indices: number[] = [];
  clips.forEach((clip, i) => {
    if (!isComposeClipDurationProbeable(clip.durationSec) || !clip.url) return;
    indices.push(i);
  });
  if (!indices.length) {
    onAllDone?.();
    return;
  }

  let cursor = 0;
  let inflight = 0;
  let remaining = indices.length;

  const doneOne = () => {
    remaining -= 1;
    inflight -= 1;
    if (remaining <= 0) {
      onAllDone?.();
      return;
    }
    pump();
  };

  /** 启动一条探测；完成后腾出槽位再取下一条 */
  const startOne = (i: number) => {
    inflight += 1;
    void probeVideoDuration(clips[i].url).then((duration) => {
      if (duration > 0) {
        clips[i].durationSec = duration;
      }
      if (!isComposeClipDurationProbeable(clips[i].durationSec)) {
        onClipReady?.(clips[i]);
      }
      doneOne();
    });
  };

  const pump = () => {
    while (inflight < DURATION_PROBE_CONCURRENCY && cursor < indices.length) {
      startOne(indices[cursor]);
      cursor += 1;
    }
  };

  pump();
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/**
 * 对仍占位的 clip 多轮探测。片段多、metadata 晚到时避免首轮超时就按 0.1s 上轴。
 * @param clips 待探测列表（就地写入 durationSec）
 * @param onClipReady 单条探测到有效时长时回调
 */
export async function probeClipDurationsWithRetry(clips: VideoClipItem[], onClipReady?: (clip: VideoClipItem) => void): Promise<void> {
  for (let round = 0; round < DURATION_PROBE_ROUNDS; round += 1) {
    const pending = clips.filter((clip) => isComposeClipDurationProbeable(clip.durationSec) && Boolean(clip.url));
    if (!pending.length) return;
    if (round > 0) {
      await delayMs(DURATION_PROBE_RETRY_GAP_MS * round);
    }
    await new Promise<void>((resolve) => {
      probeClipDurations(pending, resolve, onClipReady);
    });
  }
}
