/**
 * 九种独立转场的共享像素内核，保持非预乘 sRGB RGBA8 ABI 与八次模糊采样。
 * 坐标按 64 列分块预计算，几何变换、双线性采样和像素格式转换均在 WASM 内完成。
 * 不使用额外堆内存；固定大小的坐标表位于栈上，不影响宿主帧缓冲。
 */
typedef unsigned char Byte;
typedef unsigned int Size;
typedef struct { double r, g, b, a; } Pixel;
typedef struct { Size first, second; double weight; } Axis;
typedef struct {
  Size width, height;
  double progress, half_width, half_height, small_scale, large_scale, strength;
  double x, y, cosine, sine, scale, inverse_small, inverse_large, blur_inverse[8];
  int opaque;
} Frame;

static double unit(double value) {
  if (!(value >= 0.0)) return 0.0;
  return value > 1.0 ? 1.0 : value;
}

/** 无 libm 的周期正弦；只在帧开始时计算。 */
static double sine(double value) {
  const double pi = 3.14159265358979323846;
  value -= __builtin_floor((value + pi) / (2.0 * pi)) * (2.0 * pi);
  const double square = value * value;
  return value * (1.0 + square * (-1.0 / 6.0 + square * (1.0 / 120.0 +
      square * (-1.0 / 5040.0 + square * (1.0 / 362880.0 +
      square * (-1.0 / 39916800.0 + square * (1.0 / 6227020800.0 +
      square * (-1.0 / 1307674368000.0 + square / 355687428096000.0))))))));
}

static Pixel mix(Pixel a, Pixel b, double weight) {
  const double other = 1.0 - weight;
  return (Pixel){a.r * other + b.r * weight, a.g * other + b.g * weight,
                 a.b * other + b.b * weight, a.a * other + b.a * weight};
}

/** 普通视频不含透明像素时，跳过反复预乘和反预乘。 */
static int is_opaque(const Byte *a, const Byte *b, Size length) {
  for (Size i = 3; i < length; i += 4) if (a[i] != 255 || b[i] != 255) return 0;
  return 1;
}

static Pixel read_pixel(const Byte *pixel, int opaque) {
  const double alpha = opaque ? 1.0 : pixel[3] / 255.0;
  return (Pixel){pixel[0] * alpha, pixel[1] * alpha, pixel[2] * alpha, opaque ? 255.0 : pixel[3]};
}

/** 保留透明颜色归零约定，完全覆盖区域可直接复制原始颜色。 */
static void copy_pixel(Byte *output, const Byte *source) {
  if (source[3] == 0) output[0] = output[1] = output[2] = output[3] = 0;
  else for (Size c = 0; c < 4; c++) output[c] = source[c];
}

static void write_pixel(Byte *output, Pixel pixel, int opaque) {
  const double alpha = opaque ? 255.0 : (pixel.a < 0.0 ? 0.0 : (pixel.a > 255.0 ? 255.0 : pixel.a));
  output[3] = (Byte)(alpha + 0.500000001);
  if (output[3] == 0) {
    output[0] = output[1] = output[2] = 0;
    return;
  }
  const double factor = opaque ? 1.0 : 255.0 / alpha;
  const double red = pixel.r * factor, green = pixel.g * factor, blue = pixel.b * factor;
  output[0] = (Byte)((red < 0.0 ? 0.0 : (red > 255.0 ? 255.0 : red)) + 0.500000001);
  output[1] = (Byte)((green < 0.0 ? 0.0 : (green > 255.0 ? 255.0 : green)) + 0.500000001);
  output[2] = (Byte)((blue < 0.0 ? 0.0 : (blue > 255.0 ? 255.0 : blue)) + 0.500000001);
}

/** 双线性采样的边缘夹取、索引和权重；缩放时按行列预计算。 */
static Axis axis(double value, Size length) {
  value = value < 0.0 ? 0.0 : (value > length - 1.0 ? length - 1.0 : value);
  const Size first = (Size)value;
  return (Axis){first, first + 1 < length ? first + 1 : first, value - first};
}

static Pixel sample_axes(const Byte *source, Size width, Axis x, Axis y, int opaque) {
  const Byte *upper = source + y.first * width * 4;
  const Byte *lower = source + y.second * width * 4;
  return mix(
      mix(read_pixel(upper + x.first * 4, opaque), read_pixel(upper + x.second * 4, opaque), x.weight),
      mix(read_pixel(lower + x.first * 4, opaque), read_pixel(lower + x.second * 4, opaque), x.weight), y.weight);
}

/** 镜像坐标铺满四边和四角，仍沿用原像素中心采样规则。 */
static Axis zoom_axis(double position, Size length, double inverse, int mirror) {
  double value = (position - length / 2.0) * inverse + length / 2.0;
  if (mirror) {
    const double period = length * 2.0;
    value -= __builtin_floor(value / period) * period;
    if (value > length) value = period - value;
  }
  return axis(value - 0.5, length);
}

