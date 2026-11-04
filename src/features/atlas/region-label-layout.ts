/**
 * 地图标签的**纯函数**布局（016）。
 *
 * 只做几何计算：把“一个地区一条名称”的候选按面积从大到小排布，
 * 让名称落在面内部（首选最大环的内心，退化到质心），并避开彼此重叠、
 * 不越出可视区。不引入 Leaflet、不读存储、不写任何状态，便于单元测试。
 *
 * 为什么不用“第一个坐标”：多面/带环的边界里首点常在外海或环起点，
 * 标签会飞出该地区之外（岛屿、窄条、飞地尤其明显）。
 */

/** GeoJSON 面/多面的最小几何形状（只读）。 */
export type LabelGeometry = {
  type?: string;
  coordinates?: unknown;
  geometry?: LabelGeometry | null;
};

export type LabelFeature = {
  regionId: string;
  name: string;
  geometry: LabelGeometry | null | undefined;
  /**
   * 可选的锚点微调（度）。只用于**标签避让**：真实边界与业务身份都不变。
   * 典型场景是香港/澳门这类相距不到 8 像素的相邻小地区——
   * 两个锚点会完全重叠，必须有一个挪到邻近水面才能同时读到名称。
   */
  anchorOffset?: [number, number];
};

export type LabelPlacement = {
  regionId: string;
  /** 标签锚点（经纬度）。 */
  anchor: [number, number];
  /** 该地区最大环的面积（度²，仅用于排序与筛选，不冒充真实面积）。 */
  area: number;
};

export type PlaceLabelsOptions = {
  /** 标签锚点（经纬度）→ 像素坐标（与 viewport 同一尺度）。 */
  project: (anchor: [number, number]) => [number, number];
  /** 当前视口的像素宽度。 */
  viewportWidth: number;
  /** 当前视口的像素高度。 */
  viewportHeight: number;
  /** 一个标签在屏幕上的宽度（CSS 像素）。 */
  labelWidth: number;
  /** 一个标签在屏幕上的高度（CSS 像素）。 */
  labelHeight: number;
  /** 标签外扩留白（像素）；缺省按标签高度的 1/4 估算。 */
  gap?: number;
  /**
   * 地理面积下限（度²）：小于它的地区不做标签排布。
   * 判定在屏幕上进行，因此需要 `pixelsPerDegree²` 把地理面积换算成像素面积。
   */
  minArea?: number;
  /** 当前缩放下的“每度像素数”。缺省 1（只影响 minArea 判定）。 */
  pixelsPerDegree?: number;
  /** 最多展示多少个标签（防止小屏幕上铺满）。 */
  maxLabels?: number;
};

export type PlaceLabelsResult = {
  /** 能放下标签的地区（面积从大到小）。 */
  placed: LabelPlacement[];
  /** 放不下/过小的地区 regionId：调用方应用标签栏列出，不能静默消失。 */
  overflowRegionIds: string[];
};

/** 取最大环的经纬度点列；Points/LineString 等非面几何返回空。 */
export function largestRing(geometry: LabelGeometry | null | undefined): [number, number][] {
  const shape = geometry?.geometry ?? geometry;
  const type = shape?.type;
  const coordinates = shape?.coordinates;
  if (!coordinates || (type !== "Polygon" && type !== "MultiPolygon")) return [];

  const polygons: unknown[] = type === "Polygon" ? [coordinates] : (coordinates as unknown[]);
  let best: [number, number][] = [];
  let bestArea = -1;
  for (const polygon of polygons) {
    const rings = Array.isArray(polygon) ? (polygon as unknown[]) : [];
    const outer = rings[0];
    if (!Array.isArray(outer)) continue;
    const ring = outer.filter(isPosition);
    const area = Math.abs(ringArea(ring));
    if (area > bestArea) {
      bestArea = area;
      best = ring;
    }
  }
  return best;
}

