import type { ComposeTrack, VideoClipItem, VideoComposeClipInput } from "@/types/videoCompose";

/** 片段入参签名：仅 id / 媒体引用变化时触发重载 */
export function buildComposeClipInputsSignature(inputs: VideoComposeClipInput[]): string {
  return inputs
    .map((c) => [c.id, c.taskId ?? "", c.video.url ?? "", c.video.mediaId ?? "", c.video.bizType ?? "", c.video.field ?? ""].join(":"))
    .join("|");
}

/** 去掉 query/hash，避免签名 URL 刷新导致媒体身份误判 */
function normalizeComposeMediaUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  const hashIdx = trimmed.indexOf("#");
  const withoutHash = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
  const queryIdx = withoutHash.indexOf("?");
  return queryIdx >= 0 ? withoutHash.slice(0, queryIdx) : withoutHash;
}

/** 从 clip.config 读取 Step3 taskId（bootstrap 时写入） */
function readClipTaskId(config: unknown): string {
  if (!config || typeof config !== "object") return "";
  const taskId = (config as { taskId?: unknown }).taskId;
  return taskId != null && String(taskId).trim() ? String(taskId).trim() : "";
}

/**
 * 判断持久化主轨媒体是否与当前 clips 入参一致，从而可安全 importTracks。
 * 仅按入参 id 对齐比对；主轨上多出的上传片段不参与判断。
 * 双方 taskId 均非空且相等时视为同片（忽略 URL 漂移）；否则比归一化 URL。
 */
export function mainTrackMatchesClipInputs(tracks: ComposeTrack[] | undefined, inputs: VideoComposeClipInput[]): boolean {
  if (!inputs.length) return false;
  const main =
    (tracks || []).find((t) => t.isMain && t.clips.some((c) => c.type === "video")) ||
    (tracks || []).find((t) => t.type === "video" && t.clips.some((c) => c.type === "video"));
  if (!main) return false;

  const byId = new Map(main.clips.filter((c) => c.type === "video").map((c) => [c.id, c] as const));

  for (const input of inputs) {
    const clip = byId.get(input.id);
    if (!clip || clip.type !== "video") return false;

    const inputTaskId = (input.taskId || "").trim();
    const trackTaskId = readClipTaskId(clip.config);
    if (inputTaskId && trackTaskId) {
      if (inputTaskId !== trackTaskId) return false;
      continue;
    }

    const inputUrl = normalizeComposeMediaUrl(input.video.url || "");
    const trackUrl = normalizeComposeMediaUrl(clip.sourceUrl || "");
    if (!inputUrl || !trackUrl || inputUrl !== trackUrl) return false;
  }
  return true;
}

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

/** 本地只使用已有可播放地址，不请求签名 URL */
async function resolveMediaRef(ref: VideoComposeClipInput["video"], fallbackRawUrl?: string): Promise<string> {
  return (ref.url || fallbackRawUrl || "").trim();
}

/**
 * 将编辑器片段入参解析为可播放的 VideoClipItem 列表。
 * 返回前等待时长探测完成，避免 bootstrap 时仍用占位 0.1s 把片段画成细线。
 */
export async function resolveComposeClips(inputs: VideoComposeClipInput[]): Promise<VideoClipItem[]> {
  const clips: VideoClipItem[] = [];
  for (let idx = 0; idx < inputs.length; idx += 1) {
    const input = inputs[idx];
    const url = await resolveMediaRef(input.video);
    if (!url) continue;
    clips.push({
      id: input.id,
      taskId: input.taskId,
      title: input.title || `片段 ${idx + 1}`,
      url,
      durationSec: 0,
      src: input.poster || "",
    });
  }
  await probeClipDurationsWithRetry(clips);
  return clips;
}
