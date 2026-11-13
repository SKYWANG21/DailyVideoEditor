import { applyTextTemplateSvg } from "@/editor/shared/applyTextTemplateSvg";
import { getCachedTextTemplateSvg, parseSvgAspect } from "@/editor/shared/textTemplateCatalog";
import { normalizeFrameAspect, readVideoFrameTransform } from "@/editor/shared/videoFrame";
import { isPassthroughMediaUrl, type ResolveMediaUrl } from "@/service/resolveComposeMediaUrl";
import { normalizeTrackTransitions } from "@/transitions/timing";
import { readBeautyParams } from "@/types/composeMedia";
import {
  mapMediaClipToVideoClipItem,
  mapTracksToPreviewAudioClips,
  mapTracksToTextOverlayClips,
  pickSubtitleStyleFromClip,
  type ComposeTrack,
} from "@/types/videoCompose";
import type { ComposeExportSnapshot, ExportAudioClip, ExportInterval, ExportVideoClip, ExportVideoTrack } from "./exportProtocol";

/** 快照资源在页面端解析，渲染 Worker 只收到可读取的地址和数据。 */
interface SnapshotOptions {
  algorithmBaseUrl: string;
  transitionBackend: ComposeExportSnapshot["transitionBackend"];
  resolveMediaUrl?: ResolveMediaUrl;
  signal: AbortSignal;
}

/** 只保留和主轨输出区间相交的内容。 */
function within(clip: ExportInterval, end: number): boolean {
  return (
    Number.isFinite(clip.startTime) && Number.isFinite(clip.endTime) && clip.endTime > Math.max(0, clip.startTime) && clip.startTime < end
  );
}

/** 提取显示规则和裁剪信息，避免复制缩略图或波形。 */
function videoTrack(track: ComposeTrack, end: number): ExportVideoTrack {
  const clips = track.clips
    .flatMap((clip, index): ExportVideoClip[] => {
      if (clip.type !== "video" || !within(clip, end)) return [];
      const item = mapMediaClipToVideoClipItem(clip, index);
      return [
        {
          ...item,
          type: "video",
          startTime: clip.startTime,
          endTime: clip.endTime,
          visible: track.visible !== false && clip.visible !== false,
          frame: readVideoFrameTransform(clip.config),
          beauty: readBeautyParams(item.beauty),
          volume: track.muted ? 0 : item.volume,
        },
      ];
    })
    .sort((a, b) => a.startTime - b.startTime);
  const transitions = normalizeTrackTransitions(clips, track.transitions).map((item) => ({
    ...item,
    params: JSON.parse(JSON.stringify(item.params)) as Record<string, unknown>,
  }));
  return { clips, transitions };
}

/** 同源和普通 CORS 地址交给 Worker 按需读取，页面 Blob 固定为任务持有的数据。 */
async function resolveAsset(url: string, options: SnapshotOptions): Promise<string | Blob> {
  if (!url.trim()) throw new Error("存在没有媒体地址的片段");
  options.signal.throwIfAborted();
  const resolved = !isPassthroughMediaUrl(url) && options.resolveMediaUrl ? await options.resolveMediaUrl(url) : url;
  options.signal.throwIfAborted();
  if (!resolved?.trim()) throw new Error("宿主没有返回可读取的媒体地址");
  const absolute = new URL(resolved, document.baseURI);
  if (absolute.protocol !== "blob:" && absolute.protocol !== "data:") return absolute.href;
  const response = await fetch(absolute, { signal: options.signal });
  if (!response.ok) throw new Error("无法读取本地媒体素材");
  return response.blob();
}

