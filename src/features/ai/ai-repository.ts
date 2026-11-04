/**
 * P1-02：AI 派生数据存储（独立 `xingji-ai` 库）。
 *
 * 边界：
 * - 只保存派生信息：tasks / proposals / pageMetadata。不是用户正文的唯一副本，
 *   删除整库不影响 Notebook、Capture、媒体与已接受的用户内容。
 * - 写入是“期望状态 + 期望 revision”的比较写入（CAS）：迟到结果与旧状态
 *   不能覆盖新状态或终态。
 * - 不实现缓存层、队列、事件总线或跨库事务框架。
 */
import {
  isAiTaskTerminal,
  type AiTask,
  type AiTaskError,
  type AiTaskStatus,
  type AiTaskType
} from "./ai-task";
import {
  payloadDigest,
  validateAnalyzeNotebookPayload,
  validateOrganizeCapturesPayload,
  validateOrganizeCollectionPayload
} from "./ai-proposal";
import type {
  AiProposal,
  AiProposalStatus,
  AiProposalType,
  AiSourceRef,
  OrganizeCapturesPayload,
  ProposalPayload
} from "./ai-proposal";
import { SOURCE_DIGEST_VERSION } from "./ai-context";
import {
  isAnalyzeNotebookTaskInput,
  isGeneratePageMetadataTaskInput,
  isOrganizeCapturesTaskInput,
  isOrganizeCollectionTaskInput,
  isOrganizePageTaskInput
} from "./ai-task";

export const AI_DB_NAME = "xingji-ai";
export const AI_DB_VERSION = 1;
export const AI_TASK_STORE = "tasks";
export const AI_PROPOSAL_STORE = "proposals";
export const AI_METADATA_STORE = "pageMetadata";

/** 比较写入失败：状态或 revision 与期望不符，绝不覆盖。 */
export class StaleAiWriteError extends Error {
  constructor(
    readonly collection: "task" | "proposal",
    readonly id: string,
    readonly expected: { status?: string; revision?: number },
    readonly actual: { status?: string; revision?: number } | null
  ) {
    super(`AI_WRITE_STALE:${collection}:${id}`);
    this.name = "StaleAiWriteError";
  }
}

/** 本实现不认识的记录：明确拒绝，不猜测语义、不静默写入。 */
export class AiRecordInvalidError extends Error {
  constructor(
    readonly store: "task" | "proposal" | "pageMetadata",
    readonly id: string
  ) {
    super(`AI_RECORD_INVALID:${store}:${id}`);
    this.name = "AiRecordInvalidError";
  }
}

export type AiWriteGuard = {
  /** 期望的当前状态（如 running）。 */
  expectedStatus?: AiTaskStatus | AiProposalStatus;
  /** 期望的当前 revision（CAS）。 */
  expectedRevision?: number;
};

/**
 * 任务持久化端口（F4/F5）。
 *
 * 存在的唯一职责：让“任务状态迁移 + 建议落库”在 `xingji-ai` 库的**同一个事务**内完成，
 * 从而不可能出现“有建议没任务”“有任务没建议”或“清空后迟到回调重建任务/建议”。
 * 它不是通用事务框架：只有这一个组合写入口。
 */
/**
 * 提交意图授权（F2）。
 *
 * `authorizeCommit` 在 `xingji-ai` 库内做一次**原子条件写**：把建议从 `accepted`
 * 置为 `accepting`，同时核对关联任务存在、waiting_user 且指向该建议。
 * 任务与建议在同一个事务内读取。这一次写入同时是“最后一次授权核对”和“提交屏障”：
 * - 撤回发生在它之前 → 状态已不是 accepted → 授权失败，不进入业务提交；
 * - 撤回发生在它之后 → 建议处于 `accepting`，撤回被拒绝 → 不会出现
 *   “业务已提交但授权已失效”的悬挂提交。
 *
 * 失败释放：业务事务未提交时调用方用 `releaseCommit` 把 `accepting` 还原为 accepted；
 * 中断恢复：应用重启后遗留的 `accepting` 表示进程在提交窗口死亡，按业务收据是否
 * 存在决定补记为 applied 或还原为 accepted（见 `recoverInterruptedCommits`）。
 */
