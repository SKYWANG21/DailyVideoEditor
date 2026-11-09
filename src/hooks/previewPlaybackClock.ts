import { reactive } from "vue";
import type { PreviewPlaybackClock } from "@/types/previewPlayback";

/** 工程、素材预览和独立播放器各自创建，避免跨实例共享时间。 */
export function createPreviewPlaybackClock(): PreviewPlaybackClock {
  return reactive<PreviewPlaybackClock>({
    presentedTime: 0,
    isPlaying: false,
    playbackRate: 1,
    state: "paused",
    revision: 0,
  });
}
