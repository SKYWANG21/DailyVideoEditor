# 天天视频剪辑

Vue 3 多轨视频剪辑组件，npm 包名为 `daily-video-editor`。在宿主页面中可导入素材、编辑时间轴、预览画面、调色、截图和导出 MP4。

## 安装与接入

项目需安装 Vue 3.5+。

```bash
npm install daily-video-editor
```

在宿主的 `App.vue` 中接入组件并引入样式。给编辑器容器设置高度，例如以下示例中的 `100vh`。

```vue
<script setup lang="ts">
import { ref } from "vue";
import { createDefaultVideoComposeEditorModel, VideoComposeEditor, type VideoComposeEditorExpose } from "daily-video-editor";
import "daily-video-editor/style.css";

const model = ref(createDefaultVideoComposeEditorModel({ bizType: "source_video", bizId: "local" }));
const editorRef = ref<VideoComposeEditorExpose | null>(null);
</script>

<template>
  <div style="height: 100vh">
    <VideoComposeEditor ref="editorRef" v-model="model" />
  </div>
</template>
```

将 `model` 保存到宿主业务中。切换草稿时使用 `await editorRef.value?.reload(nextModel)`，让时间轴同步载入新稿。保存前可调用 `flush()` 提交当前编辑。

本地联调时，先在本仓库运行 `npm run build` 生成 `dist/`，再在宿主项目中运行 `npm install ../VIDEO-Clips`。Monorepo 可使用 workspace 依赖。

## 剪辑操作

1. 从素材栏上传或添加素材，将视频拖到主视频轨，再添加需要的音频、字幕或花字。
2. 在主视频轨添加转场时，将左侧「转场」卡片拖到相邻视频的接缝。也可选中相邻视频后双击卡片。用接缝手柄调整时长或删除转场。
3. 在时间轴选中视频片段，打开右侧「调色」，通过滑块或数字框调整色温、色调、饱和度、亮度、对比度、高光、阴影、锐化和颗粒。松开滑块或确认数值后生效，点击「重置」即可恢复。点击视频设置的「应用到全局」会将当前调色、美颜、音量和倍速应用到所有视频片段。

## 截图与 MP4 导出

### 截图

将播放头定位到目标画面，等待预览就绪。演示页可点击「截图」。宿主可调用 `captureCurrentFrame()` 获取 PNG 的 `blob`，用于下载或上传。若返回 `null`，请先让预览显示画面。截图会包含画面当前可见的字幕和花字。

```ts
const frame = await editorRef.value?.captureCurrentFrame();
```

### 导出 MP4

先在主视频轨添加视频，确认字幕、花字和音频都落在主轨输出范围内。演示页可点击「导出视频」。宿主可调用 `exportVideo()`，如果出现分辨率选择，选定档位后点击「开始导出」。导出完成后可用结果的 `blob` 和 `fileName` 触发下载。

```ts
const result = await editorRef.value?.exportVideo();
```

- 导出环境需使用 HTTPS 或 localhost，浏览器需支持 `OffscreenCanvas` 和 H.264 编码。
- 导出中可在遮罩点击「取消导出」，也可通过 `exportVideo({ signal, onProgress })` 接入宿主的取消与进度提示。
- 增强放大不可用时，可调用 `exportVideo({ resolution: "source" })` 按素材分辨率导出。
- 如果宿主已有自己的渲染流程，可用 `exportComposePayload()` 获取工程数据。

## 主视频轨转场

转场以相邻视频的切点为中心，默认时长 1 秒，实际时长受两侧片段长度限制。片段位置和工程总时长保持原样，原声在切点切换。两侧各自完成美颜、画面变换和调色后再进入转场。

| 效果       | `effectId`        | 表现                                                   |
| ---------- | ----------------- | ------------------------------------------------------ |
| 淡化       | `crossfade`       | 离场与入场画面平滑交叠                                 |
| 推进       | `zoom-in`         | A 从 1 倍放大至 2 倍，B 从 0.5 倍同步放大至 1 倍       |
| 淡入淡出   | `fade-black`      | 离场画面淡出至黑，中点全黑，再淡入下一画面             |
| 拉远       | `zoom-out`        | A 从 1 倍缩小至 0.5 倍，B 从 2 倍同步缩小至 1 倍       |
| 百叶窗     | `blinds`          | 10 条水平条带，各条由上向下展开                        |
| 倾斜百叶窗 | `blinds-diagonal` | 条带倾斜 45°，沿条带法线展开                           |
| 向右擦除   | `wipe-right`      | 入场画面从左向右覆盖                                   |
| 向左擦除   | `wipe-left`       | 入场画面从右向左覆盖                                   |
| 中分展开   | `split-open`      | 入场画面从中央向左右两侧展开                           |
| 轻微晃动   | `shake`           | 交叉淡化叠加轻微位移和旋转，首尾复位并自动放大避免露边 |

