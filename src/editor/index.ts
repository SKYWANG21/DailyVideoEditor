export { default as VideoComposeEditor } from "./VideoComposeEditor.vue";

export { createDefaultVideoComposeEditorModel } from "@/types/videoCompose";

export type {
  BgmItem,
  ComposeClip,
  ComposeExportPayload,
  ComposeSegmentClipAssets,
  ComposeTrack,
  MediaBizType,
  MediaRef,
  VideoClipItem,
  VideoComposeEditorModel,
} from "@/types/videoCompose";

export type { TextTemplateItem } from "./shared/textTemplateCatalog";

export type {
  ComposeBgmUploadResult,
  ComposeCatalogUploadPayload,
  ComposeEditorProps,
  ComposeUploadAdapter,
} from "./session/createComposeEditorState";

export type { VideoComposeEditorExpose } from "./session/videoComposeEditorExpose";

export type { MediaClip, SubtitleClip, TextClip, TrackType } from "@/clip-track";
