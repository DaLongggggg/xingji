/**
 * 019 县级浏览包生成与校验。
 *
 * 关键约束（019 返工后）：
 * 1. 几何先经过 `geometry-normalize.ts` 规范化，**只**剔除零面积退化分量
 *    （顶点不足/共线），并逐项留下审计记录。
 * 2. **非空 diagnostics 一律阻断发布**：受影响的城市保持“不发布”状态，
 *    清单里明确记录，磁盘上的既有完整产物原样保留（不被删洞/改形的结果覆盖）。
 *    结构异常的内环、带内环的退化外环、feature 全退化都属于这一类。
 * 3. 合法区域、多部件、真实内环全部保留；原始 `map-data/` 只读。
 *
 * 用法：
 *   node scripts/atlas/prepare-counties.mjs            # 生成（并写入 manifest）
 *   node scripts/atlas/prepare-counties.mjs --check    # 只校验产物与清单一致
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { normalizeFeatureCollection } from "./geometry-normalize.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, ".local/atlas");
const manifestPath = path.join(output, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const check = process.argv.includes("--check");
const digest = (data) => createHash("sha256").update(data).digest("hex");

const packages = [];
const unavailable = [];
const removals = [];
const diagnostics = [];
const payloads = [];
/** 港澳区级包复用本次下载的固定版本；其他地区仍用原本地素材。 */
const HARBOR_SOURCE = {
  xiang_gang: "source-hongkong.json",
  ao_men: "source-macau.json"
};
for (const file of Object.values(HARBOR_SOURCE)) {
  if (!existsSync(path.join(output, file))) {
    throw new Error(`缺少港澳来源 ${file}，请先运行 prepare-atlas.mjs --download`);
  }
}

for (const province of manifest.coverage) {
  for (const entry of province.entries) {
    if (entry.disposition !== "used" && entry.disposition !== "province-self") continue;
    const stem = entry.sourceFile.replace(/\.geojson$/, "");
    const source = HARBOR_SOURCE[province.dir]
      ? path.join(output, HARBOR_SOURCE[province.dir])
      : path.join(root, "map-data", province.dir, "shape-with-internal-borders", `${stem}.geojson`);
    if (!existsSync(source)) continue;
    try {
      const raw = readFileSync(source);
      const data = JSON.parse(raw);
      if (data.type !== "FeatureCollection" || !data.features?.length)
        throw new Error(`Empty county collection: ${stem}`);
      const normalized = normalizeFeatureCollection(data, entry.sourceFile);
      for (const item of normalized.removed) removals.push({ parentSourceFile: stem, ...item });
      for (const item of normalized.diagnostics)
        diagnostics.push({ parentSourceFile: stem, ...item });
      // 019 返工：非空 diagnostics 阻断发布，不做“记日志后照发”。
      if (normalized.diagnostics.length > 0) {
        throw new Error(
          `Geometry diagnostics block publish: ${normalized.diagnostics.length} 项（首个：${
            normalized.diagnostics[0].kind
          }）`
        );
      }
      if (normalized.features.length !== data.features.length)
        throw new Error(`Feature count changed after normalization: ${stem}`);

      const seen = new Set();
      for (const feature of normalized.features) {
        const name = feature.properties?.name;
        if (typeof name !== "string" || !name || seen.has(name))
          throw new Error(`Ambiguous county name: ${stem}/${name}`);
        seen.add(name);
        const geometry = feature.geometry;
        if (!geometry || !["Polygon", "MultiPolygon"].includes(geometry.type))
          throw new Error(`Invalid geometry: ${stem}/${name}`);
        const polygons =
          geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
        if (!polygons.length) throw new Error(`Empty geometry: ${stem}/${name}`);
        for (const polygon of polygons) {
          if (!polygon.length) throw new Error(`Empty polygon: ${stem}/${name}`);
          for (const ring of polygon) {
            if (
              ring.length < 4 ||
              ring.some(
                (p) =>
                  !Number.isFinite(p[0]) ||
                  !Number.isFinite(p[1]) ||
                  Math.abs(p[0]) > 180 ||
                  Math.abs(p[1]) > 90
              ) ||
              JSON.stringify(ring[0]) !== JSON.stringify(ring.at(-1))
            )
              throw new Error(`Invalid ring: ${stem}/${name}`);
          }
        }
        // Version-scoped display identity; never a persisted business RegionId/adcode.
        feature.properties.xingjiSourceRegionId = JSON.stringify([stem, name]);
      }
      const text = JSON.stringify(normalized);
      const bytes = Buffer.byteLength(text);
      if (bytes > 10 * 1024 * 1024) throw new Error(`County package exceeds 10MiB: ${stem}`);
      const file = `county-${stem}.json`;
      packages.push({
        file,
        parentSourceFile: stem,
        provinceRegionId: `xingji-cn:p-${province.sourceRegionId}`,
        sourceVersion: HARBOR_SOURCE[province.dir]
          ? "7aa2c5fabc6a892015625898c3482874b233f9de"
          : manifest.sources.cities.sourceVersion,
        bytes,
        sha256: digest(text),
        sourceSha256: digest(raw),
        featureCount: normalized.features.length,
        removedComponents: normalized.removed.length
      });
      payloads.push({ file, text });
    } catch (error) {
      unavailable.push({ parentSourceFile: stem, reason: error.message });
    }
  }
}

