# 天天视频剪辑

Vue 3 多轨视频合成编辑器（npm 包名 `daily-video-editor`）。提供素材栏、预览器、参数侧栏与时间轴。

> **当前仍处于迭代阶段。** API、工程 JSON 与 UI 可能随版本调整。后续计划陆续推出：**自定义字体**、**视频画面调色**、**前端合成**等能力。字段含义以 `dist/index.d.ts` 为准。

## 安装

需已安装 **Vue 3.5+**（`peerDependencies`）。

```bash
npm install daily-video-editor
```

也可用：

```bash
pnpm add daily-video-editor
# 或
yarn add daily-video-editor
```

安装后在入口引入样式（缺一不可）：

```ts
import "daily-video-editor/style.css";
```

本地联调或未发布到 registry 时，可用路径依赖：

```bash
# 相对路径 / 绝对路径
npm install ../VIDEO-Clips
# 或 package.json
# "daily-video-editor": "file:../VIDEO-Clips"
```

使用源码路径依赖前，请在本仓库执行 `npm run build`，确保存在 `dist/`。monorepo 可用 workspace 协议指向本包。

## 快速接入

```ts
import { createApp, ref } from "vue";
import {
  createDefaultVideoComposeEditorModel,
  VideoComposeEditor,
  type VideoComposeEditorExpose,
  type VideoComposeEditorModel,
} from "daily-video-editor";
import "daily-video-editor/style.css";

const model = ref<VideoComposeEditorModel>(
  createDefaultVideoComposeEditorModel({
    bizType: "source_video",
    bizId: "local",
  }),
);
const editorRef = ref<VideoComposeEditorExpose | null>(null);

createApp(App).mount("#app");
```

```vue
<VideoComposeEditor ref="editorRef" v-model="model" />
```

**换稿必须调用 `editorRef.reload(model)`。** 只改 `v-model` 引用不会回灌时间轴。

`peerDependencies` 只有 `vue`。

---

## 导出数据结构

### `ComposeExportPayload`（成片请求快照）

调用 `exportComposePayload()` 返回。先 `flush`，再取当前工程：

| 字段      | 类型               | 说明                       |
| --------- | ------------------ | -------------------------- |
| `id`      | `string`           | 合成草稿主键               |
| `bizType` | `MediaBizType`     | 业务类型                   |
| `bizId`   | `string \| number` | 业务实体 id                |
| `tracks`  | `ComposeTrack[]`   | 多轨列表（渲染侧主要消费） |

### `VideoComposeEditorModel`（v-model / 持久化真相源）

| 字段                       | 类型               | 说明                           |
| -------------------------- | ------------------ | ------------------------------ |
| `id`                       | `string`           | 合成草稿主键                   |
| `bizType`                  | `MediaBizType`     | 业务类型                       |
| `bizId`                    | `string \| number` | 业务实体 id                    |
| `tracks`                   | `ComposeTrack[]`   | 多轨列表                       |
| `scale?`                   | `number`           | 时间轴显示倍率；成片渲染忽略   |
| `composeExtractAudioUrls?` | `string[]`         | 兼容旧工程抽轨 URL；本地仅透传 |

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

本期支持：`MediaClip`（`video` \| `audio`）| `ComposeSubtitleClip` | `TextClip`。

共性字段见 `BaseClip`（`id`、`trackId`、`startTime` / `endTime`、`rect`、`visible`、`config` 等）。

- **视频 / 音频**：`sourceUrl`、`trimStart` / `trimEnd`、`playbackRate`、`volume` 等；业务扩展在 `config`（美颜、画面变换、抽轨关联等）
- **字幕**：文案与字体样式，另含 ASS 扩展（`bold` / `italic` / `alignment` / 边距等）
- **花字（贴图）**：`text`、`fontSize`、`color`；模板资源在 `config.sourceUrl` / `config.templateId`

可用 `createDefaultVideoComposeEditorModel({ bizType, bizId })` 创建空工程。

---

## 组件 Ref 方法（`VideoComposeEditorExpose`）

| 方法                                           | 说明                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| `validate(): string \| null`                   | 导出前校验。`null` 表示通过，否则为错误文案                       |
| `flush(): void`                                | 立刻把当前轨道、缩放等写入 `update:modelValue`                    |
| `reload(model): Promise<void>`                 | 用指定工程整页重置时间轴。换稿只走这个方法                        |
| `exportComposePayload(): ComposeExportPayload` | 先 `flush`，再返回 `{ id, bizType, bizId, tracks }`               |
| `getMainVideoClips(): VideoClipItem[]`         | 主轨视频片段。优先读时间轴，否则用派生列表                        |
| `requestUploadClip(): void`                    | 触发上传视频：有 `onRequestUploadClip` 则交给宿主，否则走内置上传 |
| `getEditingClip(): ComposeClip \| null`        | 右栏 inspector 当前类型对应的选中 clip                            |
| `getSelectedClips(): ComposeClip[]`            | 当前时间轴多选解析后的 clip 列表                                  |

