import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// 浏览器集成测试：先启动 Vite，再通过现有 Edge/Chrome 的 CDP 验证真实 Canvas 和媒体。
const origin = process.env.TRANSITION_TEST_ORIGIN || process.argv[2] || "http://127.0.0.1:5175";
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
    "--mute-audio",
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

/** 真实鼠标命中标尺，覆盖播放时用户输入与帧提交在同一事件循环中的情况。 */
async function rulerPoint(time) {
  return evaluate(`(() => {
    const ruler = document.querySelector('.ruler__wrapper'), rect = ruler.getBoundingClientRect();
    return { x: rect.left + ${time} * 80 * window.transitionTest.timeline.getScale() - ruler.scrollLeft, y: rect.bottom - 8 };
  })()`);
}

async function clickRuler(time) {
  const point = await rulerPoint(time);
  await command("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 });
  await command("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
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
  // 每次验证使用当前 Vite 模块，避免复用旧预构建版本造成两个 Vue 运行时。
  await command("Network.enable");
  await command("Network.setCacheDisabled", { cacheDisabled: true });
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
    const record = async (color, withAudio = false) => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 180);
      const stream = canvas.captureStream(30), chunks = [];
      let audioContext, oscillator;
      if (withAudio) {
        audioContext = new AudioContext(); oscillator = audioContext.createOscillator();
        const destination = audioContext.createMediaStreamDestination(); oscillator.connect(destination);
        oscillator.start(); await audioContext.resume();
        destination.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
      }
      const recorder = new MediaRecorder(stream, { mimeType: withAudio ? 'video/webm;codecs=vp8,opus' : 'video/webm;codecs=vp8' });
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.start(100);
      const timer = setInterval(() => ctx.fillRect(0, 0, 320, 180), 30);
      await new Promise((resolve) => setTimeout(resolve, 2200));
      await new Promise((resolve) => { recorder.onstop = resolve; recorder.stop(); });
      clearInterval(timer); stream.getTracks().forEach((track) => track.stop());
      if (oscillator) oscillator.stop();
      if (audioContext) await audioContext.close();
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
    window.transitionTest = { model, editor, app, find, urls, readonly, record, initialModel: JSON.parse(JSON.stringify(model.value)) };
  })()`);
  await waitFor("document.querySelectorAll('.transition-handles__badge').length === 1");
  await evaluate(`(() => {
    const test = window.transitionTest, root = test.app._instance;
    test.timeline = test.find(root, 'VideoComposeTimeline').exposed;
    test.player = test.find(root, 'VideoComposePlayer').exposed;
  })()`);
  await waitFor("window.transitionTest.find(window.transitionTest.app._instance, 'VideoComposePlayer').setupState.mediaReady === true");
  await delay(100);
  const resizePoint = await evaluate(`(() => {
    const badge = document.querySelector('.transition-handles__badge'), badgeRect = badge.getBoundingClientRect();
    const cutX = badgeRect.left + badgeRect.width / 2;
    const handles = [...document.querySelectorAll('.clip__handle')].filter((el) => {
      const rect = el.getBoundingClientRect(); return Math.abs(rect.left + rect.width / 2 - cutX) < 8;
    });
    return { badgeHit: document.elementFromPoint(cutX, badgeRect.top + badgeRect.height / 2)?.closest('.transition-handles__badge') === badge,
      edges: handles.map((el) => { const rect = el.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + 4;
        return { x, y, hit: document.elementFromPoint(x, y) === el, right: el.classList.contains('clip__handle--right') }; }) };
  })()`);
  assert.equal(resizePoint.badgeHit, true);
  assert.equal(resizePoint.edges.length, 2);
  assert.ok(
    resizePoint.edges.every((edge) => edge.hit),
    JSON.stringify(resizePoint),
  );
  const trimPoint = resizePoint.edges.find((edge) => edge.right);
  await command("Input.dispatchMouseEvent", { type: "mouseMoved", x: trimPoint.x, y: trimPoint.y });
  await command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: trimPoint.x,
    y: trimPoint.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await waitFor("Boolean(document.querySelector('.clip--resizing'))");
  await command("Input.dispatchMouseEvent", { type: "mouseMoved", x: trimPoint.x - 16, y: trimPoint.y, buttons: 1 });
  await command("Input.dispatchMouseEvent", { type: "mouseReleased", x: trimPoint.x - 16, y: trimPoint.y, button: "left", clickCount: 1 });
  await waitFor("window.transitionTest.model.value.tracks[0].clips.find((clip) => clip.id === 'a').endTime < 2");
  await evaluate("window.transitionTest.editor.value.reload(window.transitionTest.initialModel)");
  await waitFor("document.querySelectorAll('.transition-handles__badge').length === 1");
  console.log("PASS 接缝按钮可点击、两侧裁剪可命中且能真实拖动");
  await evaluate("window.transitionTest.timeline.selectClipById('a'); window.transitionTest.timeline.applyTransition('crossfade')");
  await waitFor("window.transitionTest.model.value.tracks[0].transitions?.length === 1");
  assert.equal(await evaluate("window.transitionTest.model.value.tracks[0].transitions[0].durationSec"), 1);
  console.log("PASS 主轨接缝、添加与 modelValue 持久化");

  await evaluate("window.transitionTest.player.seek(2)");
  await waitFor(`(() => { const c = document.querySelector('canvas.pointer-events-none.absolute.inset-0'); if (!c?.width) return false;
    const p = c.getContext('2d').getImageData(c.width/2, c.height/2, 1, 1).data; return p[0] > 90 && p[2] > 90 && p[1] < 20; })()`);
  console.log("PASS 真实视频暂停定位转场中点");

  await evaluate(`(async () => { await window.transitionTest.player.seek(1.1); await window.transitionTest.player.play(); })()`);
  await waitFor("window.transitionTest.timeline.getCurrentTime() > 2.65", 25000);
  await evaluate("window.transitionTest.player.pause()");
  console.log("PASS 窗口外连续播放进入转场、跨切点并退出");
  await evaluate(`(async () => {
    const test = window.transitionTest;
    test.player.seek(1.6); test.player.seek(2.4); await test.player.seek(2);
  })()`);
  await delay(500);
  assert.ok(Math.abs((await evaluate("window.transitionTest.timeline.getCurrentTime()")) - 2) < 0.1);
  console.log("PASS 快速定位取消旧采样");
  await evaluate(`(async () => {
    const test = window.transitionTest; await test.player.seek(0);
    test.timeline.seekTo(1); await test.player.seek(0);
  })()`);
  await waitFor("window.transitionTest.timeline.getCurrentTime() === 0");
  console.log("PASS 定位回同一帧共享展示时间保持正确，游标不保留过期请求位置");

  await evaluate("(async () => { await window.transitionTest.player.seek(.1); await window.transitionTest.player.play(); })()");
  await waitFor("window.transitionTest.timeline.getCurrentTime() > .2");
  await clickRuler(2.8);
  await waitFor("window.transitionTest.timeline.getCurrentTime() >= 2.79");
  await evaluate("window.transitionTest.player.pause()");
  assert.ok((await evaluate("window.transitionTest.timeline.getCurrentTime()")) < 3.3);
  assert.equal(
    await evaluate(`(() => {
    const test = window.transitionTest, player = test.find(test.app._instance, 'VideoComposePlayer');
    const timeline = test.find(test.app._instance, 'VideoComposeTimeline');
    return player.props.playbackClock === timeline.props.playbackClock &&
      timeline.props.playbackClock.presentedTime === test.timeline.getCurrentTime();
  })()`),
    true,
  );
  console.log("PASS 播放中真实点击标尺可跳转，播放器和时间轴直接读取同一时钟对象");

  await evaluate(`(async () => {
    const test = window.transitionTest; await test.player.seek(.1);
    const renderer = test.find(test.app._instance, 'VideoComposePlayer').setupState.frameRendererRef, original = renderer.render;
    let release; const gate = new Promise((resolve) => release = resolve);
    renderer.render = async (...args) => { await gate; return original(...args); };
    test.releaseSeek = () => { renderer.render = original; release(); };
  })()`);
  await clickRuler(3);
  await waitFor(
    "window.transitionTest.find(window.transitionTest.app._instance, 'VideoComposePlayer').setupState.playbackState === 'seeking'",
  );
  await clickRuler(2.1);
  assert.equal(await evaluate("window.transitionTest.timeline.getCurrentTime()"), 0.1);
  await evaluate("window.transitionTest.releaseSeek()");
  await waitFor("Math.abs(window.transitionTest.timeline.getCurrentTime() - 2.1) < .01");
  assert.equal(await evaluate("window.transitionTest.timeline.isPlaying()"), false);
  console.log("PASS 定位处理未完成时游标保留旧位置，连续真实点击以后一次目标为准");

  await evaluate("(async () => { await window.transitionTest.player.seek(.3); await window.transitionTest.player.play(); })()");
  await waitFor("window.transitionTest.timeline.getCurrentTime() > .4");
  const cursor = await evaluate(`(() => { const rect = document.querySelector('.ruler__cursor-handle').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + 4 }; })()`);
  await command("Input.dispatchMouseEvent", { type: "mousePressed", ...cursor, button: "left", buttons: 1, clickCount: 1 });
  await waitFor("window.transitionTest.timeline.isPlaying() === false");
  const scrubTarget = await rulerPoint(2.2);
  await command("Input.dispatchMouseEvent", { type: "mouseMoved", ...scrubTarget, buttons: 1 });
  await command("Input.dispatchMouseEvent", { type: "mouseReleased", ...scrubTarget, button: "left", clickCount: 1 });
  await waitFor("window.transitionTest.timeline.getCurrentTime() >= 2.19 && window.transitionTest.timeline.isPlaying()");
  await evaluate("window.transitionTest.player.pause()");
  console.log("PASS 真实拖动期间暂停，最终目标展示后恢复原播放意图");

  await evaluate(`(async () => {
    const test = window.transitionTest; await test.player.seek(1.2);
    test.find(test.app._instance, 'VideoComposeEditor').setupState.onCatalogPreview({ id: 'catalog-clock', url: test.urls[1], segmentTitle: '素材预览' });
  })()`);
  // MediaRecorder WebM 的原生 duration 可能为 Infinity，此时素材预览沿用 0.1s 缺省窗口。
  await waitFor("window.transitionTest.find(window.transitionTest.app._instance, 'VideoComposePlayer').setupState.globalTime > 0");
  assert.equal(await evaluate("window.transitionTest.timeline.getCurrentTime()"), 1.2);
  await evaluate("window.transitionTest.find(window.transitionTest.app._instance, 'VideoComposeEditor').setupState.clearCatalogPreview()");
  await waitFor(`(() => { const player = window.transitionTest.find(window.transitionTest.app._instance, 'VideoComposePlayer');
    return !player.props.catalogPreviewActive && player.setupState.mediaReady && Math.abs(player.setupState.globalTime - 1.2) < .01; })()`);
  assert.equal(await evaluate("window.transitionTest.timeline.isPlaying()"), false);
  console.log("PASS 素材预览独立计时，退出后恢复工程已展示位置");

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
    const target = document.querySelector('.transition-handles__badge');
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

  // 自然换片不能因展示变换变化清空已经预热的完成帧；真实编辑仍需废弃旧输出。
  await evaluate(`(async () => {
    const test = window.transitionTest;
    test.beforeClipSwitchModel = JSON.parse(JSON.stringify(test.model.value));
    const model = JSON.parse(JSON.stringify(test.initialModel));
    model.tracks[0].transitions = [];
    model.tracks[0].clips[0].config.frame = { x: 0, y: 0, w: 320, h: 180, scale: 100, rotate: 0 };
    model.tracks[0].clips[1].config.frame = { x: -80, y: 0, w: 160, h: 180, scale: 100, rotate: 0 };
    await test.editor.value.reload(model);
    await test.player.seek(1.1);
  })()`);
  await delay(150);
  await evaluate(`(async () => {
    const test = window.transitionTest;
    const renderer = test.find(test.app._instance, 'VideoComposePlayer').setupState.frameRendererRef;
    const present = renderer.present, reset = renderer.reset;
    test.clipSwitchFrames = []; test.clipSwitchResets = 0;
    renderer.present = (frame) => {
      test.clipSwitchFrames.push({ time: frame.time, clip: frame.identity.clipId, generation: frame.identity.generation });
      present(frame);
    };
    renderer.reset = () => { test.clipSwitchResets += 1; reset(); };
    test.restoreClipSwitchRenderer = () => { renderer.present = present; renderer.reset = reset; };
    await test.player.play();
  })()`);
  await waitFor("window.transitionTest.timeline.getCurrentTime() > 2.5");
  await evaluate("window.transitionTest.player.pause()");
  const clipSwitch = await evaluate(`(() => {
    const test = window.transitionTest, canvas = document.querySelector('canvas.pointer-events-none.absolute.inset-0');
    const ctx = canvas.getContext('2d');
    return { resets: test.clipSwitchResets, frames: test.clipSwitchFrames,
      left: [...ctx.getImageData(canvas.width / 4, canvas.height / 2, 1, 1).data],
      right: [...ctx.getImageData(canvas.width * .75, canvas.height / 2, 1, 1).data] };
  })()`);
  assert.equal(clipSwitch.resets, 0, JSON.stringify(clipSwitch));
  assert.equal(new Set(clipSwitch.frames.map((frame) => frame.generation)).size, 1);
  assert.deepEqual([...new Set(clipSwitch.frames.map((frame) => frame.clip))], ["a", "b"]);
  assert.ok(clipSwitch.left[0] < 10 && clipSwitch.left[2] > 240 && clipSwitch.left[3] === 255, JSON.stringify(clipSwitch.left));
  assert.equal(clipSwitch.right[3], 0);
  console.log("PASS 不同画面变换的普通 clip 自然换片不重置解码或完成帧队列，B 使用自身变换");

  await evaluate(`window.transitionTest.timeline.patchClipsByType('video', {
    config: { frame: { x: 0, y: 0, w: 320, h: 180, scale: 100, rotate: 0 } }
  }, { clipId: 'b' })`);
  await waitFor(`(() => {
    const test = window.transitionTest, canvas = document.querySelector('canvas.pointer-events-none.absolute.inset-0');
    const pixel = canvas.getContext('2d').getImageData(canvas.width * .75, canvas.height / 2, 1, 1).data;
    return test.clipSwitchResets > 0 && pixel[2] > 240 && pixel[3] === 255;
  })()`);
  await evaluate(`(async () => {
    const test = window.transitionTest; test.restoreClipSwitchRenderer();
    await test.editor.value.reload(test.beforeClipSwitchModel); await test.player.seek(2);
  })()`);
  console.log("PASS 用户真实编辑片段变换仍会废弃旧输出并刷新已暂停的画面");

  await evaluate(`(async () => {
    const { createApp, h, ref } = await import('/node_modules/.vite/deps/vue.js');
    const { default: Player } = await import('/src/editor/player/VideoComposePlayer.vue');
    const test = window.transitionTest, props = test.find(test.app._instance, 'VideoComposePlayer').props;
    const player = ref(null), frame = ref({ x: 0, y: 0, w: 320, h: 180, scale: 100, rotate: 0 });
    const host = document.createElement('div'); host.style.cssText = 'width:640px;height:360px'; document.body.append(host);
    const app = createApp({ setup: () => () => h(Player, { ...props, ref: player,
      playbackClock: undefined, transitionTrack: undefined, overrideClips: null, catalogPreviewActive: false,
      videoClips: [{ ...props.videoClips[1], startTime: 0, endTime: 2 }], videoFrame: frame.value, readonly: true }) });
    app.mount(host);
    test.standalonePlayer = { app, host, player, frame, resets: 0,
      state: test.find(app._instance, 'VideoComposePlayer').setupState };
  })()`);
  await waitFor("window.transitionTest.standalonePlayer.state.mediaReady === true");
  await evaluate(`(async () => {
    const single = window.transitionTest.standalonePlayer;
    await single.player.value.seek(.2);
    const renderer = single.state.frameRendererRef, reset = renderer.reset;
    renderer.reset = () => { single.resets += 1; reset(); };
    single.frame.value = { x: -80, y: 0, w: 160, h: 180, scale: 100, rotate: 0 };
  })()`);
  await waitFor(`(() => {
    const single = window.transitionTest.standalonePlayer;
    const canvas = single.host.querySelector('canvas.pointer-events-none.absolute.inset-0');
    return single.resets > 0 && canvas.getContext('2d').getImageData(canvas.width * .75, canvas.height / 2, 1, 1).data[3] === 0;
  })()`);
  await evaluate("window.transitionTest.standalonePlayer.app.unmount(); window.transitionTest.standalonePlayer.host.remove()");
  console.log("PASS 无轨道独立播放器仍响应外部画面变换并刷新输出");

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

  await evaluate(`(async () => {
    const test = window.transitionTest, { watch } = await import('/node_modules/.vite/deps/vue.js');
    const green = await test.record('#00ff00'); test.urls.push(green);
    const model = JSON.parse(JSON.stringify(test.initialModel)), track = model.tracks[0];
    track.clips[1].endTime = 3; track.clips[1].trimEnd = 1;
    track.clips.push({ ...track.clips[0], id: 'c', name: '绿色', sourceUrl: green, startTime: 3, endTime: 5 });
    track.transitions = [
      { id: 'ab', clipAId: 'a', clipBId: 'b', effectId: 'crossfade', durationSec: 1, params: {} },
      { id: 'bc', clipAId: 'b', clipBId: 'c', effectId: 'crossfade', durationSec: 1, params: {} },
    ];
    await test.editor.value.reload(model);
    await test.player.seek(2.49);
    test.consecutiveFrames = [];
    const player = test.find(test.app._instance, 'VideoComposePlayer');
    test.stopConsecutiveWatch = watch(() => player.setupState.globalTime, (time) => {
      if (time < 2.6 || time > 2.9) return;
      const canvas = document.querySelector('canvas.pointer-events-none.absolute.inset-0');
      test.consecutiveFrames.push({ time, pixel: [...canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data] });
    }, { flush: 'sync' });
    await test.player.play();
  })()`);
  await waitFor("window.transitionTest.timeline.getCurrentTime() > 3.6", 25000);
  await evaluate("window.transitionTest.player.pause(); window.transitionTest.stopConsecutiveWatch()");
  const consecutiveFrames = await evaluate("window.transitionTest.consecutiveFrames");
  assert.ok(consecutiveFrames.length > 0, "必须采集到相接窗口之后的转场帧");
  assert.ok(
    consecutiveFrames.every(({ pixel }) => pixel[0] < 20 && pixel[1] > 15 && pixel[2] > 100),
    JSON.stringify(consecutiveFrames),
  );
  console.log("PASS 相接转场自动换源，B→C 帧只含蓝绿且不混入 A 的红色");

  const scaled = await evaluate(`(async () => {
    const { createApp, h, ref, onMounted } = await import('/node_modules/.vite/deps/vue.js');
    const { useComposePreviewFrame } = await import('/src/hooks/useComposePreviewFrame.ts');
    const { capturePreviewBitmap } = await import('/src/hooks/previewVideoFrame.ts');
    const original = new OffscreenCanvas(3840, 2160), paint = original.getContext('2d');
    paint.fillStyle = '#ff0000'; paint.fillRect(0, 0, 3840, 2160);
    const native = await createImageBitmap(original), signal = new AbortController().signal;
    const input = await capturePreviewBitmap(native, signal); native.close();
    const host = document.createElement('div'); document.body.append(host);
    let complete;
    const done = new Promise((resolve) => complete = resolve);
    const app = createApp({ setup() {
      const canvas = ref(null), gpuCanvas = ref(null), beautyReady = ref(false);
      const clips = ref([{ id: 'scale-test', url: 'test', title: 'scale', durationSec: 1 }]);
      const track = ref({ clips: [{ id: 'scale-test', config: { frame: { x: -960, y: 0, w: 1920, h: 2160, scale: 100, rotate: 0 } } }] });
      const preview = useComposePreviewFrame({ canvas, gpuCanvas, beautyReady, clips, transitionTrack: track,
        canvasSize: ref({ width: 3840, height: 2160 }), frame: ref(null) });
      onMounted(async () => {
        const output = await preview.renderer.render({ identity: { generation: 1, requestId: 1, clipId: 'scale-test', sourceTimeUs: 0 },
          time: 0, duration: 1 / 30, clipIndex: 0, outgoing: { bitmap: input, sourceTimeUs: 0,
            sourceSize: { width: 3840, height: 2160 }, release() {}, retain() {} } }, signal);
        preview.renderer.present(output); output.bitmap.close();
        const ctx = canvas.value.getContext('2d');
        complete({ input: [input.width, input.height], canvas: [canvas.value.width, canvas.value.height],
          project: { width: preview.videoSize.value.width, height: preview.videoSize.value.height },
          left: [...ctx.getImageData(480, 540, 1, 1).data], right: [...ctx.getImageData(1440, 540, 1, 1).data] });
      });
      return () => h('div', [h('canvas', { ref: canvas }), h('canvas', { ref: gpuCanvas })]);
    } });
    app.mount(host); const result = await done; app.unmount(); host.remove(); input.close(); return result;
  })()`);
  assert.deepEqual(scaled.input, [1920, 1080]);
  assert.deepEqual(scaled.canvas, [1920, 1080]);
  assert.deepEqual(scaled.project, { width: 3840, height: 2160 });
  assert.deepEqual(scaled.left, [255, 0, 0, 255]);
  assert.equal(scaled.right[3], 0);
  console.log("PASS 4K 快照与合成缩至 1920，项目坐标变换保持正确");

  await evaluate(`(async () => {
    const test = window.transitionTest, tone = await test.record('#ff0000', true); test.urls.push(tone);
    const NativeAudio = window.Audio; test.poolAudios = [];
    window.Audio = function(...args) { const audio = new NativeAudio(...args); test.poolAudios.push(audio); return audio; };
    window.Audio.prototype = NativeAudio.prototype; test.restoreAudio = () => window.Audio = NativeAudio;
    const model = JSON.parse(JSON.stringify(test.initialModel));
    model.tracks[0].clips[0].sourceUrl = tone; model.tracks[0].clips[0].volume = .2;
    const bgm = { ...model.tracks[0].clips[0], id: 'bgm-audio', trackId: 'bgm-track', type: 'audio', volume: .1 };
    model.tracks.push({ id: 'bgm-track', type: 'audio', name: '背景音乐', visible: true, locked: false, order: 1, clips: [bgm] });
    test.audioModel = model;
    await test.editor.value.reload(model); await test.player.seek(0); await test.player.play();
  })()`);
  await waitFor("window.transitionTest.timeline.getCurrentTime() > .25");
  const continuous = await evaluate(`(() => {
    const test = window.transitionTest, player = test.find(test.app._instance, 'VideoComposePlayer');
    const events = { seeks: 0, pauses: 0 }, descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    test.restoreVideos = [...document.querySelectorAll('video')].map((video) => {
      const originalPause = video.pause;
      Object.defineProperty(video, 'currentTime', { configurable: true, get() { return descriptor.get.call(this); },
        set(time) { events.seeks += 1; descriptor.set.call(this, time); } });
      video.pause = function() { if (!this.paused) events.pauses += 1; return originalPause.call(this); };
      return () => { delete video.currentTime; video.pause = originalPause; };
    });
    test.nativeEvents = events;
    return { originalAndBgmPlaying: test.poolAudios.filter((audio) => !audio.paused).length,
      silentVideos: [...document.querySelectorAll('video')].every((video) => video.muted), frames: player.setupState.previewStats.presented };
  })()`);
  assert.equal(continuous.originalAndBgmPlaying, 2);
  assert.equal(continuous.silentVideos, true);
  await waitFor("window.transitionTest.timeline.getCurrentTime() > .7");
  const events = await evaluate("window.transitionTest.nativeEvents");
  assert.equal(events.seeks, 0, JSON.stringify(events));
  assert.ok(events.pauses < 4, JSON.stringify(events));
  console.log("PASS 原声/BGM 独立播放，正常解码不逐帧 seek 或暂停");

  await evaluate(`(() => {
    const test = window.transitionTest, player = test.find(test.app._instance, 'VideoComposePlayer');
    const renderer = player.setupState.frameRendererRef, original = renderer.render;
    let release; const gate = new Promise((resolve) => release = resolve);
    renderer.render = async (...args) => { await gate; return original(...args); };
    test.releaseFrames = () => { renderer.render = original; release(); };
  })()`);
  await waitFor(
    "window.transitionTest.find(window.transitionTest.app._instance, 'VideoComposePlayer').setupState.playbackState === 'buffering'",
  );
  const frozen = await evaluate(`(() => {
    const test = window.transitionTest, player = test.find(test.app._instance, 'VideoComposePlayer');
    return { time: test.timeline.getCurrentTime(), frames: player.setupState.previewStats.presented,
      audios: test.poolAudios.filter((audio) => audio.src).map((audio) => ({ time: audio.currentTime, paused: audio.paused })) };
  })()`);
  assert.ok(
    frozen.audios.every((audio) => audio.paused),
    JSON.stringify(frozen),
  );
  await delay(500);
  const stillFrozen = await evaluate(`(() => {
    const test = window.transitionTest, player = test.find(test.app._instance, 'VideoComposePlayer');
    return { time: test.timeline.getCurrentTime(), frames: player.setupState.previewStats.presented,
      audios: test.poolAudios.filter((audio) => audio.src).map((audio) => audio.currentTime) };
  })()`);
  assert.equal(stillFrozen.time, frozen.time);
  assert.equal(stillFrozen.frames, frozen.frames);
  stillFrozen.audios.forEach((time, index) => assert.ok(Math.abs(time - frozen.audios[index].time) < 0.05));
  await evaluate(`(() => {
    const test = window.transitionTest, { setupState } = test.find(test.app._instance, 'VideoComposePlayer');
    test.resumeFrames = []; const original = setupState.frameRendererRef.present;
    setupState.frameRendererRef.present = (frame) => { test.resumeFrames.push(frame.time); original(frame); };
    test.restorePresent = () => setupState.frameRendererRef.present = original;
    test.releaseFrames();
  })()`);
  await waitFor("window.transitionTest.resumeFrames.length > 2");
  await evaluate(
    "window.transitionTest.player.pause(); window.transitionTest.restorePresent(); window.transitionTest.restoreVideos.forEach((restore) => restore())",
  );
  const resumed = await evaluate("window.transitionTest.resumeFrames");
  assert.ok(resumed[0] > frozen.time && resumed[0] - frozen.time <= 0.034, JSON.stringify({ frozen, resumed }));
  console.log("PASS 实际处理阻塞 500ms 时画面、时间轴和音频共同冻结，恢复只前进一帧");

  await evaluate(`(async () => {
    const test = window.transitionTest, model = JSON.parse(JSON.stringify(test.audioModel));
    model.tracks[0].clips[0].config.audioDetached = true;
    await test.editor.value.reload(model); await test.player.seek(0); await test.player.play();
  })()`);
  await waitFor("window.transitionTest.timeline.getCurrentTime() > .15");
  assert.equal(await evaluate("window.transitionTest.poolAudios.filter((audio) => !audio.paused).length"), 1);
  await evaluate("window.transitionTest.player.pause(); window.transitionTest.restoreAudio()");
  assert.equal(
    (await evaluate("window.transitionTest.editor.value.exportComposePayload()")).tracks.filter((track) => track.type === "audio").length,
    1,
  );
  console.log("PASS 原声分离后不重复播放，保留独立背景音轨");
  assert.deepEqual(errors, []);
  console.log("浏览器集成验证全部通过");
} catch (error) {
  console.error("浏览器运行异常：", errors);
  if (socket?.readyState === WebSocket.OPEN) {
    console.error(await evaluate("({ url: location.href, content: document.body?.innerText?.slice(0, 1800) })").catch(() => null));
  }
  throw error;
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await command("Browser.close").catch(() => undefined);
    socket.close();
  }
  browser.kill();
}
