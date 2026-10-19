import { clampGain } from "@/editor/volumeDb";

/** 小于该差值视为同一增益，避免每帧重写音量 */
const GAIN_EPSILON = 1e-6;

const bound = new WeakMap<HTMLMediaElement, GainNode>();

let sharedCtx: AudioContext | null = null;

/** 增益差是否小到可以跳过写入 */
function sameGain(a: number, b: number): boolean {
  return Math.abs(a - b) < GAIN_EPSILON;
}

/** 预览共用的 AudioContext；浏览器不支持时返回 null */
function ensureContext(): AudioContext | null {
  if (sharedCtx) return sharedCtx;
  const Ctx = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  sharedCtx = new Ctx();
  return sharedCtx;
}

/**
 * 在用户手势（播放、按下音量滑块）里恢复 AudioContext。
 * 大于 0 dB 的放大依赖这条上下文，挂起时预览听不到增益。
 */
export function primePreviewAudioContext(): void {
  const ctx = ensureContext();
  if (ctx && ctx.state === "suspended") {
    void ctx.resume();
  }
}

/** 把媒体元素接入 GainNode。接入后不能拆开，之后衰减也走该节点 */
function attachGainNode(el: HTMLMediaElement): GainNode | null {
  const ctx = ensureContext();
  if (!ctx) return null;
  const source = ctx.createMediaElementSource(el);
  const gain = ctx.createGain();
  gain.gain.value = 1;
  source.connect(gain);
  gain.connect(ctx.destination);
  bound.set(el, gain);
  return gain;
}

/**
 * 把线性增益应用到预览媒体。
 * ≤ 1 且尚未接入节点时写 element.volume；大于 1 时改走 GainNode（element.volume 固定为 1）。
 */
export function applyPreviewGain(el: HTMLMediaElement, gain: number): void {
  const next = clampGain(gain);
  const node = bound.get(el);
  if (!node) {
    if (next <= 1) {
      if (!sameGain(el.volume, next)) el.volume = next;
      return;
    }
    let created: GainNode | null = null;
    try {
      created = attachGainNode(el);
    } catch {
      created = null;
    }
    if (!created) {
      if (el.volume !== 1) el.volume = 1;
      return;
    }
    el.volume = 1;
    created.gain.value = next;
    void (created.context as any).resume();
    return;
  }
  if (el.volume !== 1) el.volume = 1;
  if (!sameGain(node.gain.value, next)) node.gain.value = next;
}
