import {
  findTripJournal,
  setTripJournalMeta,
  type NotebookPage,
  type NotebookRegionRef,
  type NotebookRevision,
  type TripDateRange
} from "./notebook-model";
import {
  applyManualReaffirm,
  mergeRegionSources,
  normalizeRegionSources,
  pruneRegionSources,
  removeRegionSources,
  type RegionAssociationSource
} from "@/features/regions/region-sources";
import type { ArchiveCore, NotebookRepository } from "./notebook-repository";
import { assertSupportedArchiveVersion, RevisionConflictError } from "./notebook-repository";
import { REGION_CATALOG, type RegionCatalog } from "@/features/regions/region-catalog";
import { validateRegionSelection } from "@/features/regions/region-validation";
import {
  formatCapacityViolation,
  measurePageCapacity,
  PAGE_CAPACITY_LIMITS
} from "./notebook-capacity";

/**
 * 014-C：设置一篇笔记本的地区关联。
 *
 * 约束：
 * - 独立篇才可编辑；legacy 关联查看页只读，需先复制（不静默复制）；
 * - 新增地区必须来自当前目录且父级可解析；既有未知/旧 ID 允许保留或显式移除；
 * - 只改 `meta.regions` 与 `meta.updatedAt`，保留 tripDate、正文、媒体、来源关联、收据；
 * - 无实质变化不写入；写入走 Repository 事务与 revision 比较，冲突不覆盖并保留草稿。
 */

export type SetPageRegionsOutcome =
  | {
      status: "saved";
      pageId: string;
      revision: NotebookRevision;
      regions: NotebookRegionRef[];
      changed: boolean;
      /** 本次事务结果的元数据基线，后续重试不再重读并吸收他人写入。 */
      metaSignature: string;
    }
  | { status: "conflict"; expectedRevision: NotebookRevision; actualRevision: NotebookRevision }
  | {
      status: "unchanged";
      pageId: string;
      revision: NotebookRevision;
      regions: NotebookRegionRef[];
      metaSignature: string;
    }
  | {
      status: "rejected";
      code: "PAGE_NOT_FOUND" | "PAGE_READONLY" | "INVALID_REGIONS" | "CAPACITY_EXCEEDED";
      detail: string;
    };

export type SetPageRegionsDeps = {
  repository: NotebookRepository;
  now?: () => Date;
  catalog?: RegionCatalog;
  /**
   * 受控资产大小覆盖（assetId → 字节），仅用于测试临界容量；
   * 生产路径不读取全库 Blob，只用 Repository 的媒体元数据。
   */
  assetSizes?: Record<string, number>;
};

/** 读取一篇页面块实际引用的资产字节（只用元数据，不读 Blob）。 */
async function measurePage(
  repository: NotebookRepository,
  page: NotebookPage,
  meta: { tripDate: string | null; regions: NotebookRegionRef[]; updatedAt: string } | undefined,
  overrides?: Record<string, number>
) {
  const metadata = await repository.loadMediaMetadata();
  const assetSizes: Record<string, number> = {};
  for (const item of metadata) assetSizes[item.id] = item.size;
  for (const [assetId, size] of Object.entries(overrides ?? {})) assetSizes[assetId] = size;
  return measurePageCapacity({ page, meta, assetSizes, limits: PAGE_CAPACITY_LIMITS });
}

function isPageEditable(page: NotebookPage): boolean {
  return page.source.kind !== "legacy-journal";
}

/**
 * M1.5/M2 扩展输入（均可选，缺省行为与旧调用完全一致）：
 * - `sources.add`：本次保存要并入的来源记录（照片确认/规则）；
 * - `sources.removeIds`：撤销的贡献记录 id；
 * - `sources.manualReaffirm`：本次保存来自地区编辑器的人工确认 →
 *   在场地区来源升位 hadPriorAssociation（撤销贡献不再删关联）；
 * - `tripDateRange`：旅行日期（undefined=不改；null=清除）。
 * 来源记录最终按保存后的地区集裁剪（移除地区的记录成孤儿即删）。
 */
