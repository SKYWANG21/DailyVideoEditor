import type { TransitionEffectDefinition, TransitionRegistryOptions } from "@/types/transition";
import { TransitionRegistry } from "./registry";
import { loadWasmTransitionAlgorithm } from "./wasmAdapter";

/** 内置目录只保存描述，具体算法首次使用时加载。 */
export const crossfadeDefinition: TransitionEffectDefinition = {
  id: "crossfade",
  name: "淡化",
  description: "两段画面平滑交叠，总时长保持不变",
  defaultParams: { curve: "linear" },
  normalizeParams(value): Record<string, unknown> {
    const curves = ["linear", "ease", "ease-in", "ease-out", "ease-in-out"];
    return { curve: typeof value.curve === "string" && curves.includes(value.curve) ? value.curve : "linear" };
  },
  load: () => import("./algorithms/crossfade").then((module) => module.crossfadeAlgorithm),
};

/** 固定内置后端并追加宿主效果；算法按需加载，实例之间不共享可变注册状态。 */
export function createTransitionRegistry(options: TransitionRegistryOptions = {}): TransitionRegistry {
  const registry = new TransitionRegistry();
  registry.register(
    options.backend === "wasm"
      ? {
          ...crossfadeDefinition,
          load: () => loadWasmTransitionAlgorithm(new URL("./wasm/crossfade.wasm", import.meta.url)),
        }
      : crossfadeDefinition,
  );
  for (const effect of options.effects ?? []) registry.register(effect);
  return registry;
}
