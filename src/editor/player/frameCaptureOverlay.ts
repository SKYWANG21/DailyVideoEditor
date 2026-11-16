const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

/** 只保留内容排版和绘制样式，克隆图层不依赖宿主的样式表。 */
const layoutProperties = [
  "display",
  "position",
  "inset",
  "top",
  "right",
  "bottom",
  "left",
  "width",
  "height",
  "box-sizing",
  "margin",
  "padding",
  "overflow",
  "flex-direction",
  "align-items",
  "justify-content",
  "text-align",
  "white-space",
  "overflow-wrap",
  "word-break",
  "direction",
  "writing-mode",
  "z-index",
  "visibility",
  "opacity",
  "transform",
  "translate",
  "rotate",
  "scale",
  "transform-origin",
  "transform-box",
  "filter",
  "clip-path",
  "mask",
  "mix-blend-mode",
  "color",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "font-stretch",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-shadow",
];
const svgProperties = [
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stop-color",
  "stop-opacity",
  "flood-color",
  "flood-opacity",
  "lighting-color",
  "clip-rule",
  "vector-effect",
  "paint-order",
  "text-anchor",
  "dominant-baseline",
  "alignment-baseline",
  "baseline-shift",
  "marker-start",
  "marker-mid",
  "marker-end",
];
const omittedTags = new Set(["style", "script", "animate", "animateTransform", "animateMotion", "set"]);

interface OverlayResources {
  /** 可见内容实际声明的字体族。 */
  fonts: Set<string>;
  /** 克隆中需内嵌的图片。 */
  images: Array<{ node: Element; attribute: "href" | "src"; url: string }>;
}

/** 固定 SVG 动画的当前属性值，保留渐变和逐字旋转等非 CSS 动画。 */
function animatedAttribute(target: SVGElement, name: string): string | undefined {
  const property: unknown = (target as unknown as Record<string, unknown>)[name];
  if (!property || typeof property !== "object" || !("animVal" in property)) return;
  const value = property.animVal;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof SVGLength) return value.valueAsString;
  if (value instanceof SVGNumberList || value instanceof SVGLengthList) {
    return Array.from({ length: value.numberOfItems }, (_, index) => {
      const item = value.getItem(index);
      return item instanceof SVGLength ? item.valueAsString : item.value;
    }).join(" ");
  }
  if (value instanceof SVGTransformList) {
    return Array.from({ length: value.numberOfItems }, (_, index) => {
      const { a, b, c, d, e, f } = value.getItem(index).matrix;
      return `matrix(${a},${b},${c},${d},${e},${f})`;
    }).join(" ");
  }
}

/** 收集每个可见 SVG 中由 SMIL 驱动、且必须写回克隆节点的属性。 */
function freezeSvgAnimations(svg: SVGSVGElement): Map<Element, Map<string, string>> {
  const frozen = new Map<Element, Map<string, string>>();
  for (const animation of svg.querySelectorAll<SVGAnimationElement>("animate, animateTransform, animateMotion, set")) {
    const target = animation.targetElement;
    const name = animation.getAttribute("attributeName") ?? "";
    if (!target) continue;
    const value = animatedAttribute(target, name);
    if (value === undefined) {
      if (layoutProperties.includes(name) || svgProperties.includes(name)) continue;
      throw new DOMException(`截图暂不支持此花字动画属性（${name || animation.localName}）`, "NotSupportedError");
    }
    const attributes = frozen.get(target) ?? new Map<string, string>();
    attributes.set(name, value);
    frozen.set(target, attributes);
  }
  return frozen;
}

/** 图片文档中的 SVG 引用须保留为内部片段，不能指回当前网页。 */
function localReference(raw: string, source: Element): string {
  if (raw.startsWith("#") || raw.startsWith("data:")) return raw;
  const url = new URL(raw, source.baseURI);
  const page = new URL(source.ownerDocument.URL);
  const fragment = url.hash;
  url.hash = page.hash = "";
  if (fragment && url.href === page.href) return fragment;
  throw new DOMException("截图中的 SVG 滤镜或引用依赖外部文档", "NotSupportedError");
}

