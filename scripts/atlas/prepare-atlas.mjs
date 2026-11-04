/**
 * 015 地图素材准备与全量校验脚本。
 *
 * 用法：
 *   node scripts/atlas/prepare-atlas.mjs            # 盘点 + 校验 + 生成产物（默认）
 *   node scripts/atlas/prepare-atlas.mjs --check    # 只校验素材与已提交清单/产物是否一致
 *   node scripts/atlas/prepare-atlas.mjs --report   # 只做盘点报告
 *   node scripts/atlas/prepare-atlas.mjs --download # 先按固定版本获取缺失的全国边界
 *
 * 只读取 map-data/（只读素材），只写入 .local/atlas/（Git 忽略产物）与
 * src/features/regions/region-catalog-cities.ts（生成的目录数据）。
 * 不执行上游代码、不改写素材、不把素材复制进 bundle 或 public。
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeFeatureCollection } from "./geometry-normalize.ts";
import { decideCityRepair, mergeFeatureGeometries } from "./city-geometry-repair.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

const ATLAS_OUTPUT_DIR = ".local/atlas";
const CITY_SOURCE = {
  sourceId: "echarts-cities-shape-only",
  sourceVersion: "e3318090406a64c48fd26a4020b11ea6b590a007",
  assetRoot: "map-data",
  assetSubdir: "shape-only"
};
const NATIONAL_SOURCE = {
  sourceId: "local-json-cn",
  sourceVersion: "33cd37ab22628858654d839f5d88a2deec372463+7aa2c5fabc6a892015625898c3482874b233f9de",
  localFileName: "cn-provinces.json",
  gitBlobSha1: "3ba8e748bcfed52bf433090761b0b4afaea0dfd4",
  bytes: 192361,
  sha256: "6b90035b03d179507c0b760463534dec799652d2904c88b4d9928e451be5c4d2",
  base: {
    bytes: 54426,
    gitBlobSha1: "3ba8e748bcfed52bf433090761b0b4afaea0dfd4",
    blobUrl: "https://api.github.com/repos/yezongyang/china-geojson/contents/china.json?ref=33cd37ab22628858654d839f5d88a2deec372463"
  },
  refinements: [
    {
      sourceRegionId: "81", name: "香港特别行政区", sourceFile: "province/香港特别行政区.json",
      localFileName: "source-hongkong.json", features: 18, bytes: 132724,
      gitBlobSha1: "66928b7703a210bc0f1bc617b5b12655423bd854",
      sha256: "f8347f9c8c34712a97ff95f7c052b77f3772ad128e9d3408b8a6746dc0deaf29"
    },
    {
      sourceRegionId: "82", name: "澳门特别行政区", sourceFile: "province/澳门特别行政区.json",
      localFileName: "source-macau.json", features: 8, bytes: 13422,
      gitBlobSha1: "04df1093921427087c9d4e9be293e46b726e5ccc",
      sha256: "0fddffcb05ab2814fed602600e39cdaf777c605c1fb5e2188d7d92022254f52a"
    }
  ]
};
const PACKAGE_MAX_BYTES = 10 * 1024 * 1024;
const PROVINCE_DIRECTORIES = [
  ["bei_jing", "11"],
  ["tian_jin", "12"],
  ["he_bei", "13"],
  ["shan_xi", "14"],
  ["nei_meng_gu", "15"],
  ["liao_ning", "21"],
  ["ji_lin", "22"],
  ["hei_long_jiang", "23"],
  ["shang_hai", "31"],
  ["jiang_su", "32"],
  ["zhe_jiang", "33"],
  ["an_hui", "34"],
  ["fu_jian", "35"],
  ["jiang_xi", "36"],
  ["shan_dong", "37"],
  ["he_nan", "41"],
  ["hu_bei", "42"],
  ["hu_nan", "43"],
  ["guang_dong", "44"],
  ["guang_xi", "45"],
  ["hai_nan", "46"],
  ["chong_qing", "50"],
  ["si_chuan", "51"],
  ["gui_zhou", "52"],
  ["yun_nan", "53"],
  ["xi_zang", "54"],
  ["shaan_xi", "61"],
  ["gan_su", "62"],
  ["qing_hai", "63"],
  ["ning_xia", "64"],
  ["xin_jiang", "65"],
  ["tai_wan", "71"],
  ["xiang_gang", "81"],
  ["ao_men", "82"]
];
const PROVINCE_SELF = new Set([
  "bei_jing",
  "tian_jin",
  "shang_hai",
  "chong_qing",
  "xiang_gang",
  "ao_men"
]);
const FATAL_EXTRA = new Set(["guang3_dong1_dong1_sha1_qun2_dao3"]);
/**
 * 既有 014-C 的 21 个广东城市 RegionId 必须保持不变。这里从**现有目录源文件**读出
 * 名称→编号对照（不重复维护数字），再按文件名里的中文简称匹配；匹配不到就不使用旧编号。
 */
