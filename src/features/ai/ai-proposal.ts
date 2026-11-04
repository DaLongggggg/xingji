/**
 * P1-02：AiProposal、按类型区分的结构化 payload、预览冻结与接受身份。
 *
 * 边界：
 * - `accepted` 只是用户授权，不代表业务已提交；`applied` 只能由真实业务事务结果决定。
 * - 预览会冻结 payloadDigest；接受必须匹配冻结身份，预览后改载荷不能沿用旧接受。
 * - payload 是判别联合；`unknown` 永远不能直接交给写管线。
 * - 首期只启用 organize_page；其他类型保留在文档，不在运行时建立空实现。
 */
import {
  fingerprintParts,
  MAX_PAGE_TEXT_LENGTH,
  MAX_PAGE_TITLE_LENGTH
} from "../notebook/notebook-model";
import {
  canonicalJson,
  type AppendSourceSnapshot,
  type JournalDraft
} from "../notebook/append-service";
import type { CaptureOrganizeTarget, CollectionScope } from "./ai-task";
import { isCollectionScope } from "./ai-task";
import {
  validateNotebookAnalysisResult,
  type NotebookAnalysisIssue,
  type NotebookAnalysisResult
} from "./ai-notebook-result-schema";
import {
  LIGHT_AGENT_RESULT_LIMITS,
  validateLightAgentResult,
  type LightAgentResult
} from "./ai-light-agent-schema";

/**
 * P1 首期只实现 organize_page；P3-02 增加 organize_captures；
 * P4 增加 analyze_notebook（只读本册分析）；P8 增加 organize_collection
 * （只读分组提案，同样没有可应用写入，其余类型保留在文档）。
 */
export type AiProposalType =
  | "organize_page"
  | "organize_captures"
  | "analyze_notebook"
  | "organize_collection";

export type AiProposalStatus =
  | "draft"
  | "accepted"
  /** 提交中：授权已被占用（见 `authorizeCommit`）。撤回在此状态被拒绝。 */
  | "accepting"
  | "rejected"
  | "applied"
  | "conflicted";

/** 输入身份：记录本任务消费了哪个源的哪一版内容。 */
export type AiSourceRef = {
  kind: "page" | "capture_message";
  id: string;
  blockIds?: string[];
  sourceDigest: string;
};

export type PageBaseline = {
  pageId: string;
  updatedAt: string;
  blocksDigest: string;
};

/**
 * organize_page 载荷：只允许已有 text block 的内容替换与可选标题。
 * 不含块增删、顺序调整、图片指令——结构变更需要专门的 Schema 与预览授权。
 */
export type OrganizePagePayload = {
  kind: "organize_page";
  pageId: string;
  title?: string;
  textBlocks: { blockId: string; content: string }[];
  /** 派生信息：候选 metadata，不写入正文。 */
  summary?: string;
};

/**
 * P3-02：organize_captures 载荷——把选中的 Capture 记录整理为**新增/追加**内容。
 *
 * 冻结范围（payloadDigest 覆盖全部字段）：用户指定目标、全部选中来源快照、
 * 媒体身份映射、实际纳入草稿的来源、投影后的既有 JournalDraft、实际外发清单。
 * 明确区分"全部冻结来源"（sources）与"实际纳入草稿的来源"（includedMessageIds），
 * 后续写入与归档只能使用后者。
 */
export type OrganizeCapturesPayload = {
  kind: "organize_captures";
  /** Explicit duplicate confirmation is frozen in a new preview, never applied to an old authorization. */
  duplicatePolicy?: "append-duplicate";
  /** 用户选定的写入目标；模型不能选择或改写。 */
  target: CaptureOrganizeTarget;
  /** 冻结的全部选中来源快照（生成前由调用方冻结，顺序即输入顺序）。 */
  sources: AppendSourceSnapshot[];
  /** 冻结的来源媒体身份映射（messageId+sourceMediaId → 手帐 assetId；确定性派生）。 */
  mediaLink: { messageId: string; sourceMediaId: string; assetId: string }[];
  /** 实际纳入草稿的来源 ID（模型输出覆盖的来源；跳过的来源连图片一并跳过）。 */
  includedMessageIds: string[];
  /** 投影后的既有 JournalDraft（复用追加服务契约，只含纳入来源）。 */
  draft: JournalDraft;
  /** 实际外发清单：发给模型的最终输入文本（含索引与"含图"标记；图片内容不外发）。 */
  outgoingInput: string;
  /**
   * organize_page 专有字段：capture 载荷必须缺失——使载荷联合可安全查询
   * （`payload.pageId === page.id` 对 capture 载荷恒为 false，既有 P2 代码无需修改）。
   */
  pageId?: undefined;
};

