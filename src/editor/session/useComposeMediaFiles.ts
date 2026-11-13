import { onScopeDispose, watch } from "vue";
import type { ComposeSegmentClipAssets } from "@/types/videoCompose";

/** 保存实例内导入的文件；移除素材时保留引用供撤销使用，会话结束后统一释放。 */
export function useComposeMediaFiles(assets: () => readonly ComposeSegmentClipAssets[]): ReadonlyMap<string, File> {
  const files = new Map<string, File>();
  watch(
    () => assets().map(({ url, file }) => ({ url, file })),
    (items): void => {
      for (const { url, file } of items) {
        if (url.trim() && file instanceof File) files.set(url.trim(), file);
      }
    },
    { immediate: true, flush: "sync" },
  );
  // URL 由上传方拥有，清理文件引用时不能撤销宿主仍在使用的地址。
  onScopeDispose((): void => files.clear());
  return files;
}
