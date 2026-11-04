/**
 * Memory 本地 SQLite 存储（任务书 §3）。
 *
 * 边界：
 * - 默认 `.local/ai-memory/memory.sqlite`；测试用 `XINGJI_MEMORY_DB_PATH` 指向临时文件。
 *   客户端**不能**指定路径。
 * - 两张最小表：单行设置表（enabled + 全局 revision）与条目表；只支持 preference，
 *   旧版本留下的 session-summary 行不展示，但写入时原样保留（不隐式删数据）。
 * - SQLite 事务负责整批校验、版本比较、写入与 revision 递增；保存成功仅指事务已提交。
 * - 文件不存在才初始化；损坏 / 不可写 / 不支持的版本一律明确失败，**不删除重建、不清空、不退回内存**。
 * - 目录 0700、数据库 0600；普通 SQLite 不等于加密，不放任何凭据。
 */
import { statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { currentScopeEnv } from "./user-scope.ts";
import {
  MEMORY_SCHEMA_VERSION as SQLITE_MEMORY_VERSION,
  SQLITE_LIMITS,
  inTransaction,
  resolveDatabasePath,
  withDatabase as sharedWithDatabase
} from "./sqlite-db";

export const MEMORY_SCHEMA_VERSION = SQLITE_MEMORY_VERSION;
export const MEMORY_LIMITS = {
  /** 单条正文上限（字符）。 */
  maxTextChars: 2_000,
  /** 条目总数上限。 */
  maxEntries: 200,
  /** 单次请求正文上限（字节，路由层用）。 */
  maxBodyBytes: 2 * 1024 * 1024,
  /** 数据库占用时的有限等待（与共享入口一致）。 */
  busyTimeoutMs: SQLITE_LIMITS.busyTimeoutMs
};

export type MemoryKind = "preference";

export type MemoryEntryRecord = {
  id: string;
  kind: MemoryKind;
  text: string;
  allowModelUse: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MemoryView = { revision: number; enabled: boolean; entries: MemoryEntryRecord[] };

export type MemoryOperation =
  | { op: "upsert"; id: string; kind: MemoryKind; text: string; allowModelUse?: boolean }
  | { op: "delete"; id: string }
  | { op: "set-enabled"; enabled: boolean };

/** 稳定错误码；文案固定，不回显路径、异常或记忆正文。 */
export type MemoryErrorCode =
  | "MEMORY_VERSION_REQUIRED"
  | "MEMORY_CONFLICT"
  | "MEMORY_BUSY"
  | "MEMORY_INVALID"
  | "MEMORY_TOO_LARGE"
  | "MEMORY_FORBIDDEN"
  | "MEMORY_UNAVAILABLE";

export class MemoryStoreError extends Error {
  constructor(readonly code: MemoryErrorCode, readonly detail: string) {
    super(detail);
    this.name = "MemoryStoreError";
  }
}

export function memoryErrorDetail(code: MemoryErrorCode): string {
  switch (code) {
    case "MEMORY_VERSION_REQUIRED":
      return "缺少记忆库版本，请先读取当前状态再提交。";
    case "MEMORY_CONFLICT":
      return "记忆已在别处修改，本次未保存；请重新读取后再提交。";
    case "MEMORY_BUSY":
      return "记忆库正忙，请稍后重试。";
    case "MEMORY_INVALID":
      return "记忆条目不符合要求（类型或正文长度）。";
    case "MEMORY_TOO_LARGE":
      return "记忆内容超过上限，本次未写入任何条目。";
    case "MEMORY_FORBIDDEN":
      return "记忆管理只允许本机同源访问。";
    default:
      return "记忆库暂时不可用，未做任何修改。";
  }
}

export function resolveMemoryDbPath(env: NodeJS.ProcessEnv = currentScopeEnv() as NodeJS.ProcessEnv): string {
  return resolveDatabasePath(env);
}

/**
 * 打开数据库走共享入口（版本判定与 v1→v2 升级都在那里，Memory 业务语义不变）。
 * 共享入口的失败统一映射回记忆端点的稳定码。
 */
function withDatabase<T>(dbPath: string, run: (database: DatabaseSync) => T): T {
  try {
    return sharedWithDatabase(dbPath, run);
  } catch (error) {
    if (error instanceof MemoryStoreError) throw error;
    throw new MemoryStoreError("MEMORY_UNAVAILABLE", memoryErrorDetail("MEMORY_UNAVAILABLE"));
  }
}

function rowToEntry(row: Record<string, unknown>): MemoryEntryRecord {
  return {
    id: String(row.id),
    kind: "preference",
    text: String(row.text),
    allowModelUse: Number(row.allowModelUse) === 1,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt)
  };
}

export function readMemoryView(dbPath = resolveMemoryDbPath()): MemoryView {
  return withDatabase(dbPath, (database) => {
    const settings = database.prepare("SELECT enabled, revision FROM memory_settings WHERE id = 1").get() as
      | { enabled?: number; revision?: number }
      | undefined;
    const rows = database.prepare(
      "SELECT id, kind, text, allowModelUse, createdAt, updatedAt FROM memory_entries WHERE kind = 'preference' ORDER BY createdAt ASC, id ASC"
    ).all() as Record<string, unknown>[];
    return {
      revision: Number(settings?.revision ?? 1),
      enabled: Number(settings?.enabled ?? 0) === 1,
      entries: rows.map(rowToEntry)
    };
  });
}

function assertEntryShape(entry: { text: string }, size: number) {
  if (size > MEMORY_LIMITS.maxEntries) throw new MemoryStoreError("MEMORY_TOO_LARGE", memoryErrorDetail("MEMORY_TOO_LARGE"));
  if (entry.text.length > MEMORY_LIMITS.maxTextChars) {
    throw new MemoryStoreError("MEMORY_TOO_LARGE", memoryErrorDetail("MEMORY_TOO_LARGE"));
  }
  if (entry.text.trim().length === 0) throw new MemoryStoreError("MEMORY_INVALID", memoryErrorDetail("MEMORY_INVALID"));
}

/**
 * 整批提交：版本比较 + 校验 + 写入 + revision 递增都在一个事务里。
 * 任何一条非法 → 整批零写入（不静默截断、不部分写入）。
 */
export function applyMemoryOperations(
  input: { baseRevision?: number; operations: MemoryOperation[] },
  dbPath = resolveMemoryDbPath(),
  now: () => Date = () => new Date()
): MemoryView {
  if (!Number.isInteger(input.baseRevision) || (input.baseRevision ?? 0) < 1) {
    throw new MemoryStoreError("MEMORY_VERSION_REQUIRED", memoryErrorDetail("MEMORY_VERSION_REQUIRED"));
  }
  if (!Array.isArray(input.operations) || input.operations.length === 0 || input.operations.length > MEMORY_LIMITS.maxEntries + 1) {
    throw new MemoryStoreError("MEMORY_INVALID", memoryErrorDetail("MEMORY_INVALID"));
  }
  return withDatabase(dbPath, (database) => {
    return inTransaction(database, () => {
      const settings = database.prepare("SELECT enabled, revision FROM memory_settings WHERE id = 1").get() as
        | { enabled?: number; revision?: number }
        | undefined;
      const current = Number(settings?.revision ?? 1);
      if (current !== input.baseRevision) {
        throw new MemoryStoreError("MEMORY_CONFLICT", memoryErrorDetail("MEMORY_CONFLICT"));
      }
      const rows = database.prepare(
        "SELECT id, kind, text, sessionId, allowModelUse, createdAt, updatedAt FROM memory_entries"
      ).all() as Record<string, unknown>[];
      // 旧版本可能留下 session-summary 行：不在界面展示，但整批重写时原样保留，不静默删除。
      const legacy = rows.filter((row) => row.kind !== "preference");
      const existing = new Map(
        rows.filter((row) => row.kind === "preference").map((row) => [String(row.id), rowToEntry(row)])
      );
      let enabled = Number(settings?.enabled ?? 0) === 1;
      const stamp = now().toISOString();

      for (const operation of input.operations) {
        if (operation.op === "set-enabled") {
          if (typeof operation.enabled !== "boolean") throw new MemoryStoreError("MEMORY_INVALID", memoryErrorDetail("MEMORY_INVALID"));
          enabled = operation.enabled;
          continue;
        }
        if (typeof operation.id !== "string" || !operation.id.trim()) {
          throw new MemoryStoreError("MEMORY_INVALID", memoryErrorDetail("MEMORY_INVALID"));
        }
        if (operation.op === "delete") {
          existing.delete(operation.id);
          continue;
        }
        if (operation.op !== "upsert") throw new MemoryStoreError("MEMORY_INVALID", memoryErrorDetail("MEMORY_INVALID"));
        if (operation.kind !== "preference") {
          // 会话摘要已移除：显式拒绝旧客户端，避免被当成偏好写入。
          throw new MemoryStoreError("MEMORY_INVALID", memoryErrorDetail("MEMORY_INVALID"));
        }
        assertEntryShape(
          { text: operation.text },
          // 编辑已有条目不再占用新名额；只有真正新增才 +1。
          existing.size + (existing.has(operation.id) ? 0 : 1)
        );
        const previous = existing.get(operation.id);
        existing.set(operation.id, {
          id: operation.id,
          kind: "preference",
          text: operation.text.trim(),
          // 新条目默认不外发；已有条目保持原许可。
          allowModelUse: operation.allowModelUse ?? previous?.allowModelUse ?? false,
          createdAt: previous?.createdAt ?? stamp,
          updatedAt: stamp
        });
      }

      if (existing.size > MEMORY_LIMITS.maxEntries) {
        throw new MemoryStoreError("MEMORY_TOO_LARGE", memoryErrorDetail("MEMORY_TOO_LARGE"));
      }

      database.prepare("DELETE FROM memory_entries").run();
      const insert = database.prepare(
        "INSERT INTO memory_entries (id, kind, text, sessionId, allowModelUse, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      for (const entry of existing.values()) {
        insert.run(entry.id, entry.kind, entry.text, null, entry.allowModelUse ? 1 : 0, entry.createdAt, entry.updatedAt);
      }
      for (const row of legacy) {
        insert.run(
          String(row.id),
          String(row.kind),
          String(row.text),
          typeof row.sessionId === "string" ? row.sessionId : null,
          Number(row.allowModelUse) === 1 ? 1 : 0,
          String(row.createdAt),
          String(row.updatedAt)
        );
      }
      const nextRevision = current + 1;
      database.prepare("UPDATE memory_settings SET enabled = ?, revision = ? WHERE id = 1").run(enabled ? 1 : 0, nextRevision);
      const settings2 = database.prepare("SELECT enabled, revision FROM memory_settings WHERE id = 1").get() as {
        enabled?: number;
        revision?: number;
      };
      const rows2 = database.prepare(
        "SELECT id, kind, text, allowModelUse, createdAt, updatedAt FROM memory_entries WHERE kind = 'preference' ORDER BY createdAt ASC, id ASC"
      ).all() as Record<string, unknown>[];
      // 成功以事务内回读为准（同一连接，避免刚提交又被别的写入插队）。
      return {
        revision: Number(settings2?.revision ?? nextRevision),
        enabled: Number(settings2?.enabled ?? 0) === 1,
        entries: rows2.map(rowToEntry)
      };
    }, (error, busy) => {
      if (error instanceof MemoryStoreError) throw error;
      // 只有真正的占用/约束问题才算 BUSY；其它一律按存储故障处理，不掩盖校验错误。
      throw new MemoryStoreError(busy ? "MEMORY_BUSY" : "MEMORY_UNAVAILABLE", memoryErrorDetail(busy ? "MEMORY_BUSY" : "MEMORY_UNAVAILABLE"));
    });
  });
}

/** 数据库文件与目录权限（供诊断与验收读取，不返回给客户端）。 */
export function memoryFileMode(dbPath = resolveMemoryDbPath()): { directory: number; file: number } | undefined {
  try {
    return { directory: statSync(path.dirname(dbPath)).mode & 0o777, file: statSync(dbPath).mode & 0o777 };
  } catch {
    return undefined;
  }
}
