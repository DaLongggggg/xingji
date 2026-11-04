import {
  addPageSourceLinks,
  createNotebookId,
  findAppendOperation,
  fingerprintParts,
  governAppendOperationLog,
  listPageSourceLinks,
  type AppendDuplicatePolicy,
  MAX_MEDIA_BYTES,
  MAX_PAGE_TEXT_LENGTH,
  MAX_PAGE_TITLE_LENGTH,
  NOTEBOOK_ARCHIVE_VERSION,
  type AppendOperationReceipt,
  type NotebookMedia,
  type NotebookPage,
  type NotebookPageBlock,
  type NotebookPageSourceLink,
  type NotebookRevision
} from "./notebook-model";
import {
  checkSingleAssetSize,
  formatCapacityViolation,
  measurePageCapacity,
  PAGE_CAPACITY_LIMITS,
  type PageCapacityViolation
} from "./notebook-capacity";
import {
  MediaContentConflictError,
  RevisionConflictError,
  type ArchiveCore,
  type NotebookRepository
} from "./notebook-repository";

/**
 * 014-A 追加服务。产品规则：追加永远放在末尾，已有块 ID/内容/相对顺序不变；
 * 同 operationId 同输入重试返回原结果，同 ID 不同输入明确拒绝；
 * 默认遇到重复来源返回 needs-confirmation 且不写库。
 */

/**
 * 014-B：用户确认后的正文草稿契约。
 *
 * 用户在预览里改过的 Markdown/文字不能从原始记录重新推导，因此必须作为**显式输入**
 * 传入新建/追加服务：它既决定写入的块，也参与幂等摘要。回读保存结果时必须与该草稿一致。
 */
export type JournalTextBlockDraft = { type: "text"; text: string };

export type JournalDraftEntry =
  | { kind: "message"; messageId: string; blocks: JournalTextBlockDraft[] }
  | { kind: "photo"; assetId: string; caption: string };

export type JournalDraft = { entries: JournalDraftEntry[] };

/** 按草稿生成块：文字用草稿内容（含用户编辑），图片仍用来源资产身份。 */
export function blocksFromJournalDraft(draft: JournalDraft): NotebookPageBlock[] {
  const blocks: NotebookPageBlock[] = [];
  draft.entries.forEach((entry, index) => {
    if (entry.kind === "photo") {
      blocks.push({
        id: `blk-draft-${index}-p`,
        type: "photo",
        mediaId: entry.assetId,
        caption: entry.caption
      });
      return;
    }
    entry.blocks.forEach((block, blockIndex) => {
      blocks.push({
        id: `blk-draft-${index}-${blockIndex}-t`,
        type: "text",
        text: block.text
      });
    });
  });
  return blocks;
}

/**
 * 把草稿里的**来源媒体 ID**替换为准备后的笔记资产 ID。
 * 草稿由 UI 生成（只知道来源媒体 ID），资产身份在服务准备媒体之后才确定；
 * 这一步让写入结果与确认的预览顺序一致，同时保持资产身份由服务拥有。
 */
export function resolveDraftAssetIds(
  draft: JournalDraft,
  link: { sourceMediaId: string; assetId: string; messageId: string; name?: string }[]
): JournalDraft {
  const bySourceId = new Map(link.map((item) => [item.sourceMediaId, item] as const));
  return {
    entries: draft.entries.map((entry) => {
      if (entry.kind !== "photo") return entry;
      const resolved = bySourceId.get(entry.assetId);
      return {
        ...entry,
        assetId: resolved?.assetId ?? entry.assetId,
        caption: entry.caption || resolved?.name || resolved?.assetId || entry.assetId
      };
    })
  };
}

/** 以记录为单位的默认草稿：每条记录的文本 + 其图片，顺序与基础排版一致。 */
export function draftFromSnapshots(sources: AppendSourceSnapshot[]): JournalDraft {
  const entries: JournalDraftEntry[] = [];
  sources.forEach((source) => {
    entries.push({
      kind: "message",
      messageId: source.messageId,
      blocks: [{ type: "text", text: source.text }]
    });
    for (const item of source.media) {
      entries.push({ kind: "photo", assetId: item.assetId, caption: item.name });
    }
  });
  return { entries };
}

export type AppendSourceSnapshot = {
  /** 原始记录 ID（稳定关联身份）。 */
  messageId: string;
  text: string;
  capturedAt: string;
  /**
   * 追加时**必须**能读到原始记录内容；读不到时置 false / 缺字段即明确失败，
   * 不按空文本继续（也不重新创建原记录）。
   */
  messageFound?: boolean;
  media: {
    /** 笔记本自有资产 ID（提交前已准备好）。 */
    assetId: string;
    name: string;
    type: string;
    size: number;
    createdAt: string;
    /** 来源媒体 ID，仅用于来源追溯。 */
    sourceMediaId: string;
  }[];
};

export type AppendCapturesRequest = {
  pageId: string;
  operationId: string;
  expectedRevision: NotebookRevision;
  duplicatePolicy: AppendDuplicatePolicy;
  sources: AppendSourceSnapshot[];
  /** 用户确认的正文草稿；缺省时按来源文本原样生成（等价草稿）。 */
  draft?: JournalDraft;
};

