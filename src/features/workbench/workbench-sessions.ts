/**
 * 会话持久化的客户端契约与 API 适配层（任务书 §5.1）。
 *
 * 只做三件事：把界面会话变成白名单 payload、把服务端记录还原成界面会话、把 HTTP 错误变成稳定码。
 * 不做缓存、不做重试策略、不持有授权：授权永远来自当前界面状态。
 */
import type { WorkbenchMessage, WorkbenchScope, WorkbenchSession } from "./workbench-types";
import { snapshotProcess } from "./workbench-process";
import { apiFetch } from "@/lib/api-client";

export type SessionSummary = {
  id: string;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  renamed: boolean;
  messageCount: number;
};

export type SessionRecord = SessionSummary & { payload: SessionPayload };

/** 落库契约：只有这些字段会进数据库。 */
export type SessionPayload = {
  scope: WorkbenchScope;
  textModelId?: string;
  imageModelId?: string;
  renamed: boolean;
  messages: WorkbenchMessage[];
};

export type WorkbenchPreference = { revision: number; activeSessionId?: string };

export type SessionApi = {
  list(): Promise<SessionSummary[]>;
  read(id: string): Promise<SessionRecord>;
  create(input: { id: string; title?: string; payload: SessionPayload }): Promise<SessionRecord>;
  update(input: { id: string; baseRevision: number; title?: string; payload: SessionPayload }): Promise<SessionRecord>;
  remove(input: { id: string; baseRevision: number }): Promise<{ id: string; preference: WorkbenchPreference }>;
  readPreference(): Promise<WorkbenchPreference>;
  writePreference(input: { baseRevision: number; activeSessionId?: string | null }): Promise<WorkbenchPreference>;
};

export class SessionApiError extends Error {
  constructor(readonly code: string, readonly detail: string, readonly status: number) {
    super(detail);
    this.name = "SessionApiError";
  }
}

/**
 * 逐层选择：消息与嵌套结构都只挑白名单字段，
 * 不把 request/result/附件对象按引用原样交给存储（SP7）。
 */
const MESSAGE_FIELDS = [
  "id", "role", "text", "intent", "status", "reasoning", "tools", "traces", "error", "saveFailed", "createdAt", "localEdit",
  "eventSequence",
  // R1：图片计划与尝试投影（服务端白名单同步支持，见 session-store.ts）。
  "imagePlan", "imageAttempts",
  // R4：调用记录。
  "calls"
] as const;
const TOOL_FIELDS = ["id", "name", "title", "argsDigest", "ok", "cancelled", "summary", "truncated", "ms"] as const;
const REQUEST_FIELDS = ["text", "intent", "context", "scope", "imageOptions"] as const;
const IMAGE_OPTIONS_FIELDS = ["modelId", "size", "style", "outputFormat", "requested"] as const;
const SKILL_REFERENCE_FIELDS = ["id", "name"] as const;
const ADVICE_ITEM_FIELDS = ["sourceId", "sourceDigest", "instruction"] as const;
const REFERENCE_FIELDS = ["id", "kind", "title", "text", "updatedAt"] as const;
const ATTACHMENT_FIELDS = ["id", "name", "dataUrl", "fileRef", "edit"] as const;
const RESULT_FIELDS = ["id", "kind", "title", "body", "caption", "from", "to", "dataUrl", "fileRef", "subtitle", "demo", "blocks"] as const;

function pick<T extends object>(value: T, fields: readonly string[]): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    const item = (value as Record<string, unknown>)[field];
    if (item !== undefined) output[field] = item;
  }
  return output;
}

function pickMessage(message: WorkbenchMessage): Record<string, unknown> {
  const output = pick(message, MESSAGE_FIELDS);
  if (message.process) output.process = pick(snapshotProcess(message.process), ["startedAt", "phase", "elapsedMs", "endedAt", "outcome", "waitingLabel"]);
  if (message.skillReferences) output.skillReferences = message.skillReferences.map(ref => pick(ref, SKILL_REFERENCE_FIELDS));
  if (message.imageAdvice) output.imageAdvice = { items: message.imageAdvice.items.map(item => pick(item, ADVICE_ITEM_FIELDS)) };
  if (message.references) output.references = message.references.map(reference => pick(reference, REFERENCE_FIELDS));
  if (message.attachments) output.attachments = message.attachments.map(attachment => pick(attachment, ATTACHMENT_FIELDS));
  if (message.request) {
    const request: Record<string, unknown> = {
      ...pick(message.request, REQUEST_FIELDS),
      references: message.request.references.map(reference => pick(reference, REFERENCE_FIELDS)),
      attachments: message.request.attachments.map(attachment => pick(attachment, ATTACHMENT_FIELDS))
    };
    if (message.request.imageOptions) request.imageOptions = pick(message.request.imageOptions, IMAGE_OPTIONS_FIELDS);
    if (message.request.skillReferences) request.skillReferences = message.request.skillReferences.map(ref => pick(ref, SKILL_REFERENCE_FIELDS));
    if (message.request.history) request.history = message.request.history.map(turn => ({
      ...pick(turn, ["role", "id", "text", "imageSourceIds"]),
      ...(turn.imageAdvice ? { imageAdvice: { items: turn.imageAdvice.items.map(item => pick(item, ADVICE_ITEM_FIELDS)) } } : {})
    }));
    if (message.request.targetResult) request.targetResult = pick(message.request.targetResult, RESULT_FIELDS);
    output.request = request;
  }
  if (message.tools) output.tools = message.tools.map(tool => ({
    ...pick(tool, TOOL_FIELDS),
    ...(tool.search ? { search: { ...pick(tool.search, ["query", "summary", "truncated", "grounding"]),
      sources: tool.search.sources.map(source => pick(source, ["title", "url"])),
      ...(tool.search.images ? { images: tool.search.images.map(image => pick(image, ["url", "title", "sourceUrl", "thumbnailUrl"])) } : {}) } } : {})
  }));
  if (message.blocks) output.blocks = message.blocks.map(block => pick(block,
    ["id", "sequence", "type", "text", "endSequence", "phase", "toolId", "callId", "attachmentIds", "resultId"]));
  if (message.result) output.result = pick(message.result, RESULT_FIELDS);
  return output;
}

