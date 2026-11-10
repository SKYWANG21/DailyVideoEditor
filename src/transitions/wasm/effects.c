/**
 * 九种独立转场的共享像素内核，TRANSITION_EFFECT 在编译时选择效果。
 * 输入输出沿用非预乘 sRGB RGBA8 ABI；采样、镜像、裁剪和混合均在 WASM 内完成。
 * 不依赖浏览器、宿主导入、libc 或额外工作内存，缓动由调用方统一处理。
 */
typedef unsigned char Byte;
typedef unsigned int Size;

/** 预乘的 RGBA，所有通道取值均为 0–255。 */
typedef struct {
  double r, g, b, a;
} Pixel;

/** 当前帧共用的几何量，避免逐像素重复计算三角函数。 */
typedef struct {
  Size width, height;
  double progress, small_scale, large_scale, strength;
  double x, y, cosine, sine, scale;
} Frame;

/** 将比例限制到合法区间，NaN 也按起点处理。 */
static double unit(double value) {
  if (!(value >= 0.0)) return 0.0;
  return value > 1.0 ? 1.0 : value;
}

/** 无 libm 的周期正弦；区间收束后使用十七阶多项式。 */
static double sine(double value) {
  const double pi = 3.14159265358979323846;
  value -= __builtin_floor((value + pi) / (2.0 * pi)) * (2.0 * pi);
  const double square = value * value;
  return value * (1.0 + square * (-1.0 / 6.0 + square * (1.0 / 120.0 +
      square * (-1.0 / 5040.0 + square * (1.0 / 362880.0 +
      square * (-1.0 / 39916800.0 + square * (1.0 / 6227020800.0 +
      square * (-1.0 / 1307674368000.0 + square / 355687428096000.0))))))));
}

/** 在预乘颜色空间加权，不因透明输入或二次 source-over 使画面变暗。 */
static Pixel mix(Pixel a, Pixel b, double weight) {
  const double other = 1.0 - weight;
  return (Pixel){a.r * other + b.r * weight, a.g * other + b.g * weight,
                 a.b * other + b.b * weight, a.a * other + b.a * weight};
}

/** 读取单个像素并转换为预乘颜色。 */
static Pixel read_pixel(const Byte *source, Size width, Size x, Size y) {
  const Byte *pixel = source + (y * width + x) * 4;
  const double alpha = pixel[3] / 255.0;
  return (Pixel){pixel[0] * alpha, pixel[1] * alpha, pixel[2] * alpha, pixel[3]};
}

/** 双线性采样采用像素中心坐标，边缘夹取，匹配 Canvas 图像缩放语义。 */
static Pixel sample(const Byte *source, Size width, Size height, double x, double y) {
  x = x < 0.0 ? 0.0 : (x > width - 1.0 ? width - 1.0 : x);
  y = y < 0.0 ? 0.0 : (y > height - 1.0 ? height - 1.0 : y);
  const Size left = (Size)x, top = (Size)y;
  const Size right = left + 1 < width ? left + 1 : left;
  const Size bottom = top + 1 < height ? top + 1 : top;
  const Pixel upper = mix(read_pixel(source, width, left, top), read_pixel(source, width, right, top), x - left);
  const Pixel lower = mix(read_pixel(source, width, left, bottom), read_pixel(source, width, right, bottom), x - left);
  return mix(upper, lower, y - top);
}

/** 将缩放后超出素材的坐标沿四边和四角镜像折回。 */
static double reflect(double value, double length) {
  const double period = length * 2.0;
  value -= __builtin_floor(value / period) * period;
  return value > length ? period - value : value;
}

/** 居中变焦采样；缩小帧使用镜像坐标铺满整个输出。 */
static Pixel zoom_sample(const Byte *source, const Frame *frame, double x, double y, double scale, int mirror) {
  x = (x - frame->width / 2.0) / scale + frame->width / 2.0;
  y = (y - frame->height / 2.0) / scale + frame->height / 2.0;
  if (mirror) {
    x = reflect(x, frame->width);
    y = reflect(y, frame->height);
  }
  return sample(source, frame->width, frame->height, x - 0.5, y - 0.5);
}