export type AppendRejectCode =
  | "INVALID_REQUEST"
  | "OPERATION_ID_REUSED_WITH_DIFFERENT_INPUT"
  | "PAGE_NOT_FOUND"
  /** 目标篇已被永久删除：同一 operationId 不得复活页面，也不能谎报“已应用”。 */
  | "TARGET_PURGED"
  | "SOURCE_MESSAGE_MISSING"
  | "CAPACITY_EXCEEDED"
  /** P3-01：追加收据台账达到字节预算（压缩历史明细后仍超限），拒绝本次新操作。 */
  | "OPERATION_LOG_FULL"
  | "MEDIA_NOT_PREPARED"
  /** 同 ID 但内容与既有笔记资产不同：拒绝写入，绝不覆盖已有图片。 */
  | "MEDIA_ID_CONFLICT";

/** 台账预算触顶的用户可见说明（P3-01）：原 Capture 记录保留，可重试上下文不受影响。 */
export const OPERATION_LOG_FULL_DETAIL =
  "操作记录已达安全容量上限，为避免丢失幂等保护，本次操作已拒绝。";

/**
 * P3-01：追加收据台账达到字节预算（governAppendOperationLog 压缩后仍超限）。
 * 只在真正要写入新收据时抛出；已有操作的合法重放不经过本错误
 * （重放/同 ID 不同输入判定在 planAppendCaptures 中先于容量治理完成）。
 */
export class OperationLogBudgetExceededError extends Error {
  constructor() {
    super(`APPEND_OPERATION_LOG_BUDGET_EXCEEDED:${OPERATION_LOG_FULL_DETAIL}`);
    this.name = "OperationLogBudgetExceededError";
  }
}

export type AppendCapturesResult =
  | {
      status: "applied";
      pageId: string;
      revision: NotebookRevision;
      appliedMessageIds: string[];
      appendedBlockIds: string[];
      appendedMediaIds: string[];
      /** 同 operationId + 同输入的重试：返回原结果，不重复写库。 */
      replayed: boolean;
    }
  | {
      status: "skipped-all-duplicates";
      pageId: string;
      revision: NotebookRevision;
      skippedMessageIds: string[];
    }
  | { status: "needs-confirmation"; duplicateMessageIds: string[]; reason: string }
  | { status: "conflict"; expectedRevision: NotebookRevision; actualRevision: NotebookRevision }
  | { status: "rejected"; code: AppendRejectCode; detail: string };

/** 稳定规范化 JSON：对象键排序、数组保序，不依赖对象偶然序列化顺序。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/** 请求摘要：只含影响结果的稳定字段。 */
export function appendRequestDigest(request: AppendCapturesRequest): string {
  return fingerprintParts([
    canonicalJson({
      pageId: request.pageId,
      duplicatePolicy: request.duplicatePolicy,
      draft: request.draft ?? null,
      sources: request.sources.map((source) => ({
        messageId: source.messageId,
        text: source.text,
        capturedAt: source.capturedAt,
        messageFound: source.messageFound !== false,
        media: source.media.map((item) => ({
          assetId: item.assetId,
          name: item.name,
          type: item.type,
          size: item.size,
          createdAt: item.createdAt,
          sourceMediaId: item.sourceMediaId
        }))
      }))
    })
  ]);
}

/** 来源内容指纹：登记加入时的快照，来源后续变化不改变已加入内容。 */
export function sourceSnapshotDigest(source: AppendSourceSnapshot): string {
  return fingerprintParts([
    canonicalJson({
      messageId: source.messageId,
      text: source.text,
      capturedAt: source.capturedAt,
      media: source.media.map((item) => [item.sourceMediaId, item.size])
    })
  ]);
}

export type AppendPlan = {
  request: AppendCapturesRequest;
  requestDigest: string;
  pageId: string;
  /** 实际要追加的来源（重复项按策略处理后的结果）。 */
  acceptedSources: AppendSourceSnapshot[];
  skippedMessageIds: string[];
  duplicateMessageIds: string[];
  duplicateIntent: boolean;
  blocks: NotebookPageBlock[];
  sourceLinks: NotebookPageSourceLink[];
  media: NotebookMedia[];
  receipt: AppendOperationReceipt;
};

export type AppendPlanResult =
  | { status: "planned"; plan: AppendPlan }
  | Extract<AppendCapturesResult, { status: "needs-confirmation" | "rejected" }>
  | { status: "replayed"; result: Extract<AppendCapturesResult, { status: "applied" }> }
  | { status: "skipped-all-duplicates"; skippedMessageIds: string[] };

function invalidRequest(detail: string): Extract<AppendCapturesResult, { status: "rejected" }> {
  return { status: "rejected", code: "INVALID_REQUEST", detail };
}

/**
 * 来源快照与单张上限校验（追加与“新建即写入”共用）。
 * 这里刻意**不**检查“本次张数 ≤ 10”：勾选多条已保存记录不是一次文件选择，
 * 累计超过 10 张但符合整篇上限时必须整体提交（014-B 第 3 节）；
 * 10 张限制由文件选择入口与整篇 100 图配额负责。
 */