---

## 插槽（Slots）

未传入时走内置默认 UI；传入后替换对应区域。

### 素材栏操作区

替换各分类「上传 / 添加」入口（有插槽时不再渲染默认按钮）：

| 插槽名             | 位置     |
| ------------------ | -------- |
| `video-actions`    | 视频素材 |
| `audio-actions`    | 音频     |
| `subtitle-actions` | 字幕     |
| `fancy-actions`    | 花字     |
| `sfx-actions`      | 音效     |

### 参数侧栏「应用到全局」之前

供宿主插入自定义控件：

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
| `track-control`      | 轨道右侧操作区；追加在内置静音/向前对齐之后 | `{ track }` |

说明：

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
    <!-- 工具栏操作区末尾；readonly 时不可见 -->
  </template>
  <template #track-control="{ track }">
    <!-- 追加在静音/对齐之后；需自行处理 readonly 禁用 -->
  </template>
</VideoComposeEditor>
```

---

## Props / 事件（摘要）

常用 Props：`modelValue`、`readonly`、`videoAssets` / `audioAssets` / `sfxAssets` / `subtitleAssets` / `textTemplates`、`uploadAdapter`、`onRequestUploadClip` 等、`resolveMediaUrl`、`algorithmBaseUrl`、`trackTypes`。

常用事件：`update:modelValue`、`ready`、`remove-catalog-clip`、`toggle-like`、`video-uploaded` / `audio-uploaded` / `sfx-uploaded` / `text-template-uploaded`、`selection-changed`。

上传成功事件载荷：`{ file: File; item: T; items: T[] }`。纯 `onRequestUpload*` 由宿主自管 UX，不走该 emit。

---

## 公共类型（包根导出）

- 组件与工厂：`VideoComposeEditor`、`createDefaultVideoComposeEditorModel`
- 工程：`VideoComposeEditorModel`、`ComposeExportPayload`、`ComposeTrack`、`ComposeClip`、`MediaBizType`、`MediaRef`、`ComposeSegmentClipAssets`
- 侧栏种子：`BgmItem`、`TextTemplateItem`、`VideoClipItem`
- 入参与上传：`ComposeEditorProps`、`ComposeUploadAdapter`、`ComposeBgmUploadResult`、`ComposeCatalogUploadPayload`
- Ref：`VideoComposeEditorExpose`
- 轨道片段：`MediaClip`、`SubtitleClip`、`TextClip`、`TrackType`、`TrackTypeConfig`
- 媒体地址：`createComposeMediaResolver`、`isPassthroughMediaUrl`、`mediaCorsMessage`、`ComposeMediaResolver`、`ResolveMediaUrl`

---

## 构建与产物

```bash
npm run build
```

库产物：`dist/index.js`、`dist/index.d.ts`、`dist/style.css`、`dist/algorithm/`。

宿主必须引入样式：

```ts
import "daily-video-editor/style.css";
```

美颜预览 Worker 在构建时内联进 `dist/index.js`，无需单独部署。`dist/algorithm/` 须挂到宿主静态目录（默认 `/algorithm/`）：

- `/algorithm/face_landmarker.task`
- `/algorithm/mediapipe/`

可用 `algorithmBaseUrl` 改根路径。

---

## 跨域媒体

预览、缩略图和美颜抽帧都要能读取像素。编辑器会给 `video` / `audio` 设 `crossorigin="anonymous"`，对跨域地址默认 CORS `fetch` 并转成 `blob:`。源站需允许 CORS；失败时配置 `resolveMediaUrl` 走同源代理或 blob。本仓库不实现代理服务。

```vue
<VideoComposeEditor v-model="model" :resolve-media-url="proxyToBlob" />
```

---

## 路线图（规划中）

| 方向         | 说明                                 |
| ------------ | ------------------------------------ |
| 自定义字体   | 宿主 / 用户字体接入字幕与花字        |
| 视频画面调色 | 亮度、对比度、色温等画面调整         |
| 前端合成     | 浏览器端导出成片，减少对后端渲染依赖 |

欢迎在迭代过程中反馈接入问题；正式 API 稳定前请以类型声明与本 README 同步查阅。

---

## 致谢

本项目的时间轴组件基于开源库 [vue-clip-track](https://github.com/caohongz/vue-clip-track) 衍生而来。感谢原作者与贡献者提供的多轨编辑能力——轨道交互、时间轴缩放与片段操作等，为本编辑器打下了坚实基础。

仓库内 `src/clip-track` 已面向合成编辑场景做了定制演进，与上游并非一一对应；欢迎一并了解原项目。
