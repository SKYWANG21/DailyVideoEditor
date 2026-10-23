<template>
  <div ref="shellRef" class="compose-shell relative isolate h-full w-full min-h-0 overflow-hidden">
    <div class="grid h-full w-full min-h-0 overflow-hidden" :style="shellGridStyle">
      <div class="grid min-h-0 overflow-hidden" :style="topGridStyle">
        <VideoComposeAssetPanel
          v-if="!readonly"
          class="h-full min-h-0 w-full min-w-0"
          :video-variants="videoCatalogVariants"
          :liked-media-keys="likedMediaKeys"
          :timeline-clip-urls="timelineClipUrls"
          :preview-clip-id="previewCatalogVariant?.id"
          :readonly="readonly"
          :audio-clip-count="audioClipCount"
          :audio-assets="audioAssets"
          :sfx-assets="sfxAssets"
          :subtitle-assets="subtitleAssets"
          :text-templates="textTemplateCatalog"
          @open-upload-bgm="uploadAudioModalOpen = true"
          @upload-clip="uploadClipModalOpen = true"
          @upload-sfx="uploadSfxModalOpen = true"
          @upload-fancy="onFancyUploaded"
          @add-subtitle="onAddSubtitle"
          @preview-clip="onCatalogPreview"
          @remove-catalog-clip="onRemoveCatalogVariant"
          @toggle-like="onToggleCatalogLike"
        >
          <template v-for="name in forwardedActionSlots" :key="name" #[name]>
            <slot :name="name" />
          </template>
        </VideoComposeAssetPanel>
        <div
          v-if="!readonly"
          class="compose-split compose-split--col"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整素材栏宽度"
          @pointerdown="onSplitPointerDown($event, 'left')"
        />
        <VideoComposePlayer
          ref="playerRef"
          class="h-full min-h-0 w-full min-w-0"
          :video-clips="derivedMainClips"
          :override-clips="previewOverrideClips"
          :catalog-preview-active="!!previewCatalogVariant"
          :catalog-preview-label="previewCatalogLabel"
          :audio-clips="catalogPreviewActive ? [] : derivedAudioClips"
          :compose-config="catalogPreviewActive ? catalogPreviewComposeConfig : derivedComposeConfig"
          :duration-sec="previewDurationSec"
          :show-subtitles="!previewCatalogVariant"
          :visible-preview-subtitles="visiblePreviewSubtitles"
          :adjust-preview-subtitles="adjustPreviewSubtitles"
          :subtitle-style="subtitleStyle"
          :text-clips="textOverlayClips"
          :selected-text-clip-id="activeTextClipId"
          :readonly="readonly"
          :canvas-width="canvasSize.width"
          :canvas-height="canvasSize.height"
          :video-frame="visibleVideoFrame"
          :show-video-frame-box="showVideoFrameBox"
          :visible-clip-id="visibleClipId"
          @update:playing-idx="playingIdx = $event"
          @toggle-playback="onPreviewTogglePlayback"
          @seek-playback="onPreviewSeek"
          @global-time-update="onPlayerGlobalTimeUpdate"
          @update:is-adjusting="onIsAdjustingUpdate"
          @update:video-ready="videoReady = $event"
          @clear-catalog-preview="clearCatalogPreview"
          @update:text-clip-rect="onTextClipRectUpdate"
          @select-text-clip="onSelectTextClip"
          @select-subtitle-clip="onSelectSubtitleClip"
          @update:subtitle-text="onPreviewSubtitleTextUpdate"
          @select-video-clip="onSelectVideoClip"
          @update:video-frame="onVisibleFrameChange"
          @update:source-size="onVideoSourceSize"
        />

        <div
          v-if="!readonly"
          class="compose-split compose-split--col"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整参数栏宽度"
          @pointerdown="onSplitPointerDown($event, 'right')"
        />
        <VideoComposeSidebar
          v-if="!readonly"
          ref="sidebarRef"
          class="h-full min-h-0 w-full min-w-0"
          :video-volume="videoVolume"
          :beauty="beauty"
          :video-volume-label="videoVolumeLabel"
          :audio-volume-label="audioVolumeLabel"
          :bgm-volume="bgmVolume"
          :audio-clip-count="audioClipCount"
          :font-label="fontLabel"
          :style-label="styleLabel"
          :subtitle-style="subtitleStyle"
          :subtitle-visible="subtitleVisible"
          :is-adjusting="isAdjusting"
          :video-ready="videoReady"
          :inspector-kind="inspectorKind"
          :frame-aspect="frameAspect"
          :video-frame="inspectorVideoFrame"
          :can-edit-video-frame="canEditVideoFrame"
          :selected-text-clip="selectedTextClipProps"
          :selected-subtitle-text="selectedSubtitleText"
          :selected-subtitle-id="activeSubtitleId"
          :has-selected-subtitle="Boolean(activeSubtitleId)"
          @update:video-volume="onVideoVolumeChange"
          @update:beauty="onBeautyChange"
          @update:bgm-volume="onBgmVolumeChange"
          @update:subtitle-style="onSubtitleStyleChange"
          @update:subtitle-visible="onSubtitleVisibleChange"
          @update:subtitle-text="onSubtitleTextChange"
          @commit:subtitle-text="onSubtitleTextCommit"
          @update:text-clip-props="onTextClipPropsChange"
          @font-popover-toggle="onFontPopoverToggle"
          @toggle-adjust-position="toggleAdjustSubPosition"
          @apply-global="onApplyGlobal"
          @update:frame-aspect="onFrameAspectChange"
          @update:video-frame="onInspectorFrameChange"
        />
      </div>

      <div
        class="compose-split compose-split--row"
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整时间轴高度"
        @pointerdown="onSplitPointerDown($event, 'timeline')"
      />

      <VideoComposeTimeline
        ref="timelineRef"
        class="h-full min-h-0 w-full min-w-0"
        :tracks="tracks"
        :readonly="readonly"
        :scale="modelValue.scale"
        @update:tracks="onTracksUpdate"
        @update:scale="onTimelineScaleUpdate"
        @selection-changed="onSelectionChanged"
        @playback-play="onTimelinePlay"
        @playback-pause="onTimelinePause"
        @playback-seek="onTimelineSeek"
        @time-update="onTimelineTimeUpdate"
        @playback-ratechange="onTimelineRateChange"
        @drop-catalog-clip="onTimelineDropCatalogClip"
        @drop-audio-asset="onTimelineDropAudioAsset"
        @drop-subtitle-asset="onTimelineDropSubtitleAsset"
        @drop-text-template="onTimelineDropTextTemplate"
        @inspect-track="onInspectTrack"
      />
    </div>

    <BgmUploadModal v-model:open="uploadAudioModalOpen" :submitting="false" @uploaded="onAudioUploaded" />

    <BgmUploadModal
      v-model:open="uploadSfxModalOpen"
      title="上传音效"
      picker-text="点击或拖拽上传音效"
      success-text="已添加音效"
      :submitting="false"
      @uploaded="onSfxUploaded"
    />

    <VideoClipUploadModal v-if="!readonly" v-model:open="uploadClipModalOpen" @uploaded="onClipUploaded" />

    <SubtitleFontPopover
      v-model:font-popover-open="fontPopoverOpen"
      :font-family-dropdown-style="fontFamilyDropdownStyle"
      :font-style-dropdown-style="fontStyleDropdownStyle"
      :font-options="fontOptions"
      :style-options="styleOptions"
      :subtitle-style="subtitleStyle"
      :font-style-key="fontStyleKey"
      @select-family="onFontOptionSelect"
      @select-style="onStyleOptionSelect"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, useSlots } from "vue";
