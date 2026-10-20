/** 一帧 RGBA 及其显示尺寸 */
export interface FrameRgba {
  /** 像素缓冲 */
  buffer: ArrayBuffer;
  /** 宽 */
  width: number;
  /** 高 */
  height: number;
}

/**
 * 把 VideoFrame 拷成紧密排列的 RGBA。
 * GPUPixel 只接受这份内存，不接受 VideoFrame。
 * VideoFrame 首行是画面顶边，WebGL 把缓冲首行当纹理底边，拷完后翻行才正立。
 */
export async function copyFrameRgba(frame: VideoFrame): Promise<FrameRgba> {
  const width = frame.displayWidth;
  const height = frame.displayHeight;
  if (width <= 0 || height <= 0) {
    throw new Error("视频帧尺寸无效");
  }
  const layout = [{ offset: 0, stride: width * 4 }];
  const byteLength = frame.allocationSize({ format: "RGBA", layout });
  const buffer = new ArrayBuffer(byteLength);
  await frame.copyTo(buffer, { format: "RGBA", layout });
  flipRgbaRows(buffer, width, height);
  return { buffer, width, height };
}

/** 上下对调每一行，使首行变成画面底边 */
function flipRgbaRows(buffer: ArrayBuffer, width: number, height: number): void {
  const view = new Uint8Array(buffer);
  const stride = width * 4;
  const row = new Uint8Array(stride);
  let top = 0;
  let bottom = (height - 1) * stride;
  while (top < bottom) {
    row.set(view.subarray(top, top + stride));
    view.copyWithin(top, bottom, bottom + stride);
    view.set(row, bottom);
    top += stride;
    bottom -= stride;
  }
}
