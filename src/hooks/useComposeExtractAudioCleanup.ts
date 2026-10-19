import { ref } from "vue";
import type { ComposeTrack } from "@/types/videoCompose";

/**
 * 本地工程不登记、不清理远端抽轨文件。
 * @param initialRegistry 兼容旧工程字段，本地只原样保留
 */
export function useComposeExtractAudioCleanup(initialRegistry: string[] = []) {
  /** 工程里带来的 URL 列表，不做远端删除 */
  const composeExtractAudioUrls = ref<string[]>([...initialRegistry]);

  /** 本地不登记新的抽轨地址 */
  function registerComposeExtractAudioUrl(_url: string | undefined | null): void {
    return;
  }

  /** 本地不从轨道回填 OSS 注册表 */
  function syncRegistryFromTracks(_tracks: ComposeTrack[]): void {
    return;
  }

  /** 不请求清理接口 */
  function scheduleOrphanComposeExtractCleanup(_tracks: ComposeTrack[]): void {
    return;
  }

  return {
    composeExtractAudioUrls,
    registerComposeExtractAudioUrl,
    syncRegistryFromTracks,
    scheduleOrphanComposeExtractCleanup,
  };
}
