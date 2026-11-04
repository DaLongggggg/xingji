import { resolvableMediaIds } from "./notebook-write-guards";
import { normalizeRegionSources } from "@/features/regions/region-sources";
import {
  EMPTY_NOTEBOOK_ARCHIVE,
  type PurgedPageRecord,
  AI_COMMIT_RECEIPT_LIMIT,
  isAiCommitReceipt,
  isBlobLike,
  isNotebookMedia,
  isNotebookMediaGps,
  isNotebookPage,
  isPurgedPageRecord,
  isTripJournalMeta,
  isAppendOperationReceipt,
  isPageSourceLink,
  isRetainedAppendReceipt,
  applyPurge,
  minimalPurgedReceipt,
  purgeTargets,
  MAX_PAGE_BLOCKS_HARD_LIMIT,
  NOTEBOOK_ARCHIVE_VERSION,
  NOTEBOOK_DB_NAME,
  NOTEBOOK_DB_VERSION,
  isKnownArchiveVersion,
  sortNotebooks,
  type AppendOperationReceipt,
  type AiCommitReceipt,
  type LegacyImportRecord,
  type Notebook,
  type NotebookArchive,
  type NotebookArchiveV1,
  isTripDateRange,
  isVisitedRegionRecord,
  type NotebookMedia,
  type NotebookMediaGps,
  type NotebookPage,
  type TripJournalMeta,
  type NotebookPageSourceLink,
  type NotebookRevision,
  type NotebookTripJournal,
  type PurgePlan,
  type PurgeTarget
} from "./notebook-model";

import type {
  PagePlaceLink,
  Place,
  PurgedTargetRecord,
  Trip,
  TripArchiveSlice,
  TripPageLink
} from "../trips/trip-model";

/** 不含媒体的结构化档案；媒体单独存取。 */
export type ArchiveCore = Omit<NotebookArchive, "media">;

export const EMPTY_ARCHIVE_CORE: ArchiveCore = {
  schemaVersion: NOTEBOOK_ARCHIVE_VERSION,
  revision: 0,
  notebooks: [],
  pages: [],
  legacyImports: [],
  tripJournals: [],
  pageSources: [],
  appendOperations: [],
  aiCommitReceipts: [],
  purgedPages: [],
  trashConfirmedAt: null,
  trips: [],
  places: [],
  tripPageLinks: [],
  pagePlaceLinks: [],
  purgedTrips: [],
  purgedPlaces: []
};

/** 档案版本比本实现更新，必须拒绝而不是丢字段。 */
export class UnsupportedArchiveVersionError extends Error {
  readonly version: number;
  constructor(version: number) {
    super(`NOTEBOOK_ARCHIVE_VERSION_UNSUPPORTED:${version}`);
    this.name = "UnsupportedArchiveVersionError";
    this.version = version;
  }
}

/**
 * P6：本地库无法按当前结构初始化/打开时的**明确**结论（不自动清库、不静默转换）。
 * - `reset-required`：升级时发现旧结构版本且有非空数据；需按授权手动清理该环境后重试。
 * - `db-version-newer`：磁盘上的库版本高于本实现，本版本不能打开（旧客户端防写）。
 */
export class NotebookStorageBlockedError extends Error {
  constructor(
    readonly reason: "reset-required" | "db-version-newer",
    readonly detail: string
  ) {
    super(`NOTEBOOK_STORAGE_BLOCKED:${reason}:${detail}`);
    this.name = "NotebookStorageBlockedError";
  }
}

/** P6：六数组容器不是数组时无法原样保留，必须显式报错（不静默丢字段）。 */
export class TripStoreCorruptError extends Error {
  constructor(readonly store: string) {
    super(`NOTEBOOK_TRIP_STORE_CORRUPT:${store}`);
    this.name = "TripStoreCorruptError";
  }
}

