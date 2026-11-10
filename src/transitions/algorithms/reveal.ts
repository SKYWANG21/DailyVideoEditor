import type { TransitionAlgorithm, TransitionRenderContext } from "@/types/transition";

/** 共用擦除与百叶窗的区域替换，防止透明入场像素透出旧画面。 */
export function createRevealAlgorithm(createPath: (context: TransitionRenderContext) => Path2D): TransitionAlgorithm {
  return {
    render(context): void {
      const { ctx, outgoing, incoming, width, height, progress } = context;
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.drawImage(progress >= 1 ? incoming : outgoing, 0, 0, width, height);
      if (progress <= 0 || progress >= 1) return;
      ctx.save();
      try {
        ctx.clip(createPath(context));
        ctx.clearRect(0, 0, width, height);
        // 加法补回裁剪覆盖率，避免抗锯齿边缘被二次 source-over 衰减。
        ctx.globalCompositeOperation = "lighter";
        ctx.drawImage(incoming, 0, 0, width, height);
      } finally {
        ctx.restore();
      }
    },
  };
}
