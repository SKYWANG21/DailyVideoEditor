import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readVideoAdjustments } from "../src/types/videoAdjustments";
import type { AdjustmentWorkerRequest, GradeWorkerMessage } from "../src/types/videoAdjustmentWorker";

const workers = vi.hoisted(() => ({ instances: [] as FakeWorker[] }));
/** 可控消息时序，复现取消、迟到结果和 Worker 失败。 */
interface FakeWorker {
  onmessage: ((event: { data: GradeWorkerMessage }) => void) | null;
  onerror: (() => void) | null;
  terminate: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn<(request: AdjustmentWorkerRequest, transfer: Transferable[]) => void>>;
}
vi.mock("../src/workers/videoAdjustment.worker.ts?worker&inline", () => ({
  default: class {
    onmessage = null;
    onerror = null;
    terminate = vi.fn();
    postMessage = vi.fn<(request: AdjustmentWorkerRequest, transfer: Transferable[]) => void>();
    constructor() {
      workers.instances.push(this);
    }
  },
}));
import { VideoAdjustmentWorkerClient } from "../src/hooks/videoAdjustmentWorkerClient";

/** 模拟有明确关闭语义的位图。 */
function bitmap(): ImageBitmap {
  return { width: 8, height: 8, close: vi.fn() } as unknown as ImageBitmap;
}
/** 返回最后一次处理的有效结果。 */
function reply(worker: FakeWorker, output: ImageBitmap): void {
  const { bitmap: _input, adjustments: _params, ...identity } = worker.postMessage.mock.calls.at(-1)![0];
  worker.onmessage?.({ data: { type: "frame", ...identity, backendUsed: "gpu", bitmap: output } });
}

describe("调色 Worker 生命周期", () => {
  let client: VideoAdjustmentWorkerClient;
  let input: ImageBitmap;
  const canvas = {} as OffscreenCanvas;
  const frame = { clipId: "a", sourceTimeUs: 1000 };
  beforeEach(() => {
    workers.instances = [];
    input = bitmap();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => input),
    );
    client = new VideoAdjustmentWorkerClient();
  });
  afterEach(() => {
    client.dispose();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("传输独立输入快照，调用方取得输出所有权", async () => {
    const pending = client.render(canvas, readVideoAdjustments({ brightness: 10 }), frame, 1, new AbortController().signal);
    await Promise.resolve();
    const worker = workers.instances[0];
    expect(worker.postMessage.mock.calls[0][1]).toEqual([input]);
    const output = bitmap();
    reply(worker, output);
    expect(await pending).toBe(output);
    expect(output.close).not.toHaveBeenCalled();
    expect(input.close).toHaveBeenCalled();
  });

  it("连续定位取消等待，只发送最终目标并复用旧线程", async () => {
    const controller = new AbortController();
    const pending = client.render(canvas, readVideoAdjustments(), frame, 1, controller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    const old = workers.instances[0];
    controller.abort();
    await cancelled;
    expect(old.terminate).not.toHaveBeenCalled();
    const middle = new AbortController();
    const skipped = client.render(canvas, readVideoAdjustments(), frame, 2, middle.signal);
    const dropped = expect(skipped).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    middle.abort();
    await dropped;
    const next = client.render(canvas, readVideoAdjustments(), frame, 3, new AbortController().signal);
    await Promise.resolve();
    expect(old.postMessage).toHaveBeenCalledTimes(1);
    const late = bitmap();
    reply(old, late);
    expect(late.close).toHaveBeenCalledOnce();
    expect(workers.instances).toHaveLength(1);
    expect(old.postMessage.mock.calls.at(-1)![0].generation).toBe(3);
    const output = bitmap();
    reply(old, output);
    expect(await next).toBe(output);
  });

  it("快照创建期间取消会关闭快照并跳过 Worker 创建", async () => {
    const controller = new AbortController();
    const pending = client.render(canvas, readVideoAdjustments(), frame, 1, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(input.close).toHaveBeenCalled();
    expect(workers.instances).toHaveLength(0);
  });

  it("连续丢失时播放器保持 CPU，定位不会绕过保护", async () => {
    const signal = new AbortController().signal;
    const params = readVideoAdjustments({ brightness: 5 });
    const first = client.render(canvas, params, frame, 1, signal);
    await Promise.resolve();
    const worker = workers.instances[0];
    for (let i = 0; i < 3; i++) worker.onmessage?.({ data: { type: "context", event: "lost" } });
    reply(worker, bitmap());
    (await first).close();
    client.reset();
    const second = client.render(canvas, params, frame, 2, signal);
    await Promise.resolve();
    expect(worker.postMessage.mock.lastCall?.[0].cpuOnly).toBe(true);
    expect(worker.terminate).not.toHaveBeenCalled();
    reply(worker, bitmap());
    (await second).close();
  });

  it("已取消帧超时仍释放物理计算槽，下一次请求可重新创建线程", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const first = client.render(canvas, readVideoAdjustments(), frame, 1, controller.signal);
    const cancelled = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    controller.abort();
    await cancelled;
    await vi.advanceTimersByTimeAsync(15000);
    expect(workers.instances[0].terminate).toHaveBeenCalledOnce();
    const next = client.render(canvas, readVideoAdjustments(), frame, 2, new AbortController().signal);
    await Promise.resolve();
    reply(workers.instances[1], bitmap());
    (await next).close();
  });

  it("Worker 超时会拒绝等待并释放线程", async () => {
    vi.useFakeTimers();
    const pending = client.render(canvas, readVideoAdjustments(), frame, 1, new AbortController().signal);
    const failed = expect(pending).rejects.toThrow("超时");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(15000);
    await failed;
    expect(workers.instances[0].terminate).toHaveBeenCalled();
  });
});