export interface AiCommitAuthorizationPort {
  authorizeCommit(input: {
    proposalId: string;
    expectedRevision: number;
  }): Promise<{ ok: true; proposal: AiProposal } | { ok: false; status: AiProposalStatus }>;
}

export interface AiTaskPort {
  saveTask(task: AiTask, guard?: AiWriteGuard): Promise<void>;
  getTask(id: string): Promise<AiTask | null>;
  /**
   * 在同一个事务内写入任务终态与建议（F4/F5）。
   *
   * 顺序语义（与 `clear()` 等价的同一 readwrite 事务序列）：
   * - `clear()` 先完成：任务记录消失 → 本方法拒绝，迟到回调不能重建任何记录；
   * - 本方法先完成：`clear()` 随后会同时清掉任务与建议。
   *
   * 语义：任务必须**已存在**（不允许缺失任务被迟到回调重新创建）；
   * `expectedRevision` 必须命中当前 revision；当前状态为终态时拒绝。
   */
  saveTaskWithProposal(input: {
    task: AiTask;
    proposal: AiProposal;
    expectedRevision: number;
  }): Promise<void>;
  /**
   * P5/R5：在同一个事务内写入**任务终态**与派生 `pageMetadata`。
   *
   * 存在理由与 `saveTaskWithProposal` 相同：让“任务已完成”和“派生结果已保存”不可能只成立一个。
   * 事务提交 = 两者都在；事务失败/清空竞争 = 两者都不在，调用方必须如实报告失败。
   * 不是通用事务框架：只有这一个组合写入口（第二个）。
   */
  saveTaskWithMetadata(input: {
    task: AiTask;
    metadata: AiPageMetadata;
    expectedRevision: number;
  }): Promise<void>;
}

export interface AiRepository extends AiTaskPort, AiCommitAuthorizationPort {
  saveTask(task: AiTask, guard?: AiWriteGuard): Promise<void>;
  getTask(id: string): Promise<AiTask | null>;
  listTasks(): Promise<AiTask[]>;
  saveProposal(proposal: AiProposal, guard?: AiWriteGuard): Promise<void>;
  getProposal(id: string): Promise<AiProposal | null>;
  /**
   * R1 修复：只读列出全部建议（与 `listTasks()` 对称的读访问器）。
   * Astra 复现需要按「是否落库」核对取消后的结果；P8 侧也只用于只读核对。
   * 不新增 store/index/版本；读取边界同样过滤 `isAiProposal`。
   */
  listProposals(): Promise<AiProposal[]>;
  savePageMetadata(metadata: AiPageMetadata): Promise<void>;
  getPageMetadata(pageId: string): Promise<AiPageMetadata | null>;
  /** P5：主题过滤与覆盖统计需要一次读出全部派生 metadata（只读，不做索引）。 */
  listPageMetadata(): Promise<AiPageMetadata[]>;
  /** 仅测试与隔离演练使用。 */
  clear(): Promise<void>;
}

export type AiMetadataStatus = "fresh" | "stale" | "unavailable";

export type AiPageMetadata = {
  pageId: string;
  summary?: string;
  topics?: string[];
  /** 生成时的源摘要；与当前源摘要比较得到 fresh/stale。 */
  sourceDigest: string;
  model: string;
  promptId: string;
  promptVersion: number;
  generatedAt: string;
};

/** 当前源摘要：调用方用 `pageSourceDigest`（或 Context 的 sourceDigest）传入；
 *  页不存在/不可读时传 null → unavailable，不误报 stale。 */
export function deriveMetadataStatus(
  metadata: AiPageMetadata | null,
  currentSourceDigest: string | null
): AiMetadataStatus {
  if (!metadata) return "unavailable";
  if (!metadata.sourceDigest.startsWith(`${SOURCE_DIGEST_VERSION}:`)) return "stale";
  if (currentSourceDigest === null) return "unavailable";
  return metadata.sourceDigest === currentSourceDigest ? "fresh" : "stale";
}

/** 主题标签最大长度：超过即视为非法输入（不截断，避免两个主题被折叠成同一个）。 */
export const MAX_TOPIC_LENGTH = 40;

/**
 * P5：主题标签的唯一规范化规则（生成写入与搜索过滤共用，避免两套标签体系）。
 * 去除首尾空白、把内部连续空白折叠为单个空格、统一小写；空串返回 null。
 * 超长返回 null（由写入边界拒绝，不在读取时静默截断）。
 */
