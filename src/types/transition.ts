/** 持久化到主视频轨的转场；时间单位均为秒。 */
export interface ComposeTransition {
  /** 转场唯一标识。 */
  id: string;
  /** 离场视频片段。 */
  clipAId: string;
  /** 入场视频片段。 */
  clipBId: string;
  /** 注册表中的效果标识。 */
  effectId: string;
  /** 切点两侧共用的转场时长。 */
  durationSec: number;
  /** 效果专属的可序列化参数。 */
  params: Record<string, unknown>;
}

/** 接缝计算所需的最小片段信息。 */
export interface TransitionClipRef {
  /** 稳定片段标识。 */
  id: string;
  /** 媒体类型。 */
  type: string;
  /** 时间轴起点。 */
  startTime: number;
  /** 时间轴终点。 */
  endTime: number;
}

/** 合法的主轨视频接缝。 */
export interface TransitionSeam {
  /** 由有序片段 ID 构成的接缝标识。 */
  key: string;
  /** 离场片段。 */
  clipA: TransitionClipRef;
  /** 入场片段。 */
  clipB: TransitionClipRef;
  /** 时间轴切点。 */
  cut: number;
  /** 防止相邻转场重叠的最大时长。 */
  maxDuration: number;
  /** 当前接缝配置，未添加时为空。 */
  transition?: ComposeTransition;
}

/** 当前采样命中的转场。 */
export interface TransitionSample extends TransitionSeam {
  /** 已添加的配置。 */
  transition: ComposeTransition;
  /** 转场窗口开始。 */
  start: number;
  /** 转场窗口结束，不包含此时间点。 */
  end: number;
  /** 尚未缓动的线性进度。 */
  progress: number;
}

/** 算法只能绘制输入，不负责解码、计时或关闭调用方的帧。 */
export interface TransitionRenderContext {
  /** 引擎隔离状态后的输出上下文。 */
  ctx: OffscreenCanvasRenderingContext2D;
  /** 离场画面。 */
  outgoing: CanvasImageSource;
  /** 入场画面。 */
  incoming: CanvasImageSource;
  /** 目标画布宽度。 */
  width: number;
  /** 目标画布高度。 */
  height: number;
  /** 限制并缓动后的进度。 */
  progress: number;
}

/** 可独立加载的具体绘制算法。 */
export interface TransitionAlgorithm {
  /** 在当前帧上下文中绘制；实例可供多个引擎共用，异步实现须支持重入且不保留调用方的帧或上下文。 */
  render(context: TransitionRenderContext, params: Readonly<Record<string, unknown>>): void | Promise<void>;
}

/** 内置淡化的执行后端；其余内置效果固定使用 Canvas，不写入工程数据。 */
export type TransitionBackend = "canvas" | "wasm";

/** 创建后固定内置后端与效果列表，避免同一效果的加载缓存混用。 */
export interface TransitionRegistryOptions {
  /** 内置淡化默认使用 Canvas；新增内置效果始终使用 Canvas。 */
  backend?: TransitionBackend;
  /** 按传入顺序追加的宿主效果；重复 ID 报错，具体实现由各自的 load 决定。 */
  effects?: readonly TransitionEffectDefinition[];
}

/** 无宿主导入的转场 WASM ABI；图像均为紧密排列、非预乘的 sRGB RGBA8。 */
export interface WasmTransitionExports {
  /** 输入、输出和参数共用的 wasm32 线性内存。 */
  memory: WebAssembly.Memory;
  /** 静态数据与栈之后的首个可用字节，由宿主保留为帧缓冲。 */
  __heap_base: WebAssembly.Global;
  /** 进度已经缓动；参数为 UTF-8 JSON；返回 0 表示成功。 */
  render(
    a: number,
    b: number,
    output: number,
    width: number,
    height: number,
    progress: number,
    params: number,
    paramsLength: number,
  ): number;
}

/** 轻量效果目录；UI 展示无需提前加载绘制算法。 */
export interface TransitionEffectDefinition {
  /** 稳定效果标识。 */
  id: string;
  /** 界面名称。 */
  name: string;
  /** 界面说明。 */
  description: string;
  /** 默认参数。 */
  defaultParams: Readonly<Record<string, unknown>>;
  /** 将工程参数收束为合法参数。 */
  normalizeParams(value: Readonly<Record<string, unknown>>): Record<string, unknown>;
  /** 按需加载算法。 */
  load(): Promise<TransitionAlgorithm>;
}

/** 引擎的单帧绘制请求。 */
export interface TransitionRenderRequest {
  /** 已注册的效果。 */
  effectId: string;
  /** 输入画面。 */
  outgoing: CanvasImageSource;
  /** 输入画面。 */
  incoming: CanvasImageSource;
  /** 目标宽度。 */
  width: number;
  /** 目标高度。 */
  height: number;
  /** 线性进度。 */
  progress: number;
  /** 已持久化的效果参数。 */
  params: Record<string, unknown>;
}
