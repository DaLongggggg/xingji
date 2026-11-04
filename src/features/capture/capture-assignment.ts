import {
  appendCaptures,
  appendRequestDigest,
  createPageFromCaptures,
  type JournalDraft,
  type AppendCapturesRequest,
  type AppendCapturesResult,
  type AppendSourceSnapshot,
  type CreatePageFromCapturesResult
} from "@/features/notebook/append-service";
import type {
  AppendDuplicatePolicy,
  NotebookMedia,
  NotebookPage
} from "@/features/notebook/notebook-model";
import { digestMediaContent } from "@/features/notebook/notebook-repository";
import type { ArchiveCore, NotebookRepository } from "@/features/notebook/notebook-repository";
import type { CaptureMedia, CaptureMessage } from "./capture-model";

/**
 * 014-B 记录归属协调服务。
 *
 * 顺序固定为「先保存原始记录，再追加到笔记本」：两个库不能跨库原子，
 * 所以只承诺可恢复顺序，不假装整体原子。追加失败时保留已保存的记录与可重试身份，
 * 调用方不得重新保存同一条原始记录。UI 不直接拼接 blocks，一律经 append/create 服务。
 */

export type CaptureTarget = { kind: "inbox" } | { kind: "page"; pageId: string };

export type CaptureAssignmentStatus =
  | "saved-to-inbox"
  | "applied"
  | "record-saved-not-appended"
  | "needs-confirmation"
  | "conflict"
  | "rejected";

export type AppendRejectReason =
  | "target-missing"
  | "target-not-editable"
  | "source-message-missing"
  | "capacity-exceeded"
  | "media-not-prepared"
  /** 同 ID 但内容不同的资产冲突：拒绝覆盖既有笔记图片。 */
  | "media-id-conflict"
  | "operation-id-conflict"
  | "invalid-request"
  | "notebook-missing";

export type CaptureAssignmentOutcome = {
  status: CaptureAssignmentStatus;
  /** 已保存的原始记录 ID（永远先保存；即便追加失败也已存在）。 */
  messageId: string;
  /** 本次实际追加/创建的块；未追加时为空数组。 */
  blockIds: string[];
  mediaIds: string[];
  duplicateMessageIds?: string[];
  /** 重试目标：携带它即可复用同一 operationId 与同一来源快照。 */
  retry?: CaptureRetryContext;
  reason?: AppendRejectReason;
  detail?: string;
};

export type CaptureRetryContext = {
  notebookId: string;
  pageId?: string;
  title: string;
  operationId: string;
  messageIds: string[];
  /** 首次提交时冻结的媒体身份映射与草稿：重试必须复用，否则会变成不同输入。 */
  mediaLink?: { sourceMediaId: string; assetId: string; messageId: string }[];
  draft?: JournalDraft;
};

export type CaptureAssignmentResult = CaptureAssignmentOutcome;

/** 准备阶段：把记录箱自有媒体复制成笔记本自有资产（事务外完成，失败只留未引用媒体）。 */
export type PreparedCaptureMedia = {
  /** 来源记录媒体 ID → 笔记资产（同一提交内稳定映射）。 */
  link: { sourceMediaId: string; assetId: string; messageId: string }[];
  media: NotebookMedia[];
};

/**
 * 笔记资产 ID 必须**由来源身份确定派生**：同一记录 + 同一来源媒体永远得到同一
 * 资产 ID。这样同一操作重试时请求摘要与媒体身份保持一致，才会被识别为幂等重放，
 * 而不是被判成“同 operationId 不同输入”。ID 仍由笔记本侧命名空间持有，
 * 只是不再随机生成。
 */
export function deriveNotebookAssetId(
  messageId: string,
  sourceMediaId: string,
  contentDigest: string
): string {
  // 身份 = 来源元组 + 内容摘要：来源身份无歧义，且同来源内容变化会得到**新资产**，
  // 不会复用旧 ID 覆盖既有笔记本正在使用的图片。既有资产 ID 保持兼容，不批量重命名。
  return `jmedia-${encodeSourceIdentity(messageId, sourceMediaId)}-${contentDigest}`;
}

/**
 * 来源身份编码：对元组做**无歧义**编码，避免“替换非法字符 + 横杠拼接”造成的碰撞
 * （例如 `a-b` + `c` 与 `a` + `b-c` 会得到同一个 ID）。
 *
 * 编码规则：`UTF-8 字节的 base64url`，各段之间用 `_` 分隔，并前置段长度。
 * base64url 字母表不含 `_`，因此分隔符不会出现在段内，解码唯一。
 */
