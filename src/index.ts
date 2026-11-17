import "./style";

export type { VideoAdjustments } from "./types/videoAdjustments";

export type { ComposeFrameCapture } from "./types/frameCapture";
export type {
  ComposeVideoExportOptions,
  ComposeVideoExportProgress,
  ComposeVideoExportResolution,
  ComposeVideoExportResult,
  ComposeVideoExportStage,
  VideoLayerSize,
  VideoLayerUpscaler,
  VideoLayerUpscalerFactory,
  VideoLayerUpscaleRequest,
} from "./types/videoExport";
export { ComposeVideoExportError } from "./editor/export/useComposeVideoExport";

export type {
  ComposeTransition,
  TransitionAlgorithm,
  TransitionBackend,
  TransitionEffectDefinition,
  TransitionInputKeys,
  TransitionRegistryOptions,
  TransitionRenderContext,
  TransitionRenderRequest,
  WasmTransitionExports,
} from "./types/transition";
export { TransitionEngine } from "./transitions/engine";
export { TransitionRegistry } from "./transitions/registry";
export { createTransitionRegistry, crossfadeDefinition } from "./transitions/catalog";
export { loadWasmTransitionAlgorithm } from "./transitions/wasmAdapter";

export { VideoComposeEditor, createDefaultVideoComposeEditorModel } from "./editor";

export type {
  BgmItem,
  ComposeBgmUploadResult,
  ComposeCatalogUploadPayload,
  ComposeClip,
  ComposeEditorProps,
  ComposeExportPayload,
  ComposeSegmentClipAssets,
  ComposeTrack,
  ComposeUploadAdapter,
  MediaBizType,
  MediaClip,
  MediaRef,
  SubtitleClip,
  TextClip,
  TextTemplateItem,
  TrackType,
  TrackTypeConfig,
  VideoClipItem,
  VideoComposeEditorExpose,
  VideoComposeEditorModel,
} from "./editor";

export {
  createComposeMediaResolver,
  isPassthroughMediaUrl,
  mediaCorsMessage,
  mediaHttpErrorMessage,
  type ComposeMediaResolver,
  type ResolveMediaUrl,
} from "./service/resolveComposeMediaUrl";