/** 乐观并发冲突：不自动覆盖，调用方保留草稿。 */
export class RevisionConflictError extends Error {
  readonly expectedRevision: NotebookRevision;
  readonly actualRevision: NotebookRevision;
  constructor(expectedRevision: NotebookRevision, actualRevision: NotebookRevision) {
    super(`REVISION_CONFLICT:${expectedRevision}:${actualRevision}`);
    this.name = "RevisionConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

/**
 * 读取时的版本关口：未知/未来版本明确拒绝（不静默降级）。
 *
 * P6：已知历史版本扩展为 1/2/3。接受 v2 是读取旧档案兼容所需；
 * 在线库的旧结构数据由 `openDatabase` 的初始化屏障单独拒绝。
 */
export function assertSupportedArchiveVersion(value: unknown): 1 | 2 | typeof NOTEBOOK_ARCHIVE_VERSION {
  const version = (value as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (version === undefined) return 1;
  if (isKnownArchiveVersion(version)) {
    return version as 1 | 2 | typeof NOTEBOOK_ARCHIVE_VERSION;
  }
  throw new UnsupportedArchiveVersionError(typeof version === "number" ? version : Number.NaN);
}

function arraysOf<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 规范化并升级为 v2 档案（读取边界）。
 * v1 缺字段按“未设置”解释：revision 0、无篇元数据/来源关联/操作收据。
 * 未来版本在此之前的版本关口已拒绝，不会走到这里。
 */
export function normalizeArchiveCore(input: unknown): ArchiveCore {
  assertSupportedArchiveVersion(input);
  const source = (input ?? {}) as Partial<NotebookArchiveV1> & Partial<ArchiveCore>;
  const notebooks = arraysOf(source.notebooks).filter(
    (notebook): notebook is Notebook =>
      Boolean(notebook) &&
      typeof notebook === "object" &&
      typeof notebook.id === "string" &&
      notebook.id.length > 0
  );
  const notebookIds = new Set(notebooks.map((notebook) => notebook.id));
  const pages = arraysOf(source.pages)
    .filter((page) => notebookIds.has(page?.notebookId) && isNotebookPage(page))
    .map((page) => ({ ...page, schemaVersion: NOTEBOOK_ARCHIVE_VERSION }) as NotebookPage);
  const pageIds = new Set(pages.map((page) => page.id));

  const legacyImports: LegacyImportRecord[] = arraysOf(source.legacyImports)
    .filter((record) => pageIds.has(record?.linkedPageId))
    .map((record) => ({
      ...record,
      copiedPageId:
        record.copiedPageId && pageIds.has(record.copiedPageId) ? record.copiedPageId : null,
      copyStatus: record.copiedPageId && pageIds.has(record.copiedPageId) ? record.copyStatus : null
    }));

  const tripJournals: NotebookTripJournal[] = arraysOf(source.tripJournals)
    .filter((entry) => pageIds.has(entry?.pageId) && isTripJournalMeta(entry?.meta))
    .map((entry) => ({
      pageId: entry.pageId,
      meta: {
        tripDate: asNullableString(entry.meta.tripDate),
        regions: entry.meta.regions.map((region) => ({
          regionId: region.regionId,
          parentRegionId: asNullableString(region.parentRegionId),
          level: region.level,
          name: region.name,
          catalogVersion: region.catalogVersion
        })),
        updatedAt: entry.meta.updatedAt,
        // M1.5/M2 可选字段：形状非法即按未设置处理（保守，不阻断读取）。
        ...(isTripDateRange(entry.meta.tripDateRange)
          ? { tripDateRange: entry.meta.tripDateRange }
          : {}),
        ...(Array.isArray((entry.meta as Partial<TripJournalMeta>).visitedRegions)
          ? {
              visitedRegions: ((entry.meta as Partial<TripJournalMeta>).visitedRegions ?? []).filter(
                isVisitedRegionRecord
              )
            }
          : {}),
        ...(Array.isArray((entry.meta as Partial<TripJournalMeta>).regionSources)
          ? {
              regionSources: normalizeRegionSources(
                (entry.meta as Partial<TripJournalMeta>).regionSources
              )
            }
          : {})
      }
    }));

  const pageSources: NotebookPageSourceLink[] = arraysOf(source.pageSources)
    .filter((link) => pageIds.has(link?.pageId) && isPageSourceLink(link))
    .map((link) => ({
      pageId: link.pageId,
      messageId: link.messageId,
      snapshotDigest: link.snapshotDigest,
      blockIds: [...link.blockIds],
      mediaAssetIds: [...link.mediaAssetIds],
      appendedAt: link.appendedAt,
      operationId: link.operationId
    }));

  const knownBlockIds = new Set(pages.flatMap((page) => page.blocks.map((block) => block.id)));
  /*
   * 追加收据的有效条件按身份区分（024）：
   * - 活动收据（`applied`）挂在仍然存在的目标篇上，篇没了就不再是有效业务事实；
   * - 永久删除终态（`purged`）的目标篇**就是被永久删掉的**，不能再要求页仍存在，
   *   否则同一 operationId 的身份在写入/重启/恢复时被静默抹掉；
   *   它只保留最小身份，明细数组一律清空（不保留无效大载荷）。
   */
  const appendOperations: AppendOperationReceipt[] = arraysOf(source.appendOperations)
    .filter(
      (receipt): receipt is AppendOperationReceipt =>
        isAppendOperationReceipt(receipt) && isRetainedAppendReceipt(receipt, pageIds)
    )
    .map((receipt) =>
      receipt.status === "purged"
        ? minimalPurgedReceipt(receipt)
        : {
            ...receipt,
            appendedBlockIds: receipt.appendedBlockIds.filter((id) => knownBlockIds.has(id)),
            appendedMediaIds: [...receipt.appendedMediaIds],
            messageIds: [...receipt.messageIds],
            skippedMessageIds: [...receipt.skippedMessageIds]
          }
    );

  const revision =
    typeof source.revision === "number" && Number.isInteger(source.revision) && source.revision >= 0
      ? source.revision
      : 0;

  /*
   * 024：篇的删除标记与永久删除终态。
   * - 篇 `deletedAt`：缺省补 null；给了非法值（非 null 也非字符串）按 null 处理，
   *   不会因为一个坏字段让整篇读不出来；
   * - `purgedPages`：只保留合法记录；`trashConfirmedAt` 缺省为 null（未确认）。
   */
  const pagesWithDeletion = pages.map((page) => ({
    ...page,
    deletedAt:
      typeof page.deletedAt === "string" && page.deletedAt.length > 0 ? page.deletedAt : null
  }));
  const purgedPages = arraysOf((source as { purgedPages?: PurgedPageRecord[] }).purgedPages).filter(
    isPurgedPageRecord
  );
  const trashConfirmedAt =
    typeof (source as { trashConfirmedAt?: unknown }).trashConfirmedAt === "string"
      ? (source as { trashConfirmedAt: string }).trashConfirmedAt
      : null;

  /*
   * P6：六数组的规范化。
   * - 缺省（旧档案）→ 空数组；
   * - 给了但**不是数组** → 显式报错（无法原样保留，绝不静默丢字段）；
   * - 是数组 → **原样保留**（不 filter）：损坏记录不能让整档读不出来，也不能被静默丢弃。
   *   损坏由 `inspectTripStore` 报告（读取边界只报告不写回），写入侧由命令层拒绝非法输入。
   */
  const tripArray = <T,>(key: keyof TripArchiveSlice): T[] => {
    const value = (source as unknown as Record<string, unknown>)[key];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new TripStoreCorruptError(String(key));
    return value as T[];
  };

  return {
    schemaVersion: NOTEBOOK_ARCHIVE_VERSION,
    revision,
    notebooks: sortNotebooks(notebooks),
    pages: pagesWithDeletion,
    legacyImports,
    tripJournals,
    pageSources,
    appendOperations,
    // P1-03：AI 提交收据缺省为空数组；非法条目丢弃（不能让一条坏收据让整档读不出来）。
    aiCommitReceipts: arraysOf(source.aiCommitReceipts).filter(isAiCommitReceipt),
    purgedPages,
    trashConfirmedAt,
    trips: tripArray<Trip>("trips"),
    places: tripArray<Place>("places"),
    tripPageLinks: tripArray<TripPageLink>("tripPageLinks"),
    pagePlaceLinks: tripArray<PagePlaceLink>("pagePlaceLinks"),
    purgedTrips: tripArray<PurgedTargetRecord>("purgedTrips"),
    purgedPlaces: tripArray<PurgedTargetRecord>("purgedPlaces")
  };
}

/** @deprecated 使用 normalizeArchiveCore；保留旧名以兼容既有调用点。 */
export const normalizeArchive = normalizeArchiveCore;

export type NotebookRevisionStore = { revision: NotebookRevision };

/**
 * 笔记本所有权边界。UI 与业务逻辑只依赖本接口，不直接接触 IndexedDB 或 localStorage。
 * 实现：IndexedDB（浏览器）与内存实现（测试/隔离恢复演练）。
 *
 * 写入约定（014-A）：
 * - `commitJournalChange` 是编辑/移动/删除/恢复/追加的统一写入口，在同一事务内
 *   读取最新档案、校验 revision、再写回；
 * - `saveArchive` 是无条件写，仅迁移/恢复/测试使用，不作为 UI 写路径；
 * - revision 不匹配抛 `RevisionConflictError`，不自动覆盖。
 */
export interface NotebookRepository {
  loadArchive(): Promise<ArchiveCore>;
  saveArchive(archive: ArchiveCore): Promise<void>;
  loadMedia(): Promise<NotebookMedia[]>;
  /** 只读元数据，不读取二进制；容量与统计走这里。 */
  loadMediaMetadata(): Promise<NotebookMediaMeta[]>;
  loadMediaBlob(mediaId: string): Promise<Blob | undefined>;
  /** 按 ID 批量读取二进制，避免全库读出。 */
  loadMediaBlobs(mediaIds: string[]): Promise<(Blob | undefined)[]>;
  saveMedia(media: NotebookMedia[]): Promise<void>;
  /**
   * M1.5：写入照片级拍摄位置（共享媒体记录）。单事务批量写；mediaId 不存在
   * 时整体失败（抛错，不部分写入）。返回**实际写入条数**；`onlyIfAbsent` 时
   * 记录已有位置则跳过（同一事务内判定，恢复与并发确认不互相覆盖）。
   * **不联动 archive revision**：媒体记录不在档案内容里，联动会让编辑中的
   * 篇基线无故冲突；并发语义 = 同媒体记录上后一次用户确认胜出。
   */
  updateMediaGps(
    entries: { mediaId: string; gps: NotebookMediaGps }[],
    options?: { onlyIfAbsent?: boolean }
  ): Promise<number>;
  /** 清除照片级位置（共享媒体操作：影响所有引用篇，不动 blob/EXIF）。返回清除数。 */
  clearMediaGps(mediaIds: string[]): Promise<number>;
  removeMedia(mediaId: string): Promise<void>;
  /** 比较 revision 后写入；不匹配抛 RevisionConflictError。 */
  saveArchiveIfRevision(
    archive: ArchiveCore,
    expectedRevision: NotebookRevision
  ): Promise<{ revision: NotebookRevision }>;
  /** 事务内读取最新档案 → 同步变更 → 写回（可选 revision 校验与预写媒体）。 */
  commitJournalChange(
    change: (current: ArchiveCore) => ArchiveCore,
    options?: { expectedRevision?: NotebookRevision; media?: NotebookMedia[] }
  ): Promise<{ archive: ArchiveCore; revision: NotebookRevision }>;
  /**
   * 024：永久删除垃圾桶条目（单项或清空）。
   *
   * 引用核对、页面删除与媒体删除必须在**同一 IndexedDB readwrite 事务**内完成，
   * 因此这里接收确认时冻结的目标，在事务内重新核对身份与 revision：
   * - revision 不一致或目标身份变化 → 返回 conflict/skipped，不写；
   * - 媒体只回收本次待删页引用、且删除后无人引用者；
   * - 不扫描全库孤儿，不动 capture 库与旧游记原图。
   */
  purgeTrash(input: {
    targets: PurgeTarget[];
    expectedRevision?: NotebookRevision;
  }): Promise<PurgeOutcome>;
  /**
   * P1-03：带 AI 提交收据的写入口。
   *
   * 与 `commitJournalChange` 的区别只有一个：在**同一个 IndexedDB 事务内**先按
   * operationId 做收据幂等判断，再把业务修改与收据一起写回。这样
   * “业务已提交”和“收据存在”不可能只成立一个。
   *
   * 结果：`committed`（本次写入）/ `replayed`（同 operationId 同载荷，返回既有收据，不重复写）
   * / `conflict`（同 operationId 不同载荷，拒绝）/ `revision-conflict` / `receipt-limit`。
   */
  commitJournalChangeWithReceipt(
    /**
     * 业务修改。返回 `{ archive, receipt }`：`receipt` 在**同一个事务内、基于本次
     * 实际提交结果**生成，因此 “业务已提交”与“收据内容”不可能只成立一个。
     */
    change: (current: ArchiveCore) => {
      archive: ArchiveCore;
      receipt: Omit<AiCommitReceipt, "operationId" | "payloadDigest" | "appliedAt">;
    },
    receipt: {
      operationId: string;
      /** 在事务内读到的当前档案上计算，避免 TOCTOU。 */
      payloadDigest: (current: ArchiveCore) => string;
      /** 便于测试固定时间；缺省用当前时间。 */
      now?: () => Date;
    },
    options?: {
      expectedRevision?: NotebookRevision;
      /**
       * 事务内校验（媒体可解析性/容量等）。在该事务读到的档案与拟提交结果上执行；
       * 失败即抛错并中止事务，业务数据、revision 与收据都不改变。
       */
      guard?: AiCommitGuard;
    }
  ): Promise<AiCommitOutcome>;
  /** 删除库中所有数据，仅用于测试与恢复演练。 */
  clear(): Promise<void>;
}

export type AiCommitOutcome =
  | {
      status: "committed";
      archive: ArchiveCore;
      revision: NotebookRevision;
      receipt: AiCommitReceipt;
    }
  | {
      status: "replayed";
      archive: ArchiveCore;
      revision: NotebookRevision;
      receipt: AiCommitReceipt;
    }
  | { status: "conflict"; existing: AiCommitReceipt; requestedDigest: string }
  | { status: "revision-conflict"; currentRevision: NotebookRevision }
  | { status: "receipt-limit"; limit: number };

/**
 * R3：AI 提交的**事务内校验**。
 *
 * 必须在同一个事务、针对 `stored`（事务读到的当前档案）与 `next`（拟提交结果）执行：
 * 事务外预检会被“预检之后的数据变化”绕过，因此事务外校验不是安全边界。
 * 校验通过则返回；不通过则抛出（调用方中止事务，业务与收据都不改变）。
 *
 * `mediaExists` 依据**实际媒体存储记录**判定可解析性，不是只看 mediaId 或元数据。
 */
export type AiCommitGuard = {
  validate: (input: {
    stored: ArchiveCore;
    next: ArchiveCore;
    /** 事务内实际可解析的媒体 id 集合（来自媒体 store，且带二进制载荷）。 */
    resolvableMediaIds: ReadonlySet<string>;
    assetSizes: Map<string, number>;
  }) => void;
};

/** 容量计量只需要媒体大小，不读取二进制。 */
function assetSizesFromMediaRecords(records: readonly unknown[]): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const candidate = record as { id?: unknown; size?: unknown };
    if (typeof candidate.id === "string" && typeof candidate.size === "number") {
      sizes.set(candidate.id, candidate.size);
    }
  }
  return sizes;
}

/**
 * 收据幂等逻辑：IndexedDB 与内存实现共用同一份判定，两种环境下语义一致。
 * 返回 `stop` 表示本次不写业务数据。
 *
 * 注意顺序：幂等重放/冲突判定**先于**校验执行——已经成功提交的同操作重放，
 * 不应因为之后容量变化而被错误拒绝。`guard` 只在真正要写入时运行。
 */
function resolveReceiptCommit(
  current: ArchiveCore,
  change: (current: ArchiveCore) => {
    archive: ArchiveCore;
    receipt: Omit<AiCommitReceipt, "operationId" | "payloadDigest" | "appliedAt">;
  },
  receiptInput: {
    operationId: string;
    payloadDigest: (current: ArchiveCore) => string;
    now?: () => Date;
  },
  expectedRevision: NotebookRevision | undefined,
  now: () => Date,
  mediaRecords: readonly unknown[] = [],
  guard?: AiCommitGuard
):
  | { kind: "stop"; outcome: AiCommitOutcome }
  | { kind: "write"; committed: ArchiveCore; receipt: AiCommitReceipt } {
  if (expectedRevision !== undefined && current.revision !== expectedRevision) {
    return {
      kind: "stop",
      outcome: { status: "revision-conflict", currentRevision: current.revision }
    };
  }
  const requestedDigest = receiptInput.payloadDigest(current);
  const existing = (current.aiCommitReceipts ?? []).find(
    (item) => item.operationId === receiptInput.operationId
  );
  if (existing) {
    if (existing.payloadDigest === requestedDigest) {
      // 同请求重放：返回既有收据，不重复写业务数据。
      return {
        kind: "stop",
        outcome: {
          status: "replayed",
          archive: current,
          revision: current.revision,
          receipt: existing
        }
      };
    }
    return { kind: "stop", outcome: { status: "conflict", existing, requestedDigest } };
  }
  if ((current.aiCommitReceipts ?? []).length >= AI_COMMIT_RECEIPT_LIMIT) {
    return { kind: "stop", outcome: { status: "receipt-limit", limit: AI_COMMIT_RECEIPT_LIMIT } };
  }

  // 业务修改在事务内应用；收据基于提交结果生成，不用调用方传入的乐观值。
  const outcome = change(current);
  const committed: ArchiveCore = { ...outcome.archive, revision: current.revision + 1 };
  /*
   * R3：事务内校验。它在幂等/冲突/上限判定**之后**执行，因此：
   * - 重放已成功的同操作不会被后来变化误拒（不会走到这里）；
   * - 校验针对事务内读到的 current 与**拟提交结果**（含 +1 后的 revision），
   *   事务外预检无法替代。
   */
  if (guard) {
    guard.validate({
      stored: current,
      next: committed,
      // 依据实际媒体存储记录（且有二进制载荷）判定可解析，不只看 id 或元数据。
      resolvableMediaIds: resolvableMediaIds(mediaRecords),
      assetSizes: assetSizesFromMediaRecords(mediaRecords)
    });
  }
  const receipt: AiCommitReceipt = {
    ...outcome.receipt,
    operationId: receiptInput.operationId,
    payloadDigest: requestedDigest,
    appliedAt: now().toISOString()
  };
  if (!isAiCommitReceipt(receipt)) throw new Error("AI_COMMIT_RECEIPT_INVALID");
  return {
    kind: "write",
    committed: { ...committed, aiCommitReceipts: [...(current.aiCommitReceipts ?? []), receipt] },
    receipt
  };
}

export type PurgeOutcome =
  | { status: "purged"; archive: ArchiveCore; revision: NotebookRevision; purged: PurgePlan }
  | { status: "conflict"; currentRevision: NotebookRevision }
  | {
      status: "skipped";
      archive: ArchiveCore;
      reason: "no-targets" | "identity-changed";
      skipped: PurgeTarget[];
    };

/**
 * 媒体内容身份：用于判断“同 ID 是否同一份内容”。
 * 比较字节长度与非加密内容指纹（FNV-1a 32 位）；这不是加密哈希，
 * 但足以拒绝“同 ID 写入明显不同的图片”，并保持写入路径同步、可并发检查。
 */
export function mediaContentFingerprint(blob: Blob): string {
  return `${blob.size}:${blob.type}:${pendingFingerprints.get(blob) ?? ""}`;
}

const pendingFingerprints = new WeakMap<Blob, string>();

/** 记录一条媒体的内容指纹（写入前登记，供同 ID 比较）。 */
export async function registerMediaFingerprint(blob: Blob, digest: string): Promise<string> {
  pendingFingerprints.set(blob, digest);
  return digest;
}

/** 内容摘要：同步读字节做稳定指纹；读取失败返回长度+类型，仍可用于冲突判断。 */
export async function digestMediaContent(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let hash = 2166136261;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index];
    hash = Math.imul(hash, 16777619);
  }
  const digest = `${bytes.length}:${(hash >>> 0).toString(16)}`;
  pendingFingerprints.set(blob, digest);
  return digest;
}

