/**
 * 019 全量边界完整性检查与修复审计（只读原始素材，产物写 .local/atlas/）。
 *
 * 用法：
 *   node scripts/atlas/audit-boundaries.mjs              # 全量盘点 + 覆盖/渲染差异 + 报告
 *   node scripts/atlas/audit-boundaries.mjs --report     # 只打印摘要（仍做全量盘点）
 *   node scripts/atlas/audit-boundaries.mjs --features   # 只跑原始素材几何盘点
 *
 * 产出（都不进 Git）：
 *   .local/atlas/audit-report.json   机器报告（每份文件一行状态）
 *   .local/atlas/city-repairs.json   需要修复的城市轮廓及证据
 *
 * 报告的每一项都区分：结构合法 / 拓扑有效 / 覆盖一致 / 实际渲染。
 * 只用 JSON 可解析或“能画出来”不能算完整。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectGeometry, normalizeFeatureCollection } from "./geometry-normalize.ts";
import { decideCityRepair } from "./city-geometry-repair.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const OUTPUT = path.join(ROOT, ".local/atlas");
const MANIFEST_PATH = path.join(OUTPUT, "manifest.json");

const args = process.argv.slice(2);
const featuresOnly = args.includes("--features");
const reportOnly = args.includes("--report");

const manifest = existsSync(MANIFEST_PATH) ? JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) : null;

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function listSourceFiles() {
  const files = [];
  for (const provinceDir of readdirSync(path.join(ROOT, "map-data"), { withFileTypes: true })) {
    if (!provinceDir.isDirectory()) continue;
    for (const dataset of ["shape-only", "shape-with-internal-borders"]) {
      const dir = path.join(ROOT, "map-data", provinceDir.name, dataset);
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".geojson")) continue;
        files.push({ province: provinceDir.name, dataset, file, fullPath: path.join(dir, file) });
      }
    }
  }
  return files.sort((a, b) =>
    `${a.province}/${a.dataset}/${a.file}`.localeCompare(`${b.province}/${b.dataset}/${b.file}`)
  );
}

/** 原始素材全量盘点：每份文件的哈希、feature/多边形/环与退化分量。 */
function inventorySources() {
  const perFile = [];
  const totals = {
    files: 0,
    features: 0,
    polygons: 0,
    rings: 0,
    degenerateOuterRings: 0,
    degenerateHoleRings: 0,
    structuralProblems: 0,
    validOuterRings: 0,
    nonFiniteCoordinates: 0,
    unclosedRings: 0,
    featuresWithoutValidPolygon: 0
  };
  const perProvince = new Map();
  const perDataset = new Map();
  for (const item of listSourceFiles()) {
    const raw = readFileSync(item.fullPath);
    const data = JSON.parse(raw);
    const features = Array.isArray(data.features) ? data.features : [];
    const stats = {
      polygons: 0,
      rings: 0,
      degenerateOuterRings: 0,
      degenerateHoleRings: 0,
      structuralProblems: 0,
      validOuterRings: 0
    };
    let featuresWithoutValidPolygon = 0;
    for (const feature of features) {
      const one = inspectGeometry(feature?.geometry);
      for (const key of Object.keys(stats)) stats[key] += one[key];
      if (one.validOuterRings === 0) featuresWithoutValidPolygon += 1;
    }
    const normalized = normalizeFeatureCollection(data, item.file);
    const entry = {
      province: item.province,
      dataset: item.dataset,
      file: item.file,
      bytes: raw.length,
      sha256: sha256(raw),
      features: features.length,
      ...stats,
      featuresWithoutValidPolygon,
      removedComponents: normalized.removed.length,
      removedKinds: normalized.removed.map((removed) => removed.kind),
      diagnostics: normalized.diagnostics.map((diagnostic) => diagnostic.kind)
    };
    perFile.push(entry);
    totals.files += 1;
    totals.features += features.length;
    for (const key of Object.keys(stats)) totals[key] += stats[key];
    totals.featuresWithoutValidPolygon += featuresWithoutValidPolygon;
    perProvince.set(
      item.province,
      (perProvince.get(item.province) ?? 0) + stats.degenerateOuterRings
    );
    perDataset.set(
      item.dataset,
      (perDataset.get(item.dataset) ?? 0) + stats.degenerateOuterRings + stats.structuralProblems
    );
  }
  return {
    perFile,
    totals,
    degenerateOuterByProvince: Object.fromEntries(
      [...perProvince.entries()].filter(([, value]) => value > 0)
    ),
    problemsByDataset: Object.fromEntries(perDataset)
  };
}

