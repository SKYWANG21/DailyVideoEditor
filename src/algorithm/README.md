# GPUPixel WebAssembly 美颜模块

`wasm/` 目录是给前端调用的美颜算法包。它包含磨皮、美白、瘦脸、大眼，并把 MediaPipe Face Landmarker 的关键点转换成 GPUPixel 瘦脸着色器使用的 106 点。

这不是 GPUPixel 的完整滤镜库。口红、腮红、其他通用滤镜，以及原来的 mars-face-kit 人脸检测都没有导出。人脸检测由调用方自己运行 MediaPipe，再把关键点交进来。

## 文件

三个文件必须放在同一目录，由页面通过 HTTP 加载，不能用 `file://` 打开。

| 文件 | 作用 |
| --- | --- |
| `gpupixel.js` | 加载器。提供 `createGpuPixelModule` |
| `gpupixel.wasm` | 滤镜链、106 点映射和 JavaScript 绑定 |
| `gpupixel.data` | 美白查找表：`lookup_gray.png`、`lookup_origin.png`、`lookup_skin.png`、`lookup_light.png` |

前端不需要、也不应引用仓库里的 `src/wasm`。那个目录只是编译前的 C++ 源码。

## 调用

页面上先放好 canvas，并且不要对它调用 `getContext`。本模块会在这块 canvas 上创建唯一的 WebGL 2 上下文。MediaPipe 请使用 CPU delegate，避免再占用同一个 WebGL 上下文。

```html
<canvas id="gpupixel_canvas" width="1280" height="720"></canvas>
<script src="./gpupixel.js"></script>
<script type="module">
  const Module = await createGpuPixelModule({
    locateFile: (file) => new URL(file, import.meta.url).href
  });
  const pipeline = Module.create("gpupixel_canvas");

  pipeline.setSmooth(4); // 磨皮，0–10
  pipeline.setWhiten(3); // 美白，0–10
  pipeline.setSlim(2);   // 瘦脸，0–10
  pipeline.setEye(2);    // 大眼，0–10

  // MediaPipe 归一化坐标，x,y 交替。空数组表示这一帧没有脸。
  pipeline.setMediaPipeLandmarks(flatXy);

  const byteLength = width * height * 4;
  const ptr = Module._malloc(byteLength);
  Module.HEAPU8.set(rgba, ptr); // RGBA，每行 width * 4 字节
  pipeline.process(ptr, width, height);
  Module._free(ptr);
</script>
```

每帧在 `process` 之前写入参数和关键点。结果直接画到 canvas 上，不会把像素读回 JavaScript。

`create` 的参数可以是 canvas 的 id（`"gpupixel_canvas"`），也可以是 CSS 选择器（`"#gpupixel_canvas"`）。必须在第一次 `create` 之前，这个 canvas 已经在页面里。

页面和这三个文件不在同一目录时，用 `locateFile` 指向 `gpupixel.wasm` 和 `gpupixel.data`。`.data` 加载失败时，`create` 会因为缺少美白查找表而失败。

用 CommonJS 打包时，`gpupixel.js` 的导出就是 `createGpuPixelModule`。

## 参数

滑杆范围与桌面 demo 一致，模块内部再换算成滤镜强度。

| 方法 | 取值 | 实际强度 |
| --- | --- | --- |
| `setSmooth` | 0–10 | 除以 10，传给磨皮 |
| `setWhiten` | 0–10 | 除以 20，传给美白 |
| `setSlim` | 0–10 | 除以 200，传给瘦脸 |
| `setEye` | 0–10 | 除以 100，传给大眼 |

## 关键点

`setMediaPipeLandmarks` 接收 Face Landmarker 的归一化坐标，顺序为 `x0, y0, x1, y1, ...`，y 向下。标准模型输出 478 点，共 956 个数。至少要能读到下标 454。

模块内部会：

- 沿脸部轮廓从图像左侧太阳穴（点 127）经下巴（点 152，对应 GPUPixel 下标 16）到图像右侧太阳穴（点 356），按弧长重采样成 33 个轮廓点。
- 鼻梁直接取点：`44←197`，`45←195`，`46←5`，`49←4`。
- 眼睛优先用虹膜：`74←468`，`77←473`。没有虹膜点时，用对应眼眶顶点的平均值。上眼睑为 `72←159`、`75←386`。
- 写入前把每个 y 变成 `1 - y`，与纹理坐标一致。

瘦脸和大眼实际只用轮廓 `3、7、10、14、16、18、22、25、29`，鼻梁 `44、45、46、49`，以及眼睛 `72、74、75、77`。其余 106 点填 0。映射失败时按无人脸处理。

## 重新编译

在已安装 Emscripten、CMake、Ninja 的环境中，于仓库根目录执行：

```powershell
.\script\build_wasm.ps1
```

脚本使用 `D:\CODE\emsdk`。产物仍写入 `output/wasm/`。