/** 同 ID 但内容不同的媒体写入被拒绝：绝不覆盖已被笔记本引用的图片。 */
export class MediaContentConflictError extends Error {
  readonly mediaId: string;
  constructor(mediaId: string) {
    super(`MEDIA_CONTENT_CONFLICT:${mediaId}`);
    this.name = "MediaContentConflictError";
    this.mediaId = mediaId;
  }
}

/** 媒体元数据：与 NotebookMedia 同字段但不含二进制（含可选照片位置）。 */
export type NotebookMediaMeta = {
  id: string;
  name: string;
  type: string;
  size: number;
  createdAt: string;
  gps?: NotebookMediaGps;
};

export function toMediaMeta(media: NotebookMedia): NotebookMediaMeta {
  return {
    id: media.id,
    name: media.name,
    type: media.type,
    size: media.size,
    createdAt: media.createdAt,
    ...(media.gps ? { gps: media.gps } : {})
  };
}

export function isMediaMeta(value: unknown): value is NotebookMediaMeta {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NotebookMediaMeta>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.name === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.size === "number" &&
    Number.isFinite(candidate.size) &&
    candidate.size >= 0 &&
    typeof candidate.createdAt === "string"
  );
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("INDEXEDDB_REQUEST_FAILED"));
  });
}