/** 克隆可见内容并固定动画采样，去掉编辑外框、手柄及光标。 */
function cloneLayer(source: Element, resources: OverlayResources, inheritedAnimations?: Map<Element, Map<string, string>>): Element | null {
  if (source.hasAttribute("data-frame-capture-skip") || omittedTags.has(source.localName)) return null;
  const style = getComputedStyle(source);
  const isSvg = source.namespaceURI === SVG_NS;
  // SVG 的 defs 等节点即使 display:none 也可能被渐变、遮罩引用。
  if (!isSvg && style.display === "none") return null;
  const animations = inheritedAnimations ?? (source instanceof SVGSVGElement ? freezeSvgAnimations(source) : undefined);
  const frozen = animations?.get(source);
  const clone = source.cloneNode(false) as HTMLElement | SVGElement;
  clone.removeAttribute("style");
  clone.removeAttribute("contenteditable");
  for (const attribute of [...clone.attributes]) {
    if (/^on/i.test(attribute.name)) clone.removeAttribute(attribute.name);
  }
  const properties = isSvg ? [...layoutProperties, ...svgProperties] : layoutProperties;
  for (const property of properties) {
    if (frozen?.has(property)) continue;
    const value = style.getPropertyValue(property);
    if (value)
      clone.style.setProperty(
        property,
        value.replace(/url\(\s*(["']?)(.*?)\1\s*\)/g, (_, _quote: string, url: string) => `url("${localReference(url, source)}")`),
      );
  }
  for (const [name, value] of frozen ?? []) clone.setAttribute(name, value);

  if (source.localName === "image" || source instanceof HTMLImageElement) {
    const attribute = isSvg ? "href" : "src";
    const url =
      source instanceof HTMLImageElement
        ? source.currentSrc || source.getAttribute("src")
        : (source.getAttribute("href") ?? source.getAttribute("xlink:href"));
    clone.removeAttribute("srcset");
    clone.removeAttribute("xlink:href");
    if (url?.startsWith("data:") || url?.startsWith("#")) clone.setAttribute(attribute, url);
    else if (url) {
      clone.removeAttribute(attribute);
      resources.images.push({ node: clone, attribute, url: new URL(url, source.baseURI).href });
    }
  } else if (isSvg) {
    for (const attribute of ["href", "xlink:href"]) {
      const url = source.getAttribute(attribute);
      if (url) clone.setAttribute(attribute, localReference(url, source));
    }
  }

  if ([...source.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim())) {
    for (const family of style.fontFamily.split(",")) resources.fonts.add(fontFamilyKey(family));
  }
  for (const child of source.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) clone.appendChild(child.cloneNode());
    else if (child instanceof Element) {
      const content = cloneLayer(child, resources, animations);
      if (content) clone.appendChild(content);
    }
  }
  return clone;
}

/** CSS 字体族名比较忽略引号、大小写和首尾空格。 */
function fontFamilyKey(family: string): string {
  return family
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .toLowerCase();
}

/** 读取 CSS 内可访问的字体声明，包括媒体查询和导入的样式表。 */
function* fontFaceRules(sheet: CSSStyleSheet, seen: Set<CSSStyleSheet>): IterableIterator<CSSFontFaceRule> {
  if (seen.has(sheet)) return;
  seen.add(sheet);
  let rules: CSSRuleList;
  try {
    rules = sheet.cssRules;
  } catch {
    return;
  }
  function* walk(list: CSSRuleList): IterableIterator<CSSFontFaceRule> {
    for (const rule of list) {
      if (rule instanceof CSSFontFaceRule) yield rule;
      else if (rule instanceof CSSGroupingRule) yield* walk(rule.cssRules);
      else if (rule instanceof CSSImportRule && rule.styleSheet) yield* fontFaceRules(rule.styleSheet, seen);
    }
  }
  yield* walk(rules);
}

/** 资源必须自包含才能在 SVG 图片文档中正常显示。 */
async function inlineResource(url: string, signal: AbortSignal): Promise<string> {
  if (url.startsWith("data:")) return url;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`截图资源读取失败（HTTP ${response.status}）`);
  const blob = await response.blob();
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = (): void => reader.abort();
    signal.addEventListener("abort", abort, { once: true });
    reader.onload = (): void => resolve(String(reader.result));
    reader.onerror = (): void => reject(reader.error ?? new Error("截图资源转换失败"));
    reader.onabort = (): void => reject(signal.reason);
    reader.onloadend = (): void => signal.removeEventListener("abort", abort);
    reader.readAsDataURL(blob);
  });
}

/** 只内嵌画面用到且已加载的网页字体，无法读取时报告字体缺失。 */
async function embedFonts(svg: SVGSVGElement, families: Set<string>, load: (url: string) => Promise<string>): Promise<void> {
  const used = new Set(
    [...document.fonts]
      .filter((face) => face.status === "loaded" && families.has(fontFamilyKey(face.family)))
      .map((face) => fontFamilyKey(face.family)),
  );
  if (!used.size) return;
  const seen = new Set<CSSStyleSheet>();
  const rules = [...document.styleSheets, ...(document.adoptedStyleSheets ?? [])].flatMap((sheet) => [...fontFaceRules(sheet, seen)]);
  const available = rules.filter((rule) => used.has(fontFamilyKey(rule.style.getPropertyValue("font-family"))));
  for (const rule of available) used.delete(fontFamilyKey(rule.style.getPropertyValue("font-family")));
  if (used.size) throw new DOMException(`截图无法读取字体（${[...used].join("、")}）`, "NotSupportedError");
  const css = await Promise.all(
    available.map(async (rule): Promise<string> => {
      let declaration = rule.cssText;
      for (const match of rule.cssText.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/g)) {
        const data = await load(new URL(match[2], rule.parentStyleSheet?.href ?? document.baseURI).href);
        declaration = declaration.replace(match[0], `url("${data}")`);
      }
      return declaration;
    }),
  );
  const style = document.createElementNS(SVG_NS, "style");
  style.textContent = css.join("\n");
  svg.prepend(style);
}

