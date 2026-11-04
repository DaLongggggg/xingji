import { IMAGE_EDIT_METADATA, LOCAL_EDIT_ORIGIN } from "@/features/workbench/workbench-image-edit-contract";
/**
 * 工作台会话持久化（任务书 §3）：复用同一个 SQLite 文件，每会话一行 JSON。
 *
 * 边界：
 * - 只保存白名单字段；函数、AbortSignal、API 密钥/凭据、Memory 快照一律拒绝；
 * - 每会话独立 revision（改 A 不会让 B 冲突）；列表只读摘要字段，不加载大 payload；
 * - 上限：单会话 payload 510 MiB（UTF-8 字节）与 1000 条消息，超限明确失败且不动库；
 * - 删除会话只删该会话与消息，**保留 Memory 条目**。
 */
import { DatabaseSync } from "node:sqlite";
import { isImageStyle } from "@/features/creation/creation-image-rules";
import { IMAGE_LIMITS } from "@/features/creation/creation-image-limits";
import { NATIVE_SEARCH_RESULT } from "@/features/ai/native-search-contract";
import { attemptClaimsFromPayload, clearTransferredArtifacts, deleteSessionAttempts, digestImageDataUrl, reservedBytesForSession } from "./image-execution-store";
import { inTransaction, resolveDatabasePath, withDatabase as sharedWithDatabase } from "./sqlite-db";
import { currentScopeEnv } from "./user-scope.ts";

export const SESSION_LIMITS = {
  /** 单会话 payload 上限（UTF-8 字节）。 */
  // 当前九张各 20MiB 的附件/请求快照双份约 480MiB，加单张结果预留约 27.67MiB。
  // 信封再留 1MiB，仍低于当前 Node 的约 512MiB 字符串长度边界；不改变存储形式。
  maxPayloadBytes: 510 * 1024 * 1024,
  /** 单会话消息条数上限。 */
  maxMessages: 1_000,
  maxTitleChars: 120
};

export type WorkbenchSessionPayload = {
  scope: { kind: string; notebookId?: string; notebookTitle?: string; noteId?: string; noteTitle?: string };
  textModelId?: string;
  imageModelId?: string;
  renamed: boolean;
  messages: Record<string, unknown>[];
};

export type WorkbenchSessionSummary = {
  id: string;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  renamed: boolean;
  messageCount: number;
};

export type WorkbenchSessionRecord = WorkbenchSessionSummary & { payload: WorkbenchSessionPayload };

export type SessionStoreErrorCode =
  | "SESSION_VERSION_REQUIRED"
  | "SESSION_CONFLICT"
  | "SESSION_BUSY"
  | "SESSION_INVALID"
  | "SESSION_TOO_LARGE"
  | "SESSION_NOT_FOUND"
  | "SESSION_EXISTS"
  | "SESSION_UNAVAILABLE";

export class SessionStoreError extends Error {
  constructor(readonly code: SessionStoreErrorCode, readonly detail: string) {
    super(detail);
    this.name = "SessionStoreError";
  }
}

export function sessionErrorDetail(code: SessionStoreErrorCode): string {
  switch (code) {
    case "SESSION_VERSION_REQUIRED":
      return "缺少会话版本，请先读取当前会话再提交。";
    case "SESSION_CONFLICT":
      return "会话已在别处更新，本次未保存；请重新读取后比较。";
    case "SESSION_BUSY":
      return "存储正忙，请稍后重试。";
    case "SESSION_INVALID":
      return "会话内容不符合要求，本次未保存。";
    case "SESSION_TOO_LARGE":
      return "会话超过大小上限，本次未保存；可另建会话继续。";
    case "SESSION_NOT_FOUND":
      return "会话不存在或已删除。";
    case "SESSION_EXISTS":
      return "该会话 ID 已存在，未覆盖原会话。";
    default:
      return "会话存储暂时不可用，未做任何修改。";
  }
}

function fail(code: SessionStoreErrorCode): never {
  throw new SessionStoreError(code, sessionErrorDetail(code));
}

/** 共享数据库入口 + 稳定错误映射。 */
function withDatabase<T>(dbPath: string | undefined, run: (database: DatabaseSync) => T): T {
  try {
    return sharedWithDatabase(dbPath ?? resolveDatabasePath(), run);
  } catch (error) {
    if (error instanceof SessionStoreError) throw error;
    return fail("SESSION_UNAVAILABLE");
  }
}

