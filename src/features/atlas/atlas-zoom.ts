import type { BoundaryFeature } from "./boundary-contract";

/** 固定概览允许 1/20 级缩放：在完整边界内尽量填满工作区，短窄地图仍可缩小。 */
export function atlasFitZoom(
  boundsWidth: number,
  boundsHeight: number,
  width: number,
  height: number
) {
  // 宽地图尽量铺满工作区；窄地图保留卡片/控件所需的外围余量。
  const padding = Math.min(width >= 620 ? 8 : 24, width / 4, height / 4);
  const scale = Math.min(
    (width - padding * 2) / Math.max(0.001, boundsWidth),
    (height - padding * 2) / Math.max(0.001, boundsHeight)
  );
  return Math.max(-8, Math.min(16, Math.floor(Math.log2(Math.max(scale, 0.001)) * 20) / 20));
}

/** 只读当前行政层全部边界；绝不接收笔记或图钉集合。 */
export function atlasBoundaryExtent(features: BoundaryFeature[]) {
  let west = Infinity,
    east = -Infinity,
    north = -Infinity,
    south = Infinity;
  for (const feature of features) {
    const points =
      feature.geometry.type === "Polygon"
        ? feature.geometry.coordinates.flat()
        : feature.geometry.coordinates.flat(2);
    for (const [lng, lat] of points) {
      west = Math.min(west, lng);
      east = Math.max(east, lng);
      north = Math.max(north, lat);
      south = Math.min(south, lat);
    }
  }
  return [west, east, north, south].every(Number.isFinite) ? { west, east, north, south } : null;
}
