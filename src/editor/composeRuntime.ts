import { inject, type InjectionKey, type Ref } from "vue";
import { COMPOSE_MEDIA_RESOLVER, createComposeMediaResolver, type ComposeMediaResolver } from "@/service/resolveComposeMediaUrl";

export { COMPOSE_MEDIA_RESOLVER };

/** 美颜 WASM / 模型的站点根路径，以 / 结尾 */
export const COMPOSE_ALGORITHM_BASE: InjectionKey<Ref<string>> = Symbol("composeAlgorithmBase");

const fallbackResolver = createComposeMediaResolver();

/** 读取编辑器注入的解析器。脱离编辑器时退回进程内默认实例 */
export function useComposeMediaResolver(): ComposeMediaResolver {
  return inject(COMPOSE_MEDIA_RESOLVER, fallbackResolver);
}
