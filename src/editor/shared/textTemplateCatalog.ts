/** 侧栏文字模板：默认空目录；mock 或上传时写入，不请求素材库 */

import { shallowRef } from "vue";
import { getMockTextTemplateFiles, isVideoComposeMockEnabled } from "./videoComposeMockClips";

/** 文字模板目录中的一项资源 */
export interface TextTemplateItem {
  /** 模板 id，写入 clip.config.templateId */
  id: string;
  /** 侧栏卡片标题 */
  name: string;
  /** SVG 默认文案 */
  defaultText: string;
  /** SVG 默认填充色 */
  defaultColor: string;
  /** SVG 默认字号（px） */
  defaultFontSize: number;
  /** viewBox 宽 */
  viewBoxW: number;
  /** viewBox 高 */
  viewBoxH: number;
  /** 缩略图地址（打包后的本地资源） */
  url: string;
  /** 模板地址，写入 clip.config.sourceUrl */
  sourceUrl: string;
  /** 原始 SVG 字符串 */
  raw: string;
}

/** 已加载的文字模板列表 */
export const textTemplateCatalog = shallowRef<TextTemplateItem[]>([]);

/** 按 sourceUrl / id 缓存的 SVG 原文 */
const svgRawCache = new Map<string, string>();

function parseViewBoxSize(raw: string): { w: number; h: number } {
  const match = raw.match(/viewBox\s*=\s*"([^"]+)"/i);
  if (match?.[1]) {
    const parts = match[1]
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { w: parts[2], h: parts[3] };
    }
  }
  const width = Number((raw.match(/\bwidth\s*=\s*"([\d.]+)"/i) || [])[1]);
  const height = Number((raw.match(/\bheight\s*=\s*"([\d.]+)"/i) || [])[1]);
  if (width > 0 && height > 0) return { w: width, h: height };
  return { w: 1, h: 1 };
}

function parseFirstTextDefaults(raw: string): { text: string; color: string; fontSize: number } {
  if (typeof DOMParser === "undefined") {
    return { text: "", color: "#000000", fontSize: 32 };
  }
  const doc = new DOMParser().parseFromString(raw, "image/svg+xml");
  const primary = doc.querySelector("text");
  if (!primary) {
    return { text: "", color: "#000000", fontSize: 32 };
  }
  const style = primary.getAttribute("style") || "";
  const fillAttr = primary.getAttribute("fill");
  const fillMatch = style.match(/fill:\s*([^;]+)/i);
  const sizeMatch = style.match(/font-size:\s*([\d.]+)px/i);
  const color = (fillMatch?.[1] || fillAttr || "").trim();
  const fontSize = sizeMatch ? Math.max(1, Math.round(Number(sizeMatch[1]))) : 32;
  return {
    text: (primary.textContent || "").trim(),
    color: color || "#000000",
    fontSize,
  };
}

/** 侧栏色板可用的 CSS hex */
export function isCssHexColor(raw: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(raw.trim());
}

/** 从 SVG 原文解析宽高比（w/h） */
export function parseSvgAspect(raw: string): number {
  const { w, h } = parseViewBoxSize(raw);
  if (h <= 0) return 1;
  return w / h;
}

/** 读取已缓存的模板 SVG */
export function getCachedTextTemplateSvg(sourceUrl: string): string {
  const url = sourceUrl.trim();
  if (!url) return "";
  return svgRawCache.get(url) || "";
}

/** 按本地缓存读取模板 SVG，不发网络请求 */
export function loadTextTemplateSvg(sourceUrl: string): Promise<string> {
  return Promise.resolve(getCachedTextTemplateSvg(sourceUrl));
}

/** 解析 SVG 并写入原文缓存，供拖入贴图轨后读取 */
function buildTemplate(id: string, name: string, raw: string, url: string): TextTemplateItem {
  const defaults = parseFirstTextDefaults(raw);
  const viewBox = parseViewBoxSize(raw);
  svgRawCache.set(url, raw);
  svgRawCache.set(id, raw);
  return {
    id,
    name,
    defaultText: defaults.text || name,
    defaultColor: defaults.color,
    defaultFontSize: defaults.fontSize,
    viewBoxW: viewBox.w,
    viewBoxH: viewBox.h,
    url,
    sourceUrl: url,
    raw,
  };
}

/** 把本地 SVG 追加进当前会话的花字列表。刷新页面后消失 */
export async function appendUploadedTextTemplate(file: File): Promise<TextTemplateItem> {
  const fileName = file.name.trim();
  const isSvg = file.type === "image/svg+xml" || fileName.toLowerCase().endsWith(".svg");
  if (!isSvg) {
    throw new Error("请上传 SVG 文件");
  }
  const raw = (await file.text()).trim();
  if (!/<svg[\s>]/i.test(raw)) {
    throw new Error("文件不是有效的 SVG");
  }
  const baseName = fileName.replace(/\.svg$/i, "").trim() || "花字";
  const id = `upload-fancy-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const url = URL.createObjectURL(new Blob([raw], { type: "image/svg+xml" }));
  const item = buildTemplate(id, baseName, raw, url);
  textTemplateCatalog.value = [...textTemplateCatalog.value, item];
  return item;
}

/** 返回文字模板；mock 开且目录为空时注入调试花字 */
export async function loadTextTemplateCatalog(): Promise<TextTemplateItem[]> {
  if (isVideoComposeMockEnabled() && textTemplateCatalog.value.length === 0) {
    textTemplateCatalog.value = getMockTextTemplateFiles().map((file) => buildTemplate(file.id, file.id, file.raw, file.url));
  }
  return textTemplateCatalog.value;
}

/** 宿主经 props 注入的花字（优先于会话目录） */
let hostTextTemplates: TextTemplateItem[] = [];

/** 同步宿主花字进查找缓存，供拖入贴图轨 / 预览按 id 解析 */
export function setHostTextTemplates(items: TextTemplateItem[] | undefined): void {
  hostTextTemplates = items ?? [];
  for (const item of hostTextTemplates) {
    if (!item.raw?.trim()) continue;
    svgRawCache.set(item.id, item.raw);
    if (item.url?.trim()) svgRawCache.set(item.url.trim(), item.raw);
    if (item.sourceUrl?.trim()) svgRawCache.set(item.sourceUrl.trim(), item.raw);
  }
}

/** 按 templateId 查找资源（先宿主 props，再会话目录） */
export function findTextTemplateById(templateId: string): TextTemplateItem | undefined {
  if (!templateId) return undefined;
  const needle = templateId.trim().toLowerCase();
  const fromHost = hostTextTemplates.find((item) => item.id.toLowerCase() === needle);
  if (fromHost) return fromHost;
  return textTemplateCatalog.value.find((item) => item.id.toLowerCase() === needle);
}

/** 模板宽高比（w/h），缺省 1 */
export function getTextTemplateAspect(templateId: string): number {
  const item = findTextTemplateById(templateId);
  if (!item || item.viewBoxH <= 0) return 1;
  return item.viewBoxW / item.viewBoxH;
}
