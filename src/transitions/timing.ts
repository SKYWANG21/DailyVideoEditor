import type { ComposeTransition, TransitionClipRef, TransitionSample, TransitionSeam } from "@/types/transition";

/** 与编辑器采样帧率一致的最小转场时长。 */
export const MIN_TRANSITION_DURATION = 1 / 30;
/** 跨组件拖放只传效果 ID，不携带可执行代码。 */
export const TRANSITION_DRAG_MIME = "application/x-compose-transition";

/** 查找相邻视频；间隙、重叠或中间存在其他片段时不构成接缝。 */
export function resolveTransitionSeams(
  clips: readonly TransitionClipRef[],
  transitions: readonly ComposeTransition[] = [],
): TransitionSeam[] {
  const sorted = [...clips].filter((clip) => clip.type !== "transition").sort((a, b) => a.startTime - b.startTime);
  const seams: TransitionSeam[] = [];
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const clipA = sorted[index];
    const clipB = sorted[index + 1];
    if (clipA.type !== "video" || clipB.type !== "video" || Math.abs(clipA.endTime - clipB.startTime) > 0.001) continue;
    const maxDuration = Math.min(5, clipA.endTime - clipA.startTime, clipB.endTime - clipB.startTime);
    if (!Number.isFinite(maxDuration) || maxDuration < MIN_TRANSITION_DURATION) continue;
    seams.push({
      key: JSON.stringify([clipA.id, clipB.id]),
      clipA,
      clipB,
      cut: (clipA.endTime + clipB.startTime) / 2,
      maxDuration,
      transition: transitions.find((item) => item.clipAId === clipA.id && item.clipBId === clipB.id),
    });
  }
  return seams;
}

/** 只在完整编辑事务结束后清理失效关联，避免拖动中间态误删转场。 */
export function normalizeTrackTransitions(
  clips: readonly TransitionClipRef[],
  transitions: readonly ComposeTransition[] = [],
): ComposeTransition[] {
  return resolveTransitionSeams(clips, transitions).flatMap((seam) => {
    const item = seam.transition;
    if (!item || !item.id || !item.effectId) return [];
    const duration = Number.isFinite(item.durationSec) ? item.durationSec : 1;
    return [
      {
        ...item,
        durationSec: Math.max(MIN_TRANSITION_DURATION, Math.min(seam.maxDuration, duration)),
        params: item.params && typeof item.params === "object" ? { ...item.params } : {},
      },
    ];
  });
}

/** 用半开窗口命中，连续转场交界点只会归属于一个窗口。 */
export function resolveTransitionAtTime(
  clips: readonly TransitionClipRef[],
  transitions: readonly ComposeTransition[],
  time: number,
): TransitionSample | null {
  for (const seam of resolveTransitionSeams(clips, normalizeTrackTransitions(clips, transitions))) {
    if (!seam.transition) continue;
    const duration = seam.transition.durationSec;
    const start = seam.cut - duration / 2;
    const end = seam.cut + duration / 2;
    if (time >= start && time < end) return { ...seam, transition: seam.transition, start, end, progress: (time - start) / duration };
  }
  return null;
}

/** 双击素材的目标优先级：接缝、双选、单选相邻，再到播放头附近。 */
export function resolveTransitionTarget(
  seams: readonly TransitionSeam[],
  selectedKey: string | null,
  selectedIds: readonly string[],
  time: number,
): TransitionSeam | undefined {
  const explicit = seams.find((seam) => seam.key === selectedKey);
  if (explicit) return explicit;
  if (selectedIds.length > 1) {
    return selectedIds.length === 2
      ? seams.find((seam) => selectedIds.includes(seam.clipA.id) && selectedIds.includes(seam.clipB.id))
      : undefined;
  }
  if (selectedIds.length === 1) {
    return seams.find((seam) => seam.clipA.id === selectedIds[0]) ?? seams.find((seam) => seam.clipB.id === selectedIds[0]);
  }
  return [...seams].sort((a, b) => Math.abs(a.cut - time) - Math.abs(b.cut - time)).find((seam) => Math.abs(seam.cut - time) <= 0.1);
}
