<template>
  <div class="flex h-screen min-h-0 flex-col bg-background text-foreground">
    <header class="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
      <span class="text-sm font-medium">视频合成</span>
      <button type="button" class="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground" @click="onCompose">合成</button>
    </header>
    <div class="min-h-0 flex-1">
      <VideoComposeEditor
        v-model="model"
        :video-assets="videoAssets"
        :audio-assets="audioAssets"
        :sfx-assets="sfxAssets"
        :text-templates="textTemplates"
        :on-request-upload-clip="() => (uploadClipOpen = true)"
        @remove-catalog-clip="onRemoveVideoAsset"
        @toggle-like="onToggleVideoLike"
        @video-uploaded="onVideoAssetUploaded"
        @audio-uploaded="onAudioUploaded"
        @sfx-uploaded="onSfxUploaded"
        @text-template-uploaded="onTextTemplateUploaded"
      />
    </div>
    <VideoClipUploadModal v-model:open="uploadClipOpen" @uploaded="onVideoUploaded" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { VideoComposeEditor } from "@/editor";
import type { ComposeCatalogUploadPayload } from "@/editor/session/createComposeEditorState";
import VideoClipUploadModal, { type UploadedComposeClip } from "@/editor/modals/VideoClipUploadModal.vue";
import { createTextTemplateItem, type TextTemplateItem } from "@/editor/shared/textTemplateCatalog";
import {
  COMPOSE_CLIP_PLACEHOLDER_DURATION_SEC,
  isComposeClipDurationProbeable,
  probeAudioDuration,
} from "@/hooks/useResolveComposeClips";
import {
  createDefaultVideoComposeEditorModel,
  type BgmItem,
  type ComposeSegmentClipAssets,
  type VideoComposeEditorModel,
} from "@/types/videoCompose";
/** demo 花字：仅 App 引用，不会打进 lib */
import coolRaw from "@/assets/svg/TextTemplate/cool.svg?raw";
import hiRaw from "@/assets/svg/TextTemplate/hi.svg?raw";
import likeRaw from "@/assets/svg/TextTemplate/like.svg?raw";
import lolRaw from "@/assets/svg/TextTemplate/lol.svg?raw";
import ooopsRaw from "@/assets/svg/TextTemplate/ooops.svg?raw";
import pleaseRaw from "@/assets/svg/TextTemplate/please.svg?raw";
import selfieRaw from "@/assets/svg/TextTemplate/selfie.svg?raw";
import yepRaw from "@/assets/svg/TextTemplate/yep.svg?raw";
import yesRaw from "@/assets/svg/TextTemplate/yes.svg?raw";
import coolUrl from "@/assets/svg/TextTemplate/cool.svg";
import hiUrl from "@/assets/svg/TextTemplate/hi.svg";
import likeUrl from "@/assets/svg/TextTemplate/like.svg";
import lolUrl from "@/assets/svg/TextTemplate/lol.svg";
import ooopsUrl from "@/assets/svg/TextTemplate/ooops.svg";
import pleaseUrl from "@/assets/svg/TextTemplate/please.svg";
import selfieUrl from "@/assets/svg/TextTemplate/selfie.svg";
import yepUrl from "@/assets/svg/TextTemplate/yep.svg";
import yesUrl from "@/assets/svg/TextTemplate/yes.svg";

/** demo 内置花字源（id + SVG 原文 + 资源地址） */
const DEMO_TEXT_TEMPLATE_FILES: Array<{ id: string; raw: string; url: string }> = [
  { id: "cool", raw: coolRaw, url: coolUrl },
  { id: "hi", raw: hiRaw, url: hiUrl },
  { id: "like", raw: likeRaw, url: likeUrl },
  { id: "lol", raw: lolRaw, url: lolUrl },
  { id: "ooops", raw: ooopsRaw, url: ooopsUrl },
  { id: "please", raw: pleaseRaw, url: pleaseUrl },
  { id: "selfie", raw: selfieRaw, url: selfieUrl },
  { id: "yep", raw: yepRaw, url: yepUrl },
  { id: "yes", raw: yesRaw, url: yesUrl },
];

/**
 * demo 音效：仅 App 引用 `@/assets/audio`，Vite 打包进 demo，不进 lib。
 * 展示顺序固定；url 由 glob 解析为带 hash 的资源地址。
 */