function readLegacyGuangdongRegionIds() {
  const source = readFileSync(path.join(ROOT, "src/features/regions/region-catalog.ts"), "utf8");
  const block = source.match(/GUANGDONG_CITY_SOURCES[^=]*=\s*\[([\s\S]*?)\];/);
  const rows = block
    ? [...block[1].matchAll(/sourceRegionId:\s*"(\d+)",\s*name:\s*"([^"]+)"/g)].map((match) => ({
        sourceRegionId: match[1],
        name: match[2]
      }))
    : [];
  const byName = new Map();
  for (const row of rows) {
    // “广州市” → “广州”；现有名称统一带“市”，这是 014-C 的既有显示名，不改。
    byName.set(row.name.endsWith("市") ? row.name.slice(0, -1) : row.name, row.sourceRegionId);
  }
  return byName;
}

/** 广东既有城市：显示名沿用“广州市”这类既有写法。 */
const LEGACY_GUANGDONG_NAMES = new Set(["guang_dong"]);

/** 台湾素材用繁体与县级名，保持来源原名。 */
const KEEP_SOURCE_NAME = new Set(["tai_wan"]);

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function parseArgs(argv) {
  return {
    check: argv.includes("--check"),
    report: argv.includes("--report"),
    download: argv.includes("--download")
  };
}

/** 几何校验：只接受 Polygon / MultiPolygon，坐标有限、环闭合、顶点数合法。 */
function validateGeometry(geometry, context) {
  const problems = [];
  if (!geometry || typeof geometry !== "object") {
    return [`${context}: 缺少 geometry`];
  }
  if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") {
    return [`${context}: 不支持的 geometry 类型 ${geometry.type}`];
  }
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  if (!Array.isArray(polygons) || polygons.length === 0) {
    problems.push(`${context}: 空几何`);
    return problems;
  }
  polygons.forEach((rings, polygonIndex) => {
    if (!Array.isArray(rings) || rings.length === 0) {
      problems.push(`${context}: 第 ${polygonIndex} 个面没有环`);
      return;
    }
    rings.forEach((ring, ringIndex) => {
      if (!Array.isArray(ring) || ring.length < 4) {
        problems.push(`${context}: 面 ${polygonIndex} 环 ${ringIndex} 顶点不足`);
        return;
      }
      let finite = true;
      for (const point of ring) {
        if (
          !Array.isArray(point) ||
          point.length < 2 ||
          !Number.isFinite(point[0]) ||
          !Number.isFinite(point[1])
        ) {
          finite = false;
          break;
        }
      }
      if (!finite) {
        problems.push(`${context}: 面 ${polygonIndex} 环 ${ringIndex} 坐标非法`);
        return;
      }
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) {
        problems.push(`${context}: 面 ${polygonIndex} 环 ${ringIndex} 未闭合`);
      }
    });
  });
  return problems;
}

async function fetchPinnedBlob(blobUrl, bytesExpected, shaExpected) {
  const response = await fetch(blobUrl, {
    headers: { "user-agent": "xingji-atlas-prepare" }
  });
  if (!response.ok) {
    throw new Error(`获取边界失败：HTTP ${response.status}`);
  }
  const payload = await response.json();
  const bytes = Buffer.from(payload.content, "base64");
  const gitSha = createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest("hex");
  if (bytes.length !== bytesExpected || payload.sha !== shaExpected || gitSha !== shaExpected) {
    throw new Error(`边界来源哈希或字节不符：${blobUrl}`);
  }
  return bytes;
}

