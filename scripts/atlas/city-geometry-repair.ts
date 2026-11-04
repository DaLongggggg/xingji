/**
 * 019 城市轮廓修复决策（纯函数，供 prepare-atlas.mjs 与 019 审计脚本共用）。
 *
 * 背景：`shape-only` 与 `shape-with-internal-borders` 是两套独立衍生素材，
 * 个别城市的 shape-only 只覆盖到县面集合的一部分（实测 9 个城市）。
 * 这类空洞不能用填色/凸包/包围盒掩盖；判定也不能只看面积和：
 * 等面积移位、重复重叠、多 feature 都会让“面积相等”骗过判定。
 *
 * 因此这里的判定顺序是：
 * 1. **空间证据优先**：在固定网格上采样（bbox 预筛 + even-odd 面内判定），
 *    同时统计“只在城市”“只在县面集合”“两者都有”的采样点。
 * 2. **面积只作辅助**：记录双方面积与相对差，用于报告，不单独决定替换。
 * 3. **明确三分类**：
 *    - `aligned`：空间采样没有发现缺口/重叠，保留原城市轮廓；
 *    - `incomplete`：城市明显缺块（且县面集合是它的超集）→ 用县面集合重建；
 *    - `overlap` / `unreliable`：出现“只在城市”的明显面积（可能坐标偏移、
 *      等面积移位或多 feature 重叠）→ **不自动替换**，列为待处理。
 *
 * 采样只能证伪不能证全：报告必须写清步长，不得用“采样未发现差异”声称完整。
 */
import { geometryArea, normalizeFeatureCollection } from "./geometry-normalize.ts";
import type { NormalizeGeometry } from "./geometry-normalize.ts";

/** 允许的“只在城市”采样点占城市采样点的比例（边界/四舍五入容忍）。 */
export const CITY_ONLY_TOLERANCE = 0.06;
/** 允许的“只在县面”采样点占县面采样点的比例（超过即视为缺块）。 */
export const COUNTY_ONLY_THRESHOLD = 0.02;
/** 采样网格步长（度）。约 2.2 km，误差远小于一个区县，同时让全国 392 市可在秒级完成。 */
export const COVERAGE_SAMPLE_STEP = 0.02;

export type PolygonCoordinates = [number, number][][];
export type NormalizedFeature = {
  type?: string;
  properties?: Record<string, unknown>;
  geometry: NormalizeGeometry;
};
export type CountyCollection = { features: NormalizedFeature[] } | null | undefined;

export type RepairDecision = {
  /** 是否自动用县面集合重建。 */
  repair: boolean;
  /** aligned | incomplete | overlap | unavailable。 */
  classification: "aligned" | "incomplete" | "overlap" | "unavailable";
  /** 是否必须由人工/Astra 决定（不自动覆盖）。 */
  pendingReview: boolean;
  reason: string;
  cityArea: number;
  countyArea: number;
  /** 面积口径：城市面积相对县面集合的差（county-city）/city 的百分比。 */
  areaGainPercent: number;
  sampleStep: number;
  samples: { city: number; both: number; cityOnly: number; countyOnly: number };
  cityOnlyShare: number;
  countyOnlyShare: number;
  /**
   * 完全不被县面集合覆盖、且**尺寸足够**的城市部件（含小岛/飞地）。
   * 只要有一个，就不能自动替换：替换会丢掉真实区域，必须列待处理。
   */
  uncoveredComponents: number;
  /**
   * 完全不被覆盖、但小到 0.01° 以下的碎屑部件数（例如 0.001° 的礁石/碎岛）。
   * 这些是源层面的极小微元，单独计数、不阻塞自动修复，也不静默丢弃。
   */
  tinyUncoveredComponents: number;
};

