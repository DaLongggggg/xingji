/**
 * 应用地区目录（014-C）。
 *
 * 地区**身份属于应用**：`RegionId` 是应用自己的稳定字面 ID（`xingji-cn:p-<来源编号>` /
 * `xingji-cn:c-<来源编号>`），不把地图供应商命名空间写进业务身份，也不冒充官方六位 adcode。
 * 来源编号只用于可追溯与显式映射（见 `region-boundary-map.ts`）。
 *
 * 首期覆盖（2026-09-14）：
 * - 全国省级 34 条（含直辖市、港澳台；它们只有省级，本轮不伪造市级目录）；
 * - 广东省级下的 21 个地级市。
 *
 * 目录内容核对依据（只读核对，未打包数据）：
 * - 来源仓库 `yezongyang/china-geojson`，commit `33cd37ab22628858654d839f5d88a2deec372463`（2020-01-06）；
 * - `china.json` 54,426 B / git blob `3ba8e748bcfed52bf433090761b0b4afaea0dfd4`；
 * - `geometryProvince/44.json` 43,362 B / git blob `96af0165eac8ada1f3d45b385b884c19073ad6d0`；
 * - 通过 GitHub blob API 读取 `properties.id` / `properties.name` 逐条抄录；未补零、未按名称模糊匹配。
 *
 * 许可仍未决（源仓库 `license: null`）：本项目只使用编号与名称建立映射，不打包、不分发几何。
 */

import { GENERATED_CITY_REGIONS, GENERATED_CITY_REGION_COUNT } from "./region-catalog-cities";

export type RegionLevel = "province" | "city";

export type Region = {
  regionId: string;
  name: string;
  level: RegionLevel;
  parentRegionId: string | null;
  /** 目录版本；用于判断已存关联是否来自当前目录。 */
  catalogVersion: string;
  /**
   * 来源编号，仅用于映射与追溯，不作为业务身份。
   * 既有 014-C 地区是数字编号；015 新城市是素材文件名标识（带声调拼音）。
   */
  sourceRegionId: string;
  /** 素材文件名（仅 015 生成的城市目录带此字段）。 */
  sourceFile?: string;
};

export type RegionCatalog = {
  version: string;
  regions: Region[];
  byId: Map<string, Region>;
};

/**
 * 目录版本：014-C 与 015 的全国城市目录共用同一来源基线（china.json 2020-01-06 提交），
 * 因此既有引用的 `catalogVersion` 仍然有效。
 */
export const REGION_CATALOG_VERSION = "xingji-cn-2020-01-06";

export const REGION_ID_PREFIX = "xingji-cn";

export function provinceRegionId(sourceRegionId: string): string {
  return `${REGION_ID_PREFIX}:p-${sourceRegionId}`;
}

export function cityRegionId(sourceRegionId: string): string {
  return `${REGION_ID_PREFIX}:c-${sourceRegionId}`;
}

/** 全国省级（来源 `china.json` 的 34 个 feature，按来源顺序抄录）。 */
const PROVINCE_SOURCES: { sourceRegionId: string; name: string }[] = [
  { sourceRegionId: "65", name: "新疆维吾尔自治区" },
  { sourceRegionId: "54", name: "西藏自治区" },
  { sourceRegionId: "15", name: "内蒙古自治区" },
  { sourceRegionId: "63", name: "青海省" },
  { sourceRegionId: "51", name: "四川省" },
  { sourceRegionId: "23", name: "黑龙江省" },
  { sourceRegionId: "62", name: "甘肃省" },
  { sourceRegionId: "53", name: "云南省" },
  { sourceRegionId: "45", name: "广西壮族自治区" },
  { sourceRegionId: "43", name: "湖南省" },
  { sourceRegionId: "61", name: "陕西省" },
  { sourceRegionId: "44", name: "广东省" },
  { sourceRegionId: "22", name: "吉林省" },
  { sourceRegionId: "13", name: "河北省" },
  { sourceRegionId: "42", name: "湖北省" },
  { sourceRegionId: "52", name: "贵州省" },
  { sourceRegionId: "37", name: "山东省" },
  { sourceRegionId: "36", name: "江西省" },
  { sourceRegionId: "41", name: "河南省" },
  { sourceRegionId: "21", name: "辽宁省" },
  { sourceRegionId: "14", name: "山西省" },
  { sourceRegionId: "34", name: "安徽省" },
  { sourceRegionId: "35", name: "福建省" },
  { sourceRegionId: "33", name: "浙江省" },
  { sourceRegionId: "32", name: "江苏省" },
  { sourceRegionId: "50", name: "重庆市" },
  { sourceRegionId: "64", name: "宁夏回族自治区" },
  { sourceRegionId: "46", name: "海南省" },
  { sourceRegionId: "71", name: "台湾省" },
  { sourceRegionId: "11", name: "北京市" },
  { sourceRegionId: "12", name: "天津市" },
  { sourceRegionId: "31", name: "上海市" },
  { sourceRegionId: "81", name: "香港特别行政区" },
  { sourceRegionId: "82", name: "澳门特别行政区" }
];

