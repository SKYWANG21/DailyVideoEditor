import { AudioSample, AudioSampleSink, type AudioSampleSource, type InputAudioTrack } from "mediabunny";
import type { ExportAudioClip } from "./exportProtocol";
import type { ExportMedia } from "./exportMedia";

/** 成片混音格式和 AAC 编码参数。 */
export const EXPORT_AUDIO = { sampleRate: 48000, numberOfChannels: 2, bitrate: 160000 };

/** 一个解码样本及其交错 PCM，读取后立即释放原始 AudioData。 */
interface PcmBlock {
  start: number;
  end: number;
  rate: number;
  channels: number;
  data: Float32Array;
}

/** 单一素材片段的顺序音频读取器。 */
class AudioCursor {
  private iterator: AsyncGenerator<AudioSample, void, unknown> | null = null;
  private block: PcmBlock | null = null;
  private ended = false;

  constructor(
    private readonly clip: ExportAudioClip,
    private readonly track: InputAudioTrack,
    private readonly origin: number,
  ) {}

  /** 把该片段在本窗口的贡献叠加到交错 PCM。 */
  async mix(output: Float32Array, first: number, last: number, signal: AbortSignal): Promise<void> {
    const { sampleRate } = EXPORT_AUDIO;
    let index = Math.max(first, Math.ceil(this.clip.startTime * sampleRate));
    const end = Math.min(last, Math.ceil(this.clip.endTime * sampleRate));
    const offset = this.origin + this.clip.trimStart - this.clip.startTime * this.clip.playbackRate;
    const step = this.clip.playbackRate / sampleRate;
    while (index < end) {
      signal.throwIfAborted();
      const time = offset + index * step;
      const block = await this.read(time);
      if (!block) break;
      if (time < block.start - 1e-8) {
        index = Math.max(index + 1, Math.ceil((block.start - offset) / step - 1e-7));
        continue;
      }
      const until = Math.min(end, Math.max(index + 1, Math.ceil((block.end - offset) / step - 1e-7)));
      for (; index < until; index += 1) {
        mixSample(output, (index - first) * 2, block, (offset + index * step - block.start) * block.rate, this.clip.volume);
      }
    }
  }

  /** 解码到覆盖目标时间的块或下一个有音频的块。 */
  private async read(time: number): Promise<PcmBlock | null> {
    if (this.ended) return null;
    this.iterator ??= new AudioSampleSink(this.track).samples(time - 0.1);
    while (!this.block || this.block.end <= time + 1e-9) {
      const { value: sample } = await this.iterator.next();
      if (!sample) {
        this.ended = true;
        return null;
      }
      try {
        const data = new Float32Array(sample.numberOfFrames * sample.numberOfChannels);
        sample.copyTo(data, { format: "f32", planeIndex: 0 });
        this.block = {
          start: sample.timestamp,
          end: sample.timestamp + sample.numberOfFrames / sample.sampleRate,
          rate: sample.sampleRate,
          channels: sample.numberOfChannels,
          data,
        };
      } finally {
        sample.close();
      }
    }
    return this.block;
  }

  /** 释放片段的解码迭代器。 */
  close(): void {
    void this.iterator?.return().catch(() => undefined);
    this.iterator = null;
    this.block = null;
    this.ended = true;
  }
}

/** 线性重采样并转换成双声道。单声道复制，多声道合入中置与环绕声。 */
function mixSample(output: Float32Array, offset: number, block: PcmBlock, position: number, gain: number): void {
  const { channels, data } = block;
  const last = data.length / channels - 1;
  const clamped = Math.max(0, Math.min(last, position));
  const frame = Math.floor(clamped);
  const first = frame * channels;
  const next = Math.min(frame + 1, last) * channels;
  const fraction = clamped - frame;
  let left = interpolate(data, first, next, fraction);
  let right = channels > 1 ? interpolate(data, first + 1, next + 1, fraction) : left;
  if (channels > 2) {
    const center = 0.707 * interpolate(data, first + 2, next + 2, fraction);
    left += center;
    right += center;
    for (let channel = channels >= 6 ? 4 : 3; channel < channels; channel += 1) {
      const sample = 0.5 * interpolate(data, first + channel, next + channel, fraction);
      if (channel % 2 === (channels >= 6 ? 0 : 1)) left += sample;
      else right += sample;
    }
  }
  output[offset] += left * gain;
  output[offset + 1] += right * gain;
}

/** 在两个 PCM 采样之间插值。 */
function interpolate(data: Float32Array, first: number, next: number, fraction: number): number {
  return data[first] + (data[next] - data[first]) * fraction;
}

/** 有界的时间窗口混音。编码的时间戳由累计采样数推导。 */
export class ExportAudioMixer {
  private readonly clips: Array<{ clip: ExportAudioClip; cursor: AudioCursor }>;
  private nextSample = 0;

  constructor(audio: readonly ExportAudioClip[], media: ExportMedia) {
    this.clips = audio.flatMap((clip) => {
      const source = media.audio(clip);
      return source ? [{ clip, cursor: new AudioCursor(clip, source.track, source.start) }] : [];
    });
  }

  /** 纯视频工程省去 AAC 轨。 */
  get hasAudio(): boolean {
    return this.clips.length > 0;
  }

  /** 写到当前视频窗口末尾，最后一个窗口以主轨末端为上限。 */
  async writeUntil(endTime: number, source: AudioSampleSource, signal: AbortSignal): Promise<void> {
    const { sampleRate, numberOfChannels } = EXPORT_AUDIO;
    const first = this.nextSample;
    const last = Math.floor(endTime * sampleRate + 1e-7);
    if (last <= first) return;
    const pcm = new Float32Array((last - first) * numberOfChannels);
    for (const { clip, cursor } of this.clips) {
      if (clip.startTime < endTime && clip.endTime > first / sampleRate) await cursor.mix(pcm, first, last, signal);
      if (clip.endTime <= endTime) cursor.close();
    }
    for (let index = 0; index < pcm.length; index += 1) pcm[index] = Math.max(-1, Math.min(1, pcm[index]));
    signal.throwIfAborted();
    const sample = new AudioSample({ data: pcm, format: "f32", numberOfChannels, sampleRate, timestamp: first / sampleRate });
    try {
      await source.add(sample);
      this.nextSample = last;
    } finally {
      sample.close();
    }
  }

  /** 取消时清掉还未到末端的解码器。 */
  dispose(): void {
    for (const { cursor } of this.clips) cursor.close();
  }
}
