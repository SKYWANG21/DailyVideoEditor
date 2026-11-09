import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPreviewAudioMixer, type PreviewAudioMixer, type PreviewAudioMixerSyncState } from "../src/hooks/previewAudioMixer";
import { createDefaultComposeConfig } from "../src/types/composeMedia";
import type { ComposeMediaResolver } from "../src/service/resolveComposeMediaUrl";

vi.mock("../src/types/videoCompose", () => ({
  findPreviewAudiosAtTime: (clips: { startTime: number; endTime: number }[], time: number) =>
    clips.filter((clip) => time >= clip.startTime && time < clip.endTime),
}));
vi.mock("../src/hooks/previewMediaGain", () => ({ applyPreviewGain: vi.fn() }));

/** HTMLAudioElement 的可观察控制行为，真实媒体解码另由浏览器集成覆盖。 */
class AudioSource extends EventTarget {
  src = "";
  currentTime = 0;
  duration = 10;
  readyState = 4;
  seeking = false;
  paused = true;
  error: { code: number; message: string } | null = null;
  volume = 1;
  playbackRate = 1;
  play = vi.fn(async () => {
    this.paused = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
  load = vi.fn();
  removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }
}

describe("展示时钟下的独立原声与混音", () => {
  let instances: AudioSource[];
  let mixer: PreviewAudioMixer;
  let state: PreviewAudioMixerSyncState;
  let resolver: ComposeMediaResolver;

  beforeEach(() => {
    instances = [];
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("HTMLMediaElement", { HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2 });
    vi.stubGlobal(
      "Audio",
      class extends AudioSource {
        constructor() {
          super();
          instances.push(this);
        }
      },
    );
    resolver = { resolve: async (url) => url, peek: (url) => url, isFailed: () => false, revokeAll: vi.fn() };
    mixer = createPreviewAudioMixer(resolver);
    state = {
      audioClips: [],
      originalAudioClips: [{ id: "a", url: "original.webm", startTime: 0, endTime: 5, trimStart: 1, volume: 0.8, playbackRate: 2 }],
      globalTime: 0,
      isPlaying: true,
      playbackWaiting: false,
      globalPlaybackRate: 1,
      composeConfig: { ...createDefaultComposeConfig(), bgm: { name: "BGM", url: "bgm.mp3", durationSec: 10 } },
      bgmEl: new AudioSource() as unknown as HTMLAudioElement,
    };
  });

  afterEach(() => {
    mixer.destroy(state.bgmEl);
    vi.unstubAllGlobals();
  });

  it("原声池不会禁用 legacy BGM，二者先准备再同步启动", async () => {
    await mixer.prepare(state, new AbortController().signal);
    expect(instances).toHaveLength(1);
    expect(instances[0].currentTime).toBe(1);
    expect(instances[0].playbackRate).toBe(2);
    expect(instances[0].paused).toBe(true);
    expect(state.bgmEl!.src).toBe("bgm.mp3");
    mixer.sync(state);
    expect(instances[0].play).toHaveBeenCalledTimes(1);
    expect(state.bgmEl!.play).toHaveBeenCalledTimes(1);
  });

  it("工程音轨与原声 ID 相同也独立混音，存在工程音轨时保持既有 BGM 回退规则", async () => {
    state.audioClips = [{ id: "a", url: "track.mp3", startTime: 0, endTime: 5, trimStart: 0, playbackRate: 1, volume: 0.4 }];
    await mixer.prepare(state, new AbortController().signal);
    mixer.sync(state);
    expect(instances).toHaveLength(2);
    expect(instances.every((audio) => !audio.paused)).toBe(true);
    expect(state.bgmEl!.play).not.toHaveBeenCalled();
  });

  it("缓冲只暂停音轨，不能按旧展示时间反复倒回；恢复才精确对齐", async () => {
    await mixer.prepare(state, new AbortController().signal);
    mixer.sync(state);
    instances[0].currentTime = 1.2;
    state.playbackWaiting = true;
    mixer.sync(state);
    expect(instances[0].paused).toBe(true);
    expect(instances[0].currentTime).toBe(1.2);
    expect(state.bgmEl!.paused).toBe(true);
    state.globalTime = 0.1;
    await mixer.prepare(state, new AbortController().signal);
    state.playbackWaiting = false;
    mixer.sync(state);
    expect(instances[0].currentTime).toBe(1.2);
    expect(instances[0].paused).toBe(false);
  });

  it("暂停一个播放器不影响另一个播放器的原声或共享增益上下文", async () => {
    const other = createPreviewAudioMixer(resolver);
    const otherState = { ...state, bgmEl: new AudioSource() as unknown as HTMLAudioElement };
    await mixer.prepare(state, new AbortController().signal);
    await other.prepare(otherState, new AbortController().signal);
    mixer.sync(state);
    other.sync(otherState);
    mixer.pauseAll(state.bgmEl);
    expect(instances[0].paused).toBe(true);
    expect(instances[1].paused).toBe(false);
    expect(otherState.bgmEl!.paused).toBe(false);
    other.destroy(otherState.bgmEl);
  });

  it("静音原声不创建媒体实例，也不会禁用仍可听的 BGM", async () => {
    state.originalAudioClips![0].muted = true;
    await mixer.prepare(state, new AbortController().signal);
    mixer.sync(state);
    expect(instances).toHaveLength(0);
    expect(state.bgmEl!.paused).toBe(false);
  });

  it("原声不支持的缓存按源地址隔离，替换同 ID 视频后可以重新发声", async () => {
    await mixer.prepare(state, new AbortController().signal);
    instances[0].error = { code: 4, message: "无音轨" };
    await mixer.prepare(state, new AbortController().signal);
    mixer.sync(state);
    state.originalAudioClips![0].url = "new-with-audio.webm";
    await mixer.prepare(state, new AbortController().signal);
    mixer.sync(state);
    expect(instances).toHaveLength(2);
    expect(instances[1].src).toBe("new-with-audio.webm");
    expect(instances[1].paused).toBe(false);
  });

  it("预览静音时 BGM 不启动独立播放，也不阻塞画面准备", async () => {
    state.originalAudioClips = [];
    state.composeConfig.bgmVolume = 0;
    await mixer.prepare(state, new AbortController().signal);
    expect(mixer.ready(state)).toBe(true);
    mixer.sync(state);
    expect(state.bgmEl!.play).not.toHaveBeenCalled();
  });
});
