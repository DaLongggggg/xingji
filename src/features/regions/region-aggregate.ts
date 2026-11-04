import {
  canonicalRegionId,
  findRegion,
  REGION_CATALOG,
  type RegionCatalog
} from "./region-catalog";
import { resolveStoredRegion, type StoredRegionRef } from "./region-boundary-map";

/**
 * 地区关联聚合（014-C）：**纯函数**，从当前可见独立篇聚合，不存冗余计数。
 *
 * 规则：
 * - 只统计可见、未删除笔记本里的独立篇；legacy 关联查看页排除；
 * - 一篇关联广州与佛山：两市各 1 篇、广东 1 篇（城市隐含父省）；
 * - 显式省级关联与隐含父省不重复计数（集合去重）；
 * - 全国总数 = 逻辑篇去重，不把各地区篇数相加；
 * - 三类按篇互斥：可解析、未设置、地区待匹配；有任何未知/不匹配即列待匹配。
 */

export type RegionLinkedPage = {
  pageId: string;
  title: string;
  capturedAt: string;
  notebookId: string;
  notebookTitle: string;
  /** 该篇可解析的应用地区 ID（含隐含父省，已去重）。 */
  regionIds: string[];
};

export type RegionAggregate = {
  /** 区域 → 去重后的篇 ID 集合（城市隐含父省）。 */
  pagesByRegion: Map<string, Set<string>>;
  /** 区域 → 篇数（由集合派生，二者不会不一致）。 */
  countsByRegion: Map<string, number>;
  /** 区域 → 篇摘要（按时间倒序）。 */
  pagesByRegionDetail: Map<string, RegionLinkedPage[]>;
  /** 有任意未知/不匹配关联的篇（优先列待匹配，不计入可解析集合）。 */
  needsMatchingPages: RegionLinkedPage[];
  /** 完全没有任何地区引用的篇。 */
  unsetPages: RegionLinkedPage[];
  /** 关联可完整解析的篇数（总览“已关联地区的笔记 X 篇”）。 */
  linkedPageCount: number;
  /** 参与统计的可见独立篇总数（三类之和）。 */
  totalVisiblePages: number;
};

type ArchiveLike = {
  notebooks: { id: string; title: string; archivedAt: string | null; deletedAt: string | null }[];
  pages: {
    id: string;
    notebookId: string;
    title: string;
    capturedAt: string;
    source: { kind: string };
    /** 024 篇级垃圾桶：在桶里的篇不参与地区统计（与目录、追加同一口径）。 */
    deletedAt?: string | null;
  }[];
  tripJournals?: { pageId: string; meta: { regions: StoredRegionRef[] } }[];
};

function visibleNotebookIds(archive: ArchiveLike): Set<string> {
  return new Set(
    archive.notebooks
      .filter((notebook) => !notebook.archivedAt && !notebook.deletedAt)
      .map((notebook) => notebook.id)
  );
}

/** 独立篇：排除 legacy 关联查看页（它只是引用旧游记，不算独立内容单元）。 */
export function isIndependentPage(page: { source: { kind: string } }): boolean {
  return page.source.kind !== "legacy-journal";
}

/**
 * 归一化一篇的地区引用：解析目录、补齐城市隐含父省、去重。
 * 只要存在任一项无法解析/不匹配，`problems` 非空，该篇即列入“地区待匹配”。
 */
export function normalizePageRegions(
  refs: StoredRegionRef[],
  catalog: RegionCatalog = REGION_CATALOG
): { regionIds: string[]; problems: string[] } {
  const regionIds = new Set<string>();
  const problems: string[] = [];
  for (const ref of refs) {
    const resolution = resolveStoredRegion(ref, catalog);
    if (resolution.status === "unmatched") {
      // 目录里没有这个 ID（旧供应商命名空间等）：保留原数据待匹配，无法计入任何地区。
      problems.push(resolution.reason);
      continue;
    }
    if (resolution.status === "mismatch") {
      // ID 仍能按目录识别：既存数据的地区列表仍可贡献该地区，同时标记需要确认。
      problems.push(resolution.reason);
    }
    regionIds.add(canonicalRegionId(resolution.region.regionId));
    // 城市隐含父省：即使只选了广州，广东也计 1 篇；Set 保证不重复计数。
    if (resolution.region.parentRegionId) {
      regionIds.add(canonicalRegionId(resolution.region.parentRegionId));
    }
  }
  return { regionIds: [...regionIds], problems };
}