/** 广东 21 个地级市（来源 `geometryProvince/44.json`，按来源顺序抄录）。 */
const GUANGDONG_CITY_SOURCES: { sourceRegionId: string; sourceFile: string; name: string }[] = [
  { sourceRegionId: "4418", sourceFile: "guang3_dong1_qing1_yuan3", name: "清远市" },
  { sourceRegionId: "4402", sourceFile: "guang3_dong1_shao2_guan1", name: "韶关市" },
  { sourceRegionId: "4408", sourceFile: "guang3_dong1_zhan4_jiang1", name: "湛江市" },
  { sourceRegionId: "4414", sourceFile: "guang3_dong1_mei2_zhou1", name: "梅州市" },
  { sourceRegionId: "4416", sourceFile: "guang3_dong1_he2_yuan2", name: "河源市" },
  { sourceRegionId: "4412", sourceFile: "guang3_dong1_zhao4_qing4", name: "肇庆市" },
  { sourceRegionId: "4413", sourceFile: "guang3_dong1_hui4_zhou1", name: "惠州市" },
  { sourceRegionId: "4409", sourceFile: "guang3_dong1_mao4_ming2", name: "茂名市" },
  { sourceRegionId: "4407", sourceFile: "guang3_dong1_jiang1_men2", name: "江门市" },
  { sourceRegionId: "4417", sourceFile: "guang3_dong1_yang2_jiang1", name: "阳江市" },
  { sourceRegionId: "4453", sourceFile: "guang3_dong1_yun2_fu2", name: "云浮市" },
  { sourceRegionId: "4401", sourceFile: "guang3_dong1_guang3_zhou1", name: "广州市" },
  { sourceRegionId: "4415", sourceFile: "guang3_dong1_shan4_wei3", name: "汕尾市" },
  { sourceRegionId: "4452", sourceFile: "guang3_dong1_jie1_yang2", name: "揭阳市" },
  { sourceRegionId: "4404", sourceFile: "guang3_dong1_zhu1_hai3", name: "珠海市" },
  { sourceRegionId: "4406", sourceFile: "guang3_dong1_fo2_shan1", name: "佛山市" },
  { sourceRegionId: "4451", sourceFile: "guang3_dong1_chao2_zhou1", name: "潮州市" },
  { sourceRegionId: "4405", sourceFile: "guang3_dong1_shan4_tou2", name: "汕头市" },
  { sourceRegionId: "4403", sourceFile: "guang3_dong1_shen1_zhen4", name: "深圳市" },
  { sourceRegionId: "4419", sourceFile: "guang3_dong1_dong1_guan1", name: "东莞市" },
  { sourceRegionId: "4420", sourceFile: "guang3_dong1_zhong1_shan1", name: "中山市" }
];

export const GUANGDONG_PROVINCE_SOURCE_ID = "44";

