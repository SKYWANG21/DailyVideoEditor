import { createPinia, type Pinia } from "pinia";
import { inject, type InjectionKey } from "vue";

/** VideoTrack 子树注入的独立 Pinia，避免多编辑器共用全局 store */
export const CLIP_TRACK_PINIA: InjectionKey<Pinia> = Symbol("clipTrackPinia");

const scopeIds = new WeakMap<Pinia, string>();
let scopeSeq = 0;

/**
 * 为单个时间轴创建 Pinia，并记下缩放设置用的 scope。
 */
export function createClipTrackPinia(): Pinia {
  const pinia = createPinia();
  scopeSeq += 1;
  scopeIds.set(pinia, `ct-${scopeSeq}`);
  return pinia;
}

/** 缩放 localStorage 后缀。未登记的实例共用 default */
export function clipTrackScopeId(pinia: Pinia | null | undefined): string {
  if (!pinia) return "default";
  return scopeIds.get(pinia) ?? "default";
}

/** 子组件读取当前时间轴的 Pinia */
export function useClipTrackPinia(): Pinia {
  const pinia = inject(CLIP_TRACK_PINIA, null);
  if (!pinia) {
    throw new Error("未找到时间轴 Pinia：请在 VideoTrack 内部使用");
  }
  return pinia;
}

/** 卸载时间轴时释放 store 与 effect */
export function disposeClipTrackPinia(pinia: Pinia): void {
  const scoped = pinia as Pinia & {
    _s: Map<string, { $dispose: () => void }>;
    _e?: { stop: () => void };
  };
  scoped._s.forEach((store) => store.$dispose());
  scoped._s.clear();
  scoped._e?.stop();
}