function validateSources(request: {
  operationId: string;
  sources: AppendSourceSnapshot[];
}): Extract<AppendCapturesResult, { status: "rejected" }> | undefined {
  if (!request.operationId) return invalidRequest("缺少操作 ID，无法保证重试幂等。");
  if (request.sources.length === 0) return invalidRequest("本次没有可追加的来源记录。");
  for (const source of request.sources) {
    if (!source.messageId) return invalidRequest("来源记录缺少稳定 ID。");
    if (source.messageFound === false) {
      return {
        status: "rejected",
        code: "SOURCE_MESSAGE_MISSING",
        detail: `来源记录 ${source.messageId} 无法读取，未追加（不按空文本继续）。`
      };
    }
    if (source.text.length > MAX_PAGE_TEXT_LENGTH) {
      return invalidRequest(`来源记录 ${source.messageId} 的文本超过单块长度上限。`);
    }
    for (const item of source.media) {
      if (!item.assetId) return invalidRequest("媒体资产缺少笔记资产 ID。");
      const violation = checkSingleAssetSize(
        { assetId: item.assetId, name: item.name, size: item.size },
        PAGE_CAPACITY_LIMITS
      );
      if (violation)
        return {
          status: "rejected",
          code: "CAPACITY_EXCEEDED",
          detail: formatCapacityViolation(violation)
        };
    }
  }
  return undefined;
}

function validateRequest(
  request: AppendCapturesRequest
): Extract<AppendCapturesResult, { status: "rejected" }> | undefined {
  if (!request.pageId) return invalidRequest("缺少目标篇 ID。");
  if (!Number.isInteger(request.expectedRevision) || request.expectedRevision < 0) {
    return invalidRequest("expectedRevision 必须是大于等于 0 的整数。");
  }
  return validateSources(request);
}

/** 由来源快照推出来源媒体 ID → 资产 ID 的映射（用于解析草稿中的图片引用）。 */
function planLink(
  sources: AppendSourceSnapshot[]
): { sourceMediaId: string; assetId: string; messageId: string; name: string }[] {
  return sources.flatMap((source) =>
    source.media.map((item) => ({
      sourceMediaId: item.sourceMediaId,
      assetId: item.assetId,
      messageId: source.messageId,
      name: item.name
    }))
  );
}

/** 草稿里下一个“记录”条目的下标，用于界定该记录的块区间。 */
function nextDraftEntryStart(draft: JournalDraft, entryIndex: number): number {
  for (let index = entryIndex + 1; index < draft.entries.length; index += 1) {
    if (draft.entries[index].kind === "message") return index;
  }
  return draft.entries.length;
}

function duplicateAgainstPage(archive: ArchiveCore, pageId: string, messageId: string): boolean {
  return listPageSourceLinks(archive, pageId).some((link) => link.messageId === messageId);
}

/**
 * 计算追加计划（纯函数，不做 I/O）。
 * 事务内调用它时同样成立：输入是已规范化参数与事务内最新档案。
 */
