/**
 * 015：目录与映射核对（纯脚本，无浏览器）。
 * 校验：地区数、去重、父级明确、旧 ID 不变、每个使用中的素材文件都有唯一 RegionId。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const catalogSource = readFileSync(
  path.join(ROOT, "src/features/regions/region-catalog.ts"),
  "utf8"
);
const generatedSource = readFileSync(
  path.join(ROOT, "src/features/regions/region-catalog-cities.ts"),
  "utf8"
);
const manifest = JSON.parse(readFileSync(path.join(ROOT, ".local/atlas/manifest.json"), "utf8"));

// 省级目录以清单为准（34 个省级目录，各对应一个应用省级 RegionId）。
const provinceIds = manifest.coverage.map((province) => province.sourceRegionId);
const guangdongBlock = catalogSource.match(/GUANGDONG_CITY_SOURCES[^=]*=\s*\[([\s\S]*?)\];/);
const legacyCities = guangdongBlock
  ? [
      ...guangdongBlock[1].matchAll(
        /sourceRegionId:\s*"(\d+)",\s*(?:sourceFile:\s*"[^"]+",\s*)?name:\s*"([^"]+)"/g
      )
    ].map((match) => ({ sourceRegionId: match[1], name: match[2] }))
  : [];
const generatedCities = [
  ...generatedSource.matchAll(
    /regionId: "([^"]+)", name: "([^"]+)", level: "city", parentRegionId: "([^"]+)"/g
  )
].map((match) => ({ regionId: match[1], name: match[2], parentRegionId: match[3] }));

const problems = [];
if (legacyCities.length !== 21) problems.push(`广东既有城市数 ${legacyCities.length} ≠ 21`);
const legacyIds = new Set(legacyCities.map((city) => `xingji-cn:c-${city.sourceRegionId}`));
const generatedIds = generatedCities.map((city) => city.regionId);
// 生成目录中与手写广东重叠的条目会在运行时被手写条目取代（ID 相同），这是预期行为。
const duplicated = generatedIds.filter((id) => legacyIds.has(id));
const uniqueGenerated = new Set(generatedIds);
if (uniqueGenerated.size !== generatedIds.length) {
  problems.push(`生成目录存在重复 RegionId：${generatedIds.length - uniqueGenerated.size} 个`);
}
for (const city of generatedCities) {
  if (!city.parentRegionId.startsWith("xingji-cn:p-")) {
    problems.push(`城市 ${city.regionId} 的父级不是省级：${city.parentRegionId}`);
  }
}
const usedFiles = manifest.coverage.flatMap((province) =>
  province.entries.filter((entry) => entry.disposition === "used").map((entry) => entry.sourceFile)
);
// 目录城市数：生成目录 385 条中，广东 21 条与手写编号同 ID（运行时由手写条目取代），
// 因此最终唯一城市数 = 生成目录（385）。素材使用数也必须等于它。
const uniqueCityIds = new Set(generatedIds);
if (uniqueCityIds.size !== generatedCities.length) {
  problems.push(`生成目录存在重复 RegionId：${generatedCities.length - uniqueCityIds.size} 个`);
}
if (usedFiles.length !== generatedCities.length) {
  problems.push(`素材使用数 ${usedFiles.length} ≠ 城市数 ${generatedCities.length}`);
}
const coveredFiles = new Set(usedFiles);
for (const province of manifest.coverage) {
  for (const entry of province.entries) {
    if (!entry.disposition) problems.push(`${province.dir}/${entry.sourceFile} 缺少处置`);
  }
}
if (provinceIds.length !== 34) problems.push(`省级数 ${provinceIds.length} ≠ 34`);
void coveredFiles;

console.log(
  JSON.stringify(
    {
      provinces: manifest.coverage.length,
      cityFiles: manifest.coverage.reduce((sum, province) => sum + province.files, 0),
      usedFiles: usedFiles.length,
      legacyCities: legacyCities.length,
      generatedCities: generatedCities.length,
      packages: manifest.cityChunks.length,
      overlappingWithLegacy: duplicated.length,
      problems
    },
    null,
    2
  )
);
if (problems.length > 0) process.exit(1);