/** 按 kind 判别的联合；新增类型时在这里扩展，并补运行时校验。 */
export type ProposalPayload =
  | OrganizePagePayload
  | OrganizeCapturesPayload
  | AnalyzeNotebookPayload
  | OrganizeCollectionPayload;

/**
 * P4：本册只读分析载荷。
 *
 * 只表达“看到了什么、建议什么”，**没有任何可应用写入**：因此它不会进入
 * accepted/accepting/applied，Safe Commit 也不认识它。引用完整性在运行时按
 * `sourceRefs` 冻结范围校验（见 `validateProposalPayload`）。
 */
export type AnalyzeNotebookPayload = {
  kind: "analyze_notebook";
  notebookId: string;
  result: NotebookAnalysisResult;
  /** organize_page 专有字段：本载荷必须缺失（沿用 capture 的判别式做法）。 */
  pageId?: undefined;
};

/**
 * P8：整理检索结果的**只读分组载荷**。
 *
 * 只表达“把哪些篇归到哪个主题、哪些没归组”，没有任何正文替换或结构改写指令：
 * 因此它不会进入 accepted/accepting/applied，Safe Commit 也不认识它。
 * 引用完整性在运行时按 `sourceRefs`（本次**实际读取**的篇）冻结范围校验。
 */
export type OrganizeCollectionPayload = {
  kind: "organize_collection";
  /** 用户整理目标（生成前冻结，作为提案的一部分可回看）。 */
  goal: string;
  /** 生成时冻结的权限范围（恢复/展示时说明这份结果基于什么范围）。 */
  scope: CollectionScope;
  result: LightAgentResult;
  /** organize_page 专有字段：本载荷必须缺失（沿用 capture 的判别式做法）。 */
  pageId?: undefined;
};

export type AiProposal = {
  id: string;
  taskId: string;
  type: AiProposalType;
  status: AiProposalStatus;
  /** 乐观并发版本；每次成功持久化 +1。 */
  revision: number;
  sourceRefs: AiSourceRef[];
  baselines: PageBaseline[];
  payload: ProposalPayload;
  /** 预览冻结的载荷身份。draft 时尚未冻结。 */
  payloadDigest?: string;
  previewedAt?: string;
  appliedAt?: string;
  appliedRevision?: number;
  conflictDetail?: string;
  createdAt: string;
  updatedAt: string;
};

export type ProposalValidationIssue = {
  code:
    | "PAYLOAD_INVALID"
    | "PAGE_MISMATCH"
    | "TITLE_TOO_LONG"
    | "BLOCK_UNKNOWN"
    | "BLOCK_DUPLICATE"
    | "BLOCK_NOT_TEXT"
    | "CONTENT_TOO_LONG"
    | "SUMMARY_TOO_LONG"
    | "TARGET_INVALID"
    | "SOURCE_INVALID"
    | "MEDIA_LINK_INVALID"
    | "INCLUDED_INVALID"
    | "DRAFT_INVALID"
    | "OUTGOING_INVALID";
  detail: string;
};

export class ProposalPayloadError extends Error {
  readonly issues: ProposalValidationIssue[];
  constructor(issues: ProposalValidationIssue[]) {
    super(`AI_PROPOSAL_PAYLOAD_INVALID:${issues.map((issue) => issue.code).join(",")}`);
    this.name = "ProposalPayloadError";
    this.issues = issues;
  }
}

/**
 * 载荷规范化编码：只取载荷自身的字段并按固定顺序拼接。
 * 用于预览冻结与“同 operationId 不同载荷”判定；不是加密哈希。
 * organize_captures 分支用 canonicalJson（键排序）序列化结构字段——
 * 等价对象的属性插入顺序不影响摘要。
 */