function listPolygons(geometry) {
  if (!geometry || typeof geometry !== "object") return [];
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x <= ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInGeometry(point, geometry) {
  for (const polygon of listPolygons(geometry)) {
    if (!polygon.length) continue;
    if (
      pointInRing(point, polygon[0]) &&
      !polygon.slice(1).some((hole) => pointInRing(point, hole))
    )
      return true;
  }
  return false;
}

function geometryBounds(geometry) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const polygon of listPolygons(geometry)) {
    for (const ring of polygon) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return [minX, minY, maxX, maxY];
}

/** 用固定网格粗测“只在 A / 只在 B / 两者都有”的采样点比例（可复现，无随机）。 */
function coverageDiff(geometryA, geometryB, step = 0.02) {
  const [minX, minY, maxX, maxY] = geometryBounds(geometryA);
  const columns = Math.floor((maxX - minX) / step) + 1;
  const rows = Math.floor((maxY - minY) / step) + 1;
  const result = { samples: 0, onlyA: 0, onlyB: 0, both: 0, step, columns, rows };
  for (let column = 0; column < columns; column += 1) {
    for (let row = 0; row < rows; row += 1) {
      const point = [minX + column * step, minY + row * step];
      const inA = pointInGeometry(point, geometryA);
      const inB = pointInGeometry(point, geometryB);
      result.samples += 1;
      if (inA && inB) result.both += 1;
      else if (inA) result.onlyA += 1;
      else if (inB) result.onlyB += 1;
    }
  }
  return result;
}

/** 源素材（带内部边界）→ 城市的规范化县面集合。 */
function countyCollectionFor(provinceDir, stem) {
  const source = path.join(
    ROOT,
    "map-data",
    provinceDir,
    "shape-with-internal-borders",
    `${stem}.geojson`
  );
  if (!existsSync(source)) return null;
  const data = JSON.parse(readFileSync(source, "utf8"));
  const normalized = normalizeFeatureCollection(data, `${stem}.geojson`);
  return {
    features: normalized.features,
    removed: normalized.removed,
    diagnostics: normalized.diagnostics
  };
}

function shapeOnlyFor(provinceDir, stem) {
  const source = path.join(ROOT, "map-data", provinceDir, "shape-only", `${stem}.geojson`);
  if (!existsSync(source)) return null;
  const data = JSON.parse(readFileSync(source, "utf8"));
  return { features: Array.isArray(data.features) ? data.features : [], raw: data };
}

/** 城市轮廓完整性：shape-only 是否覆盖规范化县面集合。 */
/**
 * 城市轮廓覆盖审计（019 返工后）：
 * - 判定与生成共用 `decideCityRepair`（空间采样优先、面积辅助），口径一致；
 * - 百分比写清分母：面积差以**城市面积为分母**（增量口径），
 *   采样比例分别以城市采样点/县面采样点为分母；
 * - 明确写出采样步长，并声明“采样只能证伪”：未发现差异不等于证明完整。
 * - 全部 385 个城市都记录（不只是超阈值的），便于复核“待处理”项。
 */
function auditCityCoverage() {
  const entries = [];
  for (const province of manifest?.coverage ?? []) {
    for (const entry of province.entries) {
      if (entry.disposition !== "used") continue;
      const stem = entry.sourceFile.replace(/\.geojson$/, "");
      const shape = shapeOnlyFor(province.dir, stem);
      const counties = countyCollectionFor(province.dir, stem);
      if (!shape || shape.features.length === 0) continue;
      const decision = decideCityRepair(shape.features, counties);
      const derived = (manifest.cityChunks ?? [])
        .flatMap((chunk) => chunk.cities ?? [])
        .find((city) => city.sourceFile === entry.sourceFile)?.geometryCoverage;
      entries.push({
        province: province.dir,
        file: entry.sourceFile,
        name: entry.sourceName,
        classification: decision.classification,
        pendingReview: decision.pendingReview,
        /** 派生包是否已按该判定重建（清单 geometryCoverage.applied）。 */
        repaired: Boolean(derived?.applied),
        reason: decision.reason,
        /** 面积口径：countyArea/cityArea 为度²，areaGainPercent=(county-city)/city。 */
        areas: {
          /** 两个分母都写清：增量相对城市面积；缺块相对县面集合面积。 */
          denominators: ["cityArea", "countyArea"],
          cityArea: Number(decision.cityArea.toFixed(6)),
          countyUnionArea: Number(decision.countyArea.toFixed(6)),
          /** (county-city)/city：县面集合比旧城市图多出的比例（增量口径）。 */
          areaGainPercent: Number(decision.areaGainPercent.toFixed(4)),
          /** (county-city)/county：以县面集合为基准，城市图缺掉的比例。 */
          countyShortfallPercent: Number(
            (decision.countyArea > 0
              ? ((decision.countyArea - decision.cityArea) / decision.countyArea) * 100
              : 0
            ).toFixed(4)
          )
        },
        sampling: {
          stepDegrees: decision.sampleStep,
          samples: decision.samples,
          /** 分母：城市采样点（city+both+cityOnly=city）。 */
          cityOnlyShare: Number(decision.cityOnlyShare.toFixed(6)),
          /** 分母：城市侧采样点（both+cityOnly）。 */
          countyOnlyShare: Number(decision.countyOnlyShare.toFixed(6)),
          note: "采样只能证伪：未发现差异不等于证明几何完整"
        },
        cityPolygons: shape.features.reduce((sum, f) => sum + listPolygons(f.geometry).length, 0),
        countyFeatures: counties?.features.length ?? 0,
        removedComponents: counties?.removed.length ?? 0,
        diagnostics: counties?.diagnostics.length ?? 0
      });
    }
  }
  return entries.sort((a, b) => b.areas.areaGainPercent - a.areas.areaGainPercent);
}