```ts
const transitions = [
  {
    id: "transition-1",
    clipAId: "video-a",
    clipBId: "video-b",
    effectId: "crossfade",
    durationSec: 1,
    params: { curve: "linear" },
  },
];
```

绘制驱动 `TransitionEngine` 通过 `TransitionRegistry` 加载算法。素材面板与接缝菜单读取同一份效果目录。为项目增加内置算法时，需实现 `TransitionAlgorithm` 并在目录注册描述及 `load()`。引擎返回的 Canvas 是复用缓冲，需要保存跨帧结果时调用 `renderBitmap()`。 [效果目录](./src/transitions/catalog.ts)

### 自定义转场

通过 `transitionEffects` 追加转场效果。重复 ID 会报错，效果列表在挂载时读取。素材栏、缩略图、接缝菜单、时间轴命令和预览共享编辑器注册表。

```vue
<VideoComposeEditor v-model="model" :transition-effects="hostTransitions" />
```

Canvas 扩展示例使用包根导出的类型。

```ts
import type { TransitionAlgorithm, TransitionEffectDefinition } from "daily-video-editor";

const hostTransitions: readonly TransitionEffectDefinition[] = [
  {
    id: "host-wipe",
    name: "向右擦除",
    description: "入场画面从左向右覆盖离场画面",
    defaultParams: {},
    /** 当前效果无需专属参数。 */
    normalizeParams(): Record<string, unknown> {
      return {};
    },
    /** 首次生成缩略图或播放时加载。实例内的 render 应支持重入。 */
    async load(): Promise<TransitionAlgorithm> {
      return {
        /** 输入已完成画面变换，进度已缓动，绘制状态由引擎隔离。 */
        render({ ctx, outgoing, incoming, width, height, progress }): void {
          ctx.drawImage(outgoing, 0, 0, width, height);
          ctx.beginPath();
          ctx.rect(0, 0, width * progress, height);
          ctx.clip();
          ctx.drawImage(incoming, 0, 0, width, height);
        },
      };
    },
  },
];
```

WASM 算法使用相同定义，将 `load` 替换为适配器调用，并使用独立 ID。

```ts
import { loadWasmTransitionAlgorithm } from "daily-video-editor";

const hostWasmTransition: TransitionEffectDefinition = {
  ...hostTransitions[0],
  id: "host-wasm-fade",
  name: "宿主淡化",
  description: "使用宿主提供的 WASM 混合两帧",
  load: () => loadWasmTransitionAlgorithm("/custom-transitions/fade.wasm"),
};
```

`transitionBackend` 选择全部内置效果的实现，宿主效果始终使用自身的 `load()`。独立使用引擎时可调用
`new TransitionEngine(createTransitionRegistry({ effects: hostTransitions }))`，也可继续手动 `registry.register()`。
注册和 `list()` 查询不加载算法。素材卡片生成缩略图属于首次实际使用，会触发 `load()`。同一注册表缓存同一效果的加载结果，
宿主异步算法须支持多个引擎调用同一实例，不得在渲染结束后保留调用方的画面或上下文。独立引擎仍依赖浏览器 Canvas API。
工程仅保存效果 ID、时长和可序列化参数，重载时宿主须再次提供对应定义。缺失算法保留工程配置，并沿用普通画面降级提示。

## 工程与导出数据结构

### `ComposeExportPayload`（成片请求快照）

`exportComposePayload()` 先提交当前编辑，再返回以下工程快照。

| 字段      | 类型               | 说明                       |
| --------- | ------------------ | -------------------------- |
| `id`      | `string`           | 合成草稿主键               |
| `bizType` | `MediaBizType`     | 业务类型                   |
| `bizId`   | `string \| number` | 业务实体 id                |
| `tracks`  | `ComposeTrack[]`   | 多轨列表（渲染侧主要消费） |