export function canonicalPayloadString(payload: ProposalPayload): string {
  if (payload.kind === "organize_captures") {
    return JSON.stringify([
      payload.kind,
      canonicalJson(payload.target),
      canonicalJson(payload.sources),
      canonicalJson(payload.mediaLink),
      canonicalJson(payload.includedMessageIds),
      canonicalJson(payload.draft),
      payload.outgoingInput,
      ...(payload.duplicatePolicy ? [payload.duplicatePolicy] : [])
    ]);
  }
  if (payload.kind === "analyze_notebook") {
    // 只读结果：按规范 JSON（键排序）编码，保证同一结果得到同一身份。
    return JSON.stringify([payload.kind, payload.notebookId, canonicalJson(payload.result)]);
  }
  if (payload.kind === "organize_collection") {
    // 只读分组：范围与目标一起进身份，换范围或换目标都是一份新提案。
    return JSON.stringify([
      payload.kind,
      canonicalJson(payload.scope),
      payload.goal,
      canonicalJson(payload.result)
    ]);
  }
  return JSON.stringify([
    payload.kind,
    payload.pageId,
    payload.title ?? "\u0000",
    payload.summary ?? "\u0000",
    ...payload.textBlocks.map((block) => [block.blockId, block.content])
  ]);
}

export function payloadDigest(payload: ProposalPayload): string {
  const canonical = canonicalPayloadString(payload);
  return `apd1:${canonical.length}:${fingerprintParts([canonical])}`;
}

/** 载荷校验入口：按 kind 分发到对应校验器（未知 kind 一律拒绝）。 */
export function validateProposalPayload(
  payload: unknown,
  /**
   * 建议自身的冻结来源引用。真实边界（预览冻结、存储读取）必须传入：
   * analyze_notebook 的引用白名单来自这里，不传就只做结构校验。
   */
  sourceRefs?: readonly AiSourceRef[]
): ProposalValidationIssue[] {
  if (!payload || typeof payload !== "object") {
    return [{ code: "PAYLOAD_INVALID", detail: "载荷不是对象。" }];
  }
  const kind = (payload as { kind?: unknown }).kind;
  if (kind === "organize_captures") return validateOrganizeCapturesPayload(payload);
  if (kind === "analyze_notebook") return validateAnalyzeNotebookPayload(payload, sourceRefs);
  if (kind === "organize_collection") return validateOrganizeCollectionPayload(payload, sourceRefs);
  return validateOrganizePayload(payload);
}

/**
 * P8 只读分组载荷：结构 + 上限 + 引用必须**恰好属于**`sourceRefs`（实际读取集合）的冻结范围。
 * 覆盖一致性（不编造、不重复、不遗漏）由 `validateLightAgentResult` 复核。
 */
export function validateOrganizeCollectionPayload(
  payload: unknown,
  sourceRefs?: readonly AiSourceRef[]
): ProposalValidationIssue[] {
  if (!payload || typeof payload !== "object") {
    return [{ code: "PAYLOAD_INVALID", detail: "载荷不是对象。" }];
  }
  const candidate = payload as Partial<OrganizeCollectionPayload> & Record<string, unknown>;
  const issues: ProposalValidationIssue[] = [];
  const extra = Object.keys(candidate).filter(
    (key) => !["kind", "goal", "scope", "result"].includes(key)
  );
  if (extra.length > 0) {
    issues.push({ code: "PAYLOAD_INVALID", detail: `不接受的字段：${extra.join(",")}` });
  }
  if (candidate.kind !== "organize_collection") {
    return [{ code: "PAYLOAD_INVALID", detail: `未知载荷类型：${String(candidate.kind)}。` }];
  }
  if (typeof candidate.goal !== "string" || candidate.goal.trim().length === 0) {
    issues.push({ code: "PAYLOAD_INVALID", detail: "缺少整理目标。" });
  } else if (candidate.goal.length > LIGHT_AGENT_RESULT_LIMITS.titleChars + 200) {
    issues.push({ code: "PAYLOAD_INVALID", detail: "整理目标过长。" });
  }
  if (!isCollectionScope(candidate.scope)) {
    issues.push({ code: "PAYLOAD_INVALID", detail: "范围不合法。" });
  }
  const refs = sourceRefs ?? [];
  const allowedPageIds = new Set(refs.filter((ref) => ref.kind === "page").map((ref) => ref.id));
  const resultIssues = validateLightAgentResult(
    candidate.result,
    // 读取边界必须提供 sourceRefs 才能核对引用与覆盖；未提供时只做结构校验。
    sourceRefs === undefined ? {} : { allowedPageIds }
  );
  for (const issue of resultIssues) {
    issues.push({ code: "PAYLOAD_INVALID", detail: `${issue.code}:${issue.detail}` });
  }
  return issues;
}

