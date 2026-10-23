import { computed, watch } from "vue";
import { useComposeMediaResolver } from "../composeRuntime";
import type { ComposeFrameAspect, ComposeTrack, VideoFrameTransform } from "@/types/videoCompose";
import type { ComposeEditorProps, ComposeEditorState } from "./createComposeEditorState";
import { findClipById } from "./trackLookup";
import {
  clampVideoFrame,
  normalizeFrameAspect,
  probeVideoPixelSize,
  readClipSourceSize,
  resolveComposeCanvasSize,
  resolveVideoFrame,
} from "../shared/videoFrame";

/** 主视频轨画幅，以及当前片段的画面变换。字幕和贴图不读这里 */
export function useComposeVideoFrame(props: ComposeEditorProps, state: ComposeEditorState) {
  const mediaResolver = useComposeMediaResolver();
  const mainTrack = computed(
    () => state.tracks.value.find((track) => track.isMain) ?? state.tracks.value.find((track) => track.type === "video"),
  );

  const frameAspect = computed(() => normalizeFrameAspect(mainTrack.value?.frameAspect));

  const canvasSize = computed(() =>
    resolveComposeCanvasSize(frameAspect.value, mainTrack.value?.nativeFrameWidth, mainTrack.value?.nativeFrameHeight),
  );

  const visibleClip = computed(() => {
    const item = state.derivedMainClips.value[state.playingIdx.value];
    const clip = findClipById(state.tracks.value, item?.id);
    return clip?.type === "video" ? clip : undefined;
  });

  const inspectorClip = computed(() => {
    const selected = findClipById(state.tracks.value, state.activeVideoId.value);
    if (selected?.type === "video") return selected;
    return visibleClip.value;
  });

  const visibleVideoFrame = computed(() => frameForClip(visibleClip.value));
  const inspectorVideoFrame = computed(() => frameForClip(inspectorClip.value));

  const canEditVideoFrame = computed(() => Boolean(inspectorClip.value));

  const showVideoFrameBox = computed(() => {
    if (props.readonly || state.previewCatalogVariant.value) return false;
    const visibleId = visibleClip.value?.id;
    return Boolean(visibleId && state.activeVideoId.value === visibleId);
  });

  /** 点预览画面：选中当前主轨片段，右栏切到视频。页签记忆不动 */
  function onSelectVideoClip(clipId: string): void {
    if (props.readonly || !clipId) return;
    state.timelineRef.value?.selectClipById?.(clipId);
    state.selectedClipIds.value = [clipId];
    state.inspectorKind.value = "video";
  }

  /** 侧栏改一个数字。没有保存过的片段会把当前适配结果一起写上 */
  function onInspectorFrameChange(patch: Partial<VideoFrameTransform>): void {
    const clip = inspectorClip.value;
    if (!clip) return;
    writeFrame(clip.id, { ...inspectorVideoFrame.value, ...patch });
  }

  /** 预览拖拽写回当前画面上的片段 */
  function onVisibleFrameChange(frame: VideoFrameTransform): void {
    const clipId = visibleClip.value?.id;
    if (!clipId) return;
    writeFrame(clipId, frame);
  }

  /** 整条主视频轨共用一种画幅，不重算已有变换 */
  function onFrameAspectChange(aspect: ComposeFrameAspect): void {
    if (props.readonly) return;
    state.timelineRef.value?.setMainTrackFrame?.({ frameAspect: aspect });
  }

  /** 活动 video 的原始像素。第一段同时写成原画尺寸 */
  function onVideoSourceSize(payload: { clipId: string; width: number; height: number }): void {
    const clip = findClipById(state.tracks.value, payload.clipId);
    if (!clip || clip.type !== "video" || payload.width <= 0 || payload.height <= 0) return;
    const prev = readClipSourceSize(clip.config);
    if (!prev || prev.width !== payload.width || prev.height !== payload.height) {
      state.timelineRef.value?.patchClipsByType?.(
        "video",
        { config: { sourceWidth: payload.width, sourceHeight: payload.height } },
        { clipId: payload.clipId },
      );
    }
    const first = firstVideoClip(mainTrack.value);
    if (first?.id !== payload.clipId) return;
    writeNativeSize(payload.width, payload.height);
  }

  let probeSeq = 0;
  watch(
    () => firstVideoSource(mainTrack.value),
    (source) => {
      const seq = ++probeSeq;
      if (!source) return;
      void probeVideoPixelSize(source, (url) => mediaResolver.resolve(url)).then((size) => {
        if (seq !== probeSeq || !size) return;
        writeNativeSize(size.width, size.height);
      });
    },
    { immediate: true },
  );

  watch(
    () => state.timelineRef.value,
    () => {
      const track = mainTrack.value;
      if (track?.nativeFrameWidth && track.nativeFrameHeight) return;
      const source = firstVideoSource(track);
      if (!source) return;
      const seq = ++probeSeq;
      void probeVideoPixelSize(source, (url) => mediaResolver.resolve(url)).then((size) => {
        if (seq !== probeSeq || !size) return;
        writeNativeSize(size.width, size.height);
      });
    },
  );

  function frameForClip(clip: ComposeTrack["clips"][number] | undefined): VideoFrameTransform {
    const canvas = canvasSize.value;
    const source = clip ? readClipSourceSize(clip.config) : null;
    return resolveVideoFrame(clip?.config, canvas.width, canvas.height, source?.width, source?.height);
  }

  function writeFrame(clipId: string, frame: VideoFrameTransform): void {
    state.timelineRef.value?.patchClipsByType?.("video", { config: { frame: clampVideoFrame(frame) } }, { clipId });
  }

  function writeNativeSize(width: number, height: number): void {
    const track = mainTrack.value;
    if (!track || !state.timelineRef.value?.setMainTrackFrame) return;
    if (track.nativeFrameWidth === width && track.nativeFrameHeight === height) return;
    state.timelineRef.value.setMainTrackFrame({ nativeFrameWidth: width, nativeFrameHeight: height });
  }

  return {
    frameAspect,
    canvasSize,
    visibleClipId: computed(() => visibleClip.value?.id ?? ""),
    visibleVideoFrame,
    inspectorVideoFrame,
    canEditVideoFrame,
    showVideoFrameBox,
    onSelectVideoClip,
    onInspectorFrameChange,
    onVisibleFrameChange,
    onFrameAspectChange,
    onVideoSourceSize,
  };
}

function firstVideoClip(track: ComposeTrack | undefined): ComposeTrack["clips"][number] | undefined {
  if (!track) return undefined;
  return [...track.clips].filter((clip) => clip.type === "video").sort((a, b) => a.startTime - b.startTime)[0];
}

function firstVideoSource(track: ComposeTrack | undefined): string {
  const clip = firstVideoClip(track);
  if (!clip || clip.type !== "video") return "";
  return clip.sourceUrl?.trim() || "";
}
