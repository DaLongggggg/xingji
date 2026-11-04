import { findRegion, REGION_CATALOG, type RegionCatalog } from "./region-catalog";
import {
  resolveStoredRegion,
  toStoredRegionRef,
  type StoredRegionRef
} from "./region-boundary-map";

/**
 * 地区选择校验（014-C）。
 *
 * - **新增**引用必须来自当前目录，并且父级一致；
 * - 既有未知/旧 ID 允许保留或由用户显式移除，不会因为保存其他地区而消失；
 * - 城市隐含父省不必手选，但选择了城市时父省必须能解析（否则拒绝新增）；
 * - 去重后保持稳定顺序（省级在前，其余按目录顺序），避免无实质变化的重复写入。
 */

export type RegionSelectionResult =
  { ok: true; regions: StoredRegionRef[]; changed: boolean } | { ok: false; reason: string };

export function validateRegionSelection(
  proposedIds: string[],
  existing: StoredRegionRef[],
  catalog: RegionCatalog = REGION_CATALOG
): RegionSelectionResult {
  const existingById = new Map(existing.map((ref) => [ref.regionId, ref] as const));
  const ordered: StoredRegionRef[] = [];
  const seen = new Set<string>();

  for (const regionId of proposedIds) {
    if (seen.has(regionId)) continue;
    seen.add(regionId);
    const existingRef = existingById.get(regionId);
    if (existingRef && resolveStoredRegion(existingRef, catalog).status !== "resolved") {
      // 既有未知/不匹配引用：原样保留（不重写名称/父级），用户显式移除才会消失。
      ordered.push(existingRef);
      continue;
    }
    const region = findRegion(regionId, catalog);
    if (!region) {
      return { ok: false, reason: `「${regionId}」不在当前地区目录中，未保存。` };
    }
    if (region.level === "city") {
      if (!region.parentRegionId || !findRegion(region.parentRegionId, catalog)) {
        return { ok: false, reason: `「${region.name}」缺少可解析的上级省份，未保存。` };
      }
    }
    ordered.push(toStoredRegionRef(region));
  }

  ordered.sort((left, right) =>
    left.level === right.level ? 0 : left.level === "province" ? -1 : 1
  );
  return { ok: true, regions: ordered, changed: !sameRegions(existing, ordered) };
}

/** 地区集合是否等价（忽略顺序，但保留未知引用的原始内容）。 */
export function sameRegions(left: StoredRegionRef[], right: StoredRegionRef[]): boolean {
  if (left.length !== right.length) return false;
  const key = (ref: StoredRegionRef) =>
    `${ref.regionId}\u0001${ref.level}\u0001${ref.parentRegionId ?? ""}\u0001${ref.name}\u0001${ref.catalogVersion}`;
  const leftKeys = left.map(key).sort();
  const rightKeys = right.map(key).sort();
  return leftKeys.every((item, index) => item === rightKeys[index]);
}

/**
 * 目录已知城市的上级省份：用于“选了城市就隐含父省”的界面展示与统计。
 * 只按目录父子关系推导，不按名称或编号前缀猜测。
 */
export function impliedProvinceId(
  regionId: string,
  catalog: RegionCatalog = REGION_CATALOG
): string | undefined {
  const region = findRegion(regionId, catalog);
  return region?.level === "city" ? (region.parentRegionId ?? undefined) : undefined;
}