export function normalizeTopic(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const collapsed = raw.trim().replace(/\s+/g, " ");
  if (collapsed.length === 0 || collapsed.length > MAX_TOPIC_LENGTH) return null;
  return collapsed.toLowerCase();
}

/** 规范化一组主题：丢弃空/超长项、去重（保留首次出现顺序）。 */
export function normalizeTopics(list: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of list) {
    const topic = normalizeTopic(item);
    if (topic === null || seen.has(topic)) continue;
    seen.add(topic);
    result.push(topic);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isAiTaskError(value: unknown): value is AiTaskError {
  return isRecord(value) && typeof value.code === "string" && typeof value.message === "string";
}

export function isAiTask(value: unknown): value is AiTask {
  if (!isRecord(value)) return false;
  const status = value.status;
  const input = value.input;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    // type 与 input 必须相互匹配（形状错误或交叉错配都拒绝），不能只放宽类型白名单。
    ((value.type === "organize_page" && isOrganizePageTaskInput(input)) ||
      (value.type === "organize_captures" && isOrganizeCapturesTaskInput(input)) ||
      (value.type === "analyze_notebook" && isAnalyzeNotebookTaskInput(input)) ||
      (value.type === "generate_page_metadata" && isGeneratePageMetadataTaskInput(input)) ||
      (value.type === "organize_collection" && isOrganizeCollectionTaskInput(input))) &&
    (status === "queued" ||
      status === "running" ||
      status === "waiting_user" ||
      status === "completed" ||
      status === "failed" ||
      status === "cancelled") &&
    typeof value.promptId === "string" &&
    typeof value.promptVersion === "number" &&
    Number.isInteger(value.promptVersion) &&
    typeof value.revision === "number" &&
    Number.isInteger(value.revision) &&
    value.revision >= 0 &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    (value.error === undefined || isAiTaskError(value.error)) &&
    (value.proposalId === undefined || typeof value.proposalId === "string") &&
    (value.retryOf === undefined || typeof value.retryOf === "string")
  );
}

export function isAiProposal(value: unknown): value is AiProposal {
  if (!isRecord(value)) return false;
  const status = value.status;
  if (
    !(
      typeof value.id === "string" &&
      value.id.length > 0 &&
      typeof value.taskId === "string" &&
      (value.type === "organize_page" ||
        value.type === "organize_captures" ||
        value.type === "analyze_notebook" ||
        value.type === "organize_collection") &&
      (status === "draft" ||
        status === "accepted" ||
        status === "accepting" ||
        status === "rejected" ||
        status === "applied" ||
        status === "conflicted") &&
      Array.isArray(value.sourceRefs) &&
      Array.isArray(value.baselines) &&
      isRecord(value.payload) &&
      typeof value.revision === "number" &&
      Number.isInteger(value.revision) &&
      value.revision >= 0 &&
      typeof value.createdAt === "string" &&
      typeof value.updatedAt === "string" &&
      (value.payloadDigest === undefined || typeof value.payloadDigest === "string")
    )
  ) {
    return false;
  }
  /*
   * type、payload.kind 与 sourceRefs 必须相互匹配；organize_captures 载荷
   * 在存储边界做完整结构校验（读取持久化数据时不只信任 TypeScript）。
   * organize_page 载荷保持 P1/P2 既有浅校验（载荷合法性在预览/应用边界把关）。
   */
  const payloadKind = (value.payload as { kind?: unknown }).kind;
  if (payloadKind !== value.type) return false;
  if (value.type === "organize_captures") {
    if (validateOrganizeCapturesPayload(value.payload).length > 0) return false;
    const sources = (value.payload as OrganizeCapturesPayload).sources;
    const refs = value.sourceRefs as AiSourceRef[];
    if (refs.length !== sources.length) return false;
    return sources.every((source, index) => {
      const ref = refs[index];
      return (
        ref &&
        ref.kind === "capture_message" &&
        ref.id === source.messageId &&
        typeof ref.sourceDigest === "string" &&
        ref.sourceDigest.length > 0
      );
    });
  }
  /*
   * P4：只读分析载荷在存储边界做完整校验（结构 + 引用必须属于该建议的冻结来源）。
   * 这样“范围外引用”不可能只靠写入方自觉，读取旧记录时也会被拒绝。
   */
  if (value.type === "analyze_notebook") {
    const refs = value.sourceRefs as AiSourceRef[];
    if (
      refs.length === 0 ||
      !refs.every(
        (ref) =>
          ref &&
          ref.kind === "page" &&
          typeof ref.id === "string" &&
          ref.id.length > 0 &&
          typeof ref.sourceDigest === "string" &&
          ref.sourceDigest.length > 0
      )
    ) {
      return false;
    }
    return validateAnalyzeNotebookPayload(value.payload, refs).length === 0;
  }
  /*
   * P8：只读分组提案的同一套存储边界校验——来源必须是 page 引用（带摘要），
   * 结果必须恰好覆盖这些来源。读取旧记录时同样会被拒绝，不只靠写入方自觉。
   */
  if (value.type === "organize_collection") {
    const refs = value.sourceRefs as AiSourceRef[];
    if (
      refs.length === 0 ||
      !refs.every(
        (ref) =>
          ref &&
          ref.kind === "page" &&
          typeof ref.id === "string" &&
          ref.id.length > 0 &&
          typeof ref.sourceDigest === "string" &&
          ref.sourceDigest.length > 0
      )
    ) {
      return false;
    }
    return validateOrganizeCollectionPayload(value.payload, refs).length === 0;
  }
  return true;
}

