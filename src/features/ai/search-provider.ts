/**
 * P1-01：SearchProvider（keyword 模式 + 结构过滤；P5 启用 topics 主题过滤）。
 *
 * 职责边界：
 * - keyword 匹配完全复用 `notebook-query.searchPages`（标题 + 完整 text block），
 *   本文件不重写匹配逻辑，只做可见性/结构过滤/稳定排序/limit 与截断报告；
 * - 顺序遵循 docs/search-retrieval.md：可见性与任务范围 → 结构过滤 → 主题过滤 →
 *   关键词 → 排序 → limit；
 * - topics 过滤只使用与**当前 sourceDigest 匹配**的有效 metadata（fresh）；
 *   stale/unavailable 的篇不参与判定，并且必须在覆盖统计里如实上报——
 *   “没有元数据”不等于“与主题不相关”；
 * - 未实现的 semantic/hybrid 明确拒绝，不静默忽略；tripIds/placeIds 自 P6 起为已实现的结构过滤；
 * - 只返回候选引用（id/标题/snippet/digest），正文必须由 Context 按 ID 回读。
 */
import { getPageSummary, searchPages } from "../notebook/notebook-query";
import {
  aiVisiblePages,
  createAiReadScope,
  narrowNotebookScope,
  pageSourceDigest,
  sortPagesStable,
  type AiReadScope
} from "./ai-context";
import {
  deriveMetadataStatus,
  normalizeTopics,
  type AiMetadataStatus,
  type AiPageMetadata
} from "./ai-repository";
import type { Notebook } from "../notebook/notebook-model";
import type { NotebookPage } from "../notebook/notebook-model";
import type { ArchiveCore } from "../notebook/notebook-repository";
import {
  isPlaceRecord,
  isPagePlaceLinkRecord,
  isPurgedTargetRecordShaped,
  isTripPageLinkRecord,
  isTripRecord
} from "../trips/trip-model";

export type SearchMode = "keyword" | "semantic" | "hybrid";

export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 100;

export type AiPageQuery = {
  query?: string;
  notebookIds?: string[];
  /** P6：按旅行事件筛选（只看仍有效的关系；已永久删除的旅行不参与）。 */
  tripIds?: string[];
  regionIds?: string[];
  /** P6：按真实地点筛选（已永久删除的地点不参与）。 */
  placeIds?: string[];
  /**
   * P5：主题过滤（规范化后精确匹配有效 metadata 的 topics）。
   * 需要调用方提供 metadata 快照；没有快照时明确失败，不伪装成“无匹配”。
   */
  topics?: string[];
  /** capturedAt 的下界（含）。 */
  from?: string;
  /** capturedAt 的上界（不含）。 */
  to?: string;
  mode?: SearchMode;
  limit?: number;
};

export type SearchResult = {
  pageId: string;
  notebookId: string;
  title: string;
  /** 明确截断的候选摘要；不是完整正文，不得当作正文或写入基线。 */
  snippet: string;
  sourceDigest: string;
  matchedBy: ("keyword" | "structured" | "semantic" | "metadata")[];
  /** 命中的 text block id（标题命中则为空）。 */
  blockIds?: string[];
};

export type SearchMetadataCoverage = {
  /** 是否提供了 metadata 快照（AI 库是否可读）。false 时仅关键词/结构检索可用。 */
  topicsAvailable: boolean;
  /** 实际生效的主题（规范化后）；未请求主题时为 null。 */
  requestedTopics: string[] | null;
  /** 结构过滤后参与判定的候选项总数（分母）。 */
  candidates: number;
  /** 候选中 metadata 与当前 sourceDigest 一致的篇数。 */
  fresh: number;
  /** 候选中 metadata 已过期的篇数。 */
  stale: number;
  /** 候选中没有 metadata（或源不可读）的篇数。 */
  unavailable: number;
  /** 候选中没有有效（fresh）主题标签、因而未参与主题判定的篇数。 */
  withoutFreshMetadata: number;
};

export type SearchResponse = {
  results: SearchResult[];
  /** 过滤后、limit 之前的候选总数。 */
  totalMatches: number;
  /** 候选多于 limit：前 N 条不是“全部”，调用方必须如实报告。 */
  truncated: boolean;
  /** 实际生效的 limit。 */
  limit: number;
  /** P5：覆盖统计。无 metadata 的篇不能因此被说成“不相关”。 */
  metadata: SearchMetadataCoverage;
};

/** 未启用能力：明确拒绝，不伪装成功。 */
export class AiQueryUnsupportedError extends Error {
  constructor(readonly detail: string) {
    super(`AI_QUERY_UNSUPPORTED:${detail}`);
    this.name = "AiQueryUnsupportedError";
  }
}