async function ensureNationalSource() {
  const output = path.join(ROOT, ATLAS_OUTPUT_DIR);
  mkdirSync(output, { recursive: true });
  const refinements = [];
  for (const item of NATIONAL_SOURCE.refinements) {
    const target = path.join(output, item.localFileName);
    let bytes = existsSync(target) ? readFileSync(target) : null;
    if (!bytes || bytes.length !== item.bytes || sha256(bytes) !== item.sha256) {
      const url = `https://api.github.com/repos/zhChuXiao/ChinaGeoJson/contents/province/${encodeURIComponent(item.sourceFile.split("/").at(-1))}?ref=7aa2c5fabc6a892015625898c3482874b233f9de`;
      bytes = await fetchPinnedBlob(url, item.bytes, item.gitBlobSha1);
      if (sha256(bytes) !== item.sha256) throw new Error(`${item.name} 来源 SHA256 不符`);
      writeFileSync(target, bytes);
    }
    refinements.push({ ...item, bytes });
  }
  const target = path.join(output, NATIONAL_SOURCE.localFileName);
  if (existsSync(target)) {
    const current = readFileSync(target);
    if (current.length === NATIONAL_SOURCE.bytes && sha256(current) === NATIONAL_SOURCE.sha256) return;
  }
  const base = await fetchPinnedBlob(
    NATIONAL_SOURCE.base.blobUrl,
    NATIONAL_SOURCE.base.bytes,
    NATIONAL_SOURCE.base.gitBlobSha1
  );
  const national = JSON.parse(base.toString("utf8"));
  if (national?.type !== "FeatureCollection" || national.features?.length !== 34) {
    throw new Error("原全国包不是 34 个省份");
  }
  for (const item of refinements) {
    const parsed = JSON.parse(item.bytes.toString("utf8"));
    const normalized = normalizeFeatureCollection(parsed, item.sourceFile);
    if (normalized.features.length !== item.features || normalized.removed.length || normalized.diagnostics.length) {
      throw new Error(`${item.name} 几何校验未通过`);
    }
    const feature = national.features.find((entry) => entry.properties?.id === item.sourceRegionId);
    if (!feature || feature.properties.name !== item.name) throw new Error(`${item.name} 与全国目录不匹配`);
    feature.geometry = mergeFeatureGeometries(normalized.features);
  }
  const derived = JSON.stringify(national);
  if (Buffer.byteLength(derived) !== NATIONAL_SOURCE.bytes || sha256(derived) !== NATIONAL_SOURCE.sha256) {
    throw new Error("港澳细化后的全国包摘要不符");
  }
  writeFileSync(target, derived);
}

/** 盘点 + 校验 392 份城市素材，返回每省的处理结果。 */
const LEGACY_GUANGDONG_REGION_IDS = readLegacyGuangdongRegionIds();

function inventoryCities() {
  const provinces = [];
  const issues = [];
  const seenStems = new Map();
  for (const [dir, sourceRegionId] of PROVINCE_DIRECTORIES) {
    const assetDir = path.join(ROOT, CITY_SOURCE.assetRoot, dir, CITY_SOURCE.assetSubdir);
    if (!existsSync(assetDir)) {
      issues.push(`${dir}: 缺少素材目录`);
      continue;
    }
    const files = readdirSync(assetDir)
      .filter((name) => name.endsWith(".geojson"))
      .sort();
    const children = [];
    for (const file of files) {
      const full = path.join(assetDir, file);
      const text = readFileSync(full, "utf8");
      const stem = file.replace(/\.geojson$/, "");
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        issues.push(`${dir}/${file}: 不是有效 JSON`);
        continue;
      }
      if (parsed?.type !== "FeatureCollection" || !Array.isArray(parsed.features)) {
        issues.push(`${dir}/${file}: 不是 FeatureCollection`);
        continue;
      }
      if (parsed.features.length === 0) {
        issues.push(`${dir}/${file}: 没有 feature`);
        continue;
      }
      if (seenStems.has(stem)) {
        issues.push(`文件标识重复：${stem}（${seenStems.get(stem)} 与 ${dir}）`);
      }
      seenStems.set(stem, dir);
      parsed.features.forEach((feature, index) => {
        issues.push(...validateGeometry(feature?.geometry, `${dir}/${file}#${index}`));
      });
      const rawName = String(parsed.features[0]?.properties?.name ?? "").trim();
      if (!rawName) {
        issues.push(`${dir}/${file}: 缺少 properties.name`);
      }
      const isExtra = FATAL_EXTRA.has(stem);
      const isProvinceSelf =
        PROVINCE_SELF.has(dir) && parsed.features.length === 1 && rawName.startsWith("");
      // 显示名只用来源核对结果；既有广东城市沿用“广州市”这类既有写法，其余保持来源原名。
      const legacyRegionId = LEGACY_GUANGDONG_REGION_IDS.get(rawName);
      const displayName =
        LEGACY_GUANGDONG_NAMES.has(dir) && legacyRegionId ? `${rawName}市` : rawName;
      children.push({
        stem,
        legacyRegionId,
        fileName: file,
        sourceBytes: Buffer.byteLength(text, "utf8"),
        sourceSha256: sha256(text),
        featureCount: parsed.features.length,
        sourceName: rawName,
        displayName,
        disposition: isExtra
          ? "historical-extra"
          : isProvinceSelf && rawName === displayName
            ? "province-self"
            : "used",
        reason: isExtra ? "广东素材中的额外项，不作为地级市" : undefined
      });
    }
    provinces.push({ dir, sourceRegionId, files, children });
  }
  return { provinces, issues };
}

