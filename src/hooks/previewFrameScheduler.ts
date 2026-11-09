import type { PreparedPreviewFrame } from "@/types/previewPlayback";

/** 与既有时间轴一致的输出帧率；媒体自身帧率可不同。 */
export const PREVIEW_FPS = 30;
/** 完成帧缓存和恢复水位，解码/处理不在展示截止时间后才启动。 */
export const PREVIEW_QUEUE_LIMIT = 6;
export const PREVIEW_RESUME_FRAMES = 3;

/** 只管理完成帧和可冻结时钟，不依赖 Vue、解码器或音频实现。 */
export class PreviewFrameScheduler {
  private frames: PreparedPreviewFrame[] = [];
  private anchorTime = 0;
  private anchorWall = 0;
  private presentedEnd = 0;
  private frozenTime = 0;
  private rate = 1;
  running = false;
  productionEnded = false;

  get size(): number {
    return this.frames.length;
  }

  get full(): boolean {
    return this.size >= PREVIEW_QUEUE_LIMIT;
  }

  get ready(): boolean {
    return this.size >= PREVIEW_RESUME_FRAMES || (this.productionEnded && this.size > 0);
  }

  /** 新控制操作释放旧帧，位置仅在后续 present 成功时对外发布。 */
  reset(time: number, rate: number): void {
    for (const frame of this.frames) frame.bitmap?.close();
    this.frames = [];
    this.anchorTime = this.frozenTime = this.presentedEnd = time;
    this.rate = rate;
    this.running = false;
    this.productionEnded = false;
  }

  /** 入队即转移所有权，满队列不接受额外输出。 */
  enqueue(frame: PreparedPreviewFrame): void {
    if (this.full) throw new Error("预览完成帧队列已满");
    this.frames.push(frame);
  }

  /** 暂停、缓冲和恢复均以逻辑时间重新锚定，排除等待耗时。 */
  freeze(now: number): void {
    this.frozenTime = this.time(now);
    this.running = false;
  }

  resume(now: number): void {
    this.anchorTime = this.frozenTime;
    this.anchorWall = now;
    this.running = true;
  }

  /** 音频只能走到当前已经提交画面的有效区间末端。 */
  time(now: number): number {
    if (!this.running) return this.frozenTime;
    return Math.min(this.presentedEnd, this.anchorTime + ((now - this.anchorWall) / 1000) * this.rate);
  }

  /** 一次只提交最早到期帧，长任务后重新锚定，禁止丢掉积压帧追赶墙钟。 */
  takeDue(now: number): PreparedPreviewFrame | null {
    if (!this.running) return null;
    const deadline = this.anchorTime + ((now - this.anchorWall) / 1000) * this.rate;
    const frame = this.frames[0];
    if (!frame || frame.time > deadline + 1e-6) return null;
    if (deadline > frame.time + frame.duration) {
      this.anchorTime = frame.time;
      this.anchorWall = now;
    }
    return this.frames.shift()!;
  }

  /** 仅在 Canvas 写入成功后确认；暂停定位也通过此接口建立首帧区间。 */
  presented(frame: PreparedPreviewFrame): void {
    this.presentedEnd = frame.time + frame.duration;
  }

  /** 没有下一帧且当前有效区间已播完，才进入缓冲或结束。 */
  exhausted(now: number): boolean {
    return this.running && !this.frames.length && this.time(now) >= this.presentedEnd - 1e-6;
  }
}