/** 非法 limit：明确失败，不静默改成默认值。 */
export class AiQueryLimitError extends Error {
  constructor(readonly limit: number) {
    super(`AI_QUERY_LIMIT_INVALID:${limit}`);
    this.name = "AiQueryLimitError";
  }
}

/** P5：主题输入非法（规范化后为空）：明确失败，不静默返回全部。 */
export class AiQueryTopicsError extends Error {
  constructor(detail: string) {
    super(`AI_QUERY_TOPICS_INVALID:${detail}`);
    this.name = "AiQueryTopicsError";
  }
}

/**
 * P5：请求了主题过滤，但调用方没有提供 metadata 快照（AI 库不可用/读取失败）。
 * 明确失败，避免把“没有主题数据”显示成“与主题不相关”。
 */
export class AiQueryMetadataUnavailableError extends Error {
  constructor() {
    super("AI_QUERY_METADATA_UNAVAILABLE");
    this.name = "AiQueryMetadataUnavailableError";
  }
}

export interface SearchProvider {
  searchPages(query: AiPageQuery): Promise<SearchResult[]>;
}

export type SearchProviderOptions = {
  archive: ArchiveCore;
  scope?: Partial<AiReadScope>;
  /**
   * AI 派生 metadata 快照（调用方读取；读取失败传 undefined）。
   * 只读使用：Provider 不写 metadata、不调用模型。
   */
  pageMetadata?: readonly AiPageMetadata[];
};

function assertSupported(query: AiPageQuery): void {
  if (query.mode !== undefined && query.mode !== "keyword") {
    throw new AiQueryUnsupportedError(`mode:${query.mode}`);
  }
}

function resolvedLimit(limit: number | undefined): number {
  if (limit === undefined) return SEARCH_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new AiQueryLimitError(limit);
  return Math.min(limit, SEARCH_MAX_LIMIT);
}

/** 页的地区集合 = 已存地区 + 其父省（复用城市隐含父省语义，不按名称猜 ID）。 */
function regionSet(page: NotebookPage, archive: ArchiveCore): Set<string> {
  const ids = new Set<string>();
  for (const region of archive.tripJournals.find((entry) => entry.pageId === page.id)?.meta
    .regions ?? []) {
    ids.add(region.regionId);
    if (region.parentRegionId) ids.add(region.parentRegionId);
  }
  return ids;
}

function matchesRegions(page: NotebookPage, archive: ArchiveCore, regionIds: string[]): boolean {
  if (regionIds.length === 0) return false;
  const ids = regionSet(page, archive);
  return regionIds.some((regionId) => ids.has(regionId));
}

/**
 * P6：页的有效旅行 id 集合 = 关系表中指向**仍存在且未删除**旅行的那些。
 * 已软删（垃圾桶）或已永久删除的旅行不参与筛选，不制造“已删除也能命中”的假象。
 *
 * R1：读取边界允许保留损坏记录，因此这里只使用通过记录校验的行（`is*Record`），
 * 坏记录既不参与命中、也不会让搜索崩溃（不清理、不写回）。
 */
function tripSet(page: NotebookPage, archive: ArchiveCore): Set<string> {
  const trips = (archive.trips ?? []).filter(isTripRecord);
  const purged = new Set(
    (archive.purgedTrips ?? []).filter(isPurgedTargetRecordShaped).map((record) => record.id)
  );
  const ids = new Set<string>();
  for (const link of (archive.tripPageLinks ?? []).filter(isTripPageLinkRecord)) {
    if (link.pageId !== page.id) continue;
    if (purged.has(link.tripId)) continue;
    const trip = trips.find((item) => item.id === link.tripId);
    if (!trip || trip.deletedAt) continue;
    ids.add(link.tripId);
  }
  return ids;
}

/** P6：页的有效地点 id 集合（同规则：目标必须存在且未删除）。 */
function placeSet(page: NotebookPage, archive: ArchiveCore): Set<string> {
  const places = (archive.places ?? []).filter(isPlaceRecord);
  const purged = new Set(
    (archive.purgedPlaces ?? []).filter(isPurgedTargetRecordShaped).map((record) => record.id)
  );
  const ids = new Set<string>();
  for (const link of (archive.pagePlaceLinks ?? []).filter(isPagePlaceLinkRecord)) {
    if (link.pageId !== page.id) continue;
    if (purged.has(link.placeId)) continue;
    const place = places.find((item) => item.id === link.placeId);
    if (!place || place.deletedAt) continue;
    ids.add(link.placeId);
  }
  return ids;
}

