/**
 * 照片位置 → 地区匹配（M1.5）：GPS 点与行政区边界的命中测试。
 *
 * 纯函数、零依赖：复用既有边界数据包（按需 fetch 后传入几何），用
 * region-label-layout 的射线法做点在面内判定；几何由调用方提供，
 * 本模块不发起请求、不写任何存储。
 *
 * 语义边界（方案 §10bis）：
 * - 结果是**候选**：坐标基准可能不匹配（EXIF 为 WGS-84，底图坐标系未声明，
 *   可能有数百米偏移），必须经用户确认才允许进入笔记关联；
 * - 位置不等于到访：本函数只回答「点落在哪个行政区」，不推断到访或路线。
 */

import { canonicalRegionId } from "@/features/regions/region-catalog";
import {
  pointInRing,
  largestRing,
  ringBounds,
  type LabelGeometry
} from "@/features/atlas/region-label-layout";

export type PhotoLocationMatch = {
  /** 应用稳定 RegionId（已归一双身份；匹配层级由该地区目录条目决定）。 */
  regionId: string;
  /** 命中方式：面内 = 明确命中；外环近似 = 点到最大外环的距离 ≤0.05°（包围盒仅预筛）。 */
  basis: "inside" | "near";
};

export type RegionGeometryEntry = {
  regionId: string;
  level: "province" | "city";
  geometry: LabelGeometry;
};

/** 环点列清洗：只保留 [number, number]。 */
function toRing(candidate: unknown): [number, number][] {
  if (!Array.isArray(candidate)) return [];
  return candidate.filter(
    (item): item is [number, number] =>
      Array.isArray(item) &&
      item.length >= 2 &&
      typeof item[0] === "number" &&
      typeof item[1] === "number"
  );
}

/**
 * 判定点在单个多面几何内：外环命中且**不在任何内环（洞）里**。
 * 内环是行政意义上的洞——广东多边形里的港澳洞：落在洞里的点属于港澳，
 * 不属于广东（M1.5 复审 P1：忽略内环曾把澳门点判成广东）。
 */
export function pointInGeometry(point: [number, number], geometry: LabelGeometry): boolean {
  const shape = geometry.geometry ?? geometry;
  const type = shape?.type;
  const coordinates = shape?.coordinates;
  if (!coordinates || (type !== "Polygon" && type !== "MultiPolygon")) return false;
  const polygons: unknown[] = type === "Polygon" ? [coordinates] : (coordinates as unknown[]);
  for (const polygon of polygons) {
    const rings = Array.isArray(polygon) ? (polygon as unknown[]) : [];
    const outer = toRing(rings[0]);
    if (outer.length < 3 || !pointInRing(point, outer)) continue;
    let inHole = false;
    for (let index = 1; index < rings.length; index += 1) {
      const hole = toRing(rings[index]);
      if (hole.length >= 3 && pointInRing(point, hole)) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

/** 点到线段的距离（度，近似平面）。 */
function pointToSegmentDistance(
  point: [number, number],
  a: [number, number],
  b: [number, number]
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  let t = lengthSquared === 0 ? 0 : ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy));
}

function distanceToRing(point: [number, number], ring: [number, number][]): number {
  let min = Number.POSITIVE_INFINITY;
  for (let index = 0, prev = ring.length - 1; index < ring.length; prev = index, index += 1) {
    min = Math.min(min, pointToSegmentDistance(point, ring[prev], ring[index]));
  }
  return min;
}

/**
 * 近似命中：点在面外但**贴近实际边界**（≤ bufferDegrees）。
 * 必须量到边界而不是包围盒——凹形省份（北部湾的广西）的包围盒会把
 * 远海点也吞进来（M1.5 复审 P2：(21,106) 被推荐为广西）。
 */
function pointNearGeometry(
  point: [number, number],
  geometry: LabelGeometry,
  bufferDegrees: number
): boolean {
  const ring = largestRing(geometry);
  if (ring.length === 0) return false;
  const bounds = ringBounds(ring);
  if (!bounds) return false;
  const [minX, minY, maxX, maxY] = bounds;
  if (
    point[0] < minX - bufferDegrees ||
    point[0] > maxX + bufferDegrees ||
    point[1] < minY - bufferDegrees ||
    point[1] > maxY + bufferDegrees
  ) {
    return false;
  }
  return distanceToRing(point, ring) <= bufferDegrees;
}

/** 草稿关联 ID 的规范集：别名（拼音/数字双身份）视为同一地区，用于去重追加。 */
export function canonicalRegionIdSet(regionIds: string[]): Set<string> {
  return new Set(regionIds.map(canonicalRegionId));
}

/**
 * 找出 GPS 点所在的省市：先全国省级几何，命中省后只在该省城市里细化。
 * 返回候选列表（省 + 可能的城市）；都不命中返回空数组——调用方显示
 * 「未识别到行政区」，不阻塞任何流程。
 */
export function matchPhotoLocation(
  point: { lat: number; lng: number },
  provinces: RegionGeometryEntry[],
  citiesByProvince: Map<string, RegionGeometryEntry[]>
): PhotoLocationMatch[] {
  const coordinate: [number, number] = [point.lng, point.lat];
  const matches: PhotoLocationMatch[] = [];

  // 省级：面内命中即确定；都未命中时再用边界距离近似（海岸线/边界偏移兜底）。
  let province: RegionGeometryEntry | null = null;
  let provinceBasis: "inside" | "near" = "inside";
  for (const entry of provinces) {
    if (pointInGeometry(coordinate, entry.geometry)) {
      province = entry;
      provinceBasis = "inside";
      break;
    }
  }
  if (!province) {
    for (const entry of provinces) {
      if (pointNearGeometry(coordinate, entry.geometry, 0.05)) {
        province = entry;
        provinceBasis = "near";
        break;
      }
    }
  }
  if (!province) return [];
  matches.push({ regionId: canonicalRegionId(province.regionId), basis: provinceBasis });

  // 城市级：只在该省的城市几何里找，面内命中才算（省级 near 不推定城市）。
  const cities = citiesByProvince.get(province.regionId) ?? [];
  for (const city of cities) {
    if (pointInGeometry(coordinate, city.geometry)) {
      matches.push({ regionId: canonicalRegionId(city.regionId), basis: "inside" });
      break;
    }
  }
  return matches;
}
