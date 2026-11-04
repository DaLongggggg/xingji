/**
 * 019 派生层几何规范化（只读原始素材，不修改 map-data/）。
 *
 * 目的：把“零面积退化分量”和“真正异常的几何”分开处理，并留下可追溯的逐项记录。
 * 原始素材里存在少量无法形成面积的环（3 个顶点但只有 1~2 个不同点、或所有点共线）。
 * 它们不贡献任何面积，但会让整包几何校验失败；本模块只在**派生输出**里剔除这些分量，
 * 每个被剔除的分量都带源文件、feature、多边形、环索引与原始坐标。
 *
 * 明确不套用该规则的异常（一律单独诊断，不静默剔除）：
 * - 退化外环**带有效内环**：删掉外环会让内环变成假填充，必须整项诊断；
 * - 非有限坐标、空环、未闭合环；
 * - 规范化后某个 feature 不再有任何有效多边形。
 *
 * 面积代数和为 0 不单独作为退化判据：自交环（如 bow-tie）也可能代数和为 0，
 * 因此这里额外要求“不同点数不足 3”或“所有点共线”，否则不按退化剔除。
 */

export type Position = [number, number];
export type Ring = Position[];
export type PolygonCoordinates = Ring[];
export type NormalizeGeometry = {
  type: "Polygon" | "MultiPolygon";
  coordinates: PolygonCoordinates | PolygonCoordinates[];
};
export type RemovedComponent = {
  sourceFile?: string;
  featureName?: string | null;
  featureIndex?: number;
  polygonIndex: number;
  ringIndex: number;
  kind: string;
  reason: string;
  originalRing: Ring;
};
export type GeometryDiagnostic = {
  sourceFile?: string;
  featureName?: string | null;
  featureIndex?: number;
  polygonIndex?: number;
  ringIndex?: number;
  kind: string;
  detail?: string;
  holes?: number;
};
export type DegenerateKind = { kind: string; reason: string };

/** 环里有多少个不同顶点。 */
export function distinctPointCount(ring: Ring): number {
  const seen = new Set();
  for (const point of ring) seen.add(`${point[0]},${point[1]}`);
  return seen.size;
}

