import {
  findRegion,
  listProvinces,
  REGION_CATALOG,
  type Region,
  type RegionCatalog
} from "./region-catalog";

/**
 * 几何来源 ↔ 应用地区的显式映射（014-C）。
 *
 * 地图适配器只认识来源命名空间 ID（`<sourceId>:<sourceRegionId>`，见 D2a `createRegionId`）；
 * 应用只认识自己的 `RegionId`。两者**只能通过这里显式对应**：
 * - 只登记已确认的来源与版本；未知 sourceId 或未支持 sourceVersion 一律返回未映射；
 * - 不按名称、编号前缀或“恰好同号”猜测；
 * - 显示的 `sourceId` 为数据集自报值，应用不按名字改写它。
 */

/** 与 D2a 一致的来源命名空间 ID 构造（避免 atlas 与 regions 互相依赖）。 */
export function boundaryRegionId(sourceId: string, sourceRegionId: string): string {
  return `${sourceId}:${sourceRegionId}`;
}

export type BoundarySourceDescriptor = {
  sourceId: string;
  sourceVersion: string;
};

/**
 * 已确认支持的几何来源（含版本）。开发入口当前自报 `local-json` + 目录指纹；
 * 该别名与来源 commit 的对应关系在此显式登记，换版本必须在这里新增条目。
 */
export const SUPPORTED_BOUNDARY_SOURCES: {
  sourceId: string;
  sourceVersion: string;
  /** 可追溯的原始来源（用于文档与排查，不参与判断）。 */
  origin: string;
}[] = [
  {
    /** 015：全国分省包（沿用 D2a 已验证的固定版本 china.json）。 */
    sourceId: "local-json-cn",
    sourceVersion: "33cd37ab22628858654d839f5d88a2deec372463",
    origin: "yezongyang/china-geojson@33cd37ab22628858654d839f5d88a2deec372463"
  },
  {
    /** 015：各省城市包（echarts-china-cities-js shape-only，固定提交）。 */
    sourceId: "echarts-cities-shape-only",
    sourceVersion: "e3318090406a64c48fd26a4020b11ea6b590a007",
    origin: "echarts-maps/echarts-china-cities-js@e3318090406a64c48fd26a4020b11ea6b590a007"
  }
];

/** 基线来源编号范围：目录里的省级与广东市级编号都属于这一基线。 */
export const BASE_CATALOG_SOURCE_REGION_IDS = new Set(
  REGION_CATALOG.regions.map((region) => region.sourceRegionId)
);

function isSupportedSource(source: BoundarySourceDescriptor): boolean {
  return SUPPORTED_BOUNDARY_SOURCES.some(
    (item) => item.sourceId === source.sourceId && item.sourceVersion === source.sourceVersion
  );
}

/**
 * 建立来源 → 应用映射。未知来源或未支持版本返回**空映射**
 * （调用方显示“篇数未知”，而不是错误地按同号对应）。
 */
export function createBoundaryMap(
  source: BoundarySourceDescriptor,
  catalog: RegionCatalog = REGION_CATALOG
): Map<string, string> {
  const map = new Map<string, string>();
  if (!isSupportedSource(source)) return map;
  for (const region of catalog.regions) {
    map.set(boundaryRegionId(source.sourceId, region.sourceRegionId), region.regionId);
  }
  return map;
}

/** 来源编号 → 应用地区 ID（仅已支持来源）。 */
export function toAppRegionId(
  boundaryRegionIdValue: string,
  source: BoundarySourceDescriptor,
  catalog: RegionCatalog = REGION_CATALOG
): string | undefined {
  if (!isSupportedSource(source)) return undefined;
  const prefix = `${source.sourceId}:`;
  if (!boundaryRegionIdValue.startsWith(prefix)) return undefined;
  const sourceRegionId = boundaryRegionIdValue.slice(prefix.length);
  const region = catalog.regions.find((item) => item.sourceRegionId === sourceRegionId);
  return region && findRegion(region.regionId, catalog) ? region.regionId : undefined;
}

/** 应用地区 ID → 来源 ID（仅已支持来源）。 */
export function toBoundaryRegionId(
  regionId: string,
  source: BoundarySourceDescriptor,
  catalog: RegionCatalog = REGION_CATALOG
): string | undefined {
  if (!isSupportedSource(source)) return undefined;
  const region = findRegion(regionId, catalog);
  if (!region) return undefined;
  return boundaryRegionId(source.sourceId, region.sourceRegionId);
}

/** 应用地区是否属于本轮目录（旧/未知 ID 返回 false，界面显示“地区待匹配”）。 */
export function isCatalogRegion(
  regionId: string,
  catalog: RegionCatalog = REGION_CATALOG
): boolean {
  return Boolean(findRegion(regionId, catalog));
}

/** 已支持来源的省级入口（用于文字入口与目录对照）。 */
export function listSupportedSourceProvinces(catalog: RegionCatalog = REGION_CATALOG): Region[] {
  return listProvinces(catalog);
}

/** 已存关联的地区引用（`NotebookRegionRef` 的结构子集，避免模块循环依赖）。 */
export type StoredRegionRef = {
  regionId: string;
  parentRegionId: string | null;
  level: "province" | "city" | "unknown";
  name: string;
  catalogVersion: string;
  /** 素材文件名标识（015 新增；旧数据没有此字段）。 */
  sourceFile?: string;
};

export type RegionResolution =
  | { status: "resolved"; region: Region }
  /** 目录里有这个 ID，但已存记录写的是别的父级/层级：保留原数据，不猜测。 */
  | { status: "mismatch"; region: Region; reason: string }
  /** 不在当前目录（旧供应商命名空间 ID、未来地区或手工数据）：待匹配。 */
  | { status: "unmatched"; reason: string };

export function resolveStoredRegion(
  ref: StoredRegionRef,
  catalog: RegionCatalog = REGION_CATALOG
): RegionResolution {
  const region = findRegion(ref.regionId, catalog);
  if (!region) {
    return {
      status: "unmatched",
      reason: `目录中没有 ${ref.regionId}（可能来自旧版本或供应商命名空间）。`
    };
  }
  if (ref.level !== "unknown" && ref.level !== region.level) {
    return {
      status: "mismatch",
      region,
      reason: `已存层级 ${ref.level} 与目录 ${region.level} 不一致。`
    };
  }
  if (ref.parentRegionId !== null && ref.parentRegionId !== region.parentRegionId) {
    return {
      status: "mismatch",
      region,
      reason: "已存父级与目录不一致，保留原数据待确认。"
    };
  }
  return { status: "resolved", region };
}

/** 由目录地区构造可持久化的引用（新增关联只允许走这里）。 */
export function toStoredRegionRef(region: Region): StoredRegionRef {
  const ref: StoredRegionRef = {
    regionId: region.regionId,
    parentRegionId: region.parentRegionId,
    level: region.level,
    name: region.name,
    catalogVersion: region.catalogVersion
  };
  // 只在确实有素材标识时写入，保持旧数据的引用形状不变。
  if (region.sourceFile) ref.sourceFile = region.sourceFile;
  return ref;
}