/** 面的外环面积（度²，鞋带公式；仅用于排序/筛选）。 */
export function ringArea(ring: [number, number][]): number {
  if (ring.length < 3) return 0;
  let sum = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[(index + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

export function largestRingArea(geometry: LabelGeometry | null | undefined): number {
  return Math.abs(ringArea(largestRing(geometry)));
}

/** 卡面与地图标签使用短地名；完整行政区名称仍保留在数据和可访问名称里。 */
export function shortRegionName(name: string): string {
  return name.replace(/维吾尔自治区|回族自治区|壮族自治区|特别行政区|自治区|省$|市$/g, "");
}

/**
 * 标签锚点：
 * 1. 首选最大环的**内心**（保证落在面内，避免质心落在凹形之外）；
 * 2. 内心不可用时退回环的包围盒中心，再退回点列平均。
 */
export function labelAnchor(geometry: LabelGeometry | null | undefined): [number, number] | null {
  const ring = largestRing(geometry);
  if (ring.length === 0) return null;
  const shape = geometry?.geometry ?? geometry;
  const polygons = shape?.type === "Polygon" ? [shape.coordinates] : shape?.coordinates;
  const polygon = Array.isArray(polygons)
    ? polygons.find(
        (candidate) =>
          Array.isArray(candidate) &&
          Array.isArray(candidate[0]) &&
          candidate[0].some((point) => point === ring[0])
      )
    : undefined;
  const holes: [number, number][][] = Array.isArray(polygon)
    ? polygon
        .slice(1)
        .filter(Array.isArray)
        .map((hole) => hole.filter(isPosition))
    : [];
  const interior = interiorPoint(ring, holes);
  if (interior) return interior;
  const bounds = ringBounds(ring);
  if (bounds) {
    return [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
  }
  let x = 0;
  let y = 0;
  for (const [px, py] of ring) {
    x += px;
    y += py;
  }
  return [x / ring.length, y / ring.length];
}

/** [minLng, minLat, maxLng, maxLat]。 */
export function ringBounds(ring: [number, number][]): [number, number, number, number] | null {
  if (ring.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/** 射线法：点是否在外环内（边界算内）。 */
export function pointInRing(point: [number, number], ring: [number, number][]): boolean {
  const [x, y] = point;
  // 退化段（重复点，例如闭合环的首尾）不构成边，也不参与射线计数。
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (xi === xj && yi === yj) continue;
    if (pointOnSegment(point, ring[i], ring[j])) return true;
    // 上界也算内：否则正好落在顶点/上边上的锚点会被判成“在外面”。
    const intersects = yi > y !== yj > y && x <= ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointOnSegment(
  point: [number, number],
  a: [number, number],
  b: [number, number]
): boolean {
  const cross = (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
  if (Math.abs(cross) > 1e-12) return false;
  const dot = (point[0] - a[0]) * (b[0] - a[0]) + (point[1] - a[1]) * (b[1] - a[1]);
  if (dot < 0) return false;
  const squared = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  return dot <= squared;
}

/**
 * 面内的一个点：在环内部按扫描线取“最宽处的中点”。
 * 比质心更可靠（质心可能落在凹形之外，例如带海湾的沿海城市）。
 */
function interiorPoint(
  ring: [number, number][],
  holes: [number, number][][] = []
): [number, number] | null {
  if (ring.length < 3) return null;
  const bounds = ringBounds(ring);
  if (!bounds) return null;
  const [minX, minY, maxX, maxY] = bounds;
  const height = maxY - minY;
  if (height <= 0) return null;
  let nextY = maxY;
  for (const outline of [ring, ...holes])
    for (const [, y] of outline) if (y > minY) nextY = Math.min(nextY, y);
  const scanLines = [0.5, 0.38, 0.62, 0.28, 0.72, 0.18, 0.82].map((ratio) => minY + height * ratio);
  // 极窄的外缘也保留一个有效扫描带；不把图钉退回内环中的包围盒中心。
  scanLines.push((minY + nextY) / 2);
  for (const y of scanLines) {
    const crossings: number[] = [];
    for (const outline of [ring, ...holes])
      for (let i = 0, j = outline.length - 1; i < outline.length; j = i, i += 1) {
        const [xi, yi] = outline[i];
        const [xj, yj] = outline[j];
        if (yi > y !== yj > y) {
          if (yj === yi) continue;
          crossings.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
        }
      }
    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a - b);
    // 取最宽的内部区间中点：跨度为奇数时（顶点穿过）仍取最宽的一对。
    let bestMid: number | null = null;
    let bestWidth = 0;
    for (let index = 0; index + 1 < crossings.length; index += 2) {
      const width = crossings[index + 1] - crossings[index];
      if (width > bestWidth) {
        bestWidth = width;
        bestMid = (crossings[index] + crossings[index + 1]) / 2;
      }
    }
    if (bestMid !== null && bestWidth > 0) {
      const point: [number, number] = [bestMid, y];
      if (pointInRing(point, ring) && !holes.some((hole) => pointInRing(point, hole))) return point;
    }
  }
  return null;
}

type Box = { left: number; right: number; bottom: number; top: number };

function boxesOverlap(a: Box, b: Box, gap: number): boolean {
  return !(
    a.right + gap < b.left ||
    b.right + gap < a.left ||
    a.top + gap < b.bottom ||
    b.top + gap < a.bottom
  );
}

/**
 * 排布标签：面积从大到小，逐个检查“是否整块落在可视区内且不与已放置标签重叠”。
 * 一个地区最多一条标签；放不下的地区返回 overflowRegionIds，由标签栏兜底。
 *
 * 注意：碰撞与边界都在**像素**尺度判断（标签尺寸是屏幕像素），
 * 只有 minArea 这个地理阈值会按 pixelsPerDegree 换算，避免重复缩放。
 */
export function placeRegionLabels(
  features: LabelFeature[],
  options: PlaceLabelsOptions
): PlaceLabelsResult {
  const {
    project,
    viewportWidth,
    viewportHeight,
    labelWidth,
    labelHeight,
    /**
     * 允许轻微重叠（默认约 45% 标签高度）：全国视野下 34 个省名要尽量都读到，
     * 完全互斥会把 19 个较小地区全部挤到侧栏。真实坐标与选择不受影响。
     */
    gap = -labelHeight * 0.45,
    minArea = 0,
    pixelsPerDegree = 1,
    maxLabels = Number.POSITIVE_INFINITY
  } = options;

  // 全部在**像素**尺度上排布；地理面积只用于“太小就不放标签”的判定。
  const halfWidth = labelWidth / 2;
  const halfHeight = labelHeight / 2;
  const minPixelArea = minArea * pixelsPerDegree ** 2;

  const candidates = features
    .map((feature) => {
      const ring = largestRing(feature.geometry);
      const area = Math.abs(ringArea(ring));
      if (ring.length < 3 || !Number.isFinite(area) || area <= 0) return null;
      const base = labelAnchor(feature.geometry);
      // 退化几何（空环、共线、坐标非数）绝不能把 NaN 传给地图：Leaflet 会抛
      // “Invalid LatLng object: (NaN, NaN)”，这里直接当成放不下。
      if (!base || !Number.isFinite(base[0]) || !Number.isFinite(base[1])) return null;
      const anchor: [number, number] = feature.anchorOffset
        ? [base[0] + feature.anchorOffset[0], base[1] + feature.anchorOffset[1]]
        : base;
      return { regionId: feature.regionId, name: feature.name, anchor, area };
    })
    .filter(
      (
        item
      ): item is {
        regionId: string;
        name: string;
        anchor: [number, number];
        area: number;
      } => item !== null
    )
    /**
     * 019：**小地区优先**排布。若按面积从大到小，全国视野下新疆/内蒙古等
     * 大省先把空间占满，澳门/香港这类小地区永远落到侧栏。
     * 从最小的开始放，保证相邻小地区（港澳相距不到 8 像素）先各占一个位置，
     * 大省再在外围避让。
     */
    .sort((a, b) => a.area - b.area);

  const placed: LabelPlacement[] = [];
  const overflowRegionIds: string[] = [];
  const boxes: Box[] = [];

  for (const candidate of candidates) {
    if (placed.length >= maxLabels) {
      overflowRegionIds.push(candidate.regionId);
      continue;
    }
    if (candidate.area * pixelsPerDegree ** 2 < minPixelArea) {
      overflowRegionIds.push(candidate.regionId);
      continue;
    }
    const [px, py] = project(candidate.anchor);
    // 偏移换算回经纬度用的比例尺（度 → 像素在视口尺度下近似为常数）。
    const scale = options.pixelsPerDegree ?? 1;
    const [lng, lat] = candidate.anchor;
    const offsets: [number, number][] = [
      [0, 0],
      [0, labelHeight * 1.4],
      [0, -labelHeight * 1.4],
      [-labelWidth * 1.2, 0],
      [labelWidth * 1.2, 0],
      [labelWidth * 1.2, labelHeight * 1.4],
      [-labelWidth * 1.2, labelHeight * 1.4],
      // 相邻小地区（港澳）需要再挪一行才能真正分开，仍然只挪标签。
      [0, labelHeight * 2.8],
      [labelWidth * 1.2, labelHeight * 2.8]
    ];
    let chosen: { box: Box; anchor: [number, number] } | null = null;
    for (const [offsetX, offsetY] of offsets) {
      const box: Box = {
        left: px + offsetX - halfWidth,
        right: px + offsetX + halfWidth,
        bottom: py + offsetY - halfHeight,
        top: py + offsetY + halfHeight
      };
      const outside =
        box.left < 0 || box.bottom < 0 || box.right > viewportWidth || box.top > viewportHeight;
      if (outside) continue;
      if (boxes.some((other) => boxesOverlap(box, other, gap))) continue;
      /**
       * 019：相邻小地区（例如香港与澳门，默认视野只差约 8 像素）**优先平移标签**，
       * 而不是直接丢进侧栏。偏移来自固定候选序列，可复现，也不改真实坐标。
       */
      chosen = { box, anchor: [lng + offsetX / scale, lat + offsetY / scale] };
      break;
    }
    if (!chosen) {
      overflowRegionIds.push(candidate.regionId);
      continue;
    }
    boxes.push(chosen.box);
    placed.push({ ...candidate, anchor: chosen.anchor });
  }

  return { placed, overflowRegionIds };
}

function isPosition(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  );
}