/**
 * SP7：**逐层结构化白名单**——只接受明确列出的字段与类型，
 * 未知字段/错误类型/超深嵌套一律整批拒绝（不依赖递归黑名单去猜凭据不会落库）。
 * 黑名单只作为额外的兜底检查（全部小写比较）。
 */
const FORBIDDEN_KEYS = new Set(["signal", "apikey", "api_key", "authorization", "authorized", "credential", "credentials", "memory", "token", "password", "secret"]);
const MAX_DEPTH = 12;

function assertClean(value: unknown, depth = 0): void {
  if (depth > MAX_DEPTH) fail("SESSION_INVALID");
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) assertClean(item, depth + 1);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) fail("SESSION_INVALID");
    assertClean(item, depth + 1);
  }
}

/** 标量/数组/对象的类型检查工具。 */
function isText(value: unknown): value is string {
  return typeof value === "string";
}

/** 实测时长：有限非负数；不接受字符串或负数（不做"看起来像"的容错）。 */
function isDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function pickObject(value: unknown, fields: Record<string, (input: unknown) => boolean>, depth = 0): Record<string, unknown> {
  if (depth > MAX_DEPTH) fail("SESSION_INVALID");
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("SESSION_INVALID");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!(key in fields)) fail("SESSION_INVALID");
  for (const [key, check] of Object.entries(fields)) {
    const item = record[key];
    if (item === undefined) continue;
    if (!check(item)) fail("SESSION_INVALID");
  }
  return record;
}

const referenceFields: Record<string, (input: unknown) => boolean> = {
  id: isText,
  kind: isText,
  title: isText,
  text: isText,
  updatedAt: isText
};
const attachmentFields: Record<string, (input: unknown) => boolean> = { id: isText, name: isText, dataUrl: isText, edit: value => IMAGE_EDIT_METADATA.safeParse(value).success };
const resultFields: Record<string, (input: unknown) => boolean> = {
  id: isText,
  kind: isText,
  title: isText,
  body: isText,
  caption: isText,
  from: isText,
  to: isText,
  dataUrl: isText,
  subtitle: isText,
  demo: input => typeof input === "boolean",
  blocks: input => Array.isArray(input) && input.every(block => {
    pickObject(block, { heading: isText, body: isText });
    return true;
  })
};
const scopeFields: Record<string, (input: unknown) => boolean> = {
  kind: isText,
  notebookId: isText,
  notebookTitle: isText,
  noteId: isText,
  noteTitle: isText
};
const skillReferencesField = (input: unknown): boolean => {
  if (!Array.isArray(input) || input.length > 9) return false;
  for (const ref of input) {
    const picked = pickObject(ref, {
      id: value => isText(value) && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value),
      name: value => isText(value) && value.trim().length > 0 && value.length <= 200
    });
    if (picked.id === undefined || picked.name === undefined) return false;
  }
  return new Set(input.map(ref => ref.id)).size === input.length;
};
const imageAdviceField = (input: unknown): boolean => {
  const picked = pickObject(input, { items: value => {
    if (!Array.isArray(value) || !value.length || value.length > 9) return false;
    for (const item of value) {
      const picked = pickObject(item, {
        sourceId: value => isText(value) && value.trim().length > 0 && value.length <= 120,
        sourceDigest: value => isText(value) && /^[a-f0-9]{64}$/.test(value),
        instruction: value => isText(value) && value.trim().length > 0 && value.length <= IMAGE_LIMITS.maxPromptChars
      });
      if (picked.sourceId === undefined || picked.sourceDigest === undefined || picked.instruction === undefined) return false;
    }
    return new Set(value.map(item => item.sourceId)).size === value.length;
  } });
  return picked.items !== undefined;
};
const requestFields: Record<string, (input: unknown) => boolean> = {
  skillReferences: skillReferencesField,
  text: isText,
  intent: isText,
  context: isText,
  scope: input => {
    pickObject(input, scopeFields);
    return true;
  },
  references: input => {
    if (!Array.isArray(input)) return false;
    for (const item of input) pickObject(item, referenceFields);
    return true;
  },
  attachments: input => {
    if (!Array.isArray(input)) return false;
    for (const item of input) pickObject(item, attachmentFields);
    return true;
  },
  history: input => {
    if (!Array.isArray(input)) return false;
    for (const item of input) pickObject(item, { role: isText, id: isText, text: isText,
      imageSourceIds: value => Array.isArray(value) && value.length <= 64 && value.every(id => isText(id) && id.length <= 120),
      imageAdvice: imageAdviceField });
    return true;
  },
  targetResult: input => {
    pickObject(input, resultFields);
    return true;
  },
  imageOptions: input => {
    const options = pickObject(input, {
      modelId: value => isText(value) && value.trim().length > 0 && value.length <= 200,
      size: value => isText(value) && /^\d+x\d+$/.test(value) && value.length <= 20,
      // 已知 id 即可（含已从选择器下线的旧 id）：老会话重存不能因为风格被改名而失败。
      style: value => isImageStyle(value),
      outputFormat: value => value === "png" || value === "jpeg",
      requested: value => value === true
    });
    return typeof options.modelId === "string" && options.modelId.trim().length > 0;
  },
  images: input => Array.isArray(input) && input.every(isText)
};