export type SetPageRegionsInput = {
  pageId: string;
  regionIds: string[];
  expectedRevision: NotebookRevision;
  sources?: {
    add?: RegionAssociationSource[];
    removeIds?: string[];
    manualReaffirm?: boolean;
  };
  tripDateRange?: TripDateRange | null;
};

/** 计算保存后的来源记录（纯函数，事务内外复用）。 */
export function resolveRegionSources(
  previousSources: RegionAssociationSource[],
  finalRegionIds: string[],
  options: SetPageRegionsInput["sources"]
): RegionAssociationSource[] {
  let next = normalizeRegionSources(previousSources);
  if (options?.manualReaffirm) next = applyManualReaffirm(next, finalRegionIds);
  if (options?.add) next = mergeRegionSources(next, options.add);
  if (options?.removeIds) next = removeRegionSources(next, options.removeIds);
  return pruneRegionSources(next, finalRegionIds);
}

function sameSources(left: RegionAssociationSource[], right: RegionAssociationSource[]): boolean {
  const key = (items: RegionAssociationSource[]) =>
    [...items]
      .map((item) => `${item.id}:${item.regionId}:${item.kind}:${item.mediaIds.join(",")}:${item.hadPriorAssociation}`)
      .sort()
      .join("|");
  return key(left) === key(right);
}

export async function setPageRegions(
  input: SetPageRegionsInput,
  deps: SetPageRegionsDeps
): Promise<SetPageRegionsOutcome> {
  const now = deps.now ?? (() => new Date());
  const catalog = deps.catalog ?? REGION_CATALOG;
  const archive = await deps.repository.loadArchive();
  assertSupportedArchiveVersion(archive);

  const page = archive.pages.find((item) => item.id === input.pageId);
  if (!page) {
    return { status: "rejected", code: "PAGE_NOT_FOUND", detail: "找不到该笔记，地区未保存。" };
  }
  if (!isPageEditable(page)) {
    return {
      status: "rejected",
      code: "PAGE_READONLY",
      detail: "关联查看页不能直接设置地区；请先复制为独立笔记。"
    };
  }

  const existing = findTripJournal(archive, input.pageId)?.regions ?? [];
  const validated = validateRegionSelection(input.regionIds, existing, catalog);
  if (!validated.ok) {
    return { status: "rejected", code: "INVALID_REGIONS", detail: validated.reason };
  }
  const previousMeta = findTripJournal(archive, input.pageId);
  const previousSources = normalizeRegionSources(previousMeta?.regionSources);
  const finalSources = resolveRegionSources(
    previousSources,
    validated.regions.map((ref) => ref.regionId),
    input.sources
  );
  const sourcesChanged = !sameSources(previousSources, finalSources);
  const previousDate = previousMeta?.tripDateRange ?? null;
  // P2：显式清除（null）必须同时清除旧 tripDate——否则读模型回退到旧日期，
  // 用户无法真正清空（effectiveTripDateRange 会用旧 tripDate 兜底）。
  const clearingDate = input.tripDateRange === null;
  const dateChanged =
    input.tripDateRange !== undefined &&
    (JSON.stringify(input.tripDateRange ?? null) !== JSON.stringify(previousDate) ||
      (clearingDate && previousMeta?.tripDate != null));
  if (!validated.changed && !sourcesChanged && !dateChanged) {
    return {
      status: "unchanged",
      pageId: input.pageId,
      revision: archive.revision,
      regions: existing,
      metaSignature: tripJournalMetaSignature(archive, input.pageId)
    };
  }

  // 容量关口：地区元数据也计入整篇配额；按最终引用集复核，超限整次拒绝且不写库。
  const before = await measurePage(
    deps.repository,
    page,
    previousMeta
      ? { ...previousMeta, updatedAt: previousMeta.updatedAt }
      : { tripDate: null, regions: [], updatedAt: page.updatedAt },
    deps.assetSizes
  );
  const after = await measurePage(
    deps.repository,
    page,
    {
      tripDate: previousMeta?.tripDate ?? null,
      regions: validated.regions,
      updatedAt: now().toISOString()
    },
    deps.assetSizes
  );
  // 既有档案已经超限时，只拒绝“让情况更糟”的改动，避免把历史数据变成不可编辑。
  const grew = after.totalBytes > before.totalBytes;
  if (after.violations.length > 0 && grew) {
    return {
      status: "rejected",
      code: "CAPACITY_EXCEEDED",
      detail: formatCapacityViolation(after.violations[0])
    };
  }

  const timestamp = now().toISOString();
  try {
    const committed = await deps.repository.commitJournalChange(
      (current) => {
        const currentPage = current.pages.find((item) => item.id === input.pageId);
        // 事务内重新确认可编辑性与校验：并发下不能靠事务外的判断。
        if (!currentPage || !isPageEditable(currentPage)) return current;
        const currentExisting = findTripJournal(current, input.pageId)?.regions ?? [];
        const revalidated = validateRegionSelection(input.regionIds, currentExisting, catalog);
        if (!revalidated.ok) return current;
        const currentMeta = findTripJournal(current, input.pageId);
        // 事务内重算来源（并发下基于最新档案）；日期按传入值或保留。
        const currentFinalSources = resolveRegionSources(
          normalizeRegionSources(currentMeta?.regionSources),
          revalidated.regions.map((ref) => ref.regionId),
          input.sources
        );
        return setTripJournalMeta(current, input.pageId, {
          // 保留既有字段（tripDate/来源/日期等），只替换本次目标；
          // 显式清除日期时同步清空旧 tripDate（防止读模型回退复活）。
          ...(currentMeta ?? { tripDate: null as string | null }),
          tripDate:
            clearingDate ? null : (currentMeta?.tripDate ?? null),
          regions: revalidated.regions,
          regionSources: currentFinalSources.length > 0 ? currentFinalSources : undefined,
          tripDateRange:
            input.tripDateRange !== undefined ? (input.tripDateRange ?? undefined) : currentMeta?.tripDateRange,
          updatedAt: timestamp
        });
      },
      { expectedRevision: input.expectedRevision }
    );

    const next = findTripJournal(committed.archive, input.pageId)?.regions ?? [];
    return {
      status: "saved",
      pageId: input.pageId,
      revision: committed.revision,
      regions: next,
      changed: true,
      metaSignature: tripJournalMetaSignature(committed.archive, input.pageId)
    };
  } catch (error) {
    if (error instanceof RevisionConflictError) {
      return {
        status: "conflict",
        expectedRevision: error.expectedRevision,
        actualRevision: error.actualRevision
      };
    }
    throw error;
  }
}

