import "./style";

export { VideoComposeEditor } from "./editor";
export type {
  ComposeUploadAdapter,
  ComposeBgmUploadResult,
  ComposeCatalogUploadPayload,
} from "./editor/session/createComposeEditorState";
export type { ComposeExportPayload } from "./types/videoCompose";
export {
  createComposeMediaResolver,
  isPassthroughMediaUrl,
  mediaCorsMessage,
  type ComposeMediaResolver,
  type ResolveMediaUrl,
} from "./service/resolveComposeMediaUrl";
