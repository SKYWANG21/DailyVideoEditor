import type { BeautyRenderRequest, BeautyWorkerEvent, BeautyWorkerRequest } from "@/types/beautyPreview";
import { copyFrameRgba, releaseFrameRgba } from "./beauty/copyFrameRgba";
import { installImportScripts } from "./beauty/installImportScripts";
import { FacePass } from "./beauty/facePass";

installImportScripts();

/** Worker 只接收快照，不再请求视频 URL 或独立解码 */
interface PreviewWorkerScope {
  /** 用来解析模型路径 */
  location: Location;
  /** 主线程消息入口 */
  onmessage: ((event: MessageEvent<BeautyWorkerRequest>) => void) | null;
  /** 转移 RGBA 所有权 */
  postMessage(message: BeautyWorkerEvent, transfer?: Transferable[]): void;
}

const scope = self as unknown as PreviewWorkerScope;
const facePass = new FacePass();
let faceInit: Promise<void> | null = null;
let faceWarning = "";
let disposed = false;
/** 片段变化时清掉关键点缓存，防止新片段复用旧人脸 */
let faceClipId = "";

/** 人脸模型失败只降级关键点效果，普通磨皮、美白继续 */
async function ensureFace(base: string): Promise<void> {
  if (faceWarning) return;
  if (!faceInit) {
    const root = new URL(base.endsWith("/") ? base : `${base}/`, scope.location.origin);
    faceInit = facePass.init(new URL("mediapipe/", root).href, new URL("face_landmarker.task", root).href).catch((error: unknown) => {
      faceWarning = `人脸检测不可用，已停用瘦脸和大眼：${error instanceof Error ? error.message : "模型加载失败"}`;
    });
  }
  await faceInit;
  if (disposed) facePass.close();
}

/** 处理一个已解码快照；成功、失败和取消最终都关闭 bitmap */
async function render(request: BeautyRenderRequest): Promise<void> {
  const { generation, requestId, clipId, sourceTimeUs, bitmap } = request;
  const identity = { generation, requestId, clipId, sourceTimeUs };
  try {
    if (disposed) return;
    if (faceClipId !== clipId) {
      facePass.reset();
      faceClipId = clipId;
    }
    let landmarks = new Float32Array(0);
    if (request.detectFace && !faceWarning) {
      try {
        landmarks = new Float32Array(await facePass.detect(bitmap, sourceTimeUs));
      } catch (error: unknown) {
        faceWarning = `人脸检测不可用，已停用瘦脸和大眼：${error instanceof Error ? error.message : "检测失败"}`;
      }
    }
    if (disposed) return;
    const rgba = copyFrameRgba(bitmap);
    scope.postMessage({ type: "frame", ...identity, ...rgba, landmarks, warning: faceWarning || undefined }, [
      rgba.buffer,
      landmarks.buffer,
    ]);
  } catch (error: unknown) {
    if (!disposed) scope.postMessage({ type: "error", ...identity, message: error instanceof Error ? error.message : "预览像素读取失败" });
  } finally {
    bitmap.close();
  }
}

/** 主线程最多发送一个处理任务；预热消息不携带视频帧 */
scope.onmessage = (event: MessageEvent<BeautyWorkerRequest>): void => {
  const message = event.data;
  if (message.type === "dispose") {
    disposed = true;
    facePass.close();
    releaseFrameRgba();
  } else if (message.type === "init") {
    void (async (): Promise<void> => {
      if (message.detectFace) await ensureFace(message.algorithmBaseUrl);
      if (!disposed) scope.postMessage({ type: "ready", requestId: message.requestId, warning: faceWarning || undefined });
    })();
  } else {
    void render(message);
  }
};
