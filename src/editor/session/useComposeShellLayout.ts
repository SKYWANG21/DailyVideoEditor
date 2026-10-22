import { computed, ref, type CSSProperties } from "vue";
import type { ComposeEditorProps } from "./createComposeEditorState";

/** 相邻栏之间的间距，拖动手柄就放在这里 */
const SPLIT_SIZE = 12;
/** 左栏下限。拖到这个宽度时素材栏显示收起样式 */
const MIN_ASSET_WIDTH = 132;
/** 右栏下限 */
const MIN_INSPECTOR_WIDTH = 240;
/** 预览下限 */
const MIN_PREVIEW_WIDTH = 240;
/** 上半区和时间轴各自下限 */
const MIN_PANE_HEIGHT = 160;

type SplitAxis = "left" | "right" | "timeline";

/** 外壳分栏。只负责像素夹紧，不碰轨道和播放 */
export function useComposeShellLayout(props: ComposeEditorProps) {
  /** 合成器外壳，用来按像素夹紧各栏 */
  const shellRef = ref<HTMLElement | null>(null);
  /** 左栏宽度。下限 132px 时由素材栏自己切成收起样式 */
  const expandedAssetWidth = ref(360);
  /** 右栏宽度 */
  const inspectorWidth = ref(300);
  /** 时间轴高度 */
  const timelineHeight = ref(280);
  /** 是否已经按外壳比例写过初始尺寸 */
  let layoutInitialized = false;
  /** 外壳尺寸变化时重新夹紧 */
  let shellResizeObserver: ResizeObserver | null = null;

  /** 把数值夹进区间 */
  function clampNum(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  /** 外壳内容盒尺寸 */
  function measureShell(): { width: number; height: number } {
    const shell = shellRef.value;
    if (!shell) return { width: 0, height: 0 };
    return { width: shell.clientWidth, height: shell.clientHeight };
  }

  /** 左右栏和两条竖向手柄占掉之后，预览还能用的宽度 */
  function previewRoom(left: number, right: number): number {
    return measureShell().width - SPLIT_SIZE * 2 - left - right;
  }

  /** 展开左栏时夹进预览下限 */
  function clampLeftWidth(next: number): number {
    const max = Math.max(MIN_ASSET_WIDTH, previewRoom(0, inspectorWidth.value) - MIN_PREVIEW_WIDTH);
    return clampNum(next, MIN_ASSET_WIDTH, max);
  }

  /** 右栏夹进预览下限 */
  function clampRightWidth(next: number): number {
    const max = Math.max(MIN_INSPECTOR_WIDTH, previewRoom(expandedAssetWidth.value, 0) - MIN_PREVIEW_WIDTH);
    return clampNum(next, MIN_INSPECTOR_WIDTH, max);
  }

  /** 时间轴高度夹进上半区下限 */
  function clampTimelineHeight(next: number): number {
    const height = measureShell().height;
    const max = Math.max(MIN_PANE_HEIGHT, height - SPLIT_SIZE - MIN_PANE_HEIGHT);
    return clampNum(next, MIN_PANE_HEIGHT, max);
  }

  /** 窗口变化时把已拖过的尺寸夹回新盒子，不改外壳 */
  function clampPaneSizes(): void {
    const { width, height } = measureShell();
    if (width <= 0 || height <= 0) return;
    timelineHeight.value = clampTimelineHeight(timelineHeight.value);
    if (props.readonly) return;
    expandedAssetWidth.value = clampLeftWidth(expandedAssetWidth.value);
    inspectorWidth.value = clampRightWidth(inspectorWidth.value);
  }

  /** 首次进入时按外壳比例给出左栏、时间轴 */
  function initPaneSizes(): void {
    const { width, height } = measureShell();
    if (width < 100 || height < 100) return;
    if (!layoutInitialized) {
      expandedAssetWidth.value = Math.round(width * 0.34);
      timelineHeight.value = Math.round(height * 0.4);
      layoutInitialized = true;
    }
    clampPaneSizes();
  }

  /** 外壳两行：上半区、手柄、时间轴 */
  const shellGridStyle = computed((): CSSProperties => ({
    gridTemplateRows: `minmax(0, 1fr) ${SPLIT_SIZE}px ${timelineHeight.value}px`,
  }));

  /** 上半区三列。只读时只留预览 */
  const topGridStyle = computed((): CSSProperties => {
    if (props.readonly) return { gridTemplateColumns: "minmax(0, 1fr)" };
    return {
      gridTemplateColumns: `${expandedAssetWidth.value}px ${SPLIT_SIZE}px minmax(${MIN_PREVIEW_WIDTH}px, 1fr) ${SPLIT_SIZE}px ${inspectorWidth.value}px`,
    };
  });

  /** 拖相邻栏的边。差值由对面的栏吃掉，外壳不变 */
  function onSplitPointerDown(event: PointerEvent, axis: SplitAxis): void {
    if (event.button !== 0) return;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const originX = event.clientX;
    const originY = event.clientY;
    const originLeft = expandedAssetWidth.value;
    const originRight = inspectorWidth.value;
    const originTimeline = timelineHeight.value;

    const onMove = (ev: PointerEvent) => {
      if (axis === "left") {
        expandedAssetWidth.value = clampLeftWidth(originLeft + ev.clientX - originX);
        return;
      }
      if (axis === "right") {
        inspectorWidth.value = clampRightWidth(originRight - (ev.clientX - originX));
        return;
      }
      timelineHeight.value = clampTimelineHeight(originTimeline - (ev.clientY - originY));
    };
    const onUp = (ev: PointerEvent) => {
      if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }

  /** 卸掉外壳尺寸监听 */
  function disposeLayout(): void {
    shellResizeObserver?.disconnect();
    shellResizeObserver = null;
  }

  /** 按外壳尺寸夹紧各栏，并在之后继续跟着盒子变化 */
  function mountLayout(): void {
    initPaneSizes();
    if (!shellRef.value) return;
    shellResizeObserver = new ResizeObserver(() => {
      initPaneSizes();
    });
    shellResizeObserver.observe(shellRef.value);
  }

  return {
    shellRef,
    shellGridStyle,
    topGridStyle,
    onSplitPointerDown,
    mountLayout,
    disposeLayout,
  };
}