function matchesTime(
  page: NotebookPage,
  from: string | undefined,
  to: string | undefined
): boolean {
  if (from !== undefined && page.capturedAt < from) return false;
  if (to !== undefined && page.capturedAt >= to) return false;
  return true;
}

function matchedBlockIds(page: NotebookPage, keyword: string): string[] {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return [];
  return page.blocks
    .filter((block) => block.type === "text" && block.text.toLowerCase().includes(needle))
    .map((block) => block.id);
}

/**
 * R1：任务授权范围是**上限**，查询条件只能进一步缩小。
 * 两者都是“获准的本集合”，语义是交集：
 * - 授权为 null（不限）→ 用查询条件；
 * - 查询未给 → 用授权范围本身；
 * - 两者都给 → 取交集；任一为空 → 结果必然为空（不是忽略过滤）。
 *
 * 实现收敛到 `ai-context.narrowNotebookScope`（与 P4 runner/Context 方法级收窄同一处），
 * 避免“交集”在多个模块各写一份而漂移；本导出签名保持不变。
 */
export function intersectNotebookScope(
  authorized: string[] | null,
  requested: string[] | undefined
): string[] | null {
  return narrowNotebookScope(authorized, requested);
}

export function createSearchProvider(options: SearchProviderOptions): SearchProviderWithReport {
  const archive = options.archive;
  const defaultScope = createAiReadScope(options.scope);
  const metadataSnapshot = options.pageMetadata;
  const metadataById = new Map<string, AiPageMetadata>();
  for (const record of metadataSnapshot ?? []) metadataById.set(record.pageId, record);

  /** 当前有效主题与状态：只有与**当前** sourceDigest 一致的 metadata 才算有效。 */
  function metadataFor(page: NotebookPage): { status: AiMetadataStatus; topics: string[] } {
    const record = metadataById.get(page.id) ?? null;
    const notebook = archive.notebooks.find((item) => item.id === page.notebookId);
    const regions = archive.tripJournals.find((entry) => entry.pageId === page.id)?.meta.regions ?? [];
    const digest = pageSourceDigest(page, notebook, regions);
    const status = deriveMetadataStatus(record, digest);
    return { status, topics: status === "fresh" ? normalizeTopics(record?.topics ?? []) : [] };
  }

  async function searchWithReport(query: AiPageQuery, all = false): Promise<SearchResponse> {
    assertSupported(query);
    const limit = resolvedLimit(query.limit);

    // 主题输入先规范化：全部为空/重复项被规范掉时明确失败，不静默返回全部。
    const requestedTopics = query.topics === undefined ? null : normalizeTopics(query.topics);
    if (requestedTopics !== null) {
      if (metadataSnapshot === undefined) throw new AiQueryMetadataUnavailableError();
      if (requestedTopics.length === 0) throw new AiQueryTopicsError("empty-after-normalize");
    }

    // 授权范围 ∩ 查询条件；query 不能把范围放大。
    const scope = createAiReadScope({
      ...defaultScope,
      notebookIds: intersectNotebookScope(defaultScope.notebookIds, query.notebookIds)
    });

    // 1+2：可见性、任务范围与结构过滤（不同字段 AND，同一 ID 集合 OR）。
    const structural = aiVisiblePages(archive, scope).filter((page) => {
      if (query.regionIds && !matchesRegions(page, archive, query.regionIds)) return false;
      // P6：旅行/地点结构过滤（不同字段 AND，同一集合内 OR），不依赖 AI 库。
      if (query.tripIds && !query.tripIds.some((tripId) => tripSet(page, archive).has(tripId))) {
        return false;
      }
      if (
        query.placeIds &&
        !query.placeIds.some((placeId) => placeSet(page, archive).has(placeId))
      ) {
        return false;
      }
      if (!matchesTime(page, query.from, query.to)) return false;
      return true;
    });

    // 2.5：主题过滤（只认有效 metadata；stale/unavailable 不参与判定但必须上报）。
    const freshTopicsByPage = new Map<string, string[]>();
    let fresh = 0;
    let stale = 0;
    let unavailable = 0;
    if (metadataSnapshot !== undefined) {
      for (const page of structural) {
        const { status, topics } = metadataFor(page);
        if (status === "fresh") {
          fresh += 1;
          freshTopicsByPage.set(page.id, topics);
        } else if (status === "stale") stale += 1;
        else unavailable += 1;
      }
    }
    const wantedTopics = requestedTopics === null ? null : new Set(requestedTopics);
    const topicFiltered =
      wantedTopics === null
        ? structural
        : structural.filter((page) =>
            (freshTopicsByPage.get(page.id) ?? []).some((topic) => wantedTopics.has(topic))
          );

    // 3：关键词（复用现有纯函数；空 query 表示仅过滤）。
    const text = (query.query ?? "").trim();
    const keywordCandidates = text ? searchPages(topicFiltered, text) : topicFiltered;

    // 4+5：稳定排序与 limit。
    const candidates = sortPagesStable(keywordCandidates);
    const picked = all ? candidates : candidates.slice(0, limit);
    const structured =
      query.notebookIds !== undefined ||
      query.regionIds !== undefined ||
      query.tripIds !== undefined ||
      query.placeIds !== undefined ||
      query.from !== undefined ||
      query.to !== undefined;

    const results = picked.map<SearchResult>((page) => {
      const notebook = archive.notebooks.find((item) => item.id === page.notebookId);
      const regions =
        archive.tripJournals.find((entry) => entry.pageId === page.id)?.meta.regions ?? [];
      const blockIds = matchedBlockIds(page, text);
      const matchedBy: SearchResult["matchedBy"] = [];
      if (text && (blockIds.length > 0 || page.title.toLowerCase().includes(text.toLowerCase()))) {
        matchedBy.push("keyword");
      }
      if (structured) matchedBy.push("structured");
      if (
        wantedTopics !== null &&
        (freshTopicsByPage.get(page.id) ?? []).some((topic) => wantedTopics.has(topic))
      ) {
        matchedBy.push("metadata");
      }
      return {
        pageId: page.id,
        notebookId: page.notebookId,
        title: page.title,
        snippet: getPageSummary(page),
        sourceDigest: pageSourceDigest(page, notebook, regions),
        matchedBy,
        ...(blockIds.length > 0 ? { blockIds } : {})
      };
    });

    return {
      results,
      totalMatches: candidates.length,
      truncated: candidates.length > picked.length,
      limit,
      metadata: {
        topicsAvailable: metadataSnapshot !== undefined,
        requestedTopics,
        candidates: structural.length,
        fresh,
        stale,
        unavailable,
        withoutFreshMetadata: metadataSnapshot === undefined ? 0 : structural.length - fresh
      }
    };
  }

  return {
    eligiblePages: async (query: AiPageQuery) => (await searchWithReport({ ...query, mode: "keyword", query: "" }, true)).results,
    searchPages: async (query) => (await searchWithReport(query)).results,
    /**
     * 附带截断与覆盖范围的任务级入口：truncated/totalMatches 必须如实上报，
     * 不能把前 limit 条写成“全部匹配”。
     */
    searchWithReport
  };
}

