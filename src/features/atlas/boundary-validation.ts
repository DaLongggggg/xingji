import {
  BoundaryError,
  MAX_BOUNDARY_FILE_BYTES,
  createRegionId,
  type BoundaryDataset,
  type BoundaryFeature,
  type BoundaryGeometry,
  type BoundaryLevel,
  type BoundaryRegionSummary,
  type ChildStatus
} from "./boundary-contract";

/**
 * 边界 JSON 的校验与归一化（纯函数，无网络、无存储）。
 *
 * 规则（013 §3）：校验 FeatureCollection、唯一 ID、名称、父级对应、
 * 坐标有限且范围合理、Polygon/MultiPolygon 闭合环、非空几何；
 * 错误显式抛出，**不静默丢弃 feature**。
 */

type ValidateInput = {
  sourceId: string;
  sourceVersion: string;
  level: BoundaryLevel;
  /** 省份层级时必填：该省的 regionId。 */
  parentRegionId?: string | null;
  /** 省份层级时必填：父省的来源标识（如 "44"）。 */
  parentSourceRegionId?: string | null;
  /**
   * 来源子级 → 应用地区 ID 的显式映射（015）。缺省时按 `${sourceId}:${sourceRegionId}` 拼出。
   * 用于：直辖市/港澳的素材子级映射回省级自身、全国城市目录的目录内解析。
   */
  regionIdFor?: (sourceRegionId: string) => string | null;
};

function fail(code: BoundaryError["code"], message: string): never {
  throw new BoundaryError(code, message);
}

function isValidCoordinate(pair: unknown): pair is [number, number] {
  if (!Array.isArray(pair) || pair.length < 2) return false;
  const [lng, lat] = pair as unknown[];
  if (typeof lng !== "number" || typeof lat !== "number") return false;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
  // 合理范围：经度 -180..180，纬度 -90..90；超出视为坏数据。
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return false;
  return true;
}

function ringIsClosed(ring: unknown): boolean {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  const first = ring[0] as [number, number];
  const last = ring[ring.length - 1] as [number, number];
  return first[0] === last[0] && first[1] === last[1];
}

function validatePolygonCoordinates(coordinates: unknown): boolean {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return false;
  return coordinates.every(
    (ring) =>
      Array.isArray(ring) && ring.length >= 4 && ring.every(isValidCoordinate) && ringIsClosed(ring)
  );
}

function readGeometry(raw: unknown): BoundaryGeometry {
  if (!raw || typeof raw !== "object") fail("EMPTY_GEOMETRY", "feature 缺少 geometry。");
  const geometry = raw as { type?: unknown; coordinates?: unknown };
  if (geometry.type === "Polygon") {
    if (!validatePolygonCoordinates(geometry.coordinates)) {
      const rings = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
      const unclosed = rings.some((ring) => Array.isArray(ring) && !ringIsClosed(ring));
      if (unclosed) fail("UNCLOSED_RING", "Polygon 存在未闭合的环。");
      fail("INVALID_COORDINATES", "Polygon 坐标无效。");
    }
    return geometry as BoundaryGeometry;
  }
  if (geometry.type === "MultiPolygon") {
    const coordinates = geometry.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length === 0) {
      fail("EMPTY_GEOMETRY", "MultiPolygon 没有多边形。");
    }
    coordinates.forEach((polygon) => {
      if (!validatePolygonCoordinates(polygon)) {
        const rings = Array.isArray(polygon) ? polygon : [];
        const unclosed = rings.some((ring) => Array.isArray(ring) && !ringIsClosed(ring));
        if (unclosed) fail("UNCLOSED_RING", "MultiPolygon 存在未闭合的环。");
        fail("INVALID_COORDINATES", "MultiPolygon 坐标无效。");
      }
    });
    return geometry as BoundaryGeometry;
  }
  fail("EMPTY_GEOMETRY", `不支持的几何类型：${String(geometry.type)}。`);
}

function readName(properties: Record<string, unknown>, index: number): string {
  const name = properties.name ?? properties.NAME;
  if (typeof name !== "string" || name.trim().length === 0) {
    fail("INVALID_STRUCTURE", `第 ${index + 1} 个 feature 缺少名称。`);
  }
  return name.trim();
}