export function isAiPageMetadata(value: unknown): value is AiPageMetadata {
  if (!isRecord(value)) return false;
  return (
    typeof value.pageId === "string" &&
    value.pageId.length > 0 &&
    typeof value.sourceDigest === "string" &&
    typeof value.model === "string" &&
    typeof value.promptId === "string" &&
    typeof value.promptVersion === "number" &&
    Number.isInteger(value.promptVersion) &&
    typeof value.generatedAt === "string" &&
    (value.summary === undefined || typeof value.summary === "string") &&
    (value.topics === undefined || isStringArray(value.topics))
  );
}

function assertGuard(
  collection: "task" | "proposal",
  id: string,
  existing: { status?: string; revision?: number } | null,
  guard: AiWriteGuard | undefined,
  /**
   * R5：有条件写入必须命中**已存在的记录**且 revision 完全一致。
   * 否则“检查之后记录被清空/删除”会让 CAS 静默变成新建（复活已失效的任务）。
   */
  admissionRequired = false
): void {
  if (!guard) return;
  if (admissionRequired && (existing === null || guard.expectedRevision === undefined)) {
    throw new StaleAiWriteError(
      collection,
      id,
      { status: guard.expectedStatus, revision: guard.expectedRevision },
      existing ?? null
    );
  }
  if (guard.expectedStatus !== undefined && existing?.status !== guard.expectedStatus) {
    throw new StaleAiWriteError(
      collection,
      id,
      { status: guard.expectedStatus, revision: guard.expectedRevision },
      existing ?? null
    );
  }
  if (guard.expectedRevision !== undefined && existing?.revision !== guard.expectedRevision) {
    throw new StaleAiWriteError(
      collection,
      id,
      { status: guard.expectedStatus, revision: guard.expectedRevision },
      existing ?? null
    );
  }
}

/**
 * 已应用的收据不可改写：业务已提交、AI 状态更新失败的恢复路径依赖这条记录。
 * 只要已落库状态是 `applied`，就不允许换载荷/摘要（即使新状态也是 applied）。
 */
export function assertAppliedProposalImmutable(
  existing: AiProposal | null,
  next: AiProposal
): void {
  if (!existing || existing.status !== "applied") return;
  // 已落库的 applied 记录其载荷必须原样保留：换载荷（即使状态仍写 applied）
  // 会让收据恢复失去判定依据。
  const existingDigest = existing.payloadDigest ?? payloadDigest(existing.payload);
  const nextDigest = next.payloadDigest ?? payloadDigest(next.payload);
  const payloadChanged = existingDigest !== nextDigest;
  // 载荷被改写，或被降级为未应用状态：两者都会毁掉恢复证据，一律拒绝。
  if (payloadChanged || next.status !== "applied") {
    throw new StaleAiWriteError(
      "proposal",
      next.id,
      { status: existing.status },
      { status: next.status }
    );
  }
}