function buildRegions(): Region[] {
  const regions: Region[] = PROVINCE_SOURCES.map((item) => ({
    regionId: provinceRegionId(item.sourceRegionId),
    name: item.name,
    level: "province" as const,
    parentRegionId: null,
    catalogVersion: REGION_CATALOG_VERSION,
    sourceRegionId: item.sourceRegionId
  }));
  const guangdongId = provinceRegionId(GUANGDONG_PROVINCE_SOURCE_ID);
  for (const item of GUANGDONG_CITY_SOURCES) {
    regions.push({
      regionId: cityRegionId(item.sourceRegionId),
      name: item.name,
      level: "city",
      parentRegionId: guangdongId,
      catalogVersion: REGION_CATALOG_VERSION,
      sourceRegionId: item.sourceRegionId,
      sourceFile: item.sourceFile
    });
  }
  return regions;
}

/**
 * 全国城市目录（015）：由 `scripts/atlas/prepare-atlas.mjs` 从素材生成，
 * 只含身份与显示名；几何在本地数据包里，不进入 bundle。
 * 与手写的广东 21 市可能重名，按 `regionId` 去重并**保留手写条目**（既有引用优先）。
 */
export const REGION_CATALOG: RegionCatalog = (() => {
  const handWritten = buildRegions();
  const handWrittenIds = new Set(handWritten.map((region) => region.regionId));
  const generated = GENERATED_CITY_REGIONS.filter((region) => !handWrittenIds.has(region.regionId));
  const regions = [...handWritten, ...generated];
  return {
    version: REGION_CATALOG_VERSION,
    regions,
    byId: new Map(regions.map((region) => [region.regionId, region] as const))
  };
})();

/** 目录来源统计（供测试与清单核对）。 */
export const REGION_CATALOG_STATS = {
  provinces: REGION_CATALOG.regions.filter((region) => region.level === "province").length,
  cities: REGION_CATALOG.regions.filter((region) => region.level === "city").length,
  generatedCities: GENERATED_CITY_REGION_COUNT
};

export function findRegion(
  regionId: string,
  catalog: RegionCatalog = REGION_CATALOG
): Region | undefined {
  return catalog.byId.get(regionId);
}

/**
 * 同一地区的多套目录身份归一（014-C 手写数字 ID 与 015 生成拼音 ID 并存）。
 *
 * 广东 21 市既有 `xingji-cn:c-4401`，015 又生成了 `xingji-cn:c-guang3_dong1_guang3_zhou1`，
 * 两者 sourceFile 相同 = 同一实际地区。已存关联两种都合法，读模型（显色/计数/卡片）
 * 必须合并到**既有 ID**，否则「先到先得」的几何映射会漏掉另一套身份的记录。
 * 只归一读模型查询；已存关联的 regionId 不改写。
 */
const CANONICAL_REGION_ID_BY_ALIAS: ReadonlyMap<string, string> = (() => {
  const canonicalBySourceFile = new Map<string, string>();
  for (const region of REGION_CATALOG.regions) {
    if (!region.sourceFile) continue;
    // 目录顺序：手写条目在生成条目之前 → 首个即既有身份。
    if (!canonicalBySourceFile.has(region.sourceFile)) {
      canonicalBySourceFile.set(region.sourceFile, region.regionId);
    }
  }
  const aliases = new Map<string, string>();
  for (const region of REGION_CATALOG.regions) {
    if (!region.sourceFile) continue;
    const canonical = canonicalBySourceFile.get(region.sourceFile);
    if (canonical && canonical !== region.regionId) aliases.set(region.regionId, canonical);
  }
  return aliases;
})();

export function canonicalRegionId(regionId: string): string {
  return CANONICAL_REGION_ID_BY_ALIAS.get(regionId) ?? regionId;
}

export function listProvinces(catalog: RegionCatalog = REGION_CATALOG): Region[] {
  return catalog.regions.filter((region) => region.level === "province");
}

export function listCities(
  provinceRegionIdValue: string,
  catalog: RegionCatalog = REGION_CATALOG
): Region[] {
  const seen = new Set<string>();
  return catalog.regions.filter((region) => {
    if (region.level !== "city" || region.parentRegionId !== provinceRegionIdValue) return false;
    const id = canonicalRegionId(region.regionId);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function listCityRegions(catalog: RegionCatalog = REGION_CATALOG): Region[] {
  return catalog.regions.filter((region) => region.level === "city");
}