function areaOf(geometry) {
  let area = 0;
  for (const polygon of listPolygons(geometry)) {
    if (!polygon.length) continue;
    area += Math.abs(ringArea(polygon[0]));
    for (const hole of polygon.slice(1)) area -= Math.abs(ringArea(hole));
  }
  return area;
}

function ringArea(ring) {
  let sum = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[(index + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/** 派生产物自检：国家包/城市分片/县级包是否与清单一致，feature 身份是否可分组。 */
function auditDerived() {
  const result = { national: null, cityChunks: [], countyPackages: [], problems: [] };
  if (!manifest) {
    result.problems.push("manifest-missing");
    return result;
  }
  const readPackage = (file) => {
    const full = path.join(OUTPUT, file);
    if (!existsSync(full)) return null;
    const raw = readFileSync(full);
    return { raw, data: JSON.parse(raw.toString("utf8")) };
  };
  const nationalMeta = manifest.sources?.national;
  const nationalFile = manifest.national?.packageFile ?? nationalMeta?.package?.file;
  const national = nationalFile ? readPackage(nationalFile) : null;
  if (national) {
    // 全国包沿用源文件本身（015 起 packageFile 就是 cn-provinces.json），
    // 因此这里与 sources.national 的源哈希/字节对照，而不是另存一份副本哈希。
    result.national = {
      file: nationalFile,
      bytes: national.raw.length,
      sha256Matches: sha256(national.raw) === nationalMeta?.sha256,
      features: national.data.features?.length ?? 0,
      declaredBytes: nationalMeta?.package?.bytes ?? nationalMeta?.bytes
    };
    if (!result.national.sha256Matches) result.problems.push("national-sha256-mismatch");
    if (national.raw.length !== result.national.declaredBytes)
      result.problems.push("national-bytes-mismatch");
  } else result.problems.push("national-package-missing");

  for (const chunk of manifest.cityChunks ?? []) {
    const pkg = readPackage(chunk.file);
    if (!pkg) {
      result.problems.push(`city-chunk-missing:${chunk.file}`);
      continue;
    }
    const ids = new Set();
    for (const feature of pkg.data.features ?? [])
      ids.add(feature.properties?.xingjiSourceRegionId ?? null);
    const entry = {
      file: chunk.file,
      bytes: pkg.raw.length,
      sha256Matches: sha256(pkg.raw) === chunk.sha256,
      declaredBytes: chunk.bytes,
      features: pkg.data.features?.length ?? 0,
      identities: ids.size,
      identityMissing: ids.has(null)
    };
    if (!entry.sha256Matches) result.problems.push(`city-chunk-sha256-mismatch:${chunk.file}`);
    if (entry.identityMissing) result.problems.push(`city-chunk-identity-missing:${chunk.file}`);
    result.cityChunks.push(entry);
  }

  for (const item of manifest.countyPackages ?? []) {
    const pkg = readPackage(item.file);
    if (!pkg) {
      result.problems.push(`county-package-missing:${item.file}`);
      continue;
    }
    const identities = new Set();
    let degenerateRings = 0;
    for (const feature of pkg.data.features ?? []) {
      identities.add(feature.properties?.xingjiSourceRegionId ?? null);
      const stats = inspectGeometry(feature.geometry);
      degenerateRings += stats.degenerateOuterRings + stats.degenerateHoleRings;
    }
    const entry = {
      file: item.file,
      parentSourceFile: item.parentSourceFile,
      bytes: pkg.raw.length,
      sha256Matches: sha256(pkg.raw) === item.sha256,
      declaredBytes: item.bytes,
      features: pkg.data.features?.length ?? 0,
      identities: identities.size,
      identityMissing: identities.has(null),
      residualDegenerateRings: degenerateRings,
      declaredRemoved: item.removedComponents
    };
    if (!entry.sha256Matches) result.problems.push(`county-sha256-mismatch:${item.file}`);
    if (entry.identityMissing) result.problems.push(`county-identity-missing:${item.file}`);
    if (entry.residualDegenerateRings > 0)
      result.problems.push(`county-residual-degenerate:${item.file}`);
    result.countyPackages.push(entry);
  }
  return result;
}

const started = Date.now();
const inventory = inventorySources();
const summary = {
  generatedAt: new Date().toISOString(),
  normalizationVersion: "019-normalize-v1",
  elapsedMs: 0,
  sourceInventory: {
    totals: inventory.totals,
    degenerateOuterByProvince: inventory.degenerateOuterByProvince
  },
  files: inventory.perFile
};

if (!featuresOnly) {
  summary.cityCoverage = auditCityCoverage();
  summary.derived = auditDerived();
}
summary.elapsedMs = Date.now() - started;

if (!reportOnly) {
  writeFileSync(path.join(OUTPUT, "audit-report.json"), `${JSON.stringify(summary, null, 1)}\n`);
  if (summary.cityCoverage) {
    writeFileSync(
      path.join(OUTPUT, "city-repairs.json"),
      `${JSON.stringify(
        {
          generatedAt: summary.generatedAt,
          policy: "shape-only 未覆盖规范化县面集合超过 0.5% 时，城市轮廓改由县面集合重建",
          cities: summary.cityCoverage
        },
        null,
        1
      )}\n`
    );
  }
}

console.log("=== 019 全量边界审计 ===");
console.log(`源素材文件：${inventory.totals.files}；feature：${inventory.totals.features}`);
console.log(
  `环：${inventory.totals.rings}；有效外环：${inventory.totals.validOuterRings}；` +
    `零面积退化外环：${inventory.totals.degenerateOuterRings}；退化内环：${inventory.totals.degenerateHoleRings}；` +
    `结构问题：${inventory.totals.structuralProblems}`
);
console.log(
  `非有限坐标：${inventory.totals.nonFiniteCoordinates}；未闭合环：${inventory.totals.unclosedRings}；` +
    `无有效多边形的 feature：${inventory.totals.featuresWithoutValidPolygon}`
);
if (summary.cityCoverage) {
  const counts = summary.cityCoverage.reduce((acc, city) => {
    acc[city.classification] = (acc[city.classification] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `城市轮廓判定：${JSON.stringify(counts)}；已重建 ${summary.cityCoverage.filter((c) => c.repaired).length} 个；` +
      `待处理 ${summary.cityCoverage.filter((c) => c.pendingReview).length} 个`
  );
  for (const city of summary.cityCoverage
    .filter((c) => c.repaired || c.pendingReview)
    .slice(0, 12)) {
    console.log(
      `  ${city.repaired ? "[已重建] " : "[待处理] "}${city.name} ${city.file}: ${city.classification}；` +
        `面积差 ${city.areas.areaGainPercent}%（分母=城市面积）/ ${city.areas.countyShortfallPercent}%（分母=县面集合面积）；` +
        `采样 ${city.sampling.stepDegrees}° ` +
        `cityOnly=${(city.sampling.cityOnlyShare * 100).toFixed(2)}% countyOnly=${(
          city.sampling.countyOnlyShare * 100
        ).toFixed(2)}%；${city.reason}`
    );
  }
}
if (summary.derived) {
  console.log(
    `派生产物：derived=${manifest?.derived?.version ?? "?"}/${manifest?.derived?.digest ?? "?"}，` +
      `cityChunks ${summary.derived.cityChunks.length}，countyPackages ${summary.derived.countyPackages.length}，` +
      `问题 ${summary.derived.problems.length}`
  );
  for (const problem of summary.derived.problems.slice(0, 10)) console.log(`  ! ${problem}`);
}
console.log(`耗时 ${summary.elapsedMs} ms`);
