/**
 * 015 数据包清单契约（客户端与服务端共用）。
 *
 * `.local/atlas/manifest.json` 由 `scripts/atlas/prepare-atlas.mjs` 生成，
 * 通过同源 `/api/atlas/_manifest` 读取。清单只含**清单标识**（文件名），
 * 不含任意路径；客户端据此按省请求分片，服务端据此做白名单校验。
 */

export type AtlasPackageChunk = {
  file: string;
  bytes: number;
  sha256: string;
  cityCount: number;
  cities: {
    sourceRegionId: string;
    name: string;
    sourceFile: string;
    sourceBytes: number;
    sourceSha256: string;
    /**
     * 019：城市轮廓修复审计。shape-only 只覆盖县面集合一部分时，
     * 该城市几何改由同源带内部边界素材的规范化县面集合重建；
     * 这里记录面积证据与处理量，未修复的城市没有这个字段。
     */
    geometryRepair?: {
      version: string;
      reason: string;
      cityArea: number;
      countyArea: number;
      missingShare: number;
      countyFile: string;
      removedComponents: number;
      diagnostics: number;
      multiPolygons: number;
      polygons: number;
    };
  }[];
};

export type AtlasProvincePackage = {
  provinceRegionId: string;
  provinceSourceRegionId: string;
  sourceId: string;
  sourceVersion: string;
  note?: string;
  chunks: AtlasPackageChunk[];
};

export type AtlasPackageManifest = {
  generatedBy: string;
  /**
   * 019：派生产物身份（与来源版本分开）。
   * `version` 是可读的“算法版本”，`digest` 是全国包 + 29 个城市分片的字节摘要，
   * 任何产物变化都会改变 digest；缓存与几何更新身份据此失效。
   */
  derived?: {
    version: string;
    digest: string;
  };
  sources: {
    national: {
      sourceId: string;
      sourceVersion: string;
      origin: string;
      gitBlobSha1: string;
      bytes: number;
      sha256: string;
      /** 全国包只细化港澳；每项记录固定来源，不改变既有省份 ID。 */
      refinements?: { sourceRegionId: string; name: string; sourceFile: string; features: number; gitBlobSha1: string }[];
      package: { file: string; bytes: number };
    };
    cities: {
      sourceId: string;
      sourceVersion: string;
      origin: string;
      subdir: string;
      fileCount: number;
      bytes: number;
    };
  };
  national: {
    sourceId: string;
    sourceVersion: string;
    packageFile: string;
    /**
     * 直辖市/港澳：素材子级与省级同名，不作为城市下钻。
     * 点击这些省级时，若分片里的子级 `sourceRegionId` 落在该集合，则把子级地区解析回省级自身。
     */
    nestedDirs?: { dir: string; sourceRegionId: string }[];
  };
  provinces: AtlasProvincePackage[];
  cityChunks: AtlasPackageChunk[];
  countyPackages?: {
    file: string;
    parentSourceFile: string;
    provinceRegionId: string;
    sourceVersion: string;
    bytes: number;
    sha256: string;
  }[];
  countyUnavailable?: { parentSourceFile: string; reason: string }[];
  coverage: {
    dir: string;
    sourceRegionId: string;
    files: number;
    used: number;
    entries: {
      sourceFile: string;
      sourceName: string;
      sourceBytes: number;
      sourceSha256: string;
      disposition: string;
      reason?: string;
    }[];
  }[];
};

/** 直辖市/港澳的素材目录 → 省级来源编号（与准备脚本一致）。 */
export const PROVINCE_SELF_SOURCE_REGION_IDS: { dir: string; sourceRegionId: string }[] = [
  { dir: "bei_jing", sourceRegionId: "11" },
  { dir: "tian_jin", sourceRegionId: "12" },
  { dir: "shang_hai", sourceRegionId: "31" },
  { dir: "chong_qing", sourceRegionId: "50" },
  { dir: "xiang_gang", sourceRegionId: "81" },
  { dir: "ao_men", sourceRegionId: "82" }
];

export const ATLAS_ENDPOINT = "/api/atlas";
export const ATLAS_MANIFEST_ID = "_manifest";

/** 白名单标识：清单里登记的文件名（含全国包）才允许读取。 */
export function listAllowedPackageIds(manifest: AtlasPackageManifest): string[] {
  return [
    manifest.national.packageFile,
    ...manifest.cityChunks.map((chunk) => chunk.file),
    ...(manifest.countyPackages ?? []).map((item) => item.file)
  ];
}

export function findProvincePackage(
  manifest: AtlasPackageManifest,
  provinceRegionId: string
): AtlasProvincePackage | undefined {
  return manifest.provinces.find((province) => province.provinceRegionId === provinceRegionId);
}

export function findCityChunk(
  manifest: AtlasPackageManifest,
  provinceRegionId: string
): AtlasPackageChunk | undefined {
  const province = findProvincePackage(manifest, provinceRegionId);
  const first = province?.chunks[0];
  if (!first) return undefined;
  return manifest.cityChunks.find((chunk) => chunk.file === first.file);
}

/** 省级是否属于“省级自身即有素材”的直辖市/港澳。 */
export function isProvinceSelfSource(
  manifest: AtlasPackageManifest,
  sourceRegionId: string
): boolean {
  return (manifest.national.nestedDirs ?? PROVINCE_SELF_SOURCE_REGION_IDS).some(
    (item) => item.sourceRegionId === sourceRegionId
  );
}

/** 某省的全部城市分片（按清单顺序）。 */
export function chunksForProvince(
  manifest: AtlasPackageManifest,
  provinceRegionId: string
): AtlasPackageChunk[] {
  const province = findProvincePackage(manifest, provinceRegionId);
  if (!province) return [];
  const byFile = new Map(manifest.cityChunks.map((chunk) => [chunk.file, chunk] as const));
  return province.chunks
    .map((chunk) => byFile.get(chunk.file))
    .filter((chunk): chunk is AtlasPackageChunk => Boolean(chunk));
}