/** R1（C1.8）：服务端白名单与会话序列化**同步**支持计划与尝试投影；缺字段拒绝，不悄悄丢弃。 */
const planSourcesFields: Record<string, (input: unknown) => boolean> = {
  sourceId: value => isText(value) && value.length > 0 && value.length <= 200,
  attachmentId: value => isText(value) && value.length > 0 && value.length <= 200,
  originalOrder: value => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 99,
  name: isText,
  sourceDigest: value => isText(value) && /^[0-9a-f]{64}$/.test(value)
};
const planItemFields: Record<string, (input: unknown) => boolean> = {
  itemId: value => isText(value) && value.length > 0 && value.length <= 120,
  sourceIds: input => Array.isArray(input) && input.length <= 9 && input.every(id => isText(id) && id.length > 0 && id.length <= 200),
  instruction: value => isText(value) && value.length > 0 && value.length <= IMAGE_LIMITS.maxPromptChars
};
const planConfigFields: Record<string, (input: unknown) => boolean> = {
  textConfigId: value => isText(value) && value.length > 0 && value.length <= 200,
  imageConfigId: value => isText(value) && value.length > 0 && value.length <= 200,
  configDigest: value => isText(value) && /^[0-9a-f]{64}$/.test(value),
  size: value => isText(value) && /^\d+x\d+$/.test(value) && value.length <= 20,
  style: value => isImageStyle(value),
  outputFormat: value => value === "png" || value === "jpeg",
  // R4：计划冻结的资源选择（字符串数组，最多 9 项）。
  skillIds: input => Array.isArray(input) && input.length <= 9 && input.every(id => isText(id) && (id as string).length <= 200)
};
const imagePlanFields: Record<string, (input: unknown) => boolean> = {
  version: value => value === 1,
  executionId: value => isText(value) && value.length > 0 && value.length <= 120,
  originalRequest: value => isText(value) && value.length > 0 && value.length <= IMAGE_LIMITS.maxPromptChars,
  mode: value => value === "edit" || value === "generate",
  sources: input => Array.isArray(input) && input.length <= 9 &&
    input.every(source => {
      pickObject(source, planSourcesFields);
      return true;
    }),
  items: input => Array.isArray(input) && input.length > 0 && input.length <= 9 &&
    input.every(item => {
      pickObject(item, planItemFields);
      return true;
    }),
  config: input => {
    pickObject(input, planConfigFields);
    return typeof (input as Record<string, unknown>).configDigest === "string";
  }
};
const attemptProjectionFields: Record<string, (input: unknown) => boolean> = {
  attemptId: value => isText(value) && value.length > 0 && value.length <= 120,
  itemId: value => isText(value) && value.length > 0 && value.length <= 120,
  attemptNo: value => typeof value === "number" && Number.isInteger(value) && value >= 1,
  previousAttemptId: value => isText(value) && value.length > 0 && value.length <= 120,
  status: value => ["prepared", "dispatched", "succeeded", "failed", "outcome_unknown"].includes(String(value)),
  errorCode: value => isText(value) && value.length <= 100,
  artifactId: value => isText(value) && value.length > 0 && value.length <= 200,
  artifactDigest: value => isText(value) && /^[0-9a-f]{64}$/.test(value),
  skillVersion: value => isText(value) && value.length <= 100,
  /** 阶段B：本项设计实际采用的资源摘要（id ≤200 + 64 位摘要；≤9 条；可选 files 文件身份）。 */
  skillResources: input => Array.isArray(input) && input.length >= 1 && input.length <= 9
    && input.every(entry => {
      if (typeof entry !== "object" || entry === null) return false;
      const record = entry as Record<string, unknown>;
      const keys = Object.keys(record);
      if (!(isText(record.id) && (record.id as string).length <= 200
        && typeof record.digest === "string" && /^[0-9a-f]{64}$/.test(record.digest))) return false;
      if (keys.length === 2) return true;
      if (keys.length !== 3 || record.files === undefined) return false;
      return Array.isArray(record.files) && (record.files as unknown[]).length >= 1 && (record.files as unknown[]).length <= 12
        && (record.files as unknown[]).every(file => {
          if (typeof file !== "object" || file === null) return false;
          const f = file as Record<string, unknown>;
          return Object.keys(f).length === 2
            && isText(f.path) && (f.path as string).length <= 200
            && typeof f.digest === "string" && /^[0-9a-f]{64}$/.test(f.digest);
        });
    }),
  delivered: value => value === true,
  promptSnapshot: input => {
    pickObject(input, {
      prompt: value => isText(value) && value.length > 0 && value.length <= IMAGE_LIMITS.maxPromptChars,
      size: value => isText(value) && /^\d+x\d+$/.test(value) && value.length <= 20,
      quality: value => value === "low" || value === "medium" || value === "high",
      outputFormat: value => value === "png" || value === "jpeg",
      sourceDigests: input2 => Array.isArray(input2) && input2.every(digest => isText(digest) && /^[0-9a-f]{64}$/.test(digest)) && input2.length <= 9,
      configDigest: value => isText(value) && /^[0-9a-f]{64}$/.test(value),
      /**
       * 修图源图出站的转换记录（2026-10-07 来源链路）：与 sourceDigests 同序的可选条目，
       * 只允许两种原因与真实图片 MIME；index 必须落在来源数组范围内；展平背景只认显式白字。
       */
      sourceTransforms: input2 => Array.isArray(input2) && input2.length >= 1 && input2.length <= 9
        && input2.every(entry => {
          if (typeof entry !== "object" || entry === null) return false;
          const record = entry as Record<string, unknown>;
          const keys = Object.keys(record);
          if (!(Number.isInteger(record.index) && (record.index as number) >= 0 && (record.index as number) <= 8)) return false;
          if (!(record.reason === "byte-budget" || record.reason === "alpha-flatten")) return false;
          if (!(record.mime === "image/png" || record.mime === "image/jpeg" || record.mime === "image/webp")) return false;
          if (!Number.isInteger(record.width) || (record.width as number) < 1 || (record.width as number) > 12_000) return false;
          if (!Number.isInteger(record.height) || (record.height as number) < 1 || (record.height as number) > 12_000) return false;
          // 展平必须声明显式白字背景；普通降档不得携带 background。
          return record.reason === "alpha-flatten"
            ? keys.length === 6 && record.background === "#FFFFFF"
            : keys.length === 5;
        })
    });
    return true;
  }
};
function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isMessageBlocks(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  let previous = 0;
  const ids = new Set<string>();
  const references = new Set<string>();
  for (const block of input) {
    if (!block || typeof block !== "object" || Array.isArray(block)) return false;
    const type = block.type;
    const extra: Record<string, (value: unknown) => boolean> = type === "trace" ? { text: isText }
      : type === "text" || type === "reasoning" ? { text: isText, endSequence: isSequence }
      : type === "tool" ? { toolId: isText }
      : type === "call" ? { callId: isText }
      : type === "result" ? { resultId: isText }
      : type === "images" ? { attachmentIds: value => Array.isArray(value) && value.length > 0 && value.every(isText) }
      : {};
    if (!Object.keys(extra).length) return false;
    const picked = pickObject(block, { id: isText, sequence: isSequence, type: value => value === type, ...extra,
      ...(type === "text" ? { phase: (value: unknown) => value === "work" || value === "answer" } : {}) });
    if (!isText(picked.id) || !picked.id || ids.has(picked.id) || !isSequence(picked.sequence) || picked.sequence <= previous
      || Object.keys(extra).some(field => picked[field] === undefined)) return false;
    if ((type === "text" || type === "reasoning") && (!isSequence(picked.endSequence) || picked.endSequence < picked.sequence)) return false;
    const reference = type === "tool" ? `tool:${picked.toolId}` : type === "call" ? `call:${picked.callId}` : undefined;
    if (reference && references.has(reference)) return false;
    if (reference) references.add(reference);
    ids.add(picked.id);
    previous = Number(picked.endSequence ?? picked.sequence);
  }
  return true;
}

