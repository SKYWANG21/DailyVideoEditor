import { computed, nextTick, ref, watch, type CSSProperties } from "vue";
import { ElMessage } from "element-plus";
import type { MediaClip, RectConfig } from "@/clip-track";
import type { BeautyParams, ComposeSubtitleClip, SubtitleStyleConfig } from "@/types/videoCompose";
import { createDefaultSubtitleStyle, pickSubtitleStyleFromClip, readBeautyParams, readClipConfig } from "@/types/videoCompose";
import type { PatchableClipType } from "../timeline/VideoComposeTimeline.vue";
import { dbToGain, gainToDb } from "../shared/volumeDb";
import { clampPlaybackRate } from "../shared/playbackRate";
import { getTextTemplateAspect, type TextTemplateItem } from "../shared/textTemplateCatalog";
import type { ComposeApplyGlobalScope, SubtitleTextEditPayload } from "../sidebar/VideoComposeSidebar.vue";
import type { ComposeEditorProps, ComposeEditorState } from "./createComposeEditorState";
import type { ComposeEditorPorts } from "./ports";
import { findClipById, firstClipOfType, inspectorKindFromClipType, inspectorKindFromTrackType } from "./trackLookup";
import type { SubtitleAdjustCommit } from "@/hooks/useVideoComposeSubtitleAdjust";