export function planAppendCaptures(
  archive: ArchiveCore,
  request: AppendCapturesRequest,
  now: () => Date = () => new Date()
): AppendPlanResult {
  const invalid = validateRequest(request);
  if (invalid) return invalid;

  const requestDigest = appendRequestDigest(request);

  // 幂等：同 operationId 同输入返回原结果；同 ID 不同输入拒绝。
  const existing = findAppendOperation(archive, request.operationId);
  if (existing) {
    if (existing.requestDigest !== requestDigest) {
      return {
        status: "rejected",
        code: "OPERATION_ID_REUSED_WITH_DIFFERENT_INPUT",
        detail: `操作 ${request.operationId} 已用不同输入提交过，拒绝复用该操作 ID。`
      };
    }
    // 目标已被永久删除：这是最小幂等终态，不是“已应用”，也绝不复活页面。
    if (existing.status === "purged") {
      return {
        status: "rejected",
        code: "TARGET_PURGED",
        detail: `操作 ${request.operationId} 的目标篇已被永久删除，本次未追加任何内容。`
      };
    }
    return {
      status: "replayed",
      result: {
        status: "applied",
        pageId: existing.pageId,
        revision: existing.resultRevision,
        appliedMessageIds: existing.messageIds,
        appendedBlockIds: existing.appendedBlockIds,
        appendedMediaIds: existing.appendedMediaIds,
        replayed: true
      }
    };
  }

  const page = archive.pages.find((item) => item.id === request.pageId);
  if (!page) {
    return {
      status: "rejected",
      code: "PAGE_NOT_FOUND",
      detail: `找不到目标篇 ${request.pageId}，未追加。`
    };
  }

  // 重复识别：篇内已加入（稳定 messageId）或本次来源内部重复。
  const seenInRequest = new Set<string>();
  const duplicateMessageIds: string[] = [];
  for (const source of request.sources) {
    if (duplicateAgainstPage(archive, page.id, source.messageId)) {
      duplicateMessageIds.push(source.messageId);
      continue;
    }
    if (seenInRequest.has(source.messageId)) duplicateMessageIds.push(source.messageId);
    seenInRequest.add(source.messageId);
  }

  if (duplicateMessageIds.length > 0 && request.duplicatePolicy === "needs-confirmation") {
    return {
      status: "needs-confirmation",
      duplicateMessageIds,
      reason: `有 ${duplicateMessageIds.length} 条记录已在本文中，默认先不写入。`
    };
  }

  const acceptedSources =
    request.duplicatePolicy === "skip"
      ? request.sources.filter((source) => !duplicateMessageIds.includes(source.messageId))
      : request.sources;

  if (acceptedSources.length === 0) {
    return { status: "skipped-all-duplicates", skippedMessageIds: duplicateMessageIds };
  }

  const timestamp = now().toISOString();
  const blocks: NotebookPageBlock[] = [];
  const sourceLinks: NotebookPageSourceLink[] = [];
  const media: NotebookMedia[] = [];
  const appendedMediaIds: string[] = [];

  const draft = request.draft
    ? resolveDraftAssetIds(request.draft, planLink(acceptedSources))
    : draftFromSnapshots(acceptedSources);
  const draftBlocks = blocksFromJournalDraft(draft).map((block, index) => ({
    ...block,
    // 块 ID 稳定绑定 operationId + 草稿位置：重试得到同一批 ID，不产生重复。
    id: `blk-${request.operationId}-${index}`
  }));
  blocks.push(...draftBlocks);

  acceptedSources.forEach((source, index) => {
    // 该记录在草稿中的块：按草稿顺序把块分配给对应记录，来源关联仍按记录登记。
    const draftEntryIndex = draft.entries.findIndex(
      (entry) => entry.kind === "message" && entry.messageId === source.messageId
    );
    const photoAssetIds = source.media.map((item) => item.assetId);
    const blockIds = draftBlocks
      .filter((block) => photoAssetIds.includes(block.type === "photo" ? block.mediaId : ""))
      .map((block) => block.id);
    const textBlockIds =
      draftEntryIndex >= 0
        ? draftBlocks
            .slice(draftEntryIndex, nextDraftEntryStart(draft, draftEntryIndex))
            .filter((block) => block.type === "text")
            .map((block) => block.id)
        : [];
    blockIds.unshift(...textBlockIds);
    const mediaAssetIds = photoAssetIds;
    appendedMediaIds.push(...mediaAssetIds);
    for (const item of source.media) {
      media.push({
        id: item.assetId,
        name: item.name,
        type: item.type,
        size: item.size,
        createdAt: item.createdAt || timestamp,
        blob: new Blob([], { type: item.type }),
        origin: {
          kind: "capture-message",
          messageId: source.messageId,
          sourceMediaId: item.sourceMediaId
        }
      });
    }
    void index;
    sourceLinks.push({
      pageId: page.id,
      messageId: source.messageId,
      snapshotDigest: sourceSnapshotDigest(source),
      blockIds,
      mediaAssetIds,
      appendedAt: timestamp,
      operationId: request.operationId
    });
  });

  // 收据的 resultRevision 在提交时填真实值；计划阶段先用 expectedRevision + 1。
  const receipt: AppendOperationReceipt = {
    operationId: request.operationId,
    pageId: page.id,
    requestDigest,
    status: "applied",
    duplicateIntent: request.duplicatePolicy === "append-duplicate",
    appendedBlockIds: blocks.map((block) => block.id),
    appendedMediaIds,
    messageIds: acceptedSources.map((source) => source.messageId),
    skippedMessageIds: request.duplicatePolicy === "skip" ? duplicateMessageIds : [],
    resultRevision: request.expectedRevision + 1,
    createdAt: timestamp
  };

  return {
    status: "planned",
    plan: {
      request,
      requestDigest,
      pageId: page.id,
      acceptedSources,
      skippedMessageIds: receipt.skippedMessageIds,
      duplicateMessageIds,
      duplicateIntent: receipt.duplicateIntent,
      blocks,
      sourceLinks,
      media,
      receipt
    }
  };
}

/** 把计划应用到档案（纯函数）：已有块 ID/内容/顺序不变，新块追加末尾。 */
export function applyAppendPlan(archive: ArchiveCore, plan: AppendPlan): ArchiveCore {
  const page = archive.pages.find((item) => item.id === plan.pageId);
  if (!page) throw new Error("PAGE_NOT_FOUND");
  const updatedPage: NotebookPage = { ...page, blocks: [...page.blocks, ...plan.blocks] };
  const withPage: ArchiveCore = {
    ...archive,
    pages: archive.pages.map((item) => (item.id === page.id ? updatedPage : item))
  };
  const withLinks = addPageSourceLinks(withPage, plan.sourceLinks);
  /*
   * P3-01 容量治理：候选数组 = 已有收据 + 本次新收据。超预算先按稳定历史顺序
   * 压缩最旧 applied 收据（最近 K 条完整），压缩后仍超限则整体拒绝。
   * 治理与业务写入在同一个事务回调内完成，失败一起回滚，不单独保存压缩结果。
   */
  const governed = governAppendOperationLog(
    [...(withLinks.appendOperations ?? []), plan.receipt],
    plan.receipt
  );
  if (!governed) throw new OperationLogBudgetExceededError();
  return { ...withLinks, appendOperations: governed };
}

/**
 * 提交前的容量关口：按最终引用集计算，超限整次拒绝（保留原档案与草稿）。
 * 媒体大小来自已落库元数据与本次待写媒体，不接受缩略图预计值。
 */