function listPolygons(geometry: NormalizeGeometry | null | undefined): PolygonCoordinates[] {
  if (!geometry || typeof geometry !== "object") return [];
  if (geometry.type === "Polygon") return [geometry.coordinates as PolygonCoordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates as PolygonCoordinates[];
  return [];
}

/** 把一组 feature 的**全部**多边形合成一个 MultiPolygon（保留所有部件）。 */
export function mergeFeatureGeometries(features: NormalizedFeature[]): NormalizeGeometry | null {
  const coordinates: PolygonCoordinates[] = [];
  for (const feature of features) coordinates.push(...listPolygons(feature.geometry));
  if (coordinates.length === 0) return null;
  if (coordinates.length === 1) return { type: "Polygon", coordinates: coordinates[0] };
  return { type: "MultiPolygon", coordinates };
}

function pointInRing(point: [number, number], ring: [number, number][]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x <= ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 环内的一个确定点：按扫描线取最宽内部区间的中点（凸/凹环都适用）。 */
function interiorPointOfRing(ring: [number, number][]): [number, number] | null {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [, y] of ring) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  for (const ratio of [0.5, 0.35, 0.65, 0.2, 0.8]) {
    const y = minY + (maxY - minY) * ratio;
    const crossings: number[] = [];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y) crossings.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
    }
    if (crossings.length < 2) continue;
    crossings.sort((a, b) => a - b);
    let bestMid: number | null = null;
    let bestWidth = 0;
    for (let index = 0; index + 1 < crossings.length; index += 2) {
      const width = crossings[index + 1] - crossings[index];
      if (width > bestWidth) {
        bestWidth = width;
        bestMid = (crossings[index] + crossings[index + 1]) / 2;
      }
    }
    if (bestMid !== null && bestWidth > 0) return [bestMid, y];
  }
  return null;
}

type PreparedPolygon = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  polygon: PolygonCoordinates;
};

function preparePolygons(geometries: NormalizeGeometry[]): PreparedPolygon[] {
  const prepared: PreparedPolygon[] = [];
  for (const geometry of geometries) {
    for (const polygon of listPolygons(geometry)) {
      if (!polygon.length) continue;
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const [x, y] of polygon[0]) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      prepared.push({ minX, minY, maxX, maxY, polygon });
    }
  }
  return prepared;
}

/**
 * 空间索引：按固定格子把多边形的 bbox 分桶，避免每个采样点都扫全部多边形
 * （全国 392 市 × 上万顶点的朴素循环会跑到分钟级）。
 */
const INDEX_CELL = 0.25;

function buildIndex(prepared: PreparedPolygon[]): Map<string, PreparedPolygon[]> {
  const index = new Map<string, PreparedPolygon[]>();
  for (const item of prepared) {
    const minCellX = Math.floor(item.minX / INDEX_CELL);
    const maxCellX = Math.floor(item.maxX / INDEX_CELL);
    const minCellY = Math.floor(item.minY / INDEX_CELL);
    const maxCellY = Math.floor(item.maxY / INDEX_CELL);
    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
      for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
        const key = `${cellX},${cellY}`;
        const bucket = index.get(key);
        if (bucket) bucket.push(item);
        else index.set(key, [item]);
      }
    }
  }
  return index;
}

function containsPoint(point: [number, number], index: Map<string, PreparedPolygon[]>): boolean {
  const bucket = index.get(
    `${Math.floor(point[0] / INDEX_CELL)},${Math.floor(point[1] / INDEX_CELL)}`
  );
  if (!bucket) return false;
  for (const item of bucket) {
    const [outer, ...holes] = item.polygon;
    if (!pointInRing(point, outer)) continue;
    if (holes.some((hole) => pointInRing(point, hole))) continue;
    return true;
  }
  return false;
}

/** 在固定网格上比较两套几何的空间覆盖。步长固定、无随机，可复现。 */
export function sampleCoverage(
  cityGeometries: NormalizeGeometry[],
  countyGeometries: NormalizeGeometry[],
  step = COVERAGE_SAMPLE_STEP
): { samples: { city: number; both: number; cityOnly: number; countyOnly: number }; step: number } {
  const cityPrepared = preparePolygons(cityGeometries);
  const countyPrepared = preparePolygons(countyGeometries);
  const cityIndex = buildIndex(cityPrepared);
  const countyIndex = buildIndex(countyPrepared);
  const everything = [...cityPrepared, ...countyPrepared];
  if (everything.length === 0) {
    return { samples: { city: 0, both: 0, cityOnly: 0, countyOnly: 0 }, step };
  }
  /**
   * 只遍历各多边形 bbox 的并集（而不是整体外接矩形），否则像塔城地区这种
   * 狭长形状会把大量采样点浪费在空白上，全国 392 市会跑到分钟级。
   * 采样点取格心，避免正好压在共享边界上造成假差异。
   */
  const samples = { city: 0, both: 0, cityOnly: 0, countyOnly: 0 };
  const visited = new Set<string>();
  for (const item of everything) {
    for (let x = item.minX + step / 2; x <= item.maxX; x += step) {
      for (let y = item.minY + step / 2; y <= item.maxY; y += step) {
        const key = `${Math.round(x / step)},${Math.round(y / step)}`;
        if (visited.has(key)) continue;
        visited.add(key);
        const point: [number, number] = [x, y];
        const inCity = containsPoint(point, cityIndex);
        const inCounty = containsPoint(point, countyIndex);
        if (inCity) samples.city += 1;
        if (inCity && inCounty) samples.both += 1;
        else if (inCity) samples.cityOnly += 1;
        else if (inCounty) samples.countyOnly += 1;
      }
    }
  }
  return { samples, step };
}

