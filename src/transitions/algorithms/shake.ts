import type { TransitionAlgorithm } from "@/types/transition";
import { renderCrossfade } from "./crossfade";

/** 交叉淡化叠加确定性轻晃，自动放大以覆盖位移和旋转暴露的边缘。 */
export const shakeAlgorithm: TransitionAlgorithm = {
  render(context): void {
    const { ctx, width, height, progress } = context;
    if (progress <= 0 || progress >= 1) {
      renderCrossfade(context);
      return;
    }
    const envelope = Math.sin(Math.PI * progress);
    const phase = 2 * Math.PI * progress;
    const x = width * 0.006 * envelope * Math.sin(3 * phase);
    const y = height * 0.004 * envelope * Math.sin(2 * phase);
    const angle = ((0.35 * Math.PI) / 180) * envelope * Math.sin(3 * phase);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // 将画布四角逆旋转至素材坐标，计算覆盖全部角点的最小放大倍数。
    const scale = Math.max(
      Math.abs(cos) + (height / width) * Math.abs(sin) + (2 * Math.abs(cos * x + sin * y)) / width,
      Math.abs(cos) + (width / height) * Math.abs(sin) + (2 * Math.abs(-sin * x + cos * y)) / height,
    );
    ctx.save();
    try {
      ctx.translate(width / 2 + x, height / 2 + y);
      ctx.rotate(angle);
      ctx.scale(scale, scale);
      ctx.translate(-width / 2, -height / 2);
      renderCrossfade(context);
    } finally {
      ctx.restore();
    }
  },
};
