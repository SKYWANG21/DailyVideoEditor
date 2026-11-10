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

/** 内置效果的 Canvas 定义；创建注册表时可选择同 ID 的独立 WASM 实现。 */
const canvasDefinitions: readonly TransitionEffectDefinition[] = [
  {
    ...crossfadeDefinition,
    id: "zoom-in",
    name: "推进",
    description: "离场画面放大至两倍，入场画面从半倍同步拉近至原比例",
    load: () => import("./algorithms/zoom").then((module) => module.zoomInAlgorithm),
  },
  {
    ...crossfadeDefinition,
    id: "fade-black",
    name: "淡入淡出",
    description: "前一画面淡出至黑，再淡入下一画面",
    load: () => import("./algorithms/fadeBlack").then((module) => module.fadeBlackAlgorithm),
  },
  {
    ...crossfadeDefinition,
    id: "zoom-out",
    name: "拉远",
    description: "离场画面缩小至半倍，入场画面从两倍同步拉远至原比例",
    load: () => import("./algorithms/zoom").then((module) => module.zoomOutAlgorithm),
  },
  {
    ...crossfadeDefinition,
    id: "blinds",
    name: "百叶窗",
    description: "十条水平百叶由上向下展开下一画面",
    load: () => import("./algorithms/blinds").then((module) => module.blindsAlgorithm),
  },
  {
    ...crossfadeDefinition,
    id: "blinds-diagonal",
    name: "倾斜百叶窗",
    description: "十条倾斜 45° 的百叶展开下一画面",
    load: () => import("./algorithms/blinds").then((module) => module.diagonalBlindsAlgorithm),
  },
  {
    ...crossfadeDefinition,
    id: "wipe-right",
    name: "向右擦除",
    description: "入场画面从左向右覆盖离场画面",
    load: () => import("./algorithms/wipe").then((module) => module.wipeRightAlgorithm),
  },
  {
    ...crossfadeDefinition,
    id: "wipe-left",
    name: "向左擦除",
    description: "入场画面从右向左覆盖离场画面",
    load: () => import("./algorithms/wipe").then((module) => module.wipeLeftAlgorithm),
  },
  {
    ...crossfadeDefinition,
    id: "split-open",
    name: "中分展开",
    description: "入场画面从中央向左右两侧展开",
    load: () => import("./algorithms/wipe").then((module) => module.splitOpenAlgorithm),
  },
  {
    ...crossfadeDefinition,
    id: "shake",
    name: "轻微晃动",
    description: "平滑叠化中加入轻微位移和旋转",
    load: () => import("./algorithms/shake").then((module) => module.shakeAlgorithm),
  },
];

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
  for (const effect of canvasDefinitions) {
    registry.register(
      options.backend === "wasm"
        ? { ...effect, load: () => loadWasmTransitionAlgorithm(new URL(`./wasm/${effect.id}.wasm`, import.meta.url)) }
        : effect,
    );
  }
  for (const effect of options.effects ?? []) registry.register(effect);
  return registry;
}
