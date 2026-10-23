import type { ComposeSegmentClipAssets, ComposeTrack } from "@/types/videoCompose";

/** 侧栏视频分组序号占位（历史字段，卡片不再按此区分可否删除） */
export const COMPOSE_UPLOAD_CATALOG_SEGMENT_INDEX = -1;

/** 从主轨 clip 名称解析展示标签（「上传片段 · xxx」→ xxx） */
function parseUploadClipLabel(name?: string): string {
  const raw = name?.trim() || "";
  const sep = " · ";
  const idx = raw.indexOf(sep);
  if (idx >= 0) return raw.slice(idx + sep.length).trim() || "上传片段";
  if (raw.startsWith("上传片段")) return raw.replace(/^上传片段\s*/, "").trim() || "上传片段";
  return raw || "上传片段";
}

/**
 * 从已持久化主轨推断侧栏视频条目（兼容旧数据无 uploadedClipCatalog 字段）。
 * 排除 hist- 前缀 id（旧历史版本上轴标记）。
 */
export function inferUploadedVariantsFromTracks(tracks: ComposeTrack[] | undefined): ComposeSegmentClipAssets[] {
  const main =
    tracks?.find((t) => t.isMain && t.clips.some((c) => c.type === "video")) ||
    tracks?.find((t) => t.type === "video" && t.clips.some((c) => c.type === "video"));
  if (!main) return [];

  const variants: ComposeSegmentClipAssets[] = [];
  for (const clip of main.clips) {
    if (clip.type !== "video") continue;
    const sourceUrl = clip.sourceUrl?.trim();
    if (!sourceUrl) continue;
    if (clip.id.startsWith("hist-")) continue;

    variants.push({
      id: clip.id,
      segmentIndex: COMPOSE_UPLOAD_CATALOG_SEGMENT_INDEX,
      segmentTitle: "上传片段",
      url: sourceUrl,
      label: parseUploadClipLabel(clip.name),
    });
  }
  return variants;
}

/** 合并多来源上传 catalog，按 URL 去重（保留先出现的条目） */
export function mergeUploadedCatalogVariants(...sources: Array<ComposeSegmentClipAssets[] | undefined>): ComposeSegmentClipAssets[] {
  const byUrl = new Map<string, ComposeSegmentClipAssets>();
  for (const list of sources) {
    for (const variant of list || []) {
      const url = variant.url?.trim();
      if (!url || byUrl.has(url)) continue;
      byUrl.set(url, { ...variant, url });
    }
  }
  return [...byUrl.values()];
}

/** 本地素材直接使用已有地址 */
export async function resolveCatalogVariantPlayUrl(variant: ComposeSegmentClipAssets): Promise<string> {
  return variant.url?.trim() || "";
}
