/**
 * 媒体处理工具
 * 使用 @webav/av-cliper 提取视频缩略图和音频波形数据
 */
import { MP4Clip, AudioClip } from '@webav/av-cliper';
import type { ResolveMediaUrl } from '../../service/resolveComposeMediaUrl';

/** 先按会话解析跨域地址，再 fetch 媒体字节 */
async function fetchMediaBody(url: string, resolve?: ResolveMediaUrl): Promise<ReadableStream<Uint8Array>> {
  const target = resolve ? await resolve(url) : url;
  const response = await fetch(target);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch media: ${response.statusText}`);
  }
  return response.body;
}

// 缓存已处理的媒体数据
const thumbnailCache = new Map<string, ThumbnailResult>();
const pendingThumbnails = new Map<string, Promise<ThumbnailResult>>();
const waveformCache = new Map<string, number[]>();
const durationCache = new Map<string, number>();

/**
 * 视频缩略图提取结果
 */
export interface ThumbnailResult {
  /** 可供多个 Clip 独立创建展示 URL 的原始图片。 */
  frames: readonly Blob[];
  duration: number; // 视频时长（秒）
}

/**
 * 音频波形提取结果
 */
export interface WaveformResult {
  waveformData: number[]; // 归一化的波形数据 (0-1)
  duration: number; // 音频时长（秒）
}

/**
 * 按素材和抽帧规格复用结果，同一规格的并发请求只解码一次。
 * @param videoUrl 视频 URL
 * @param options 配置选项
 * @returns 缩略图结果
 */
export async function extractVideoThumbnails(
  videoUrl: string,
  options: {
    /** 提取的缩略图数量 */
    count?: number;
    /** 缩略图宽度 */
    width?: number;
    /** 跨域地址先解析成可 fetch 的 URL */
    resolve?: ResolveMediaUrl;
  } = {},
): Promise<ThumbnailResult> {
  const { count = 10, width = 120, resolve } = options;
  const cacheKey = `${videoUrl}_${count}_${width}`;
  const cached = thumbnailCache.get(cacheKey);
  if (cached) return cached;

  const pending = pendingThumbnails.get(cacheKey);
  if (pending) return pending;

  const request = decodeVideoThumbnails(videoUrl, count, width, resolve).catch((error: unknown): ThumbnailResult => {
    console.error("Error extracting thumbnails:", error);
    return { frames: [], duration: 0 };
  });
  pendingThumbnails.set(cacheKey, request);
  try {
    const result = await request;
    if (pendingThumbnails.get(cacheKey) === request && result.frames.length > 0) {
      thumbnailCache.set(cacheKey, result);
      durationCache.set(videoUrl, result.duration);
    }
    return result;
  } finally {
    if (pendingThumbnails.get(cacheKey) === request) pendingThumbnails.delete(cacheKey);
  }
}

/** 对完整视频抽帧，结果不依赖某个时间轴 Clip 的裁剪区间。 */
async function decodeVideoThumbnails(videoUrl: string, count: number, width: number, resolve?: ResolveMediaUrl): Promise<ThumbnailResult> {
  const body = await fetchMediaBody(videoUrl, resolve);
  const clip = new MP4Clip(body);
  try {
    await clip.ready;
    const durationUs = clip.meta.duration;
    const thumbnails = await clip.thumbnails(width, {
      start: 0,
      end: durationUs,
      step: Math.max(durationUs / count, 100_000),
    });
    return { frames: thumbnails.map((thumbnail) => thumbnail.img), duration: durationUs / 1e6 };
  } finally {
    clip.destroy();
  }
}

/**
 * 从音频/视频中提取波形数据
 * @param audioUrl 音频/视频 URL
 * @param options 配置选项
 * @returns 波形数据结果
 */
export async function extractAudioWaveform(
  audioUrl: string,
  options: {
    samples?: number; // 采样点数量
    /** 跨域地址先解析成可 fetch 的 URL */
    resolve?: ResolveMediaUrl;
  } = {}
): Promise<WaveformResult> {
  const { samples = 100, resolve } = options;

  // 检查缓存
  const cacheKey = `${audioUrl}_${samples}`;
  if (waveformCache.has(cacheKey)) {
    return {
      waveformData: waveformCache.get(cacheKey)!,
      duration: durationCache.get(audioUrl) || 0,
    };
  }

  try {
    const body = await fetchMediaBody(audioUrl, resolve);

    // 创建 AudioClip 实例
    const clip = new AudioClip(body);
    await clip.ready;

    // 获取音频时长
    const duration = clip.meta.duration / 1e6;

    // 获取 PCM 数据
    const pcmData = clip.getPCMData();

    // 处理波形数据
    const waveformData = processWaveformData(pcmData, samples);

    // 销毁 clip
    clip.destroy();

    // 缓存结果
    waveformCache.set(cacheKey, waveformData);
    durationCache.set(audioUrl, duration);

    return { waveformData, duration };
  } catch (error) {
    console.error('Error extracting waveform:', error);
    return { waveformData: [], duration: 0 };
  }
}

/**
 * 从视频中提取音频波形数据
 * @param videoUrl 视频 URL
 * @param options 配置选项
 * @returns 波形数据结果
 */
export async function extractVideoAudioWaveform(
  videoUrl: string,
  options: {
    samples?: number;
    /** 跨域地址先解析成可 fetch 的 URL */
    resolve?: ResolveMediaUrl;
  } = {}
): Promise<WaveformResult> {
  const { samples = 100, resolve } = options;

  const cacheKey = `video_audio_${videoUrl}_${samples}`;
  if (waveformCache.has(cacheKey)) {
    return {
      waveformData: waveformCache.get(cacheKey)!,
      duration: durationCache.get(videoUrl) || 0,
    };
  }

  try {
    const body = await fetchMediaBody(videoUrl, resolve);

    // 使用 MP4Clip 来获取视频中的音频
    const clip = new MP4Clip(body);
    await clip.ready;

    const duration = clip.meta.duration / 1e6;

    // 通过 tick 方法采样音频数据
    const waveformData: number[] = [];
    const step = (duration * 1e6) / samples;

    for (let i = 0; i < samples; i++) {
      const time = i * step;
      try {
        const { audio } = await clip.tick(Math.floor(time));
        if (audio && audio.length > 0) {
          // 计算这个采样点的音量
          let sum = 0;
          let count = 0;
          for (const channel of audio) {
            for (let j = 0; j < channel.length; j++) {
              sum += Math.abs(channel[j]);
              count++;
            }
          }
          waveformData.push(count > 0 ? sum / count : 0);
        } else {
          waveformData.push(0);
        }
      } catch {
        waveformData.push(0);
      }
    }

    // 归一化
    const maxVal = Math.max(...waveformData, 0.001);
    const normalizedData = waveformData.map((v) => v / maxVal);

    clip.destroy();

    waveformCache.set(cacheKey, normalizedData);
    durationCache.set(videoUrl, duration);

    return { waveformData: normalizedData, duration };
  } catch (error) {
    console.error('Error extracting video audio waveform:', error);
    return { waveformData: [], duration: 0 };
  }
}

/**
 * 处理 PCM 数据为波形数据
 * @param pcmData PCM 数据（多通道）
 * @param samples 目标采样点数量
 * @returns 归一化的波形数据
 */
function processWaveformData(
  pcmData: Float32Array[],
  samples: number
): number[] {
  if (!pcmData || pcmData.length === 0) {
    return new Array(samples).fill(0);
  }

  // 合并所有通道
  const totalLength = pcmData[0].length;
  const mergedData = new Float32Array(totalLength);

  for (let i = 0; i < totalLength; i++) {
    let sum = 0;
    for (const channel of pcmData) {
      sum += Math.abs(channel[i] || 0);
    }
    mergedData[i] = sum / pcmData.length;
  }

  // 下采样到目标数量
  const blockSize = Math.floor(totalLength / samples);
  const waveformData: number[] = [];

  for (let i = 0; i < samples; i++) {
    const start = i * blockSize;
    const end = Math.min(start + blockSize, totalLength);
    let sum = 0;
    for (let j = start; j < end; j++) {
      sum += mergedData[j];
    }
    waveformData.push(sum / (end - start));
  }

  // 归一化到 0-1 范围
  const maxVal = Math.max(...waveformData, 0.001);
  return waveformData.map((v) => v / maxVal);
}

/**
 * 获取媒体时长
 * @param url 媒体 URL
 * @param type 媒体类型
 * @returns 时长（秒）
 */
export async function getMediaDuration(
  url: string,
  type: 'video' | 'audio',
  resolve?: ResolveMediaUrl,
): Promise<number> {
  // 检查缓存
  if (durationCache.has(url)) {
    return durationCache.get(url)!;
  }

  try {
    const body = await fetchMediaBody(url, resolve);

    if (type === 'video') {
      const clip = new MP4Clip(body);
      await clip.ready;
      const duration = clip.meta.duration / 1e6;
      clip.destroy();
      durationCache.set(url, duration);
      return duration;
    } else {
      const clip = new AudioClip(body);
      await clip.ready;
      const duration = clip.meta.duration / 1e6;
      clip.destroy();
      durationCache.set(url, duration);
      return duration;
    }
  } catch (error) {
    console.error('Error getting media duration:', error);
    return 0;
  }
}

/**
 * 清除共享媒体结果，展示用 URL 仍由各 Clip 负责释放。
 */
export function clearMediaCache(): void {
  thumbnailCache.clear();
  pendingThumbnails.clear();
  waveformCache.clear();
  durationCache.clear();
}

/**
 * 预加载媒体数据
 * @param url 媒体 URL
 * @param type 媒体类型
 */
export async function preloadMedia(
  url: string,
  type: 'video' | 'audio'
): Promise<void> {
  if (type === 'video') {
    await extractVideoThumbnails(url);
  } else {
    await extractAudioWaveform(url);
  }
}
