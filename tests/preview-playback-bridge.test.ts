import { describe, expect, it, vi } from "vitest";
import { computed, ref } from "vue";
import { useComposePlaybackBridge } from "../src/editor/session/useComposePlaybackBridge";
import { createPreviewPlaybackClock } from "../src/hooks/previewPlaybackClock";
import type { ComposeEditorState } from "../src/editor/session/createComposeEditorState";
import type { ComposeEditorPorts } from "../src/editor/session/ports";

vi.mock("../src/types/videoCompose", () => ({ mapMainTrackToVideoClips: vi.fn(), mapTracksToPreviewAudioClips: vi.fn() }));

/** 控制请求和画面回执分开，避免用 seek mock 伪造已展示时间。 */
function setup() {
  const playbackClock = createPreviewPlaybackClock();
  playbackClock.presentedTime = 1;
  const player = {
    isPlaying: false,
    seek: vi.fn(async (_time: number): Promise<void> => undefined),
    resync: vi.fn(async (_time: number): Promise<void> => undefined),
    play: vi.fn(async (): Promise<void> => undefined),
    pause: vi.fn(),
    setPlaybackRate: vi.fn(),
  };
  const timeline = { seekTo: vi.fn(), play: vi.fn(), pause: vi.fn() };
  const state = {
    playerRef: ref(player),
    timelineRef: ref(timeline),
    playbackClock,
    globalTime: computed(() => playbackClock.presentedTime),
    previewDurationSec: ref(5),
    previewCatalogVariant: ref(null),
    derivedMainClips: ref([{ id: "a" }]),
    derivedAudioClips: ref([]),
    clock: { playSeq: 0, playInFlight: false },
  } as unknown as ComposeEditorState;
  const ports = { afterExitCatalogPreview: (action: (exited: boolean) => void) => action(false) } as ComposeEditorPorts;
  return { state, player, timeline, bridge: useComposePlaybackBridge(state, ports) };
}

/** 等待控制命令的 Promise 链结束。 */
async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe("时间轴被动显示与控制命令", () => {
  it("暂停跳转只请求目标，准备期间不提前修改共享时间", () => {
    const { bridge, state, player, timeline } = setup();
    bridge.onPreviewSeek(3);
    expect(player.seek).toHaveBeenCalledWith(3);
    expect(state.globalTime.value).toBe(1);
    expect(timeline.seekTo).not.toHaveBeenCalled();
    state.playbackClock.presentedTime = 3;
    state.playbackClock.revision += 1;
    expect(state.globalTime.value).toBe(3);
    expect(timeline.seekTo).not.toHaveBeenCalled();
  });

  it("展示时间变化不会反向跳转或调用时间轴播放 API", () => {
    const { state, player, timeline } = setup();
    state.playbackClock.isPlaying = true;
    state.playbackClock.presentedTime = 1.1;
    expect(player.seek).not.toHaveBeenCalled();
    expect(timeline.seekTo).not.toHaveBeenCalled();
    expect(timeline.play).not.toHaveBeenCalled();
  });

  it("播放中收到真实跳转命令立即转交，不存在等待下一帧的抑制窗口", () => {
    const { bridge, state, player } = setup();
    state.playerRef.value!.isPlaying = true;
    state.playbackClock.isPlaying = true;
    for (const time of [1.2, 2, 3]) bridge.onTimelineCommand({ type: "seek", time });
    expect(player.seek.mock.calls.map(([time]) => time)).toEqual([1.2, 2, 3]);
    expect(state.globalTime.value).toBe(1);
  });

  it("暂停续播直接 play，复用协调器队列", async () => {
    const { bridge, player, timeline } = setup();
    bridge.onTimelinePlay();
    await flush();
    expect(player.play).toHaveBeenCalledOnce();
    expect(player.seek).not.toHaveBeenCalled();
    expect(timeline.play).not.toHaveBeenCalled();
  });

  it("定位尚未完成时点播放会等待目标，暂停可取消待执行的播放", async () => {
    const { bridge, player } = setup();
    let release!: () => void;
    player.seek.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    bridge.onTimelineSeek(3);
    bridge.onTimelinePlay();
    await flush();
    expect(player.seek).toHaveBeenCalledOnce();
    expect(player.play).not.toHaveBeenCalled();
    bridge.onTimelinePause();
    release();
    await flush();
    expect(player.play).not.toHaveBeenCalled();
  });

  it("播放请求等待期间的新跳转接管目标并保留播放意图", async () => {
    const { bridge, player } = setup();
    const releases: Array<() => void> = [];
    player.seek.mockImplementation(() => new Promise<void>((resolve) => releases.push(resolve)));
    bridge.onTimelineSeek(2);
    bridge.onTimelinePlay();
    bridge.onTimelineSeek(3);
    releases[0]();
    await flush();
    expect(player.play).not.toHaveBeenCalled();
    releases[1]();
    await flush();
    expect(player.play).toHaveBeenCalledOnce();
    expect(player.seek.mock.calls.map(([time]) => time)).toEqual([2, 3]);
  });

  it("拖动松手等待最终目标提交后恢复，期间暂停可取消恢复", async () => {
    const { bridge, player } = setup();
    let release!: () => void;
    player.seek.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    bridge.onTimelineCommand({ type: "scrub-start" });
    bridge.onTimelineCommand({ type: "scrub-end", time: 3, resume: true });
    expect(player.pause).toHaveBeenCalledOnce();
    expect(player.play).not.toHaveBeenCalled();
    bridge.onTimelinePause();
    release();
    await flush();
    expect(player.play).not.toHaveBeenCalled();
  });

  it("最终目标就绪后恢复拖动前播放意图", async () => {
    const { bridge, player } = setup();
    bridge.onTimelineCommand({ type: "scrub-end", time: 3, resume: true });
    await flush();
    expect(player.seek).toHaveBeenCalledWith(3);
    expect(player.play).toHaveBeenCalledOnce();
  });

  it("素材库预览的播放按钮不会退出预览或推动工程时间", async () => {
    const { bridge, state, player } = setup();
    state.previewCatalogVariant.value = { id: "asset" } as NonNullable<ComposeEditorState["previewCatalogVariant"]["value"]>;
    bridge.onPreviewTogglePlayback();
    await flush();
    expect(player.play).toHaveBeenCalledOnce();
    expect(player.resync).not.toHaveBeenCalled();
    expect(state.globalTime.value).toBe(1);
  });
});