const messageFields: Record<string, (input: unknown) => boolean> = {
  blocks: isMessageBlocks,
  eventSequence: isSequence,
  process: input => {
    const process = pickObject(input, {
      startedAt: isDuration,
      phase: value => value === "working" || value === "answering" || value === "waiting",
      elapsedMs: isDuration,
      endedAt: isDuration,
      outcome: value => ["stop", "limit", "cancelled", "timeout", "error", "interrupted"].includes(String(value)),
      waitingLabel: value => isText(value) && value.length <= 500
    });
    return isDuration(process.startedAt) && isDuration(process.elapsedMs) && process.phase !== undefined
      && (process.endedAt === undefined || Number(process.endedAt) >= process.startedAt)
      && (process.endedAt === undefined || process.outcome !== undefined)
      && (process.outcome === undefined || process.outcome === "interrupted" || process.endedAt !== undefined)
      && (process.waitingLabel === undefined || process.phase === "waiting" && process.outcome === undefined);
  },
  skillReferences: skillReferencesField,
  imageAdvice: imageAdviceField,
  id: isText,
  role: input => input === "user" || input === "assistant",
  text: isText,
  createdAt: isText,
  status: input => ["pending", "failed", "done"].includes(String(input)),
  error: isText,
  saveFailed: input => typeof input === "boolean",
  intent: isText,
  reasoning: isText,
  localEdit: input => LOCAL_EDIT_ORIGIN.safeParse(input).success,
  tools: input => {
    if (!Array.isArray(input)) return false;
    for (const item of input) {
      const tool = pickObject(item, {
        id: isText,
        name: isText,
        title: isText,
        argsDigest: isText,
        ok: value => typeof value === "boolean",
        cancelled: value => value === true,
        summary: isText,
        truncated: value => value === true,
        ms: isDuration,
        search: value => {
          const result = NATIVE_SEARCH_RESULT.safeParse(value);
          return result.success && result.data.sources.length > 0;
        }
      });
      if (tool.search !== undefined && (tool.name !== "web_search" || tool.ok !== true || tool.cancelled === true)) fail("SESSION_INVALID");
    }
    return true;
  },
  traces: input => Array.isArray(input) && input.every(isText),
  references: requestFields.references,
  attachments: requestFields.attachments,
  request: input => {
    pickObject(input, requestFields);
    return true;
  },
  result: input => {
    pickObject(input, resultFields);
    return true;
  },
  imagePlan: input => {
    const plan = pickObject(input, imagePlanFields);
    const sources = plan.sources as { sourceId: string }[];
    const items = plan.items as { sourceIds: string[] }[];
    if (!Array.isArray(sources) || !Array.isArray(items) || !["edit", "generate"].includes(String(plan.mode))) return false;
    const sourceIds = new Set(sources.map(source => source.sourceId));
    // 文生图可没有参考图；修图仍要求每项恰好绑定一张已保存的原图。
    return items.every(item => Array.isArray(item.sourceIds)
      && (plan.mode !== "edit" || item.sourceIds.length === 1)
      && item.sourceIds.every(id => sourceIds.has(id)));
  },
  imageAttempts: input => {
    if (!Array.isArray(input)) return false;
    if (input.length > 9 * 4) return false;
    for (const item of input) pickObject(item, attemptProjectionFields);
    return true;
  },
  calls: input => {
    if (!Array.isArray(input)) return false;
    if (input.length > 64) return false;
    for (const item of input) {
      pickObject(item, {
        callId: value => isText(value) && value.length > 0 && value.length <= 120,
        stage: value => isText(value) && ["search", "plan", "understand", "design", "image", "describe", "answer"].includes(String(value)),
        configId: value => isText(value) && value.length <= 200,
        model: value => isText(value) && value.trim().length > 0 && value.length <= 512,
        startedAt: value => typeof value === "number" && Number.isFinite(value),
        endedAt: value => typeof value === "number" && Number.isFinite(value),
        outcome: value => isText(value) && ["success", "error", "cancelled", "timeout"].includes(String(value)),
        usage: input2 => {
          if (input2 === undefined) return true;
          pickObject(input2 as unknown as Record<string, unknown>, {
            inputTokens: value => typeof value === "number" && Number.isInteger(value),
            outputTokens: value => typeof value === "number" && Number.isInteger(value)
          });
          return true;
        },
        estimate: input2 => {
          if (input2 === undefined) return true;
          pickObject(input2 as unknown as Record<string, unknown>, {
            textChars: value => typeof value === "number" && Number.isInteger(value) && value >= 0,
            serverTextChars: value => typeof value === "number" && Number.isInteger(value) && value >= 0
          });
          return true;
        },
        resources: input2 => {
          if (input2 === undefined) return true;
          if (!Array.isArray(input2) || input2.length > 9) return false;
          for (const entry of input2) {
            pickObject(entry as unknown as Record<string, unknown>, {
              id: value => isText(value) && value.length > 0 && value.length <= 200,
              version: value => isText(value) && value.length > 0 && value.length <= 100,
              digest: value => isText(value) && value.length <= 200
            });
          }
          return true;
        },
        executionId: value => isText(value) && value.length <= 120,
        itemId: value => isText(value) && value.length <= 120,
        attemptId: value => isText(value) && value.length <= 120
      });
    }
    return true;
  }
};