if (check) {
  if (JSON.stringify(manifest.countyPackages) !== JSON.stringify(packages))
    throw new Error("County manifest is stale");
  if (JSON.stringify(manifest.countyUnavailable) !== JSON.stringify(unavailable))
    throw new Error("County unavailable report is stale");
  if (JSON.stringify(manifest.countyNormalization?.removals ?? []) !== JSON.stringify(removals))
    throw new Error("County normalization removals are stale");
  if (
    JSON.stringify(manifest.countyNormalization?.diagnosticEntries ?? []) !==
    JSON.stringify(diagnostics)
  )
    throw new Error("County normalization diagnostics are stale");
  for (const payload of payloads) {
    if (readFileSync(path.join(output, payload.file), "utf8") !== payload.text)
      throw new Error(`Stale county package: ${payload.file}`);
  }
} else {
  // 只有通过全部校验的包才落盘；被阻断的包不写，磁盘上的既有完整产物原样保留。
  for (const payload of payloads) writeFileSync(path.join(output, payload.file), payload.text);
  manifest.countyPackages = packages;
  manifest.countyUnavailable = unavailable;
  manifest.countyNormalization = {
    version: "019-normalize-v2",
    removedComponents: removals.length,
    diagnostics: diagnostics.length,
    blockedPackages: unavailable.length,
    removals,
    ...(diagnostics.length > 0 ? { diagnosticEntries: diagnostics } : {})
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}
packages.sort((a, b) => a.file.localeCompare(b.file));
unavailable.sort((a, b) => a.parentSourceFile.localeCompare(b.parentSourceFile));
removals.sort((a, b) => {
  const left = `${a.parentSourceFile}|${a.featureIndex}|${a.polygonIndex}|${a.ringIndex}`;
  const right = `${b.parentSourceFile}|${b.featureIndex}|${b.polygonIndex}|${b.ringIndex}`;
  return left.localeCompare(right);
});
diagnostics.sort((a, b) => {
  const left = `${a.parentSourceFile}|${a.featureIndex}|${a.polygonIndex}|${a.ringIndex}`;
  const right = `${b.parentSourceFile}|${b.featureIndex}|${b.polygonIndex}|${b.ringIndex}`;
  return left.localeCompare(right);
});

console.log(
  `County packages ${check ? "verified" : "generated"}: ${packages.length}; ` +
    `removed degenerate components: ${removals.length}; ` +
    `blocked (diagnostics): ${unavailable.length}`
);
for (const item of unavailable)
  console.warn(`County package blocked: ${item.parentSourceFile}: ${item.reason}`);