/** 只读分析载荷：结构 + 上限 + 引用必须属于 `sourceRefs` 的冻结范围。 */
export function validateAnalyzeNotebookPayload(
  payload: unknown,
  sourceRefs?: readonly AiSourceRef[]
): ProposalValidationIssue[] {
  if (!payload || typeof payload !== "object") {
    return [{ code: "PAYLOAD_INVALID", detail: "载荷不是对象。" }];
  }
  const candidate = payload as Partial<AnalyzeNotebookPayload> & Record<string, unknown>;
  const issues: ProposalValidationIssue[] = [];
  const extra = Object.keys(candidate).filter(
    (key) => !["kind", "notebookId", "result"].includes(key)
  );
  if (extra.length > 0) {
    issues.push({ code: "PAYLOAD_INVALID", detail: `不接受的字段：${extra.join(",")}` });
  }
  if (candidate.kind !== "analyze_notebook") {
    return [{ code: "PAYLOAD_INVALID", detail: `未知载荷类型：${String(candidate.kind)}。` }];
  }
  if (typeof candidate.notebookId !== "string" || candidate.notebookId.length === 0) {
    issues.push({ code: "PAYLOAD_INVALID", detail: "缺少 notebookId。" });
  }
  const refs = sourceRefs ?? [];
  const allowedPageIds = new Set(refs.filter((ref) => ref.kind === "page").map((ref) => ref.id));
  const allowedBlockIds = new Set(refs.flatMap((ref) => ref.blockIds ?? []));
  const resultIssues: NotebookAnalysisIssue[] = validateNotebookAnalysisResult(
    candidate.result,
    sourceRefs === undefined
      ? {}
      : { allowedPageIds, allowedBlockIds }
  );
  for (const issue of resultIssues) {
    issues.push({ code: "PAYLOAD_INVALID", detail: `${issue.code}:${issue.detail}` });
  }
  return issues;
}

/**
 * 运行时载荷校验：只有**原篇已有的 text block** 允许被替换。
 * 未知/重复 blockId、非法结构、超限内容一律拒绝；这里不读取原篇，
 * 只做载荷自身合法性检查，与源块的白名单核对在应用事务内完成。
 */
export function validateOrganizePayload(payload: unknown): ProposalValidationIssue[] {
  const issues: ProposalValidationIssue[] = [];
  if (!payload || typeof payload !== "object") {
    return [{ code: "PAYLOAD_INVALID", detail: "载荷不是对象。" }];
  }
  const candidate = payload as Partial<OrganizePagePayload>;
  if (candidate.kind !== "organize_page") {
    return [{ code: "PAYLOAD_INVALID", detail: `未知载荷类型：${String(candidate.kind)}。` }];
  }
  if (typeof candidate.pageId !== "string" || candidate.pageId.length === 0) {
    issues.push({ code: "PAYLOAD_INVALID", detail: "缺少 pageId。" });
  }
  if (candidate.title !== undefined) {
    if (typeof candidate.title !== "string" || candidate.title.trim().length === 0) {
      issues.push({ code: "PAYLOAD_INVALID", detail: "title 必须是非空字符串或省略。" });
    } else if (candidate.title.length > MAX_PAGE_TITLE_LENGTH) {
      issues.push({
        code: "TITLE_TOO_LONG",
        detail: `标题超过 ${MAX_PAGE_TITLE_LENGTH} 字。`
      });
    }
  }
  if (
    candidate.summary !== undefined &&
    (typeof candidate.summary !== "string" || candidate.summary.length > MAX_PAGE_TEXT_LENGTH)
  ) {
    issues.push({ code: "SUMMARY_TOO_LONG", detail: "summary 必须是字符串且不超长。" });
  }
  if (!Array.isArray(candidate.textBlocks)) {
    issues.push({ code: "PAYLOAD_INVALID", detail: "textBlocks 必须是数组。" });
    return issues;
  }
  const seen = new Set<string>();
  for (const block of candidate.textBlocks) {
    if (!block || typeof block !== "object") {
      issues.push({ code: "PAYLOAD_INVALID", detail: "textBlocks 元素不是对象。" });
      continue;
    }
    const entry = block as { blockId?: unknown; content?: unknown };
    if (typeof entry.blockId !== "string" || entry.blockId.length === 0) {
      issues.push({ code: "PAYLOAD_INVALID", detail: "blockId 必须是非空字符串。" });
      continue;
    }
    if (seen.has(entry.blockId)) {
      issues.push({ code: "BLOCK_DUPLICATE", detail: `blockId 重复：${entry.blockId}。` });
    }
    seen.add(entry.blockId);
    if (typeof entry.content !== "string") {
      issues.push({
        code: "PAYLOAD_INVALID",
        detail: `blockId ${entry.blockId} 的 content 不是字符串。`
      });
      continue;
    }
    if (entry.content.length > MAX_PAGE_TEXT_LENGTH) {
      issues.push({
        code: "CONTENT_TOO_LONG",
        detail: `blockId ${entry.blockId} 超过单块 ${MAX_PAGE_TEXT_LENGTH} 字上限。`
      });
    }
  }
  return issues;
}

