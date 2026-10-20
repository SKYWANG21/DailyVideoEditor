/**
 * 模块 Worker 没有 importScripts。
 * MediaPipe 把「存在 importScripts」当成 Worker：同步调用若抛 TypeError，才会动态 import 模块版胶水。
 * 没有这个函数时，库会改走 document 插脚本，在 Worker 里直接失败。
 */
export function installImportScripts(): void {
  const scope = globalThis as typeof globalThis & {
    importScripts?: (...urls: string[]) => void;
  };
  if (typeof scope.importScripts === "function") return;
  scope.importScripts = () => {
    throw new TypeError("模块 Worker 不支持 importScripts");
  };
}
