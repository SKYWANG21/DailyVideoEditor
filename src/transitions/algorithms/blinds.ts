import type { TransitionRenderContext } from "@/types/transition";
import { createRevealAlgorithm } from "./reveal";

/** 在旋转后的画布投影内等分十条百叶，保证倾斜时四角也被覆盖。 */
function blindsPath({ width, height, progress }: TransitionRenderContext, angle: number): Path2D {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const projectedWidth = width * Math.abs(cos) + height * Math.abs(sin);
  const projectedHeight = width * Math.abs(sin) + height * Math.abs(cos);
  const stripHeight = projectedHeight / 10;
  const strips = new Path2D();
  for (let index = 0; index < 10; index += 1) {
    strips.rect(-projectedWidth / 2, -projectedHeight / 2 + index * stripHeight, projectedWidth, stripHeight * progress);
  }
  const path = new Path2D();
  path.addPath(strips, new DOMMatrix([cos, sin, -sin, cos, width / 2, height / 2]));
  return path;
}

/** 水平百叶窗：每条从上向下展开。 */
export const blindsAlgorithm = createRevealAlgorithm((context): Path2D => blindsPath(context, 0));

/** 倾斜百叶窗：水平条带旋转 45°，沿条带法线展开。 */
export const diagonalBlindsAlgorithm = createRevealAlgorithm((context): Path2D => blindsPath(context, Math.PI / 4));
