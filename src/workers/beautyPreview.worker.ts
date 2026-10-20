import type { BeautyFrameEvent, BeautyWorkerEvent, BeautyWorkerRequest } from "@/types/beautyPreview";
import { copyFrameRgba } from "./beauty/copyFrameRgba";
import { DecodeSession } from "./beauty/decodeSession";
import { installImportScripts } from "./beauty/installImportScripts";
import { FacePass } from "./beauty/facePass";

installImportScripts();

/** 模块 Worker 上的 postMessage 与页面 Window 签名不同，这里收成预览线程要用的形状 */
interface PreviewWorkerScope {
  /** 用来拼模型地址 */
  location: Location;
  /** 主线程消息 */
  onmessage: ((this: PreviewWorkerScope, ev: MessageEvent<BeautyWorkerRequest>) => void) | null;
  /** 把帧或错误发回主线程。transfer 里的缓冲会被转移 */
  postMessage(message: BeautyWorkerEvent, transfer?: Transferable[]): void;
}

const scope = self as unknown as PreviewWorkerScope;

/** 人脸模型。由页面 public 目录提供 */
const FACE_MODEL_URL = new URL("/algorithm/face_landmarker.task", scope.location.origin).href;

/** MediaPipe SIMD wasm 目录 */
const FACE_WASM_URL = new URL("/algorithm/mediapipe/", scope.location.origin).href;

const decodeSession = new DecodeSession();
const facePass = new FacePass();

let faceInit: Promise<void> | null = null;
let faceFailed = false;
let renderChain: Promise<void> = Promise.resolve();
let latestRender: Extract<BeautyWorkerRequest, { type: "render" }> | null = null;

/** 把错误发回主线程，不中断后续帧 */
function postError(requestId: number, error: unknown): void {
  const message = error instanceof Error ? error.message : "预览画面失败";
  const event: BeautyWorkerEvent = { type: "error", requestId, message };
  scope.postMessage(event);
}

/** 人脸模块只初始化一次。失败后跳过检测，解码继续 */
function ensureFace(): Promise<void> {
  if (faceFailed) return Promise.reject(new Error("人脸检测不可用"));
  if (!faceInit) {
    faceInit = facePass.init(FACE_WASM_URL, FACE_MODEL_URL).catch((error: unknown) => {
      faceFailed = true;
      faceInit = null;
      throw error;
    });
  }
  return faceInit;
}

/** 解一帧、按需检测，再把 RGBA 和关键点转交主线程 */
async function runRender(request: Extract<BeautyWorkerRequest, { type: "render" }>): Promise<void> {
  const frame = await decodeSession.tick(request.clipId, request.url, request.sourceTimeUs);
  if (!frame) return;
  if (latestRender && latestRender.requestId > request.requestId) {
    frame.close();
    return;
  }
  try {
    let landmarks: Float32Array<ArrayBufferLike> = new Float32Array(0);
    if (request.detectFace) {
      try {
        await ensureFace();
        landmarks = await facePass.detect(frame, request.sourceTimeUs);
      } catch (e) {
        landmarks = new Float32Array(0);
        console.log(e, e.message);
      }
    }
    if (latestRender && latestRender.requestId > request.requestId) return;
    const rgba = await copyFrameRgba(frame);
    const landmarksCopy = new Float32Array(landmarks);
    const event: BeautyFrameEvent = {
      type: "frame",
      requestId: request.requestId,
      clipId: request.clipId,
      width: rgba.width,
      height: rgba.height,
      sourceTimeUs: request.sourceTimeUs,
      buffer: rgba.buffer,
      landmarks: landmarksCopy,
    };
    const transfers: Transferable[] = [rgba.buffer];
    if (landmarksCopy.buffer instanceof ArrayBuffer && landmarksCopy.byteLength > 0) {
      transfers.push(landmarksCopy.buffer);
    }
    scope.postMessage(event, transfers);
  } finally {
    frame.close();
  }
}

/** 渲染任务串行执行，队列里只留最新一帧 */
function drainRenders(): Promise<void> {
  const job = latestRender;
  if (!job) return Promise.resolve();
  latestRender = null;
  return runRender(job)
    .catch((error: unknown) => postError(job.requestId, error))
    .then(() => {
      if (latestRender) return drainRenders();
      return undefined;
    });
}

/** 新的取帧请求覆盖还没开始的那一帧 */
function enqueueRender(request: Extract<BeautyWorkerRequest, { type: "render" }>): void {
  latestRender = request;
  renderChain = renderChain.then(drainRenders).catch(() => undefined);
}

scope.onmessage = (event: MessageEvent<BeautyWorkerRequest>) => {
  const message = event.data;
  if (message.type === "dispose") {
    latestRender = null;
    decodeSession.destroy();
    facePass.close();
    return;
  }
  if (message.type === "prefetch") {
    decodeSession.prefetch(message.clipId, message.url);
    return;
  }
  enqueueRender(message);
};