/** 将预乘结果反预乘、舍入为 RGBA8；全透明像素的颜色统一归零。 */
static void write_pixel(Byte *output, Pixel pixel) {
  const double alpha = pixel.a < 0.0 ? 0.0 : (pixel.a > 255.0 ? 255.0 : pixel.a);
  /* 消除多次浮点加权落在半值下方的微小误差，保持 RGBA8 半值向上舍入。 */
  output[3] = (Byte)(alpha + 0.500000001);
  if (output[3] == 0) {
    output[0] = output[1] = output[2] = 0;
    return;
  }
  const double red = pixel.r * 255.0 / alpha;
  const double green = pixel.g * 255.0 / alpha;
  const double blue = pixel.b * 255.0 / alpha;
  output[0] = (Byte)((red < 0.0 ? 0.0 : (red > 255.0 ? 255.0 : red)) + 0.500000001);
  output[1] = (Byte)((green < 0.0 ? 0.0 : (green > 255.0 ? 255.0 : green)) + 0.500000001);
  output[2] = (Byte)((blue < 0.0 ? 0.0 : (blue > 255.0 ? 255.0 : blue)) + 0.500000001);
}

/** 单像素与水平/竖直裁剪区间的精确覆盖率。 */
static double interval(double coordinate, double start, double end) {
  const double left = coordinate > start ? coordinate : start;
  const double right = coordinate + 1.0 < end ? coordinate + 1.0 : end;
  return unit(right - left);
}

/** 45° 投影下像素方块的面积累积分布，避免倾斜百叶出现锯齿。 */
static double diagonal_area(double distance) {
  const double radius = 0.70710678118654752440;
  if (distance <= -radius) return 0.0;
  if (distance >= radius) return 1.0;
  if (distance < 0.0) return (distance + radius) * (distance + radius);
  return 1.0 - (radius - distance) * (radius - distance);
}

/** 擦除、中分及两种十条百叶窗的区域覆盖率；透明 B 直接替换对应区域。 */
static double reveal_coverage(const Frame *frame, Size x, Size y) {
  const double width = frame->width, height = frame->height, p = frame->progress;
  if (TRANSITION_EFFECT == 6) return interval(x, 0.0, width * p);
  if (TRANSITION_EFFECT == 7) return interval(x, width * (1.0 - p), width);
  if (TRANSITION_EFFECT == 8) return interval(x, width * (1.0 - p) / 2.0, width * (1.0 + p) / 2.0);
  const double diagonal = 0.70710678118654752440;
  const double projected_height = TRANSITION_EFFECT == 5 ? (width + height) * diagonal : height;
  const double strip_height = projected_height / 10.0;
  const double position = (-(x + 0.5 - width / 2.0) + (y + 0.5 - height / 2.0)) * diagonal + projected_height / 2.0;
  double coverage = 0.0;
  for (Size strip = 0; strip < 10; strip++) {
    const double start = strip * strip_height, end = start + strip_height * p;
    coverage += TRANSITION_EFFECT == 5
        ? diagonal_area(end - position) - diagonal_area(start - position)
        : interval(y, start, end);
  }
  return unit(coverage);
}

/** 缩小帧镜像铺满后做八次放射采样；径向蒙版只控制清晰与模糊的权重。 */
static Pixel zoom_pixel(const Byte *a, const Byte *b, const Frame *frame, double x, double y) {
  const Byte *small = TRANSITION_EFFECT == 1 ? b : a;
  const Byte *large = TRANSITION_EFFECT == 1 ? a : b;
  const Pixel sharp = zoom_sample(small, frame, x, y, frame->small_scale, 1);
  const double nx = (x - frame->width / 2.0) / (frame->width / 2.0);
  const double ny = (y - frame->height / 2.0) / (frame->height / 2.0);
  const double mask = unit((__builtin_sqrt(nx * nx + ny * ny) - 0.65 * frame->small_scale) / (0.5 * frame->small_scale));
  Pixel blurred = {0.0, 0.0, 0.0, 0.0};
  if (mask > 0.0) {
    for (Size index = 0; index < 8; index++) {
      const double scale = 1.0 + frame->strength * index / 7.0;
      const double sx = frame->width / 2.0 + (x - frame->width / 2.0) / scale;
      const double sy = frame->height / 2.0 + (y - frame->height / 2.0) / scale;
      const Pixel current = zoom_sample(small, frame, sx, sy, frame->small_scale, 1);
      blurred.r += current.r / 8.0;
      blurred.g += current.g / 8.0;
      blurred.b += current.b / 8.0;
      blurred.a += current.a / 8.0;
    }
  }
  const Pixel small_pixel = mix(sharp, blurred, mask);
  const Pixel large_pixel = zoom_sample(large, frame, x, y, frame->large_scale, 0);
  return TRANSITION_EFFECT == 1 ? mix(large_pixel, small_pixel, frame->progress) : mix(small_pixel, large_pixel, frame->progress);
}

