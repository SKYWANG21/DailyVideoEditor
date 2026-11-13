/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

declare module "*.svg" {
  const src: string;
  export default src;
}

declare module "*.svg?raw" {
  const raw: string;
  export default raw;
}

declare module "@/algorithm/wasm/gpupixel.js" {
  const createGpuPixelModule: unknown;
  export default createGpuPixelModule;
}
declare module "virtual:compose-worker-gpupixel" {
  /** 为导出任务绑定独立的美颜画布。 */
  export function createWorkerGpuPixel(
    canvas: OffscreenCanvas,
    options: { locateFile(file: string): string },
  ): Promise<import("./src/utils/beauty/gpuPixelPreview").GpuPixelModule>;
}