/**
 * 019：判断某城市是否需要由县面集合重建轮廓，并返回规范化后的县面 feature。
 * 只读原始素材；不命中阈值时返回 `{repair:false}`，保持原有派生输出。
 */
function resolveCityRepair(provinceDir, fileName, shapeOnly) {
  const countyPath = path.join(
    ROOT,
    CITY_SOURCE.assetRoot,
    provinceDir,
    "shape-with-internal-borders",
    fileName
  );
  if (!existsSync(countyPath)) {
    return {
      repair: false,
      classification: "unavailable",
      pendingReview: true,
      reason: "没有同源带内部边界素材",
      cityArea: 0,
      countyArea: 0,
      areaGainPercent: 0,
      sampleStep: 0,
      samples: { city: 0, both: 0, cityOnly: 0, countyOnly: 0 },
      cityOnlyShare: 0,
      countyOnlyShare: 0
    };
  }
  const normalized = normalizeFeatureCollection(
    JSON.parse(readFileSync(countyPath, "utf8")),
    fileName
  );
  // 019 返工：县面集合自身有非空 diagnostics 时不得作为修复依据（也不得发布改形结果）。
  const decision =
    normalized.diagnostics.length > 0
      ? {
          repair: false,
          classification: "unavailable",
          pendingReview: true,
          reason: `县面集合存在 ${normalized.diagnostics.length} 项几何诊断，修复依据不可靠`,
          cityArea: 0,
          countyArea: 0,
          areaGainPercent: 0,
          sampleStep: 0,
          samples: { city: 0, both: 0, cityOnly: 0, countyOnly: 0 },
          cityOnlyShare: 0,
          countyOnlyShare: 0
        }
      : decideCityRepair(shapeOnly.features ?? [], normalized);
  return {
    ...decision,
    fileName,
    removedComponents: normalized.removed.length,
    diagnostics: normalized.diagnostics.length,
    features: decision.repair ? normalized.features : undefined,
    mergedGeometry: decision.repair ? mergeFeatureGeometries(normalized.features) : undefined
  };
}