### `VideoComposeEditorModel`（v-model / 持久化真相源）

| 字段                       | 类型               | 说明                   |
| -------------------------- | ------------------ | ---------------------- |
| `id`                       | `string`           | 合成草稿主键           |
| `bizType`                  | `MediaBizType`     | 业务类型               |
| `bizId`                    | `string \| number` | 业务实体 id            |
| `tracks`                   | `ComposeTrack[]`   | 多轨列表               |
| `scale?`                   | `number`           | 仅用于时间轴的显示倍率 |
| `composeExtractAudioUrls?` | `string[]`         | 透传旧工程的抽轨 URL   |

侧栏视频 / 音频 / 音效 / 字幕 / 花字列表由 **Editor 内部数组**维护，**不写入** `v-model`。

### `ComposeTrack`

| 字段                                       | 类型                 | 说明                                                   |
| ------------------------------------------ | -------------------- | ------------------------------------------------------ |
| `id`                                       | `string`             | 轨道唯一 id                                            |
| `type`                                     | `TrackType`          | 轨道类型（如 `video` / `audio` / `subtitle` / `text`） |
| `name`                                     | `string`             | 展示名                                                 |
| `isMain?`                                  | `boolean`            | 是否主视频轨                                           |
| `visible`                                  | `boolean`            | 是否可见                                               |
| `locked`                                   | `boolean`            | 是否锁定                                               |
| `muted?`                                   | `boolean`            | 音频轨整轨静音                                         |
| `clips`                                    | `ComposeClip[]`      | 轨道片段                                               |
| `order`                                    | `number`             | 排序                                                   |
| `frameAspect?`                             | `ComposeFrameAspect` | 视频轨画幅                                             |
| `nativeFrameWidth?` / `nativeFrameHeight?` | `number`             | 原画像素                                               |

### `ComposeClip`

工程支持 `MediaClip`（视频和音频）、`ComposeSubtitleClip`（字幕）和 `TextClip`（花字）。

共性字段见 `BaseClip`（`id`、`trackId`、`startTime` / `endTime`、`rect`、`visible`、`config` 等）。

- 视频和音频片段包含 `sourceUrl`、`trimStart` / `trimEnd`、`playbackRate` 和 `volume` 等字段。`config` 保存美颜、画面变换、调色或抽轨关联等扩展数据。
- 字幕片段包含文案与字体样式，以及 `bold`、`italic`、`alignment` 和边距等 ASS 扩展。
- 花字片段包含 `text`、`fontSize` 和 `color`，模板资源记录在 `config.sourceUrl` / `config.templateId`。

可用 `createDefaultVideoComposeEditorModel({ bizType, bizId })` 创建空工程。

## 组件 Ref 方法

| 方法                                      | 用途                                                |
| ----------------------------------------- | --------------------------------------------------- |
| `validate()`                              | 校验当前工程。通过时返回 `null`，否则返回错误文案。 |
| `flush()`                                 | 将当前编辑提交到 `v-model`。                        |
| `reload(model)`                           | 加载指定工程，用于换稿。                            |
| `exportComposePayload()`                  | 提交当前编辑并返回工程快照。                        |
| `exportVideo(options?)`                   | 在浏览器中渲染并返回 MP4。                          |
| `captureCurrentFrame()`                   | 获取当前预览的 PNG 截图，无画面时返回 `null`。      |
| `getMainVideoClips()`                     | 获取主视频轨片段。                                  |
| `getEditingClip()` / `getSelectedClips()` | 获取正在编辑的片段或时间轴选区。                    |
| `requestUploadClip()`                     | 打开视频上传入口。                                  |

## 插槽（Slots）

传入插槽可替换对应区域的默认控件。

### 素材栏操作区

以下插槽用于替换各分类的「上传 / 添加」按钮。

| 插槽名             | 位置     |
| ------------------ | -------- |
| `video-actions`    | 视频素材 |
| `audio-actions`    | 音频     |
| `subtitle-actions` | 字幕     |
| `fancy-actions`    | 花字     |
| `sfx-actions`      | 音效     |

### 参数侧栏「应用到全局」之前

使用以下插槽在「应用到全局」前插入自定义控件。

| 插槽名                  | 对应 inspector |
| ----------------------- | -------------- |
| `before-apply-video`    | 视频           |
| `before-apply-audio`    | 音频           |
| `before-apply-subtitle` | 字幕           |
| `before-apply-text`     | 花字 / 贴图    |

