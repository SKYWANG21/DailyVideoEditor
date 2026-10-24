import "./style";

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
  VideoClipItem,
  VideoComposeEditorExpose,
  VideoComposeEditorModel,
} from "./editor";

export {
  createComposeMediaResolver,
  isPassthroughMediaUrl,
  mediaCorsMessage,
  type ComposeMediaResolver,
  type ResolveMediaUrl,
} from "./service/resolveComposeMediaUrl";
