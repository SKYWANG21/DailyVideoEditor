import type { ComposeSegmentClipVariant, ComposeTrack, VideoComposeClipInput } from "@/types/videoCompose";

/** 侧栏「上传片段」分组序号（与 Step3 片段区分） */
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
 * 从已持久化主轨推断上传片段（兼容旧数据无 uploadedClipCatalog 字段）。
 * 排除 Step3 入参 id 与侧栏历史版本 id（hist- 前缀）。
 */
export function inferUploadedVariantsFromTracks(
  tracks: ComposeTrack[] | undefined,
  step3InputIds: Iterable<string>,
): ComposeSegmentClipVariant[] {
  const inputIdSet = new Set(step3InputIds);
  const main =
    tracks?.find((t) => t.isMain && t.clips.some((c) => c.type === "video")) ||
    tracks?.find((t) => t.type === "video" && t.clips.some((c) => c.type === "video"));
  if (!main) return [];

  const variants: ComposeSegmentClipVariant[] = [];
  for (const clip of main.clips) {
    if (clip.type !== "video") continue;
    const sourceUrl = clip.sourceUrl?.trim();
    if (!sourceUrl) continue;
    if (inputIdSet.has(clip.id) || clip.id.startsWith("hist-")) continue;

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
export function mergeUploadedCatalogVariants(...sources: Array<ComposeSegmentClipVariant[] | undefined>): ComposeSegmentClipVariant[] {
  const byUrl = new Map<string, ComposeSegmentClipVariant>();
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
export async function resolveCatalogVariantPlayUrl(variant: ComposeSegmentClipVariant): Promise<string> {
  return variant.url?.trim() || "";
}

/** Step3 入参 clip id 集合 */
export function collectStep3InputClipIds(inputs: VideoComposeClipInput[]): Set<string> {
  return new Set(inputs.map((c) => c.id));
}
