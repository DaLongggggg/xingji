/**
 * 本地记忆（客户端契约，任务书 §4）。
 *
 * 持久化在生产环境走 `/api/ai/memory`（本机 SQLite）；测试用同接口的内存实现。
 * 边界：
 * - 只有**长期偏好**一种条目，不绑定会话（会话摘要已移除）；
 * - 只有「总开关开启 + 条目允许用于对话」的内容才会随请求发送；新条目默认不允许；
 * - 关闭总开关、取消许可或删除后，后续请求不得沿用旧快照（调用方按 revision 重新筛选）；
 * - 不自动扫描旧笔记，也不自动总结：偏好必须由用户明确保存或编辑。
 */
import { apiFetch } from "@/lib/api-client";

export type MemoryKind = "preference";

export type MemoryEntry = {
  id: string;
  kind: MemoryKind;
  text: string;
  /** 是否允许用于对话（与「本次是否真的用了」是两件事）。 */
  allowModelUse: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MemoryState = { revision: number; enabled: boolean; entries: MemoryEntry[] };

export type MemoryOperation =
  | { op: "upsert"; id: string; kind: MemoryKind; text: string; allowModelUse?: boolean }
  | { op: "delete"; id: string }
  | { op: "set-enabled"; enabled: boolean };

export type MemoryStore = {
  load(): Promise<MemoryState>;
  /** 整批提交；成功返回服务端回读结果，失败抛出带 code 的错误。 */
  apply(operations: MemoryOperation[]): Promise<MemoryState>;
};

export class MemoryClientError extends Error {
  constructor(readonly code: string, readonly detail: string) {
    super(detail);
    this.name = "MemoryClientError";
  }
}

export const MEMORY_ENDPOINT = "/api/ai/memory";

export function createMemoryId(): string {
  return `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isEntry(value: unknown): value is MemoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.kind === "preference" &&
    typeof record.text === "string" &&
    typeof record.allowModelUse === "boolean"
  );
}

/** 校验服务端视图：形状不对就明确失败，不把坏数据当空库。 */
export function parseMemoryView(payload: unknown): MemoryState {
  const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : undefined;
  if (!record || record.ok !== true || typeof record.revision !== "number" || typeof record.enabled !== "boolean" || !Array.isArray(record.entries)) {
    throw new MemoryClientError("MEMORY_UNAVAILABLE", "记忆库返回了无法识别的结果。");
  }
  const entries = record.entries.filter(isEntry).map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    text: entry.text,
    allowModelUse: entry.allowModelUse,
    createdAt: typeof entry.createdAt === "string" ? entry.createdAt : "",
    updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : ""
  }));
  return { revision: record.revision, enabled: record.enabled, entries };
}

/** 生产实现：本机 API store（关闭面板、刷新、重启后仍可读）。 */
export function createApiMemoryStore(options: { endpoint?: string; fetchImpl?: typeof fetch } = {}): MemoryStore {
  const endpoint = options.endpoint ?? MEMORY_ENDPOINT;
  // T2a：默认经受控认证入口（同源凭证 + 401 广播）；测试仍可注入 fetchImpl。
  const fetchImpl = options.fetchImpl ?? apiFetch;
  let revision: number | undefined;

  const request = async (init?: RequestInit): Promise<MemoryState> => {
    const response = await fetchImpl(endpoint, { cache: "no-store", ...init });
    const payload = (await response.json().catch(() => null)) as { ok?: boolean; code?: unknown; detail?: unknown } | null;
    if (!response.ok || payload?.ok !== true) {
      const code = typeof payload?.code === "string" ? payload.code : "MEMORY_UNAVAILABLE";
      throw new MemoryClientError(code, typeof payload?.detail === "string" ? payload.detail : "记忆库暂时不可用。");
    }
    const view = parseMemoryView(payload);
    revision = view.revision;
    return view;
  };

  return {
    load: () => request(),
    async apply(operations) {
      const baseRevision = revision ?? (await request()).revision;
      return request({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseRevision, operations })
      });
    }
  };
}

/** 测试用内存实现：与 API store 同接口，不落盘。 */
export function createMemoryStore(initial: MemoryState = { revision: 1, enabled: false, entries: [] }): MemoryStore {
  let state: MemoryState = { revision: initial.revision, enabled: initial.enabled, entries: initial.entries.map((entry) => ({ ...entry })) };
  return {
    async load() {
      return { revision: state.revision, enabled: state.enabled, entries: state.entries.map((entry) => ({ ...entry })) };
    },
    async apply(operations) {
      const next = new Map(state.entries.map((entry) => [entry.id, { ...entry }]));
      let enabled = state.enabled;
      const stamp = new Date().toISOString();
      for (const operation of operations) {
        if (operation.op === "set-enabled") {
          enabled = operation.enabled;
          continue;
        }
        if (operation.op === "delete") {
          next.delete(operation.id);
          continue;
        }
        const previous = next.get(operation.id);
        next.set(operation.id, {
          id: operation.id,
          kind: operation.kind,
          text: operation.text.trim(),
          allowModelUse: operation.allowModelUse ?? previous?.allowModelUse ?? false,
          createdAt: previous?.createdAt ?? stamp,
          updatedAt: stamp
        });
      }
      state = { revision: state.revision + 1, enabled, entries: [...next.values()] };
      return this.load();
    }
  };
}

/** 本次请求可以发送的记忆：总开关开启，且条目允许用于对话。 */
export function memoryForRequest(state: MemoryState | undefined): MemoryEntry[] {
  if (!state?.enabled) return [];
  return state.entries.filter((entry) => entry.allowModelUse);
}

/** 记忆按普通参考资料进入请求，不是系统指令、也不是工具权限。 */
export function formatMemoryForPrompt(entries: MemoryEntry[]): string {
  if (entries.length === 0) return "";
  return `<memory>\n${entries.map((entry) => `- ${entry.text}`).join("\n")}\n</memory>`;
}

/** 专用导出格式。 */
export function exportMemoryJson(state: MemoryState): string {
  return JSON.stringify(
    { format: "xingji-memory", version: 1, exportedAt: new Date().toISOString(), enabled: state.enabled, entries: state.entries },
    null,
    2
  );
}

/**
 * 导入计划：追加合并。同 id 同内容跳过；同 id 内容不同整批冲突。
 * 不开启总开关，导入条目一律 allowModelUse=false，已有条目许可保持原值。
 */
export function planMemoryImport(state: MemoryState, payload: unknown): { operations: MemoryOperation[]; imported: number; skipped: number } {
  const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : undefined;
  if (!record || record.format !== "xingji-memory" || !Array.isArray(record.entries)) {
    throw new MemoryClientError("MEMORY_INVALID", "这不是记忆导出文件。");
  }
  // 只接受本版本；未知版本整批拒绝，不猜测字段含义。
  if (record.version !== 1) {
    throw new MemoryClientError("MEMORY_INVALID", "导入文件的格式版本不受支持。");
  }
  const existing = new Map(state.entries.map((entry) => [entry.id, entry]));
  const operations: MemoryOperation[] = [];
  /** 文件内部也要查重：同 id 不同内容一律整批冲突，不能后写覆盖前写。 */
  const seen = new Map<string, { kind: MemoryKind; text: string }>();
  let skipped = 0;
  for (const raw of record.entries as Record<string, unknown>[]) {
    const id = typeof raw?.id === "string" ? raw.id : "";
    // 旧文件里的会话摘要不再导入；未知类型整批拒绝。
    const kind = raw?.kind === "preference" ? raw.kind : undefined;
    const text = typeof raw?.text === "string" ? raw.text : "";
    if (!id || !kind || !text.trim()) throw new MemoryClientError("MEMORY_INVALID", "导入文件里有不合法的条目。");

    const inFile = seen.get(id);
    if (inFile) {
      if (inFile.kind === kind && inFile.text === text.trim()) {
        skipped += 1;
        continue;
      }
      throw new MemoryClientError("MEMORY_CONFLICT", "导入文件内部同一条记忆有两种内容，本次未导入任何条目。");
    }
    seen.set(id, { kind, text: text.trim() });

    const previous = existing.get(id);
    if (previous) {
      if (previous.kind === kind && previous.text === text.trim()) {
        skipped += 1;
        continue;
      }
      throw new MemoryClientError("MEMORY_CONFLICT", "导入文件里有的条目与现有记忆内容不同，本次未导入任何条目。");
    }
    operations.push({ op: "upsert", id, kind, text, allowModelUse: false });
  }
  return { operations, imported: operations.length, skipped };
}