/** 在首次等待前冻结图层，随后生成与输出画布同尺寸的透明位图。 */
export async function rasterizeFrameOverlay(
  stage: HTMLElement,
  width: number,
  height: number,
  signal: AbortSignal,
): Promise<ImageBitmap | null> {
  const layers = stage.querySelectorAll("[data-frame-capture-layer]");
  if (!layers.length) return null;
  const stageStyle = getComputedStyle(stage);
  const stageWidth = parseFloat(stageStyle.width);
  const stageHeight = parseFloat(stageStyle.height);
  if (!(stageWidth > 0 && stageHeight > 0)) return null;
  const resources: OverlayResources = { fonts: new Set(), images: [] };
  const content = document.createElementNS(XHTML_NS, "div") as HTMLDivElement;
  content.style.cssText = `position:relative;width:${stageWidth}px;height:${stageHeight}px;overflow:hidden`;
  for (const layer of layers) {
    const clone = cloneLayer(layer, resources);
    // Vue 的空列表也会留下文本锚点，只栅格化实际有文字或图像的图层。
    if (clone && (clone.textContent?.trim() || clone.querySelector("svg, img"))) content.appendChild(clone);
  }
  if (!content.childElementCount) return null;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${stageWidth} ${stageHeight}`);
  svg.setAttribute("preserveAspectRatio", "none");
  const foreign = document.createElementNS(SVG_NS, "foreignObject");
  foreign.setAttribute("width", String(stageWidth));
  foreign.setAttribute("height", String(stageHeight));
  foreign.appendChild(content);
  svg.appendChild(foreign);

  const loads = new Map<string, Promise<string>>();
  /** 相同资源在一张截图内只读取一次。 */
  function load(url: string): Promise<string> {
    const cached = loads.get(url) ?? inlineResource(url, signal);
    loads.set(url, cached);
    return cached;
  }
  await Promise.all([
    embedFonts(svg, resources.fonts, load),
    ...resources.images.map(async ({ node, attribute, url }): Promise<void> => {
      node.setAttribute(attribute, await load(url));
    }),
  ]);
  signal.throwIfAborted();

  return rasterizeSvg(svg, width, height, signal);
}

/** 冻结独立 SVG 当前动画状态，导出任务共享外部图片和字体缓存。 */
export async function rasterizeSvgFrame(
  source: SVGSVGElement,
  width: number,
  height: number,
  signal: AbortSignal,
  loads: Map<string, Promise<string>>,
): Promise<ImageBitmap> {
  signal.throwIfAborted();
  const resources: OverlayResources = { fonts: new Set(), images: [] };
  const svg = cloneLayer(source, resources) as SVGSVGElement;
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.style.width = `${width}px`;
  svg.style.height = `${height}px`;
  /** 同一导出任务的资源只读取一次。 */
  function load(url: string): Promise<string> {
    const cached = loads.get(url) ?? inlineResource(url, signal);
    loads.set(url, cached);
    return cached;
  }
  await Promise.all([
    embedFonts(svg, resources.fonts, load),
    ...resources.images.map(async ({ node, attribute, url }): Promise<void> => {
      node.setAttribute(attribute, await load(url));
    }),
  ]);
  signal.throwIfAborted();
  return rasterizeSvg(svg, width, height, signal);
}

/** 已冻结且资源自包含的 SVG 转为可传输位图。 */
async function rasterizeSvg(svg: SVGSVGElement, width: number, height: number, signal: AbortSignal): Promise<ImageBitmap> {
  const image = new Image();
  const abort = (): void => image.removeAttribute("src");
  signal.addEventListener("abort", abort, { once: true });
  try {
    const xml = new XMLSerializer().serializeToString(svg);
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
    await image.decode();
    signal.throwIfAborted();
    // 本地 SVG 先按 Canvas 图片规则绘制，避免直接转换 foreignObject SVG 时得到不可传输的位图。
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("截图覆盖层画布不可用");
    context.drawImage(image, 0, 0, width, height);
    return canvas.transferToImageBitmap();
  } catch (error: unknown) {
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    abort();
  }
}
