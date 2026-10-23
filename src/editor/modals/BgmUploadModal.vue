<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-[20000] flex items-center justify-center bg-black/50" @click.self="close">
      <div
        class="bg-card border border-border rounded-[10px] shadow-[0_10px_40px_rgba(0,0,0,0.2)] w-full max-w-[640px] mx-4 flex flex-col overflow-hidden"
      >
        <div class="px-6 pt-6 pb-4 shrink-0 flex items-start justify-between">
          <p class="text-[18px] font-bold text-foreground">{{ title }}</p>
          <button
            class="w-8 h-8 rounded-full bg-muted hover:bg-muted/80 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors shrink-0 ml-4"
            @click="close"
          >
            <X :size="16" />
          </button>
        </div>
        <div class="h-px bg-border/60 mx-6 shrink-0" />
        <div class="p-6 flex flex-col gap-3">
          <div class="flex items-center h-[42px] border border-border/40 rounded-[6px] overflow-hidden bg-muted/30">
            <span class="pl-3 pr-3 text-[13px] text-muted-foreground font-medium shrink-0">音频名称</span>
            <div class="w-px self-stretch bg-border" />
            <input
              v-model="uploadAudioName"
              placeholder="输入音频名称..."
              class="flex-1 h-full bg-transparent border-none outline-none px-3 text-[13px]"
            />
          </div>
          <div class="flex items-start border border-border/40 rounded-[6px] overflow-hidden bg-muted/30 min-h-[96px]">
            <span class="pt-3 pl-3 pr-3 text-[13px] text-muted-foreground font-medium shrink-0">音频描述</span>
            <div class="w-px self-stretch bg-border" />
            <textarea
              v-model="uploadAudioDesc"
              class="flex-1 h-full bg-transparent border-none outline-none p-3 text-[13px] resize-none min-h-[96px]"
              placeholder="描述音频内容或风格..."
            />
          </div>
          <div
            class="border-2 border-dashed border-border rounded-xl p-8 flex flex-col items-center justify-center gap-2 cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-all"
            @click="uploadAudioFileRef?.click()"
          >
            <template v-if="uploadAudioPreview">
              <div class="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-primary mb-2">
                <Music :size="24" />
              </div>
              <span class="text-sm text-muted-foreground">{{ uploadAudioFileName }} (点击更换)</span>
            </template>
            <template v-else>
              <UploadCloud :size="32" class="text-muted-foreground mb-2" />
              <p class="text-sm font-medium">{{ pickerText }}</p>
              <p class="text-xs text-muted-foreground">支持 MP3, WAV 格式</p>
            </template>
          </div>
          <input ref="uploadAudioFileRef" type="file" accept="audio/*" hidden @change="onUploadAudio" />
        </div>
        <div class="h-px bg-border/60 mx-6 shrink-0" />
        <div class="px-6 py-4 flex justify-end gap-3 shrink-0">
          <button class="h-9 px-4 border border-border rounded-md text-sm hover:bg-muted transition-colors" @click="close">取消</button>
          <button
            class="h-9 px-4 bg-primary hover:bg-primary/90 text-primary-foreground rounded-md text-sm font-medium disabled:opacity-50"
            :disabled="!uploadAudioPreview || isBusy"
            @click="confirmUpload"
          >
            {{ isBusy ? "上传中..." : "确认上传" }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Music, UploadCloud, X } from "@lucide/vue";
import { ElMessage } from "element-plus";
import type { BgmItem } from "@/types/videoCompose";

const props = withDefaults(
  defineProps<{
    /** 弹窗是否打开 */
    open: boolean;
    /** 是否正在提交上传 */
    submitting: boolean;
    /** 弹窗标题 */
    title?: string;
    /** 未选文件时的拖放提示 */
    pickerText?: string;
    /** 添加成功提示 */
    successText?: string;
  }>(),
  {
    title: "上传音频",
    pickerText: "点击或拖拽上传音频",
    successText: "已添加本地音频",
  },
);

const emit = defineEmits<{
  "update:open": [value: boolean];
  uploaded: [bgm: BgmItem];
}>();

const uploadAudioName = ref("");
const uploadAudioDesc = ref("");
const uploadAudioPreview = ref<string | null>(null);
const uploadAudioFileName = ref("");
const uploadAudioFile = ref<File | null>(null);
const uploadAudioFileRef = ref<HTMLInputElement | null>(null);
const uploading = ref(false);

const isBusy = computed(() => props.submitting || uploading.value);

function close(): void {
  emit("update:open", false);
}

function resetForm(): void {
  if (uploadAudioPreview.value) URL.revokeObjectURL(uploadAudioPreview.value);
  uploadAudioName.value = "";
  uploadAudioDesc.value = "";
  uploadAudioPreview.value = null;
  uploadAudioFileName.value = "";
  uploadAudioFile.value = null;
  if (uploadAudioFileRef.value) uploadAudioFileRef.value.value = "";
}

function onUploadAudio(e: Event): void {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (uploadAudioPreview.value) URL.revokeObjectURL(uploadAudioPreview.value);
  uploadAudioFile.value = file;
  uploadAudioPreview.value = URL.createObjectURL(file);
  uploadAudioFileName.value = file.name;
  if (!uploadAudioName.value) uploadAudioName.value = file.name.replace(/\.[^/.]+$/, "");
}

/** 读取本地音频时长，不释放即将交给时间轴的 blob 地址 */
function readAudioDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const audio = new Audio();
    const finish = (value: number) => {
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.src = "";
      resolve(value);
    };
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      const duration = audio.duration;
      finish(Number.isFinite(duration) && duration > 0 ? duration : 0);
    };
    audio.onerror = () => finish(0);
    audio.src = url;
  });
}

async function confirmUpload(): Promise<void> {
  const name = uploadAudioName.value.trim();
  const url = uploadAudioPreview.value;
  if (!uploadAudioFile.value || !url) return;
  if (!name) {
    ElMessage.warning("请输入音频名称");
    return;
  }
  const durationSec = await readAudioDuration(url);
  uploadAudioPreview.value = null;
  emit("uploaded", { name, url, durationSec });
  emit("update:open", false);
  ElMessage.success(props.successText);
}

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) resetForm();
  },
);
</script>