/** 白名单校验：只接受已知字段。 */
export function parsePayload(value: unknown): WorkbenchSessionPayload {
  assertClean(value);
  pickObject(value, {
    scope: requestFields.scope,
    textModelId: isText,
    imageModelId: isText,
    renamed: input => typeof input === "boolean",
    messages: input => {
      if (!Array.isArray(input)) fail("SESSION_INVALID");
      if (input.length > SESSION_LIMITS.maxMessages) fail("SESSION_TOO_LARGE");
      for (const message of input) {
        const picked = pickObject(message, messageFields);
        if (picked.blocks !== undefined) {
          const blocks = picked.blocks as Record<string, unknown>[];
          const end = blocks.reduce((max, block) => Math.max(max, Number(block.endSequence ?? block.sequence)), 0);
          if (!isSequence(picked.eventSequence) || picked.eventSequence < end) fail("SESSION_INVALID");
          const tools = new Set((picked.tools as { id: string }[] | undefined)?.map(tool => tool.id));
          const calls = new Set((picked.calls as { callId: string }[] | undefined)?.map(call => call.callId));
          const images = new Set((picked.attachments as { id: string }[] | undefined)?.map(image => image.id));
          if (blocks.some(block => block.type === "tool" ? !tools.has(String(block.toolId))
            : block.type === "call" ? !calls.has(String(block.callId))
            : block.type === "images" ? (block.attachmentIds as string[]).some(id => !images.has(id))
            : block.type === "result" ? block.resultId !== (picked.result as { id?: string } | undefined)?.id : false)) fail("SESSION_INVALID");
        }
      }
      return true;
    }
  });
  const record = value as Record<string, unknown>;
  const scope = record.scope as WorkbenchSessionPayload["scope"];
  if (!["free", "notebook", "note"].includes(String(scope.kind))) fail("SESSION_INVALID");
  if (scope.kind !== "free" && typeof scope.notebookId !== "string") fail("SESSION_INVALID");
  if (scope.kind === "note" && typeof scope.noteId !== "string") fail("SESSION_INVALID");
  return {
    scope,
    ...(typeof record.textModelId === "string" ? { textModelId: record.textModelId } : {}),
    ...(typeof record.imageModelId === "string" ? { imageModelId: record.imageModelId } : {}),
    renamed: record.renamed === true,
    messages: record.messages as Record<string, unknown>[]
  };
}