### 时间轴（透传 clip-track 具名 slot）

| 插槽名               | 位置 / 用途                                 | 插槽 props  |
| -------------------- | ------------------------------------------- | ----------- |
| `toolbar-before`     | 工具栏整条之前                              | —           |
| `toolbar-after`      | 工具栏整条之后                              | —           |
| `operations-prepend` | 顶部操作按钮区前                            | —           |
| `operations-append`  | 顶部操作按钮区后                            | —           |
| `track-control`      | 轨道右侧操作区，追加在内置静音/向前对齐之后 | `{ track }` |

- `readonly` 时工具栏不渲染，`toolbar-*` / `operations-*` 不可见。
- `track-control` 内宿主内容不会自动跟随 `readonly` 禁用，需宿主自行处理。

```vue
<VideoComposeEditor v-model="model">
  <template #video-actions>
    <button type="button" @click="openHostUploader">自定义上传</button>
  </template>
  <template #before-apply-video>
    <!-- 宿主扩展控件 -->
  </template>
  <template #operations-append>
    <!-- 工具栏操作区末尾，readonly 时不可见 -->
  </template>
  <template #track-control="{ track }">
    <!-- 追加在静音/对齐之后。宿主需处理 readonly -->
  </template>
</VideoComposeEditor>
```

## Props / 事件（摘要）

接入时可配置 `modelValue`、`readonly`、`videoAssets` / `audioAssets` / `sfxAssets` / `subtitleAssets` / `textTemplates`、`uploadAdapter`、`onRequestUploadClip` 等、`resolveMediaUrl`、`algorithmBaseUrl`、`trackTypes`、`transitionBackend`、`transitionEffects`、`exportWorkerFactory`。

组件常用事件包括 `update:modelValue`、`ready`、`remove-catalog-clip`、`toggle-like`、`video-uploaded` / `audio-uploaded` / `sfx-uploaded` / `text-template-uploaded`、`selection-changed`。

上传成功事件提供的载荷为 `{ file: File; item: T; items: T[] }`。如果只使用 `onRequestUpload*`，上传交互和结果反馈由宿主管理。

## 公共类型（包根导出）

- 组件与工厂：`VideoComposeEditor`、`createDefaultVideoComposeEditorModel`
- 工程：`VideoComposeEditorModel`、`ComposeExportPayload`、`ComposeTrack`、`ComposeClip`、`MediaBizType`、`MediaRef`、`ComposeSegmentClipAssets`
- 侧栏种子：`BgmItem`、`TextTemplateItem`、`VideoClipItem`
- 入参与上传：`ComposeEditorProps`、`ComposeUploadAdapter`、`ComposeBgmUploadResult`、`ComposeCatalogUploadPayload`
- Ref：`VideoComposeEditorExpose`
- 轨道片段：`MediaClip`、`SubtitleClip`、`TextClip`、`TrackType`、`TrackTypeConfig`
- 媒体地址：`createComposeMediaResolver`、`isPassthroughMediaUrl`、`mediaCorsMessage`、`ComposeMediaResolver`、`ResolveMediaUrl`
- 截图、导出与调色：`ComposeFrameCapture`、`ComposeVideoExportOptions`、`ComposeVideoExportResult`、`ComposeVideoExportResolution`、`VideoAdjustments`

## 部署与排查

- 自行部署库产物时，运行 `npm run build`，将 `dist/algorithm/` 部署到宿主静态目录，默认地址为 `/algorithm/`。目录中的 `face_landmarker.task` 和 `mediapipe/` 用于美颜。可通过 `algorithmBaseUrl` 指定部署路径。
- 跨域素材需允许 CORS。预览或导出报素材读取失败时，可通过 `resolveMediaUrl` 返回浏览器可读的同源代理地址或 Blob URL。例如 `<VideoComposeEditor v-model="model" :resolve-media-url="proxyToBlob" />`。
- 宿主可用 `transition-backend="wasm"` 启用内置 WASM 转场，通过 `:transition-effects="hostTransitions"` 注册自定义效果。配置在挂载时读取，变更后需重新挂载。浏览器导出自定义转场时，还需在 `exportWorkerFactory` 创建的 Worker 中注册同 ID 的效果。
- 完整接入类型以包中的 `dist/index.d.ts` 为准。
