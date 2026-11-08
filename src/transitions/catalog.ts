import type { TransitionEffectDefinition } from "@/types/transition";
import { TransitionRegistry } from "./registry";

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

/** 实例之间不共享可变注册状态。 */
export function createTransitionRegistry(): TransitionRegistry {
  const registry = new TransitionRegistry();
  registry.register(crossfadeDefinition);
  return registry;
}