export function assertValidOrganizePayload(payload: unknown): OrganizePagePayload {
  const issues = validateOrganizePayload(payload);
  if (issues.length > 0) throw new ProposalPayloadError(issues);
  return payload as OrganizePagePayload;
}

/**
 * 与源块白名单核对：只允许替换**已存在的 text block**。
 * 图片块、unsupported-image、重排与新增都不在首期能力内。
 */
export function checkPayloadAgainstBlocks(
  payload: OrganizePagePayload,
  blocks: readonly { id: string; type: string }[]
): ProposalValidationIssue[] {
  const byId = new Map(blocks.map((block) => [block.id, block] as const));
  const issues: ProposalValidationIssue[] = [];
  for (const block of payload.textBlocks) {
    const target = byId.get(block.blockId);
    if (!target) {
      issues.push({ code: "BLOCK_UNKNOWN", detail: `原篇没有块 ${block.blockId}。` });
      continue;
    }
    if (target.type !== "text") {
      issues.push({
        code: "BLOCK_NOT_TEXT",
        detail: `块 ${block.blockId} 是 ${target.type}，首期只允许替换 text 块。`
      });
    }
  }
  return issues;
}

export type PreviewOutcome =
  | { ok: true; proposal: AiProposal }
  | { ok: false; reason: "not-draft" | "payload-invalid"; issues?: ProposalValidationIssue[] };

/**
 * 冻结预览：校验载荷（按 kind 分发）→ 记录 payloadDigest 与预览时间 → 进入可接受状态。
 * 改变载荷必须重新预览；旧接受不能授权新内容。
 */
export function previewProposal(
  proposal: AiProposal,
  now: () => Date = () => new Date()
): PreviewOutcome {
  if (proposal.status !== "draft") return { ok: false, reason: "not-draft" };
  const issues = validateProposalPayload(proposal.payload, proposal.sourceRefs);
  if (issues.length > 0) {
    return { ok: false, reason: "payload-invalid", issues };
  }
  const timestamp = now().toISOString();
  return {
    ok: true,
    proposal: {
      ...proposal,
      payloadDigest: payloadDigest(proposal.payload),
      previewedAt: timestamp,
      revision: proposal.revision + 1,
      updatedAt: timestamp
    }
  };
}

export type AcceptOutcome =
  | { ok: true; proposal: AiProposal }
  | { ok: false; reason: "not-acceptable" | "digest-mismatch" | "not-previewed" };

/**
 * 接受用户**确切的预览版本**：draft 且已冻结时才可接受，且载荷必须仍等于冻结身份。
 */
export function acceptProposal(
  proposal: AiProposal,
  now: () => Date = () => new Date()
): AcceptOutcome {
  if (proposal.status !== "draft") return { ok: false, reason: "not-acceptable" };
  if (!proposal.payloadDigest || !proposal.previewedAt)
    return { ok: false, reason: "not-previewed" };
  if (payloadDigest(proposal.payload) !== proposal.payloadDigest) {
    return { ok: false, reason: "digest-mismatch" };
  }
  return {
    ok: true,
    proposal: {
      ...proposal,
      status: "accepted",
      revision: proposal.revision + 1,
      updatedAt: now().toISOString()
    }
  };
}

export function rejectProposal(
  proposal: AiProposal,
  now: () => Date = () => new Date()
): AiProposal {
  if (proposal.status !== "draft") return proposal;
  return {
    ...proposal,
    status: "rejected",
    revision: proposal.revision + 1,
    updatedAt: now().toISOString()
  };
}

/**
 * 撤回：已接受但**尚未应用**的建议可以撤回为 rejected。
 * 对应“接受后业务提交失败，用户放弃重试”的真实状态；已 applied 不可撤回。
 */
/**
 * 撤回。已接受但**尚未应用**的建议可以撤回为 rejected。
 *
 * `accepting`（提交中）**不撤回**：此时授权已被一次进行中的业务提交占用，
 * 撤回若生效就会破坏“业务已提交”与“建议仍被授权”的一致；该窗口由
 * `authorizeCommit` 的原子占用与业务事务的结论共同封闭。
 */