/**
 * 界面会话 → 落库 payload：逐字段挑选（不是展开整个对象），
 * 因此函数、AbortSignal、授权标志与 Memory 快照都不可能被写进去。
 */
export function toSessionPayload(session: WorkbenchSession, models: { textModelId?: string; imageModelId?: string } = {}): SessionPayload {
  const renamed = (session as { renamed?: boolean }).renamed === true;
  return {
    scope: session.scope,
    ...(models.textModelId ? { textModelId: models.textModelId } : {}),
    ...(models.imageModelId ? { imageModelId: models.imageModelId } : {}),
    renamed,
    messages: session.messages.map(pickMessage) as unknown as WorkbenchMessage[]
  };
}

export function fromSessionRecord(record: SessionRecord): WorkbenchSession {
  return {
    id: record.id,
    title: record.title,
    scope: record.payload.scope,
    messages: record.payload.messages,
    updatedAt: record.updatedAt,
    ...(record.payload.textModelId ? { textModelId: record.payload.textModelId } : {}),
    ...(record.payload.imageModelId ? { imageModelId: record.payload.imageModelId } : {}),
    ...(record.payload.renamed ? { renamed: true } : {})
  } as WorkbenchSession;
}

/**
 * 恢复到本页时，没有执行句柄的 pending 回答按「已中断」处理：
 * 保留已保存正文，不显示持续生成，也绝不自动续跑。
 */
export function markInterrupted(messages: WorkbenchMessage[]): { messages: WorkbenchMessage[]; interrupted: number } {
  let interrupted = 0;
  const next = messages.map((message) => {
    if (message.status !== "pending") return message;
    interrupted += 1;
    const process = message.process ? snapshotProcess(message.process) : undefined;
    if (process) {
      delete process.waitingLabel;
      process.outcome = "interrupted";
    }
    return {
      ...message,
      status: "failed" as const,
      ...(process ? { process } : {}),
      error: "已中断（未在本页运行）。",
      tools: message.tools?.map(tool => tool.ok === undefined ? { ...tool, ok: false, summary: "已中断" } : tool)
    };
  });
  return { messages: next, interrupted };
}

async function call<T>(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  const response = await fetchImpl(url, { cache: "no-store", ...init });
  const payload = (await response.json().catch(() => null)) as { ok?: boolean; code?: unknown; detail?: unknown } | null;
  if (!response.ok || payload?.ok !== true) {
    const code = typeof payload?.code === "string" ? payload.code : "SESSION_UNAVAILABLE";
    const detail = typeof payload?.detail === "string" ? payload.detail : "会话存储暂时不可用。";
    throw new SessionApiError(code, detail, response.status);
  }
  return payload as T;
}

export function createSessionApi(options: { base?: string; fetchImpl?: typeof fetch } = {}): SessionApi {
  const base = options.base ?? "/api/ai/sessions";
  const fetchImpl = options.fetchImpl ?? apiFetch;
  const json = { "content-type": "application/json" };
  return {
    async list() {
      const payload = await call<{ sessions: SessionSummary[] }>(fetchImpl, base);
      return payload.sessions;
    },
    async read(id) {
      const payload = await call<{ session: SessionRecord }>(fetchImpl, `${base}/${encodeURIComponent(id)}`);
      return payload.session;
    },
    async create(input) {
      const payload = await call<{ session: SessionRecord }>(fetchImpl, base, { method: "POST", headers: json, body: JSON.stringify(input) });
      return payload.session;
    },
    async update(input) {
      const payload = await call<{ session: SessionRecord }>(fetchImpl, `${base}/${encodeURIComponent(input.id)}`, {
        method: "PUT",
        headers: json,
        body: JSON.stringify({ baseRevision: input.baseRevision, ...(input.title ? { title: input.title } : {}), payload: input.payload })
      });
      return payload.session;
    },
    async remove(input) {
      const payload = await call<{ id: string; preference: WorkbenchPreference }>(
        fetchImpl,
        `${base}/${encodeURIComponent(input.id)}`,
        { method: "DELETE", headers: json, body: JSON.stringify({ baseRevision: input.baseRevision }) }
      );
      return { id: payload.id, preference: payload.preference };
    },
    async readPreference() {
      const payload = await call<{ preference: WorkbenchPreference }>(fetchImpl, `${base}/preference`);
      return payload.preference;
    },
    async writePreference(input) {
      const payload = await call<{ preference: WorkbenchPreference }>(fetchImpl, `${base}/preference`, {
        method: "PUT",
        headers: json,
        body: JSON.stringify(input)
      });
      return payload.preference;
    }
  };
}