function buildCityPackages(provinces) {
  const packages = [];
  for (const province of provinces) {
    const used = province.children.filter((child) => child.disposition === "used");
    if (used.length === 0) {
      packages.push({
        provinceRegionId: `xingji-cn:p-${province.sourceRegionId}`,
        provinceSourceRegionId: province.sourceRegionId,
        chunks: [],
        note: PROVINCE_SELF.has(province.dir)
          ? "直辖市/港澳：保留省级入口，不生成同名子级。"
          : "没有可作为城市的素材。"
      });
      continue;
    }
    const chunks = [];
    let current = { cities: [], bytes: 0 };
    for (const child of used) {
      const text = readFileSync(
        path.join(
          ROOT,
          CITY_SOURCE.assetRoot,
          province.dir,
          CITY_SOURCE.assetSubdir,
          child.fileName
        ),
        "utf8"
      );
      /**
       * 019：个别城市的 shape-only 只覆盖县面集合的一部分（实测 9 个缺 11%~92%）。
       * 这类空洞不用填色/凸包掩盖，而是以同源“带内部边界”素材的规范化县面集合
       * 重建该城市轮廓（保留全部多部件、岛屿与真实内环）。
       */
      const repair = resolveCityRepair(province.dir, child.fileName, JSON.parse(text));
      // 分片按“单响应 10 MiB”切分：保留完整 feature，不删 feature 躲上限。
      if (current.bytes > 0 && current.bytes + child.sourceBytes > PACKAGE_MAX_BYTES) {
        chunks.push(current);
        current = { cities: [], bytes: 0 };
      }
      current.cities.push({
        sourceRegionId: child.stem,
        name: child.displayName,
        file: child.fileName,
        bytes: child.sourceBytes,
        sha256: child.sourceSha256,
        text,
        repair
      });
      current.bytes += child.sourceBytes;
    }
    if (current.cities.length > 0) chunks.push(current);

    const files = chunks.map((chunk, index) => {
      const featureCollection = { type: "FeatureCollection", features: [] };
      for (const city of chunk.cities) {
        const parsed = JSON.parse(city.text);
        // 素材只有 name；来源身份由文件名显式注入（不猜、不改原始素材）。
        if (city.repair?.repair && city.repair.mergedGeometry) {
          /**
           * 修复路径：用规范化县面集合的**全部多边形**合并成一个几何，
           * 与 shape-only 素材一样是“一个 feature 代表一个城市”，
           * 因此不会违反“同一数据包里地区 ID 唯一”的校验，
           * 同时保留全部多部件、岛屿与真实内环。
           */
          featureCollection.features.push({
            type: "Feature",
            properties: { name: city.name, xingjiSourceRegionId: city.sourceRegionId },
            geometry: city.repair.mergedGeometry
          });
          continue;
        }
        for (const feature of parsed.features) {
          featureCollection.features.push({
            ...feature,
            properties: { ...feature.properties, xingjiSourceRegionId: city.sourceRegionId }
          });
        }
      }
      const text = JSON.stringify(featureCollection);
      const fileName = `c-p-${province.sourceRegionId}-${index + 1}.json`;
      return {
        fileName,
        bytes: Buffer.byteLength(text, "utf8"),
        sha256: sha256(text),
        cities: chunk.cities.map((city) => ({
          sourceRegionId: city.sourceRegionId,
          name: city.name,
          sourceFile: city.file,
          sourceBytes: city.bytes,
          sourceSha256: city.sha256,
          // 019：轮廓修复审计（未触发修复的城市不写这个字段，保持 015 清单原样）。
          // 019：完整覆盖证据（含未修复城市），支撑审计与“待处理”判定。
          geometryCoverage: {
            version: "019-coverage-v2",
            classification: city.repair?.classification ?? "unavailable",
            pendingReview: Boolean(city.repair?.pendingReview),
            reason: city.repair?.reason ?? "",
            cityArea: Number((city.repair?.cityArea ?? 0).toFixed(6)),
            countyArea: Number((city.repair?.countyArea ?? 0).toFixed(6)),
            areaGainPercent: Number((city.repair?.areaGainPercent ?? 0).toFixed(4)),
            countyShortfallPercent: Number(
              ((city.repair?.countyArea ?? 0) > 0
                ? (((city.repair?.countyArea ?? 0) - (city.repair?.cityArea ?? 0)) /
                    (city.repair?.countyArea ?? 1)) *
                  100
                : 0
              ).toFixed(4)
            ),
            sampleStep: city.repair?.sampleStep ?? 0,
            samples: city.repair?.samples ?? { city: 0, both: 0, cityOnly: 0, countyOnly: 0 },
            cityOnlyShare: Number((city.repair?.cityOnlyShare ?? 0).toFixed(6)),
            countyOnlyShare: Number((city.repair?.countyOnlyShare ?? 0).toFixed(6)),
            countyFile: city.repair?.fileName ?? "",
            removedComponents: city.repair?.removedComponents ?? 0,
            diagnostics: city.repair?.diagnostics ?? 0,
            ...(city.repair?.repair
              ? {
                  applied: true,
                  polygons: (city.repair.mergedGeometry?.coordinates ?? []).length
                }
              : { applied: false })
          }
        })),
        text
      };
    });
    packages.push({
      provinceRegionId: `xingji-cn:p-${province.sourceRegionId}`,
      provinceSourceRegionId: province.sourceRegionId,
      // 客户端契约字段是 `file`；这里显式转换，避免契约与产物字段名不一致。
      chunks: files.map(({ text, fileName, ...rest }) => ({ file: fileName, ...rest })),
      payloads: files
    });
  }
  return packages;
}