import VideoComposeAssetPanel from "./asset-panel/VideoComposeAssetPanel.vue";
import VideoComposePlayer from "./player/VideoComposePlayer.vue";
import VideoComposeSidebar from "./sidebar/VideoComposeSidebar.vue";
import VideoComposeTimeline from "./timeline/VideoComposeTimeline.vue";
import BgmUploadModal from "./modals/BgmUploadModal.vue";
import VideoClipUploadModal from "./modals/VideoClipUploadModal.vue";
import SubtitleFontPopover from "./sidebar/SubtitleFontPopover.vue";
import { textTemplateCatalog } from "./shared/textTemplateCatalog";
import { useComposeEditorSession } from "./session/useComposeEditorSession";
import type { ComposeSegmentClipGroup, VideoComposeClipInput, VideoComposeEditorModel } from "@/types/videoCompose";

const props = withDefaults(
  defineProps<{
    /** 视频片段入参 */
    clips: VideoComposeClipInput[];
    /** 编辑器聚合状态 */
    modelValue: VideoComposeEditorModel;
    /** 只读模式 */
    readonly?: boolean;
    /** 各片段历史版本素材库（侧栏展示，不自动上轴） */
    segmentCatalog?: ComposeSegmentClipGroup[];
  }>(),
  {
    readonly: false,
    segmentCatalog: () => [],
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: VideoComposeEditorModel];
  ready: [];
}>();