/**
 * 事务执行包装（F1）：把整个事务体放在一个异常边界内。
 *
 * 为什么必需：`writeArchiveInTransaction` 会先写 meta、再写 pages。
 * 如果 pages 的写入同步抛错（或被显式抛出），而事务没有显式中止，
 * 已排入的 meta 请求可能仍随事务提交，就会出现
 * “正文未更新、revision 与成功收据已落库”的部分提交。
 *
 * 因此：任何异常都显式 `abort()`，中止失败不掩盖根因。
 */
async function runInTransaction<T>(
  transaction: IDBTransaction,
  run: () => Promise<{ value: T; commit: boolean }>
): Promise<T> {
  let outcome: { value: T; commit: boolean };
  try {
    outcome = await run();
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // 事务可能已因请求错误自动中止：清理阶段不能盖掉根因。
    }
    throw error;
  }
  try {
    await transactionDone(transaction);
  } catch (error) {
    if (!outcome.commit) {
      // 调用方主动中止（重放/冲突/上限等“不写任何业务数据”的结论）：
      // 这是预期路径，结论交还调用方，不伪装成事务失败。
      return outcome.value;
    }
    throw error;
  }
  return outcome.value;
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("INDEXEDDB_TX_FAILED"));
    transaction.onabort = () => reject(transaction.error ?? new Error("INDEXEDDB_TX_ABORTED"));
  });
}

/**
 * 旧 meta 里可能出现的集合字段（列表型）。
 * `normalizeArchiveCore` 把缺省/`null` 当空数组；**存在但不是数组**则说明内容损坏。
 */
const ARCHIVE_COLLECTION_FIELDS = [
  "notebooks",
  "pages",
  "legacyImports",
  "tripJournals",
  "pageSources",
  "appendOperations",
  "aiCommitReceipts",
  "purgedPages",
  "trips",
  "places",
  "tripPageLinks",
  "pagePlaceLinks",
  "purgedTrips",
  "purgedPlaces"
] as const;

/**
 * 旧结构 meta 是否含用户数据（升级屏障用）。
 * 只看数组内容，不把 normalize 结果当物理版本判断。
 */
function metaHasUserData(record: Record<string, unknown>): boolean {
  return ARCHIVE_COLLECTION_FIELDS.some(
    (key) => Array.isArray(record[key]) && (record[key] as unknown[]).length > 0
  );
}

/**
 * F2：集合字段存在但不是数组（`{}`、字符串、数字……）⇒ 内容损坏，**不能**当作“合法空结构”。
 * 这类库必须以 `reset-required` 拒绝，绝不能借 normalize/filter 把它变空后放行。
 */
function metaHasIllegalContainer(record: Record<string, unknown>): boolean {
  return ARCHIVE_COLLECTION_FIELDS.some((key) => {
    const value = record[key];
    return value !== undefined && value !== null && !Array.isArray(value);
  });
}

/** 库名段清洗：账号标识只保留安全字符（与 ai/capture 仓储同一规则）。 */
function sanitizeDbSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64) || "unknown";
}

