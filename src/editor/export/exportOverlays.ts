import { computeScreenFontSize, DEFAULT_SUBTITLE_SCREEN_FONT_PX } from "@/types/composeMedia";
import { createDefaultTextClipRect } from "@/types/videoCompose";
import type { VideoLayerSize } from "@/types/videoExport";
import type { ExportSticker, ExportSubtitle, SampleExportSticker } from "./exportProtocol";

/** 静态位图复用，动态花字按目标尺寸逐帧请求。 */
interface PreparedSticker {
  clip: ExportSticker;
  rect: NonNullable<ExportSticker["rect"]>;
  bitmap: ImageBitmap | null;
  width: number;
  height: number;
}

/** 绘制于视频层和转场之后的字幕与花字。 */
export class ExportOverlays {
  private readonly stickers: PreparedSticker[] = [];
  private readonly lines = new Map<ExportSubtitle, string[]>();

  constructor(
    private readonly subtitles: ExportSubtitle[],
    private readonly base: VideoLayerSize,
    private readonly output: VideoLayerSize,
  ) {}

  /** 准备排版与静态位图，动态花字由页面按需采样。 */
  async prepare(stickers: ExportSticker[], signal: AbortSignal): Promise<void> {
    for (const clip of stickers) {
      signal.throwIfAborted();
      const rect = clip.rect ?? createDefaultTextClipRect(this.base.width, this.base.height, clip.aspect);
      const resizeWidth = Math.max(1, Math.round((rect.w * this.output.width) / this.base.width));
      const resizeHeight = Math.max(1, Math.round((rect.h * this.output.height) / this.base.height));
      const bitmap =
        clip.kind === "static" ? await createImageBitmap(clip.image, { resizeWidth, resizeHeight, resizeQuality: "high" }) : null;
      this.stickers.push({ clip, rect, bitmap, width: resizeWidth, height: resizeHeight });
    }
  }

  /** 以项目像素排版，通过上下文缩放匹配最终输出。 */
  async draw(ctx: OffscreenCanvasRenderingContext2D, time: number, sample: SampleExportSticker): Promise<void> {
    ctx.save();
    ctx.scale(this.output.width / this.base.width, this.output.height / this.base.height);
    try {
      for (const { clip, bitmap, rect, width, height } of this.stickers) {
        if (time < clip.startTime || time >= clip.endTime) continue;
        const image = bitmap ?? (await sample(clip.id, time - clip.startTime, width, height));
        ctx.save();
        try {
          ctx.translate(rect.x + rect.w / 2, rect.y + rect.h / 2);
          ctx.rotate(rect.angle ?? 0);
          ctx.drawImage(image, -rect.w / 2, -rect.h / 2, rect.w, rect.h);
        } finally {
          ctx.restore();
          if (!bitmap) image.close();
        }
      }
      for (const sub of this.subtitles) {
        if (time >= sub.startTime && time < sub.endTime) this.drawSubtitle(ctx, sub);
      }
    } finally {
      ctx.restore();
    }
  }

  /** 与预览一样采用视频像素边距、底部居中、单倍行高和投影。 */
  private drawSubtitle(ctx: OffscreenCanvasRenderingContext2D, sub: ExportSubtitle): void {
    const size = sub.fontSize > 0 ? computeScreenFontSize(sub.fontSize, 1) : DEFAULT_SUBTITLE_SCREEN_FONT_PX;
    const left = sub.marginL;
    const width = this.base.width - left - sub.marginR;
    if (width <= 0) return;
    ctx.save();
    ctx.font = `${sub.italic ? "italic" : "normal"} ${sub.bold ? "bold" : "normal"} ${size}px ${sub.fontFamily || "sans-serif"}`;
    let lines = this.lines.get(sub);
    if (!lines) {
      lines = wrapSubtitle(ctx, sub.text, width);
      this.lines.set(sub, lines);
    }
    ctx.fillStyle = sub.color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.8)";
    ctx.shadowOffsetY = (2 * this.output.height) / this.base.height;
    ctx.shadowBlur = (4 * this.output.height) / this.base.height;
    const bottom = this.base.height - sub.marginV;
    ctx.beginPath();
    ctx.rect(left, 0, width, bottom);
    ctx.clip();
    for (const [index, line] of lines.entries()) {
      ctx.fillText(line, left + width / 2, bottom - (lines.length - index - 0.5) * size);
    }
    ctx.restore();
  }

  /** 释放花字位图。 */
  dispose(): void {
    for (const item of this.stickers) item.bitmap?.close();
    this.stickers.length = 0;
  }
}

/** 保留显式换行，中文和超长单词按可用宽度折行。 */
function wrapSubtitle(ctx: OffscreenCanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/u)) {
    let line = "";
    for (const segment of paragraph.match(/[A-Za-z0-9_]+|\s+|./gu) ?? []) {
      if (line && ctx.measureText(line + segment).width > width) {
        lines.push(line.trimEnd());
        line = "";
      }
      if (ctx.measureText(segment).width <= width) {
        line += line ? segment : segment.trimStart();
        continue;
      }
      for (const glyph of segment) {
        if (line && ctx.measureText(line + glyph).width > width) {
          lines.push(line.trimEnd());
          line = "";
        }
        line += glyph;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
