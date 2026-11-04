/**
 * P1-02：AiTask 类型与有限状态迁移。
 *
 * 边界：任务状态只表达“执行到哪一步”，不代表用户内容已修改。
 * 模型执行完成 ≠ 正文已改；accepted ≠ applied（后者属于 Proposal 与 Safe Commit）。
 * 不实现通用调度图、步骤引擎、重试队列或 Agent Runtime。
 */

/**
 * P1 首期只实现 organize_page；P3-02 增加 organize_captures；
 * P4 增加 analyze_notebook（只读本册分析）；P5 增加 generate_page_metadata
 * （用户显式触发的单篇主题/摘要派生）；P8 增加 organize_collection
 * （受限计划 → 检索/读取 → 只读分组提案，其余类型仍保留在文档）。
 */
export type AiTaskType =
  | "organize_page"
  | "organize_captures"
  | "analyze_notebook"
  | "generate_page_metadata"
  | "organize_collection";

export type AiTaskStatus =
  "queued" | "running" | "waiting_user" | "completed" | "failed" | "cancelled";

/** P3-02：Capture AI 的写入目标（用户指定；模型不能选择或改写）。 */
export type CaptureOrganizeTarget =
  | { kind: "new"; notebookId: string; title: string }
  | { kind: "append"; pageId: string };

/** P2：organize_page 的冻结输入（形状保持不变，既有读取路径兼容）。 */
export type OrganizePageTaskInput = {
  pageId: string;
  sourceDigest: string;
  maxOutputChars: number;
  /**
   * P5：单篇元数据生成也是 pageId+sourceDigest 形状，用显式判别字段区分两者。
   * organize_page 必须缺失该字段（旧记录同样缺失，读取兼容）。
   */
  mode?: undefined;
};

/**
 * P5：单篇派生元数据（摘要 + 主题标签）的冻结输入。
 * 只写 AI 独立库的 pageMetadata，不写正文、媒体或业务收据。
 */
export type GeneratePageMetadataTaskInput = {
  pageId: string;
  sourceDigest: string;
  maxOutputChars: number;
  mode: "page_metadata";
};

/**
 * P3-02：organize_captures 的冻结输入。
 *
 * `pageId?: undefined`：organize_page 专有字段在 capture 任务上必须缺失——
 * 这使 `AiTask["input"]` 联合可安全查询（`input.pageId === page.id` 对 capture
 * 任务恒为 false，既有 P2 过滤代码无需修改，语义也正确）。
 */
export type OrganizeCapturesTaskInput = {
  /** 用户选定的写入目标（生成前冻结）。 */
  target: CaptureOrganizeTarget;
  /** 冻结的选中来源 ID；顺序即输入构造顺序，无重复。 */
  sourceMessageIds: string[];
  /** 全部冻结来源快照的聚合摘要（与 Proposal.payload.sources 一致）。 */
  sourcesDigest: string;
  maxOutputChars: number;
  pageId?: undefined;
};

export type AiTaskInput =
  | OrganizePageTaskInput
  | OrganizeCapturesTaskInput
  | AnalyzeNotebookTaskInput
  | GeneratePageMetadataTaskInput
  | OrganizeCollectionTaskInput;

/**
 * P8：整理检索结果的**冻结权限上限**（用户显式选择，生成前冻结）。
 *
 * - `null` = 该维度不额外限制（仍受可见性过滤：未删除、未归档、非 legacy 关联页）；
 * - **空数组 = 不允许任何目标**，绝不解释成「全部」——校验器直接拒绝空数组；
 * - `from` 含、`to` 不含（沿用既有检索契约）；`null` = 该侧不限制。
 */
export type CollectionScope = {
  notebookIds: string[] | null;
  regionIds: string[] | null;
  tripIds: string[] | null;
  placeIds: string[] | null;
  from: string | null;
  to: string | null;
};

/** 整理目标字符上限：超长在写入前拒绝（不截断用户输入，不静默丢字）。 */
export const MAX_COLLECTION_GOAL_CHARS = 400;

/**
 * P8：organize_collection 的冻结输入。
 * `pageId?: undefined`：延续既有做法，使 `AiTask["input"]` 联合可安全查询。
 */
export type OrganizeCollectionTaskInput = {
  /** 用户的整理目标（视为数据；其中的指令不执行）。 */
  goal: string;
  scope: CollectionScope;
  maxOutputChars: number;
  pageId?: undefined;
};

