import { rasterizeSvgFrame } from "@/editor/player/frameCaptureOverlay";
import type { ExportSticker, ExportStickerFrameRequest } from "./exportProtocol";

/** 每个花字独立隔离 CSS 和动画关键帧。 */
interface StickerRuntime {
  host: HTMLDivElement;
  svg: SVGSVGElement;
  animations: Animation[];
}

/** 页面端按视频时间采样花字，只保留模板 DOM 和任务内资源缓存。 */
export class ExportStickerSampler {
  private readonly clips: Map<string, ExportSticker>;
  private readonly runtimes = new Map<string, StickerRuntime>();
  private readonly loads = new Map<string, Promise<string>>();

  constructor(
    stickers: ExportSticker[],
    private readonly signal: AbortSignal,
  ) {
    this.clips = new Map(stickers.map((clip) => [clip.id, clip]));
  }

  /** 已暂停的动画按局部时间定位，采样速度不影响动效进度。 */
  async sample(request: ExportStickerFrameRequest): Promise<ImageBitmap> {
    this.signal.throwIfAborted();
    let runtime = this.runtimes.get(request.clipId);
    if (!runtime) runtime = await this.prepare(request);
    this.signal.throwIfAborted();
    const time = Math.max(0, request.time);
    for (const animation of runtime.animations) animation.currentTime = time * 1000;
    runtime.svg.setCurrentTime(time);
    return rasterizeSvgFrame(runtime.svg, request.width, request.height, this.signal, this.loads);
  }

  /** 模板只挂载一次，离屏容器参与布局，Shadow DOM 隔离宿主样式。 */
  private async prepare(request: ExportStickerFrameRequest): Promise<StickerRuntime> {
    const clip = this.clips.get(request.clipId);
    if (!clip || clip.kind !== "animated") throw new Error("导出花字模板不存在");
    const parsed = new DOMParser().parseFromString(clip.svg, "image/svg+xml");
    if (parsed.documentElement.localName !== "svg" || parsed.querySelector("parsererror")) throw new Error("花字模板的 SVG 无法解析");
    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;left:-100000px;top:0;pointer-events:none";
    host.setAttribute("aria-hidden", "true");
    const shadow = host.attachShadow({ mode: "closed" });
    const svg = document.importNode(parsed.documentElement, true) as unknown as SVGSVGElement;
    // 模板只作为图形使用，禁止脚本和事件在独立导出容器执行。
    svg.querySelectorAll("script").forEach((node) => node.remove());
    for (const element of [svg, ...Array.from(svg.querySelectorAll("*"))]) {
      for (const attribute of [...element.attributes]) {
        if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
      }
    }
    svg.setAttribute("width", String(request.width));
    svg.setAttribute("height", String(request.height));
    svg.style.width = `${request.width}px`;
    svg.style.height = `${request.height}px`;
    shadow.append(svg);
    document.body.append(host);
    const runtime: StickerRuntime = { host, svg, animations: [] };
    this.runtimes.set(clip.id, runtime);
    svg.pauseAnimations();
    svg.setCurrentTime(0);
    runtime.animations = [...new Set([svg, ...Array.from(svg.querySelectorAll("*"))].flatMap((element) => element.getAnimations()))];
    for (const animation of runtime.animations) {
      animation.currentTime = 0;
      animation.pause();
    }
    await Promise.all([document.fonts.ready, ...runtime.animations.map((animation) => animation.ready)]);
    this.signal.throwIfAborted();
    return runtime;
  }

  /** 完成、失败、取消和组件销毁均释放同一组资源。 */
  dispose(): void {
    for (const runtime of this.runtimes.values()) {
      for (const animation of runtime.animations) animation.cancel();
      runtime.host.remove();
    }
    this.runtimes.clear();
    this.clips.clear();
    this.loads.clear();
  }
}