export function checkAppendCapacity(
  base: ArchiveCore,
  plan: AppendPlan,
  assetSizes: Record<string, number>
): PageCapacityViolation[] {
  const next = applyAppendPlan(base, plan);
  const page = next.pages.find((item) => item.id === plan.pageId);
  if (!page) return [];
  const sizes = { ...assetSizes };
  plan.media.forEach((item) => {
    sizes[item.id] = item.size;
  });
  const measurement = measurePageCapacity({
    page,
    assetSizes: sizes,
    limits: PAGE_CAPACITY_LIMITS
  });
  // 历史缺图（旧数据）不应把无关的追加判成超限；有未解析资产时按“已知字节下界”判断，
  // 悬空引用由写入边界校验单独拒绝。
  const hasUnresolved = measurement.unresolvedMediaIds.length > 0;
  const totalBytes = hasUnresolved
    ? measurement.textBytes +
      measurement.assetBytes +
      plan.media.reduce((total, item) => total + item.size, 0)
    : measurement.totalBytes;
  const violations: PageCapacityViolation[] = measurement.violations.filter(
    (violation) => violation.kind !== "page-total"
  );
  if (totalBytes > PAGE_CAPACITY_LIMITS.totalBytes) {
    violations.push({
      kind: "page-total",
      limit: PAGE_CAPACITY_LIMITS.totalBytes,
      actual: totalBytes
    });
  }
  // 这里**不**套用“每次选择 10 张”的批次上限：勾选多条已保存记录不是一次文件选择，
  // 累计超过 10 张但符合整篇 100 图 / 500 MB 时必须整体追加（014-B 第 3 节）。
  // 单张上限仍逐条检查，10 张限制只由文件选择入口把关。
  for (const item of plan.media) {
    const violation = checkSingleAssetSize(
      { assetId: item.id, name: item.name, size: item.size },
      PAGE_CAPACITY_LIMITS
    );
    if (violation) violations.push(violation);
  }
  return violations;
}

/**
 * 媒体身份前置检查：待写媒体的 ID 若已存在且**大小不同**，说明是不同内容复用同一 ID，
 * 直接拒绝，避免覆盖既有笔记本正在引用的图片。大小相同但字节不同的情况由
 * Repository 的写入保护兜底（并发场景同样成立）。
 */
async function findMediaIdentityConflicts(
  repository: NotebookRepository,
  media: NotebookMedia[]
): Promise<string[]> {
  if (media.length === 0) return [];
  const stored = new Map(
    (await repository.loadMediaMetadata()).map((item) => [item.id, item] as const)
  );
  return media
    .filter((item) => {
      const existing = stored.get(item.id);
      return existing !== undefined && existing.size !== item.size;
    })
    .map((item) => item.id);
}

/** 单张原图上限导出，便于调用方在准备媒体前预检。 */
export const APPEND_MAX_MEDIA_BYTES = MAX_MEDIA_BYTES;

export type AppendCapturesDeps = {
  repository: NotebookRepository;
  /** 事务前已完成的笔记本自有媒体（已落库或随本次一起落库）。 */
  preparedMedia?: NotebookMedia[];
  now?: () => Date;
};

/**
 * 两库可恢复顺序：**先保存原始记录，再加入笔记**。
 * 加入失败返回 `record-saved-not-appended` 语义的结果与可重试的 operationId，
 * 调用方不得重新创建原记录。
 */
export async function appendCaptures(
  request: AppendCapturesRequest,
  deps: AppendCapturesDeps
): Promise<AppendCapturesResult> {
  const now = deps.now ?? (() => new Date());
  const repository = deps.repository;
  const archive = await repository.loadArchive();

  const planned = planAppendCaptures(archive, request, now);
  if (planned.status === "rejected") return planned;
  if (planned.status === "needs-confirmation") return planned;
  if (planned.status === "replayed") return planned.result;
  if (planned.status === "skipped-all-duplicates") {
    return {
      status: "skipped-all-duplicates",
      pageId: request.pageId,
      revision: archive.revision,
      skippedMessageIds: planned.skippedMessageIds
    };
  }

  const plan = planned.plan;
  const preparedById = new Map((deps.preparedMedia ?? []).map((item) => [item.id, item] as const));
  const missing = plan.media.filter((item) => !preparedById.has(item.id));
  if (missing.length > 0) {
    return {
      status: "rejected",
      code: "MEDIA_NOT_PREPARED",
      detail: `有 ${missing.length} 张图片尚未准备为笔记资产，未追加（不会留下缺媒体的正文）。`
    };
  }
  const preparedMedia = plan.media.map((item) => {
    const prepared = preparedById.get(item.id)!;
    return prepared;
  });

  const conflicts = await findMediaIdentityConflicts(repository, preparedMedia);
  if (conflicts.length > 0) {
    return {
      status: "rejected",
      code: "MEDIA_ID_CONFLICT",
      detail: `有 ${conflicts.length} 个笔记资产 ID 已存在且内容不同，拒绝覆盖：${conflicts[0]}。`
    };
  }

  const assetSizes: Record<string, number> = {};
  for (const meta of await repository.loadMediaMetadata()) assetSizes[meta.id] = meta.size;
  for (const item of preparedMedia) assetSizes[item.id] = item.size;

  try {
    /*
     * 预检与提交同处一个异常边界（P3-01）：容量治理在 applyAppendPlan 内执行，
     * 台账预算触顶时这里同样收到 OperationLogBudgetExceededError 并转为明确拒绝。
     */
    const violations = checkAppendCapacity(archive, plan, assetSizes);
    if (violations.length > 0) {
      return {
        status: "rejected",
        code: "CAPACITY_EXCEEDED",
        detail: formatCapacityViolation(violations[0])
      };
    }

    const committed = await repository.commitJournalChange(
      (current) => {
        // 事务内以最新档案重新跑一遍纯计划：并发提交后仍保持“同 ID 同输入只生效一次”。
        const replanned = planAppendCaptures(current, request, now);
        return replanned.status === "planned" ? applyAppendPlan(current, replanned.plan) : current;
      },
      {
        expectedRevision: request.expectedRevision,
        media: preparedMedia
      }
    );

    const receipt = findAppendOperation(committed.archive, request.operationId);
    if (!receipt) {
      // 事务内已被同一操作的并发提交处理：这次没有新增内容，按已生效结果返回。
      return {
        status: "conflict",
        expectedRevision: request.expectedRevision,
        actualRevision: committed.revision
      };
    }
    // 并发的永久删除落在本次提交之后：终态不是“已应用”。
    if (receipt.status === "purged") {
      return {
        status: "rejected",
        code: "TARGET_PURGED",
        detail: `操作 ${request.operationId} 的目标篇已被永久删除，本次未追加任何内容。`
      };
    }
    return {
      status: "applied",
      pageId: receipt.pageId,
      revision: committed.revision,
      appliedMessageIds: receipt.messageIds,
      appendedBlockIds: receipt.appendedBlockIds,
      appendedMediaIds: receipt.appendedMediaIds,
      replayed: false
    };
  } catch (error) {
    if (error instanceof RevisionConflictError) {
      return {
        status: "conflict",
        expectedRevision: error.expectedRevision,
        actualRevision: error.actualRevision
      };
    }
    if (error instanceof MediaContentConflictError) {
      return {
        status: "rejected",
        code: "MEDIA_ID_CONFLICT",
        detail: `笔记资产 ${error.mediaId} 已存在且内容不同，拒绝覆盖既有图片。`
      };
    }
    if (error instanceof MediaContentConflictError) {
      return {
        status: "rejected",
        code: "MEDIA_ID_CONFLICT",
        detail: `笔记资产 ${error.mediaId} 已存在且内容不同，拒绝覆盖既有图片。`
      };
    }
    if (error instanceof OperationLogBudgetExceededError) {
      return { status: "rejected", code: "OPERATION_LOG_FULL", detail: OPERATION_LOG_FULL_DETAIL };
    }
    throw error;
  }
}

