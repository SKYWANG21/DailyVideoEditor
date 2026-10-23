# video-clips

视频合成编辑器。打包后宿主只需 Vue，不必再装 Pinia、全局 Element Plus 或 Tailwind。

## 接入

```ts
import { createApp } from "vue";
import { VideoComposeEditor } from "video-clips";
import "video-clips/style.css";

createApp(App).mount("#app");
```

```vue
<VideoComposeEditor v-model="model" />
```

`peerDependencies` 只有 `vue`。`pinia`、`element-plus` 随包安装，并在编辑器内部使用：每个时间轴自建一份 Pinia，同页多个编辑器不会抢轨。

构建：

```bash
npm run build
```

产物在 `dist/index.js`、`dist/style.css`、`dist/algorithm/`。

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

## 美颜模型

默认从站点根路径 `/algorithm/` 读取：

- `/algorithm/face_landmarker.task`
- `/algorithm/mediapipe/`

本地 demo 使用 `public/algorithm/`。库构建会把这两项拷到 `dist/algorithm/`。宿主把它挂到自己的静态目录后，可用 `algorithmBaseUrl` 改根路径（需以目录形式能拼出上述两个相对路径）。
