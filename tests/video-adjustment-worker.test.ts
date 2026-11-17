import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readVideoAdjustments } from "../src/types/videoAdjustments";
import type { AdjustmentWorkerRequest, AdjustmentWorkerResponse } from "../src/types/videoAdjustmentWorker";

const workers = vi.hoisted(() => ({ instances: [] as FakeWorker[] }));
/** 可控消息时序，复现取消、迟到结果和 Worker 失败。 */
interface FakeWorker {
  onmessage: ((event: { data: AdjustmentWorkerResponse }) => void) | null;
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
  const { bitmap: _input, adjustments: _params, ...identity } = worker.postMessage.mock.calls[0][0];
  worker.onmessage?.({ data: { type: "frame", ...identity, bitmap: output } });
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

  it("取消终止旧线程、拒绝等待并关闭迟到输出，下一次请求可恢复", async () => {
    const controller = new AbortController();
    const pending = client.render(canvas, readVideoAdjustments(), frame, 1, controller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    const old = workers.instances[0];
    controller.abort();
    await cancelled;
    expect(old.terminate).toHaveBeenCalled();
    const late = bitmap();
    reply(old, late);
    expect(late.close).toHaveBeenCalled();
    const next = client.render(canvas, readVideoAdjustments(), frame, 2, new AbortController().signal);
    await Promise.resolve();
    old.onerror?.();
    const output = bitmap();
    reply(workers.instances[1], output);
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