export { createNotebookId };
export type { AppendDuplicatePolicy };

/**
 * 014-B：勾选记录后“新建笔记”的编排。
 *
 * 约束：正文、来源关联、操作收据必须在**同一个 notebook 事务**里提交，
 * 不允许先建空篇再用第二次追加补内容；媒体仍在事务外准备并先落库，
 * 失败最多留下未引用媒体。创建成功后的响应重试靠 operationId 收据识别，
 * 不得再次建篇。
 */

export type CreatePageFromCapturesRequest = {
  notebookId: string;
  operationId: string;
  expectedRevision: NotebookRevision;
  title: string;
  capturedAt?: string;
  duplicatePolicy: AppendDuplicatePolicy;
  sources: AppendSourceSnapshot[];
  /** 用户确认的正文草稿；缺省时按来源文本原样生成（等价草稿）。 */
  draft?: JournalDraft;
};

export type CreatePageFromCapturesResult =
  | {
      status: "created";
      pageId: string;
      notebookId: string;
      revision: NotebookRevision;
      appliedMessageIds: string[];
      appendedBlockIds: string[];
      appendedMediaIds: string[];
      /** 同 operationId + 同输入的重试：返回原结果，不重复建篇。 */
      replayed: boolean;
    }
  | { status: "needs-confirmation"; duplicateMessageIds: string[]; reason: string }
  | { status: "conflict"; expectedRevision: NotebookRevision; actualRevision: NotebookRevision }
  | { status: "rejected"; code: AppendRejectCode; detail: string };

export function createRequestDigest(request: CreatePageFromCapturesRequest): string {
  return fingerprintParts([
    canonicalJson({
      notebookId: request.notebookId,
      title: request.title,
      capturedAt: request.capturedAt ?? null,
      duplicatePolicy: request.duplicatePolicy,
      draft: request.draft ?? null,
      sources: request.sources.map((source) => ({
        messageId: source.messageId,
        text: source.text,
        capturedAt: source.capturedAt,
        messageFound: source.messageFound !== false,
        media: source.media.map((item) => ({
          assetId: item.assetId,
          name: item.name,
          type: item.type,
          size: item.size,
          createdAt: item.createdAt,
          sourceMediaId: item.sourceMediaId
        }))
      }))
    })
  ]);
}

type CreateCommit = {
  pageId: string;
  blocks: NotebookPageBlock[];
  sourceLinks: NotebookPageSourceLink[];
  receipt: AppendOperationReceipt;
};

/** “新建即写入”收据在事务内才拿到真实篇 ID：先写占位，由 resultPageId 记录真实值。 */
const PENDING_PAGE_ID = "pg-pending";

/**
 * 生成创建计划的纯部分（块、来源关联、收据）；页面 ID 必须在事务内生成，
 * 因此这里先返回一个“用给定 pageId 装配”的函数。
 */
