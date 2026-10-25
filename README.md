# daily-video-clips

视频合成编辑器。打包后宿主只需 Vue，不必再装 Pinia、全局 Element Plus 或 Tailwind。

## 接入

```ts
import { createApp, ref } from "vue";
import {
  createDefaultVideoComposeEditorModel,
  VideoComposeEditor,
  type VideoComposeEditorExpose,
  type VideoComposeEditorModel,
} from "video-clips";
import "video-clips/style.css";

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

`peerDependencies` 只有 `vue`。`pinia`、`element-plus` 随包安装，并在编辑器内部使用：每个时间轴自建一份 Pinia，同页多个编辑器不会抢轨。

换稿必须调用 `editorRef.reload(model)`。只改 `v-model` 引用不会回灌时间轴。

## 组件 Ref（`VideoComposeEditorExpose`）

| 方法 | 说明 |
| --- | --- |
| `validate(): string \| null` | 导出前校验。`null` 表示通过，否则为错误文案 |
| `flush(): void` | 立刻把当前轨道、喜欢态、缩放写入 `update:modelValue` |
| `reload(model): Promise<void>` | 用指定工程整页重置时间轴。换稿只走这个方法 |
| `exportComposePayload()` | 先 `flush`，再返回 `{ id, bizType, bizId, tracks }` |
| `getMainVideoClips()` | 主轨视频片段。优先读时间轴，否则用派生列表 |
| `requestUploadClip()` | 触发上传视频：有 `onRequestUploadClip` 则交给宿主，否则走内置上传 |

## 公共类型

声明在 `dist/index.d.ts`。包根导出：

- 组件与工厂：`VideoComposeEditor`、`createDefaultVideoComposeEditorModel`
- 工程：`VideoComposeEditorModel`、`ComposeExportPayload`、`ComposeTrack`、`ComposeClip`、`MediaBizType`、`MediaRef`、`ComposeSegmentClipAssets`
- 侧栏种子：`BgmItem`、`TextTemplateItem`、`VideoClipItem`
- 入参与上传：`ComposeEditorProps`、`ComposeUploadAdapter`、`ComposeBgmUploadResult`、`ComposeCatalogUploadPayload`
- Ref：`VideoComposeEditorExpose`
- 轨道片段：`MediaClip`、`SubtitleClip`、`TextClip`、`TrackType`
- 媒体地址：`createComposeMediaResolver`、`isPassthroughMediaUrl`、`mediaCorsMessage`、`ComposeMediaResolver`、`ResolveMediaUrl`

字段含义以声明文件为准。

## 发包

`package.json` 保持 `"private": true`。本包默认不发到公共 npm。

安装方式：monorepo workspace、`file:` 依赖，或私有 registry。类型入口是 `dist/index.d.ts`（`files` 含整个 `dist`）。要公开发到 npm 时，须先去掉 `private`，再按公开发布流程处理，不走上述私有安装约定。

构建：

```bash
npm run build
```

库产物：

- `dist/index.js`
- `dist/index.d.ts`
- `dist/style.css`
- `dist/algorithm/`

## 产物部署

宿主必须引入样式，否则编辑器没有皮肤：

```ts
import "video-clips/style.css";
```

美颜预览 Worker 在 `npm run build` 时内联进 `dist/index.js`。不要单独部署 worker 文件，也不要再准备 `/assets/beautyPreview.worker-*.js`。

`dist/algorithm/` 仍须挂到宿主静态目录。默认从站点根路径 `/algorithm/` 读取：

- `/algorithm/face_landmarker.task`
- `/algorithm/mediapipe/`

本地 demo 使用 `public/algorithm/`。库构建只拷贝这两项到 `dist/algorithm/`。挂好后可用 `algorithmBaseUrl` 改根路径（须是目录，并能拼出上述两个相对路径）。

## 侧栏素材（不进工程 JSON）

视频 / 音频 / 音效 / 花字列表由 **Editor 内部数组**维护，**不写入** `v-model`（`model` 只有 tracks、likedMedia、scale 等）。

可用 props 作种子；上传成功事件载荷为：

```ts
{ file: File; item: T; items: T[] }
```

宿主可把 `items` 回写到自己的状态。纯 `onRequestUpload*` 由宿主自管 UX，不走该 emit。

## 跨域媒体

预览、缩略图和美颜抽帧都要能读取像素。编辑器会：

- 给 `video` / `audio` 设置 `crossorigin="anonymous"`
- 对跨域地址默认 `fetch`（`mode: "cors"`）并转成 `blob:`
- 同源、`blob:`、`data:` 原样使用

源站需要：

```
Access-Control-Allow-Origin: <页面源> 或 *
Access-Control-Allow-Methods: GET
```

没有 CORS 头时，默认 fetch 会失败，界面提示配置 `resolveMediaUrl`。宿主把地址换成同源代理或 blob：

```ts
async function proxyToBlob(url: string): Promise<string> {
  const response = await fetch(`/api/media-proxy?url=${encodeURIComponent(url)}`);
  if (!response.ok) throw new Error("媒体代理失败");
  return URL.createObjectURL(await response.blob());
}
```

```vue
<VideoComposeEditor v-model="model" :resolve-media-url="proxyToBlob" />
```

本仓库不实现代理服务。