static double interval(double coordinate, double start, double end) {
  const double left = coordinate > start ? coordinate : start;
  const double right = coordinate + 1.0 < end ? coordinate + 1.0 : end;
  return unit(right - left);
}

static double diagonal_area(double distance) {
  const double radius = 0.70710678118654752440;
  if (distance <= -radius) return 0.0;
  if (distance >= radius) return 1.0;
  if (distance < 0.0) return (distance + radius) * (distance + radius);
  return 1.0 - (radius - distance) * (radius - distance);
}

/** 只检查与当前像素相交的倾斜百叶；小尺寸仍允许多条相交。 */
static double coverage(const Frame *frame, Size x, Size y) {
  const double width = frame->width, height = frame->height, p = frame->progress;
  if (TRANSITION_EFFECT == 6) return interval(x, 0.0, width * p);
  if (TRANSITION_EFFECT == 7) return interval(x, width * (1.0 - p), width);
  if (TRANSITION_EFFECT == 8) return interval(x, width * (1.0 - p) / 2.0, width * (1.0 + p) / 2.0);
  const double diagonal = 0.70710678118654752440;
  const double extent = TRANSITION_EFFECT == 5 ? (width + height) * diagonal : height;
  const double strip_height = extent / 10.0;
  const double position = (-(x + 0.5 - width / 2.0) + (y + 0.5 - height / 2.0)) * diagonal + extent / 2.0;
  int first = 0, last = 9;
  if (TRANSITION_EFFECT == 5) {
    first = (int)__builtin_floor((position - diagonal) / strip_height);
    last = (int)__builtin_floor((position + diagonal) / strip_height);
    if (first < 0) first = 0;
    if (last > 9) last = 9;
  }
  double result = 0.0;
  for (int strip = first; strip <= last; strip++) {
    const double start = strip * strip_height, end = start + strip_height * p;
    result += TRANSITION_EFFECT == 5
        ? diagonal_area(end - position) - diagonal_area(start - position)
        : interval(y, start, end);
  }
  return unit(result);
}

/** 公共比例、旋转及八个模糊变换的倒数每帧只计算一次。 */
static Frame prepare_frame(Size width, Size height, double progress, int opaque) {
  Frame frame = {0};
  frame.width = width; frame.height = height; frame.progress = progress; frame.opaque = opaque;
  frame.half_width = width / 2.0; frame.half_height = height / 2.0;
  frame.small_scale = frame.large_scale = frame.scale = frame.cosine = 1.0;
  const double pi = 3.14159265358979323846;
  if (TRANSITION_EFFECT == 1 || TRANSITION_EFFECT == 3) {
    frame.small_scale = TRANSITION_EFFECT == 1 ? (1.0 + progress) / 2.0 : 1.0 - progress / 2.0;
    frame.large_scale = TRANSITION_EFFECT == 1 ? 1.0 + progress : 2.0 - progress;
    frame.strength = 0.04 * sine(pi * progress);
    frame.inverse_small = 1.0 / frame.small_scale;
    frame.inverse_large = 1.0 / frame.large_scale;
    for (Size i = 0; i < 8; i++) frame.blur_inverse[i] = 1.0 / ((1.0 + frame.strength * i / 7.0) * frame.small_scale);
  }
  if (TRANSITION_EFFECT == 9) {
    const double envelope = sine(pi * progress), wave = sine(6.0 * pi * progress);
    frame.x = width * 0.006 * envelope * wave;
    frame.y = height * 0.004 * envelope * sine(4.0 * pi * progress);
    const double angle = (0.35 * pi / 180.0) * envelope * wave;
    frame.sine = sine(angle); frame.cosine = sine(pi / 2.0 + angle);
    const double scale_x = __builtin_fabs(frame.cosine) + (double)height / width * __builtin_fabs(frame.sine)
        + 2.0 * __builtin_fabs(frame.cosine * frame.x + frame.sine * frame.y) / width;
    const double scale_y = __builtin_fabs(frame.cosine) + (double)width / height * __builtin_fabs(frame.sine)
        + 2.0 * __builtin_fabs(-frame.sine * frame.x + frame.cosine * frame.y) / height;
    frame.scale = scale_x > scale_y ? scale_x : scale_y;
  }
  return frame;
}