export function withdrawAcceptedProposal(
  proposal: AiProposal,
  now: () => Date = () => new Date()
): AiProposal {
  if (proposal.status !== "accepted") return proposal;
  return {
    ...proposal,
    status: "rejected",
    revision: proposal.revision + 1,
    updatedAt: now().toISOString()
  };
}

export function markProposalApplied(
  proposal: AiProposal,
  appliedRevision: number,
  now: () => Date = () => new Date()
): AiProposal {
  return {
    ...proposal,
    status: "applied",
    appliedRevision,
    appliedAt: now().toISOString(),
    revision: proposal.revision + 1,
    updatedAt: now().toISOString()
  };
}

export function markProposalConflicted(
  proposal: AiProposal,
  detail: string,
  now: () => Date = () => new Date()
): AiProposal {
  return {
    ...proposal,
    status: "conflicted",
    conflictDetail: detail,
    revision: proposal.revision + 1,
    updatedAt: now().toISOString()
  };
}

// —— P3-02：organize_captures 载荷校验（结构 + 引用完整性，机器生成的载荷边界） ——

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isDateLike(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40;
}

function isFiniteSize(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** 冻结来源快照：形状合法、未缺失（messageFound 不得为 false）、文本不超限。 */
export function isFrozenCaptureSource(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const source = value as Partial<AppendSourceSnapshot>;
  if (!isNonEmptyString(source.messageId)) return false;
  if (typeof source.text !== "string" || source.text.length > MAX_PAGE_TEXT_LENGTH) return false;
  if (!isDateLike(source.capturedAt)) return false;
  if (source.messageFound === false) return false;
  if (!Array.isArray(source.media)) return false;
  return source.media.every((item) => {
    if (!item || typeof item !== "object") return false;
    const media = item as Partial<AppendSourceSnapshot["media"][number]>;
    return (
      isNonEmptyString(media.assetId) &&
      isNonEmptyString(media.name) &&
      isNonEmptyString(media.type) &&
      isFiniteSize(media.size) &&
      isDateLike(media.createdAt) &&
      isNonEmptyString(media.sourceMediaId)
    );
  });
}

function isFrozenMediaLinkEntry(
  value: unknown
): value is { messageId: string; sourceMediaId: string; assetId: string } {
  if (!value || typeof value !== "object") return false;
  const entry = value as { messageId?: unknown; sourceMediaId?: unknown; assetId?: unknown };
  return (
    isNonEmptyString(entry.messageId) &&
    isNonEmptyString(entry.sourceMediaId) &&
    isNonEmptyString(entry.assetId)
  );
}

function isOrganizeCapturesDraft(value: unknown): value is JournalDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<JournalDraft>;
  if (!Array.isArray(draft.entries)) return false;
  return draft.entries.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    if (entry.kind === "message") {
      const message = entry as { kind: "message"; messageId?: unknown; blocks?: unknown };
      if (!isNonEmptyString(message.messageId)) return false;
      if (!Array.isArray(message.blocks) || message.blocks.length === 0) return false;
      return message.blocks.every(
        (block) =>
          block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string" &&
          ((block as { text?: string }).text as string).length <= MAX_PAGE_TEXT_LENGTH
      );
    }
    if (entry.kind === "photo") {
      const photo = entry as { kind: "photo"; assetId?: unknown; caption?: unknown };
      return isNonEmptyString(photo.assetId) && typeof photo.caption === "string";
    }
    return false;
  });
}

/**
 * organize_captures 载荷校验（R3/R4）：unknown 输入先验证结构再访问字段——
 * 任何非法形状（null 元素、错误类型、非法目标/媒体）都返回 issue 而不是抛错，
 * 因此存储读取边界可以把非法记录直接判为拒绝。
 *
 * 关系完整性（R4）：
 * - 来源媒体与 mediaLink 完全对应：缺失、assetId 不一致、映射冲突、来源之外的
 *   映射条目、同一 assetId 被多个来源使用都拒绝；
 * - includedMessageIds 必须是冻结来源 ID 的**有序子序列**；
 * - 草稿每个 message 后必须紧随该来源的确定性图片序列（身份/顺序/数量/图注
 *   与冻结媒体完全一致）——被跳过来源的图片不可能混入，也不依赖未来阶段兜底。
 */
