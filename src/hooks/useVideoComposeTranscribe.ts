import { ref, type Ref } from "vue";
import { ElMessage } from "element-plus";
import type { SubtitleItem, VideoClipItem } from "@/types/videoCompose";

/** ASR / 转录接口返回的单条时间戳字幕 */
export interface TranscribeSegment {
  index?: number;
  /** 源视频时间轴起点（秒） */
  start: number;
  /** 源视频时间轴终点（秒） */
  end: number;
  /** 字幕文案 */
  text: string;
}

/** 映射到时间轴后的字幕条目（秒） */
export interface TimelineSubtitleCue {
  /** 时间轴起点（秒） */
  start: number;
  /** 时间轴终点（秒） */
  end: number;
  /** 字幕文案 */
  text: string;
}

/** 丢弃过短字幕的最小时长（秒） */
const MIN_CUE_DURATION_SEC = 0.05;

/**
 * 将 ASR 源时间戳按 clip 的 trim / playbackRate 映射到时间轴，并裁剪到片段窗口。
 * @param clip 主轨视频片段（含 startTime/endTime/trim/rate）
 * @param segments ASR 返回的源时间戳字幕
 * @param fallbackOffset 缺省 startTime 时的时间轴累加起点
 */
export function mapTranscribeSegmentsToTimeline(
  clip: VideoClipItem,
  segments: TranscribeSegment[],
  fallbackOffset = 0,
): TimelineSubtitleCue[] {
  const rate = clip.playbackRate && clip.playbackRate > 0 ? clip.playbackRate : 1;
  const timelineDur = Math.max(0, clip.durationSec || 0);
  const clipStart = clip.startTime ?? fallbackOffset;
  const clipEnd = clip.endTime != null && clip.endTime > clipStart ? clip.endTime : clipStart + timelineDur;
  const trimStart = Math.max(0, clip.trimStart ?? 0);
  const trimEnd = clip.trimEnd != null && clip.trimEnd > trimStart ? clip.trimEnd : trimStart + timelineDur * rate;

  if (clipEnd <= clipStart || trimEnd <= trimStart) return [];

  const mapped: TimelineSubtitleCue[] = [];
  for (const seg of segments || []) {
    const text = (seg.text || "").trim();
    if (!text) continue;

    // 与源内 [trimStart, trimEnd] 求交
    const srcStart = Math.max(seg.start || 0, trimStart);
    const srcEnd = Math.min(seg.end || 0, trimEnd);
    if (srcEnd <= srcStart) continue;

    // 源时间 → 时间轴：clipStart + (src - trimStart) / rate，再夹紧到片段窗口
    let start = clipStart + (srcStart - trimStart) / rate;
    let end = clipStart + (srcEnd - trimStart) / rate;
    start = Math.max(clipStart, Math.min(clipEnd, start));
    end = Math.max(clipStart, Math.min(clipEnd, end));
    if (end - start < MIN_CUE_DURATION_SEC) continue;

    mapped.push({ start, end, text });
  }

  mapped.sort((a, b) => a.start - b.start);

  // 相邻轻微重叠时收束前一条 end，避免同轨叠块
  for (let i = 0; i < mapped.length - 1; i += 1) {
    const curr = mapped[i];
    const next = mapped[i + 1];
    if (curr.end > next.start) {
      curr.end = Math.max(curr.start, Math.min(curr.end, next.start));
    }
  }

  return mapped.filter((c) => c.end - c.start >= MIN_CUE_DURATION_SEC);
}

interface UseVideoComposeTranscribeOptions {
  clips: Ref<VideoClipItem[]>;
  subtitles: Ref<SubtitleItem[][]>;
}

/** 视频字幕转录：单片段 / 全片段 */
export function useVideoComposeTranscribe(_options: UseVideoComposeTranscribeOptions) {
  const isTranscribing = ref(false);

  /** 本地不请求转录 */
  async function transcribeClip(_clipIdx: number): Promise<void> {
    ElMessage.info("暂无");
  }

  /** 本地不请求转录 */
  async function transcribeAllClips(): Promise<void> {
    ElMessage.info("暂无");
  }

  return { isTranscribing, transcribeClip, transcribeAllClips };
}
