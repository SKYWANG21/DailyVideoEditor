import "./style";

export type { ComposeTransition, TransitionAlgorithm, TransitionEffectDefinition, TransitionRenderContext, TransitionRenderRequest } from "./types/transition";
export { TransitionEngine } from "./transitions/engine";
export { TransitionRegistry } from "./transitions/registry";
export { createTransitionRegistry, crossfadeDefinition } from "./transitions/catalog";

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