/** 固定 64 列坐标表约 10KB；八次模糊采样保持不变，整帧不额外分配内存。 */
static void render_zoom(const Byte *a, const Byte *b, Byte *output, const Frame *frame) {
  const Byte *small = TRANSITION_EFFECT == 1 ? b : a, *large = TRANSITION_EFFECT == 1 ? a : b;
  Axis columns[10][64], rows[10];
  double radii[64];
  for (Size start = 0; start < frame->width; start += 64) {
    const Size count = frame->width - start < 64 ? frame->width - start : 64;
    for (Size i = 0; i < count; i++) {
      const double x = start + i + 0.5;
      const double normalized = (x - frame->half_width) / frame->half_width;
      radii[i] = normalized * normalized;
      columns[0][i] = zoom_axis(x, frame->width, frame->inverse_small, 1);
      columns[1][i] = zoom_axis(x, frame->width, frame->inverse_large, 0);
      for (Size sample = 0; sample < 8; sample++) columns[sample + 2][i] = zoom_axis(x, frame->width, frame->blur_inverse[sample], 1);
    }
    for (Size y = 0; y < frame->height; y++) {
      const double center_y = y + 0.5, normalized = (center_y - frame->half_height) / frame->half_height;
      rows[0] = zoom_axis(center_y, frame->height, frame->inverse_small, 1);
      rows[1] = zoom_axis(center_y, frame->height, frame->inverse_large, 0);
      for (Size sample = 0; sample < 8; sample++) rows[sample + 2] = zoom_axis(center_y, frame->height, frame->blur_inverse[sample], 1);
      for (Size i = 0; i < count; i++) {
        const double mask = unit((__builtin_sqrt(radii[i] + normalized * normalized) - 0.65 * frame->small_scale) / (0.5 * frame->small_scale));
        Pixel pixel = {0};
        if (mask < 1.0) pixel = sample_axes(small, frame->width, columns[0][i], rows[0], frame->opaque);
        if (mask > 0.0) {
          Pixel blurred = {0};
          for (Size sample = 0; sample < 8; sample++) {
            const Pixel current = sample_axes(small, frame->width, columns[sample + 2][i], rows[sample + 2], frame->opaque);
            blurred.r += current.r / 8.0; blurred.g += current.g / 8.0;
            blurred.b += current.b / 8.0; blurred.a += current.a / 8.0;
          }
          pixel = mask == 1.0 ? blurred : mix(pixel, blurred, mask);
        }
        const Pixel other = sample_axes(large, frame->width, columns[1][i], rows[1], frame->opaque);
        pixel = TRANSITION_EFFECT == 1 ? mix(other, pixel, frame->progress) : mix(pixel, other, frame->progress);
        write_pixel(output + (y * frame->width + start + i) * 4, pixel, frame->opaque);
      }
    }
  }
}

/** 原 ABI 保持不变；端点和完全覆盖区域跳过无效混合，透明像素仍归零。 */
int render(const Byte *a, const Byte *b, Byte *output, Size width, Size height,
           double progress, const Byte *params, Size params_length) {
  (void)params; (void)params_length;
  if (width == 0 || height == 0 || width > 0x1fffffffU / height) return 1;
  progress = unit(progress);
  const Size length = width * height * 4;
  if (progress == 0.0 || progress == 1.0) {
    const Byte *source = progress == 0.0 ? a : b;
    for (Size i = 0; i < length; i += 4) copy_pixel(output + i, source + i);
    return 0;
  }
  const Frame frame = prepare_frame(width, height, progress, is_opaque(a, b, length));
  if (TRANSITION_EFFECT == 1 || TRANSITION_EFFECT == 3) {
    render_zoom(a, b, output, &frame);
    return 0;
  }
  const double inverse = 1.0 / frame.scale;
  for (Size y = 0; y < height; y++) {
    const double row_coverage = TRANSITION_EFFECT == 4 ? coverage(&frame, 0, y) : 0.0;
    for (Size x = 0; x < width; x++) {
      const Size offset = (y * width + x) * 4;
      Pixel pixel;
      if (TRANSITION_EFFECT == 2) {
        const Pixel black = {0.0, 0.0, 0.0, 255.0};
        pixel = progress < 0.5 ? mix(read_pixel(a + offset, frame.opaque), black, progress * 2.0)
                             : mix(read_pixel(b + offset, frame.opaque), black, (1.0 - progress) * 2.0);
      } else if (TRANSITION_EFFECT == 9) {
        const double dx = x + 0.5 - frame.half_width - frame.x, dy = y + 0.5 - frame.half_height - frame.y;
        const Axis sx = axis((frame.cosine * dx + frame.sine * dy) * inverse + frame.half_width - 0.5, width);
        const Axis sy = axis((-frame.sine * dx + frame.cosine * dy) * inverse + frame.half_height - 0.5, height);
        pixel = mix(sample_axes(a, width, sx, sy, frame.opaque), sample_axes(b, width, sx, sy, frame.opaque), progress);
      } else {
        const double weight = TRANSITION_EFFECT == 4 ? row_coverage : coverage(&frame, x, y);
        if (weight == 0.0 || weight == 1.0) {
          copy_pixel(output + offset, (weight == 0.0 ? a : b) + offset);
          continue;
        }
        pixel = mix(read_pixel(a + offset, frame.opaque), read_pixel(b + offset, frame.opaque), weight);
      }
      write_pixel(output + offset, pixel, frame.opaque);
    }
  }
  return 0;
}
