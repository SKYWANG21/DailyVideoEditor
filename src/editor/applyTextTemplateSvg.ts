/** 将 TextClip 的 text / color / fontSize 写回模板 SVG，供预览 overlay 使用 */

/** 改写模板时的文案 / 样式 / 本 clip 的 id 前缀 */
export interface ApplyTextTemplateSvgOptions {
  /** 贴图展示文案 */
  text: string;
  /** 文字颜色；null 时沿用模板 fill */
  color: string | null;
  /** 字号 px */
  fontSize: number;
  /** 本 clip 稳定前缀，避免同模板多实例撞 id */
  idPrefix: string;
}

/** 单个 id 的旧值 → 带前缀新值 */
interface IdRewrite {
  from: string;
  to: string;
}

/**
 * 改写主 text 节点的 style。
 * color 为空时不改 fill，沿用素材 SVG 原色。
 */
function patchStyle(el: Element, fontSize: number, fill?: string | null): void {
  if (fill) {
    el.setAttribute("fill", fill);
  }
  const prev = el.getAttribute("style") || "";
  let cleaned = prev.replace(/font-size\s*:\s*[^;]*;?/gi, "");
  if (fill) {
    cleaned = cleaned.replace(/fill\s*:\s*[^;]*;?/gi, "");
  }
  cleaned = cleaned.replace(/;{2,}/g, ";").replace(/^;|;$/g, "").trim();
  const next = [cleaned, fill ? `fill:${fill}` : "", `font-size:${fontSize}px`].filter(Boolean).join(";");
  el.setAttribute("style", next);
}

/** 将 clip.id 收成 XML 可用的 id 前缀 */
function sanitizeIdPrefix(raw: string): string {
  const s = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  if (!s) return "clip";
  return /^[A-Za-z_]/.test(s) ? s : `c_${s}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 把字符串里的 url(#id) / #id 换成带前缀的新 id（按 from 从长到短） */
function rewriteIdRefs(value: string, replacements: IdRewrite[]): string {
  let next = value;
  for (const { from, to } of replacements) {
    const escaped = escapeRegExp(from);
    next = next.replace(new RegExp(`url\\(\\s*(['"]?)#${escaped}\\1\\s*\\)`, "gi"), `url(#${to})`);
    next = next.replace(new RegExp(`#${escaped}(?![A-Za-z0-9_-])`, "g"), `#${to}`);
  }
  return next;
}

/** 收集模板内全部 id，生成 prefix-原id；长 id 优先以免前缀误伤 */
function collectIdReplacements(doc: Document, prefix: string): IdRewrite[] {
  const seen = new Set<string>();
  const list: IdRewrite[] = [];
  for (const el of Array.from(doc.querySelectorAll("[id]"))) {
    const from = el.getAttribute("id")?.trim() || "";
    if (!from || seen.has(from)) continue;
    seen.add(from);
    list.push({ from, to: `${prefix}-${from}` });
  }
  list.sort((a, b) => b.from.length - a.from.length);
  return list;
}

/**
 * 给本 clip 副本的 id 及 href / url(#) / CSS #id 加前缀。
 * class 与 @keyframes 名不改。
 */
function scopeSvgIds(doc: Document, idPrefix: string): void {
  const replacements = collectIdReplacements(doc, sanitizeIdPrefix(idPrefix));
  if (!replacements.length) return;
  const toByFrom = new Map(replacements.map((item) => [item.from, item.to]));
  for (const el of Array.from(doc.querySelectorAll("[id]"))) {
    const from = el.getAttribute("id")?.trim() || "";
    const to = toByFrom.get(from);
    if (to) el.setAttribute("id", to);
  }
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      const rewritten = rewriteIdRefs(attr.value, replacements);
      if (rewritten !== attr.value) attr.value = rewritten;
    }
  }
  for (const style of Array.from(doc.querySelectorAll("style"))) {
    const src = style.textContent || "";
    const rewritten = rewriteIdRefs(src, replacements);
    if (rewritten !== src) style.textContent = rewritten;
  }
}

/** 首个 text 的直接子 tspan（yep 逐字动画挂在这些节点上） */
function directTspans(primary: Element): Element[] {
  return Array.from(primary.children).filter((node) => node.tagName.toLowerCase() === "tspan");
}

/**
 * 有 tspan 时按 Unicode 码点拆字写入，多删少补，保留 tspan 属性。
 * 无 tspan 才整段 textContent，避免拆掉装饰结构。
 */
function patchPrimaryText(primary: Element, text: string): void {
  const existing = directTspans(primary);
  if (!existing.length) {
    primary.textContent = text;
    return;
  }
  const chars = Array.from(text);
  if (!chars.length) {
    primary.textContent = "";
    return;
  }
  const proto = existing[0];
  while (existing.length > chars.length) {
    existing.pop()?.remove();
  }
  for (let i = 0; i < chars.length; i += 1) {
    let span = existing[i];
    if (!span) {
      span = proto.cloneNode(false) as Element;
      primary.appendChild(span);
    }
    span.textContent = chars[i];
  }
}

/**
 * 改写模板 SVG：仅主（首个）text 节点更新文案/颜色/字号，装饰 text 保留。
 * color 为 null 时不覆盖 fill。按 idPrefix 隔离 id，输出可直接 v-html 到预览层。
 */
export function applyTextTemplateSvg(raw: string, options: ApplyTextTemplateSvgOptions): string {
  if (!raw || typeof DOMParser === "undefined") return raw;
  const doc = new DOMParser().parseFromString(raw, "image/svg+xml");
  if (doc.querySelector("parsererror")) return raw;
  const svg = doc.documentElement;
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  const texts = Array.from(doc.querySelectorAll("text"));
  const primary = texts[0];
  if (primary) {
    patchPrimaryText(primary, options.text);
    patchStyle(primary, options.fontSize, options.color?.trim() || null);
  }
  scopeSvgIds(doc, options.idPrefix);
  return new XMLSerializer().serializeToString(doc);
}
