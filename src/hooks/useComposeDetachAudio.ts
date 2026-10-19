import { ref } from "vue";
import { ElMessage } from "element-plus";

/** Timeline 分离音轨所需的最小暴露接口（本地不调用） */
export interface ComposeDetachAudioTimelineRef {
  /** 将 video clip 与抽出的 audio 写入双轨 */
  applyDetachedAudioPair: (videoClipId: string, audioUrl: string, durationSec: number) => string | null;
  /** 标记 video clip 无内嵌音轨 */
  markVideoClipNoEmbeddedAudio: (videoClipId: string) => void;
  /** 读取 clip 的 sourceUrl */
  getClipSourceUrl: (clipId: string) => string | null;
  /** 读取 clip config */
  getClipConfig: (clipId: string) => unknown;
  /** video 是否处于有效分离态 */
  hasActiveDetachedAudio: (videoClipId: string) => boolean;
  /** 清除过期分离标记 */
  clearStaleDetachedAudioState: (videoClipId: string) => void;
  /** 写入/清除 video clip 分离状态 */
  setVideoExtractStatus: (clipId: string, status: "extracting" | "failed" | null, error?: string) => void;
  /** 刷新后恢复分离状态 */
  recoverStaleExtractStatuses: () => void;
}

/**
 * 分离音轨在独立工程中不请求抽轨接口。
 * @param _getTimeline 时间轴引用，本地忽略
 * @param _onExtracted 抽轨成功回调，本地忽略
 */
export function useComposeDetachAudio(
  _getTimeline: () => ComposeDetachAudioTimelineRef | null,
  _onExtracted?: (audioUrl: string) => void,
) {
  /** 正在抽轨的 clip，本地始终为空 */
  const detachingClipIds = ref<Set<string>>(new Set());

  /** 提示暂无，不发起抽轨 */
  function detachAudioForVideoClip(_videoClipId: string): Promise<string | null> {
    ElMessage.info("暂无");
    return Promise.resolve(null);
  }

  return {
    detachingClipIds,
    detachAudioForVideoClip,
  };
}