function openDatabase(factory: IDBFactory, dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(dbName, NOTEBOOK_DB_VERSION);
    /** P6 初始化屏障：升级时发现旧结构**非空**数据就拒绝，不自动删、不静默转换。 */
    let resetRequired: string | undefined;
    request.onupgradeneeded = (event) => {
      const database = request.result;
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(PAGE_STORE)) {
        database.createObjectStore(PAGE_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(MEDIA_STORE)) {
        database.createObjectStore(MEDIA_STORE, { keyPath: "id" });
      }
      const transaction = request.transaction;
      const previousVersion = (event as IDBVersionChangeEvent).oldVersion;
      // 全新库（oldVersion 0）直接建当前结构；已有库才检查旧数据。
      if (previousVersion < 1 || !transaction) return;
      const reading = transaction.objectStore(META_STORE).get(ARCHIVE_ID);
      reading.onsuccess = () => {
        const record = reading.result as Record<string, unknown> | undefined;
        const version =
          typeof record?.archiveSchemaVersion === "number" ? record.archiveSchemaVersion : undefined;
        // 已经是当前结构：无需拦截。
        if (record && version === NOTEBOOK_ARCHIVE_VERSION) return;
        /*
         * R5/F2：**缺失或损坏的 meta 不能作为“空库”的证明**。
         * 只有把三个既有 store 与 meta 内容一起核对为空，才允许在这个旧库上升级；
         * 任何一处非空（含非法容器、额外的 meta 行）都中止 versionchange，
         * 保持原物理版本与原始记录。
         */
        const counts: Record<string, number> = { meta: -1, pages: -1, media: -1 };
        const evaluate = () => {
          if (Object.values(counts).some((value) => value < 0)) return;
          const metaUnreadable = record !== undefined && version === undefined;
          const metaUserData = record !== undefined && metaHasUserData(record);
          // F2：版本号可读但集合字段是非法容器 ⇒ 内容损坏，不算空库。
          const metaIllegalContainer = record !== undefined && metaHasIllegalContainer(record);
          // F2：meta store 只应有 archive 一条记录；多出来的行也是实际非空内容。
          const extraMetaRows = record === undefined ? counts.meta > 0 : counts.meta > 1;
          const nonEmpty =
            counts.pages > 0 ||
            counts.media > 0 ||
            metaUnreadable ||
            metaUserData ||
            metaIllegalContainer ||
            extraMetaRows;
          if (!nonEmpty) return;
          const metaReason =
            record === undefined
              ? "缺失"
              : metaUnreadable
                ? "版本不可读"
                : metaIllegalContainer
                  ? "集合字段损坏"
                  : metaUserData
                    ? "含用户数据"
                    : "含额外的 meta 行";
          resetRequired =
            `发现旧结构版本 ${String(version ?? "unknown")} 且有数据残留` +
            `（meta ${metaReason}、meta 行 ${counts.meta}、pages ${counts.pages}、media ${counts.media}）`;
          try {
            transaction.abort();
          } catch {
            // 事务可能已结束；拒绝结论仍然有效。
          }
        };
        for (const [key, store] of [
          ["meta", META_STORE],
          ["pages", PAGE_STORE],
          ["media", MEDIA_STORE]
        ] as const) {
          const counting = transaction.objectStore(store).count();
          counting.onsuccess = () => {
            counts[key] = counting.result;
            evaluate();
          };
        }
      };
    };
    request.onsuccess = () => {
      const database = request.result;
      // A newer database generation must retire this connection, including stale writers.
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => {
      const error = request.error;
      if (resetRequired) {
        reject(
          new NotebookStorageBlockedError(
            "reset-required",
            `${resetRequired}；本版本不自动清理或迁移，请按授权手动清理该环境后重试。`
          )
        );
        return;
      }
      if (error && error.name === "VersionError") {
        reject(
          new NotebookStorageBlockedError(
            "db-version-newer",
            "本地库由更新版本创建，当前版本无法打开（不会写入或降级）。"
          )
        );
        return;
      }
      reject(error ?? new Error("INDEXEDDB_OPEN_FAILED"));
    };
  });
}

const META_STORE = "meta";
const PAGE_STORE = "pages";
const MEDIA_STORE = "media";
const ARCHIVE_ID = "archive";

/**
 * IndexedDB 内的媒体记录：二进制以 ArrayBuffer 存储。
 * Blob 在各实现的结构化克隆行为不一致（fake-indexeddb 会丢成空对象），
 * 而 ArrayBuffer 在所有环境都能可靠往返；对外仍以 Blob 暴露。
 */
type StoredMediaRecord = Omit<NotebookMedia, "blob"> & { blobData: ArrayBuffer };

async function toStoredMedia(media: NotebookMedia): Promise<StoredMediaRecord> {
  const { blob, ...rest } = media;
  return { ...rest, blobData: await blob.arrayBuffer() };
}

// Binary preparation happens outside IDB transactions; comparisons inside are synchronous.
function sameMediaBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function fromStoredMedia(record: unknown): NotebookMedia | undefined {
  if (!record || typeof record !== "object") return undefined;
  const candidate = record as Partial<StoredMediaRecord> & { blob?: unknown };
  // 注意：不能依赖 instanceof 判断二进制类型。结构化克隆可能返回其他 realm 的
  // ArrayBuffer（byteLength 正确但 instanceof 为 false），因此按能力读取。
  const blob = toBlob(candidate.blobData ?? candidate.blob, candidate.type ?? "");
  if (!blob) return undefined;
  const {
    blobData,
    blob: legacyBlob,
    ...rest
  } = candidate as StoredMediaRecord & {
    blob?: unknown;
  };
  void blobData;
  void legacyBlob;
  const media: NotebookMedia = { ...(rest as Omit<NotebookMedia, "blob">), blob };
  return isNotebookMedia(media) ? media : undefined;
}

/** 只读元数据，不构造 Blob，也不读二进制。 */
function fromStoredMediaMeta(record: unknown): NotebookMediaMeta | undefined {
  if (!record || typeof record !== "object") return undefined;
  const candidate = record as Partial<StoredMediaRecord>;
  const meta: NotebookMediaMeta = {
    id: candidate.id ?? "",
    name: candidate.name ?? "",
    type: candidate.type ?? "",
    size: typeof candidate.size === "number" ? candidate.size : Number.NaN,
    createdAt: candidate.createdAt ?? "",
    ...(isNotebookMediaGps(candidate.gps) ? { gps: candidate.gps } : {})
  };
  return isMediaMeta(meta) ? meta : undefined;
}

/** 把任意类二进制（Blob / ArrayBuffer / TypedArray，含跨 realm 副本）读成 Blob。 */
function toBlob(value: unknown, fallbackType: string): Blob | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (isBlobLike(value)) {
    const typed = value as Blob;
    return new Blob([typed], { type: typed.type || fallbackType });
  }
  if (typeof (value as ArrayBuffer).byteLength === "number") {
    return new Blob([new Uint8Array(value as ArrayBuffer)], { type: fallbackType });
  }
  const view = value as ArrayBufferView;
  if (view.buffer && typeof view.byteLength === "number") {
    return new Blob([new Uint8Array(view.buffer as ArrayBuffer)], { type: fallbackType });
  }
  return undefined;
}

/**
 * meta store 中的单个记录：整档结构（除 pages）与 revision。
 * 记录自身版本固定为 1（物理布局），档案结构版本由 `archiveSchemaVersion` 记录。
 */
type MetaRecord = {
  id: string;
  schemaVersion: 1;
  archiveSchemaVersion: number;
  revision: NotebookRevision;
  notebooks: Notebook[];
  legacyImports: LegacyImportRecord[];
  tripJournals: NotebookTripJournal[];
  pageSources: NotebookPageSourceLink[];
  appendOperations: AppendOperationReceipt[];
  /** P1-03：AI 提交收据（缺省兼容）。 */
  aiCommitReceipts: AiCommitReceipt[];
  /** 024：永久删除墓碑与“旧垃圾桶已确认”时点（缺省兼容）。 */
  purgedPages: PurgedPageRecord[];
  trashConfirmedAt: string | null;
  /** P6：Trip/Place 与两类关系、永久删除墓碑（旧记录缺省按空数组解释）。 */
  trips?: Trip[];
  places?: Place[];
  tripPageLinks?: TripPageLink[];
  pagePlaceLinks?: PagePlaceLink[];
  purgedTrips?: PurgedTargetRecord[];
  purgedPlaces?: PurgedTargetRecord[];
  updatedAt: string;
};

function toMetaRecord(archive: ArchiveCore, updatedAt: string): MetaRecord {
  return {
    id: ARCHIVE_ID,
    schemaVersion: 1,
    archiveSchemaVersion: archive.schemaVersion,
    revision: archive.revision,
    notebooks: archive.notebooks,
    legacyImports: archive.legacyImports,
    tripJournals: archive.tripJournals ?? [],
    pageSources: archive.pageSources ?? [],
    appendOperations: archive.appendOperations ?? [],
    aiCommitReceipts: archive.aiCommitReceipts ?? [],
    purgedPages: archive.purgedPages ?? [],
    trashConfirmedAt: archive.trashConfirmedAt ?? null,
    // P6：六字段逐项写入 meta（漏一个就等于读时丢一个）。
    trips: archive.trips ?? [],
    places: archive.places ?? [],
    tripPageLinks: archive.tripPageLinks ?? [],
    pagePlaceLinks: archive.pagePlaceLinks ?? [],
    purgedTrips: archive.purgedTrips ?? [],
    purgedPlaces: archive.purgedPlaces ?? [],
    updatedAt
  };
}

