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

### 主视频轨转场

左侧「转场」提供淡化及以下 9 种 Canvas 效果。卡片可拖至主轨接缝，也可选中相邻视频后双击应用；接缝双竖线手柄可修改时长或删除转场。
转场默认 1 秒，以切点居中，不改变片段位置或工程总时长。仅处理视频画面，原声仍在切点切换；两侧各自的美颜和画面变换会先处理再转场。

| 效果       | `effectId`        | 表现                                                   |
| ---------- | ----------------- | ------------------------------------------------------ |
| 推进       | `zoom-in`         | A 从 1 倍放大至 2 倍，B 从 0.5 倍同步放大至 1 倍       |
| 淡入淡出   | `fade-black`      | 离场画面淡出至黑，中点全黑，再淡入下一画面             |
| 拉远       | `zoom-out`        | A 从 1 倍缩小至 0.5 倍，B 从 2 倍同步缩小至 1 倍       |
| 百叶窗     | `blinds`          | 10 条水平条带，各条由上向下展开                        |
| 倾斜百叶窗 | `blinds-diagonal` | 条带倾斜 45°，沿条带法线展开                           |
| 向右擦除   | `wipe-right`      | 入场画面从左向右覆盖                                   |
| 向左擦除   | `wipe-left`       | 入场画面从右向左覆盖                                   |
| 中分展开   | `split-open`      | 入场画面从中央向左右两侧展开                           |
| 轻微晃动   | `shake`           | 交叉淡化叠加轻微位移和旋转，首尾复位并自动放大避免露边 |

所有内置效果均支持 `params.curve`：`linear`（默认）、`ease`、`ease-in`、`ease-out`、`ease-in-out`；其余视觉参数固定。

推进和拉远将缩小帧的四边、四角向外镜像铺满画布，再对 A/B 全画幅叠化，不再使用局部矩形裁切和背景扣除。
中心保持清晰，外围通过径向渐变混入轻微放射模糊，弱化镜像折返处；模糊在转场中段最强，首尾保持原始画面。
离屏缓冲按输出画布复用；镜像区域可能出现对称重复的物体。

配置保存在 `modelValue.tracks[].transitions`，随撤销重做、`reload()` 和 `exportComposePayload()` 一起读写：

```ts
transitions: [
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

旧工程缺省为空；关联视频不再相邻时清理转场，缩短片段时自动限制转场时长。实际成片服务由宿主消费该字段，本库不执行服务端渲染。

绘制驱动 `TransitionEngine` 与算法通过 `TransitionRegistry` 解耦。内置目录位于 `src/transitions/catalog.ts`；新增算法实现
`TransitionAlgorithm` 并在目录注册描述及 `load()`，素材面板与手柄菜单从该目录读取，不必修改引擎分发。
外部可使用导出的引擎、注册表和类型独立集成；引擎返回的 Canvas 为复用缓冲，需要保存跨帧结果时调用 `renderBitmap()`。

Canvas 为默认后端。宿主可通过 `<VideoComposeEditor v-model="model" transition-backend="wasm" />` 使用内置淡化 WASM；
独立使用时调用 `new TransitionEngine(createTransitionRegistry({ backend: "wasm" }))`。后端在挂载/创建注册表时固定，切换时需重建；
`effectId`、参数与工程数据不变。新增的 9 种效果在两种后端配置下均使用 Canvas，不加载 WASM。
预热和渲染共用编辑器注册表，WASM 首次使用时加载，失败沿用现有错误处理（预览提示并回退普通画面）。

宿主可通过 `transitionEffects` 追加自定义转场。素材栏、缩略图、接缝菜单、时间轴命令、预热与播放器共用编辑器注册表，
保留内置效果并按传入顺序追加；重复 ID（包括内置 ID）报错。后端与效果列表均在挂载时固定，变更时需重新挂载编辑器。

```vue
<VideoComposeEditor v-model="model" :transition-effects="hostTransitions" />
```

Canvas 算法示例（使用包根导出的类型）：

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
    /** 首次生成缩略图或播放时加载；实例内的 render 应支持重入。 */
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

宿主 WASM 算法使用相同定义，将 `load` 替换为适配器调用，并使用独立 ID：

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

`transitionBackend` 仅选择内置淡化的实现；其余内置效果固定使用 Canvas，宿主效果始终使用自身的 `load()`。独立使用引擎时可调用
`new TransitionEngine(createTransitionRegistry({ effects: hostTransitions }))`，也可继续手动 `registry.register()`。
注册和 `list()` 查询不加载算法；素材卡片生成缩略图属于首次实际使用，会触发 `load()`。同一注册表缓存同一效果的加载结果，
宿主异步算法须支持多个引擎调用同一实例，不得在渲染结束后保留调用方的画面或上下文；独立引擎仍依赖浏览器 Canvas API。
工程仅保存效果 ID、时长和可序列化参数，重载时宿主须再次提供对应定义；缺失算法保留工程配置，并沿用普通画面降级提示。

适配器 `loadWasmTransitionAlgorithm(url)` 可在自定义效果的 `load()` 中使用。模块不得依赖宿主导入，并须导出：

- `memory`：wasm32 线性内存。
- `__heap_base`：栈和静态数据之后的首个可用地址。该地址之后的空间由适配器保留，内核不得另行分配或增长内存。
- `render(a, b, output, width, height, progress, params, paramsLength): i32`：成功返回 0；其他返回值视为失败。

地址、尺寸和参数长度均为 `i32`，`progress` 为已经缓动的 `f64`。图像是自左上至右下、每行 `width * 4` 字节的
**非预乘 sRGB RGBA8**；参数为 UTF-8 JSON。适配器负责 Canvas 像素读写和缓冲复用，内核负责预乘颜色混合与反预乘输出。
内置淡化采用 Q16 权重与整数舍入；它与 Canvas 的量化方式可能略有差异，不承诺逐字节相同。
后端直接调用时，从 `__heap_base` 起为 A、B、输出各保留 `width * height * 4` 字节，再放参数；
调用前通过 `memory.grow()` 按 65536 字节一页补足内存，之后复用缓冲。

内置源码为 `src/transitions/wasm/crossfade.c`，仓库包含对应 `.wasm`，使用现有产物不需要安装编译器。
重新编译需支持 wasm32 的 LLVM Clang（Emscripten SDK 自带），在 PowerShell 执行：

```powershell
$env:WASM_CLANG = "D:\CODE\emsdk\upstream\bin\clang.exe"
pnpm run build:transitions-wasm
```

库构建将 WASM 随浏览器代码打包，并额外输出 `dist/algorithm/transitions/crossfade.wasm`；包子路径
`daily-video-editor/transitions/crossfade.wasm` 指向该独立产物。后端可在无浏览器的 WASM 运行时执行相同 ABI，
将 FFmpeg 解码的 RGBA 帧传入内核，再把输出交给 FFmpeg 编码；本库未实现 FFmpeg 桥接。
严格对照还需统一源帧、缓动、色彩转换、美颜、变换与输出尺寸。

开发验证：`pnpm test`、`pnpm typecheck`。真实浏览器验证先启动 `pnpm exec vite --host 127.0.0.1 --port 5175 --strictPort`，再运行
`node tests/browser-transitions.mjs`；默认使用本机 Edge，可通过 `TRANSITION_TEST_BROWSER` 指定 Chromium 可执行文件。

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
