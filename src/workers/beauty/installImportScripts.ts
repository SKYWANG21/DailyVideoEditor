/**
 * 模块 Worker 没有 importScripts。
 * MediaPipe 会用它同步执行 wasm 胶水，这里用同步 XHR 补上。
 */
export function installImportScripts(): void {
  const scope = globalThis as typeof globalThis & {
    importScripts?: (...urls: string[]) => void;
  };
  if (typeof scope.importScripts === "function") return;
  scope.importScripts = (...urls: string[]) => {
    for (const url of urls) {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, false);
      xhr.send();
      if (xhr.status !== 0 && (xhr.status < 200 || xhr.status >= 300)) {
        throw new Error(`无法加载 ${url}`);
      }
      (0, eval)(xhr.responseText);
    }
  };
}
