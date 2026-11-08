/** 视频加载、定位及快照等待的统一超时 */
export const VIDEO_FRAME_TIMEOUT_MS = 8000;

/** 等待真实媒体状态；超时、媒体错误和取消都不能冒充成功 */
export function waitForPreviewMedia(video: HTMLMediaElement, ready: () => boolean, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const events = ["loadedmetadata", "loadeddata", "canplay", "seeked"];
    /** 结束等待并移除全部监听与超时 */
    const finish = (error?: Error): void => {
      window.clearTimeout(timer);
      for (const event of events) video.removeEventListener(event, check);
      video.removeEventListener("error", fail);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    /** 只在目标状态成立时完成 */
    const check = (): void => {
      if (signal.aborted) abort();
      else if (video.error) fail();
      else if (ready()) finish();
    };
    /** 媒体读取失败时保留上一次画面 */
    const fail = (): void => finish(new Error(video.error?.message || "视频画面读取失败"));
    /** 控制操作作废旧等待 */
    const abort = (): void => finish(new DOMException("预览请求已取消", "AbortError"));
    const timer = window.setTimeout(() => finish(new Error("等待视频画面超时（8 秒）")), VIDEO_FRAME_TIMEOUT_MS);
    for (const event of events) video.addEventListener(event, check);
    video.addEventListener("error", fail);
    signal.addEventListener("abort", abort, { once: true });
    check();
  });
}

/** 定位活动视频，等待 seeked 和可用像素后才允许快照 */
export async function seekPreviewVideo(video: HTMLMediaElement, sourceSec: number, signal: AbortSignal): Promise<void> {
  await waitForPreviewMedia(video, () => video.readyState >= HTMLMediaElement.HAVE_METADATA, signal);
  if (signal.aborted) throw new DOMException("预览请求已取消", "AbortError");
  // 片尾保持最后有效像素，不能 seek 到 duration 之后的无帧位置。
  const target = Number.isFinite(video.duration) ? Math.max(0, Math.min(sourceSec, video.duration - 0.001)) : Math.max(0, sourceSec);
  if (Math.abs(video.currentTime - target) > 0.000001) video.currentTime = target;
  await waitForPreviewMedia(video, () => !video.seeking && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA, signal);
}