function payloadBytes(payload: WorkbenchSessionPayload): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

function rowToSummary(row: Record<string, unknown>): WorkbenchSessionSummary {
  return {
    id: String(row.id),
    title: String(row.title),
    revision: Number(row.revision),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    renamed: Number(row.renamed) === 1,
    messageCount: Number(row.messageCount)
  };
}

/** 列表：只读摘要字段，不加载 payloadJson。 */
export function listSessions(dbPath?: string): WorkbenchSessionSummary[] {
  return withDatabase(dbPath, (database) => {
    const rows = database
      .prepare("SELECT id, title, revision, createdAt, updatedAt, renamed, messageCount FROM workbench_sessions ORDER BY updatedAt DESC, id ASC")
      .all() as Record<string, unknown>[];
    return rows.map(rowToSummary);
  });
}

export function readSession(id: string, dbPath?: string): WorkbenchSessionRecord {
  return withDatabase(dbPath, (database) => {
    const row = database
      .prepare("SELECT id, title, revision, createdAt, updatedAt, renamed, messageCount, payloadJson FROM workbench_sessions WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return fail("SESSION_NOT_FOUND");
    return { ...rowToSummary(row), payload: parsePayload(JSON.parse(String(row.payloadJson))) };
  });
}

/** 创建：仅允许不存在的 ID；重复提交不能覆盖已有会话。 */
export function createSession(
  input: { id: string; title?: string; payload: unknown },
  dbPath?: string,
  now: () => Date = () => new Date()
): WorkbenchSessionRecord {
  if (typeof input.id !== "string" || !input.id.trim()) fail("SESSION_INVALID");
  const payload = parsePayload(input.payload);
  if (payloadBytes(payload) > SESSION_LIMITS.maxPayloadBytes) fail("SESSION_TOO_LARGE");
  const title = (input.title ?? "新会话").trim().slice(0, SESSION_LIMITS.maxTitleChars) || "新会话";
  const stamp = now().toISOString();
  return withDatabase(dbPath, (database) =>
    inTransaction(
      database,
      () => {
        const existing = database.prepare("SELECT id FROM workbench_sessions WHERE id = ?").get(input.id);
        if (existing) fail("SESSION_EXISTS");
        database
          .prepare(
            "INSERT INTO workbench_sessions (id, title, revision, createdAt, updatedAt, renamed, messageCount, payloadJson) VALUES (?, ?, 1, ?, ?, ?, ?, ?)"
          )
          .run(input.id, title, stamp, stamp, payload.renamed ? 1 : 0, payload.messages.length, JSON.stringify(payload));
        return {
          id: input.id,
          title,
          revision: 1,
          createdAt: stamp,
          updatedAt: stamp,
          renamed: payload.renamed,
          messageCount: payload.messages.length,
          payload
        };
      },
      (error, busy) => {
        if (error instanceof SessionStoreError) throw error;
        return fail(busy ? "SESSION_BUSY" : "SESSION_UNAVAILABLE");
      }
    )
  );
}

/** 更新：只更新已存在的会话；版本不符即冲突；不能复活已删除会话。 */
export function updateSession(
  input: { id: string; baseRevision?: number; title?: string; payload: unknown },
  dbPath?: string,
  now: () => Date = () => new Date()
): WorkbenchSessionRecord {
  if (!Number.isInteger(input.baseRevision) || (input.baseRevision ?? 0) < 1) fail("SESSION_VERSION_REQUIRED");
  const payload = parsePayload(input.payload);
  if (payloadBytes(payload) > SESSION_LIMITS.maxPayloadBytes) fail("SESSION_TOO_LARGE");
  const title = input.title === undefined ? undefined : input.title.trim().slice(0, SESSION_LIMITS.maxTitleChars) || "新会话";
  const stamp = now().toISOString();
  return withDatabase(dbPath, (database) =>
    inTransaction(
      database,
      () => {
        const row = database
          .prepare("SELECT id, title, revision, createdAt, renamed FROM workbench_sessions WHERE id = ?")
          .get(input.id) as Record<string, unknown> | undefined;
        if (!row) return fail("SESSION_NOT_FOUND");
        if (Number(row.revision) !== input.baseRevision) fail("SESSION_CONFLICT");
        // 手动命名后不再被第一条消息标题覆盖：payload.renamed 一旦为真就保持。
        const renamed = payload.renamed || Number(row.renamed) === 1;
        const nextTitle = title ?? String(row.title);
        const nextRevision = Number(row.revision) + 1;
        database
          .prepare("UPDATE workbench_sessions SET title = ?, revision = ?, updatedAt = ?, renamed = ?, messageCount = ?, payloadJson = ? WHERE id = ?")
          .run(nextTitle, nextRevision, stamp, renamed ? 1 : 0, payload.messages.length, JSON.stringify(payload), input.id);
        /*
         * R1：同一事务内核对**已转存**产物并清除尝试表的临时图片字节（§4.2.6）。
         * 核对按最终 payload（刚写入的附件）进行，摘要不一致就不清理——
         * 不把转存误算成新增两份图片，也不放行未核实的清除。
         */
        try {
          clearTransferredArtifacts(database, input.id, attemptClaimsFromPayload(payload.messages), digestImageDataUrl, stamp);
        } catch {
          // 清理失败不影响会话保存本身；临时结果保留，等待下次已核实转存。
        }
        /*
         * 容量按**事务最终状态**计算（§4.2）：最终 payload + 未转存结果 + 在途预留合计
         * 不得越过上限——出站期间其他写入不能挤占已承诺给图片请求的空间。
         * 超限整批回滚（本次会话更新与转存清理一并撤销），尝试表登记不受影响。
         */
        if (Buffer.byteLength(JSON.stringify(payload), "utf8") + reservedBytesForSession(database, input.id) > SESSION_LIMITS.maxPayloadBytes) {
          fail("SESSION_TOO_LARGE");
        }
        return {
          id: input.id,
          title: nextTitle,
          revision: nextRevision,
          createdAt: String(row.createdAt),
          updatedAt: stamp,
          renamed,
          messageCount: payload.messages.length,
          payload
        };
      },
      (error, busy) => {
        if (error instanceof SessionStoreError) throw error;
        return fail(busy ? "SESSION_BUSY" : "SESSION_UNAVAILABLE");
      }
    )
  );
}

/** 删除：事务内删除会话并清除指向它的 activeSessionId；Memory 条目不动。 */
export function deleteSession(
  input: { id: string; baseRevision?: number },
  dbPath?: string
): { id: string; preference: WorkbenchPreference } {
  if (!Number.isInteger(input.baseRevision) || (input.baseRevision ?? 0) < 1) fail("SESSION_VERSION_REQUIRED");
  return withDatabase(dbPath, (database) =>
    inTransaction(
      database,
      () => {
        const row = database.prepare("SELECT revision FROM workbench_sessions WHERE id = ?").get(input.id) as
          | { revision?: number }
          | undefined;
        if (!row) return fail("SESSION_NOT_FOUND");
        if (Number(row.revision) !== input.baseRevision) fail("SESSION_CONFLICT");
        database.prepare("DELETE FROM workbench_sessions WHERE id = ?").run(input.id);
        // R1：同一事务删除关联的制图尝试——晚到响应不能再更新或复活任何记录。
        deleteSessionAttempts(database, input.id);
        const settings = database.prepare("SELECT activeSessionId, revision FROM workbench_settings WHERE id = 1").get() as {
          activeSessionId?: string | null;
          revision?: number;
        };
        let preferenceRevision = Number(settings?.revision ?? 1);
        if (settings?.activeSessionId === input.id) {
          preferenceRevision += 1;
          database.prepare("UPDATE workbench_settings SET activeSessionId = NULL, revision = ? WHERE id = 1").run(preferenceRevision);
        }
        return {
          id: input.id,
          preference: { revision: preferenceRevision, activeSessionId: undefined }
        };
      },
      (error, busy) => {
        if (error instanceof SessionStoreError) throw error;
        return fail(busy ? "SESSION_BUSY" : "SESSION_UNAVAILABLE");
      }
    )
  );
}

export type WorkbenchPreference = { revision: number; activeSessionId?: string };

export function readPreference(dbPath?: string): WorkbenchPreference {
  return withDatabase(dbPath, (database) => {
    const row = database.prepare("SELECT activeSessionId, revision FROM workbench_settings WHERE id = 1").get() as
      | { activeSessionId?: string | null; revision?: number }
      | undefined;
    return {
      revision: Number(row?.revision ?? 1),
      ...(typeof row?.activeSessionId === "string" && row.activeSessionId ? { activeSessionId: row.activeSessionId } : {})
    };
  });
}

/** 偏好独立做 revision 比较；activeSessionId 必须存在或为空。 */
export function writePreference(
  input: { baseRevision?: number; activeSessionId?: string | null },
  dbPath?: string
): WorkbenchPreference {
  if (!Number.isInteger(input.baseRevision) || (input.baseRevision ?? 0) < 1) fail("SESSION_VERSION_REQUIRED");
  if (input.activeSessionId !== undefined && input.activeSessionId !== null && typeof input.activeSessionId !== "string") {
    fail("SESSION_INVALID");
  }
  return withDatabase(dbPath, (database) =>
    inTransaction(
      database,
      () => {
        const row = database.prepare("SELECT activeSessionId, revision FROM workbench_settings WHERE id = 1").get() as {
          activeSessionId?: string | null;
          revision?: number;
        };
        if (Number(row?.revision ?? 1) !== input.baseRevision) fail("SESSION_CONFLICT");
        const next = input.activeSessionId === undefined ? (row?.activeSessionId ?? null) : input.activeSessionId;
        if (next) {
          const exists = database.prepare("SELECT id FROM workbench_sessions WHERE id = ?").get(next);
          if (!exists) fail("SESSION_INVALID");
        }
        const revision = Number(row?.revision ?? 1) + 1;
        database.prepare("UPDATE workbench_settings SET activeSessionId = ?, revision = ? WHERE id = 1").run(next, revision);
        return { revision, ...(next ? { activeSessionId: String(next) } : {}) };
      },
      (error, busy) => {
        if (error instanceof SessionStoreError) throw error;
        return fail(busy ? "SESSION_BUSY" : "SESSION_UNAVAILABLE");
      }
    )
  );
}
