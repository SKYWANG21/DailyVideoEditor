import { inject, type InjectionKey, type Ref } from "vue";
import { COMPOSE_MEDIA_RESOLVER, createComposeMediaResolver, type ComposeMediaResolver } from "@/service/resolveComposeMediaUrl";
import { createTransitionRegistry } from "@/transitions/catalog";
import type { TransitionRegistry } from "@/transitions/registry";

export { COMPOSE_MEDIA_RESOLVER };

/** 美颜 WASM / 模型的站点根路径，以 / 结尾 */
export const COMPOSE_ALGORITHM_BASE: InjectionKey<Ref<string>> = Symbol("composeAlgorithmBase");

/** 本编辑器固定后端与宿主效果的注册表，供素材目录、时间轴命令、预热和渲染共用。 */
export const COMPOSE_TRANSITION_REGISTRY: InjectionKey<TransitionRegistry> = Symbol("composeTransitionRegistry");

const fallbackResolver = createComposeMediaResolver();

/** 读取编辑器注入的解析器。脱离编辑器时退回进程内默认实例 */
export function useComposeMediaResolver(): ComposeMediaResolver {
  return inject(COMPOSE_MEDIA_RESOLVER, fallbackResolver);
}

/** 独立播放器未注入注册表时保持原有 Canvas 行为。 */
export function useComposeTransitionRegistry(): TransitionRegistry {
  return inject(COMPOSE_TRANSITION_REGISTRY, undefined) ?? createTransitionRegistry();
}