function fromMetaRecord(meta: unknown, pages: NotebookPage[]): ArchiveCore {
  if (!meta || typeof meta !== "object") return { ...EMPTY_ARCHIVE_CORE };
  const record = meta as Partial<MetaRecord>;
  return normalizeArchiveCore({
    schemaVersion:
      typeof record.archiveSchemaVersion === "number" ? record.archiveSchemaVersion : 1,
    revision: record.revision,
    notebooks: record.notebooks,
    pages,
    legacyImports: record.legacyImports,
    tripJournals: record.tripJournals,
    pageSources: record.pageSources,
    appendOperations: record.appendOperations,
    aiCommitReceipts: record.aiCommitReceipts,
    purgedPages: record.purgedPages,
    trashConfirmedAt: record.trashConfirmedAt,
    // P6：六字段逐项读回；旧 meta 没有这些键时由 normalize 解释为空数组。
    trips: record.trips,
    places: record.places,
    tripPageLinks: record.tripPageLinks,
    pagePlaceLinks: record.pagePlaceLinks,
    purgedTrips: record.purgedTrips,
    purgedPlaces: record.purgedPlaces
  });
}

/** 在同一事务内读取完整档案（不做任何 await 之外的事，避免事务失活）。 */
async function readArchiveInTransaction(transaction: IDBTransaction): Promise<ArchiveCore> {
  const meta = await requestToPromise<unknown>(transaction.objectStore(META_STORE).get(ARCHIVE_ID));
  const pages = await requestToPromise<NotebookPage[]>(
    transaction.objectStore(PAGE_STORE).getAll()
  );
  return fromMetaRecord(meta, pages);
}

/** 在同一事务内写入档案（先写 meta，再增量写 pages，最后清理已删除页）。 */
async function writeArchiveInTransaction(
  transaction: IDBTransaction,
  archive: ArchiveCore,
  updatedAt: string
): Promise<void> {
  const pageStore = transaction.objectStore(PAGE_STORE);
  await requestToPromise(transaction.objectStore(META_STORE).put(toMetaRecord(archive, updatedAt)));
  const existingIds = (await requestToPromise<NotebookPage[]>(pageStore.getAll())).map(
    (page) => page.id
  );
  const nextIds = new Set(archive.pages.map((page) => page.id));
  for (const page of archive.pages) {
    await requestToPromise(pageStore.put(page));
  }
  for (const id of existingIds) {
    if (!nextIds.has(id)) await requestToPromise(pageStore.delete(id));
  }
}