export function encodeSourceIdentity(messageId: string, sourceMediaId: string): string {
  const encode = (value: string): string => {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const parts = [messageId, sourceMediaId].map(encode);
  return `${parts[0].length}_${parts[0]}_${parts[1]}`;
}

/**
 * 记录箱媒体 → 笔记本自有资产。ID 由笔记本侧按来源身份确定派生，来源删除不影响已复制内容；
 * 媒体二进制直接引用来源 Blob，不复制字节。
 *
 * 找不到来源二进制时明确失败，不静默少带图片（避免文字已加入、图片却悄悄丢失）。
 */
export async function prepareCaptureMedia(
  messages: CaptureMessage[],
  captureMedia: CaptureMedia[],
  /** 重试时传入首次冻结的映射，保证同一操作身份稳定。 */
  frozenLink?: PreparedCaptureMedia["link"]
): Promise<PreparedCaptureMedia> {
  const byId = new Map(captureMedia.map((item) => [item.id, item] as const));
  const missing = messages
    .flatMap((message) => message.mediaIds.map((mediaId) => ({ message, mediaId })))
    .filter((item) => !byId.has(item.mediaId));
  if (missing.length > 0) {
    throw new Error(
      `SOURCE_MEDIA_MISSING:记录 ${missing[0].message.id} 的图片 ${missing[0].mediaId} 读不到，未加入笔记。`
    );
  }
  const frozen = new Map(
    (frozenLink ?? []).map(
      (item) => [`${item.messageId}\u0001${item.sourceMediaId}`, item.assetId] as const
    )
  );
  const link: PreparedCaptureMedia["link"] = [];
  const media: NotebookMedia[] = [];
  for (const message of messages) {
    for (const sourceMediaId of message.mediaIds) {
      const source = byId.get(sourceMediaId)!;
      const assetId =
        frozen.get(`${message.id}\u0001${sourceMediaId}`) ??
        deriveNotebookAssetId(message.id, sourceMediaId, await digestMediaContent(source.blob));
      link.push({ sourceMediaId, assetId, messageId: message.id });
      media.push({
        id: assetId,
        name: source.name,
        type: source.type,
        size: source.size,
        createdAt: source.createdAt,
        blob: source.blob,
        origin: { kind: "capture-message", messageId: message.id, sourceMediaId }
      });
    }
  }
  return { link, media };
}

function mediaForMessage(
  prepared: PreparedCaptureMedia,
  message: CaptureMessage
): AppendSourceSnapshot["media"] {
  return prepared.link
    .filter((item) => item.messageId === message.id)
    .map((item) => {
      const asset = prepared.media.find((media) => media.id === item.assetId)!;
      return {
        assetId: item.assetId,
        name: asset.name,
        type: asset.type,
        size: asset.size,
        createdAt: asset.createdAt,
        sourceMediaId: item.sourceMediaId
      };
    });
}

/**
 * 冻结来源快照：文本、时间、媒体身份与资产 ID 全部在此刻确定。
 * 重试必须复用同一份快照，否则 operationId 会因输入变化而被拒绝。
 */
export function buildSourceSnapshots(
  messages: CaptureMessage[],
  prepared: PreparedCaptureMedia
): AppendSourceSnapshot[] {
  return messages.map((message) => ({
    messageId: message.id,
    text: message.text,
    capturedAt: message.capturedAt,
    messageFound: true,
    media: mediaForMessage(prepared, message)
  }));
}

/** 请求摘要：与 append 服务共用同一算法，供页面刷新后的重建校验。 */
export function capturePageRequestDigest(
  pageId: string,
  policy: AppendDuplicatePolicy,
  sources: AppendSourceSnapshot[]
): string {
  const request: AppendCapturesRequest = {
    pageId,
    operationId: "digest",
    expectedRevision: 0,
    duplicatePolicy: policy,
    sources
  };
  return appendRequestDigest(request);
}

export type CaptureAssignmentDeps = {
  captureRepository: {
    loadArchive(): Promise<{ messages: CaptureMessage[] }>;
    saveArchive(archive: unknown): Promise<void>;
  };
  notebookRepository: NotebookRepository;
  notebookArchive: ArchiveCore;
  captureMedia: CaptureMedia[];
  now?: () => Date;
};

function outcomeFromAppend(
  result: AppendCapturesResult,
  messageIds: string[],
  retry: CaptureRetryContext
): CaptureAssignmentOutcome {
  const messageId = messageIds[messageIds.length - 1] ?? "";
  switch (result.status) {
    case "applied":
      return {
        status: "applied",
        messageId,
        blockIds: result.appendedBlockIds,
        mediaIds: result.appendedMediaIds
      };
    case "skipped-all-duplicates":
      return {
        status: "applied",
        messageId,
        blockIds: [],
        mediaIds: [],
        detail: "所选记录此前已加入该篇，本次未重复写入。"
      };
    case "needs-confirmation":
      return {
        status: "needs-confirmation",
        messageId,
        blockIds: [],
        mediaIds: [],
        duplicateMessageIds: result.duplicateMessageIds,
        retry
      };
    case "conflict":
      return {
        status: "conflict",
        messageId,
        blockIds: [],
        mediaIds: [],
        retry,
        detail: `目标篇已被其他操作更新（revision ${result.actualRevision}），本次未写入。`
      };
    case "rejected":
      return {
        status: "record-saved-not-appended",
        messageId,
        blockIds: [],
        mediaIds: [],
        retry,
        reason: mapRejectCode(result.code),
        detail: result.detail
      };
  }
}

function mapRejectCode(code: string): AppendRejectReason {
  if (code === "PAGE_NOT_FOUND") return "target-missing";
  if (code === "SOURCE_MESSAGE_MISSING") return "source-message-missing";
  if (code === "CAPACITY_EXCEEDED") return "capacity-exceeded";
  // P3-01：收据台账字节预算触顶，与页面容量同属容量类失败（原记录保留、可重试）。
  if (code === "OPERATION_LOG_FULL") return "capacity-exceeded";
  if (code === "MEDIA_NOT_PREPARED") return "media-not-prepared";
  if (code === "MEDIA_ID_CONFLICT") return "media-id-conflict";
  if (code === "OPERATION_ID_REUSED_WITH_DIFFERENT_INPUT") return "operation-id-conflict";
  return "invalid-request";
}

/** 目标篇是否可作为追加目标：必须存在、未删除所属本、且不是 legacy 关联页。 */
export function describeTargetProblem(
  archive: ArchiveCore,
  pageId: string
): { reason: AppendRejectReason; detail: string } | undefined {
  const page = archive.pages.find((item) => item.id === pageId);
  if (!page) {
    return { reason: "target-missing", detail: "目标笔记不存在（可能已被删除）。" };
  }
  const notebook = archive.notebooks.find((item) => item.id === page.notebookId);
  if (!notebook || notebook.deletedAt) {
    return { reason: "target-missing", detail: "目标篇所在笔记本不存在或已删除。" };
  }
  if (page.source.kind === "legacy-journal") {
    return {
      reason: "target-not-editable",
      detail: "关联查看页不能直接追加；请先在旧游记列表里复制为独立页。"
    };
  }
  return undefined;
}

/**
 * 把已保存的记录追加到指定篇（复用 014-A 追加服务与 revision 契约）。
 * 调用方传入的记录必须**已经保存**；本函数只负责追加，不创建原始记录。
 */
export async function assignCapturesToPage(
  input: {
    pageId: string;
    messageIds: string[];
    duplicatePolicy: AppendDuplicatePolicy;
    operationId: string;
    messages: CaptureMessage[];
    /** 用户确认后的正文草稿（含编辑）；缺省表示按来源原样。 */
    draft?: JournalDraft;
    /** 重试上下文：携带首次冻结的媒体映射与草稿。 */
    retry?: CaptureRetryContext;
  },
  deps: CaptureAssignmentDeps
): Promise<CaptureAssignmentOutcome> {
  const now = deps.now ?? (() => new Date());
  const lastMessageId = input.messageIds[input.messageIds.length - 1] ?? "";
  const page = deps.notebookArchive.pages.find((item) => item.id === input.pageId);
  const retry: CaptureRetryContext = input.retry ?? {
    notebookId: page?.notebookId ?? "",
    pageId: input.pageId,
    title: page?.title ?? "",
    operationId: input.operationId,
    messageIds: input.messageIds
  };
  retry.draft = input.draft ?? retry.draft;

  const problem = describeTargetProblem(deps.notebookArchive, input.pageId);
  if (problem) {
    return {
      status: "record-saved-not-appended",
      messageId: lastMessageId,
      blockIds: [],
      mediaIds: [],
      retry,
      reason: problem.reason,
      detail: problem.detail
    };
  }

  let prepared: PreparedCaptureMedia;
  try {
    prepared = await prepareCaptureMedia(input.messages, deps.captureMedia, retry.mediaLink);
    retry.mediaLink = prepared.link;
  } catch (error) {
    return {
      status: "record-saved-not-appended",
      messageId: lastMessageId,
      blockIds: [],
      mediaIds: [],
      retry,
      reason: "source-message-missing",
      detail:
        error instanceof Error ? error.message.split(":").slice(1).join(":") : "来源媒体缺失。"
    };
  }
  const sources = buildSourceSnapshots(input.messages, prepared);
  const result = await appendCaptures(
    {
      pageId: input.pageId,
      operationId: input.operationId,
      expectedRevision: deps.notebookArchive.revision,
      duplicatePolicy: input.duplicatePolicy,
      sources,
      draft: retry.draft
    },
    { repository: deps.notebookRepository, preparedMedia: prepared.media, now }
  );
  return outcomeFromAppend(result, input.messageIds, retry);
}

/** 勾选记录后“新建笔记”：建篇与正文/来源关联/收据在同一事务内提交。 */
export async function createNotebookPageFromCaptures(
  input: {
    notebookId: string;
    title: string;
    messageIds: string[];
    duplicatePolicy: AppendDuplicatePolicy;
    operationId: string;
    messages: CaptureMessage[];
    /** 用户确认后的正文草稿（含编辑）；缺省表示按来源原样。 */
    draft?: JournalDraft;
    /** 重试上下文：携带首次冻结的媒体映射与草稿。 */
    retry?: CaptureRetryContext;
  },
  deps: CaptureAssignmentDeps
): Promise<CaptureAssignmentOutcome> {
  const now = deps.now ?? (() => new Date());
  const lastMessageId = input.messageIds[input.messageIds.length - 1] ?? "";
  const retry: CaptureRetryContext = input.retry ?? {
    notebookId: input.notebookId,
    title: input.title,
    operationId: input.operationId,
    messageIds: input.messageIds
  };
  retry.draft = input.draft ?? retry.draft;
  const notebook = deps.notebookArchive.notebooks.find((item) => item.id === input.notebookId);
  if (!notebook || notebook.deletedAt) {
    return {
      status: "record-saved-not-appended",
      messageId: lastMessageId,
      blockIds: [],
      mediaIds: [],
      retry,
      reason: "notebook-missing",
      detail: "目标笔记本不存在或已删除，未新建笔记。"
    };
  }

  let prepared: PreparedCaptureMedia;
  try {
    prepared = await prepareCaptureMedia(input.messages, deps.captureMedia, retry.mediaLink);
    retry.mediaLink = prepared.link;
  } catch (error) {
    return {
      status: "record-saved-not-appended",
      messageId: lastMessageId,
      blockIds: [],
      mediaIds: [],
      retry,
      reason: "source-message-missing",
      detail:
        error instanceof Error ? error.message.split(":").slice(1).join(":") : "来源媒体缺失。"
    };
  }
  const sources = buildSourceSnapshots(input.messages, prepared);
  const result: CreatePageFromCapturesResult = await createPageFromCaptures(
    {
      notebookId: input.notebookId,
      operationId: input.operationId,
      expectedRevision: deps.notebookArchive.revision,
      title: input.title,
      duplicatePolicy: input.duplicatePolicy,
      sources,
      draft: retry.draft
    },
    { repository: deps.notebookRepository, preparedMedia: prepared.media, now }
  );

  switch (result.status) {
    case "created":
      return {
        status: "applied",
        messageId: lastMessageId,
        blockIds: result.appendedBlockIds,
        mediaIds: result.appendedMediaIds
      };
    case "needs-confirmation":
      return {
        status: "needs-confirmation",
        messageId: lastMessageId,
        blockIds: [],
        mediaIds: [],
        duplicateMessageIds: result.duplicateMessageIds,
        retry
      };
    case "conflict":
      return {
        status: "conflict",
        messageId: lastMessageId,
        blockIds: [],
        mediaIds: [],
        retry,
        detail: `笔记本档案已被其他操作更新（revision ${result.actualRevision}），未新建笔记。`
      };
    case "rejected":
      return {
        status: "record-saved-not-appended",
        messageId: lastMessageId,
        blockIds: [],
        mediaIds: [],
        retry,
        reason: mapRejectCode(result.code),
        detail: result.detail
      };
  }
}

/** 供页面展示的目标篇摘要（不接触存储实现）。 */
export type NotebookPageSummary = {
  pageId: string;
  notebookId: string;
  notebookTitle: string;
  pageTitle: string;
  /** legacy 关联页不能作为追加目标，界面提示先复制。 */
  editable: boolean;
};

export function listAppendTargets(archive: ArchiveCore): NotebookPageSummary[] {
  const visible = new Map(
    archive.notebooks
      .filter((notebook) => !notebook.archivedAt && !notebook.deletedAt)
      .map((notebook) => [notebook.id, notebook] as const)
  );
  return archive.pages
    .filter((page) => visible.has(page.notebookId))
    .map((page) => {
      const notebook = visible.get(page.notebookId)!;
      return {
        pageId: page.id,
        notebookId: notebook.id,
        notebookTitle: notebook.title,
        pageTitle: page.title,
        editable: page.source.kind !== "legacy-journal"
      };
    });
}

export type { AppendDuplicatePolicy, NotebookPage };
