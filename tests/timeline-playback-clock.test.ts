import { describe, expect, it, vi } from "vitest";
import { createPinia } from "pinia";
import { usePlaybackStore } from "../src/clip-track/stores/playback";
import { createPreviewPlaybackClock } from "../src/hooks/previewPlaybackClock";

describe("时间轴读取预览主时钟", () => {
  it("预览提交才移动游标，缓冲等待不会自行推进或发出命令", () => {
    const store = usePlaybackStore(createPinia()),
      clock = createPreviewPlaybackClock(),
      dispatch = vi.fn();
    store.connect(clock, dispatch);
    clock.presentedTime = 2;
    clock.revision += 1;
    expect(store.currentTime).toBe(2);
    clock.isPlaying = true;
    clock.state = "buffering";
    expect(store.currentTime).toBe(2);
    expect(store.isPlaying).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("连续按键从待定位目标累加，提交后编辑操作读取已展示位置", () => {
    const store = usePlaybackStore(createPinia()),
      clock = createPreviewPlaybackClock(),
      dispatch = vi.fn();
    store.connect(clock, dispatch);
    store.setDuration(10);
    clock.presentedTime = 1;
    store.adjustTime(1 / 30);
    store.adjustTime(1 / 30);
    expect(store.currentTime).toBe(1);
    expect(store.seekTime).toBeCloseTo(1 + 2 / 30);
    expect(dispatch).toHaveBeenLastCalledWith({ type: "seek", time: store.seekTime });
    clock.presentedTime = 1 + 2 / 30;
    clock.revision += 1;
    expect(store.currentTime).toBeCloseTo(1 + 2 / 30);
    expect(store.seekTime).toBe(store.currentTime);
  });

  it("重新提交同一帧会清除已过期的跳转草稿", () => {
    const store = usePlaybackStore(createPinia()),
      clock = createPreviewPlaybackClock();
    store.connect(clock, vi.fn());
    store.seekTo(3);
    expect(store.seekTime).toBe(3);
    clock.revision += 1;
    expect(store.seekTime).toBe(0);
    expect(store.currentTime).toBe(0);
  });

  it("拖动保留开始时的播放意图，不直接暂停共享时钟", () => {
    const store = usePlaybackStore(createPinia()),
      clock = createPreviewPlaybackClock(),
      dispatch = vi.fn();
    clock.isPlaying = true;
    store.connect(clock, dispatch);
    store.beginScrub();
    expect(clock.isPlaying).toBe(true);
    expect(dispatch).toHaveBeenLastCalledWith({ type: "scrub-start" });
    store.endScrub(2);
    expect(dispatch).toHaveBeenLastCalledWith({ type: "scrub-end", time: 2, resume: true });
  });

  it("不同编辑器时钟隔离，未绑定时保留独立时间轴功能", () => {
    const first = usePlaybackStore(createPinia()),
      second = usePlaybackStore(createPinia());
    const clock = createPreviewPlaybackClock();
    first.connect(clock, vi.fn());
    second.seekTo(4);
    second.play();
    expect(first.currentTime).toBe(0);
    expect(first.isPlaying).toBe(false);
    expect(second.currentTime).toBe(4);
    expect(second.isPlaying).toBe(true);
    first.reset();
    expect(second.currentTime).toBe(4);
  });
});