/** 右栏写回轨道。同步展示值时用 syncingFromTracks 挡住字号 watch 的反向写入 */
export function useComposeInspector(props: ComposeEditorProps, state: ComposeEditorState, ports: ComposeEditorPorts) {
  /** 片段线性增益 → 侧栏分贝。缺省才用 fallback；显式 0 保持静音 */
  function volumeToDb(volume: number | undefined, fallbackGain: number): number | null {
    if (volume == null || !Number.isFinite(volume)) return gainToDb(fallbackGain);
    return gainToDb(volume);
  }

  /** 音轨 Tab 滑条目标：优先当前选中的 audio clip，未选中则 fallback 第一个 audio */
  function resolveActiveAudioVolumeClip(): MediaClip | undefined {
    const selected = findClipById(state.tracks.value, state.activeAudioId.value);
    if (selected?.type === "audio") return selected as MediaClip;
    return firstClipOfType(state.tracks.value, "audio") as MediaClip | undefined;
  }

  /** 从 tracks / 选中态同步侧栏展示值 */
  function syncSidebarFromTracks(): void {
    state.clock.syncingFromTracks = true;
    const videoClip = (findClipById(state.tracks.value, state.activeVideoId.value) || firstClipOfType(state.tracks.value, "video")) as
      MediaClip | undefined;
    const audioClip = resolveActiveAudioVolumeClip();
    const subClip = (findClipById(state.tracks.value, state.activeSubtitleId.value) || firstClipOfType(state.tracks.value, "subtitle")) as
      ComposeSubtitleClip | undefined;

    state.videoVolume.value = volumeToDb(videoClip?.volume, 0.8);
    state.beauty.value = readBeautyParams(readClipConfig(videoClip?.config).beauty);
    state.videoPlaybackRate.value = videoClip?.playbackRate && videoClip.playbackRate > 0 ? videoClip.playbackRate : 1;
    // 无音轨 clip 时保留用户侧栏已调值，避免 tracks 同步时用默认 -6 dB 覆盖
    if (audioClip) {
      state.bgmVolume.value = volumeToDb(audioClip.volume, 0.5);
      state.audioPlaybackRate.value = audioClip.playbackRate > 0 ? audioClip.playbackRate : 1;
    }

    if (subClip && subClip.type === "subtitle") {
      Object.assign(state.subtitleStyle, pickSubtitleStyleFromClip(subClip));
    } else {
      Object.assign(state.subtitleStyle, createDefaultSubtitleStyle());
    }
    void nextTick(() => {
      state.clock.syncingFromTracks = false;
    });
  }

  function patchClips(type: PatchableClipType, patch: Record<string, unknown>, clipId?: string): void {
    state.timelineRef.value?.patchClipsByType(type, patch, clipId ? { clipId } : undefined);
  }

  /** 侧栏视频分贝写回当前视频 clip 的线性增益 */
  function onVideoVolumeChange(db: number | null): void {
    state.videoVolume.value = db;
    patchClips("video", { volume: dbToGain(db) }, state.activeVideoId.value);
  }

  /** 侧栏美颜写回当前视频 clip。未选中时与音量一样写到全部视频片段 */
  function onBeautyChange(next: BeautyParams): void {
    state.beauty.value = next;
    patchClips("video", { config: { beauty: { ...next } } }, state.activeVideoId.value);
  }

  /** 侧栏音轨分贝写回当前音频 clip 的线性增益 */
  function onBgmVolumeChange(db: number | null): void {
    state.bgmVolume.value = db;
    const target = resolveActiveAudioVolumeClip();
    patchClips("audio", { volume: dbToGain(db) }, target?.id);
  }

  /** 把倍率写到指定 clip；未指定时写该类型全部 clip，并重算各自时间轴长度 */
  function writePlaybackRate(type: "video" | "audio", rate: number, clipId?: string): void {
    const next = clampPlaybackRate(rate);
    const ids = clipId
      ? [clipId]
      : state.tracks.value.flatMap((track) => track.clips.filter((clip) => clip.type === type).map((clip) => clip.id));
    for (const id of ids) {
      state.timelineRef.value?.setMediaClipPlaybackRate?.(id, next);
    }
  }

  /** 侧栏视频变速写回当前视频 clip */
  function onVideoPlaybackRateChange(rate: number): void {
    const next = clampPlaybackRate(rate);
    state.videoPlaybackRate.value = next;
    writePlaybackRate("video", next, state.activeVideoId.value);
  }

  /** 侧栏音频变速写回当前音频 clip */
  function onAudioPlaybackRateChange(rate: number): void {
    const next = clampPlaybackRate(rate);
    state.audioPlaybackRate.value = next;
    writePlaybackRate("audio", next, resolveActiveAudioVolumeClip()?.id);
  }

  function onSubtitleStyleChange(style: SubtitleStyleConfig): void {
    Object.assign(state.subtitleStyle, style);
    patchClips("subtitle", { ...style }, state.activeSubtitleId.value);
  }

  /** 侧栏输入非空时写回 payload.clipId（聚焦时锁定，避免切选中写到新 clip） */
  function onSubtitleTextChange(payload: SubtitleTextEditPayload): void {
    if (!payload.clipId || !payload.text.trim()) return;
    patchClips("subtitle", { text: payload.text }, payload.clipId);
  }

  /** 侧栏失焦/切选中提交；空文案拒绝并提示，不写回 */
  function onSubtitleTextCommit(payload: SubtitleTextEditPayload): void {
    if (!payload.clipId) return;
    const trimmed = payload.text.trim();
    if (!trimmed) {
      ElMessage.warning("字幕内容不能为空，请输入字幕后重试");
      return;
    }
    patchClips("subtitle", { text: trimmed }, payload.clipId);
  }

  /** 退出调整并同步父级标记，避免 emit 滞后挡住下一次 enter */
  function exitSubtitleAdjustNow(): void {
    state.playerRef.value?.exitAdjustSubPosition?.();
    state.isAdjusting.value = false;
  }

  /** 预览区双击字幕：同步时间轴选中态，侧栏切到字幕设置 */
  function onSelectSubtitleClip(clipId: string): void {
    if (props.readonly) return;
    const leavingId = state.activeSubtitleId.value;
    if (leavingId && leavingId !== clipId) {
      exitSubtitleAdjustNow();
    }
    state.timelineRef.value?.selectClipById?.(clipId);
    state.selectedClipIds.value = [clipId];
    state.inspectorKind.value = "subtitle";
    syncSubtitleAdjustMode({ pausePlayback: true });
  }

  /** 预览区字幕就地编辑提交；空文案拒绝并提示 */
  function onPreviewSubtitleTextUpdate(payload: { clipId: string; text: string }): void {
    const trimmed = payload.text.trim();
    if (!trimmed) {
      ElMessage.warning("字幕内容不能为空，请输入字幕后重试");
      return;
    }
    patchClips("subtitle", { text: trimmed }, payload.clipId);
  }

  /** 将当前侧栏值强制同步到对应轨道全部 clip */
  function onApplyGlobal(scope: ComposeApplyGlobalScope): void {
    if (scope === "audio") {
      patchClips("audio", { volume: dbToGain(state.bgmVolume.value) });
      writePlaybackRate("audio", state.audioPlaybackRate.value);
      return;
    }
    if (scope === "video") {
      patchClips("video", {
        volume: dbToGain(state.videoVolume.value),
        config: { beauty: { ...state.beauty.value } },
      });
      writePlaybackRate("video", state.videoPlaybackRate.value);
      return;
    }
    // 不写 visible，避免「应用到全局」误改各条字幕可见性
    patchClips("subtitle", {
      ...state.subtitleStyle,
    });
  }

  /** 将文字模板添加到贴图轨。未指定起点时用播放头，尺寸读当前预览画面 */
  function onAddTextTemplate(item: TextTemplateItem, startTime?: number): void {
    if (props.readonly) return;
    const size = state.playerRef.value?.getVideoSize?.() ?? null;
    const clipId = state.timelineRef.value?.addTextClip({
      templateId: item.id,
      sourceUrl: item.sourceUrl,
      name: item.name,
      text: item.defaultText,
      fontSize: item.defaultFontSize,
      color: null,
      aspect: getTextTemplateAspect(item.id),
      videoWidth: size?.width,
      videoHeight: size?.height,
      startTime,
    });
    if (!clipId) return;
    state.inspectorKind.value = "text";
    ElMessage.success("已添加到时间轴");
  }

  /** 侧栏：更新选中 TextClip 的 text / fontSize / color */
  function onTextClipPropsChange(patch: { text?: string; fontSize?: number; color?: string }): void {
    const clipId = state.activeTextClipId.value;
    if (!clipId) return;
    patchClips("text", patch, clipId);
  }

  /** 预览区拖拽贴图结束，写回 rect */
  function onTextClipRectUpdate(payload: { clipId: string; rect: RectConfig }): void {
    patchClips("text", { rect: payload.rect }, payload.clipId);
  }

  /** 预览区点选贴图：同步时间轴选中态，侧栏切到属性面板 */
  function onSelectTextClip(clipId: string): void {
    if (state.activeSubtitleId.value && state.activeSubtitleId.value !== clipId) {
      exitSubtitleAdjustNow();
    }
    state.timelineRef.value?.selectClipById?.(clipId);
    state.selectedClipIds.value = [clipId];
    state.inspectorKind.value = "text";
    syncSubtitleAdjustMode();
  }

  /** 拖动字幕框结束：边距和字号只写入当前选中字幕 */
  function onSubtitlePositionChange(commit: SubtitleAdjustCommit): void {
    const clipId = state.activeSubtitleId.value;
    if (!clipId) return;
    state.subtitleStyle.marginL = commit.marginL;
    state.subtitleStyle.marginR = commit.marginR;
    state.subtitleStyle.marginV = commit.marginV;
    state.subtitleStyle.fontSize = commit.fontSize;
    patchClips("subtitle", {
      marginL: commit.marginL,
      marginR: commit.marginR,
      marginV: commit.marginV,
      fontSize: commit.fontSize,
    }, clipId);
  }

  /** playhead 是否落在选中字幕上。半开区间，与预览过滤一致 */
  function selectedSubtitleHitsPlayhead(): boolean {
    const clip = findClipById(state.tracks.value, state.activeSubtitleId.value);
    if (!clip || clip.type !== "subtitle" || clip.visible === false || !clip.text?.trim()) return false;
    const timeSec = state.globalTime.value;
    return timeSec >= clip.startTime && timeSec < clip.endTime;
  }

  /** 右栏停在字幕且 playhead 在该 clip 内才出调整框 */
  function syncSubtitleAdjustMode(opts?: { pausePlayback?: boolean }): void {
    const shouldAdjust = !props.readonly && state.inspectorKind.value === "subtitle" && selectedSubtitleHitsPlayhead();
    if (shouldAdjust) {
      // 总是 enter：换选中条要重铺 draft；exit 后 state.isAdjusting 可能仍滞后为 true
      void state.playerRef.value?.enterAdjustSubPosition?.(opts);
      return;
    }
    exitSubtitleAdjustNow();
  }

  /** 播放路过区间：只显隐框，不暂停 */
  watch(
    () => [state.globalTime.value, state.activeSubtitleId.value, state.inspectorKind.value] as const,
    () => {
      syncSubtitleAdjustMode();
    },
  );

  /** 调整态开关只同步标记。位置在拖动结束时已写入当前 clip */
  function onIsAdjustingUpdate(next: boolean): void {
    state.isAdjusting.value = next;
  }

  function onSelectionChanged(ids: string[]): void {
    const nextIds = ids || [];
    const leavingSubtitle = Boolean(state.activeSubtitleId.value && !nextIds.includes(state.activeSubtitleId.value));
    if (leavingSubtitle) {
      exitSubtitleAdjustNow();
    }
    state.selectedClipIds.value = nextIds;
    syncSidebarFromTracks();
    if (!nextIds.length) {
      state.inspectorKind.value = null;
      syncSubtitleAdjustMode();
      return;
    }
    for (const id of nextIds) {
      const clip = findClipById(state.tracks.value, id);
      if (!clip) continue;
      const kind = inspectorKindFromClipType(clip.type);
      if (kind) {
        state.inspectorKind.value = kind;
        // 时间轴点选字幕：命中区间时进框并暂停；播放路过不走这里
        syncSubtitleAdjustMode(kind === "subtitle" ? { pausePlayback: true } : undefined);
        return;
      }
    }
    state.inspectorKind.value = null;
    syncSubtitleAdjustMode();
  }

  /** 点轨道头时切换右栏，不改轨道数据 */
  function onInspectTrack(trackType: string): void {
    state.inspectorKind.value = inspectorKindFromTrackType(trackType);
    syncSubtitleAdjustMode();
  }

  const fontPopover = useFontPopover(state, onSubtitleStyleChange);

  /** 预览自动换算字号后写回（measure 可能改 fontSize） */
  watch(
    () => state.subtitleStyle.fontSize,
    (fontSize) => {
      if (state.clock.syncingFromTracks || state.isAdjusting.value || fontSize <= 0) return;
      patchClips("subtitle", { fontSize }, state.activeSubtitleId.value);
    },
  );

  ports.syncSidebarFromTracks = syncSidebarFromTracks;
  ports.onAddTextTemplate = onAddTextTemplate;

  return {
    onVideoVolumeChange,
    onBeautyChange,
    onBgmVolumeChange,
    onVideoPlaybackRateChange,
    onAudioPlaybackRateChange,
    onSubtitleStyleChange,
    onSubtitleTextChange,
    onSubtitleTextCommit,
    onSelectSubtitleClip,
    onPreviewSubtitleTextUpdate,
    onApplyGlobal,
    onTextClipPropsChange,
    onTextClipRectUpdate,
    onSelectTextClip,
    onSubtitlePositionChange,
    onIsAdjustingUpdate,
    onSelectionChanged,
    onInspectTrack,
    ...fontPopover,
  };
}

