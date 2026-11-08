import type { VideoClipItem } from "@/types/videoCompose";

/**
 * 片段在时间轴上的起点（秒）。
 * 有 startTime 用绝对值，否则按前面片段时长累加。与预览时钟一致。
 */
export function previewClipStartSec(clips: VideoClipItem[], index: number): number {
  const clip = clips[index];
  if (clip?.startTime != null) return clip.startTime;
  let acc = 0;
  for (let i = 0; i < index; i += 1) acc += clips[i]?.durationSec || 0;
  return acc;
}

/**
 * 全局时间轴时间换成源内时间（微秒），供活动 video 定位和快照校验。
 * @param clips 当前播放列表
 * @param index 当前片段下标
 * @param globalTimeSec 时间轴时间（秒）
 */
export function previewSourceTimeUs(clips: VideoClipItem[], index: number, globalTimeSec: number): number {
  const clip = clips[index];
  if (!clip) return 0;
  const rate = clip.playbackRate != null && clip.playbackRate > 0 ? clip.playbackRate : 1;
  const trim = Math.max(0, clip.trimStart ?? 0);
  const local = Math.max(0, globalTimeSec - previewClipStartSec(clips, index));
  const sourceSec = trim + local * rate;
  const trimEnd = clip.trimEnd != null && clip.trimEnd > trim ? clip.trimEnd : trim + (clip.durationSec || 0) * rate;
  return Math.max(0, Math.round(Math.min(sourceSec, trimEnd) * 1e6));
}

/** 实际解码使用出点之前的有效像素，逻辑采样身份仍使用精确出点。 */
export function previewSeekTimeSec(clips: VideoClipItem[], index: number, globalTimeSec: number): number {
  const clip = clips[index];
  if (!clip) return 0;
  const trim = Math.max(0, clip.trimStart ?? 0);
  const end = clip.trimEnd ?? trim + clip.durationSec * (clip.playbackRate || 1);
  return Math.min(previewSourceTimeUs(clips, index, globalTimeSec) / 1e6, Math.max(trim, end - 0.001));
}

/**
 * 源时间（微秒）换回时间轴秒数，是 previewSourceTimeUs 的反函数。
 * @param clips 当前播放列表
 * @param index 当前片段下标
 * @param sourceTimeUs 源时间（微秒）
 */
export function previewTimelineSec(clips: VideoClipItem[], index: number, sourceTimeUs: number): number {
  const clip = clips[index];
  if (!clip) return 0;
  const rate = clip.playbackRate != null && clip.playbackRate > 0 ? clip.playbackRate : 1;
  const trim = Math.max(0, clip.trimStart ?? 0);
  const sourceSec = Math.max(0, sourceTimeUs / 1e6);
  const local = Math.max(0, (sourceSec - trim) / rate);
  return previewClipStartSec(clips, index) + local;
}