/**
 * P4：本册只读分析的冻结输入。
 *
 * - `sources`：冻结的来源篇（顺序即输入顺序、无重复），每篇带生成时的 sourceDigest；
 * - `notebookDigest`：父本自身摘要（标题 + 成员页身份），成员变化即视为源已变化；
 * - `pageId?: undefined`：本任务不是单篇任务，既有按 `input.pageId` 过滤的 P2 代码
 *   对它恒为 false，无需修改且语义正确。
 */
export type AnalyzeNotebookTaskInput = {
  notebookId: string;
  sources: { pageId: string; sourceDigest: string }[];
  notebookDigest: string;
  maxOutputChars: number;
  pageId?: undefined;
};

/** 终态：不再变化，迟到回调不得覆盖。 */
export const AI_TASK_TERMINAL_STATUSES: readonly AiTaskStatus[] = [
  "completed",
  "failed",
  "cancelled"
];

export function isAiTaskTerminal(status: AiTaskStatus): boolean {
  return AI_TASK_TERMINAL_STATUSES.includes(status);
}

/** 允许的迁移。终态不在任何键里 → 天然不可离开。 */
const ALLOWED_TRANSITIONS: Record<AiTaskStatus, readonly AiTaskStatus[]> = {
  queued: ["running", "cancelled", "failed"],
  running: ["waiting_user", "completed", "failed", "cancelled"],
  // 用户审阅中：接受并落库后 completed；拒绝则 cancelled。
  waiting_user: ["completed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: []
};

export function canTransitionAiTask(from: AiTaskStatus, to: AiTaskStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export type AiTaskError = { code: string; message: string };

type AiTaskCommon = {
  id: string;
  status: AiTaskStatus;
  /** 有限步骤进度，不是通用调度游标。 */
  step?: number;
  error?: AiTaskError;
  model?: string;
  promptId: string;
  promptVersion: number;
  /** 乐观并发版本；每次成功持久化 +1。 */
  revision: number;
  /** 显式重试建立的新任务指向原任务。 */
  retryOf?: string;
  /** 当前有效 Proposal（waiting_user/completed 时存在）。 */
  proposalId?: string;
  createdAt: string;
  updatedAt: string;
};

/** 判别联合：`task.type` 收窄后 `task.input` 具有对应形状（type 与 input 相互匹配）。 */
export type OrganizePageAiTask = AiTaskCommon & {
  type: "organize_page";
  input: OrganizePageTaskInput;
};

export type OrganizeCapturesAiTask = AiTaskCommon & {
  type: "organize_captures";
  input: OrganizeCapturesTaskInput;
};

export type AiTask =
  | OrganizePageAiTask
  | OrganizeCapturesAiTask
  | AnalyzeNotebookAiTask
  | GeneratePageMetadataAiTask
  | OrganizeCollectionAiTask;

export type AiTaskTransitionOutcome =
  | { ok: true; task: AiTask }
  | { ok: false; reason: "terminal" | "invalid-transition" | "stale-revision"; current: AiTask };

/**
 * 迁移一次任务状态。`expectedRevision` 不匹配时拒绝（迟到回调的保护）。
 * 终态不再接受任何迁移，包括“成功”回调。
 */
export function transitionAiTask<T extends AiTask>(
  task: T,
  to: AiTaskStatus,
  patch: Partial<Omit<AiTaskCommon, "id" | "status" | "revision" | "createdAt">> = {},
  now: () => Date = () => new Date(),
  expectedRevision?: number
): AiTaskTransitionOutcome {
  if (expectedRevision !== undefined && expectedRevision !== task.revision) {
    return { ok: false, reason: "stale-revision", current: task };
  }
  if (isAiTaskTerminal(task.status)) {
    return { ok: false, reason: "terminal", current: task };
  }
  if (!canTransitionAiTask(task.status, to)) {
    return { ok: false, reason: "invalid-transition", current: task };
  }
  return {
    ok: true,
    task: {
      ...task,
      ...patch,
      status: to,
      revision: task.revision + 1,
      updatedAt: now().toISOString()
    }
  };
}

/**
 * 应用重启后清理遗留执行态：running → failed(interrupted)。
 * queued 不自动发请求（保持 queued，由用户显式启动）；waiting_user 保留建议但需重验源摘要。
 */
export function recoverInterruptedTasks(
  tasks: readonly AiTask[],
  now: () => Date = () => new Date()
): { tasks: AiTask[]; interrupted: string[] } {
  const interrupted: string[] = [];
  const next = tasks.map((task) => {
    if (task.status !== "running") return task;
    interrupted.push(task.id);
    return {
      ...task,
      status: "failed" as const,
      error: { code: "interrupted", message: "应用重启前任务未完成，已标记失败；请显式重试。" },
      revision: task.revision + 1,
      updatedAt: now().toISOString()
    };
  });
  return { tasks: next, interrupted };
}

/** 显式重试：新建任务身份，迟到结果无法覆盖新尝试。 */
export function createRetryTask(
  task: AiTask,
  newId: string,
  now: () => Date = () => new Date()
): AiTask {
  const timestamp = now().toISOString();
  return {
    ...task,
    id: newId,
    status: "queued",
    retryOf: task.id,
    step: undefined,
    error: undefined,
    proposalId: undefined,
    revision: 0,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

// —— P3-02：按 type 匹配的输入运行时校验（供存储边界 isAiTask 与测试共用） ——

function isCaptureOrganizeTarget(value: unknown): value is CaptureOrganizeTarget {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CaptureOrganizeTarget>;
  if (candidate.kind === "new") {
    const target = candidate as { kind: "new"; notebookId?: unknown; title?: unknown };
    return (
      typeof target.notebookId === "string" &&
      target.notebookId.length > 0 &&
      typeof target.title === "string" &&
      target.title.trim().length > 0
    );
  }
  if (candidate.kind === "append") {
    const target = candidate as { kind: "append"; pageId?: unknown };
    return typeof target.pageId === "string" && target.pageId.length > 0;
  }
  return false;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** organize_page 输入：既有 P2 形状（pageId/sourceDigest/maxOutputChars）。 */
export function isOrganizePageTaskInput(value: unknown): value is OrganizePageTaskInput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OrganizePageTaskInput> & Record<string, unknown>;
  // P5：mode 必须缺失，避免与单篇元数据生成输入互相误判。
  if (candidate.mode !== undefined) return false;
  return (
    isNonEmptyString(candidate.pageId) &&
    isNonEmptyString(candidate.sourceDigest) &&
    typeof candidate.maxOutputChars === "number" &&
    Number.isInteger(candidate.maxOutputChars) &&
    candidate.maxOutputChars > 0
  );
}

/** P5：单篇元数据生成输入：pageId + 冻结摘要 + 预算 + 显式 mode 判别。 */
export function isGeneratePageMetadataTaskInput(
  value: unknown
): value is GeneratePageMetadataTaskInput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GeneratePageMetadataTaskInput> & Record<string, unknown>;
  return (
    candidate.mode === "page_metadata" &&
    isNonEmptyString(candidate.pageId) &&
    isNonEmptyString(candidate.sourceDigest) &&
    typeof candidate.maxOutputChars === "number" &&
    Number.isInteger(candidate.maxOutputChars) &&
    candidate.maxOutputChars > 0
  );
}

/**
 * organize_captures 输入：目标 + 冻结来源 ID（无重复）+ 聚合摘要 + 预算；
 * `pageId` 与 `sourceDigest` 是 organize_page 专有字段，capture 输入必须缺失。
 */
export function isOrganizeCapturesTaskInput(value: unknown): value is OrganizeCapturesTaskInput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OrganizeCapturesTaskInput> & Record<string, unknown>;
  if (candidate.sourceDigest !== undefined || candidate.pageId !== undefined) return false;
  if (!isCaptureOrganizeTarget(candidate.target)) return false;
  if (
    !Array.isArray(candidate.sourceMessageIds) ||
    candidate.sourceMessageIds.length === 0 ||
    !candidate.sourceMessageIds.every((id) => isNonEmptyString(id)) ||
    new Set(candidate.sourceMessageIds).size !== candidate.sourceMessageIds.length
  ) {
    return false;
  }
  return (
    isNonEmptyString(candidate.sourcesDigest) &&
    typeof candidate.maxOutputChars === "number" &&
    Number.isInteger(candidate.maxOutputChars) &&
    candidate.maxOutputChars > 0
  );
}

/** type 与 input 必须相互匹配：形状错误或交叉错配都拒绝。 */
export function isAiTaskInputForType(type: AiTaskType, input: unknown): boolean {
  if (type === "organize_page") return isOrganizePageTaskInput(input);
  if (type === "organize_captures") return isOrganizeCapturesTaskInput(input);
  if (type === "analyze_notebook") return isAnalyzeNotebookTaskInput(input);
  if (type === "generate_page_metadata") return isGeneratePageMetadataTaskInput(input);
  if (type === "organize_collection") return isOrganizeCollectionTaskInput(input);
  return false;
}

/** P5：单篇元数据生成任务的判别（既有联合的新成员）。 */
export type GeneratePageMetadataAiTask = AiTaskCommon & {
  type: "generate_page_metadata";
  input: GeneratePageMetadataTaskInput;
};

/**
 * analyze_notebook 输入：冻结本 ID + 有序无重复来源（页 ID 与摘要）+ 本册摘要 + 预算。
 * `pageId` 必须是 organize_page 专有字段，本任务输入不得携带。
 */
export function isAnalyzeNotebookTaskInput(value: unknown): value is AnalyzeNotebookTaskInput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AnalyzeNotebookTaskInput> & Record<string, unknown>;
  if (candidate.pageId !== undefined) return false;
  if (!isNonEmptyString(candidate.notebookId)) return false;
  if (!isNonEmptyString(candidate.notebookDigest)) return false;
  if (
    !Array.isArray(candidate.sources) ||
    candidate.sources.length === 0 ||
    !candidate.sources.every(
      (source) =>
        Boolean(source) &&
        typeof source === "object" &&
        isNonEmptyString((source as { pageId?: unknown }).pageId) &&
        isNonEmptyString((source as { sourceDigest?: unknown }).sourceDigest)
    )
  ) {
    return false;
  }
  const pageIds = candidate.sources.map((source) => source.pageId);
  if (new Set(pageIds).size !== pageIds.length) return false;
  return (
    typeof candidate.maxOutputChars === "number" &&
    Number.isInteger(candidate.maxOutputChars) &&
    candidate.maxOutputChars > 0
  );
}

/** P4：本册任务的判别（既有联合的新成员）。 */
export type AnalyzeNotebookAiTask = AiTaskCommon & {
  type: "analyze_notebook";
  input: AnalyzeNotebookTaskInput;
};

/** P8：整理检索结果任务的判别（既有联合的新成员，只读提案）。 */
export type OrganizeCollectionAiTask = AiTaskCommon & {
  type: "organize_collection";
  input: OrganizeCollectionTaskInput;
};

/**
 * P8：`YYYY-MM-DD` 日历日期（与 `use-notebook-search.isValidDateFilter` 同一口径）。
 * 计划里模型给出的时间只能收窄，格式错误直接拒绝，不做「尽力解析」。
 */
export function isValidCollectionDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(Number(match[1]), month, 0)).getUTCDate();
}

