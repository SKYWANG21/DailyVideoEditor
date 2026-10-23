<template>
  <aside
    ref="panelRef"
    class="compose-assets relative flex h-full min-h-0 w-full min-w-0 overflow-hidden rounded-[16px] bg-[var(--compose-surface)] shadow-[var(--compose-shadow-card)]"
    aria-label="素材"
  >
    <div class="flex min-w-0 flex-1 flex-col">
      <div class="flex shrink-0 items-center gap-1 px-3 pt-2">
        <button v-if="narrow" type="button" class="compose-assets__arrow" aria-label="上一个分类" @click="stepCat(-1)">
          <ChevronLeft :size="16" />
        </button>
        <div class="min-w-0 flex-1" :class="narrow ? 'flex justify-center' : ''">
          <VideoComposeUnderlineTabs
            :tabs="narrow ? [cats[catIndex].name] : catNames"
            :model-value="narrow ? 0 : catIndex"
            @update:model-value="onCatIndex"
          />
        </div>
        <button v-if="narrow" type="button" class="compose-assets__arrow" aria-label="下一个分类" @click="stepCat(1)">
          <ChevronRight :size="16" />
        </button>
      </div>

      <div class="compose-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <template v-if="catId === 'video'">
          <div class="grid gap-2" :style="cardGridStyle">
            <slot name="video-actions">
              <button v-if="!readonly" type="button" :class="addCardClass" @click="emit('upload-clip')">
                <UploadCloud :size="24" />
                上传视频
              </button>
            </slot>
          </div>
          <VideoComposeClipCatalog
            class="mt-3"
            :variants="videoVariants"
            :liked-keys="likedMediaKeys"
            :timeline-clip-urls="timelineClipUrls"
            :preview-clip-id="previewClipId"
            :readonly="readonly"
            @preview="emit('preview-clip', $event)"
            @remove="emit('remove-catalog-clip', $event)"
            @toggle-like="emit('toggle-like', $event)"
          />
        </template>

        <template v-else-if="catId === 'audio'">
          <div class="grid gap-2" :style="cardGridStyle">
            <slot name="audio-actions">
              <button v-if="!readonly" type="button" :class="addCardClass" @click="emit('open-upload-bgm')">
                <UploadCloud :size="24" />
                上传音频
              </button>
            </slot>
          </div>
          <p v-if="audioClipCount > 0" class="mt-3 text-[12px] text-[var(--compose-fg-3)]">已添加 {{ audioClipCount }} 段音频到时间轴</p>
          <div v-if="audioAssets.length" class="mt-3 grid gap-2" :style="cardGridStyle">
            <VideoComposeAssetCard
              v-for="(item, index) in audioAssets"
              :key="`${item.url}-${index}`"
              :label="item.name || '音频'"
              :readonly="readonly"
              @drag-start="onAudioDragStart($event, item)"
            />
          </div>
          <p v-else class="mt-3 text-center text-[12px] text-[var(--compose-fg-3)]">暂无音频</p>
        </template>

        <template v-else-if="catId === 'subtitle'">
          <div class="grid gap-2" :style="cardGridStyle">
            <slot name="subtitle-actions">
              <button v-if="!readonly" type="button" :class="addCardClass" @click="emit('add-subtitle')">
                <Plus :size="24" />
                添加字幕
              </button>
            </slot>
          </div>
          <div v-if="subtitleAssets.length" class="mt-3 grid gap-2" :style="cardGridStyle">
            <VideoComposeAssetCard
              v-for="item in subtitleAssets"
              :key="item.id"
              :label="item.text || '字幕'"
              :readonly="readonly"
              @drag-start="onSubtitleDragStart($event, item)"
            />
          </div>
          <p v-else class="mt-3 text-center text-[12px] text-[var(--compose-fg-3)]">暂无字幕</p>
        </template>

        <template v-else-if="catId === 'fancy'">
          <div class="grid gap-2" :style="cardGridStyle">
            <slot name="fancy-actions">
              <button v-if="!readonly" type="button" :class="addCardClass" @click="fancyFileRef?.click()">
                <UploadCloud :size="24" />
                上传花字
              </button>
            </slot>
          </div>
          <VideoComposeTextTemplateCatalog class="mt-3" :items="textTemplates" :readonly="readonly" />
        </template>

        <template v-else>
          <div class="grid gap-2" :style="cardGridStyle">
            <slot name="sfx-actions">
              <button v-if="!readonly" type="button" :class="addCardClass" @click="emit('upload-sfx')">
                <UploadCloud :size="24" />
                上传音效
              </button>
            </slot>
          </div>
          <div v-if="sfxAssets.length" class="mt-3 grid gap-2" :style="cardGridStyle">
            <VideoComposeAssetCard
              v-for="(item, index) in sfxAssets"
              :key="`${item.url}-${index}`"
              :label="item.name || '音效'"
              :readonly="readonly"
              @drag-start="onAudioDragStart($event, item)"
            />
          </div>
          <p v-else class="mt-3 text-center text-[12px] text-[var(--compose-fg-3)]">暂无音效</p>
        </template>
      </div>
    </div>
    <input ref="fancyFileRef" type="file" accept=".svg,image/svg+xml" class="hidden" @change="onFancyFileChange" />
  </aside>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ChevronLeft, ChevronRight, Plus, UploadCloud } from "@lucide/vue";