export function aggregateRegions(
  archive: ArchiveLike,
  catalog: RegionCatalog = REGION_CATALOG
): RegionAggregate {
  const notebooks = new Map(archive.notebooks.map((notebook) => [notebook.id, notebook] as const));
  const visible = visibleNotebookIds(archive);
  const journalByPage = new Map(
    (archive.tripJournals ?? []).map((entry) => [entry.pageId, entry.meta] as const)
  );

  const pagesByRegion = new Map<string, Set<string>>();
  const pagesByRegionDetail = new Map<string, RegionLinkedPage[]>();
  const needsMatchingPages: RegionLinkedPage[] = [];
  const unsetPages: RegionLinkedPage[] = [];
  let linkedPageCount = 0;

  for (const page of archive.pages) {
    if (!visible.has(page.notebookId)) continue;
    if (!isIndependentPage(page)) continue;
    // 篇级垃圾桶：删除要即时反映到颜色、封面、统计与列表（M1 验收口径）。
    if (typeof page.deletedAt === "string" && page.deletedAt.length > 0) continue;
    const notebook = notebooks.get(page.notebookId);
    const refs = journalByPage.get(page.id)?.regions ?? [];
    const { regionIds, problems } = normalizePageRegions(refs, catalog);
    const summary: RegionLinkedPage = {
      pageId: page.id,
      title: page.title,
      capturedAt: page.capturedAt,
      notebookId: page.notebookId,
      notebookTitle: notebook?.title ?? "未知笔记本",
      regionIds
    };

    if (refs.length === 0) {
      unsetPages.push(summary);
      continue;
    }
    if (problems.length > 0) needsMatchingPages.push(summary);
    else linkedPageCount += 1;

    for (const regionId of regionIds) {
      const ids = pagesByRegion.get(regionId) ?? new Set<string>();
      // 同一篇在同一地区只计一次；跨地区分别计，但总览用 linkedPageCount 去重。
      ids.add(page.id);
      pagesByRegion.set(regionId, ids);
      const detail = pagesByRegionDetail.get(regionId) ?? [];
      if (!detail.some((item) => item.pageId === page.id)) detail.push(summary);
      pagesByRegionDetail.set(regionId, detail);
    }
  }

  const countsByRegion = new Map<string, number>();
  for (const [regionId, ids] of pagesByRegion) countsByRegion.set(regionId, ids.size);
  for (const detail of pagesByRegionDetail.values()) {
    detail.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
  }

  return {
    pagesByRegion,
    countsByRegion,
    pagesByRegionDetail,
    needsMatchingPages,
    unsetPages,
    linkedPageCount,
    totalVisiblePages: unsetPages.length + needsMatchingPages.length + linkedPageCount
  };
}

/** 区域篇数：目录已知但无关联 → 真实 0；目录外区域 → null（未知，不显示 0）。 */
export function regionPageCount(
  aggregate: RegionAggregate,
  regionId: string,
  catalog: RegionCatalog = REGION_CATALOG
): number | null {
  if (!findRegion(regionId, catalog)) return null;
  return aggregate.countsByRegion.get(canonicalRegionId(regionId)) ?? 0;
}

/** 某地区（省或市）的去重篇集合，供地图高亮与列表使用。 */
export function pagesForRegion(aggregate: RegionAggregate, regionId: string): Set<string> {
  return aggregate.pagesByRegion.get(regionId) ?? new Set();
}

export function regionPageDetails(
  aggregate: RegionAggregate,
  regionId: string
): RegionLinkedPage[] {
  return aggregate.pagesByRegionDetail.get(regionId) ?? [];
}

/** 省内“尚未细分城市”的篇：只关联了该省、没有关联其下任何城市。 */
export function provinceOnlyPages(
  aggregate: RegionAggregate,
  provinceRegionId: string,
  catalog: RegionCatalog = REGION_CATALOG
): RegionLinkedPage[] {
  const cityPages = new Set<string>();
  for (const region of catalog.regions) {
    if (region.level === "city" && region.parentRegionId === provinceRegionId) {
      for (const pageId of aggregate.pagesByRegion.get(region.regionId) ?? [])
        cityPages.add(pageId);
    }
  }
  const detail = aggregate.pagesByRegionDetail.get(provinceRegionId) ?? [];
  return detail.filter((page) => !cityPages.has(page.pageId));
}