export function validateOrganizeCapturesPayload(payload: unknown): ProposalValidationIssue[] {
  if (!payload || typeof payload !== "object") {
    return [{ code: "PAYLOAD_INVALID", detail: "载荷不是对象。" }];
  }
  const candidate = payload as Partial<OrganizeCapturesPayload> & Record<string, unknown>;
  const allowed = [
    "kind",
    "target",
    "sources",
    "mediaLink",
    "includedMessageIds",
    "draft",
    "outgoingInput",
    "duplicatePolicy"
  ];
  const issues: ProposalValidationIssue[] = [];
  const extra = Object.keys(candidate).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    issues.push({ code: "PAYLOAD_INVALID", detail: `不接受的字段：${extra.join(",")}` });
  }

  if (candidate.duplicatePolicy !== undefined && candidate.duplicatePolicy !== "append-duplicate") {
    issues.push({ code: "PAYLOAD_INVALID", detail: "重复策略必须经过显式预览确认。" });
  }
  const target = candidate.target;
  if (
    !target ||
    typeof target !== "object" ||
    ((target as CaptureOrganizeTarget).kind !== "new" &&
      (target as CaptureOrganizeTarget).kind !== "append")
  ) {
    issues.push({ code: "TARGET_INVALID", detail: "写入目标不合法或缺失。" });
  } else {
    const typedTarget = target as CaptureOrganizeTarget;
    if (
      (typedTarget.kind === "new" &&
        (!isNonEmptyString(typedTarget.notebookId) ||
          typeof typedTarget.title !== "string" ||
          typedTarget.title.trim().length === 0 ||
          typedTarget.title.length > MAX_PAGE_TITLE_LENGTH)) ||
      (typedTarget.kind === "append" && !isNonEmptyString(typedTarget.pageId))
    ) {
      issues.push({ code: "TARGET_INVALID", detail: "写入目标不合法或缺失。" });
    }
  }

  // 来源快照：先形状校验（不访问字段），通过后才提取 ID。
  const sources = candidate.sources;
  let sourcesValid = false;
  let sourceIds: string[] = [];
  let sourcesArray: AppendSourceSnapshot[] = [];
  if (!Array.isArray(sources) || sources.length === 0 || !sources.every(isFrozenCaptureSource)) {
    issues.push({
      code: "SOURCE_INVALID",
      detail: "冻结来源快照不合法（缺失、重复或形状错误）。"
    });
  } else {
    sourcesArray = sources as AppendSourceSnapshot[];
    sourceIds = sourcesArray.map((source) => source.messageId);
    if (new Set(sourceIds).size !== sourceIds.length) {
      issues.push({ code: "SOURCE_INVALID", detail: "冻结来源快照存在重复 messageId。" });
    } else {
      sourcesValid = true;
    }
  }

  // 媒体映射：先形状校验，通过后才做与来源的对应核对。
  const mediaLink = candidate.mediaLink;
  let mediaLinkValid = false;
  let mediaLinkArray: { messageId: string; sourceMediaId: string; assetId: string }[] = [];
  if (!Array.isArray(mediaLink) || !mediaLink.every(isFrozenMediaLinkEntry)) {
    issues.push({ code: "MEDIA_LINK_INVALID", detail: "媒体映射不合法。" });
  } else {
    mediaLinkArray = mediaLink as { messageId: string; sourceMediaId: string; assetId: string }[];
    const linkKeys = mediaLinkArray.map((entry) => `${entry.messageId} ${entry.sourceMediaId}`);
    if (new Set(linkKeys).size !== linkKeys.length) {
      issues.push({ code: "MEDIA_LINK_INVALID", detail: "媒体映射存在重复来源媒体。" });
    } else {
      mediaLinkValid = true;
    }
  }

  // 纳入集合：先形状校验（非空字符串、唯一），再核对有序子序列关系。
  const included = candidate.includedMessageIds;
  let includedValid = false;
  let includedArray: string[] = [];
  if (
    !Array.isArray(included) ||
    !included.every((id) => isNonEmptyString(id)) ||
    new Set(included as string[]).size !== (included as string[]).length ||
    !(included as string[]).every((id) => sourceIds.includes(id))
  ) {
    issues.push({ code: "INCLUDED_INVALID", detail: "纳入来源集合不合法（空、重复或越界）。" });
  } else {
    includedArray = included as string[];
    let cursor = 0;
    const ordered = includedArray.every((id) => {
      const at = sourceIds.indexOf(id, cursor);
      if (at === -1) return false;
      cursor = at + 1;
      return true;
    });
    if (!ordered) {
      issues.push({
        code: "INCLUDED_INVALID",
        detail: "纳入来源必须是冻结来源 ID 的有序子序列。"
      });
    } else {
      includedValid = true;
    }
  }

  const draft = candidate.draft;
  let draftValid = false;
  if (!isOrganizeCapturesDraft(draft)) {
    issues.push({ code: "DRAFT_INVALID", detail: "草稿结构不合法。" });
  } else {
    draftValid = true;
  }

  if (typeof candidate.outgoingInput !== "string") {
    issues.push({ code: "OUTGOING_INVALID", detail: "实际外发清单缺失或不是字符串。" });
  }

  // —— 关系核对（仅在各自形状合法时执行，避免访问未验证字段） ——
  if (sourcesValid && mediaLinkValid) {
    const assetBySourceKey = new Map<string, string>();
    for (const entry of mediaLinkArray) {
      assetBySourceKey.set(`${entry.messageId} ${entry.sourceMediaId}`, entry.assetId);
    }
    const sourceKeys = new Set<string>();
    const assetOwners = new Map<string, string>();
    const assetsBySource = new Map<string, { assetId: string; caption: string }[]>();
    for (const source of sourcesArray) {
      const assets: { assetId: string; caption: string }[] = [];
      for (const item of source.media) {
        const key = `${source.messageId} ${item.sourceMediaId}`;
        sourceKeys.add(key);
        if (assetBySourceKey.get(key) !== item.assetId) {
          issues.push({
            code: "MEDIA_LINK_INVALID",
            detail: `来源媒体 ${key} 与冻结映射不一致（缺失或 assetId 不同）。`
          });
        }
        const owner = assetOwners.get(item.assetId);
        if (owner !== undefined && owner !== source.messageId) {
          issues.push({
            code: "MEDIA_LINK_INVALID",
            detail: `资产 ${item.assetId} 被多个来源使用（${owner} 与 ${source.messageId}）。`
          });
        }
        assetOwners.set(item.assetId, source.messageId);
        assets.push({ assetId: item.assetId, caption: item.name });
      }
      assetsBySource.set(source.messageId, assets);
    }
    for (const [key, assetId] of assetBySourceKey) {
      if (!sourceKeys.has(key)) {
        issues.push({
          code: "MEDIA_LINK_INVALID",
          detail: `媒体映射包含来源之外的条目：${key}（assetId ${assetId}）。`
        });
      }
    }

    // 草稿与纳入来源的确定性投影核对（R4）：
    // 每个 message 后必须紧随该来源冻结媒体的完整序列（身份/顺序/数量/图注）。
    if (draftValid && includedValid) {
      const entries = (draft as JournalDraft).entries;
      const messageIds = entries
        .filter((entry) => entry.kind === "message")
        .map((entry) => entry.messageId);
      if (messageIds.join(" ") !== includedArray.join(" ")) {
        issues.push({
          code: "DRAFT_INVALID",
          detail: "草稿文字条目与纳入来源集合不一致（顺序或数量）。"
        });
      }
      let ownerIndex = -1;
      const emittedBySource = new Map<string, number>();
      let projectionBroken = false;
      for (const entry of entries) {
        if (projectionBroken) break;
        if (entry.kind === "message") {
          ownerIndex += 1;
          continue;
        }
        const owner = includedArray[ownerIndex];
        const expectedList = owner !== undefined ? (assetsBySource.get(owner) ?? []) : [];
        const expected = expectedList[emittedBySource.get(owner ?? "") ?? 0];
        if (
          entry.kind !== "photo" ||
          expected === undefined ||
          entry.assetId !== expected.assetId ||
          entry.caption !== expected.caption
        ) {
          issues.push({
            code: "DRAFT_INVALID",
            detail:
              "草稿图片与其所属来源的确定性投影不一致（紧随性、身份、顺序、数量或图注）；" +
              "被跳过来源的图片不允许出现。"
          });
          projectionBroken = true;
          break;
        }
        emittedBySource.set(owner, (emittedBySource.get(owner ?? "") ?? 0) + 1);
      }
      if (!projectionBroken) {
        // 数量完备：每个纳入来源的图片必须全部出现（少发也是投影不一致）。
        for (const id of includedArray) {
          const expectedCount = (assetsBySource.get(id) ?? []).length;
          if ((emittedBySource.get(id) ?? 0) !== expectedCount) {
            issues.push({
              code: "DRAFT_INVALID",
              detail: "草稿图片数量与纳入来源的冻结媒体数量不一致。"
            });
            break;
          }
        }
      }
    }
  }

  return issues;
}