import {
  COMPOSE_AUDIO_ASSET_DRAG_MIME,
  COMPOSE_SUBTITLE_ASSET_DRAG_MIME,
  type BgmItem,
  type ComposeSegmentClipVariant,
  type ComposeSubtitleAsset,
} from "@/types/videoCompose";
import VideoComposeAssetCard from "./VideoComposeAssetCard.vue";
import VideoComposeClipCatalog from "./VideoComposeClipCatalog.vue";
import VideoComposeTextTemplateCatalog from "./VideoComposeTextTemplateCatalog.vue";
import VideoComposeUnderlineTabs from "../shared/VideoComposeUnderlineTabs.vue";
import type { TextTemplateItem } from "../shared/textTemplateCatalog";

/** 左栏分类。不含图片、转场 */
const cats = [
  { id: "video", name: "视频" },
  { id: "audio", name: "音频" },
  { id: "subtitle", name: "字幕" },
  { id: "fancy", name: "花字" },
  { id: "sfx", name: "音效" },
] as const;

type AssetCatId = (typeof cats)[number]["id"];

/** 素材卡边长。拖宽面板时不跟着变 */
const CARD_SIZE_PX = 72;
/** 左栏拖到这个宽度时，页签收成当前分类 */
const NARROW_PANE_PX = 132;

const props = defineProps<{
  /** 扁平视频素材。本地上传在前，历史版本按原顺序接在后面 */
  videoVariants?: ComposeSegmentClipVariant[];
  /** 已喜欢媒体的匹配键 */
  likedMediaKeys?: Set<string>;
  /** 已在时间轴上的视频地址 */
  timelineClipUrls?: Set<string>;
  /** 正在预览的版本 id */
  previewClipId?: string;
  /** 只读：隐藏上传，卡片不可拖 */
  readonly?: boolean;
  /** 时间轴上的音频段数 */
  audioClipCount: number;
  /** 音频素材。拖入后进音频轨 */
  audioAssets?: BgmItem[];
  /** 音效素材。拖入后同样进音频轨 */
  sfxAssets?: BgmItem[];
  /** 字幕素材 */
  subtitleAssets?: ComposeSubtitleAsset[];
  /** 花字模板 */
  textTemplates?: TextTemplateItem[];
}>();

const emit = defineEmits<{
  "upload-clip": [];
  "open-upload-bgm": [];
  "upload-sfx": [];
  "upload-fancy": [file: File];
  "add-subtitle": [];
  "preview-clip": [variant: ComposeSegmentClipVariant];
  "remove-catalog-clip": [variant: ComposeSegmentClipVariant];
  "toggle-like": [variant: ComposeSegmentClipVariant];
}>();