/** 从篇元数据读取地区（未设置返回空数组，界面显示“未设置地区”）。 */
export function readPageRegions(archive: ArchiveCore, pageId: string): NotebookRegionRef[] {
  return findTripJournal(archive, pageId)?.regions ?? [];
}

/**
 * P1（冲突重试收紧）：该篇 tripJournal 元数据的稳定签名。
 * 地区面板保存只有在这些元数据自打开面板以来**未被其他操作改动**时，才允许
 * 冲突后按最新 revision 自动重试（正文自动保存等字段不相交的写入不改变签名）；
 * 签名覆盖地区、来源、日期和历史兼容字段及 updatedAt——
 * 任何 meta 写入都会推进它，因此其他实例保存地区必然改变签名。
 */
export function tripJournalMetaSignature(archive: ArchiveCore, pageId: string): string {
  const meta = findTripJournal(archive, pageId);
  if (!meta) return "none";
  return JSON.stringify({
    updatedAt: meta.updatedAt,
    tripDate: meta.tripDate ?? null,
    tripDateRange: meta.tripDateRange ?? null,
    regions: meta.regions.map((ref) => `${ref.regionId}|${ref.name ?? ""}`),
    sources: [...(meta.regionSources ?? [])]
      .map(
        (item) =>
          `${item.id}:${item.regionId}:${item.kind}:${item.mediaIds.join(",")}:${item.hadPriorAssociation}`
      )
      .sort(),
    visits: [...(meta.visitedRegions ?? [])]
      .map((item) => `${item.regionId}@${item.confirmedAt}`)
      .sort()
  });
}
