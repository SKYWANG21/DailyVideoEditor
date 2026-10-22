import type { ComposeTrack } from "@/types/videoCompose";
import { readClipConfig } from "@/types/videoCompose";
import type { ComposeInspectorKind } from "../sidebar/VideoComposeSidebar.vue";

/** 能在右栏编辑的片段类型 */
export type SelectableClipKind = "audio" | "video" | "subtitle" | "text";

/** 片段类型对应的右栏 */
export function inspectorKindFromClipType(clipType: string): ComposeInspectorKind | null {
  if (clipType === "video" || clipType === "audio" || clipType === "subtitle") return clipType;
  if (clipType === "text") return "text";
  return null;
}

/** 轨道类型对应的右栏。贴图轨在库里叫 sticker */
export function inspectorKindFromTrackType(trackType: string): ComposeInspectorKind | null {
  if (trackType === "video" || trackType === "audio" || trackType === "subtitle") return trackType;
  if (trackType === "sticker" || trackType === "text") return "text";
  return null;
}

/** 选中且类型匹配的 clip id；否则 undefined（表示全轨） */
export function findSelectedIdOfType(tracks: ComposeTrack[], selectedIds: string[], type: SelectableClipKind): string | undefined {
  if (!selectedIds.length) return undefined;
  for (const id of selectedIds) {
    for (const track of tracks) {
      const clip = track.clips.find((item) => item.id === id);
      if (clip && clip.type === type) return id;
    }
  }
  return undefined;
}

/** 按 id 在全部轨道里找 clip */
export function findClipById(tracks: ComposeTrack[], id: string | undefined): ComposeTrack["clips"][number] | undefined {
  if (!id) return undefined;
  for (const track of tracks) {
    const clip = track.clips.find((item) => item.id === id);
    if (clip) return clip;
  }
  return undefined;
}

/** 根据 clip id 找所在轨道 id */
export function findTrackIdByClipId(tracks: ComposeTrack[], clipId: string | undefined): string | undefined {
  if (!clipId) return undefined;
  for (const track of tracks) {
    if (track.clips.some((item) => item.id === clipId)) return track.id;
  }
  return undefined;
}

/** 该类型的第一条 clip。视频只认主轨，贴图认 sticker / text 轨 */
export function firstClipOfType(tracks: ComposeTrack[], type: SelectableClipKind): ComposeTrack["clips"][number] | undefined {
  for (const track of tracks) {
    if (type === "video" && !(track.isMain || track.type === "video")) continue;
    if (type === "text" && track.type !== "sticker" && track.type !== "text") continue;
    if (type !== "video" && type !== "text" && track.type !== type) continue;
    const clip = track.clips.find((item) => item.type === type);
    if (clip) return clip;
  }
  return undefined;
}

/** 已分离原声时，video clip 对应的 linked audio clip id */
export function getLinkedOriginalAudioIdForVideo(tracks: ComposeTrack[], videoClipId: string | undefined): string | undefined {
  if (!videoClipId) return undefined;
  const clip = findClipById(tracks, videoClipId);
  if (!clip || clip.type !== "video") return undefined;
  const config = readClipConfig(clip.config);
  if (!config.audioDetached || !config.linkedAudioClipId) return undefined;
  return config.linkedAudioClipId;
}

/** 轨道/片段 id 与类型签名：区分结构性变更和属性微调 */
export function tracksStructureSig(list: ComposeTrack[]): string {
  return list.map((track) => `${track.id}:${track.type}:${track.clips.map((clip) => `${clip.id}:${clip.type}`).join(",")}`).join("|");
}
