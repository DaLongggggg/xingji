/**
 * 行政区边界数据契约（013 / D2a）。
 *
 * 两条状态轴**分开表达**，不能用一个布尔值互相冒充：
 * - `geometryAvailable`：技术上是否已加载并通过校验的真实几何，可驱动地图渲染（技术 ready）。
 * - `dataScope`：数据的使用/分发范围；只有拿到明确授权才可为 "approved"。
 *
 * 本轮（D2a）真实数据只用于开发态本地文件验证，因此即使几何加载成功，
 * `dataScope` 仍是 "development-preview"，绝不把技术成功当成发布授权。
 */

export type AtlasDataScope = "unavailable" | "development-preview" | "approved";

export type BoundaryLevel = "national" | "province" | "city";

/** 子级是否可继续下钻。 */
export type ChildStatus = "available" | "unavailable" | "leaf";

/** 一个地区（省或城市）。 */
export type BoundaryRegionSummary = {
  /** 稳定 ID，由显式来源映射产生（带来源命名空间），不使用数组下标或显示名。 */
  regionId: string;
  /** 来源文件中的原始标识（如 "44"、"4401"），保留可追溯。 */
  sourceRegionId: string;
  name: string;
  parentRegionId: string | null;
  childStatus: ChildStatus;
};

export type BoundaryGeometry = GeoJSON.Polygon | GeoJSON.MultiPolygon;

export type BoundaryFeature = {
  regionId: string;
  geometry: BoundaryGeometry;
};

export type BoundaryDataset = {
  sourceId: string;
  sourceVersion: string;
  level: BoundaryLevel;
  parentRegionId: string | null;
  regions: BoundaryRegionSummary[];
  features: BoundaryFeature[];
};

export type BoundaryLoadOptions = { signal?: AbortSignal };

export type BoundaryProvider = {
  /** 来源标识与版本，用于缓存键；换源必须清缓存。 */
  readonly sourceId: string;
  readonly sourceVersion: string;
  /**
   * 019：**派生产物版本**（变换算法版本 + 包摘要），与来源版本分开。
   * 派生算法或产物字节变化时它必须变化，缓存与几何更新身份据此失效；
   * 它与业务 RegionId、县级展示身份无关。
   */
  readonly derivedVersion?: string;
  loadNational(options?: BoundaryLoadOptions): Promise<BoundaryDataset>;
  loadProvince(regionId: string, options?: BoundaryLoadOptions): Promise<BoundaryDataset>;
  loadCity?(regionId: string, options?: BoundaryLoadOptions): Promise<BoundaryDataset>;
};

/** 校验失败时的显式错误码，便于区分“数据坏”和“网络/取消”。 */
export type BoundaryErrorCode =
  | "INVALID_JSON"
  | "INVALID_STRUCTURE"
  | "EMPTY_GEOMETRY"
  | "DUPLICATE_REGION_ID"
  | "UNKNOWN_REGION"
  | "PARENT_MISMATCH"
  | "INVALID_COORDINATES"
  | "UNCLOSED_RING"
  | "FILE_TOO_LARGE"
  | "NO_DATA"
  | "ABORTED";

export class BoundaryError extends Error {
  constructor(
    readonly code: BoundaryErrorCode,
    message: string
  ) {
    super(message);
    this.name = "BoundaryError";
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof BoundaryError
    ? error.code === "ABORTED"
    : Boolean(
        error && typeof error === "object" && (error as { name?: string }).name === "AbortError"
      );
}

/** 单份边界文件大小上限 10 MiB（超限先报告，不放开任意大文件）。 */
export const MAX_BOUNDARY_FILE_BYTES = 10 * 1024 * 1024;

/** 来源命名空间化的稳定 ID。 */
export function createRegionId(sourceId: string, sourceRegionId: string): string {
  return `${sourceId}:${sourceRegionId}`;
}