const fontOptions = [
  { v: "Noto Sans CJK SC", t: "思源黑体" },
  { v: "SimHei", t: "黑体" },
  { v: "SimSun", t: "宋体" },
  { v: "Arial", t: "Arial" },
];

const styleOptions = [
  { v: "normal", t: "常规", bold: false, italic: false },
  { v: "bold", t: "加粗", bold: true, italic: false },
  { v: "italic", t: "斜体", bold: false, italic: true },
  { v: "bold-italic", t: "加粗斜体", bold: true, italic: true },
];

/** 字体气泡锚在右栏按钮上。按钮 ref 由侧栏 expose，外壳只负责定位 */
function useFontPopover(state: ComposeEditorState, onSubtitleStyleChange: (style: SubtitleStyleConfig) => void) {
  const fontPopoverOpen = ref<"family" | "style" | null>(null);
  const popoverLayoutTick = ref(0);

  const fontLabel = computed(() => fontOptions.find((option) => option.v === state.subtitleStyle.fontFamily)?.t || "微软雅黑");
  const fontStyleKey = computed(
    () =>
      styleOptions.find((option) => option.bold === state.subtitleStyle.bold && option.italic === state.subtitleStyle.italic)?.v ||
      "normal",
  );
  const styleLabel = computed(() => styleOptions.find((option) => option.v === fontStyleKey.value)?.t || "常规");

  function popoverAnchorStyle(btn: HTMLButtonElement | null): CSSProperties {
    if (!btn) return { display: "none" };
    const rect = btn.getBoundingClientRect();
    return { top: `${rect.bottom + 4}px`, left: `${rect.left}px`, width: `${rect.width}px` };
  }

  function familyButton(): HTMLButtonElement | null {
    const sidebar = state.sidebarRef.value as { fontFamilyBtnRef?: HTMLButtonElement | null } | null;
    return sidebar?.fontFamilyBtnRef ?? null;
  }

  function styleButton(): HTMLButtonElement | null {
    const sidebar = state.sidebarRef.value as { fontStyleBtnRef?: HTMLButtonElement | null } | null;
    return sidebar?.fontStyleBtnRef ?? null;
  }

  const fontFamilyDropdownStyle = computed(() => {
    popoverLayoutTick.value;
    return popoverAnchorStyle(familyButton());
  });

  const fontStyleDropdownStyle = computed(() => {
    popoverLayoutTick.value;
    return popoverAnchorStyle(styleButton());
  });

  function onFontPopoverToggle(type: "family" | "style"): void {
    fontPopoverOpen.value = fontPopoverOpen.value === type ? null : type;
    if (fontPopoverOpen.value) {
      void nextTick(() => {
        popoverLayoutTick.value += 1;
      });
    }
  }

  function onFontOptionSelect(fontFamily: string): void {
    onSubtitleStyleChange({ ...state.subtitleStyle, fontFamily });
  }

  function onStyleOptionSelect(key: string): void {
    const opt = styleOptions.find((option) => option.v === key);
    if (!opt) return;
    onSubtitleStyleChange({ ...state.subtitleStyle, bold: opt.bold, italic: opt.italic });
  }

  return {
    fontPopoverOpen,
    fontFamilyDropdownStyle,
    fontStyleDropdownStyle,
    fontOptions,
    styleOptions,
    fontLabel,
    fontStyleKey,
    styleLabel,
    onFontPopoverToggle,
    onFontOptionSelect,
    onStyleOptionSelect,
  };
}
