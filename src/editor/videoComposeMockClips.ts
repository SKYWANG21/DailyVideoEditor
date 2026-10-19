import type { VideoClipItem } from "@/types/videoCompose";

/**
 * ! MOCK 数据开关 — 调试视频合成 UI 时设为 true；联调/上线前必须改回 false
 * ! true 时 VideoComposeEditor 忽略 props.clips，始终使用 MOCK_VIDEO_URLS 并 bootstrap 主视频轨
 */
export const USE_MOCK_VIDEO_CLIPS = true;

/** ! 调试用 mock 视频地址。独立工程不预置远程链接，片段由本地上传提供 */
const MOCK_VIDEO_URLS: string[] = ["https://media.vimo.io/upload/video/2026/10/16/20261016165521_59389.mp4"];

/** 是否启用 mock 片段（供 VideoComposeEditor 加载逻辑使用） */
export function isVideoComposeMockEnabled(): boolean {
  return USE_MOCK_VIDEO_CLIPS;
}

/** ! 调试用 mock 片段列表 */
export function buildMockVideoClips(): VideoClipItem[] {
  return MOCK_VIDEO_URLS.map((url, i) => ({
    id: `clip-${i + 1}`,
    title: `片段 ${i + 1}`,
    url,
    durationSec: 0,
    src: "",
  }));
}
