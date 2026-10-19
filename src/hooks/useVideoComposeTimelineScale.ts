import { computed, type Ref } from "vue";

export const PX_PER_SEC = 40;

const MIN_TRACK_WIDTH_PX = 1200;
const TICK_STEP_SEC = 2;

export interface TimelineTick {
  leftPx: number;
  label: string;
}

export function formatClock(totalSec: number): string {
  const safe = Math.max(0, Math.floor(totalSec || 0));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function parseClock(mmss: string): number {
  const [m, s] = (mmss || "00:00").split(":");
  const min = Math.max(0, parseInt(m, 10) || 0);
  const sec = Math.max(0, parseInt(s, 10) || 0);
  return min * 60 + sec;
}

export interface SubtitleClockParts {
  min: string;
  sec: string;
  ms: string;
}

export function formatSubtitleClock(totalSec: number): string {
  const safe = Math.max(0, totalSec || 0);
  const totalMs = Math.round(safe * 1000);
  const m = Math.floor(totalMs / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

export function parseSubtitleClock(clock: string): number {
  const normalized = clock || "00:00.000";
  const dotIdx = normalized.indexOf(".");
  const timePart = dotIdx >= 0 ? normalized.slice(0, dotIdx) : normalized;
  const msPart = dotIdx >= 0 ? normalized.slice(dotIdx + 1) : "0";
  const [m, s] = timePart.split(":");
  const min = Math.max(0, parseInt(m, 10) || 0);
  const sec = Math.max(0, parseInt(s, 10) || 0);
  const ms = Math.max(0, Math.min(999, parseInt(msPart.replace(/\D/g, "").slice(0, 3), 10) || 0));
  return min * 60 + sec + ms / 1000;
}

export function splitSubtitleClock(clock: string): SubtitleClockParts {
  const normalized = clock || "00:00.000";
  const dotIdx = normalized.indexOf(".");
  const timePart = dotIdx >= 0 ? normalized.slice(0, dotIdx) : normalized;
  const msPart = dotIdx >= 0 ? normalized.slice(dotIdx + 1) : "000";
  const [m, s] = timePart.split(":");
  return {
    min: (m || "00").padStart(2, "0").slice(-2),
    sec: (s || "00").padStart(2, "0").slice(-2),
    ms: (msPart || "000").replace(/\D/g, "").padStart(3, "0").slice(0, 3),
  };
}

/** 字幕时间拆分为可编辑片段（不补零，供输入框绑定） */
export function splitSubtitleClockEditable(clock: string): SubtitleClockParts {
  const normalized = clock || "00:00.000";
  const dotIdx = normalized.indexOf(".");
  const timePart = dotIdx >= 0 ? normalized.slice(0, dotIdx) : normalized;
  const msPart = dotIdx >= 0 ? normalized.slice(dotIdx + 1) : "000";
  const [m, s] = timePart.split(":");
  return {
    min: (m ?? "").replace(/\D/g, ""),
    sec: (s ?? "").replace(/\D/g, ""),
    ms: (msPart ?? "").replace(/\D/g, "").slice(0, 3),
  };
}

/** 将可编辑片段拼接为字幕时钟字符串（不补零） */
export function joinSubtitleClockParts(parts: SubtitleClockParts): string {
  return `${parts.min}:${parts.sec}.${parts.ms}`;
}

/** 将字幕时钟规范化为 MM:SS.mmm */
export function normalizeSubtitleClock(clock: string): string {
  return formatSubtitleClock(parseSubtitleClock(clock));
}

export function useVideoComposeTimelineScale(totalDurationSec: Ref<number>) {
  const pxPerSec = PX_PER_SEC;

  const trackWidthPx = computed(() => Math.max(totalDurationSec.value * pxPerSec, MIN_TRACK_WIDTH_PX));

  const ticks = computed<TimelineTick[]>(() => {
    const result: TimelineTick[] = [];
    const totalPx = trackWidthPx.value;
    for (let sec = 0; sec * pxPerSec <= totalPx; sec += TICK_STEP_SEC) {
      result.push({ leftPx: sec * pxPerSec, label: formatClock(sec) });
    }
    return result;
  });

  const secToPx = (sec: number): number => sec * pxPerSec;
  const pxToSec = (px: number): number => px / pxPerSec;

  return { pxPerSec, trackWidthPx, ticks, secToPx, pxToSec };
}