function buildCreateCommit(
  request: CreatePageFromCapturesRequest,
  pageId: string,
  timestamp: string,
  revisionAfter: NotebookRevision
): CreateCommit {
  const blocks: NotebookPageBlock[] = [];
  const sourceLinks: NotebookPageSourceLink[] = [];
  const receipt: AppendOperationReceipt = {
    operationId: request.operationId,
    pageId: PENDING_PAGE_ID,
    notebookId: request.notebookId,
    resultPageId: pageId,
    requestDigest: createRequestDigest(request),
    status: "applied",
    duplicateIntent: request.duplicatePolicy === "append-duplicate",
    appendedBlockIds: [],
    appendedMediaIds: [],
    messageIds: request.sources.map((source) => source.messageId),
    skippedMessageIds: [],
    resultRevision: revisionAfter,
    createdAt: timestamp
  };

  // 正文块完全由确认后的草稿决定（含用户编辑），图片仍用来源资产身份。
  const draft = request.draft
    ? resolveDraftAssetIds(request.draft, planLink(request.sources))
    : draftFromSnapshots(request.sources);
  const draftBlocks = blocksFromJournalDraft(draft).map((block, index) => ({
    ...block,
    id: `blk-${request.operationId}-${index}`
  }));
  blocks.push(...draftBlocks);

  request.sources.forEach((source) => {
    const photoAssetIds = source.media.map((item) => item.assetId);
    const mediaAssetIds = photoAssetIds;
    receipt.appendedMediaIds.push(...mediaAssetIds);
    // 来源关联登记该记录在草稿中对应的文本块与图片块（由草稿决定，不从正文猜测）。
    const entryIndex = draft.entries.findIndex(
      (entry) => entry.kind === "message" && entry.messageId === source.messageId
    );
    const textBlockIds =
      entryIndex >= 0
        ? draftBlocks
            .slice(entryIndex, nextDraftEntryStart(draft, entryIndex))
            .filter((block) => block.type === "text")
            .map((block) => block.id)
        : [];
    const photoBlockIds = draftBlocks
      .filter((block) => block.type === "photo" && photoAssetIds.includes(block.mediaId))
      .map((block) => block.id);
    sourceLinks.push({
      pageId,
      messageId: source.messageId,
      snapshotDigest: sourceSnapshotDigest(source),
      blockIds: [...textBlockIds, ...photoBlockIds],
      mediaAssetIds,
      appendedAt: timestamp,
      operationId: request.operationId
    });
  });

  receipt.appendedBlockIds = blocks.map((block) => block.id);
  return { pageId, blocks, sourceLinks, receipt };
}