/** 有向面积（鞋带公式，度²；仅用于退化判定与统计，不代表真实球面面积）。 */
export function signedRingArea(ring: Ring): number {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  let sum = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[(index + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/** 所有点是否共线（含退化点集）。 */
export function isCollinear(ring: Ring): boolean {
  const unique = [];
  for (const point of ring) {
    const last = unique[unique.length - 1];
    if (!last || last[0] !== point[0] || last[1] !== point[1]) unique.push(point);
  }
  if (unique.length < 3) return true;
  const [ax, ay] = unique[0];
  const [bx, by] = unique[1];
  const dx = bx - ax;
  const dy = by - ay;
  for (const [x, y] of unique.slice(2)) {
    // 叉积为 0 表示与首两点共线（用相对误差容忍浮点）。
    const cross = dx * (y - ay) - dy * (x - ax);
    const scale = Math.max(1, Math.abs(dx) + Math.abs(dy) + Math.abs(x) + Math.abs(y));
    if (Math.abs(cross) > 1e-9 * scale) return false;
  }
  return true;
}

/** 坐标是否为有限数。 */
function isFinitePoint(point: unknown): point is Position {
  return (
    Array.isArray(point) &&
    point.length >= 2 &&
    Number.isFinite(point[0]) &&
    Number.isFinite(point[1]) &&
    Math.abs(point[0]) <= 180 &&
    Math.abs(point[1]) <= 90
  );
}

/**
 * 环的**结构**问题（不含“退化”）：非有限坐标、未闭合、不是有效点列。
 * 顶点不足属于退化分量，由 `classifyDegenerateRing` 判定。
 * 返回空数组表示结构合法。
 */
export function findRingStructuralProblems(ring: unknown): string[] {
  const problems: string[] = [];
  if (!Array.isArray(ring) || ring.length === 0) {
    problems.push("empty-ring");
    return problems;
  }
  if (!ring.every(isFinitePoint)) problems.push("non-finite-coordinate");
  const first = ring[0] as Position;
  const last = ring[ring.length - 1] as Position;
  if (first[0] !== last[0] || first[1] !== last[1]) problems.push("unclosed-ring");
  return problems;
}

/**
 * 判定某个环是否属于可剔除的零面积退化分量。
 * @returns {{kind: string, reason: string} | null} null 表示不是可剔除的退化分量。
 */
export function classifyDegenerateRing(ring: unknown): DegenerateKind | null {
  const structural = findRingStructuralProblems(ring);
  if (structural.length > 0) return null; // 结构问题另走诊断
  const candidate = ring as Ring;
  const distinct = distinctPointCount(candidate);
  // 顶点数不足与不同点不足都归同一类：环本身无法围出面积。
  if (candidate.length < 4 || distinct < 3) {
    return {
      kind: "too-few-distinct-points",
      reason: `环 ${candidate.length} 个点、${distinct} 个不同点`
    };
  }
  if (signedRingArea(candidate) === 0 && isCollinear(candidate)) {
    return { kind: "collinear-zero-area", reason: "环所有点共线，面积恒为 0" };
  }
  return null;
}

/** 多边形面积（外环减内环，可能为负/0；仅用于统计与退化判定）。 */
export function polygonArea(polygon: PolygonCoordinates): number {
  if (!Array.isArray(polygon) || polygon.length === 0) return 0;
  let area = Math.abs(signedRingArea(polygon[0]));
  for (const hole of polygon.slice(1)) area -= Math.abs(signedRingArea(hole));
  return area;
}

function listPolygons(geometry: unknown): PolygonCoordinates[] {
  if (!geometry || typeof geometry !== "object") return [];
  const candidate = geometry as { type?: unknown; coordinates?: unknown };
  if (candidate.type === "Polygon") return [candidate.coordinates as PolygonCoordinates];
  if (candidate.type === "MultiPolygon") return candidate.coordinates as PolygonCoordinates[];
  return [];
}

/** 几何总面积（各多边形面积代数和）。 */
export function geometryArea(geometry: unknown): number {
  return listPolygons(geometry).reduce((sum, polygon) => sum + polygonArea(polygon), 0);
}

/**
 * 规范化一个几何：剔除零面积退化分量，保留全部有效分量与真实内环。
 *
 * @param {object} geometry GeoJSON Polygon/MultiPolygon
 * @param {{sourceFile?: string, featureName?: string|null, featureIndex?: number}} context
 * @returns {{geometry: object|null, removed: object[], diagnostics: object[]}}
 */
export function normalizeGeometry(
  geometry: unknown,
  context: { sourceFile?: string; featureName?: string | null; featureIndex?: number } = {}
): {
  geometry: NormalizeGeometry | null;
  removed: RemovedComponent[];
  diagnostics: GeometryDiagnostic[];
} {
  const removed: RemovedComponent[] = [];
  const diagnostics: GeometryDiagnostic[] = [];
  const polygons = listPolygons(geometry);
  if (polygons.length === 0) {
    diagnostics.push({
      ...context,
      kind: "unsupported-geometry",
      detail: String((geometry as { type?: unknown } | null)?.type ?? "")
    });
    return { geometry: null, removed, diagnostics };
  }

  const keptPolygons: PolygonCoordinates[] = [];
  polygons.forEach((polygon, polygonIndex) => {
    if (!Array.isArray(polygon) || polygon.length === 0) {
      diagnostics.push({ ...context, polygonIndex, kind: "empty-polygon" });
      return;
    }
    const outer = polygon[0];
    const structural = findRingStructuralProblems(outer);
    if (structural.length > 0) {
      diagnostics.push({
        ...context,
        polygonIndex,
        ringIndex: 0,
        kind: "structural-ring-problem",
        detail: structural.join(",")
      });
      // 原样保留：结构异常由调用方阻断发布，不由规范化改写几何。
      keptPolygons.push([outer as Ring]);
      return;
    }
    const degenerate = classifyDegenerateRing(outer);
    if (degenerate) {
      // 只有“外环退化但还有内环”会改变语义（内环会变成假面），必须单独诊断并阻断发布。
      if (polygon.length > 1) {
        diagnostics.push({
          ...context,
          polygonIndex,
          ringIndex: 0,
          kind: "degenerate-outer-with-holes",
          detail: degenerate.reason,
          holes: polygon.length - 1
        });
        keptPolygons.push([outer as Ring, ...(polygon.slice(1) as Ring[])]);
        return;
      }
      removed.push({
        ...context,
        polygonIndex,
        ringIndex: 0,
        kind: degenerate.kind,
        reason: degenerate.reason,
        originalRing: outer
      });
      return;
    }
    /**
     * 真实内环的处理（019 返工）：
     * - 结构异常的内环**原样保留**并记诊断：剔掉它会静默填掉一个洞，
     *   因此这里绝不改动几何；调用方必须在派生发布入口用非空 diagnostics 阻断整包。
     * - 只有“零面积”的内环（不同点不足/共线）才可以剔除：它不覆盖任何面积，
     *   剔除不改变渲染结果，属于可追溯的规范化。
     */
    const keptHoles: Ring[] = [];
    polygon.slice(1).forEach((hole, holeOffset) => {
      const candidateHole = hole as Ring;
      const holeStructural = findRingStructuralProblems(candidateHole);
      if (holeStructural.length > 0) {
        diagnostics.push({
          ...context,
          polygonIndex,
          ringIndex: holeOffset + 1,
          kind: "structural-ring-problem",
          detail: holeStructural.join(",")
        });
        keptHoles.push(candidateHole);
        return;
      }
      const holeDegenerate = classifyDegenerateRing(candidateHole);
      if (holeDegenerate) {
        removed.push({
          ...context,
          polygonIndex,
          ringIndex: holeOffset + 1,
          kind: `hole-${holeDegenerate.kind}`,
          reason: holeDegenerate.reason,
          originalRing: candidateHole
        });
        return;
      }
      keptHoles.push(candidateHole);
    });
    keptPolygons.push([outer, ...keptHoles]);
  });

  if (keptPolygons.length === 0) {
    diagnostics.push({ ...context, kind: "feature-all-degenerate" });
    // 保留原几何并阻断发布，避免发布“只剩空壳”的 feature。
    return {
      geometry: { type: "MultiPolygon", coordinates: polygons } as NormalizeGeometry,
      removed,
      diagnostics
    };
  }

  const normalized: NormalizeGeometry =
    (geometry as { type?: string }).type === "Polygon" && keptPolygons.length === 1
      ? { type: "Polygon", coordinates: keptPolygons[0] }
      : { type: "MultiPolygon", coordinates: keptPolygons };
  return { geometry: normalized, removed, diagnostics };
}

/**
 * 规范化整份 FeatureCollection；返回新对象，**不修改入参**。
 * 每个 feature 的来源身份（properties）原样保留。
 */
export function normalizeFeatureCollection(
  collection: { features?: unknown[] } | null | undefined,
  sourceFile: string
): {
  type: "FeatureCollection";
  features: { type?: string; properties?: Record<string, unknown>; geometry: NormalizeGeometry }[];
  removed: RemovedComponent[];
  diagnostics: GeometryDiagnostic[];
} {
  const features: {
    type?: string;
    properties?: Record<string, unknown>;
    geometry: NormalizeGeometry;
  }[] = [];
  const removed: RemovedComponent[] = [];
  const diagnostics: GeometryDiagnostic[] = [];
  const featureList = Array.isArray(collection?.features) ? collection.features : [];
  featureList.forEach((rawFeature, featureIndex) => {
    const feature = rawFeature as {
      type?: string;
      properties?: Record<string, unknown>;
      geometry?: unknown;
    } | null;
    const name = typeof feature?.properties?.name === "string" ? feature.properties.name : null;
    const result = normalizeGeometry(feature?.geometry, {
      sourceFile,
      featureName: name,
      featureIndex
    });
    removed.push(...result.removed);
    diagnostics.push(...result.diagnostics);
    if (result.geometry) features.push({ ...feature, geometry: result.geometry });
  });
  return { type: "FeatureCollection", features, removed, diagnostics };
}

/** 逐环统计：用于全量盘点报告（不修改数据）。 */
export function inspectGeometry(geometry: unknown): {
  polygons: number;
  rings: number;
  degenerateOuterRings: number;
  degenerateHoleRings: number;
  structuralProblems: number;
  validOuterRings: number;
} {
  const stats = {
    polygons: 0,
    rings: 0,
    degenerateOuterRings: 0,
    degenerateHoleRings: 0,
    structuralProblems: 0,
    validOuterRings: 0
  };
  for (const polygon of listPolygons(geometry)) {
    if (!Array.isArray(polygon) || polygon.length === 0) continue;
    stats.polygons += 1;
    polygon.forEach((ring, ringIndex) => {
      stats.rings += 1;
      const structural = findRingStructuralProblems(ring);
      if (structural.length > 0) {
        stats.structuralProblems += 1;
        return;
      }
      const degenerate = classifyDegenerateRing(ring);
      if (ringIndex === 0) {
        if (degenerate) stats.degenerateOuterRings += 1;
        else stats.validOuterRings += 1;
      } else if (degenerate) {
        stats.degenerateHoleRings += 1;
      }
    });
  }
  return stats;
}
