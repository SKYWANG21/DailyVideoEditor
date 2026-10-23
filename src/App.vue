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
import { ref } from "vue";
import { ElMessage } from "element-plus";
import { VideoComposeEditor } from "@/editor";
import type { ComposeCatalogUploadPayload } from "@/editor/session/createComposeEditorState";
import VideoClipUploadModal, { type UploadedComposeClip } from "@/editor/modals/VideoClipUploadModal.vue";
import type { TextTemplateItem } from "@/editor/shared/textTemplateCatalog";
import {
  buildMockSfxAssets,
  buildMockTextTemplates,
  buildMockVideoAssets,
  isVideoComposeMockEnabled,
} from "@/editor/shared/videoComposeMockClips";
import {
  createDefaultVideoComposeEditorModel,
  type BgmItem,
  type ComposeSegmentClipAssets,
  type VideoComposeEditorModel,
} from "@/types/videoCompose";

/** 工程状态：轨道在 model.tracks；侧栏素材不进 model */
const model = ref<VideoComposeEditorModel>(
  createDefaultVideoComposeEditorModel({
    bizType: "source_video",
    bizId: "local",
  }),
);

const mockOn = isVideoComposeMockEnabled();

/** 侧栏四类素材种子（上传后 Editor 内部维护；emit 带回全量时可回写） */
const videoAssets = ref<ComposeSegmentClipAssets[]>(mockOn ? buildMockVideoAssets() : []);
const audioAssets = ref<BgmItem[]>([]);
const sfxAssets = ref<BgmItem[]>(mockOn ? buildMockSfxAssets() : []);
const textTemplates = ref<TextTemplateItem[]>(mockOn ? buildMockTextTemplates() : []);

const uploadClipOpen = ref(false);

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
