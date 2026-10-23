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

/** 工程状态：轨道在 model.tracks */
const model = ref<VideoComposeEditorModel>(
  createDefaultVideoComposeEditorModel({
    bizType: "source_video",
    bizId: "local",
  }),
);

const mockOn = isVideoComposeMockEnabled();

/** 侧栏四类素材：统一经 Editor props 注入（mock 开时预填） */
const videoAssets = ref<ComposeSegmentClipAssets[]>(mockOn ? buildMockVideoAssets() : []);
const audioAssets = ref<BgmItem[]>([]);
const sfxAssets = ref<BgmItem[]>(mockOn ? buildMockSfxAssets() : []);
const textTemplates = ref<TextTemplateItem[]>(mockOn ? buildMockTextTemplates() : []);

const uploadClipOpen = ref(false);

/** 内置上传弹窗结果写入 videoAssets */
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

/** 侧栏移除：宿主改列表 */
function onRemoveVideoAsset(variant: ComposeSegmentClipAssets): void {
  videoAssets.value = videoAssets.value.filter((item) => item.id !== variant.id);
}

/** uploadAdapter 上传视频成功（demo 当前用 onRequestUploadClip；此事件供 adapter 路径） */
function onVideoAssetUploaded(item: ComposeSegmentClipAssets): void {
  videoAssets.value = [...videoAssets.value, item];
}

/** 编辑器内置上传音频 → 写入 audioAssets */
function onAudioUploaded(item: BgmItem): void {
  audioAssets.value = [...audioAssets.value, item];
}

/** 编辑器内置上传音效 → 写入 sfxAssets */
function onSfxUploaded(item: BgmItem): void {
  sfxAssets.value = [...sfxAssets.value, item];
}

/** 编辑器内置上传花字 → 写入 textTemplates */
function onTextTemplateUploaded(item: TextTemplateItem): void {
  textTemplates.value = [...textTemplates.value, item];
}

/**
 * 合成：validate → exportComposePayload。
 * demo 未挂 ref；宿主集成时对 VideoComposeEditor 取 ref 调用即可。
 */
function onCompose(): void {
  ElMessage.info("暂无（宿主：validate() 后 exportComposePayload()）");
}
</script>