/** 分类操作插槽名。外壳没传时不转发，面板保留默认上传按钮 */
const actionSlotNames = ["video-actions", "audio-actions", "subtitle-actions", "fancy-actions", "sfx-actions"] as const;

const editorSlots = useSlots();

/** 只转发外壳真正传入的分类操作插槽 */
const forwardedActionSlots = computed(() => actionSlotNames.filter((name) => editorSlots[name]));

const {
  shellRef,
  shellGridStyle,
  topGridStyle,
  onSplitPointerDown,
  playerRef,
  sidebarRef,
  timelineRef,
  derivedMainClips,
  derivedAudioClips,
  playingIdx,
  isAdjusting,
  videoReady,
  previewDurationSec,
  tracks,
  audioAssets,
  sfxAssets,
  subtitleAssets,
  audioClipCount,
  subtitleStyle,
  subtitleVisible,
  videoVolume,
  beauty,
  bgmVolume,
  videoVolumeLabel,
  audioVolumeLabel,
  inspectorKind,
  selectedTextClipProps,
  selectedSubtitleText,
  activeSubtitleId,
  activeTextClipId,
  textOverlayClips,
  derivedComposeConfig,
  previewCatalogVariant,
  uploadAudioModalOpen,
  uploadSfxModalOpen,
  uploadClipModalOpen,
  visiblePreviewSubtitles,
  adjustPreviewSubtitles,
  onPreviewTogglePlayback,
  onPreviewSeek,
  onPlayerGlobalTimeUpdate,
  onTimelinePlay,
  onTimelinePause,
  onTimelineSeek,
  onTimelineTimeUpdate,
  onTimelineRateChange,
  onVideoVolumeChange,
  onBeautyChange,
  onBgmVolumeChange,
  onSubtitleStyleChange,
  onSubtitleVisibleChange,
  onSubtitleTextChange,
  onSubtitleTextCommit,
  onSelectSubtitleClip,
  onPreviewSubtitleTextUpdate,
  onApplyGlobal,
  onTextClipPropsChange,
  onTextClipRectUpdate,
  onSelectTextClip,
  toggleAdjustSubPosition,
  onIsAdjustingUpdate,
  onSelectionChanged,
  onInspectTrack,
  fontPopoverOpen,
  fontFamilyDropdownStyle,
  fontStyleDropdownStyle,
  fontOptions,
  styleOptions,
  fontLabel,
  fontStyleKey,
  styleLabel,
  onFontPopoverToggle,
  onFontOptionSelect,
  onStyleOptionSelect,
  videoCatalogVariants,
  likedMediaKeys,
  catalogPreviewActive,
  previewOverrideClips,
  previewCatalogLabel,
  timelineClipUrls,
  catalogPreviewComposeConfig,
  onCatalogPreview,
  clearCatalogPreview,
  onRemoveCatalogVariant,
  onTimelineDropCatalogClip,
  onTimelineDropAudioAsset,
  onTimelineDropSubtitleAsset,
  onTimelineDropTextTemplate,
  onAudioUploaded,
  onSfxUploaded,
  onFancyUploaded,
  onToggleCatalogLike,
  onClipUploaded,
  onAddSubtitle,
  onTracksUpdate,
  onTimelineScaleUpdate,
  frameAspect,
  canvasSize,
  visibleClipId,
  visibleVideoFrame,
  inspectorVideoFrame,
  canEditVideoFrame,
  showVideoFrameBox,
  onSelectVideoClip,
  onInspectorFrameChange,
  onVisibleFrameChange,
  onFrameAspectChange,
  onVideoSourceSize,
} = useComposeEditorSession(props, emit);
</script>