function buildManifest({ provinces, packages, nationalText }) {
  const cityChunks = packages.flatMap((province) => province.payloads ?? []);
  const totalSourceBytes = provinces.reduce(
    (sum, province) => sum + province.children.reduce((s, child) => s + child.sourceBytes, 0),
    0
  );
  /**
   * 019：派生产物身份 = 算法版本 + 全部派生包字节摘要。
   * 与来源版本分开记录；任一包变化都会让 digest 变化，缓存身份随之失效。
   */
  // 顺序固定，摘要才可复现（分片顺序由 chunk.file 决定）。
  const orderedChunks = [...cityChunks].sort((a, b) => a.fileName.localeCompare(b.fileName));
  const derivedDigest = sha256(
    [nationalText, ...orderedChunks.map((chunk) => chunk.text)].join("\u0000")
  ).slice(0, 32);
  return {
    generatedBy: "scripts/atlas/prepare-atlas.mjs",
    derived: {
      version: "019-derived-v2",
      digest: derivedDigest
    },
    sources: {
      national: {
        sourceId: NATIONAL_SOURCE.sourceId,
        sourceVersion: NATIONAL_SOURCE.sourceVersion,
        origin: "yezongyang/china-geojson@33cd37ab22628858654d839f5d88a2deec372463 + zhChuXiao/ChinaGeoJson@7aa2c5fabc6a892015625898c3482874b233f9de (港澳)",
        gitBlobSha1: NATIONAL_SOURCE.gitBlobSha1,
        bytes: Buffer.byteLength(nationalText, "utf8"),
        sha256: sha256(nationalText),
        refinements: NATIONAL_SOURCE.refinements.map(({ sourceRegionId, name, sourceFile, features, gitBlobSha1 }) => ({ sourceRegionId, name, sourceFile, features, gitBlobSha1 })),
        package: {
          file: NATIONAL_SOURCE.localFileName,
          bytes: Buffer.byteLength(nationalText, "utf8")
        }
      },
      cities: {
        sourceId: CITY_SOURCE.sourceId,
        sourceVersion: CITY_SOURCE.sourceVersion,
        origin: "echarts-maps/echarts-china-cities-js",
        subdir: CITY_SOURCE.assetSubdir,
        fileCount: provinces.reduce((sum, province) => sum + province.children.length, 0),
        bytes: totalSourceBytes
      }
    },
    national: {
      sourceId: NATIONAL_SOURCE.sourceId,
      sourceVersion: NATIONAL_SOURCE.sourceVersion,
      packageFile: NATIONAL_SOURCE.localFileName
    },
    provinces: packages.map((province) => ({
      provinceRegionId: province.provinceRegionId,
      provinceSourceRegionId: province.provinceSourceRegionId,
      sourceId: CITY_SOURCE.sourceId,
      sourceVersion: CITY_SOURCE.sourceVersion,
      note: province.note,
      chunks: province.chunks
    })),
    cityChunks: cityChunks.map((chunk) => ({
      file: chunk.fileName,
      bytes: chunk.bytes,
      sha256: chunk.sha256,
      cityCount: chunk.cities.length,
      cities: chunk.cities
    })),
    coverage: provinces.map((province) => ({
      dir: province.dir,
      sourceRegionId: province.sourceRegionId,
      files: province.children.length,
      used: province.children.filter((child) => child.disposition === "used").length,
      entries: province.children.map((child) => ({
        sourceFile: child.fileName,
        sourceName: child.sourceName,
        sourceBytes: child.sourceBytes,
        sourceSha256: child.sourceSha256,
        disposition: child.disposition,
        reason: child.reason
      }))
    }))
  };
}