function readSourceRegionId(properties: Record<string, unknown>, index: number): string {
  // 015：城市素材只有 name，没有 adcode/id；准备脚本按素材文件名注入 `xingjiSourceRegionId`，
  // 来源身份仍然明确（不按数组位置或名称生成）。
  const raw =
    properties.adcode ?? properties.id ?? properties.ADCODE ?? properties.xingjiSourceRegionId;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  fail("INVALID_STRUCTURE", `第 ${index + 1} 个 feature 缺少来源地区标识（adcode/id）。`);
}

/**
 * 归一化一份边界 JSON 为 BoundaryDataset。
 * 解析与结构错误一律显式抛出（不做“跳过坏 feature”的静默降级）。
 */
export function normalizeBoundaryJson(rawText: string, input: ValidateInput): BoundaryDataset {
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    fail("INVALID_JSON", "边界文件为空。");
  }
  if (rawText.length > MAX_BOUNDARY_FILE_BYTES) {
    fail("FILE_TOO_LARGE", `边界文件超过 ${MAX_BOUNDARY_FILE_BYTES} 字节上限。`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    // 截断/损坏的 JSON 必须显式失败，不能当作空地图。
    fail(
      "INVALID_JSON",
      `边界文件不是合法 JSON（可能被截断）：${error instanceof Error ? error.message : "解析失败"}`
    );
  }

  const collection = parsed as { type?: unknown; features?: unknown };
  if (collection?.type !== "FeatureCollection") {
    fail("INVALID_STRUCTURE", "根节点必须是 FeatureCollection。");
  }
  if (!Array.isArray(collection.features) || collection.features.length === 0) {
    fail("EMPTY_GEOMETRY", "FeatureCollection 没有任何 feature。");
  }

  const seen = new Set<string>();
  const regions: BoundaryRegionSummary[] = [];
  const features: BoundaryFeature[] = [];
  const parentRegionId = input.parentRegionId ?? null;

  collection.features.forEach((item, index) => {
    const feature = item as { properties?: unknown; geometry?: unknown };
    if (!feature || typeof feature !== "object" || !feature.properties) {
      fail("INVALID_STRUCTURE", `第 ${index + 1} 个 feature 缺少 properties。`);
    }
    const properties = feature.properties as Record<string, unknown>;
    const name = readName(properties, index);
    const sourceRegionId = readSourceRegionId(properties, index);
    // 显式映射优先（015：直辖市/港澳子级 → 省级自身、全国城市目录解析）。
    const regionId = input.regionIdFor
      ? input.regionIdFor(sourceRegionId)
      : createRegionId(input.sourceId, sourceRegionId);
    if (!regionId) {
      fail("UNKNOWN_REGION", `地区 ${sourceRegionId} 未在目录登记。`);
    }
    if (seen.has(regionId)) {
      fail("DUPLICATE_REGION_ID", `重复的地区 ID：${regionId}。`);
    }
    seen.add(regionId);

    // 省份层级：城市素材的文件标识自带省级前缀（如 "guang3_dong1_*"），
    // 因此父子关系由提供方按该前缀挑选文件保证；这里只要求父省标识存在。
    if (input.level === "province" && !input.parentSourceRegionId) {
      fail("PARENT_MISMATCH", "省份层级缺少父省来源标识。");
    }
    if (input.level === "city" && !parentRegionId) {
      fail("PARENT_MISMATCH", "区县视图缺少父地区标识。");
    }

    const geometry = readGeometry(feature.geometry);
    // childNum 只作提示：>0 表示可能可下钻，但能否下钻取决于是否真的提供了子级数据。
    const childNum = Number(properties.childNum ?? 0);
    const childStatus: ChildStatus =
      input.level === "national" && childNum > 0 ? "unavailable" : "leaf";

    regions.push({ regionId, sourceRegionId, name, parentRegionId, childStatus });
    features.push({ regionId, geometry });
  });

  return {
    sourceId: input.sourceId,
    sourceVersion: input.sourceVersion,
    level: input.level,
    parentRegionId,
    regions,
    features
  };
}
