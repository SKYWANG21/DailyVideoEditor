import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// 先启动 Vite，通过真实 Chromium 验证 SVG 采样与 exportVideo 的 Worker 链路。
const origin = process.env.EXPORT_TEST_ORIGIN || process.argv[2] || "http://127.0.0.1:5175";
const executable = process.env.EXPORT_TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const profile = resolve(`node_modules/.cache/export-browser-${process.pid}`);
await mkdir(profile, { recursive: true });
const listener = createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const browser = spawn(
  executable,
  [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--no-proxy-server",
    "--enable-unsafe-swiftshader",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { windowsHide: true, stdio: "ignore" },
);
let socket;
let sequence = 0;
const pending = new Map();

/** 带超时的 CDP 请求，测试失败时不会无限等待。 */
function command(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 90000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

try {
  let endpoint;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      endpoint = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      if (endpoint.some((item) => item.type === "page" && item.url === "about:blank")) break;
      await delay(100);
    } catch {
      await delay(100);
    }
  }
  const page = endpoint?.find((item) => item.type === "page" && item.url === "about:blank");
  assert.ok(page, "浏览器 CDP 未启动");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const done = pending.get(message.id);
    if (done) {
      pending.delete(message.id);
      done(message);
    }
  };
  await command("Page.navigate", { url: origin });
  await delay(1500);
  const result = await command("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression: `
    (async () => {
      const { ExportStickerSampler } = await import('/src/editor/export/exportStickerSampler.ts');
      const { applyTextTemplateSvg } = await import('/src/editor/shared/applyTextTemplateSvg.ts');
      const { parseSvgAspect } = await import('/src/editor/shared/textTemplateCatalog.ts');
      const { useComposeVideoExport } = await import('/src/editor/export/useComposeVideoExport.ts');
      const { createApp, h, ref } = await import('/node_modules/.vite/deps/vue.js');
      const bunny = await import('/node_modules/.vite/deps/mediabunny.js');
      const ensure = (condition, message) => { if (!condition) throw new Error(message); };
      const { verifyGradeRecovery } = await import('/tests/browser-grade.mjs');
      const gradeRecovery = await verifyGradeRecovery();
      // 真正的专用调色 Worker 与导出共用算法，逐像素对比同尺寸结果。
      const { VideoAdjustmentEngine } = await import('/src/utils/videoAdjustmentEngine.ts');
      const { VideoAdjustmentWorkerClient } = await import('/src/hooks/videoAdjustmentWorkerClient.ts');
      const { readVideoAdjustments } = await import('/src/types/videoAdjustments.ts');
      const gradeSource = new OffscreenCanvas(32, 32), gradeCtx = gradeSource.getContext('2d');
      gradeCtx.fillStyle = '#748ab2'; gradeCtx.fillRect(4, 4, 24, 24);
      const gradeParams = readVideoAdjustments({ temperature: 20, tint: -12, saturation: 18, brightness: 5,
        contrast: 10, highlights: -20, shadows: 30, sharpen: 40, grain: 50 });
      const gradeFrame = { clipId: 'grade', sourceTimeUs: 33333 };
      const gradeClient = new VideoAdjustmentWorkerClient();
      try {
        const bitmap = await gradeClient.render(gradeSource, gradeParams, gradeFrame, 1, new AbortController().signal);
        const actualCanvas = new OffscreenCanvas(32, 32), actualCtx = actualCanvas.getContext('2d');
        actualCtx.drawImage(bitmap, 0, 0); bitmap.close();
        new VideoAdjustmentEngine().apply(gradeCtx, gradeParams, gradeFrame);
        const expected = gradeCtx.getImageData(0, 0, 32, 32).data;
        const actual = actualCtx.getImageData(0, 0, 32, 32).data;
        ensure(expected.every((value, index) => value === actual[index]), 'Worker 调色与共享算法像素不一致');
        const abort = new AbortController();
        const cancelledFrame = gradeClient.render(gradeSource, gradeParams, gradeFrame, 2, abort.signal);
        abort.abort();
        let stopped = false;
        try { await cancelledFrame; } catch (error) { stopped = error.name === 'AbortError'; }
        ensure(stopped, '取消调色后仍交付画面');
      } finally { gradeClient.dispose(); }
      // 真实预览 Hook 调用专用 Worker；同一源 PTS 修改参数也必须废弃缓存。
      const { useComposePreviewFrame } = await import('/src/hooks/useComposePreviewFrame.ts');
      const previewSource = new OffscreenCanvas(32, 32), previewSourceCtx = previewSource.getContext('2d');
      previewSourceCtx.fillStyle = 'blue'; previewSourceCtx.fillRect(0, 0, 32, 32);
      const sourceBitmap = await createImageBitmap(previewSource);
      const previewRoot = document.createElement('div'); document.body.append(previewRoot);
      const previewCanvas = document.createElement('canvas');
      const previewClips = ref([{ id: 'preview-grade', title: 'grade', url: '', durationSec: 1,
        adjustments: readVideoAdjustments({ saturation: -100 }) }]);
      let previewRenderer;
      const previewApp = createApp({ setup() {
        previewRenderer = useComposePreviewFrame({ canvas: ref(previewCanvas), gpuCanvas: ref(null), clips: previewClips,
          transitionTrack: ref(undefined), canvasSize: ref({ width: 32, height: 32 }), frame: ref(null), beautyReady: ref(false) }).renderer;
        return () => null;
      } });
      previewApp.mount(previewRoot);
      const previewRequest = { identity: { generation: 1, requestId: 1, clipId: 'preview-grade', sourceTimeUs: 0 },
        time: 0, duration: 1 / 30, clipIndex: 0,
        outgoing: { bitmap: sourceBitmap, sourceTimeUs: 0, sourceSize: { width: 32, height: 32 } } };
      try {
        const graded = await previewRenderer.render(previewRequest, new AbortController().signal);
        previewRenderer.present(graded); graded.bitmap.close();
        const gray = [...previewCanvas.getContext('2d').getImageData(16, 16, 1, 1).data];
        ensure(Math.abs(gray[0] - gray[2]) < 2, '预览未接入调色 Worker');
        previewClips.value[0].adjustments = readVideoAdjustments();
        const neutral = await previewRenderer.render(previewRequest, new AbortController().signal);
        previewRenderer.present(neutral); neutral.bitmap.close();
        const blue = [...previewCanvas.getContext('2d').getImageData(16, 16, 1, 1).data];
        ensure(blue[2] === 255 && blue[0] === 0, '同 PTS 参数修改仍使用旧缓存');
        ensure(sourceBitmap.width === 32, '借用的解码帧被调色关闭或转移');
      } finally { previewApp.unmount(); previewRoot.remove(); sourceBitmap.close(); }
      const controller = new AbortController();
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><style>@keyframes fade{from{opacity:0.2}to{opacity:1}}rect{animation:fade 1s linear infinite alternate}</style><rect width="64" height="64" fill="red"/></svg>';
      const clip = { id: 'flower', sourceUrl: '', text: '', color: null, fontSize: 32, startTime: 0, endTime: 2, aspect: 1, kind: 'animated', svg };
      const sampler = new ExportStickerSampler([clip], controller.signal);
      const before = document.body.childElementCount;
      const request = { type: 'sticker-frame-request', jobId: 1, requestId: 1, clipId: clip.id, time: 0, width: 64, height: 64 };
      const pixels = async (time) => {
        const bitmap = await sampler.sample({ ...request, time });
        const canvas = new OffscreenCanvas(64, 64);
        const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
        return [...ctx.getImageData(32, 32, 1, 1).data];
      };
      const first = await pixels(0), middle = await pixels(0.5), repeat = await pixels(0.5);
      ensure(middle[3] > first[3] + 50, 'SVG 动画没有随时间变化: ' + JSON.stringify({ first, middle }));
      ensure(JSON.stringify(middle) === JSON.stringify(repeat), '同一时间采样不一致');
      sampler.dispose(); ensure(document.body.childElementCount === before, '采样容器未释放');
      controller.abort();
      let aborted = false;
      try { await sampler.sample(request); } catch (error) { aborted = error.name === 'AbortError'; }
      ensure(aborted, '取消后仍能采样');

      // 现有模板实际栅格化，验证滤镜、文字和 CSS 动画不会丢失。
      const templateResults = [];
      for (const name of ['hi', 'cool', 'like', 'ooops', 'lol', 'please', 'selfie', 'yes', 'yep']) {
        const raw = await fetch('/src/assets/svg/TextTemplate/' + name + '.svg').then((response) => response.text());
        const styled = applyTextTemplateSvg(raw, { text: 'TEST', color: null, fontSize: 32, idPrefix: name });
        const scene = new ExportStickerSampler([{ ...clip, svg: styled, aspect: parseSvgAspect(raw) }], new AbortController().signal);
        const hashes = [];
        for (const time of [0, 0.3, 0.7]) {
          const bitmap = await scene.sample({ ...request, time, width: 192, height: 96 });
          const canvas = new OffscreenCanvas(192, 96), ctx = canvas.getContext('2d');
          ctx.drawImage(bitmap, 0, 0); bitmap.close();
          const data = ctx.getImageData(0, 0, 192, 96).data;
          let hash = 0, visible = false;
          for (let index = 0; index < data.length; index += 1) { hash = (Math.imul(hash, 31) + data[index]) | 0; if (index % 4 === 3 && data[index]) visible = true; }
          hashes.push({ hash, visible });
        }
        ensure(hashes.some((item) => item.visible), name + ' 模板全部透明');
        ensure(new Set(hashes.map((item) => item.hash)).size > 1, name + ' 动画无变化');
        templateResults.push(name);
        scene.dispose();
      }

      // 合成一个本地 MP4，然后通过组件公开方法所用的会话入口导出。
      const canvas = new OffscreenCanvas(96, 96), ctx = canvas.getContext('2d');
      const target = new bunny.BufferTarget();
      const output = new bunny.Output({ format: new bunny.Mp4OutputFormat(), target });
      const video = new bunny.CanvasSource(canvas, { codec: 'avc', bitrate: 1000000 });
      if (!(await bunny.canEncodeAudio('aac', { sampleRate: 48000, numberOfChannels: 1, bitrate: 64000 }))) {
        const { registerAacEncoder } = await import('/node_modules/.vite/deps/@mediabunny_aac-encoder.js');
        registerAacEncoder();
      }
      const audio = new bunny.AudioSampleSource({ codec: 'aac', bitrate: 64000 });
      output.addVideoTrack(video); output.addAudioTrack(audio); await output.start();
      ctx.fillStyle = 'blue'; ctx.fillRect(0, 0, 96, 96);
      // 故意制造音轨先开始、视频首帧晚 2 帧的真实 MP4。
      const silence = new bunny.AudioSample({ data: new Float32Array(48000), format: 'f32-planar', sampleRate: 48000, numberOfChannels: 1, timestamp: 0 });
      await audio.add(silence); silence.close(); audio.close();
      for (let frame = 0; frame < 30; frame++) await video.add((frame + 2) / 30, 1 / 30);
      video.close(); await output.finalize();
      const file = new File([target.buffer], 'test.mp4', { type: 'video/mp4' });
      const sourceInput = new bunny.Input({ formats: bunny.ALL_FORMATS, source: new bunny.BlobSource(file) });
      const sourceFirst = await sourceInput.getFirstTimestamp();
      const videoFirst = await (await sourceInput.getPrimaryVideoTrack()).getFirstTimestamp();
      ensure(videoFirst - sourceFirst > 0.05, '测试素材没有保留音视频起点差异');
      sourceInput.dispose();
      const url = URL.createObjectURL(file);
      const stickerUrl = 'data:image/svg+xml,' + encodeURIComponent(svg);
      const tracks = [
        { id: 'main', type: 'video', isMain: true, name: 'main', visible: true, clips: [{ id: 'v', type: 'video', name: 'video', sourceUrl: url, startTime: 0, endTime: 1, duration: 1, volume: 0, visible: true, videoWidth: 96, videoHeight: 96 }], frameAspect: '1:1' },
        { id: 'stickers', type: 'sticker', name: 'flower', visible: true, clips: [{ id: 'flower', type: 'text', text: '', startTime: 0, endTime: 1, visible: true, config: { sourceUrl: stickerUrl }, rect: { x: 0, y: 0, w: 96, h: 96, angle: 0 } }] },
      ];
      const root = document.createElement('div'); document.body.append(root);
      let session;
      const app = createApp({ setup() {
        session = useComposeVideoExport({ localMediaFiles: new Map([[url, file]]), tracks: () => tracks, pause() {}, root: () => root,
          algorithmBase: () => '/algorithm/', transitionBackend: () => 'canvas', resolveMediaUrl: () => undefined, createWorker: () => undefined });
        return () => null;
      } });
      app.mount(root);
      const verifyAnimation = async (result) => {
        const input = new bunny.Input({ formats: bunny.ALL_FORMATS, source: new bunny.BlobSource(result.blob) });
        const track = await input.getPrimaryVideoTrack();
        const sink = new bunny.CanvasSink(track);
        const red = [];
        for (const time of [0, 0.5]) { const frame = await sink.getCanvas(time); const ctx = frame.canvas.getContext('2d'); red.push(ctx.getImageData(48, 48, 1, 1).data[0]); }
        input.dispose();
        ensure(red[1] > red[0] + 50, '成片花字动效丢失: ' + red);
        return result.blob.size;
      };
      const renderAndRead = async () => verifyAnimation(await session.exportVideo({ resolution: 'source' }));
      const newTrackBytes = await renderAndRead();
      tracks[1].type = 'text';
      const legacyTrackBytes = await renderAndRead();
      const flowerTrack = tracks.pop();
      const firstClip = tracks[0].clips[0];
      tracks[0].clips.push({ ...firstClip, id: 'b', startTime: 1, endTime: 2 });
      const transitionResults = [];
      for (const effectId of ['blinds', 'blinds-diagonal', 'crossfade']) {
        tracks[0].transitions = [{ id: 'transition', clipAId: 'v', clipBId: 'b', effectId, durationSec: 0.8, params: {} }];
        const result = await session.exportVideo({ resolution: 'source' });
        const input = new bunny.Input({ formats: bunny.ALL_FORMATS, source: new bunny.BlobSource(result.blob) });
        const sink = new bunny.CanvasSink(await input.getPrimaryVideoTrack());
        for (const time of [0, 0.8, 0.9, 1, 1.1, 1.2]) {
          const frame = await sink.getCanvas(time), ctx = frame.canvas.getContext('2d');
          const data = ctx.getImageData(8, 8, 80, 80).data;
          let minBlue = 255;
          for (let offset = 2; offset < data.length; offset += 4) minBlue = Math.min(minBlue, data[offset]);
          ensure(minBlue > 220, effectId + ' 转场出现黑帧/黑条，time=' + time + ', blue=' + minBlue);
        }
        input.dispose(); transitionResults.push(effectId);
      }
      // 带调色的两侧先独立处理再转场，普通帧和转场共享同一效果。
      tracks[0].clips[0].config = { adjustments: { saturation: -100 } };
      const gradedResult = await session.exportVideo({ resolution: 'source' });
      const gradedInput = new bunny.Input({ formats: bunny.ALL_FORMATS, source: new bunny.BlobSource(gradedResult.blob) });
      const gradedSink = new bunny.CanvasSink(await gradedInput.getPrimaryVideoTrack());
      const gradeSamples = [];
      for (const time of [0.2, 1, 1.8]) {
        const frame = await gradedSink.getCanvas(time);
        gradeSamples.push([...frame.canvas.getContext('2d').getImageData(48, 48, 1, 1).data]);
      }
      gradedInput.dispose();
      ensure(Math.abs(gradeSamples[0][0] - gradeSamples[0][2]) < 8, '普通帧灰度调色未写入成片');
      ensure(gradeSamples[2][2] > 220, '后一片段被前一片段调色污染');
      ensure(gradeSamples[1][2] > gradeSamples[0][2] + 40 && gradeSamples[1][2] < gradeSamples[2][2] - 40,
        '转场两侧未使用各自调色参数');
      tracks[0].clips[0].config = {};
      tracks[0].clips.pop(); tracks[0].transitions = [];
      tracks.push({ id: 'upper', type: 'video', order: 1, visible: true, clips: [{ ...firstClip, id: 'upper-clip',
        config: { adjustments: { saturation: -100 }, frame: { x: 24, y: 0, w: 48, h: 96, scale: 100, rotate: 0 } } }] });
      const layered = await session.exportVideo({ resolution: 'source' });
      const layeredInput = new bunny.Input({ formats: bunny.ALL_FORMATS, source: new bunny.BlobSource(layered.blob) });
      const layeredSink = new bunny.CanvasSink(await layeredInput.getPrimaryVideoTrack());
      const layeredFrame = await layeredSink.getCanvas(0.2), layeredCtx = layeredFrame.canvas.getContext('2d');
      const leftPixel = [...layeredCtx.getImageData(24, 48, 1, 1).data];
      const rightPixel = [...layeredCtx.getImageData(72, 48, 1, 1).data];
      ensure(leftPixel[2] > 220 && leftPixel[0] < 15, '上层调色覆盖了下层轨道');
      ensure(Math.abs(rightPixel[0] - rightPixel[2]) < 8, '上层片段未应用灰度');
      layeredInput.dispose(); tracks.pop(); tracks.push(flowerTrack);

      const exportPromise = session.exportVideo({ resolution: 'source', onProgress(update) { if (update.stage === 'rendering') session.cancelExport(); } });
      let cancelled = false;
      try { await exportPromise; } catch (error) { cancelled = error.name === 'AbortError'; }
      ensure(cancelled && session.cover.value === null, '取消没有清理任务');
      app.unmount(); root.remove();

      // 验证宿主真实组件 ref 入口，素材只提供 URL，旧轨经时间轴回灌后导出。
      const { default: Editor } = await import('/src/editor/VideoComposeEditor.vue');
      const model = ref({ id: 'export-test', bizType: 'source_video', bizId: 'test', tracks: structuredClone(tracks) });
      const editor = ref(null), editorRoot = document.createElement('div');
      editorRoot.style.cssText = 'width:1200px;height:800px'; document.body.append(editorRoot);
      let ready = false;
      const editorApp = createApp({ setup: () => () => h(Editor, { ref: editor, modelValue: model.value, transitionBackend: 'canvas',
        'onUpdate:modelValue': (value) => model.value = value, onReady: () => ready = true }) });
      editorApp.mount(editorRoot);
      const deadline = performance.now() + 15000;
      while (!ready && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      ensure(ready, '编辑器未完成初始化');
      const restored = editor.value.exportComposePayload();
      ensure(restored.tracks.find((track) => track.id === 'stickers')?.type === 'sticker', '旧 text 轨未迁移为 sticker');
      const componentBytes = await verifyAnimation(await editor.value.exportVideo({ resolution: 'source' }));
      const updated = JSON.parse(JSON.stringify(model.value));
      updated.tracks.find((track) => track.id === 'stickers').type = 'sticker';
      await editor.value.reload(updated);
      const reloadedBytes = await verifyAnimation(await editor.value.exportVideo({ resolution: 'source' }));
      editorApp.unmount(); editorRoot.remove(); URL.revokeObjectURL(url);
      return { gradeRecovery, first, middle, templates: templateResults, sourceFirst, videoFirst, transitionResults, gradeSamples, leftPixel, rightPixel,
        newTrackBytes, legacyTrackBytes, componentBytes, reloadedBytes, cancelled };
    })()
  `,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  console.log(JSON.stringify(result.result.value, null, 2));
} finally {
  socket?.close();
  browser.kill();
}
