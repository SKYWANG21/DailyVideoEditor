import type { TransitionAlgorithm, TransitionRenderContext } from "@/types/transition";

/** 居中缩放后按预乘颜色加权，供淡化、变焦与晃动共用。 */
export function renderCrossfade(context: TransitionRenderContext, outgoingScale: number = 1, incomingScale: number = 1): void {
  const { ctx, outgoing, incoming, width, height, progress } = context;
  const outgoingWidth = width * outgoingScale;
  const outgoingHeight = height * outgoingScale;
  const incomingWidth = width * incomingScale;
  const incomingHeight = height * incomingScale;
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1 - progress;
  ctx.drawImage(outgoing, (width - outgoingWidth) / 2, (height - outgoingHeight) / 2, outgoingWidth, outgoingHeight);
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = progress;
  ctx.drawImage(incoming, (width - incomingWidth) / 2, (height - incomingHeight) / 2, incomingWidth, incomingHeight);
}

/** 预乘颜色和透明度的线性加权，避免 source-over 重复衰减导致中点变暗。 */
export const crossfadeAlgorithm: TransitionAlgorithm = {
  render(context): void {
    renderCrossfade(context);
  },
};
