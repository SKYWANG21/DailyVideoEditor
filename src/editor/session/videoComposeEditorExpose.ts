import type { ComposeExportPayload, VideoClipItem, VideoComposeEditorModel } from "@/types/videoCompose";

/**
 * `VideoComposeEditor` 通过组件 ref 暴露的方法。
 * 换稿必须调用 `reload`；只改 `v-model` 引用不会回灌时间轴。
 */
export interface VideoComposeEditorExpose {
  /** 导出前校验。返回 `null` 表示通过，否则为错误文案 */
  validate: () => string | null;
  /** 立刻把当前轨道、喜欢态、缩放写入 `update:modelValue` */
  flush: () => void;
  /** 用指定工程整页重置时间轴与会话态 */
  reload: (model: VideoComposeEditorModel) => Promise<void>;
  /** 先 `flush`，再返回成片请求快照 */
  exportComposePayload: () => ComposeExportPayload;
  /** 主轨视频片段。优先读时间轴，否则用派生列表 */
  getMainVideoClips: () => VideoClipItem[];
  /** 触发上传视频：`onRequestUploadClip`，否则走内置上传 */
  requestUploadClip: () => void;
}
