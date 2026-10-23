<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-[20000] flex items-center justify-center bg-black/50" @click.self="close">
      <div
        class="bg-card border border-border rounded-[10px] shadow-[0_10px_40px_rgba(0,0,0,0.2)] w-full max-w-[640px] mx-4 flex flex-col overflow-hidden"
      >
        <div class="px-6 pt-6 pb-4 shrink-0 flex items-start justify-between">
          <p class="text-[18px] font-bold text-foreground">上传视频</p>
          <button
            class="w-8 h-8 rounded-full bg-muted hover:bg-muted/80 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors shrink-0 ml-4"
            @click="close"
          >
            <X :size="16" />
          </button>
        </div>
        <div class="h-px bg-border/60 mx-6 shrink-0" />
        <div class="p-6 flex flex-col gap-3">
          <div
            class="border-2 border-dashed border-border rounded-xl p-8 flex flex-col items-center justify-center gap-2 cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-all"
            @click="fileRef?.click()"
          >
            <UploadCloud :size="32" class="text-muted-foreground mb-2" />
            <p class="text-sm font-medium">点击选择本地视频</p>
            <p class="text-xs text-muted-foreground">文件只保存在浏览器内存中</p>
          </div>
          <input ref="fileRef" type="file" accept="video/*" multiple hidden @change="onPickFiles" />
          <ul v-if="pending.length" class="flex flex-col gap-2 max-h-40 overflow-y-auto">
            <li v-for="item in pending" :key="item.url" class="text-[13px] text-foreground truncate">{{ item.name }}</li>
          </ul>
        </div>
        <div class="h-px bg-border/60 mx-6 shrink-0" />
        <div class="px-6 py-4 flex justify-end gap-3 shrink-0">
          <button class="h-9 px-4 border border-border rounded-md text-sm hover:bg-muted transition-colors" @click="close">取消</button>
          <button
            class="h-9 px-4 bg-primary hover:bg-primary/90 text-primary-foreground rounded-md text-sm font-medium disabled:opacity-50"
            :disabled="pending.length === 0"
            @click="confirm"
          >
            确认添加
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { UploadCloud, X } from "@lucide/vue";

/** 本地选择后回传给合成编辑器的片段 */
export interface UploadedComposeClip {
  /** 展示名称 */
  name: string;
  /** 浏览器内存中的可播放地址 */
  url: string;
  /** 时长（秒） */
  durationSec: number;
  /** 本地上传没有素材库 id */
  mediaId?: number;
}

const props = defineProps<{
  /** 弹窗是否打开 */
  open: boolean;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  uploaded: [clips: UploadedComposeClip[]];
}>();

interface PendingClip {
  /** 文件名 */
  name: string;
  /** blob URL，确认后交给时间轴，取消时释放 */
  url: string;
}

const fileRef = ref<HTMLInputElement | null>(null);
const pending = ref<PendingClip[]>([]);

function close(): void {
  emit("update:open", false);
}

function releasePending(): void {
  for (const item of pending.value) {
    URL.revokeObjectURL(item.url);
  }
  pending.value = [];
  if (fileRef.value) fileRef.value.value = "";
}

/** 读取本地视频时长，不释放播放地址 */
function readVideoDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const finish = (value: number) => {
      video.onloadedmetadata = null;
      video.onerror = null;
      video.src = "";
      resolve(value);
    };
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const duration = video.duration;
      finish(Number.isFinite(duration) && duration > 0 ? duration : 0);
    };
    video.onerror = () => finish(0);
    video.src = url;
  });
}

function onPickFiles(event: Event): void {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  if (!files.length) return;
  releasePending();
  pending.value = files.map((file) => ({
    name: file.name.replace(/\.[^/.]+$/, "") || file.name,
    url: URL.createObjectURL(file),
  }));
}

async function confirm(): Promise<void> {
  const clips: UploadedComposeClip[] = [];
  for (const item of pending.value) {
    const durationSec = await readVideoDuration(item.url);
    clips.push({ name: item.name, url: item.url, durationSec });
  }
  pending.value = [];
  emit("uploaded", clips);
  emit("update:open", false);
}

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) releasePending();
  },
);
</script>
