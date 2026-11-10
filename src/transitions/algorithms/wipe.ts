import { createRevealAlgorithm } from "./reveal";

/** 入场画面从左边缘向右覆盖。 */
export const wipeRightAlgorithm = createRevealAlgorithm(({ width, height, progress }): Path2D => {
  const path = new Path2D();
  path.rect(0, 0, width * progress, height);
  return path;
});

/** 入场画面从右边缘向左覆盖。 */
export const wipeLeftAlgorithm = createRevealAlgorithm(({ width, height, progress }): Path2D => {
  const path = new Path2D();
  path.rect(width * (1 - progress), 0, width * progress, height);
  return path;
});

/** 入场画面从竖直中线向两侧对称展开。 */
export const splitOpenAlgorithm = createRevealAlgorithm(({ width, height, progress }): Path2D => {
  const path = new Path2D();
  path.rect((width * (1 - progress)) / 2, 0, width * progress, height);
  return path;
});