/** 初始化整帧变焦或晃动的几何量，与 Canvas 的幅度、周期和补边缩放保持一致。 */
static Frame prepare_frame(Size width, Size height, double progress) {
  Frame frame = {width, height, progress, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0};
  const double pi = 3.14159265358979323846;
  if (TRANSITION_EFFECT == 1 || TRANSITION_EFFECT == 3) {
    frame.small_scale = TRANSITION_EFFECT == 1 ? (1.0 + progress) / 2.0 : 1.0 - progress / 2.0;
    frame.large_scale = TRANSITION_EFFECT == 1 ? 1.0 + progress : 2.0 - progress;
    frame.strength = 0.04 * sine(pi * progress);
  }
  if (TRANSITION_EFFECT == 9) {
    const double envelope = sine(pi * progress);
    const double wave = sine(6.0 * pi * progress);
    frame.x = width * 0.006 * envelope * wave;
    frame.y = height * 0.004 * envelope * sine(4.0 * pi * progress);
    const double angle = (0.35 * pi / 180.0) * envelope * wave;
    frame.sine = sine(angle);
    frame.cosine = sine(pi / 2.0 + angle);
    const double scale_x = __builtin_fabs(frame.cosine) + (double)height / width * __builtin_fabs(frame.sine)
        + 2.0 * __builtin_fabs(frame.cosine * frame.x + frame.sine * frame.y) / width;
    const double scale_y = __builtin_fabs(frame.cosine) + (double)width / height * __builtin_fabs(frame.sine)
        + 2.0 * __builtin_fabs(-frame.sine * frame.x + frame.cosine * frame.y) / height;
    frame.scale = scale_x > scale_y ? scale_x : scale_y;
  }
  return frame;
}

/** 当前效果的单像素计算；编译器会移除其他效果的分支与辅助函数。 */
static Pixel render_pixel(const Byte *a, const Byte *b, const Frame *frame, Size x, Size y) {
  const Pixel outgoing = read_pixel(a, frame->width, x, y);
  const Pixel incoming = read_pixel(b, frame->width, x, y);
  if (frame->progress <= 0.0) return outgoing;
  if (frame->progress >= 1.0) return incoming;
  if (TRANSITION_EFFECT == 1 || TRANSITION_EFFECT == 3) return zoom_pixel(a, b, frame, x + 0.5, y + 0.5);
  if (TRANSITION_EFFECT == 2) {
    const Pixel black = {0.0, 0.0, 0.0, 255.0};
    return frame->progress < 0.5 ? mix(outgoing, black, frame->progress * 2.0) : mix(incoming, black, (1.0 - frame->progress) * 2.0);
  }
  if (TRANSITION_EFFECT == 9) {
    const double dx = x + 0.5 - frame->width / 2.0 - frame->x;
    const double dy = y + 0.5 - frame->height / 2.0 - frame->y;
    const double sx = (frame->cosine * dx + frame->sine * dy) / frame->scale + frame->width / 2.0 - 0.5;
    const double sy = (-frame->sine * dx + frame->cosine * dy) / frame->scale + frame->height / 2.0 - 0.5;
    return mix(sample(a, frame->width, frame->height, sx, sy), sample(b, frame->width, frame->height, sx, sy), frame->progress);
  }
  return mix(outgoing, incoming, reveal_coverage(frame, x, y));
}

/** 固定 WASM ABI：只使用调用方提供的帧缓冲，成功返回 0，无效尺寸返回 1。 */
int render(const Byte *a, const Byte *b, Byte *output, Size width, Size height,
           double progress, const Byte *params, Size params_length) {
  (void)params;
  (void)params_length;
  if (width == 0 || height == 0 || width > 0x1fffffffU / height) return 1;
  const Frame frame = prepare_frame(width, height, unit(progress));
  for (Size y = 0; y < height; y++) {
    for (Size x = 0; x < width; x++) {
      write_pixel(output + (y * width + x) * 4, render_pixel(a, b, &frame, x, y));
    }
  }
  return 0;
}
