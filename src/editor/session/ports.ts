import type { TextTemplateItem } from "../shared/textTemplateCatalog";

/**
 * 跨区域交接。
 * 各 composable 在 setup 里同步赋值，事件触发时才调用，因此播放标志和 nextTick / rAF 时序与拆分前一致。
 */
export interface ComposeEditorPorts {
  /** 同步时间轴播放按钮，不把事件回灌给预览 */
  syncTimelinePlaybackUi: (playing: boolean) => void;
  /** 从时间轴命令读主轨 / 音轨，喂给预览 */
  syncDerivedClipsFromTimeline: () => void;
  /** 用当前轨道和选中态刷新右栏，并挡住下一拍的反向写回 */
  syncSidebarFromTracks: () => void;
  /** 退出素材预览后等预览切回时间轴 clip，再执行回调 */
  afterExitCatalogPreview: (action: (exitedPreview: boolean) => void) => void;
  /** 花字落到贴图轨。未指定起点时用播放头，尺寸读预览画面 */
  onAddTextTemplate: (item: TextTemplateItem, startTime?: number) => void;
  /** 立刻把上传素材库写入 model */
  persistUploadCatalogNow: () => void;
  /** 立刻持久化轨道，并安排未引用抽轨文件清理 */
  flush: () => void;
  /** 主轨时长就绪后重建 clip，触发时间轴重新抽帧 */
  rebuildMainClipThumbnail: (clipId: string, durationSec: number) => void;
}

/** 未接线时调用会抛错，避免交接被静默丢掉 */
export function createComposeEditorPorts(): ComposeEditorPorts {
  const unwired = (name: string): (() => never) => {
    return () => {
      throw new Error(`剪辑会话交接 ${name} 尚未接线`);
    };
  };
  return {
    syncTimelinePlaybackUi: unwired("syncTimelinePlaybackUi"),
    syncDerivedClipsFromTimeline: unwired("syncDerivedClipsFromTimeline"),
    syncSidebarFromTracks: unwired("syncSidebarFromTracks"),
    afterExitCatalogPreview: unwired("afterExitCatalogPreview"),
    onAddTextTemplate: unwired("onAddTextTemplate"),
    persistUploadCatalogNow: unwired("persistUploadCatalogNow"),
    flush: unwired("flush"),
    rebuildMainClipThumbnail: unwired("rebuildMainClipThumbnail"),
  };
}
