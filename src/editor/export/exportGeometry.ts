import { fitVideoFrame, frameDisplaySize, resolveComposeCanvasSize } from "@/editor/shared/videoFrame";
import type { VideoFrameTransform } from "@/types/videoCompose";
import type { VideoLayerSize } from "@/types/videoExport";
import type { ExportMedia } from "./exportMedia";
import type { ComposeExportSnapshot, ExportResolutionChoice, ExportVideoClip } from "./exportProtocol";

/** 主轨原画取首个视频旋转校正后的像素。 */
export function projectSize(snapshot: ComposeExportSnapshot, media: ExportMedia): VideoLayerSize {
  const first = media.size(snapshot.mainClips[0]);
  return resolveComposeCanvasSize(snapshot.aspect, first.width, first.height);
}

/** 输出编码尺寸向下对齐偶数，避免素材档产生额外放大。 */
function even(value: number): number {
  return Math.max(2, Math.floor((value + 1e-8) / 2) * 2);
}

/** 画幅固定，2K、1080p 和 720p 按短边定义。 */
export function outputSizes(base: VideoLayerSize, mainClips: ExportVideoClip[], media: ExportMedia): ExportResolutionChoice[] {
  const shortSide = Math.min(base.width, base.height);
  const visible = mainClips.filter((clip) => clip.visible);
  const minimum = (visible.length ? visible : mainClips).reduce((scale, clip) => {
    const { width, height } = media.size(clip);
    return Math.min(scale, width / base.width, height / base.height);
  }, Infinity);
  return [
    { resolution: "2k", width: even((base.width * 1440) / shortSide), height: even((base.height * 1440) / shortSide) },
    { resolution: "1080p", width: even((base.width * 1080) / shortSide), height: even((base.height * 1080) / shortSide) },
    { resolution: "720p", width: even((base.width * 720) / shortSide), height: even((base.height * 720) / shortSide) },
    { resolution: "source", width: even(base.width * minimum), height: even(base.height * minimum) },
  ];
}

/** 使用项目坐标下的原始变换，未设置时与预览一样等比居中。 */
export function clipFrame(clip: ExportVideoClip, base: VideoLayerSize, source: VideoLayerSize): VideoFrameTransform {
  return clip.frame ?? fitVideoFrame(base.width, base.height, source.width, source.height);
}

/** 保持素材比例，避免将画面在图层超分阶段拉伸。 */
export function layerUpscaleSize(
  frame: VideoFrameTransform,
  source: VideoLayerSize,
  base: VideoLayerSize,
  output: VideoLayerSize,
): VideoLayerSize | null {
  const { w, h } = frameDisplaySize(frame);
  const pixelScale = Math.max((w * output.width) / base.width / source.width, (h * output.height) / base.height / source.height);
  const canvasLimit = Math.hypot(output.width, output.height) / Math.max(source.width, source.height);
  const scale = Math.min(pixelScale, canvasLimit);
  return scale > 1.001 ? { width: Math.ceil(source.width * scale), height: Math.ceil(source.height * scale) } : null;
}
