import { computed, nextTick, ref, watch, type CSSProperties } from "vue";
import { ElMessage } from "element-plus";
import type { MediaClip, RectConfig } from "@/clip-track";
import type { BeautyParams, ComposeSubtitleClip, SubtitleStyleConfig } from "@/types/videoCompose";
import { createDefaultSubtitleStyle, pickSubtitleStyleFromClip, readBeautyParams, readClipConfig } from "@/types/videoCompose";
import type { PatchableClipType } from "../timeline/VideoComposeTimeline.vue";
import { dbToGain, gainToDb } from "../shared/volumeDb";
import { getTextTemplateAspect, type TextTemplateItem } from "../shared/textTemplateCatalog";
import type { ComposeApplyGlobalScope, SubtitleTextEditPayload } from "../sidebar/VideoComposeSidebar.vue";
import type { ComposeEditorProps, ComposeEditorState } from "./createComposeEditorState";
import type { ComposeEditorPorts } from "./ports";
import { findClipById, findTrackIdByClipId, firstClipOfType, inspectorKindFromClipType, inspectorKindFromTrackType } from "./trackLookup";

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
    // 无音轨 clip 时保留用户侧栏已调值，避免 tracks 同步时用默认 -6 dB 覆盖
    if (audioClip) {
      state.bgmVolume.value = volumeToDb(audioClip.volume, 0.5);
    }

    if (subClip && subClip.type === "subtitle") {
      Object.assign(state.subtitleStyle, pickSubtitleStyleFromClip(subClip));
      state.subtitleVisible.value = subClip.visible !== false;
    } else {
      Object.assign(state.subtitleStyle, createDefaultSubtitleStyle());
      state.subtitleVisible.value = true;
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

  function onSubtitleStyleChange(style: SubtitleStyleConfig): void {
    Object.assign(state.subtitleStyle, style);
    patchClips("subtitle", { ...style }, state.activeSubtitleId.value);
  }

  function onSubtitleVisibleChange(visible: boolean): void {
    state.subtitleVisible.value = visible;
    patchClips("subtitle", { visible }, state.activeSubtitleId.value);
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

  /** 预览区双击字幕：同步时间轴选中态，侧栏切到字幕设置 */
  function onSelectSubtitleClip(clipId: string): void {
    if (props.readonly) return;
    state.timelineRef.value?.selectClipById?.(clipId);
    state.selectedClipIds.value = [clipId];
    state.inspectorKind.value = "subtitle";
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
      return;
    }
    if (scope === "video") {
      patchClips("video", {
        volume: dbToGain(state.videoVolume.value),
        config: { beauty: { ...state.beauty.value } },
      });
      return;
    }
    patchClips("subtitle", {
      ...state.subtitleStyle,
      visible: state.subtitleVisible.value,
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
    state.timelineRef.value?.selectClipById?.(clipId);
    state.selectedClipIds.value = [clipId];
    state.inspectorKind.value = "text";
  }

  function toggleAdjustSubPosition(): void {
    state.playerRef.value?.toggleAdjustSubPosition();
  }

  /** 退出调整模式时：位置写回整轨（未选中字幕则全部字幕轨），字号仍按原 clip 范围 */
  function onIsAdjustingUpdate(next: boolean): void {
    const wasAdjusting = state.isAdjusting.value;
    state.isAdjusting.value = next;
    if (wasAdjusting && !next) {
      const positionPatch = {
        marginL: state.subtitleStyle.marginL,
        marginR: state.subtitleStyle.marginR,
        marginV: state.subtitleStyle.marginV,
      };
      const selectedId = state.activeSubtitleId.value;
      const trackId = findTrackIdByClipId(state.tracks.value, selectedId);
      if (trackId) {
        state.timelineRef.value?.patchClipsByType("subtitle", positionPatch, { trackId });
      } else {
        patchClips("subtitle", positionPatch, selectedId);
      }
      patchClips("subtitle", { fontSize: state.subtitleStyle.fontSize }, selectedId);
    }
  }

  function onSelectionChanged(ids: string[]): void {
    state.selectedClipIds.value = ids || [];
    syncSidebarFromTracks();
    if (!ids?.length) {
      state.inspectorKind.value = null;
      return;
    }
    for (const id of ids) {
      const clip = findClipById(state.tracks.value, id);
      if (!clip) continue;
      const kind = inspectorKindFromClipType(clip.type);
      if (kind) {
        state.inspectorKind.value = kind;
        return;
      }
    }
    state.inspectorKind.value = null;
  }

  /** 点轨道头时切换右栏，不改轨道数据 */
  function onInspectTrack(trackType: string): void {
    state.inspectorKind.value = inspectorKindFromTrackType(trackType);
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
    onSubtitleStyleChange,
    onSubtitleVisibleChange,
    onSubtitleTextChange,
    onSubtitleTextCommit,
    onSelectSubtitleClip,
    onPreviewSubtitleTextUpdate,
    onApplyGlobal,
    onTextClipPropsChange,
    onTextClipRectUpdate,
    onSelectTextClip,
    toggleAdjustSubPosition,
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
