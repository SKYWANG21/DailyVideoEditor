/** 真实专用 Worker 上比较 CPU/GPU，并在同一尺寸连续触发两次上下文丢失与恢复。 */
export async function verifyGradeRecovery() {
  const { VideoAdjustmentEngine } = await import("/src/utils/videoAdjustmentEngine.ts");
  const { readVideoAdjustments } = await import("/src/types/videoAdjustments.ts");
  // 仅测试 Worker 允许软件 WebGL 执行一致性检查，设备名称一并返回。
  const entry = `
    let loss;
    const getContext = OffscreenCanvas.prototype.getContext;
    OffscreenCanvas.prototype.getContext = function(type, options) {
      if (type !== 'webgl2') return getContext.call(this, type, options);
      const gl = getContext.call(this, type, { ...options, failIfMajorPerformanceCaveat: false });
      if (gl) {
        loss = gl.getExtension('WEBGL_lose_context');
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        postMessage({ renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) });
      }
      return gl;
    };
    self.addEventListener('message', event => {
      if (!event.data.control) return;
      event.stopImmediatePropagation();
      loss[event.data.control]();
    });
    await import(${JSON.stringify(new URL("/src/workers/videoAdjustment.worker.ts", location.href).href)});
    postMessage({ ready: true });`;
  const url = URL.createObjectURL(new Blob([entry], { type: "text/javascript" }));
  const worker = new Worker(url, { type: "module" });
  const events = [];
  let renderer;
  let complete, fail;
  let waitingFor;
  const wait = (matches, send) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("调色 Worker 验证超时")), 8000);
      waitingFor = matches;
      complete = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      fail = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      send?.();
    });
  worker.onmessage = ({ data }) => {
    if (data.renderer) renderer = data.renderer;
    if (data.type === "context") events.push(data.event);
    if (data.type === "error") fail(new Error(data.message));
    else if (waitingFor?.(data)) complete(data);
  };
  worker.onerror = (event) => fail(new Error(event.message));
  let requestId = 0;
  let maxError = 0;
  const frame = { clipId: "gpu-test", sourceTimeUs: 33333 };
  const source = new OffscreenCanvas(32, 24),
    ctx = source.getContext("2d");
  const pixels = ctx.createImageData(32, 24);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const n = i / 4;
    pixels.data.set([(n * 7) % 256, (n * 3) % 256, (n * 17) % 256, [0, 128, 255, 255][n % 4]], i);
  }
  ctx.putImageData(pixels, 0, 0);
  const cpu = new VideoAdjustmentEngine();
  const check = async (params, backend, width = 32, height = 24) => {
    const adjustments = readVideoAdjustments(params);
    const input = new OffscreenCanvas(width, height),
      inputCtx = input.getContext("2d");
    inputCtx.drawImage(source, 0, 0, width, height);
    const bitmap = await createImageBitmap(input, { premultiplyAlpha: "none" });
    const result = await wait(
      (data) => data.type === "frame",
      () => worker.postMessage({ ...frame, requestId: ++requestId, generation: 1, adjustments, bitmap }, [bitmap]),
    );
    if (result.backendUsed !== backend) throw new Error("实际后端 " + result.backendUsed + ": " + result.fallbackReason);
    cpu.apply(inputCtx, adjustments, frame);
    const expected = inputCtx.getImageData(0, 0, width, height).data;
    inputCtx.clearRect(0, 0, width, height);
    inputCtx.drawImage(result.bitmap, 0, 0);
    result.bitmap.close();
    const actual = inputCtx.getImageData(0, 0, width, height).data;
    for (let i = 0; i < actual.length; i++) {
      const alpha = expected[i - (i % 4) + 3];
      const difference = Math.abs(actual[i] - expected[i]);
      // 在合成空间比较半透明颜色，Alpha 单独要求逐字节一致。
      const error = i % 4 === 3 ? difference : (difference * alpha) / 255;
      maxError = Math.max(maxError, error);
      if ((i % 4 === 3 && difference) || error > 1.01)
        throw new Error("调色像素差异 " + JSON.stringify({ params, i, error, actual: actual[i], expected: expected[i] }));
    }
  };
  try {
    await wait((data) => data.ready);
    const preset = { temperature: 50, brightness: 50, sharpen: 50, grain: 50 };
    await check(preset, "gpu");
    for (const key of Object.keys(readVideoAdjustments())) await check({ [key]: 100 }, "gpu");
    await check(
      { temperature: -45, tint: 22, brightness: 11, contrast: -12, saturation: 21, highlights: 30, shadows: -17, grain: 50, sharpen: 40 },
      "gpu",
    );
    await check({ brightness: 20 }, "gpu", 16, 12);
    for (let cycle = 0; cycle < 2; cycle++) {
      await wait(
        (data) => data.event === "lost",
        () => worker.postMessage({ control: "loseContext" }),
      );
      await check(preset, "cpu");
      await check(preset, "cpu");
      await wait(
        (data) => data.event === "restored",
        () => worker.postMessage({ control: "restoreContext" }),
      );
      await check(preset, "gpu");
    }
    const expectedEvents = ["created", "lost", "restored", "rebuilt", "lost", "restored", "rebuilt"];
    if (String(events) !== String(expectedEvents)) throw new Error("上下文生命周期异常 " + events.join(","));
    return { renderer, events, checkedFrames: requestId, maxCompositedChannelError: maxError };
  } finally {
    worker.terminate();
    URL.revokeObjectURL(url);
  }
}