/** IndexedDB 实现：meta / pages / media 三个 store。 */
export function createIndexedDbRepository(
  factory?: IDBFactory,
  now: () => Date = () => new Date(),
  /** T2a：按 serverId/userId 派生库名；缺省沿用旧单用户库名（既有测试/旧路径）。 */
  namespace?: { serverId: string; userId: string }
): NotebookRepository {
  const dbName = namespace
    ? `${NOTEBOOK_DB_NAME}--s-${sanitizeDbSegment(namespace.serverId)}-u-${sanitizeDbSegment(namespace.userId)}`
    : NOTEBOOK_DB_NAME;
  let databasePromise: Promise<IDBDatabase> | undefined;

  function getDatabase(): Promise<IDBDatabase> {
    // indexedDB 只在浏览器存在：不能在模块顶层或渲染期读取，否则 SSR 会抛
    // "indexedDB is not defined" 并导致整页回退到客户端渲染。
    const resolved = factory ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);
    if (!resolved) return Promise.reject(new Error("INDEXEDDB_UNAVAILABLE"));
    databasePromise ??= openDatabase(resolved, dbName);
    return databasePromise;
  }

  async function loadMediaRecords(): Promise<NotebookMedia[]> {
    const database = await getDatabase();
    const transaction = database.transaction(MEDIA_STORE, "readonly");
    const records = await requestToPromise<unknown[]>(
      transaction.objectStore(MEDIA_STORE).getAll()
    );
    await transactionDone(transaction);
    return records.map(fromStoredMedia).filter((item): item is NotebookMedia => Boolean(item));
  }

  return {
    async loadArchive() {
      const database = await getDatabase();
      const transaction = database.transaction([META_STORE, PAGE_STORE], "readonly");
      const archive = await readArchiveInTransaction(transaction);
      await transactionDone(transaction);
      return archive;
    },

    async saveArchive(archive) {
      const normalized = normalizeArchiveCore(archive);
      const database = await getDatabase();
      const transaction = database.transaction([META_STORE, PAGE_STORE], "readwrite");
      await runInTransaction(transaction, async () => {
        // Check persisted format in the same transaction; a cached older snapshot is insufficient.
        await readArchiveInTransaction(transaction);
        await writeArchiveInTransaction(transaction, normalized, now().toISOString());
        return { value: undefined, commit: true };
      });
    },

    async saveArchiveIfRevision(archive, expectedRevision) {
      const normalized = normalizeArchiveCore(archive);
      const database = await getDatabase();
      const transaction = database.transaction([META_STORE, PAGE_STORE], "readwrite");
      return await runInTransaction(transaction, async () => {
        const current = await readArchiveInTransaction(transaction);
        if (current.revision !== expectedRevision) {
          // 冲突是明确结论：中止事务并让调用方看到 RevisionConflictError。
          transaction.abort();
          throw new RevisionConflictError(expectedRevision, current.revision);
        }
        await writeArchiveInTransaction(transaction, normalized, now().toISOString());
        return { value: { revision: normalized.revision }, commit: true };
      });
    },

    async commitJournalChange(change, options = {}) {
      const records = await Promise.all((options.media ?? []).map(toStoredMedia));
      const database = await getDatabase();
      const transaction = database.transaction(
        [META_STORE, PAGE_STORE, ...(records.length ? [MEDIA_STORE] : [])],
        "readwrite"
      );
      return await runInTransaction(transaction, async () => {
        const current = await readArchiveInTransaction(transaction);
        if (
          options.expectedRevision !== undefined &&
          current.revision !== options.expectedRevision
        ) {
          throw new RevisionConflictError(options.expectedRevision, current.revision);
        }
        const next = normalizeArchiveCore(change(current));
        const committed: ArchiveCore = { ...next, revision: current.revision + 1 };
        for (const record of records) {
          const mediaStore = transaction.objectStore(MEDIA_STORE);
          const existing = await requestToPromise<StoredMediaRecord | undefined>(
            mediaStore.get(record.id)
          );
          if (existing) {
            // Legacy/unknown binary formats remain readable, but cannot safely be overwritten here.
            if (!existing.blobData || !sameMediaBytes(existing.blobData, record.blobData)) {
              throw new MediaContentConflictError(record.id);
            }
          } else {
            await requestToPromise(mediaStore.put(record));
          }
        }
        await writeArchiveInTransaction(transaction, committed, now().toISOString());
        return { value: { archive: committed, revision: committed.revision }, commit: true };
      });
    },

    async commitJournalChangeWithReceipt(change, receiptInput, options = {}) {
      const database = await getDatabase();
      /*
       * 收据判定、事务内校验与业务写入都在**同一个 readwrite 事务**：
       * - 三者不可能只成立一个；
       * - 媒体 store 也纳入本次事务，校验直接读它，不另开事务；
       * - 事务内只做本地 IndexedDB 读写，没有网络等待，不会让事务失活。
       */
      const stores = [META_STORE, PAGE_STORE, ...(options.guard ? [MEDIA_STORE] : [])];
      const transaction = database.transaction(stores, "readwrite");
      // F1：整个事务体在同一个异常边界内；任何失败都整体中止。
      return await runInTransaction(transaction, async () => {
        const current = await readArchiveInTransaction(transaction);
        const mediaRecords = options.guard
          ? await requestToPromise<unknown[]>(transaction.objectStore(MEDIA_STORE).getAll())
          : [];
        const resolution = resolveReceiptCommit(
          current,
          change,
          receiptInput,
          options.expectedRevision,
          receiptInput.now ?? now,
          mediaRecords,
          options.guard
        );
        if (resolution.kind === "stop") {
          // 重放/冲突/上限：不写任何业务数据；事务中止后返回既有结论。
          transaction.abort();
          return { value: resolution.outcome, commit: false };
        }
        const committed = normalizeArchiveCore(resolution.committed);
        await writeArchiveInTransaction(
          transaction,
          committed,
          (receiptInput.now ?? now)().toISOString()
        );
        return {
          value: {
            status: "committed" as const,
            archive: committed,
            revision: committed.revision,
            receipt: resolution.receipt
          },
          commit: true
        };
      });
    },

    async loadMedia() {
      return loadMediaRecords();
    },

    async loadMediaMetadata() {
      const database = await getDatabase();
      const transaction = database.transaction(MEDIA_STORE, "readonly");
      const store = transaction.objectStore(MEDIA_STORE);
      const keys = await requestToPromise<IDBValidKey[]>(store.getAllKeys());
      const metas: NotebookMediaMeta[] = [];
      for (const key of keys) {
        const meta = fromStoredMediaMeta(await requestToPromise<unknown>(store.get(key)));
        if (meta) metas.push(meta);
      }
      await transactionDone(transaction);
      return metas;
    },

    async loadMediaBlob(mediaId) {
      const database = await getDatabase();
      const transaction = database.transaction(MEDIA_STORE, "readonly");
      const record = await requestToPromise<unknown>(
        transaction.objectStore(MEDIA_STORE).get(mediaId)
      );
      await transactionDone(transaction);
      return fromStoredMedia(record)?.blob;
    },

    async loadMediaBlobs(mediaIds) {
      const database = await getDatabase();
      const transaction = database.transaction(MEDIA_STORE, "readonly");
      const store = transaction.objectStore(MEDIA_STORE);
      const blobs: (Blob | undefined)[] = [];
      for (const mediaId of mediaIds) {
        const record = await requestToPromise<unknown>(store.get(mediaId));
        blobs.push(fromStoredMedia(record)?.blob);
      }
      await transactionDone(transaction);
      return blobs;
    },

    async saveMedia(media) {
      const database = await getDatabase();
      // 同一事务内先读现有内容再写：并发写入时后写者会看到前者结果，不会静默覆盖。
      const transaction = database.transaction(MEDIA_STORE, "readwrite");
      const store = transaction.objectStore(MEDIA_STORE);
      for (const item of media) {
        const existing = fromStoredMedia(await requestToPromise<unknown>(store.get(item.id)));
        if (existing) {
          const [before, after] = await Promise.all([
            digestMediaContent(existing.blob),
            digestMediaContent(item.blob)
          ]);
          if (before !== after) {
            transaction.abort();
            throw new MediaContentConflictError(item.id);
          }
          continue;
        }
        await requestToPromise(store.put(await toStoredMedia(item)));
      }
      await transactionDone(transaction);
    },

    async removeMedia(mediaId) {
      const database = await getDatabase();
      const transaction = database.transaction(MEDIA_STORE, "readwrite");
      await requestToPromise(transaction.objectStore(MEDIA_STORE).delete(mediaId));
      await transactionDone(transaction);
    },

    async updateMediaGps(entries, options) {
      if (entries.length === 0) return 0;
      const database = await getDatabase();
      // 单事务批量写：任一 mediaId 缺失 → 整体失败，不部分写入（M1.5 验收）。
      const transaction = database.transaction(MEDIA_STORE, "readwrite");
      const store = transaction.objectStore(MEDIA_STORE);
      let written = 0;
      try {
        for (const entry of entries) {
          const record = await requestToPromise<unknown>(store.get(entry.mediaId));
          if (!record) {
            throw new Error(`MEDIA_NOT_FOUND:${entry.mediaId}`);
          }
          // 原样展开写入目标记录，只覆盖 gps：旧格式记录的 blob 字段（及任何
          // 未知字段）必须完整保留——曾把 blob 拆掉重组导致旧记录二进制丢失。
          const current = record as { gps?: unknown };
          if (options?.onlyIfAbsent && current.gps) continue;
          await requestToPromise(store.put({ ...(record as object), gps: entry.gps }));
          written += 1;
        }
        await transactionDone(transaction);
        return written;
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // 事务可能已失败；中止是尽力而为。
        }
        throw error;
      }
    },

    async clearMediaGps(mediaIds) {
      if (mediaIds.length === 0) return 0;
      const database = await getDatabase();
      const transaction = database.transaction(MEDIA_STORE, "readwrite");
      const store = transaction.objectStore(MEDIA_STORE);
      let cleared = 0;
      try {
        for (const mediaId of mediaIds) {
          const record = await requestToPromise<unknown>(store.get(mediaId));
          if (!record) continue;
          const candidate = record as StoredMediaRecord;
          if (!candidate.gps) continue;
          const { gps, ...rest } = candidate;
          void gps;
          await requestToPromise(store.put(rest));
          cleared += 1;
        }
        await transactionDone(transaction);
        return cleared;
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // 同上。
        }
        throw error;
      }
    },

    async purgeTrash(input) {
      const database = await getDatabase();
      // pages / meta / media 同一事务：引用核对与删除之间没有窗口。
      const transaction = database.transaction([META_STORE, PAGE_STORE, MEDIA_STORE], "readwrite");
      /*
       * 整个事务体在同一个异常边界内（与 F1 的收据写入口同一处理）：
       * 页删除请求一旦发出，后续任一同步异常或请求失败都必须显式中止事务，
       * 否则会出现“页已从 pages store 删除、meta 与媒体未更新”的半删除。
       */
      return await runInTransaction(transaction, async () => {
        const current = await readArchiveInTransaction(transaction);
        if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
          transaction.abort();
          return {
            value: { status: "conflict", currentRevision: current.revision } as PurgeOutcome,
            commit: false
          };
        }
        const plan = purgeTargets(current, input.targets);
        if (plan.pageIds.length === 0 && plan.notebookIds.length === 0) {
          transaction.abort();
          return {
            value: {
              status: "skipped",
              archive: current,
              reason: "identity-changed",
              skipped: plan.skipped
            } as PurgeOutcome,
            commit: false
          };
        }
        const pageStore = transaction.objectStore(PAGE_STORE);
        for (const pageId of plan.pageIds) {
          await requestToPromise(pageStore.delete(pageId));
        }
        const mediaStore = transaction.objectStore(MEDIA_STORE);
        for (const mediaId of plan.mediaIds) {
          await requestToPromise(mediaStore.delete(mediaId));
        }
        const next = normalizeArchiveCore(applyPurge(current, plan, now));
        const committed: ArchiveCore = { ...next, revision: current.revision + 1 };
        await writeArchiveInTransaction(transaction, committed, now().toISOString());
        return {
          value: {
            status: "purged",
            archive: committed,
            revision: committed.revision,
            purged: plan
          } as PurgeOutcome,
          commit: true
        };
      });
    },

    async clear() {
      const database = await getDatabase();
      const transaction = database.transaction([META_STORE, PAGE_STORE, MEDIA_STORE], "readwrite");
      await Promise.all([
        requestToPromise(transaction.objectStore(META_STORE).clear()),
        requestToPromise(transaction.objectStore(PAGE_STORE).clear()),
        requestToPromise(transaction.objectStore(MEDIA_STORE).clear())
      ]);
      await transactionDone(transaction);
    }
  };
}