export type SearchProviderWithReport = SearchProvider & {
  /** P7 local structural candidates, before result limit. */
  eligiblePages(query: AiPageQuery): Promise<SearchResult[]>;
  searchWithReport(query: AiPageQuery): Promise<SearchResponse>;
};

/** 接口收窄到文档契约的 SearchProvider（只暴露 searchPages）。 */
export function asSearchProvider(provider: SearchProviderWithReport): SearchProvider {
  return { searchPages: (query) => provider.searchPages(query) };
}

export type AvailableTopic = { topic: string; pages: number };

/**
 * P5：当前可见范围内**有效**（fresh）主题标签及篇数，供界面提供可点选的精确主题。
 * 只读：不写 metadata、不调用模型；没有快照时返回空数组（主题能力不可用由调用方说明）。
 * 排序固定：篇数降序 → 主题升序，便于稳定展示与测试。
 */
export function listAvailableTopics(
  archive: ArchiveCore,
  options: { pageMetadata?: readonly AiPageMetadata[]; scope?: Partial<AiReadScope> } = {}
): AvailableTopic[] {
  const snapshot = options.pageMetadata;
  if (snapshot === undefined) return [];
  const scope = createAiReadScope(options.scope);
  const counts = new Map<string, number>();
  for (const page of aiVisiblePages(archive, scope)) {
    const notebook = archive.notebooks.find((item) => item.id === page.notebookId);
    const regions = archive.tripJournals.find((entry) => entry.pageId === page.id)?.meta.regions ?? [];
    const record = snapshot.find((item) => item.pageId === page.id) ?? null;
    const status = deriveMetadataStatus(record, pageSourceDigest(page, notebook, regions));
    if (status !== "fresh") continue;
    for (const topic of normalizeTopics(record?.topics ?? [])) {
      counts.set(topic, (counts.get(topic) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([topic, pages]) => ({ topic, pages }))
    .sort((left, right) =>
      right.pages === left.pages ? left.topic.localeCompare(right.topic) : right.pages - left.pages
    );
}
