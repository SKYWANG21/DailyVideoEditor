import { vi } from "vitest";
import { TransitionWorkerRuntime } from "../../src/workers/transition.worker";
import type { TransitionWorkerEvent, TransitionWorkerRequest } from "../../src/types/transitionWorker";

/** 只替代浏览器图形对象，Worker 的消息处理与 WASM 运算使用真实代码。 */
export class MockBitmap {
  close = vi.fn();
  badRead = false;
  constructor(
    public data: Uint8ClampedArray,
    public width: number,
    public height: number,
  ) {}
}

export const reads = { count: 0 };

/** 无浏览器环境下可观察传输、线程共享、故障和终止。 */
export class MockTransitionWorker {
  static instances: MockTransitionWorker[] = [];
  onmessage: ((event: MessageEvent<TransitionWorkerEvent>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  silent = false;
  terminated = false;
  terminate = vi.fn(() => {
    this.terminated = true;
  });
  private runtime = new TransitionWorkerRuntime((data) => {
    if (this.terminated) {
      if (data.type === "frame") data.bitmap.close();
      return;
    }
    this.onmessage?.({ data } as MessageEvent<TransitionWorkerEvent>);
  });
  constructor() {
    MockTransitionWorker.instances.push(this);
  }
  postMessage(message: TransitionWorkerRequest): void {
    if (!this.silent && !this.terminated) this.runtime.accept(message);
  }
}

/** 安装可计数的像素读回画布，位图快照复制输入，便于验证借用所有权。 */
export function installTransitionCanvasMocks(): void {
  reads.count = 0;
  MockTransitionWorker.instances.length = 0;
  vi.stubGlobal(
    "ImageData",
    class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number,
      ) {}
    },
  );
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async (source: MockBitmap) => {
      const bitmap = new MockBitmap(source.data.slice(), source.width, source.height);
      bitmap.badRead = source.badRead;
      return bitmap;
    }),
  );
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      private data = new Uint8ClampedArray(0);
      private badRead = false;
      constructor(
        public width: number,
        public height: number,
      ) {}
      get pixels(): number[] {
        return [...this.data];
      }
      transferToImageBitmap(): MockBitmap {
        return new MockBitmap(this.data.slice(), this.width, this.height);
      }
      getContext() {
        return {
          canvas: this,
          clearRect: (): void => {
            this.data = new Uint8ClampedArray(this.width * this.height * 4);
          },
          save: (): void => {},
          restore: (): void => {},
          drawImage: (source: MockBitmap): void => {
            this.data = source.data.slice();
            this.badRead = source.badRead;
          },
          getImageData: (): { data: Uint8ClampedArray } => {
            reads.count++;
            if (this.badRead) throw new Error("read failed");
            return { data: this.data.slice() };
          },
          putImageData: (image: ImageData): void => {
            this.data = image.data.slice();
          },
        };
      }
    },
  );
}