/** 内存实现：用于测试，以及“导出后在隔离存储中恢复”的演练。 */
export function createMemoryRepository(now: () => Date = () => new Date()): NotebookRepository & {
  readonly store: { archive: ArchiveCore; media: NotebookMedia[] };
} {
  const store: { archive: ArchiveCore; media: NotebookMedia[] } = {
    archive: normalizeArchiveCore(EMPTY_ARCHIVE_CORE),
    media: []
  };
  const memorySaveMedia = async (media: NotebookMedia[]): Promise<void> => {
    const byId = new Map(store.media.map((item) => [item.id, item] as const));
    for (const item of media) {
      const existing = byId.get(item.id);
      if (existing) {
        const [before, after] = await Promise.all([
          digestMediaContent(existing.blob),
          digestMediaContent(item.blob)
        ]);
        // 同 ID 不同内容一律拒绝，不覆盖已有笔记本正在使用的图片。
        if (before !== after) throw new MediaContentConflictError(item.id);
        continue;
      }
      byId.set(item.id, item);
    }
    store.media = [...byId.values()];
  };
  return {
    store,
    async loadArchive() {
      return normalizeArchiveCore(store.archive);
    },
    async saveArchive(archive) {
      assertSupportedArchiveVersion(store.archive);
      store.archive = normalizeArchiveCore(archive);
    },
    async saveArchiveIfRevision(archive, expectedRevision) {
      assertSupportedArchiveVersion(store.archive);
      const normalized = normalizeArchiveCore(archive);
      if (store.archive.revision !== expectedRevision) {
        throw new RevisionConflictError(expectedRevision, store.archive.revision);
      }
      store.archive = normalized;
      return { revision: normalized.revision };
    },
    async commitJournalChange(change, options = {}) {
      const incoming = options.media ?? [];
      const prepared = await Promise.all(incoming.map(toStoredMedia));
      // Preparation may yield: use a stable snapshot, then validate and publish without awaits.
      let snapshot: NotebookMedia[];
      let existingRecords: StoredMediaRecord[];
      do {
        snapshot = store.media;
        existingRecords = await Promise.all(
          snapshot.filter((item) => incoming.some((next) => next.id === item.id)).map(toStoredMedia)
        );
      } while (snapshot !== store.media);
      const current = normalizeArchiveCore(store.archive);
      if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) {
        throw new RevisionConflictError(options.expectedRevision, current.revision);
      }
      const next = normalizeArchiveCore(change(current));
      const result: ArchiveCore = { ...next, revision: current.revision + 1 };
      const byId = new Map(existingRecords.map((record) => [record.id, record]));
      const nextMedia = [...snapshot];
      prepared.forEach((record, index) => {
        const existing = byId.get(record.id);
        if (existing && !sameMediaBytes(existing.blobData, record.blobData)) {
          throw new MediaContentConflictError(record.id);
        }
        if (!existing) {
          byId.set(record.id, record);
          nextMedia.push(incoming[index]);
        }
      });
      store.media = nextMedia;
      store.archive = result;
      return { archive: result, revision: result.revision };
    },
    async commitJournalChangeWithReceipt(change, receiptInput, options = {}) {
      const current = normalizeArchiveCore(store.archive);
      const resolution = resolveReceiptCommit(
        current,
        change,
        receiptInput,
        options.expectedRevision,
        receiptInput.now ?? now,
        store.media,
        options.guard
      );
      if (resolution.kind === "stop") return resolution.outcome;
      const committed = normalizeArchiveCore(resolution.committed);
      store.archive = committed;
      return {
        status: "committed",
        archive: committed,
        revision: committed.revision,
        receipt: resolution.receipt
      };
    },
    async loadMedia() {
      return [...store.media];
    },
    async loadMediaMetadata() {
      return store.media.map(toMediaMeta);
    },
    async loadMediaBlob(mediaId) {
      return store.media.find((media) => media.id === mediaId)?.blob;
    },
    async loadMediaBlobs(mediaIds) {
      return mediaIds.map((mediaId) => store.media.find((media) => media.id === mediaId)?.blob);
    },
    async saveMedia(media) {
      await memorySaveMedia(media);
    },
    async updateMediaGps(entries, options) {
      if (entries.length === 0) return 0;
      const byId = new Map(store.media.map((item) => [item.id, item] as const));
      for (const entry of entries) {
        if (!byId.has(entry.mediaId)) throw new Error(`MEDIA_NOT_FOUND:${entry.mediaId}`);
      }
      // 先全量校验再写入：缺 ID 整体失败，不产生半更新。
      let written = 0;
      for (const entry of entries) {
        const existing = byId.get(entry.mediaId)!;
        if (options?.onlyIfAbsent && existing.gps) continue;
        byId.set(entry.mediaId, { ...existing, gps: entry.gps });
        written += 1;
      }
      store.media = [...byId.values()];
      return written;
    },
    async clearMediaGps(mediaIds) {
      const ids = new Set(mediaIds);
      let cleared = 0;
      store.media = store.media.map((item) => {
        if (!ids.has(item.id) || !item.gps) return item;
        const { gps, ...rest } = item;
        void gps;
        cleared += 1;
        return rest as NotebookMedia;
      });
      return cleared;
    },
    async purgeTrash(input) {
      const current = normalizeArchiveCore(store.archive);
      if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
        return { status: "conflict", currentRevision: current.revision };
      }
      const plan = purgeTargets(current, input.targets);
      if (plan.pageIds.length === 0 && plan.notebookIds.length === 0) {
        return {
          status: "skipped",
          archive: current,
          reason: "identity-changed",
          skipped: plan.skipped
        };
      }
      const next = normalizeArchiveCore(applyPurge(current, plan, now));
      const result: ArchiveCore = { ...next, revision: current.revision + 1 };
      store.archive = result;
      const mediaIdSet = new Set(plan.mediaIds);
      store.media = store.media.filter((media) => !mediaIdSet.has(media.id));
      return { status: "purged", archive: result, revision: result.revision, purged: plan };
    },
    async removeMedia(mediaId) {
      store.media = store.media.filter((media) => media.id !== mediaId);
    },
    async clear() {
      store.archive = normalizeArchiveCore(EMPTY_ARCHIVE_CORE);
      store.media = [];
    }
  };
}

/**
 * 提交一次改动：先写媒体、再写结构化档案。
 * 媒体写入失败时直接抛出且**不写档案**，因此不会产生“页面已保存但图片缺失”的记录。
 *
 * 注意：这是“媒体 + 档案”的顺序提交，不是跨 store 原子的。
 * 需要在同一事务内完成“读最新档案 → 校验 revision → 写回”时用
 * `NotebookRepository.commitJournalChange`。
 */
export async function commitArchiveChange(
  repository: NotebookRepository,
  next: ArchiveCore,
  pendingMedia: NotebookMedia[] = []
): Promise<void> {
  if (pendingMedia.length > 0) {
    await repository.saveMedia(pendingMedia);
  }
  await repository.saveArchive(next);
}

export const NOTEBOOK_META_STORE = META_STORE;
export const NOTEBOOK_PAGE_STORE = PAGE_STORE;
export const NOTEBOOK_MEDIA_STORE = MEDIA_STORE;
export const NOTEBOOK_PAGE_BLOCK_HARD_LIMIT = MAX_PAGE_BLOCKS_HARD_LIMIT;

export { EMPTY_NOTEBOOK_ARCHIVE };
