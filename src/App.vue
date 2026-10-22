<template>
  <div class="flex h-screen min-h-0 flex-col bg-background text-foreground">
    <header class="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
      <span class="text-sm font-medium">视频合成</span>
      <button type="button" class="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground" @click="onCompose">合成</button>
    </header>
    <div class="min-h-0 flex-1">
      <VideoComposeEditor v-model="model" :clips="clips" :auto-transcribe="false" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { ElMessage } from "element-plus";
import { VideoComposeEditor } from "@/editor";
import { createDefaultVideoComposeEditorModel, type VideoComposeClipInput, type VideoComposeEditorModel } from "@/types/videoCompose";

/** 本地工程没有上游片段，素材从侧栏上传进入内存 */
const clips = ref<VideoComposeClipInput[]>([]);

/** 编辑器工程状态，只留在当前页面 */
const model = ref<VideoComposeEditorModel>(
  createDefaultVideoComposeEditorModel({
    bizType: "source_video",
    bizId: "local",
  }),
);

/** 合成不对接后端 */
function onCompose(): void {
  ElMessage.info("暂无");
}
</script>
