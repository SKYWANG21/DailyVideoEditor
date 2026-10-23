import type { InjectionKey } from "vue";

/** 把业务媒体地址解析成可 fetch / 可画到 canvas 的地址 */
export type ResolveMediaUrl = (url: string) => Promise<string>;

/** 编辑器向时间轴、预览注入的解析器 */
export const COMPOSE_MEDIA_RESOLVER: InjectionKey<ComposeMediaResolver> = Symbol("composeMediaResolver");

/** 一次编辑器会话的媒体地址缓存 */
export interface ComposeMediaResolver {
  /** 同源、blob、data，或已经解析过的地址。跨域且未完成时返回 null */
  peek: (url: string) => string | null;
  /** 解析地址。跨域默认拉成 blob；失败抛出说明 */
  resolve: (url: string) => Promise<string>;
  /** 释放本次会话创建的 blob URL */
  revokeAll: () => void;
}

export interface CreateComposeMediaResolverOptions {
  /** 宿主自定义解析。只用于跨域地址，常返回同源代理或 blob: */
  resolve?: ResolveMediaUrl;
  /** 每次解析时读取宿主函数，便于 prop 晚到 */
  getResolve?: () => ResolveMediaUrl | undefined;
  /** 解析失败时提示（每个原始 URL 只回调一次） */
  onError?: (message: string) => void;
}

/**
 * 创建会话级媒体解析器。
 * blob / data / 同源地址原样返回；跨域先走宿主 resolve，否则 fetch 成 blob。
 */
export function createComposeMediaResolver(options: CreateComposeMediaResolverOptions = {}): ComposeMediaResolver {
  const cache = new Map<string, string>();
  const inflight = new Map<string, Promise<string>>();
  const ownedBlobs: string[] = [];
  const reported = new Set<string>();

  function peek(url: string): string | null {
    const trimmed = url.trim();
    if (!trimmed) return "";
    if (isPassthroughMediaUrl(trimmed)) return trimmed;
    return cache.get(trimmed) ?? null;
  }

  async function resolve(url: string): Promise<string> {
    const trimmed = url.trim();
    if (!trimmed || isPassthroughMediaUrl(trimmed)) return trimmed;
    const cached = cache.get(trimmed);
    if (cached) return cached;
    const pending = inflight.get(trimmed);
    if (pending) return pending;

    const task = loadCrossOrigin(trimmed, options, ownedBlobs).catch((error: unknown) => {
      const message = error instanceof Error && error.message ? error.message : mediaCorsMessage(trimmed);
      if (!reported.has(trimmed)) {
        reported.add(trimmed);
        options.onError?.(message);
      }
      throw new Error(message);
    });
    inflight.set(trimmed, task);
    try {
      const next = await task;
      cache.set(trimmed, next);
      return next;
    } finally {
      inflight.delete(trimmed);
    }
  }

  function revokeAll(): void {
    for (const blobUrl of ownedBlobs) {
      URL.revokeObjectURL(blobUrl);
    }
    ownedBlobs.length = 0;
    cache.clear();
    inflight.clear();
  }

  return { peek, resolve, revokeAll };
}

/** 元素当前 src 是否已经是目标地址（含相对路径补全） */
export function mediaElementUsesUrl(el: HTMLMediaElement, url: string): boolean {
  if (!url) return false;
  if (el.src === url) return true;
  try {
    return el.src === new URL(url, window.location.href).href;
  } catch {
    return false;
  }
}

/**
 * blob / data 不走 CORS 模式；http(s) 使用 anonymous，便于 canvas 抽帧。
 */
export function applyMediaCrossOrigin(el: HTMLMediaElement, resolvedUrl: string): void {
  if (resolvedUrl.startsWith("blob:") || resolvedUrl.startsWith("data:")) {
    el.crossOrigin = null;
    return;
  }
  el.crossOrigin = "anonymous";
}

/**
 * 解析后写入 media.src，并按地址类型设置 crossOrigin。
 * @returns src 是否发生变化
 */
export async function assignResolvedMediaSrc(
  el: HTMLMediaElement,
  url: string,
  resolver: ComposeMediaResolver,
): Promise<boolean> {
  const resolved = await resolver.resolve(url);
  if (!resolved) return false;
  applyMediaCrossOrigin(el, resolved);
  const changed = !mediaElementUsesUrl(el, resolved);
  if (changed) el.src = resolved;
  return changed;
}

/** blob、data、同源地址不需要再代理 */
export function isPassthroughMediaUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("blob:") || trimmed.startsWith("data:")) return true;
  if (typeof window === "undefined") return true;
  try {
    return new URL(trimmed, window.location.href).origin === window.location.origin;
  } catch {
    return true;
  }
}

/** 跨域失败时给界面的说明 */
export function mediaCorsMessage(url: string): string {
  return `媒体无法跨域读取（${url}）。请为资源开启 CORS，或传入 resolveMediaUrl 走同源代理。`;
}

async function loadCrossOrigin(
  url: string,
  options: CreateComposeMediaResolverOptions,
  ownedBlobs: string[],
): Promise<string> {
  const custom = options.getResolve?.() ?? options.resolve;
  if (custom) {
    const next = (await custom(url)).trim();
    if (!next) throw new Error(mediaCorsMessage(url));
    return next;
  }
  return fetchAsBlobUrl(url, ownedBlobs);
}

async function fetchAsBlobUrl(url: string, ownedBlobs: string[]): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, { mode: "cors", credentials: "omit" });
  } catch {
    throw new Error(mediaCorsMessage(url));
  }
  if (!response.ok) throw new Error(mediaCorsMessage(url));
  const blobUrl = URL.createObjectURL(await response.blob());
  ownedBlobs.push(blobUrl);
  return blobUrl;
}
