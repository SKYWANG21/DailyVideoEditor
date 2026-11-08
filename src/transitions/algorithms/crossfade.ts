import type { TransitionAlgorithm } from "@/types/transition";

/** 预乘颜色和透明度的线性加权，避免 source-over 重复衰减导致中点变暗。 */
export const crossfadeAlgorithm: TransitionAlgorithm = {
  render({ ctx, outgoing, incoming, width, height, progress }): void {
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1 - progress;
    ctx.drawImage(outgoing, 0, 0, width, height);
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = progress;
    ctx.drawImage(incoming, 0, 0, width, height);
  },
};