/** 终态保护：已处于终态的任务不允许再被写回非终态（迟到回调）。 */
export function assertNoTerminalDowngrade(existing: AiTask | null, next: AiTask): void {
  if (!existing || !isAiTaskTerminal(existing.status)) return;
  if (isAiTaskTerminal(next.status)) return;
  throw new StaleAiWriteError(
    "task",
    next.id,
    { status: existing.status, revision: existing.revision },
    { status: next.status, revision: next.revision }
  );
}

// —— IndexedDB 实现 ——

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("INDEXEDDB_REQUEST_FAILED"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("INDEXEDDB_TX_FAILED"));
    transaction.onabort = () => reject(transaction.error ?? new Error("INDEXEDDB_TX_ABORTED"));
  });
}

/** 库名段清洗：账号标识只保留安全字符，防止会话字段污染库名。 */
function sanitizeDbSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64) || "unknown";
}

function openAiDatabase(factory: IDBFactory, dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(dbName, AI_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(AI_TASK_STORE)) {
        database.createObjectStore(AI_TASK_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(AI_PROPOSAL_STORE)) {
        database.createObjectStore(AI_PROPOSAL_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(AI_METADATA_STORE)) {
        database.createObjectStore(AI_METADATA_STORE, { keyPath: "pageId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("INDEXEDDB_OPEN_FAILED"));
  });
}

/**
 * T2a：按账号命名空间派生库名——同一浏览器上不同账号（serverId/userId）各自独立
 * 的 IDB，旧档案不自动继承。未提供 namespace 时沿用旧单用户库名（既有测试与旧路径）。
 */
export function createIndexedDbAiRepository(
  factory?: IDBFactory,
  namespace?: { serverId: string; userId: string }
): AiRepository {
  const dbName = namespace
    ? `${AI_DB_NAME}--s-${sanitizeDbSegment(namespace.serverId)}-u-${sanitizeDbSegment(namespace.userId)}`
    : AI_DB_NAME;
  let databasePromise: Promise<IDBDatabase> | undefined;

  function getDatabase(): Promise<IDBDatabase> {
    const resolved = factory ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);
    if (!resolved) return Promise.reject(new Error("INDEXEDDB_UNAVAILABLE"));
    databasePromise ??= openAiDatabase(resolved, dbName);
    return databasePromise;
  }

  async function readOne<T>(store: string, key: string): Promise<T | null> {
    const database = await getDatabase();
    const transaction = database.transaction(store, "readonly");
    const record = await requestToPromise<unknown>(transaction.objectStore(store).get(key));
    await transactionDone(transaction);
    return (record as T | undefined) ?? null;
  }

  async function readAll<T>(store: string): Promise<T[]> {
    const database = await getDatabase();
    const transaction = database.transaction(store, "readonly");
    const records = await requestToPromise<unknown[]>(transaction.objectStore(store).getAll());
    await transactionDone(transaction);
    return records as T[];
  }

  return {
    async saveTask(task, guard) {
      const database = await getDatabase();
      // 读写同一事务：并发写入时后写者看到前者结果，不会静默覆盖。
      const transaction = database.transaction(AI_TASK_STORE, "readwrite");
      const store = transaction.objectStore(AI_TASK_STORE);
      const existing = (await requestToPromise<unknown>(store.get(task.id))) ?? null;
      const current = isAiTask(existing) ? existing : null;
      try {
        assertGuard("task", task.id, current, guard, guard?.expectedRevision !== undefined);
        assertNoTerminalDowngrade(current, task);
      } catch (error) {
        transaction.abort();
        throw error;
      }
      await requestToPromise(store.put(task));
      await transactionDone(transaction);
    },

    async getTask(id) {
      const record = await readOne<unknown>(AI_TASK_STORE, id);
      return isAiTask(record) ? record : null;
    },

    async listTasks() {
      return (await readAll<unknown>(AI_TASK_STORE)).filter(isAiTask);
    },

    async listProposals() {
      return (await readAll<unknown>(AI_PROPOSAL_STORE)).filter(isAiProposal);
    },

    async authorizeCommit({ proposalId, expectedRevision }) {
      const database = await getDatabase();
      /*
       * F2 提交屏障：在同一个 readwrite 事务内把 accepted → accepting。
       * 这一次原子条件写既是“最后授权核对”，也是撤回的互斥点。
       */
      const transaction = database.transaction([AI_TASK_STORE, AI_PROPOSAL_STORE], "readwrite");
      const store = transaction.objectStore(AI_PROPOSAL_STORE);
      const existing = (await requestToPromise<unknown>(store.get(proposalId))) ?? null;
      const current = isAiProposal(existing) ? existing : null;
      if (current === null) {
        transaction.abort();
        throw new StaleAiWriteError("proposal", proposalId, { revision: expectedRevision }, null);
      }
      if (current.revision !== expectedRevision) {
        transaction.abort();
        return { ok: false as const, status: current.status };
      }
      const taskRecord = await requestToPromise<unknown>(
        transaction.objectStore(AI_TASK_STORE).get(current.taskId)
      );
      if (
        !isAiTask(taskRecord) ||
        taskRecord.status !== "waiting_user" ||
        taskRecord.proposalId !== current.id
      ) {
        transaction.abort();
        return { ok: false as const, status: current.status };
      }
      if (current.status === "accepting") {
        // 已经占用（上次业务已提交、AI 状态未落的重试）：幂等返回当前占用，不重复 +1。
        transaction.abort();
        return { ok: true as const, proposal: current };
      }
      if (current.status !== "accepted") {
        transaction.abort();
        return { ok: false as const, status: current.status };
      }
      const accepting: AiProposal = {
        ...current,
        status: "accepting",
        revision: current.revision + 1
      };
      await requestToPromise(store.put(accepting));
      await transactionDone(transaction);
      return { ok: true as const, proposal: accepting };
    },

    async saveTaskWithProposal({ task, proposal, expectedRevision }) {
      const database = await getDatabase();
      /*
       * F4/F5：任务与建议在**同一个 readwrite 事务**内写入：
       * - 事务提交 = 两者都在；事务失败/清空竞争 = 两者都不在；
       * - 任务必须已存在且 revision 命中，缺失任务不能被迟到回调重建。
       */
      const transaction = database.transaction([AI_TASK_STORE, AI_PROPOSAL_STORE], "readwrite");
      try {
        const taskStore = transaction.objectStore(AI_TASK_STORE);
        const existing = (await requestToPromise<unknown>(taskStore.get(task.id))) ?? null;
        const current = isAiTask(existing) ? existing : null;
        if (current === null || current.revision !== expectedRevision) {
          throw new StaleAiWriteError(
            "task",
            task.id,
            { revision: expectedRevision },
            current ?? null
          );
        }
        assertNoTerminalDowngrade(current, task);
        await requestToPromise(taskStore.put(task));
        await requestToPromise(transaction.objectStore(AI_PROPOSAL_STORE).put(proposal));
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // 事务可能已自动中止；清理不能掩盖根因。
        }
        throw error;
      }
      await transactionDone(transaction);
    },

    async saveTaskWithMetadata({ task, metadata, expectedRevision }) {
      const database = await getDatabase();
      /*
       * R5：任务终态与 pageMetadata 在**同一个 readwrite 事务**内写入。
       * 事务提交 = 两者都在；失败/清空竞争 = 两者都不在，调用方据此如实报错。
       *
       * F2：与内存实现同一契约 —— 任何写入前先做记录级校验，
       * 非法 task/metadata 一律 AI_RECORD_INVALID（不能把损坏数据写进库）。
       */
      const transaction = database.transaction([AI_TASK_STORE, AI_METADATA_STORE], "readwrite");
      try {
        const taskStore = transaction.objectStore(AI_TASK_STORE);
        const existing = (await requestToPromise<unknown>(taskStore.get(task.id))) ?? null;
        const current = isAiTask(existing) ? existing : null;
        if (current === null || current.revision !== expectedRevision) {
          throw new StaleAiWriteError(
            "task",
            task.id,
            { revision: expectedRevision },
            current ?? null
          );
        }
        if (!isAiTask(task)) {
          throw new AiRecordInvalidError("task", String((task as { id?: unknown })?.id ?? ""));
        }
        if (!isAiPageMetadata(metadata)) {
          throw new AiRecordInvalidError("pageMetadata", String((metadata as { pageId?: unknown })?.pageId ?? ""));
        }
        assertNoTerminalDowngrade(current, task);
        await requestToPromise(taskStore.put(task));
        await requestToPromise(transaction.objectStore(AI_METADATA_STORE).put(metadata));
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // 事务可能已自动中止；清理不能掩盖根因。
        }
        throw error;
      }
      await transactionDone(transaction);
    },

    async saveProposal(proposal, guard) {      const database = await getDatabase();
      const transaction = database.transaction(AI_PROPOSAL_STORE, "readwrite");
      const store = transaction.objectStore(AI_PROPOSAL_STORE);
      const existing = (await requestToPromise<unknown>(store.get(proposal.id))) ?? null;
      const current = isAiProposal(existing) ? existing : null;
      try {
        assertGuard("proposal", proposal.id, current, guard, guard?.expectedRevision !== undefined);
        assertAppliedProposalImmutable(current, proposal);
      } catch (error) {
        transaction.abort();
        throw error;
      }
      await requestToPromise(store.put(proposal));
      await transactionDone(transaction);
    },

    async getProposal(id) {
      const record = await readOne<unknown>(AI_PROPOSAL_STORE, id);
      return isAiProposal(record) ? record : null;
    },

    async savePageMetadata(metadata) {
      const database = await getDatabase();
      const transaction = database.transaction(AI_METADATA_STORE, "readwrite");
      await requestToPromise(transaction.objectStore(AI_METADATA_STORE).put(metadata));
      await transactionDone(transaction);
    },

    async getPageMetadata(pageId) {
      const record = await readOne<unknown>(AI_METADATA_STORE, pageId);
      return isAiPageMetadata(record) ? record : null;
    },

    async listPageMetadata() {
      return (await readAll<unknown>(AI_METADATA_STORE)).filter(isAiPageMetadata);
    },

    async clear() {
      const database = await getDatabase();
      const transaction = database.transaction(
        [AI_TASK_STORE, AI_PROPOSAL_STORE, AI_METADATA_STORE],
        "readwrite"
      );
      await Promise.all([
        requestToPromise(transaction.objectStore(AI_TASK_STORE).clear()),
        requestToPromise(transaction.objectStore(AI_PROPOSAL_STORE).clear()),
        requestToPromise(transaction.objectStore(AI_METADATA_STORE).clear())
      ]);
      await transactionDone(transaction);
    }
  };
}