<style lang="scss">
.compose-shell {
  --compose-surface: #ffffff;
  --compose-surface-2: #f0f0f4;
  --compose-surface-3: #e6e6ec;
  --compose-fg: #0e0e11;
  --compose-fg-2: #5b5b66;
  --compose-fg-3: #8e8e99;
  --compose-accent: #7650ff;
  --compose-accent-hover: #8664ff;
  --compose-accent-soft: rgba(118, 80, 255, 0.1);
  --compose-line: #d8d8e0;
  --compose-split: #e8e8ee;
  --compose-success: #1fae69;
  --compose-warning: #e8960f;
  --compose-danger: #ef3347;
  --compose-like: #f472b6;
  --compose-stage: #f1f1f5;
  --compose-thumb: #c9c9d4;
  --compose-shadow-card: 0 4px 24px rgba(14, 14, 17, 0.06);
  --compose-shadow-1: 0 1px 2px rgba(14, 14, 17, 0.06);
  --compose-focus: 0 0 0 4px rgba(118, 80, 255, 0.18);
  color: var(--compose-fg);
  font-family: "Noto Sans SC", "Source Han Sans SC", "Source Han Sans", sans-serif;
}

.dark .compose-shell {
  --compose-surface: #141420;
  --compose-surface-2: #1a1a28;
  --compose-surface-3: #1f1f30;
  --compose-fg: #ffffff;
  --compose-fg-2: #a3a3ad;
  --compose-fg-3: #6c6c76;
  --compose-accent: #8261ff;
  --compose-accent-hover: #9479ff;
  --compose-accent-soft: rgba(130, 97, 255, 0.14);
  --compose-line: rgba(255, 255, 255, 0.1);
  --compose-split: rgba(255, 255, 255, 0.06);
  --compose-success: #2fc77e;
  --compose-warning: #ffb547;
  --compose-danger: #ff4d5e;
  --compose-like: #f472b6;
  --compose-stage: #08080c;
  --compose-thumb: #2e2e44;
  --compose-shadow-card: 0 4px 24px rgba(0, 0, 0, 0.3);
  --compose-shadow-1: 0 1px 2px rgba(0, 0, 0, 0.4);
  --compose-focus: 0 0 0 4px rgba(130, 97, 255, 0.22);
}

.compose-shell .compose-scroll {
  scrollbar-width: none;
}

.compose-shell .compose-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.compose-shell .compose-scroll:hover {
  scrollbar-width: thin;
  scrollbar-color: var(--compose-thumb) transparent;
}

.compose-shell .compose-scroll:hover::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.compose-shell .compose-scroll:hover::-webkit-scrollbar-thumb {
  background: var(--compose-thumb);
  border-radius: 999px;
}

.compose-split {
  position: relative;
  z-index: 2;
  touch-action: none;
}

.compose-split--col {
  cursor: col-resize;
}

.compose-split--row {
  cursor: row-resize;
}

.compose-split::after {
  content: "";
  position: absolute;
  border-radius: 999px;
  background: transparent;
  transition: background-color 150ms cubic-bezier(0.25, 0.8, 0.25, 1);
}

.compose-split--col::after {
  top: 16px;
  bottom: 16px;
  left: 4px;
  width: 4px;
}

.compose-split--row::after {
  left: 16px;
  right: 16px;
  top: 4px;
  height: 4px;
}

.compose-split:hover::after,
.compose-split:active::after {
  background: var(--compose-accent-soft);
}

@media (prefers-reduced-motion: reduce) {
  .compose-shell,
  .compose-shell * {
    transition: none !important;
    animation: none !important;
  }
}
</style>
