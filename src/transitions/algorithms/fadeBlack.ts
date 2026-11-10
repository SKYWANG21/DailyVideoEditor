import type { TransitionAlgorithm } from "@/types/transition";

/** 前半段叠黑、后半段退黑；中点全黑，首尾保留输入透明度。 */
export const fadeBlackAlgorithm: TransitionAlgorithm = {
  render({ ctx, outgoing, incoming, width, height, progress }): void {
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.drawImage(progress < 0.5 ? outgoing : incoming, 0, 0, width, height);
    ctx.globalAlpha = 1 - Math.abs(2 * progress - 1);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
  },
};