/** 内存实现：测试与非浏览器环境；语义与 IndexedDB 实现一致。 */
export function createMemoryAiRepository(): AiRepository {
  const tasks = new Map<string, AiTask>();
  const proposals = new Map<string, AiProposal>();
  const metadata = new Map<string, AiPageMetadata>();

  function guard(
    collection: "task" | "proposal",
    id: string,
    existing: { status?: string; revision?: number } | null,
    expected: AiWriteGuard | undefined
  ) {
    assertGuard(collection, id, existing, expected, expected?.expectedRevision !== undefined);
  }

  return {
    async saveTask(task, expected) {
      // 与 IndexedDB 实现同一语义：本实现不认识的记录不写入、也不读回。
      if (!isAiTask(task))
        throw new AiRecordInvalidError("task", String((task as { id?: unknown })?.id ?? ""));
      const current = tasks.get(task.id) ?? null;
      guard("task", task.id, current, expected);
      if (expected?.expectedRevision !== undefined && current === null) {
        // R5：有条件写入必须命中已存在记录；记录已被清空/删除时不能静默新建。
        throw new AiRecordInvalidError("task", task.id);
      }
      assertNoTerminalDowngrade(current, task);
      tasks.set(task.id, task);
    },
    async getTask(id) {
      return tasks.get(id) ?? null;
    },
    async listTasks() {
      return [...tasks.values()];
    },
    async listProposals() {
      return [...proposals.values()].filter(isAiProposal);
    },
    async authorizeCommit({ proposalId, expectedRevision }) {
      const current = proposals.get(proposalId) ?? null;
      if (!current) {
        throw new StaleAiWriteError("proposal", proposalId, { revision: expectedRevision }, null);
      }
      if (current.revision !== expectedRevision) return { ok: false, status: current.status };
      const task = tasks.get(current.taskId);
      if (!task || task.status !== "waiting_user" || task.proposalId !== current.id) {
        return { ok: false, status: current.status };
      }
      if (current.status === "accepting") return { ok: true, proposal: current };
      if (current.status !== "accepted") return { ok: false, status: current.status };
      const accepting: AiProposal = {
        ...current,
        status: "accepting",
        revision: current.revision + 1
      };
      proposals.set(proposalId, accepting);
      return { ok: true, proposal: accepting };
    },
    async saveTaskWithProposal({ task, proposal, expectedRevision }) {
      const current = tasks.get(task.id) ?? null;
      // 同一“事务”：先校验，全部通过后才写入 —— 失败不留任何副作用。
      if (current === null || current.revision !== expectedRevision) {
        throw new StaleAiWriteError("task", task.id, { revision: expectedRevision }, current);
      }
      if (!isAiTask(task)) {
        throw new AiRecordInvalidError("task", String((task as { id?: unknown })?.id ?? ""));
      }
      if (!isAiProposal(proposal)) {
        throw new AiRecordInvalidError(
          "proposal",
          String((proposal as { id?: unknown })?.id ?? "")
        );
      }
      assertNoTerminalDowngrade(current, task);
      assertAppliedProposalImmutable(proposals.get(proposal.id) ?? null, proposal);
      tasks.set(task.id, task);
      proposals.set(proposal.id, proposal);
    },
    async saveTaskWithMetadata({ task, metadata: nextMetadata, expectedRevision }) {
      const current = tasks.get(task.id) ?? null;
      // 同一“事务”：先校验，全部通过后才写入 —— 失败不留任何副作用。
      if (current === null || current.revision !== expectedRevision) {
        throw new StaleAiWriteError("task", task.id, { revision: expectedRevision }, current);
      }
      if (!isAiTask(task)) {
        throw new AiRecordInvalidError("task", String((task as { id?: unknown })?.id ?? ""));
      }
      if (!isAiPageMetadata(nextMetadata)) {
        throw new AiRecordInvalidError("pageMetadata", String((nextMetadata as { pageId?: unknown })?.pageId ?? ""));
      }
      assertNoTerminalDowngrade(current, task);
      tasks.set(task.id, task);
      metadata.set(nextMetadata.pageId, nextMetadata);
    },

    async saveProposal(proposal, expected) {
      if (!isAiProposal(proposal))
        throw new AiRecordInvalidError(
          "proposal",
          String((proposal as { id?: unknown })?.id ?? "")
        );
      const current = proposals.get(proposal.id) ?? null;
      guard("proposal", proposal.id, current, expected);
      assertAppliedProposalImmutable(current, proposal);
      proposals.set(proposal.id, proposal);
    },
    async getProposal(id) {
      return proposals.get(id) ?? null;
    },
    async savePageMetadata(next) {
      if (!isAiPageMetadata(next))
        throw new AiRecordInvalidError(
          "pageMetadata",
          String((next as { pageId?: unknown })?.pageId ?? "")
        );
      metadata.set(next.pageId, next);
    },
    async getPageMetadata(pageId) {
      return metadata.get(pageId) ?? null;
    },
    async listPageMetadata() {
      return [...metadata.values()];
    },
    async clear() {
      tasks.clear();
      proposals.clear();
      metadata.clear();
    }
  };
}

/**
 * 中断恢复：把遗留的 `accepting` 建议按业务收据是否存在收敛。
 * - 收据存在（业务已提交）→ 补记 applied；
 * - 收据不存在（提交未完成）→ 还原 accepted，等待用户显式重试。
 * 不做自动重放：恢复只对齐派生状态，不触发任何业务写入。
 */
export function recoverInterruptedCommits(
  proposals: readonly AiProposal[],
  receiptExists: (proposal: AiProposal) => boolean,
  now: () => Date = () => new Date()
): AiProposal[] {
  return proposals
    .filter((proposal) => proposal.status === "accepting")
    .map((proposal) =>
      receiptExists(proposal)
        ? {
            ...proposal,
            status: "applied" as const,
            revision: proposal.revision + 1,
            updatedAt: now().toISOString()
          }
        : {
            ...proposal,
            status: "accepted" as const,
            revision: proposal.revision + 1,
            updatedAt: now().toISOString()
          }
    );
}

/** 供任务构造使用的类型再导出，避免调用方从多个模块拼装。 */
export type {
  AiTask,
  AiTaskStatus,
  AiTaskType,
  AiProposal,
  AiProposalStatus,
  AiProposalType,
  ProposalPayload
};
