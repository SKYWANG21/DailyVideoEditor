import { describe, expect, it, vi } from "vitest";
import { PREVIEW_QUEUE_LIMIT, PreviewFrameScheduler } from "../src/hooks/previewFrameScheduler";
import { previewCanvasSize } from "../src/hooks/previewCanvasFrame";
import type { PreparedPreviewFrame } from "../src/types/previewPlayback";

vi.mock("../src/editor/shared/videoFrame", () => ({ fitVideoFrame: vi.fn() }));

/** 测试位图的关闭计数用于检查队列所有权。 */
function frame(time: number, duration = 1 / 30): PreparedPreviewFrame {
  return {
    time,
    duration,
    clipIndex: 0,
    identity: { generation: 1, requestId: 1, clipId: "a", sourceTimeUs: time * 1e6 },
    bitmap: { close: vi.fn() } as unknown as ImageBitmap,
  };
}

describe("可冻结的完成帧调度", () => {
  it("提前处理的 20ms 不叠加到每帧 33ms 展示间隔", () => {
    const scheduler = new PreviewFrameScheduler();
    scheduler.reset(0, 1);
    scheduler.presented(frame(0));
    for (let index = 1; index <= 6; index += 1) scheduler.enqueue(frame(index / 30));
    expect(scheduler.ready).toBe(true);
    scheduler.resume(20);
    expect(scheduler.takeDue(20)).toBeNull();
    for (let index = 1; index <= 6; index += 1) {
      const due = scheduler.takeDue(20 + (index * 1000) / 30)!;
      expect(due.time).toBeCloseTo(index / 30);
      scheduler.presented(due);
      due.bitmap!.close();
    }
    expect(scheduler.time(220)).toBeCloseTo(0.2);
  });

  it("缓冲 500ms 时逻辑时间冻结，恢复后不追赶等待时间", () => {
    const scheduler = new PreviewFrameScheduler();
    scheduler.reset(0, 1);
    scheduler.presented(frame(0));
    scheduler.resume(0);
    expect(scheduler.exhausted(34)).toBe(true);
    scheduler.freeze(34);
    expect(scheduler.time(534)).toBeCloseTo(1 / 30);
    for (let index = 1; index <= 3; index += 1) scheduler.enqueue(frame(index / 30));
    scheduler.resume(534);
    const next = scheduler.takeDue(534)!;
    expect(next.time).toBeCloseTo(1 / 30);
    scheduler.presented(next);
    expect(scheduler.takeDue(535)).toBeNull();
    expect(scheduler.time(535)).toBeLessThan(0.04);
  });

  it("长任务后仍提交队首，不跳到积压队列的末帧", () => {
    const scheduler = new PreviewFrameScheduler();
    scheduler.reset(0, 1);
    scheduler.presented(frame(0));
    for (let index = 1; index <= 3; index += 1) scheduler.enqueue(frame(index / 30));
    scheduler.resume(0);
    const next = scheduler.takeDue(500)!;
    expect(next.time).toBeCloseTo(1 / 30);
    scheduler.presented(next);
    expect(scheduler.takeDue(501)).toBeNull();
  });

  it("倍速影响截止时间，暂停后继续沿用原队列", () => {
    const scheduler = new PreviewFrameScheduler();
    scheduler.reset(1, 2);
    scheduler.presented(frame(1, 2 / 30));
    scheduler.enqueue(frame(1 + 2 / 30, 2 / 30));
    scheduler.resume(0);
    scheduler.freeze(10);
    expect(scheduler.time(1000)).toBeCloseTo(1.02);
    scheduler.resume(1000);
    expect(scheduler.takeDue(1024)!.time).toBeCloseTo(1 + 2 / 30);
  });

  it("六帧封顶，重置释放每一张未展示位图，尾部不足三帧也能恢复", () => {
    const scheduler = new PreviewFrameScheduler();
    const frames = Array.from({ length: PREVIEW_QUEUE_LIMIT }, (_, index) => frame(index / 30));
    frames.forEach((item) => scheduler.enqueue(item));
    expect(scheduler.full).toBe(true);
    expect(() => scheduler.enqueue(frame(1))).toThrow("队列已满");
    scheduler.reset(0, 1);
    frames.forEach((item) => expect(item.bitmap!.close).toHaveBeenCalledTimes(1));
    scheduler.enqueue(frame(1));
    expect(scheduler.ready).toBe(false);
    scheduler.productionEnded = true;
    expect(scheduler.ready).toBe(true);
  });

  it("预览最长边 1920，不放大低分辨率素材且保留横竖比例", () => {
    expect(previewCanvasSize(3840, 2160)).toEqual({ width: 1920, height: 1080 });
    expect(previewCanvasSize(2160, 3840)).toEqual({ width: 1080, height: 1920 });
    expect(previewCanvasSize(320, 180)).toEqual({ width: 320, height: 180 });
  });
});
