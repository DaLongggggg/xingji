/**
 * 地区关联来源记录（M1.5 收尾）：哪个篇的哪个地区关联由哪些照片、
 * 哪次确认或哪条已授权规则产生。
 *
 * 语义边界：
 * - **没有来源记录 = 来源未知**（历史手动关联或旧数据）：保守保留，
 *   任何自动/撤销逻辑不得删除这类关联；
 * - 撤销一条贡献只移除该记录；是否同时移除地区关联取决于
 *   `hadPriorAssociation`（记录时该地区已存在无来源历史的关联）与
 *   是否仍有其他来源记录支持；
 * - 手动保存（地区编辑器路径）视为对该结果集的人工再确认：把在场地区的
 *   照片/规则来源记录升位 hadPriorAssociation=true（此后撤销贡献不再删关联）；
 * - regionId 一律 canonical（双 ID 归一）；mediaId 可被多篇引用（共享媒体，
 *   记录只描述本篇贡献，不改动照片数据）。
 */

import { canonicalRegionId } from "./region-catalog";

export type RegionAssociationSource = {
  /** 稳定记录 ID（同一确认动作的多地区记录共享同一 at，id 各自独立）。 */
  id: string;
  /** canonical 应用 RegionId。 */
  regionId: string;
  kind: "photo-confirm" | "rule";
  /** 贡献照片（共享媒体引用；只读语义）。 */
  mediaIds: string[];
  /** 确认/规则应用时间（不是旅行时间）。 */
  at: string;
  /**
   * 记录写入时该地区已存在**无来源历史**的关联（此前手动选择或旧数据）。
   * true = 撤销本贡献不删除关联（保守）；false = 关联由本贡献引入。
   */
  hadPriorAssociation: boolean;
};

/** 生成记录 ID：时间戳 + 随机段，避免同批冲突。 */
export function nextRegionSourceId(now: () => Date = () => new Date()): string {
  return `rsrc-${now().toISOString()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeRegionSources(value: unknown): RegionAssociationSource[] {
  if (!Array.isArray(value)) return [];
  const out: RegionAssociationSource[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Partial<RegionAssociationSource>;
    if (
      typeof candidate.id !== "string" ||
      candidate.id.length === 0 ||
      typeof candidate.regionId !== "string" ||
      candidate.regionId.length === 0 ||
      (candidate.kind !== "photo-confirm" && candidate.kind !== "rule") ||
      !Array.isArray(candidate.mediaIds) ||
      candidate.mediaIds.some((id) => typeof id !== "string") ||
      typeof candidate.at !== "string" ||
      candidate.at.length === 0 ||
      typeof candidate.hadPriorAssociation !== "boolean"
    ) {
      continue;
    }
    out.push({
      id: candidate.id,
      regionId: canonicalRegionId(candidate.regionId),
      kind: candidate.kind,
      mediaIds: [...candidate.mediaIds],
      at: candidate.at,
      hadPriorAssociation: candidate.hadPriorAssociation
    });
  }
  return out;
}

/** 合并来源记录：按 id 去重（重复确认幂等——同 id 覆盖，其余保留）。 */
export function mergeRegionSources(
  existing: RegionAssociationSource[],
  additions: RegionAssociationSource[]
): RegionAssociationSource[] {
  const byId = new Map(existing.map((item) => [item.id, item] as const));
  for (const addition of additions) byId.set(addition.id, addition);
  return [...byId.values()];
}

/** 移除指定 id 的来源记录。 */
export function removeRegionSources(
  existing: RegionAssociationSource[],
  ids: string[]
): RegionAssociationSource[] {
  const drop = new Set(ids);
  return existing.filter((item) => !drop.has(item.id));
}

/** 地区在移除指定贡献后是否仍被支持（还有其他记录，或原本就有未知历史关联）。 */
export function regionSupportedAfterRemoval(
  sources: RegionAssociationSource[],
  regionId: string,
  removedIds: string[]
): boolean {
  const canonical = canonicalRegionId(regionId);
  const removed = new Set(removedIds);
  return sources.some(
    (item) => item.regionId === canonical && !removed.has(item.id)
  );
}

/**
 * 撤销一条贡献后应从关联中移除的地区集合：
 * - 该贡献的 regionId（canonical）；
 * - 且 hadPriorAssociation=false（关联由本贡献引入）；
 * - 且移除后无其他来源记录支持；
 * - 且当前关联集中仍存在该地区（调用方按草稿/已存关联再核对）。
 */
export function regionsToUnlinkAfterRemoval(
  sources: RegionAssociationSource[],
  removedIds: string[]
): string[] {
  const out = new Set<string>();
  for (const id of removedIds) {
    const record = sources.find((item) => item.id === id);
    if (!record) continue;
    if (record.hadPriorAssociation) continue;
    if (!regionSupportedAfterRemoval(sources, record.regionId, removedIds)) {
      out.add(record.regionId);
    }
  }
  return [...out];
}

/**
 * 手动保存再确认：保存结果中在场的地区，其照片/规则来源记录升位
 * hadPriorAssociation=true（用户人工保留了该关联，撤销贡献不再删除它）。
 */
export function applyManualReaffirm(
  sources: RegionAssociationSource[],
  presentRegionIds: string[]
): RegionAssociationSource[] {
  const present = new Set(presentRegionIds.map(canonicalRegionId));
  return sources.map((item) =>
    present.has(item.regionId) && !item.hadPriorAssociation
      ? { ...item, hadPriorAssociation: true }
      : item
  );
}

/** 清理孤儿：关联集中已不存在的地区，其来源记录一并移除。 */
export function pruneRegionSources(
  sources: RegionAssociationSource[],
  presentRegionIds: string[]
): RegionAssociationSource[] {
  const present = new Set(presentRegionIds.map(canonicalRegionId));
  return sources.filter((item) => present.has(item.regionId));
}
