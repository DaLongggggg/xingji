import {
  BoundaryError,
  type BoundaryDataset,
  type BoundaryLoadOptions,
  type BoundaryProvider
} from "./boundary-contract";
import { normalizeBoundaryJson } from "./boundary-validation";
import {
  ATLAS_ENDPOINT,
  ATLAS_MANIFEST_ID,
  chunksForProvince,
  findProvincePackage,
  isProvinceSelfSource,
  type AtlasPackageManifest
} from "./atlas-package-manifest";
import { REGION_CATALOG, findRegion } from "@/features/regions/region-catalog";
import { boundaryRegionId } from "@/features/regions/region-boundary-map";

/**
 * 015 本地数据包 Provider：同源 fetch + 复用既有校验/缓存/取消契约。
 *
 * - 首页只加载全国包；点省才加载该省的城市分片（不预取其他省）；
 * - 响应经过与文件入口相同的 JSON 校验，空集合/坏数据不会被当成成功；
 * - 生产环境未配置数据包时返回 404，不伪造数据。
 */

export { ATLAS_ENDPOINT } from "./atlas-package-manifest";

export type AtlasProviderDeps = {
  fetchImpl?: typeof fetch;
  manifest?: AtlasPackageManifest;
};

export async function loadAtlasManifest(
  deps: AtlasProviderDeps = {}
): Promise<AtlasPackageManifest> {
  if (deps.manifest) return deps.manifest;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(`${ATLAS_ENDPOINT}/${ATLAS_MANIFEST_ID}`, {
    headers: { accept: "application/json" }
  });
  if (!response.ok) {
    throw new BoundaryError(
      "NO_DATA",
      "地图数据包暂不可用，请确认服务已配置数据包；本地笔记仍可从笔记本查看。"
    );
  }
  return (await response.json()) as AtlasPackageManifest;
}

/** 应用地区目录 → 来源编号（清单里登记的城市标识）。 */
function sourceRegionIdOf(regionId: string): string | undefined {
  return findRegion(regionId)?.sourceRegionId;
}

export function createHttpAtlasProvider(
  manifest: AtlasPackageManifest,
  deps: AtlasProviderDeps = {}
): BoundaryProvider {
  const fetchImpl = deps.fetchImpl ?? fetch;
  async function readText(url: string, options?: BoundaryLoadOptions): Promise<string> {
    const response = await fetchImpl(url, {
      signal: options?.signal,
      headers: { accept: "application/json" }
    });
    if (!response.ok) {
      throw new BoundaryError(
        response.status === 404 ? "NO_DATA" : "INVALID_STRUCTURE",
        response.status === 404
          ? "该省尚未生成本地地图数据包。"
          : `本地地图数据包读取失败：HTTP ${response.status}。`
      );
    }
    return response.text();
  }

  const derivedVersion = manifest.derived
    ? `${manifest.derived.version}.${manifest.derived.digest}`
    : undefined;

  return {
    sourceId: manifest.sources.national.sourceId,
    sourceVersion: manifest.sources.national.sourceVersion,
    derivedVersion,
    async loadCity(regionId, options) {
      const region = findRegion(regionId);
      const stem = region?.sourceFile ?? region?.sourceRegionId;
      const item = manifest.countyPackages?.find((entry) =>
        region?.level === "city"
          ? entry.parentSourceFile === stem
          : entry.provinceRegionId === regionId &&
            isProvinceSelfSource(manifest, region?.sourceRegionId ?? "")
      );
      if (!item) throw new BoundaryError("NO_DATA", "该地区尚未提供区县地图，当前视图已保留。");
      return normalizeBoundaryJson(await readText(`${ATLAS_ENDPOINT}/${item.file}`, options), {
        sourceId: `echarts-county-preview@${item.sourceVersion}+${(item.sha256 ?? "").slice(0, 16)}`,
        sourceVersion: item.sourceVersion,
        level: "city",
        parentRegionId: regionId,
        regionIdFor: (id) =>
          `echarts-county-preview@${item.sourceVersion}:${JSON.stringify([regionId, id])}`
      });
    },
    async loadNational(options) {
      const body = await readText(
        `${ATLAS_ENDPOINT}/${manifest.national.packageFile}`,
        options
      );
      return normalizeBoundaryJson(body, {
        sourceId: manifest.sources.national.sourceId,
        sourceVersion: manifest.sources.national.sourceVersion,
        level: "national"
      });
    },
    async loadProvince(regionId, options) {
      const province = findProvincePackage(manifest, regionId);
      if (!province) {
        // 目录已知但几何缺失：明确失败，界面退回文字入口，不伪造空集合。
        throw new BoundaryError(
          "NO_DATA",
          "该省尚未提供城市轮廓；仍可在地区列表中查看与关联笔记本。"
        );
      }
      const chunks = chunksForProvince(manifest, regionId);
      if (chunks.length === 0) {
        throw new BoundaryError("NO_DATA", "该省尚未提供城市轮廓。");
      }
      const merged: BoundaryDataset[] = [];
      for (const chunk of chunks) {
        const body = await readText(`${ATLAS_ENDPOINT}/${chunk.file}`, options);
        merged.push(
          normalizeBoundaryJson(body, {
            sourceId: province.sourceId,
            sourceVersion: province.sourceVersion,
            level: "province",
            parentRegionId: regionId,
            // 直辖市/港澳的素材子级就是省级自身，映射回省级而不是造同名城市。
            parentSourceRegionId: province.provinceSourceRegionId,
            regionIdFor: (sourceRegionId) => {
              if (
                isProvinceSelfSource(manifest, province.provinceSourceRegionId) &&
                sourceRegionId === province.provinceSourceRegionId
              ) {
                return regionId;
              }
              const city = REGION_CATALOG.regions.find(
                (region) =>
                  region.level === "city" &&
                  region.parentRegionId === regionId &&
                  (region.sourceRegionId === sourceRegionId ||
                    // 既有 014-C 城市的 sourceRegionId 是数字编号，素材标识在 sourceFile 里。
                    region.sourceFile === sourceRegionId)
              );
              // 目录未登记的城市不冒充：交给校验层报“未在目录登记”。
              return city ? boundaryRegionId(province.sourceId, sourceRegionId) : null;
            }
          })
        );
      }
      const regions = merged
        .flatMap((dataset) => dataset.regions)
        .map((region) => ({
          ...region,
          childStatus: manifest.countyPackages?.some(
            (item) => item.parentSourceFile === region.sourceRegionId
          )
            ? ("available" as const)
            : ("unavailable" as const)
        }));
      const features = merged.flatMap((dataset) => dataset.features);
      if (regions.length === 0 || features.length === 0) {
        throw new BoundaryError("NO_DATA", "该省城市数据为空，未作为成功加载。");
      }
      return {
        sourceId: province.sourceId,
        sourceVersion: province.sourceVersion,
        level: "province" as const,
        parentRegionId: regionId,
        regions,
        features
      };
    }
  };
}

/** 目录里该省的城市数（用于日志与界面提示，不做几何断言）。 */
export function catalogCityCount(provinceRegionId: string): number {
  return REGION_CATALOG.regions.filter(
    (region) => region.level === "city" && region.parentRegionId === provinceRegionId
  ).length;
}

export { sourceRegionIdOf };
