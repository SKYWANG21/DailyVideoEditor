import { defineExpose, onBeforeUnmount, onMounted } from "vue";
import { loadTextTemplateCatalog, setHostTextTemplates } from "../shared/textTemplateCatalog";
import type { ComposeEditorEmit, ComposeEditorProps } from "./createComposeEditorState";
import { createComposeEditorState } from "./createComposeEditorState";
import { createComposeEditorPorts } from "./ports";
import { useComposeCatalog } from "./useComposeCatalog";
import { useComposeInspector } from "./useComposeInspector";
import { useComposePlaybackBridge } from "./useComposePlaybackBridge";
import { useComposeProject } from "./useComposeProject";
import { useComposeShellLayout } from "./useComposeShellLayout";
import { useComposeVideoFrame } from "./useComposeVideoFrame";

/**
 * 视频剪辑会话。
 * 接线顺序固定：播放桥 → 右栏 → 素材库 → 草稿。后注册的 immediate watch 才能用到已经接好的交接函数。
 * 区域组件仍由外壳用 props / 事件连接，不在子组件里注入，避免改掉播放和写回的调用顺序。
 */
export function useComposeEditorSession(props: ComposeEditorProps, emit: ComposeEditorEmit) {
  const state = createComposeEditorState(props);
  const ports = createComposeEditorPorts();

  setHostTextTemplates(state.textTemplates.value);

  const layout = useComposeShellLayout(props);
  const playback = useComposePlaybackBridge(state, ports);
  const inspector = useComposeInspector(props, state, ports);
  const catalog = useComposeCatalog(props, state, ports, emit);
  const project = useComposeProject(props, state, ports, emit);
  const videoFrame = useComposeVideoFrame(props, state);

  onMounted(() => {
    void loadTextTemplateCatalog();
    layout.mountLayout();
  });

  onBeforeUnmount(() => {
    layout.disposeLayout();
    ports.flush();
  });

  defineExpose({
    validate: project.validate,
    flush: project.flush,
    reload: project.reload,
    exportComposePayload: project.exportComposePayload,
    getMainVideoClips: () => state.timelineRef.value?.getMainVideoClips?.() || state.derivedMainClips.value,
    /** 触发上传视频：onRequestUploadClip → uploadAdapter → 提示 */
    requestUploadClip: () => {
      catalog.onUploadClipClick();
    },
  });

  return {
    shellRef: layout.shellRef,
    shellGridStyle: layout.shellGridStyle,
    topGridStyle: layout.topGridStyle,
    onSplitPointerDown: layout.onSplitPointerDown,
    playerRef: state.playerRef,
    sidebarRef: state.sidebarRef,
    timelineRef: state.timelineRef,
    derivedMainClips: state.derivedMainClips,
    derivedAudioClips: state.derivedAudioClips,
    playingIdx: state.playingIdx,
    globalTime: state.globalTime,
    isAdjusting: state.isAdjusting,
    videoReady: state.videoReady,
    previewDurationSec: state.previewDurationSec,
    tracks: state.tracks,
    audioAssets: state.audioAssets,
    sfxAssets: state.sfxAssets,
    subtitleAssets: state.subtitleAssets,
    audioClipCount: state.audioClipCount,
    subtitleStyle: state.subtitleStyle,
    videoVolume: state.videoVolume,
    beauty: state.beauty,
    bgmVolume: state.bgmVolume,
    videoPlaybackRate: state.videoPlaybackRate,
    audioPlaybackRate: state.audioPlaybackRate,
    videoVolumeLabel: state.videoVolumeLabel,
    audioVolumeLabel: state.audioVolumeLabel,
    inspectorKind: state.inspectorKind,
    selectedTextClipProps: state.selectedTextClipProps,
    selectedSubtitleText: state.selectedSubtitleText,
    activeSubtitleId: state.activeSubtitleId,
    activeTextClipId: state.activeTextClipId,
    textOverlayClips: state.textOverlayClips,
    derivedComposeConfig: state.derivedComposeConfig,
    previewCatalogVariant: state.previewCatalogVariant,
    uploadAudioModalOpen: state.uploadAudioModalOpen,
    uploadSfxModalOpen: state.uploadSfxModalOpen,
    visiblePreviewSubtitles: state.visiblePreviewSubtitles,
    adjustPreviewSubtitles: state.adjustPreviewSubtitles,
    ...playback,
    ...inspector,
    ...catalog,
    onTracksUpdate: project.onTracksUpdate,
    onTimelineScaleUpdate: project.onTimelineScaleUpdate,
    ...videoFrame,
  };
}
