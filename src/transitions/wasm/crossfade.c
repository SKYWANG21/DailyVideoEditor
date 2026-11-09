/**
 * 独立 wasm32 转场内核：输入输出均为非预乘 sRGB RGBA8，无 Canvas、WASI 或 WebGL 依赖。
 * 每帧按预乘颜色混合，再反预乘输出；Q16 权重与整数舍入固定两端计算规则。
 * 参数为 UTF-8 JSON；当前淡化无需专属参数，缓动由调用方提前处理。
 */
int render(const unsigned char *a, const unsigned char *b, unsigned char *output,
           unsigned int width, unsigned int height, double progress,
           const unsigned char *params, unsigned int params_length) {
  (void)params;
  (void)params_length;
  if (!(progress >= 0.0)) progress = 0.0;
  if (progress > 1.0) progress = 1.0;
  const unsigned int weight_b = (unsigned int)(progress * 65536.0 + 0.5);
  const unsigned int weight_a = 65536 - weight_b;
  const unsigned int length = width * height * 4;
  for (unsigned int index = 0; index < length; index += 4) {
    const unsigned int alpha_a = a[index + 3] * weight_a;
    const unsigned int alpha_b = b[index + 3] * weight_b;
    const unsigned int alpha = alpha_a + alpha_b;
    output[index + 3] = (unsigned char)((alpha + 32768) >> 16);
    for (unsigned int channel = 0; channel < 3; channel++) {
      output[index + channel] = output[index + 3] == 0
          ? 0
          : (unsigned char)((a[index + channel] * alpha_a + b[index + channel] * alpha_b + alpha / 2) / alpha);
    }
  }
  return 0;
}
