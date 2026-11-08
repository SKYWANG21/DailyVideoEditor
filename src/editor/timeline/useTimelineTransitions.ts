import { ref, type Ref } from "vue";
import { ElMessage } from "element-plus";
import type { Track } from "@/clip-track";
import type { ComposeTransition, TransitionSeam } from "@/types/transition";
import { createTransitionRegistry } from "@/transitions/catalog";
import { MIN_TRANSITION_DURATION, resolveTransitionSeams, resolveTransitionTarget } from "@/transitions/timing";

/** 通过时间轴公开命令写入，复用现有历史。 */
interface TransitionTimelineApi {
  /** 当前主轨。 */
  getMainTrack(): Track | undefined;
  /** 当前选择。 */
  getSelectedClipIds(): string[];
  /** 当前播放头。 */
  getCurrentTime(): number;
  /** 写入轨道并生成历史。 */
  updateTrack(id: string, updates: Partial<Track>): void;
}

/** 转场命令与双击目标解析。 */
export function useTimelineTransitions(
  apiRef: Ref<TransitionTimelineApi | null>,
  readonly: Ref<boolean>,
  changed: () => void,
  applied: () => void,
) {
  const selectedSeamKey = ref<string | null>(null);
  const registry = createTransitionRegistry();

  /** 命令执行时重新检查接缝，浮层打开期间的旧布局不能直接写回。 */
  function apply(effectId: string, key?: string, durationSec?: number): void {
    const api = apiRef.value;
    const track = api?.getMainTrack();
    if (!api || !track || readonly.value || track.locked) return;
    const definition = registry.get(effectId);
    if (!definition) return;
    const seams = resolveTransitionSeams(track.clips, track.transitions);
    const target = key
      ? seams.find((seam) => seam.key === key)
      : resolveTransitionTarget(seams, selectedSeamKey.value, api.getSelectedClipIds(), api.getCurrentTime());
    if (!target) {
      ElMessage.warning("请选择主视频轨的相邻片段或接缝，再添加转场");
      return;
    }
    const existing = target.transition;
    const transition: ComposeTransition = {
      id: existing?.id ?? crypto.randomUUID(),
      clipAId: target.clipA.id,
      clipBId: target.clipB.id,
      effectId,
      durationSec: Math.max(MIN_TRANSITION_DURATION, Math.min(target.maxDuration, durationSec ?? existing?.durationSec ?? 1)),
      params: definition.normalizeParams(existing?.effectId === effectId ? existing.params : definition.defaultParams),
    };
    api.updateTrack(track.id, {
      transitions: [
        ...(track.transitions ?? []).filter((item) => item.clipAId !== transition.clipAId || item.clipBId !== transition.clipBId),
        transition,
      ],
    });
    selectedSeamKey.value = target.key;
    changed();
    applied();
  }

  /** 删除元数据，不挪动片段或播放头。 */
  function remove(seam: TransitionSeam): void {
    const api = apiRef.value;
    const track = api?.getMainTrack();
    if (!api || !track || readonly.value || track.locked) return;
    api.updateTrack(track.id, {
      transitions: (track.transitions ?? []).filter((item) => item.clipAId !== seam.clipA.id || item.clipBId !== seam.clipB.id),
    });
    changed();
  }
  return { selectedSeamKey, apply, remove };
}
