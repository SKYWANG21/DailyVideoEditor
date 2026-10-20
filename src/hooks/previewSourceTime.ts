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
 * 全局时间轴时间换成源内时间（微秒），供 WebCodecs 取帧。
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
