import { MP4Clip } from "@webav/av-cliper";

interface LoadedClip {
  /** 打开时的地址。地址变了要重新解封装 */
  url: string;
  /** WebCodecs 片段 */
  clip: MP4Clip;
}

/**
 * 同时最多保留两段已打开的 MP4，对应活动段和预载段。
 */
export class DecodeSession {
  private readonly clips = new Map<string, LoadedClip>();
  private readonly loading = new Map<string, Promise<MP4Clip>>();
  private readonly busy = new Map<string, number>();
  private order: string[] = [];

  /**
   * 取指定时间的视频帧。调用方负责 close。
   * @param clipId 片段 id
   * @param url 视频地址
   * @param sourceTimeUs 源时间（微秒）
   */
  async tick(clipId: string, url: string, sourceTimeUs: number): Promise<VideoFrame | null> {
    const clip = await this.acquire(clipId, url);
    this.addBusy(clipId, 1);
    try {
      const result = await clip.tick(Math.max(0, sourceTimeUs));
      return result.video ?? null;
    } finally {
      this.addBusy(clipId, -1);
      this.evict();
    }
  }

  /** 提前打开下一段，不取帧 */
  prefetch(clipId: string, url: string): void {
    void this.acquire(clipId, url).catch(() => undefined);
  }

  /** 关闭全部解码器 */
  destroy(): void {
    for (const slot of this.clips.values()) slot.clip.destroy();
    this.clips.clear();
    this.loading.clear();
    this.order = [];
  }

  /** 打开或复用一段。同一 id 地址变化时先关掉旧的 */
  private async acquire(clipId: string, url: string): Promise<MP4Clip> {
    const cached = this.clips.get(clipId);
    if (cached?.url === url) {
      this.touch(clipId);
      return cached.clip;
    }
    const pending = this.loading.get(clipId);
    if (pending) return pending;
    const task = this.open(clipId, url);
    this.loading.set(clipId, task);
    try {
      return await task;
    } finally {
      if (this.loading.get(clipId) === task) this.loading.delete(clipId);
    }
  }

  /** fetch 后创建 MP4Clip，并挤掉更早且空闲的段 */
  private async open(clipId: string, url: string): Promise<MP4Clip> {
    const previous = this.clips.get(clipId);
    if (previous && (this.busy.get(clipId) ?? 0) === 0) {
      previous.clip.destroy();
      this.clips.delete(clipId);
    }
    const response = await fetch(url).catch(() => {
      throw new Error("无法读取视频，请确认网络或跨域权限");
    });
    if (!response.ok || !response.body) {
      throw new Error("无法读取视频");
    }
    const clip = new MP4Clip(response.body);
    await clip.ready;
    this.clips.set(clipId, { url, clip });
    this.touch(clipId);
    this.evict();
    return clip;
  }

  /** 把 id 移到最近使用的末尾 */
  private touch(clipId: string): void {
    this.order = this.order.filter((id) => id !== clipId);
    this.order.push(clipId);
  }

  /** 超过两段时关掉最久且当前没有 tick 的一段 */
  private evict(): void {
    while (this.order.length > 2) {
      const victim = this.order.find((id) => (this.busy.get(id) ?? 0) === 0);
      if (!victim) return;
      this.order = this.order.filter((id) => id !== victim);
      const slot = this.clips.get(victim);
      slot?.clip.destroy();
      this.clips.delete(victim);
    }
  }

  /** 增减某段正在进行的 tick 计数 */
  private addBusy(clipId: string, delta: number): void {
    const next = (this.busy.get(clipId) ?? 0) + delta;
    if (next <= 0) this.busy.delete(clipId);
    else this.busy.set(clipId, next);
  }
}
