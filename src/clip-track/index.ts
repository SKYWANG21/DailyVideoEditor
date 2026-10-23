/**
 * 时间轴组件入口。仅导出 Editor 实际使用的 API；
 * stores / composables / 媒体工具请走相对路径，勿从本 barrel 裸调 Pinia。
 */
import "./styles/global.css";

export { default as VideoTrack } from "./components/index.vue";

export { locales } from "./types/config";

export { generateId } from "./utils/helpers";

export type {
  RectConfig,
  MediaClip,
  SubtitleClip,
  TextClip,
  Clip,
} from "./types/clip";

export type { Track, TrackType } from "./types/track";

export type {
  OperationButton,
  ClipTypeConfig,
  TrackContextMenuConfig,
  ClipContextMenuConfig,
  ThemeConfig,
} from "./types/config";

/** VideoTrack importData / exportData 工程快照 */
export interface VideoTrackProjectData {
  version: string;
  tracks: import("./types/track").Track[];
  currentTime: number;
  scale: number;
  snapEnabled: boolean;
}
