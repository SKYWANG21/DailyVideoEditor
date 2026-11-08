import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// 浏览器集成测试：先启动 Vite，再通过现有 Edge/Chrome 的 CDP 验证真实 Canvas 和媒体。
const origin = process.env.TRANSITION_TEST_ORIGIN || "http://127.0.0.1:5175";
const executable = process.env.TRANSITION_TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const profile = resolve("node_modules/.cache/transition-browser");
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
    "--autoplay-policy=no-user-gesture-required",
    "--enable-unsafe-swiftshader",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { windowsHide: true, stdio: "ignore" },
);
browser.on("error", (error) => {
  console.error(error.message);
});
let socket;
let sequence = 0;
const pending = new Map();
const errors = [];

async function command(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 60000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject,
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const response = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}
async function waitFor(expression, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(expression)) return;
    await delay(100);
  }
  throw new Error(`浏览器条件等待超时：${expression}`);
}

try {
  let endpoint;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      endpoint = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      break;
    } catch {
      await delay(100);
    }
  }
  if (!endpoint) throw new Error("无法启动测试浏览器");
  socket = new WebSocket(endpoint.find((item) => item.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const task = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) task?.reject(new Error(message.error.message));
      else task?.resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown")
      errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  });
  await command("Runtime.enable");
  await command("Page.enable");
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await command("Page.navigate", { url: origin });
  await waitFor("Boolean(document.querySelector('.compose-shell'))", 45000);

  const pixels = await evaluate(`(async () => {
    const { createTransitionRegistry } = await import('/src/transitions/catalog.ts');
    const { TransitionEngine } = await import('/src/transitions/engine.ts');
    const engine = new TransitionEngine(createTransitionRegistry());
    const a = new OffscreenCanvas(4, 4), b = new OffscreenCanvas(4, 4);
    for (const [canvas, color] of [[a, '#ff0000'], [b, '#0000ff']]) { const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 4, 4); }
    const frame = await engine.render({ effectId: 'crossfade', outgoing: a, incoming: b, width: 4, height: 4, progress: .5, params: {} });
    const mix = [...frame.getContext('2d').getImageData(1, 1, 1, 1).data];
    const same = await engine.render({ effectId: 'crossfade', outgoing: a, incoming: a, width: 4, height: 4, progress: .5, params: {} });
    return { mix, same: [...same.getContext('2d').getImageData(1, 1, 1, 1).data] };
  })()`);
  assert.deepEqual(pixels.mix, [128, 0, 128, 255]);
  assert.deepEqual(pixels.same, [255, 0, 0, 255]);
  console.log("PASS 真实 Canvas 淡化像素与亮度");

  await evaluate(`(async () => {
    const { createApp, h, ref } = await import('/node_modules/.vite/deps/vue.js');
    const { default: Editor } = await import('/src/editor/VideoComposeEditor.vue');
    const record = async (color) => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 180);
      const stream = canvas.captureStream(30), chunks = [];
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.start(100);
      const timer = setInterval(() => ctx.fillRect(0, 0, 320, 180), 30);
      await new Promise((resolve) => setTimeout(resolve, 2200));
      await new Promise((resolve) => { recorder.onstop = resolve; recorder.stop(); });
      clearInterval(timer); stream.getTracks().forEach((track) => track.stop());
      return URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
    };
    const urls = [await record('#ff0000'), await record('#0000ff')];
    const clips = urls.map((sourceUrl, i) => ({ id: i ? 'b' : 'a', trackId: 'main', name: i ? '蓝色' : '红色', type: 'video', sourceUrl,
      originalDuration: 2, trimStart: 0, trimEnd: 2, playbackRate: 1, volume: 0, startTime: i * 2, endTime: i * 2 + 2,
      selected: false, visible: true, config: { sourceWidth: 320, sourceHeight: 180 } }));
    const model = ref({ id: 'browser-test', bizType: 'source_video', bizId: 'test', tracks: [{ id: 'main', type: 'video', isMain: true,
      name: '主视频轨', visible: true, locked: false, order: 0, nativeFrameWidth: 320, nativeFrameHeight: 180, clips }] });
    document.querySelector('#app').__vue_app__?.unmount();
    const editor = ref(null), readonly = ref(false);
    const app = createApp({ setup: () => () => h(Editor, { ref: editor, readonly: readonly.value, modelValue: model.value, 'onUpdate:modelValue': (value) => model.value = value }) });
    app.mount('#app');
    const find = (instance, name) => {
      if (instance?.type?.__name === name) return instance;
      const visit = (vnode) => { if (!vnode) return null; if (vnode.component) { const match = find(vnode.component, name); if (match) return match; }
        if (Array.isArray(vnode.children)) for (const child of vnode.children) { const match = visit(child); if (match) return match; } return null; };
      return visit(instance?.subTree);
    };
    window.transitionTest = { model, editor, app, find, urls, readonly };
  })()`);
  await waitFor("document.querySelectorAll('.transition-handles__badge').length === 1");
  await evaluate(`(() => {
    const test = window.transitionTest, root = test.app._instance;
    test.timeline = test.find(root, 'VideoComposeTimeline').exposed;
    test.player = test.find(root, 'VideoComposePlayer').exposed;
    test.timeline.selectClipById('a'); test.timeline.applyTransition('crossfade');
  })()`);
  await waitFor("window.transitionTest.model.value.tracks[0].transitions?.length === 1");
  assert.equal(await evaluate("window.transitionTest.model.value.tracks[0].transitions[0].durationSec"), 1);
  console.log("PASS 主轨接缝、添加与 modelValue 持久化");

  await evaluate("window.transitionTest.player.seek(2)");
  await waitFor(`(() => { const c = document.querySelector('canvas.pointer-events-none.absolute.inset-0'); if (!c?.width) return false;
    const p = c.getContext('2d').getImageData(c.width/2, c.height/2, 1, 1).data; return p[0] > 90 && p[2] > 90 && p[1] < 20; })()`);
  console.log("PASS 真实视频暂停定位转场中点");

  await evaluate(`(async () => { await window.transitionTest.player.seek(1.55); await window.transitionTest.player.play(); })()`);
  await waitFor("window.transitionTest.timeline.getCurrentTime() > 2.65", 25000);
  await evaluate("window.transitionTest.player.pause()");
  console.log("PASS 连续播放跨切点并退出转场");
  await evaluate(`(async () => {
    const test = window.transitionTest;
    test.player.seek(1.6); test.player.seek(2.4); await test.player.seek(2);
  })()`);
  await delay(500);
  assert.ok(Math.abs((await evaluate("window.transitionTest.timeline.getCurrentTime()")) - 2) < 0.1);
  console.log("PASS 快速定位取消旧采样");

  const payload = await evaluate("window.transitionTest.editor.value.exportComposePayload()");
  assert.equal(payload.tracks[0].transitions[0].effectId, "crossfade");
  assert.equal(payload.tracks[0].clips[1].endTime, 4);
  await evaluate("window.transitionTest.editor.value.reload(JSON.parse(JSON.stringify(window.transitionTest.model.value)))");
  await waitFor("document.querySelectorAll('[data-transition-id]').length === 1");
  console.log("PASS 配置导出与工程重载，总时长保持不变");

  await evaluate("document.querySelector('.transition-handles__badge').click()");
  await waitFor("Boolean(document.querySelector('.transition-menu input'))");
  await evaluate(`(() => {
    const input = document.querySelector('.transition-menu input');
    input.value = '0.6'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
  })()`);
  await delay(100);
  await evaluate(
    "[...document.querySelectorAll('.transition-menu button')].find((button) => button.textContent.trim() === '应用').click()",
  );
  await waitFor("window.transitionTest.model.value.tracks[0].transitions[0].durationSec === 0.6");
  await delay(250);
  await evaluate("document.querySelector('.transition-handles__badge').click()");
  await delay(150);
  await evaluate("document.querySelector('.transition-menu__remove').click()");
  await waitFor("window.transitionTest.model.value.tracks[0].transitions.length === 0");
  console.log("PASS 接缝菜单修改时长与删除");

  await evaluate("[...document.querySelectorAll('.compose-assets button')].find((button) => button.textContent.trim() === '转场').click()");
  await waitFor("Boolean(document.querySelector('.transition-card'))");
  await evaluate("document.querySelector('.transition-card').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
  await waitFor("window.transitionTest.model.value.tracks[0].transitions.length === 1");
  await evaluate(`(() => {
    const transfer = new DataTransfer();
    document.querySelector('.transition-card').dispatchEvent(new DragEvent('dragstart', { dataTransfer: transfer, bubbles: true }));
    const target = document.querySelector('.transition-handles__target');
    target.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  })()`);
  await delay(500);
  assert.equal(await evaluate("window.transitionTest.model.value.tracks[0].transitions.length"), 1);
  console.log("PASS 转场 Tab、双击、拖放及重复应用去重");

  await evaluate(`(() => {
    const test = window.transitionTest;
    test.timeline.patchClipsByType('video', { config: { frame: { x: -80, y: 0, w: 160, h: 180, scale: 100, rotate: 0 } } }, { clipId: 'a' });
  })()`);
  await delay(250);
  await evaluate("window.transitionTest.player.seek(2)");
  await delay(350);
  const transformed = await evaluate(`(() => {
    const c = document.querySelector('canvas.pointer-events-none.absolute.inset-0');
    return [...c.getContext('2d').getImageData(c.width * .75, c.height / 2, 1, 1).data];
  })()`);
  assert.ok(transformed[0] < 10 && transformed[2] > 240 && transformed[3] >= 120 && transformed[3] <= 135, String(transformed));
  console.log("PASS A/B 独立画面变换与透明区域混合");

  await evaluate(`(() => {
    const test = window.transitionTest;
    test.timeline.patchClipsByType('video', { config: { beauty: { enabled: true, smooth: 1, whiten: 0, slim: 0, eye: 0 } } });
  })()`);
  await evaluate("window.transitionTest.player.seek(2)");
  await waitFor(
    "window.transitionTest.find(window.transitionTest.app._instance, 'VideoComposePlayer').setupState.beautyReady === true",
    45000,
  );
  await delay(1000);
  const beauty = await evaluate(`(() => {
    const c = document.querySelector('canvas.pointer-events-none.absolute.inset-0');
    return [...c.getContext('2d').getImageData(c.width / 4, c.height / 2, 1, 1).data];
  })()`);
  assert.ok(beauty[0] > 70 && beauty[2] > 70, String(beauty));
  console.log("PASS 双侧真实 Worker/GPUPixel 美颜后淡化");

  await evaluate(`(() => {
    const test = window.transitionTest;
    const timeline = test.find(test.app._instance, 'VideoComposeTimeline');
    timeline.setupState.videoTrackRef.setScale(4);
  })()`);
  await waitFor("document.querySelector('.transition-handles__target').style.left === '640px'");
  await waitFor("window.transitionTest.model.value.scale === 4");
  console.log("PASS 缩放后接缝手柄仍与切点对齐");

  await evaluate("window.transitionTest.readonly.value = true");
  await waitFor("document.querySelector('.transition-handles__badge').disabled === true");
  const beforeReadonly = await evaluate("JSON.stringify(window.transitionTest.model.value)");
  await evaluate("window.transitionTest.timeline.applyTransition('crossfade', undefined, 0.9)");
  await delay(450);
  assert.equal(await evaluate("JSON.stringify(window.transitionTest.model.value)"), beforeReadonly);
  console.log("PASS 只读状态禁止编辑转场");

  await evaluate(`(async () => {
    const test = window.transitionTest;
    test.readonly.value = false;
    const model = JSON.parse(JSON.stringify(test.model.value));
    model.tracks[0].locked = true;
    await test.editor.value.reload(model);
  })()`);
  await waitFor("document.querySelector('.transition-handles__badge').disabled === true");
  console.log("PASS 锁定主轨禁止编辑转场");

  await evaluate(`(async () => {
    const test = window.transitionTest;
    const model = JSON.parse(JSON.stringify(test.model.value));
    model.tracks[0].locked = false;
    model.tracks[0].transitions[0].effectId = 'future-effect';
    await test.editor.value.reload(model);
    await test.player.seek(2);
  })()`);
  await waitFor("document.body.textContent.includes('转场已回退普通画面')");
  assert.equal(
    await evaluate("window.transitionTest.editor.value.exportComposePayload().tracks[0].transitions[0].effectId"),
    "future-effect",
  );
  console.log("PASS 未知算法保留配置并提示普通画面降级");
  assert.deepEqual(errors, []);
  console.log("浏览器集成验证全部通过");
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await command("Browser.close").catch(() => undefined);
    socket.close();
  }
  browser.kill();
}