function buildCatalogModule(provinces) {
  const lines = [];
  lines.push("/**");
  lines.push(" * 全国城市地区目录（015 生成；请用 scripts/atlas/prepare-atlas.mjs 重新生成）。");
  lines.push(" *");
  lines.push(
    " * RegionId 取自素材文件名标识（materials 的 sourceRegionId），是应用稳定不透明字面值："
  );
  lines.push(
    " * 不冒充官方 adcode、不补零、不按数组位置生成。既有 014-C 的省级与广东 21 市 ID 保持不变。"
  );
  lines.push(" * 目录只含身份与显示名；几何在本地数据包里，不进入 bundle。");
  lines.push(" */");
  // 目录版本字面量直接内联：避免与 region-catalog 形成循环导入（会触发 TDZ 初始化错误）。
  lines.push('import type { Region } from "./region-catalog";');
  lines.push("");
  lines.push(`export const GENERATED_CATALOG_VERSION = ${JSON.stringify("xingji-cn-2020-01-06")};`);
  lines.push("");
  lines.push("export const GENERATED_CITY_REGIONS: Region[] = [");
  let count = 0;
  for (const province of provinces) {
    for (const child of province.children) {
      if (child.disposition !== "used") continue;
      // 既有 014-C 编号优先（广东 21 市），其余用文件名标识；两者都是稳定不透明字面值。
      const regionId = `xingji-cn:c-${child.legacyRegionId ?? child.stem}`;
      const parent = `xingji-cn:p-${province.sourceRegionId}`;
      lines.push(
        `  { regionId: ${JSON.stringify(regionId)}, name: ${JSON.stringify(child.displayName)}, level: "city", parentRegionId: ${JSON.stringify(parent)}, catalogVersion: GENERATED_CATALOG_VERSION, sourceRegionId: ${JSON.stringify(child.legacyRegionId ?? child.stem)}, sourceFile: ${JSON.stringify(child.stem)} },`
      );
      count += 1;
    }
  }
  lines.push("];");
  lines.push("");
  lines.push(`/** 目录中来自素材的城市数量（应与清单 used 数一致）。 */`);
  lines.push(`export const GENERATED_CITY_REGION_COUNT = ${count};`);
  // 以单个换行结尾，保证文件内容与 --check 的重新生成结果逐字节一致。
  return lines.join("\n") + "\n";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = path.join(ROOT, ATLAS_OUTPUT_DIR);
  if (args.download) {
    await ensureNationalSource();
  }
  const nationalPath = path.join(outputDir, NATIONAL_SOURCE.localFileName);
  if (!existsSync(nationalPath)) {
    console.error(
      `缺少全国边界素材：${ATLAS_OUTPUT_DIR}/${NATIONAL_SOURCE.localFileName}\n` +
        `请先运行：node scripts/atlas/prepare-atlas.mjs --download（仅下载数据，不执行上游代码）`
    );
    process.exit(1);
  }
  const nationalText = readFileSync(nationalPath, "utf8");
  const nationalBytes = Buffer.byteLength(nationalText, "utf8");
  if (nationalBytes !== NATIONAL_SOURCE.bytes) {
    console.error(`全国边界字节不符：${nationalBytes} ≠ ${NATIONAL_SOURCE.bytes}`);
    process.exit(1);
  }
  if (sha256(nationalText) !== NATIONAL_SOURCE.sha256) {
    console.error("全国边界摘要不符；请重新运行 --download。");
    process.exit(1);
  }

  const { provinces, issues } = inventoryCities();
  const usedTotal = provinces.reduce(
    (sum, province) =>
      sum + province.children.filter((child) => child.disposition === "used").length,
    0
  );
  console.log("省级目录 | 文件 | 使用 | 其他");
  for (const province of provinces) {
    const used = province.children.filter((child) => child.disposition === "used").length;
    console.log(
      `${province.dir} | ${province.children.length} | ${used} | ${province.children.length - used}`
    );
  }
  const totalFiles = provinces.reduce((sum, province) => sum + province.children.length, 0);
  console.log(
    `合计文件 ${totalFiles}；使用 ${usedTotal}；例外 ${totalFiles - usedTotal}；几何/结构问题 ${issues.length}`
  );
  if (issues.length > 0) {
    for (const issue of issues.slice(0, 20)) console.error(`问题：${issue}`);
    process.exit(1);
  }
  if (args.report) return;

  const packages = buildCityPackages(provinces);
  const manifest = buildManifest({ provinces, packages, nationalText });
  const catalogModule = buildCatalogModule(provinces);

  if (args.check) {
    const manifestPath = path.join(outputDir, "manifest.json");
    const catalogPath = path.join(ROOT, "src/features/regions/region-catalog-cities.ts");
    const mismatches = [];
    if (!existsSync(manifestPath)) {
      mismatches.push("缺少 .local/atlas/manifest.json");
    }
    if (!existsSync(catalogPath)) {
      mismatches.push("缺少 src/features/regions/region-catalog-cities.ts");
    }
    if (mismatches.length > 0) {
      for (const item of mismatches) console.error(item);
      process.exit(1);
    }
    // 逐份核对：产物字节/哈希必须与清单一致；目录数据必须与重新生成的字节一致。
    for (const chunk of manifest.cityChunks) {
      const file = path.join(outputDir, chunk.file);
      if (!existsSync(file)) {
        mismatches.push(`缺少产物 ${chunk.file}`);
        continue;
      }
      const text = readFileSync(file, "utf8");
      if (Buffer.byteLength(text, "utf8") !== chunk.bytes) {
        mismatches.push(`${chunk.file} 字节与清单不符`);
      }
      if (sha256(text) !== chunk.sha256) {
        mismatches.push(`${chunk.file} 哈希与清单不符`);
      }
    }
    const nationalFile = path.join(outputDir, manifest.national.packageFile);
    if (!existsSync(nationalFile)) {
      mismatches.push(`缺少产物 ${manifest.national.packageFile}`);
    } else if (sha256(readFileSync(nationalFile, "utf8")) !== manifest.sources.national.sha256) {
      mismatches.push(`${manifest.national.packageFile} 哈希与清单不符`);
    }
    // 素材逐份哈希核对（392 份，全部有处置）。
    for (const province of provinces) {
      for (const child of province.children) {
        const asset = path.join(
          ROOT,
          CITY_SOURCE.assetRoot,
          province.dir,
          CITY_SOURCE.assetSubdir,
          child.fileName
        );
        if (!existsSync(asset)) {
          mismatches.push(`缺少素材 ${province.dir}/${child.fileName}`);
          continue;
        }
        if (sha256(readFileSync(asset, "utf8")) !== child.sourceSha256) {
          mismatches.push(`素材哈希变化 ${province.dir}/${child.fileName}`);
        }
      }
    }
    if (readFileSync(catalogPath, "utf8") !== catalogModule) {
      mismatches.push("目录数据与素材不一致（请重新生成）");
    }
    if (mismatches.length > 0) {
      for (const item of mismatches.slice(0, 20)) console.error(`不一致：${item}`);
      process.exit(1);
    }
    console.log(
      `校验通过：392 份素材哈希一致，全国 1 份 + 城市分片 ${manifest.cityChunks.length} 份产物与清单一致，目录数据同步。`
    );
    execFileSync(process.execPath, [path.join(HERE, "prepare-counties.mjs"), "--check"], {
      stdio: "inherit"
    });
    return;
  }

  // 只覆盖本清单管理的产物：清理旧的 c-p-*.json 分片后重写。
  mkdirSync(outputDir, { recursive: true });
  for (const name of readdirSync(outputDir)) {
    if (name.startsWith("c-p-") && name.endsWith(".json")) {
      rmSync(path.join(outputDir, name));
    }
  }
  for (const province of packages) {
    for (const payload of province.payloads ?? []) {
      writeFileSync(path.join(outputDir, payload.fileName), payload.text);
    }
  }
  writeFileSync(path.join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(path.join(ROOT, "src/features/regions/region-catalog-cities.ts"), catalogModule);
  execFileSync(process.execPath, [path.join(HERE, "prepare-counties.mjs")], { stdio: "inherit" });

  const chunks = manifest.cityChunks.length;
  const outputBytes = manifest.cityChunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
  console.log(
    `已生成：全国 1 份 + 城市分片 ${chunks} 份（${(outputBytes / 1024 / 1024).toFixed(1)} MiB），城市 ${usedTotal} 个。`
  );
}

await main();