const videoVariants = computed(() => props.videoVariants ?? []);
const audioAssets = computed(() => props.audioAssets ?? []);
const sfxAssets = computed(() => props.sfxAssets ?? []);
const subtitleAssets = computed(() => props.subtitleAssets ?? []);
const textTemplates = computed(() => props.textTemplates ?? []);

/** 把素材写进拖放数据。只读时不写 */
function writeAssetDrag(event: DragEvent, mime: string, payload: BgmItem | ComposeSubtitleAsset): void {
  if (props.readonly || !event.dataTransfer) return;
  event.dataTransfer.setData(mime, JSON.stringify(payload));
  event.dataTransfer.effectAllowed = "copy";
}

/** 音频或音效开始拖入时间轴 */
function onAudioDragStart(event: DragEvent, item: BgmItem): void {
  writeAssetDrag(event, COMPOSE_AUDIO_ASSET_DRAG_MIME, item);
}

/** 字幕素材开始拖入时间轴 */
function onSubtitleDragStart(event: DragEvent, item: ComposeSubtitleAsset): void {
  writeAssetDrag(event, COMPOSE_SUBTITLE_ASSET_DRAG_MIME, item);
}

/** 花字 SVG 选择框。默认上传按钮点它，外壳换掉插槽后不再使用 */
const fancyFileRef = ref<HTMLInputElement | null>(null);

/** 选中本地 SVG 后交给外壳登记到花字列表 */
function onFancyFileChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  emit("upload-fancy", file);
}

/** 面板根节点，用来量当前栏宽 */
const panelRef = ref<HTMLElement | null>(null);
/** 当前栏宽。0 表示还没量到 */
const paneWidth = ref(0);
/** 当前分类下标 */
const catIndex = ref(0);
/** 栏宽观察，拖动时更新收起判断 */
let paneObserver: ResizeObserver | null = null;

const catNames = cats.map((item) => item.name);
const catId = computed<AssetCatId>(() => cats[catIndex.value].id);
/** 拖到左栏下限时只显示当前分类 */
const narrow = computed(() => paneWidth.value > 0 && paneWidth.value <= NARROW_PANE_PX);
/** 固定 72px 方格，多出来的宽度留空 */
const cardGridStyle = { gridTemplateColumns: `repeat(auto-fill, ${CARD_SIZE_PX}px)` };

/** 虚线添加入口，固定 72px，不随栏宽拉伸 */
const addCardClass =
  "flex h-[72px] w-[72px] flex-col items-center justify-center gap-1 rounded-[12px] border border-dashed border-[var(--compose-accent)] bg-[var(--compose-accent-soft)] px-1 text-center text-[12px] font-semibold text-[var(--compose-accent)] transition-colors duration-200 disabled:cursor-wait disabled:opacity-60";

/** 收起时左右切换分类 */
function stepCat(delta: number): void {
  const count = cats.length;
  catIndex.value = (catIndex.value + delta + count) % count;
}

/** 展开时点页签 */
function onCatIndex(index: number): void {
  if (narrow.value) return;
  catIndex.value = index;
}

onMounted(() => {
  const panel = panelRef.value;
  if (!panel) return;
  paneObserver = new ResizeObserver(() => {
    paneWidth.value = panel.clientWidth;
  });
  paneObserver.observe(panel);
  paneWidth.value = panel.clientWidth;
});

onBeforeUnmount(() => {
  paneObserver?.disconnect();
  paneObserver = null;
});
</script>

<style scoped lang="scss">
.compose-assets {
  min-width: 0;
}

.compose-assets__arrow {
  display: grid;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  place-items: center;
  border-radius: 8px;
  color: var(--compose-fg-3);
  transition:
    background-color 200ms cubic-bezier(0.25, 0.8, 0.25, 1),
    color 150ms cubic-bezier(0.25, 0.8, 0.25, 1);
}

.compose-assets__arrow:hover {
  background: var(--compose-surface-2);
  color: var(--compose-fg);
}
</style>