const DEMO_SFX_NAMES: string[] = [
  "系统警告",
  "牛叫",
  "闪亮登场",
  "突然加速",
  "综艺尴尬背景音",
  "鼠标点击声",
  "疑问",
  "警告音",
  "颤抖",
  "魔法音效",
  "滴",
];

/** path → url；文件名（无扩展名）即展示名 */
const DEMO_SFX_URL_BY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("@/assets/audio/*.mp3", {
      eager: true,
      query: "?url",
      import: "default",
    }),
  ).map(([path, url]) => {
    const fileName = path.split("/").pop() ?? "";
    return [fileName.replace(/\.mp3$/i, ""), url];
  }),
);

/** 工程状态：轨道在 model.tracks；侧栏素材不进 model */
const model = ref<VideoComposeEditorModel>(
  createDefaultVideoComposeEditorModel({
    bizType: "source_video",
    bizId: "local",
  }),
);

/** 侧栏四类素材种子（上传后 Editor 内部维护；emit 带回全量时可回写） */
const videoAssets = ref<ComposeSegmentClipAssets[]>([]);
const audioAssets = ref<BgmItem[]>([]);
const sfxAssets = ref<BgmItem[]>(
  DEMO_SFX_NAMES.flatMap((name) => {
    const url = DEMO_SFX_URL_BY_NAME[name];
    return url ? [{ name, url, durationSec: 0 }] : [];
  }),
);
const textTemplates = ref<TextTemplateItem[]>(
  DEMO_TEXT_TEMPLATE_FILES.map((file) => createTextTemplateItem(file.id, file.id, file.raw, file.url)),
);

const uploadClipOpen = ref(false);

/** 批量探测 demo 音效时长并写回侧栏种子 */
async function probeDemoSfxDurations(): Promise<void> {
  const list = sfxAssets.value;
  if (!list.length) return;
  const next = await Promise.all(
    list.map(async (item) => {
      if (!item.url?.trim() || !isComposeClipDurationProbeable(item.durationSec)) return item;
      const durationSec = await probeAudioDuration(item.url);
      if (durationSec <= COMPOSE_CLIP_PLACEHOLDER_DURATION_SEC) return item;
      return { ...item, durationSec };
    }),
  );
  sfxAssets.value = next;
}

onMounted(() => {
  void probeDemoSfxDurations();
});

/** 内置上传弹窗结果写入 videoAssets 种子 */
function onVideoUploaded(clips: UploadedComposeClip[]): void {
  if (!clips.length) return;
  for (const clip of clips) {
    if (!clip.url?.trim()) continue;
    videoAssets.value.push({
      id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      segmentIndex: 0,
      segmentTitle: "上传片段",
      url: clip.url.trim(),
      label: clip.name?.trim() || "上传片段",
      mediaId: clip.mediaId,
    });
  }
  ElMessage.success(clips.length > 1 ? `已添加 ${clips.length} 个视频到片段列表` : "已添加到视频片段列表");
}

/** 侧栏移除：宿主同步种子 */
function onRemoveVideoAsset(variant: ComposeSegmentClipAssets): void {
  videoAssets.value = videoAssets.value.filter((item) => item.id !== variant.id);
}

/** 侧栏切换喜欢：宿主回写 videoAssets[].liked */
function onToggleVideoLike(variant: ComposeSegmentClipAssets): void {
  videoAssets.value = videoAssets.value.map((item) => (item.id === variant.id ? variant : item));
}

/** adapter 上传视频：用 Editor 返回的全量列表对齐种子 */
function onVideoAssetUploaded(payload: ComposeCatalogUploadPayload<ComposeSegmentClipAssets>): void {
  videoAssets.value = [...payload.items];
}

/** 编辑器内置上传音频 */
function onAudioUploaded(payload: ComposeCatalogUploadPayload<BgmItem>): void {
  audioAssets.value = [...payload.items];
}

/** 编辑器内置上传音效 */
function onSfxUploaded(payload: ComposeCatalogUploadPayload<BgmItem>): void {
  sfxAssets.value = [...payload.items];
}

/** 编辑器内置上传花字 */
function onTextTemplateUploaded(payload: ComposeCatalogUploadPayload<TextTemplateItem>): void {
  textTemplates.value = [...payload.items];
}

/**
 * 合成：validate → exportComposePayload。
 * demo 未挂 ref；宿主集成时对 VideoComposeEditor 取 ref 调用即可。
 */
function onCompose(): void {
  ElMessage.info("暂无（宿主：validate() 后 exportComposePayload()）");
}
</script>
