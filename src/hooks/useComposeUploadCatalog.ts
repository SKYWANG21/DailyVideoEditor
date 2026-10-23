import type { ComposeSegmentClipAssets } from "@/types/videoCompose";

/** 本地素材直接使用已有地址 */
export async function resolveCatalogVariantPlayUrl(variant: ComposeSegmentClipAssets): Promise<string> {
  return variant.url?.trim() || "";
}
