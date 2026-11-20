import type { GradeContextEvent } from "@/types/videoAdjustmentWorker";
import type { VideoAdjustments } from "@/types/videoAdjustments";
import { adjustColors, grainSeed } from "@/utils/videoAdjustmentEngine";

/** 用全屏三角形覆盖整个目标画布。 */
const vertexSource = `#version 300 es
void main() {
  vec2 position = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}`;

/** 复现 CPU 的颜色量化、四邻域锐化及同源帧颗粒。 */
const fragmentSource = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uFrame;
uniform highp usampler2D uLookup;
uniform uint uSeed;
uniform vec4 uColor; // 色温、色调、亮度增益、对比度
uniform vec4 uDetail; // 饱和度、阴影、高光、锐化
uniform float uGrain;
out vec4 outColor;

vec3 toBytes(vec3 value) {
  return roundEven(clamp(value, 0.0, 255.0));
}

vec4 grade(ivec2 p) {
  vec4 pixel = roundEven(texelFetch(uFrame, p, 0) * 255.0);
  if (uDetail.x < 0.0) {
    ivec3 i = ivec3(pixel.rgb);
    uint r = texelFetch(uLookup, ivec2(i.r, 2), 0).r & 255u;
    uint g = (texelFetch(uLookup, ivec2(i.g, 2), 0).r >> 8) & 255u;
    uint b = texelFetch(uLookup, ivec2(i.b, 2), 0).r >> 16;
    pixel.rgb = vec3(r, g, b);
  } else {
    vec3 shift = vec3(uColor.x + uColor.y, -2.0 * uColor.y, -uColor.x + uColor.y);
    vec3 color = ((pixel.rgb / 255.0 + shift) * uColor.z - 0.5) * uColor.w + 0.5;
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = luma + (color - luma) * uDetail.x;
    float adjustment = uDetail.y * (1.0 - smoothstep(0.0, 0.5, luma)) + uDetail.z * smoothstep(0.5, 1.0, luma);
    pixel.rgb = toBytes((color + adjustment) * 255.0);
  }
  return pixel;
}

vec3 sharpenDetail(vec4 center, ivec2 p) {
  vec4 neighbor = grade(p);
  return (center.rgb - neighbor.rgb) * min(center.a, neighbor.a);
}