/**
 * 判断城市是否需要修复（空间证据优先 + 面积辅助）。
 * @param shapeOnlyFeatures shape-only 城市的**全部** feature（多 feature 也参与）
 * @param countyCollection 规范化后的县面集合
 */
export function decideCityRepair(
  shapeOnlyFeatures: NormalizedFeature[] | null | undefined,
  countyCollection: CountyCollection,
  options: { step?: number } = {}
): RepairDecision {
  const cityFeatures = Array.isArray(shapeOnlyFeatures) ? shapeOnlyFeatures : [];
  const countyFeatures = countyCollection?.features ?? [];
  const cityArea = cityFeatures.reduce((sum, feature) => sum + geometryArea(feature.geometry), 0);
  const countyArea = countyFeatures.reduce(
    (sum, feature) => sum + geometryArea(feature.geometry),
    0
  );
  const areaGainPercent = cityArea > 0 ? ((countyArea - cityArea) / cityArea) * 100 : 0;
  const step = options.step ?? COVERAGE_SAMPLE_STEP;
  const empty = {
    cityArea,
    countyArea,
    areaGainPercent,
    sampleStep: step,
    samples: { city: 0, both: 0, cityOnly: 0, countyOnly: 0 },
    cityOnlyShare: 0,
    countyOnlyShare: 0,
    uncoveredComponents: 0,
    tinyUncoveredComponents: 0
  };

  if (cityFeatures.length === 0 || cityArea <= 0) {
    return {
      ...empty,
      repair: countyFeatures.length > 0,
      classification: countyFeatures.length > 0 ? "incomplete" : "unavailable",
      pendingReview: countyFeatures.length === 0,
      reason:
        countyFeatures.length > 0 ? "城市轮廓不可用，改由县面集合重建" : "城市与县面集合都不可用"
    };
  }
  if (countyFeatures.length === 0) {
    return {
      ...empty,
      repair: false,
      classification: "unavailable",
      pendingReview: true,
      reason: "没有同源带内部边界素材，无法判断完整性"
    };
  }

  /**
   * 采样步长按**城市自身的尺寸**自适应：大市（盟/地区这种几度到十几度的）用粗一档，
   * 保证全国 392 市能在秒级完成；小市保持 0.02°（约 2.2 km），远小于一个区县。
   * 容差随步长等比放大，避免“城市越小、边界格越显眼”的系统偏差。
   */
  const extent = cityFeatures.reduce((max, feature) => {
    for (const polygon of listPolygons(feature.geometry)) {
      for (const [x, y] of polygon[0]) {
        const dx = Math.abs(x);
        const dy = Math.abs(y);
        if (dx > max) max = dx;
        if (dy > max) max = dy;
      }
    }
    return max;
  }, 0);
  const adaptiveStep = step * (extent > 8 ? 4 : extent > 4 ? 3 : extent > 2 ? 2 : 1);
  const sampled = sampleCoverage(
    cityFeatures.map((feature) => feature.geometry),
    countyFeatures.map((feature) => feature.geometry),
    adaptiveStep
  );
  const cityOnlyShare =
    sampled.samples.city > 0 ? sampled.samples.cityOnly / sampled.samples.city : 0;
  const countyBase = sampled.samples.cityOnly + sampled.samples.both;
  const countyOnlyShare = countyBase > 0 ? sampled.samples.countyOnly / countyBase : 0;
  const scale = sampled.step / step;
  const cityOnlyTolerance = CITY_ONLY_TOLERANCE * scale;
  const countyOnlyThreshold = COUNTY_ONLY_THRESHOLD * scale;
  /**
   * 部件级检查（确定性，不依赖采样步长）：逐个城市部件（含小岛）取一个**内部点**，
   * 看它是否落在县面集合里。任何一个部件整块缺失都会被抓到——
   * 只看整体面积和会漏掉小岛，粗网格采样也会在小岛上取不到点。
   */
  const countyPrepared = countyFeatures.flatMap((feature) => preparePolygons([feature.geometry]));
  let uncoveredComponents = 0;
  let tinyUncoveredComponents = 0;
  for (const feature of cityFeatures) {
    for (const polygon of listPolygons(feature.geometry)) {
      if (!polygon.length) continue;
      const point = interiorPointOfRing(polygon[0]);
      if (!point) continue; // 退化环不参与“部件缺失”判定
      const inCounty = countyPrepared.some((item) => {
        if (
          point[0] < item.minX ||
          point[0] > item.maxX ||
          point[1] < item.minY ||
          point[1] > item.maxY
        )
          return false;
        const [outer, ...holes] = item.polygon;
        if (!pointInRing(point, outer)) return false;
        return !holes.some((hole) => pointInRing(point, hole));
      });
      if (inCounty) continue;
      // 极小微元（礁石级碎岛）单独计数：它们是源本身的碎屑，
      // 既不能因此阻塞修复，也不能被忽略不记。
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const [x, y] of polygon[0]) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      if (maxX - minX < 0.01 && maxY - minY < 0.01) tinyUncoveredComponents += 1;
      else uncoveredComponents += 1;
    }
  }
  const withSamples = {
    cityArea,
    countyArea,
    areaGainPercent,
    sampleStep: sampled.step,
    samples: sampled.samples,
    cityOnlyShare,
    countyOnlyShare,
    uncoveredComponents,
    tinyUncoveredComponents
  };

  // 有城市部件（岛屿/飞地）完全不被县面集合覆盖：替换会丢真实区域 → 待处理。
  if (uncoveredComponents > 0) {
    return {
      ...withSamples,
      repair: false,
      classification: "overlap",
      pendingReview: true,
      reason: `有 ${uncoveredComponents} 个城市部件（岛屿/飞地）不在县面集合内，替换会丢区域，不自动覆盖`
    };
  }
  // 明显的“只在城市”面积：坐标偏移/等面积移位/多 feature 重叠都可能，不自动覆盖。
  if (cityOnlyShare > cityOnlyTolerance) {
    return {
      ...withSamples,
      repair: false,
      classification: "overlap",
      pendingReview: true,
      reason: `采样发现 ${(cityOnlyShare * 100).toFixed(2)}% 的城市采样点不在县面集合内（可能坐标偏移/重叠），不自动替换`
    };
  }
  // 城市是县面集合的真超集（县面缺块）→ 重建。
  if (countyOnlyShare > countyOnlyThreshold) {
    return {
      ...withSamples,
      repair: true,
      classification: "incomplete",
      pendingReview: false,
      reason: `县面集合比城市多覆盖 ${(countyOnlyShare * 100).toFixed(2)}% 的采样点（城市缺块），按县面集合重建`
    };
  }
  return {
    ...withSamples,
    repair: false,
    classification: "aligned",
    pendingReview: false,
    reason:
      countyOnlyShare > 0 || cityOnlyShare > 0
        ? `空间差异在容忍范围内（城市独有 ${(cityOnlyShare * 100).toFixed(
            2
          )}%、县面独有 ${(countyOnlyShare * 100).toFixed(2)}%），保留原城市轮廓`
        : `该步长（${sampled.step}°）下未发现空间差异，保留原城市轮廓`
  };
}

/** 读原始素材（只读）并返回规范化后的县面集合；文件不存在返回 null。 */
export function readNormalizedCountyCollection(
  readFileSyncImpl: (path: string, encoding: "utf8") => string,
  sourcePath: string
): ReturnType<typeof normalizeFeatureCollection> {
  const data = JSON.parse(readFileSyncImpl(sourcePath, "utf8"));
  return normalizeFeatureCollection(data, sourcePath.split("/").pop() ?? sourcePath);
}