/** `null`（不限）或**非空** ID 数组（空数组 = 没有权限，拒绝）。 */
function isIdSetOrNull(value: unknown): value is string[] | null {
  if (value === null) return true;
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => isNonEmptyString(item)) &&
    new Set(value).size === value.length
  );
}

export function isCollectionScope(value: unknown): value is CollectionScope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CollectionScope> & Record<string, unknown>;
  const extra = Object.keys(candidate).filter(
    (key) =>
      !["notebookIds", "regionIds", "tripIds", "placeIds", "from", "to"].includes(key)
  );
  if (extra.length > 0) return false;
  if (
    !isIdSetOrNull(candidate.notebookIds) ||
    !isIdSetOrNull(candidate.regionIds) ||
    !isIdSetOrNull(candidate.tripIds) ||
    !isIdSetOrNull(candidate.placeIds)
  ) {
    return false;
  }
  if (candidate.from !== null && !isValidCollectionDate(candidate.from)) return false;
  if (candidate.to !== null && !isValidCollectionDate(candidate.to)) return false;
  if (candidate.from !== null && candidate.to !== null && candidate.from >= candidate.to) {
    return false;
  }
  return true;
}

/** P8：整理检索结果输入：目标 + 冻结范围 + 预算；`pageId` 必须缺失。 */
export function isOrganizeCollectionTaskInput(
  value: unknown
): value is OrganizeCollectionTaskInput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OrganizeCollectionTaskInput> & Record<string, unknown>;
  if (candidate.pageId !== undefined) return false;
  return (
    // 只有空白的「整理目标」没有意义：拒绝，不解释成任何范围。
    typeof candidate.goal === "string" &&
    candidate.goal.trim().length > 0 &&
    candidate.goal.length <= MAX_COLLECTION_GOAL_CHARS &&
    isCollectionScope(candidate.scope) &&
    typeof candidate.maxOutputChars === "number" &&
    Number.isInteger(candidate.maxOutputChars) &&
    candidate.maxOutputChars > 0
  );
}