void main() {
  ivec2 size = textureSize(uFrame, 0);
  // ImageBitmap 上传后的首行是源画面顶部，画布片元坐标从底部开始。
  ivec2 p = ivec2(int(gl_FragCoord.x), size.y - 1 - int(gl_FragCoord.y));
  vec4 pixel = grade(p);
  if (pixel.a == 0.0) {
    outColor = vec4(0.0);
    return;
  }
  if (uDetail.w > 0.0 && p.x > 0 && p.y > 0 && p.x < size.x - 1 && p.y < size.y - 1) {
    vec3 detail = sharpenDetail(pixel, p + ivec2(-1, 0)) + sharpenDetail(pixel, p + ivec2(1, 0))
                + sharpenDetail(pixel, p + ivec2(0, -1)) + sharpenDetail(pixel, p + ivec2(0, 1));
    pixel.rgb = toBytes(pixel.rgb + detail * (uDetail.w / 255.0));
  }
  // 将 CPU 按行依次推进的随机数序列拆成行、列两次变换，各像素独立取值。
  if (uGrain > 0.0) {
    uvec2 row = texelFetch(uLookup, ivec2(p.y, 1), 0).rg;
    uvec2 col = texelFetch(uLookup, ivec2(p.x, 0), 0).rg;
    uint seed = col.x * (row.x * uSeed + row.y) + col.y;
    pixel.rgb = toBytes(pixel.rgb + (float(seed) / 4294967296.0 - 0.5) * uGrain);
  }
  outColor = pixel / 255.0;
}`;

/** 前两行保存颗粒的行列步进，末行预留给独立 RGB 通道查找表。 */
function buildLookupTable(width: number, height: number, tableWidth: number): Uint32Array {
  const stride = tableWidth * 2;
  const table = new Uint32Array(stride * 3);
  // 一个随机数步进可写成 mul × seed + add。
  let mul = 1;
  let add = 0;
  for (let x = 0; x < width; x++) {
    mul = Math.imul(mul, 1664525);
    add = Math.imul(add, 1664525) + 1013904223;
    table[x * 2] = mul;
    table[x * 2 + 1] = add;
  }
  const rowMul = mul;
  const rowAdd = add;
  mul = 1;
  add = 0;
  for (let y = 0; y < height; y++) {
    table[stride + y * 2] = mul;
    table[stride + y * 2 + 1] = add;
    mul = Math.imul(mul, rowMul);
    add = Math.imul(add, rowMul) + rowAdd;
  }
  return table;
}

/** 编译调色着色器并将驱动错误交给 Worker 的回退路径。 */
function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("无法创建 WebGL2 着色器");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "WebGL2 着色器编译失败";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

/** 一个预览 Worker 独占一套 WebGL 资源，普通定位和参数更新都可复用。 */
export class WebGLGradeRenderer {
  private readonly canvas = new OffscreenCanvas(1, 1);
  private readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private readonly textures: WebGLTexture[] = [];
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private width = 0;
  private height = 0;
  private colorKey = "";
  private failedSize = "";
  private lost = false;
  private restoring = false;
  private disabled = false;
  fallbackReason = "";

  /** 监听原画布的丢失和恢复；首次真正绘制时再分配资源。 */
  constructor(private readonly report: (event: GradeContextEvent) => void) {
    const { canvas } = this;
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      depth: false,
      premultipliedAlpha: false,
      failIfMajorPerformanceCaveat: true,
    });
    if (!gl) throw new Error("当前设备无法创建满足性能要求的 WebGL2 上下文");
    this.gl = gl;
    canvas.addEventListener("webglcontextlost", this.onLost);
    canvas.addEventListener("webglcontextrestored", this.onRestored);
    report("created");
  }

  /** 浏览器允许恢复时继续使用同一上下文，先由 CPU 接管。 */
  private onLost = (event: Event): void => {
    event.preventDefault();
    this.markLost();
  };

  /** 绘制过程中也可能先于事件观察到丢失，同一次故障只记一次。 */
  private markLost(): void {
    if (this.lost) return;
    this.lost = true;
    this.fallbackReason = "WebGL2 上下文已丢失";
    this.report("lost");
    this.release();
  }

  /** 恢复后的首次有效请求重新建立所有绑定和尺寸相关数据。 */
  private onRestored = (): void => {
    this.lost = false;
    this.restoring = true;
    this.failedSize = "";
    this.report("restored");
  };

  /** 创建所有效果共用的程序、输入纹理和查找纹理。 */
  private initialize(): void {
    const gl = this.gl;
    const program = gl.createProgram();
    if (!program) throw new Error("无法创建 WebGL2 程序");
    this.program = program;
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertexSource],
      [gl.FRAGMENT_SHADER, fragmentSource],
    ] as const) {
      const shader = compile(gl, type, source);
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "WebGL2 程序链接失败");
    gl.useProgram(program);
    gl.disable(gl.DITHER);
    for (const [unit, name] of ["uFrame", "uLookup"].entries()) {
      const texture = gl.createTexture();
      if (!texture) throw new Error("无法创建 WebGL2 纹理");
      this.textures.push(texture);
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.uniform1i(gl.getUniformLocation(program, name), unit);
    }
    for (const name of ["uColor", "uDetail", "uGrain", "uSeed"]) this.uniforms[name] = gl.getUniformLocation(program, name);
  }

  /** 只在尺寸变更后分配存储；失败的尺寸等待下一次尺寸变化。 */
  private resize(width: number, height: number): void {
    const { gl, canvas } = this;
    this.failedSize = `${width}x${height}`;
    const tableWidth = Math.max(width, height, 256);
    if (tableWidth > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw new Error("预览尺寸超过设备纹理上限");
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
    gl.activeTexture(gl.TEXTURE1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RG32UI,
      tableWidth,
      3,
      0,
      gl.RG_INTEGER,
      gl.UNSIGNED_INT,
      buildLookupTable(width, height, tableWidth),
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    if (gl.getError() !== gl.NO_ERROR || gl.drawingBufferWidth !== width || gl.drawingBufferHeight !== height) {
      throw new Error("WebGL2 无法分配预览所需的图像资源");
    }
    this.failedSize = "";
    this.colorKey = "";
    this.width = width;
    this.height = height;
  }

  /** 独立通道的颜色变换用 CPU 算出 256 级精确舍入表，参数未变时复用。 */
  private updateColors(p: VideoAdjustments): void {
    const { gl, uniforms } = this;
    gl.uniform4f(uniforms.uColor, p.temperature * 0.002, p.tint * 0.001, 1 + p.brightness / 100, 1 + p.contrast / 100);
    // 负值专用于查表，避免接近中性的参数在 float32 中舍入为 1 时误读旧表。
    const useLookup = p.saturation === 0 && p.shadows === 0 && p.highlights === 0;
    gl.uniform4f(uniforms.uDetail, useLookup ? -1 : 1 + p.saturation / 100, p.shadows * 0.003, p.highlights * 0.003, p.sharpen / 100);
    gl.uniform1f(uniforms.uGrain, p.grain * 0.5);
    if (!useLookup) return;
    const key = [p.temperature, p.tint, p.brightness, p.contrast].join(",");
    if (key === this.colorKey) return;
    const ramp = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) ramp.set([i, i, i, 255], i * 4);
    adjustColors(ramp, p);
    const lookup = new Uint32Array(256 * 2);
    for (let i = 0; i < 256; i++) lookup[i * 2] = ramp[i * 4] | (ramp[i * 4 + 1] << 8) | (ramp[i * 4 + 2] << 16);
    gl.activeTexture(gl.TEXTURE1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 2, 256, 1, gl.RG_INTEGER, gl.UNSIGNED_INT, lookup);
    gl.activeTexture(gl.TEXTURE0);
    this.colorKey = key;
  }

  /** 仅返回可用 GPU 输出；故障帧由调用方使用原输入执行 CPU 调色。 */
  render(bitmap: ImageBitmap, p: VideoAdjustments, clipId: string, sourceTimeUs: number): ImageBitmap | null {
    const { gl } = this;
    if (this.lost || gl.isContextLost()) {
      this.markLost();
      return null;
    }
    if (this.disabled || (this.failedSize && this.failedSize === `${bitmap.width}x${bitmap.height}`)) return null;
    try {
      if (!this.program) this.initialize();
      const resized = bitmap.width !== this.width || bitmap.height !== this.height;
      if (resized) this.resize(bitmap.width, bitmap.height);
      this.updateColors(p);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      if (p.grain) gl.uniform1ui(this.uniforms.uSeed, grainSeed(clipId, sourceTimeUs));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (resized && gl.getError() !== gl.NO_ERROR) throw new Error("WebGL2 无法绘制预览帧");
      const output = this.canvas.transferToImageBitmap();
      if (gl.isContextLost()) {
        output.close();
        throw new Error("WebGL2 上下文已丢失");
      }
      if (this.restoring) this.report("rebuilt");
      this.restoring = false;
      this.fallbackReason = "";
      return output;
    } catch (error: unknown) {
      this.fallbackReason = error instanceof Error ? error.message : "WebGL2 调色失败";
      if (gl.isContextLost()) this.markLost();
      else {
        this.disabled = !this.failedSize;
        if (this.restoring) this.report("rebuildFailed");
        if (this.disabled) this.restoring = false;
        this.release();
      }
      return null;
    }
  }

  /** 释放部分或完整初始化的资源；丢失时直接放弃已失效句柄。 */
  private release(): void {
    if (!this.lost && !this.gl.isContextLost()) {
      for (const texture of this.textures) this.gl.deleteTexture(texture);
      this.gl.useProgram(null);
      this.gl.deleteProgram(this.program);
      this.canvas.width = this.canvas.height = 1;
    }
    this.textures.length = 0;
    this.program = null;
    this.uniforms = {};
    this.width = this.height = 0;
    this.colorKey = "";
  }

  /** 正常退出时移除监听并回收当前资源。 */
  dispose(): void {
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    this.release();
  }
}