/** 在第一个异步步骤前复制工程数据，随后依次准备素材和静态花字。 */
export async function buildExportSnapshot(tracks: ComposeTrack[], options: SnapshotOptions): Promise<ComposeExportSnapshot> {
  const main = tracks.find((track) => track.isMain && track.type === "video") ?? tracks.find((track) => track.type === "video");
  if (!main) throw new Error("请先在主轨添加视频");
  const durationSec = main.clips.reduce(
    (end, clip) => (clip.type === "video" && within(clip, Infinity) ? Math.max(end, clip.endTime) : end),
    0,
  );
  if (!durationSec) throw new Error("主视频轨没有可导出的时长");
  const mainTrack = videoTrack(main, durationSec);
  const videoTracks = [
    mainTrack,
    ...tracks
      .filter((track) => track !== main && track.type === "video" && track.visible !== false)
      .sort((a, b) => b.order - a.order)
      .map((track) => videoTrack(track, durationSec)),
  ];
  const audio = buildAudioClips(tracks, videoTracks, durationSec);
  const subtitles = tracks.flatMap((track) =>
    track.type === "subtitle" && track.visible !== false
      ? track.clips.flatMap((clip) =>
          clip.type === "subtitle" && clip.visible !== false && clip.text?.trim() && within(clip, durationSec)
            ? [
                {
                  ...pickSubtitleStyleFromClip(clip),
                  text: clip.text,
                  startTime: clip.startTime,
                  endTime: Math.min(clip.endTime, durationSec),
                },
              ]
            : [],
        )
      : [],
  );
  const stickers = mapTracksToTextOverlayClips(tracks)
    .filter((clip) => within(clip, durationSec))
    .map((clip) => ({ ...clip, rect: clip.rect ? { ...clip.rect } : undefined, endTime: Math.min(clip.endTime, durationSec) }));
  const aspect = normalizeFrameAspect(main.frameAspect);
  const mediaUrls = new Set(
    [...mainTrack.clips, ...videoTracks.flatMap((track) => track.clips.filter((clip) => clip.visible)), ...audio].map((clip) => clip.url),
  );
  const sources: ComposeExportSnapshot["sources"] = [];
  for (const url of mediaUrls) {
    sources.push({ url, input: await resolveAsset(url, options) });
  }
  const overlays: ComposeExportSnapshot["stickers"] = [];
  const svgSources = new Map<string, string>();
  for (const clip of stickers) {
    let raw = svgSources.get(clip.sourceUrl) || getCachedTextTemplateSvg(clip.sourceUrl);
    if (!raw) {
      const input = await resolveAsset(clip.sourceUrl, options);
      if (typeof input === "string") {
        const response = await fetch(input, { signal: options.signal });
        if (!response.ok) throw new Error(`花字素材加载失败（HTTP ${response.status}）`);
        raw = await response.text();
      } else raw = await input.text();
      svgSources.set(clip.sourceUrl, raw);
    }
    const styled = applyTextTemplateSvg(raw, { text: clip.text, color: clip.color, fontSize: clip.fontSize, idPrefix: clip.id });
    const aspect = parseSvgAspect(raw);
    overlays.push({ ...clip, aspect, image: await rasterizeSticker(styled, aspect, options.signal) });
  }
  return {
    mainClips: mainTrack.clips,
    aspect,
    durationSec,
    tracks: videoTracks,
    audio,
    subtitles,
    stickers: overlays,
    sources,
    algorithmBaseUrl: new URL(options.algorithmBaseUrl, document.baseURI).href,
    transitionBackend: options.transitionBackend,
  };
}

/** 在页面端栅格化静态 SVG，Worker 只接收浏览器通用的 PNG。 */
async function rasterizeSticker(raw: string, aspect: number, signal: AbortSignal): Promise<Blob> {
  const svgDocument = new DOMParser().parseFromString(raw, "image/svg+xml");
  const svg = svgDocument.documentElement;
  if (svg.localName !== "svg") throw new Error("花字模板的 SVG 无法解析");
  const style = svgDocument.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = "* { animation: none !important; transition: none !important; }";
  svg.append(style);
  const width = Math.max(1, Math.round(Math.min(2048, 2048 * aspect)));
  const height = Math.max(1, Math.round(Math.min(2048, 2048 / aspect)));
  if (svg.hasAttribute("viewBox")) {
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
  }
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svgDocument)], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    signal.throwIfAborted();
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("花字导出画布不可用");
    ctx.drawImage(image, 0, 0, width, height);
    return await canvas.convertToBlob({ type: "image/png" });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 参与混音的独立音轨和未分离的内嵌原声，共用主轨的裁剪边界。 */
function buildAudioClips(tracks: ComposeTrack[], videoTracks: ExportVideoTrack[], durationSec: number): ExportAudioClip[] {
  const visibleAudio = new Set(
    tracks.flatMap((track) => (track.type === "audio" ? track.clips.filter((clip) => clip.visible !== false).map((clip) => clip.id) : [])),
  );
  const audio = mapTracksToPreviewAudioClips(tracks)
    .filter((clip) => visibleAudio.has(clip.id) && !clip.muted && clip.volume > 0 && within(clip, durationSec))
    .map((clip) => ({ ...clip, embedded: false, endTime: Math.min(clip.endTime, durationSec) }));
  for (const { clips } of videoTracks) {
    for (const clip of clips) {
      if (!clip.visible || clip.audioDetached || !clip.volume) continue;
      audio.push({
        id: clip.id,
        url: clip.url,
        startTime: clip.startTime,
        endTime: Math.min(clip.endTime, durationSec),
        trimStart: clip.trimStart ?? 0,
        playbackRate: clip.playbackRate ?? 1,
        volume: clip.volume,
        embedded: true,
        muted: false,
      });
    }
  }
  return audio;
}
