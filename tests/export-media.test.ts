import { describe, expect, it, vi } from "vitest";
import type { CanvasSink, WrappedCanvas } from "mediabunny";
import { ExportVideoCursor } from "../src/editor/export/exportMedia";
import {
  getStickerSamplingKind,
  mapTracksToTextOverlayClips,
  TEXT_TEMPLATE_TRACK_TYPE,
  type ComposeTrack,
} from "../src/types/videoCompose";

/** 模拟 PTS 查询：请求早于首帧时无画面。 */
function createSink(timestamps: number[]): CanvasSink {
  const frames = timestamps.map((timestamp) => ({ timestamp, duration: 0.04, canvas: {} }) as WrappedCanvas);
  return {
    canvases: vi.fn(async function* (time: number) {
      yield* frames.filter((frame) => frame.timestamp >= time);
    }),
    getCanvas: vi.fn(async (time: number) => frames.filter((frame) => frame.timestamp <= time).at(-1) ?? null),
  } as unknown as CanvasSink;
}

describe("导出视频的首尾边界", () => {
  it("B 片段在分割点之前持续取得正 PTS 首帧", async () => {
    const sink = createSink([0.0667, 0.1, 0.14]);
    const cursor = new ExportVideoCursor(sink, 0, 0.0667, 0.18);
    expect((await cursor.at(0))?.timestamp).toBe(0.0667);
    expect((await cursor.at(0))?.timestamp).toBe(0.0667);
    expect((await cursor.at(0.1))?.timestamp).toBe(0.1);
    cursor.close();
  });

  it("保留共同音视频原点，裁剪时间不额外平移到视频首帧", async () => {
    const sink = createSink([0, 0.04, 0.08, 0.12]);
    const cursor = new ExportVideoCursor(sink, -0.02, 0, 0.16);
    expect((await cursor.at(0))?.timestamp).toBe(0);
    expect((await cursor.at(0.1))?.timestamp).toBe(0.08);
    expect((await cursor.at(20))?.timestamp).toBe(0.12);
    cursor.close();
  });
});

describe("花字轨类型迁移", () => {
  it("新建轨采用 sticker，新旧轨道均走动画采样", () => {
    expect(TEXT_TEMPLATE_TRACK_TYPE).toBe("sticker");
    expect(getStickerSamplingKind("sticker")).toBe("animated");
    expect(getStickerSamplingKind("text")).toBe("animated");
    expect(getStickerSamplingKind("subtitle")).toBeUndefined();
  });

  it("宿主传入的新旧轨均进入预览和导出，保留层级与可见性", () => {
    const tracks = ["text", "sticker", "subtitle"].map((type, index) => ({
      id: type,
      type,
      order: 2 - index,
      visible: true,
      clips: [{ id: type, type: "text", text: "花字", startTime: 0, endTime: 2, config: { sourceUrl: "flower.svg" } }],
    })) as ComposeTrack[];
    expect(mapTracksToTextOverlayClips(tracks).map((clip) => clip.id)).toEqual(["sticker", "text"]);
    tracks[1].visible = false;
    expect(mapTracksToTextOverlayClips(tracks).map((clip) => clip.id)).toEqual(["text"]);
  });
});
