import { describe, expect, it } from "vitest";
import { readVideoAdjustments, hasVideoAdjustments, type VideoAdjustments } from "../src/types/videoAdjustments";
import { VideoAdjustmentEngine } from "../src/utils/videoAdjustmentEngine";
import { mapMediaClipToVideoClipItem, type MediaClip } from "../src/types/videoCompose";

/** 固定源像素，用真实算法验证输出语义。 */
function render(pixels: number[], params: Partial<VideoAdjustments>, width = pixels.length / 4, sourceTimeUs = 0): number[] {
  const image = { data: new Uint8ClampedArray(pixels), width, height: pixels.length / 4 / width };
  new VideoAdjustmentEngine().applyPixels(image, readVideoAdjustments(params), { clipId: "clip-a", sourceTimeUs });
  return [...image.data];
}

describe("片段调色参数与像素", () => {
  it("旧工程、缺失字段和非法数值统一为中性值，输入对象不被修改", () => {
    expect(hasVideoAdjustments(readVideoAdjustments())).toBe(false);
    const raw = { temperature: 500, grain: -1, tint: NaN, sharpen: "50" };
    expect(readVideoAdjustments(raw)).toMatchObject({ temperature: 100, grain: 0, tint: 0, sharpen: 0 });
    expect(raw.temperature).toBe(500);
    const pixels = [23, 97, 211, 64, 250, 30, 8, 0];
    expect(render(pixels, {})).toEqual(pixels);
  });

  it("色温正值偏暖、色调正值偏洋红，灰度保持各通道一致", () => {
    const warm = render([128, 128, 128, 255], { temperature: 50 });
    expect(warm[0]).toBeGreaterThan(warm[2]);
    const tinted = render([128, 128, 128, 255], { tint: 50 });
    expect(tinted[0]).toBeGreaterThan(tinted[1]);
    expect(tinted[2]).toBeGreaterThan(tinted[1]);
    const gray = render([200, 100, 50, 255], { saturation: -100 });
    expect(gray[0]).toBe(gray[1]);
    expect(gray[1]).toBe(gray[2]);
  });

  it("亮度与对比度以中性值为基准，支持负向调节", () => {
    expect(render([100, 100, 100, 255], { brightness: 50 })[0]).toBe(150);
    expect(render([100, 100, 100, 255], { brightness: -100 })[0]).toBe(0);
    const contrast = render([60, 60, 60, 255, 200, 200, 200, 255], { contrast: 50 });
    expect(contrast[0]).toBeLessThan(60);
    expect(contrast[4]).toBeGreaterThan(200);
  });

  it("高光和阴影分别调整亮区与暗区", () => {
    const pixels = [32, 32, 32, 255, 128, 128, 128, 255, 224, 224, 224, 255];
    const shadows = render(pixels, { shadows: 100 });
    expect(shadows[0]).toBeGreaterThan(32);
    expect(shadows[8]).toBe(224);
    const highlights = render(pixels, { highlights: -100 });
    expect(highlights[8]).toBeLessThan(224);
    expect(highlights[0]).toBe(32);
  });

  it("锐化增强邻域差异，透明邻居不产生黑边，Alpha 保持", () => {
    const pixels = Array.from({ length: 9 }, () => [100, 100, 100, 255]).flat();
    pixels.splice(16, 4, 120, 120, 120, 255);
    expect(render(pixels, { sharpen: 100 }, 3)[16]).toBeGreaterThan(120);
    const transparent = Array.from({ length: 9 }, () => [0, 0, 0, 0]).flat();
    transparent.splice(16, 4, 120, 100, 80, 128);
    expect(render(transparent, { sharpen: 100 }, 3)).toEqual(transparent);
    expect(render([30, 50, 70, 89], { temperature: 50, grain: 80 })[3]).toBe(89);
  });

  it("颗粒可见，同源帧重复渲染一致，改变时间后更新", () => {
    const pixels = Array.from({ length: 64 }, () => [128, 128, 128, 255]).flat();
    const first = render(pixels, { grain: 100 }, 8);
    expect(first).not.toEqual(pixels);
    expect(render(pixels, { grain: 100 }, 8)).toEqual(first);
    expect(render(pixels, { grain: 100 }, 8, 33333)).not.toEqual(first);
  });

  it("工程 JSON 往返后片段映射保留调色，旧片段得到默认值", () => {
    const clip = { id: "a", name: "A", startTime: 0, endTime: 1, playbackRate: 1, config: { adjustments: { tint: 37 } } } as MediaClip;
    expect(mapMediaClipToVideoClipItem(JSON.parse(JSON.stringify(clip)), 0).adjustments?.tint).toBe(37);
    expect(hasVideoAdjustments(mapMediaClipToVideoClipItem({ ...clip, config: {} }, 0).adjustments!)).toBe(false);
  });
});