/** 新建笔记并写入正文、来源关联与收据（同一事务）。 */
export async function createPageFromCaptures(
  request: CreatePageFromCapturesRequest,
  deps: AppendCapturesDeps
): Promise<CreatePageFromCapturesResult> {
  const now = deps.now ?? (() => new Date());
  const repository = deps.repository;
  const archive = await repository.loadArchive();

  const invalid = validateSources(request);
  if (invalid) return invalid;
  if (!request.notebookId) {
    return { status: "rejected", code: "INVALID_REQUEST", detail: "缺少目标笔记本 ID。" };
  }
  if (!Number.isInteger(request.expectedRevision) || request.expectedRevision < 0) {
    return {
      status: "rejected",
      code: "INVALID_REQUEST",
      detail: "expectedRevision 必须是大于等于 0 的整数。"
    };
  }

  const digest = createRequestDigest(request);
  const existing = findAppendOperation(archive, request.operationId);
  if (existing) {
    if (existing.requestDigest !== digest) {
      return {
        status: "rejected",
        code: "OPERATION_ID_REUSED_WITH_DIFFERENT_INPUT",
        detail: `操作 ${request.operationId} 已用不同输入提交过，拒绝复用该操作 ID。`
      };
    }
    // 目标篇已被永久删除：不得重新建篇，也不得谎报 created。
    if (existing.status === "purged") {
      return {
        status: "rejected",
        code: "TARGET_PURGED",
        detail: `操作 ${request.operationId} 目标的笔记已被永久删除，本次未新建笔记。`
      };
    }
    // 重试：返回原篇，不再次建篇。
    return {
      status: "created",
      pageId: existing.resultPageId ?? existing.pageId,
      notebookId: existing.notebookId ?? request.notebookId,
      revision: existing.resultRevision,
      appliedMessageIds: existing.messageIds,
      appendedBlockIds: existing.appendedBlockIds,
      appendedMediaIds: existing.appendedMediaIds,
      replayed: true
    };
  }

  const notebook = archive.notebooks.find((item) => item.id === request.notebookId);
  if (!notebook || notebook.deletedAt) {
    return {
      status: "rejected",
      code: "PAGE_NOT_FOUND",
      detail: "目标笔记本不存在或已删除，未新建笔记。"
    };
  }

  // 新建篇内不存在“已加入”的来源；重复只可能来自本次输入自身。
  const seen = new Set<string>();
  const duplicateMessageIds: string[] = [];
  for (const source of request.sources) {
    if (seen.has(source.messageId)) duplicateMessageIds.push(source.messageId);
    seen.add(source.messageId);
  }
  if (duplicateMessageIds.length > 0 && request.duplicatePolicy === "needs-confirmation") {
    return {
      status: "needs-confirmation",
      duplicateMessageIds,
      reason: `本次选择里有 ${duplicateMessageIds.length} 条重复记录，默认先不写入。`
    };
  }

  const timestamp = now().toISOString();
  // 容量预检：与提交时同一函数族（最终引用集），超限整次拒绝。
  const previewBlocks = buildCreateCommit(
    request,
    PENDING_PAGE_ID,
    timestamp,
    archive.revision + 1
  );
  const previewPage: NotebookPage = {
    schemaVersion: NOTEBOOK_ARCHIVE_VERSION,
    id: PENDING_PAGE_ID,
    notebookId: request.notebookId,
    title: request.title.trim().slice(0, MAX_PAGE_TITLE_LENGTH),
    blocks: previewBlocks.blocks,
    source: { kind: "manual" },
    capturedAt: request.capturedAt ?? timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const assetSizes: Record<string, number> = {};
  for (const meta of await repository.loadMediaMetadata()) assetSizes[meta.id] = meta.size;
  // 本次媒体按 assetId 去重后覆盖大小：同一资产多处引用只计一次字节。
  for (const item of request.sources.flatMap((source) => source.media)) {
    assetSizes[item.assetId] = item.size;
  }
  const measurement = measurePageCapacity({
    page: previewPage,
    assetSizes,
    limits: PAGE_CAPACITY_LIMITS
  });
  if (measurement.violations.length > 0) {
    return {
      status: "rejected",
      code: "CAPACITY_EXCEEDED",
      detail: formatCapacityViolation(measurement.violations[0])
    };
  }

  const planMedia = request.sources.flatMap((source) => source.media.map((item) => item.assetId));
  const preparedById = new Map((deps.preparedMedia ?? []).map((item) => [item.id, item] as const));
  const missing = planMedia.filter((assetId) => !preparedById.has(assetId));
  if (missing.length > 0) {
    return {
      status: "rejected",
      code: "MEDIA_NOT_PREPARED",
      detail: `有 ${missing.length} 张图片尚未准备为笔记资产，未新建笔记。`
    };
  }
  const preparedMedia = planMedia.map((assetId) => preparedById.get(assetId)!);

  const conflicts = await findMediaIdentityConflicts(repository, preparedMedia);
  if (conflicts.length > 0) {
    return {
      status: "rejected",
      code: "MEDIA_ID_CONFLICT",
      detail: `有 ${conflicts.length} 个笔记资产 ID 已存在且内容不同，拒绝覆盖：${conflicts[0]}。`
    };
  }

  try {
    const committed = await repository.commitJournalChange(
      (current) => {
        // 幂等：事务内再次确认该操作未被并发提交（重放先于容量治理）。
        if (findAppendOperation(current, request.operationId)) return current;
        const pageId = createNotebookId("pg");
        const commit = buildCreateCommit(request, pageId, timestamp, current.revision + 1);
        const page: NotebookPage = {
          schemaVersion: NOTEBOOK_ARCHIVE_VERSION,
          id: pageId,
          notebookId: request.notebookId,
          title: request.title.trim().slice(0, MAX_PAGE_TITLE_LENGTH),
          blocks: commit.blocks,
          source: { kind: "manual" },
          capturedAt: request.capturedAt ?? timestamp,
          createdAt: timestamp,
          updatedAt: timestamp
        };
        const withPage: ArchiveCore = {
          ...current,
          pages: [...current.pages, page],
          tripJournals: [
            ...(current.tripJournals ?? []),
            {
              pageId,
              meta: { tripDate: null, regions: [], updatedAt: timestamp }
            }
          ]
        };
        const withLinks = addPageSourceLinks(withPage, commit.sourceLinks);
        // P3-01：候选数组 = 已有收据 + 本次新收据，与追加入口同一治理规则；
        // 压缩与建篇在同一事务内成功或回滚。
        const governed = governAppendOperationLog(
          [...(withLinks.appendOperations ?? []), commit.receipt],
          commit.receipt
        );
        if (!governed) throw new OperationLogBudgetExceededError();
        return { ...withLinks, appendOperations: governed };
      },
      { expectedRevision: request.expectedRevision, media: preparedMedia }
    );

    const receipt = findAppendOperation(committed.archive, request.operationId);
    // 并发的永久删除落在本次提交之后：不能谎报 created。
    if (receipt?.status === "purged") {
      return {
        status: "rejected",
        code: "TARGET_PURGED",
        detail: `操作 ${request.operationId} 目标的笔记已被永久删除，本次未新建笔记。`
      };
    }
    const pageId = receipt?.resultPageId ?? receipt?.pageId;
    if (!receipt || !pageId) {
      return {
        status: "conflict",
        expectedRevision: request.expectedRevision,
        actualRevision: committed.revision
      };
    }
    return {
      status: "created",
      pageId,
      notebookId: receipt.notebookId ?? request.notebookId,
      revision: committed.revision,
      appliedMessageIds: receipt.messageIds,
      appendedBlockIds: receipt.appendedBlockIds,
      appendedMediaIds: receipt.appendedMediaIds,
      replayed: false
    };
  } catch (error) {
    if (error instanceof RevisionConflictError) {
      return {
        status: "conflict",
        expectedRevision: error.expectedRevision,
        actualRevision: error.actualRevision
      };
    }
    if (error instanceof MediaContentConflictError) {
      return {
        status: "rejected",
        code: "MEDIA_ID_CONFLICT",
        detail: `笔记资产 ${error.mediaId} 已存在且内容不同，拒绝覆盖既有图片。`
      };
    }
    if (error instanceof MediaContentConflictError) {
      return {
        status: "rejected",
        code: "MEDIA_ID_CONFLICT",
        detail: `笔记资产 ${error.mediaId} 已存在且内容不同，拒绝覆盖既有图片。`
      };
    }
    if (error instanceof OperationLogBudgetExceededError) {
      return { status: "rejected", code: "OPERATION_LOG_FULL", detail: OPERATION_LOG_FULL_DETAIL };
    }
    throw error;
  }
}
