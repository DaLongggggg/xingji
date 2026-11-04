/**
 * 共享 SQLite 入口（会话持久化任务书 §3.1；R1 图片执行任务书 §4.1）。
 *
 * Memory 与会话共用同一个数据库文件、同一套打开/版本判定/权限设置，避免复制初始化代码：
 * - 文件不存在 → 直接建 v3；
 * - 已有 v1 / v2 → 一个事务内升级到 v3（**保留 Memory、会话所有行、revision 与许可原值**；
 *   v3 只新增制图尝试表，不改既有表结构）；
 * - 未知版本 / 残缺 / 损坏 → 明确失败，不重建、不清空、不猜测修复；迁移失败整批回滚，
 *   保留原版本。
 */
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { currentScopeEnv } from "./user-scope.ts";
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 3;
/** v1：只有记忆两表。 */
export const MEMORY_SCHEMA_VERSION = 1;
/** v2：记忆 + 会话两表。 */
export const SESSION_SCHEMA_VERSION = 2;

export const SQLITE_LIMITS = {
  /** 数据库占用时的有限等待。 */
  busyTimeoutMs: 3_000
};

export class SqliteStoreError extends Error {
  constructor(readonly code: string, readonly detail: string) {
    super(detail);
    this.name = "SqliteStoreError";
  }
}

export function resolveDatabasePath(env: NodeJS.ProcessEnv = currentScopeEnv() as NodeJS.ProcessEnv): string {
  const override = env.XINGJI_MEMORY_DB_PATH?.trim();
  return override && path.isAbsolute(override) ? override : path.join(process.cwd(), ".local", "ai-memory", "memory.sqlite");
}

const MEMORY_TABLES = ["memory_settings", "memory_entries"];
const SESSION_TABLES = ["workbench_sessions", "workbench_settings"];
const ATTEMPT_TABLES = ["workbench_image_attempts"];

function requiredTables(version: number): string[] {
  if (version >= SCHEMA_VERSION) return [...MEMORY_TABLES, ...SESSION_TABLES, ...ATTEMPT_TABLES];
  if (version >= SESSION_SCHEMA_VERSION) return [...MEMORY_TABLES, ...SESSION_TABLES];
  return [...MEMORY_TABLES];
}

function tableNames(database: DatabaseSync): Set<string> {
  const rows = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name?: string }[];
  return new Set(rows.map((row) => String(row.name)));
}

function createMemoryTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('preference','session-summary')),
      text TEXT NOT NULL,
      sessionId TEXT,
      allowModelUse INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    INSERT OR IGNORE INTO memory_settings (id, enabled, revision) VALUES (1, 0, 1);
  `);
}

/** 会话表：每会话一行 payload（列表只读摘要字段，不加载大 payload）。 */
function createSessionTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS workbench_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      renamed INTEGER NOT NULL DEFAULT 0,
      messageCount INTEGER NOT NULL DEFAULT 0,
      payloadJson TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workbench_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      activeSessionId TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    );
    INSERT OR IGNORE INTO workbench_settings (id, activeSessionId, revision) VALUES (1, NULL, 1);
  `);
}

/**
 * v3 制图尝试表（任务书 §4.1）：**只**负责付费图片请求的身份、出站状态与未交付结果，
 * 不是通用任务表。状态是执行事实的权威；会话与工具块只是投影。
 * - `(sessionId, executionId, itemId, attemptNo)` 唯一：双标签同时补修同一项只有一个登记成功；
 * - `resultJson` 暂存已校验的图片响应（会话转存核对后在同一事务清除）；
 * - 不存密钥、完整模型上下文、Memory 快照或原图副本。
 */
function createAttemptTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS workbench_image_attempts (
      attemptId TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL,
      messageId TEXT NOT NULL,
      executionId TEXT NOT NULL,
      itemId TEXT NOT NULL,
      attemptNo INTEGER NOT NULL,
      previousAttemptId TEXT,
      requestDigest TEXT NOT NULL,
      configDigest TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('prepared','dispatched','succeeded','failed','outcome_unknown')),
      errorCode TEXT,
      deadlineAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      reservedBytes INTEGER NOT NULL DEFAULT 0,
      artifactId TEXT,
      artifactDigest TEXT,
      artifactMime TEXT,
      resultJson TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_image_attempts_item_no
      ON workbench_image_attempts (sessionId, executionId, itemId, attemptNo);
    CREATE INDEX IF NOT EXISTS idx_image_attempts_session
      ON workbench_image_attempts (sessionId);
  `);
}

/**
 * 既有库（v1/v2）升级到 v3 的**显式关口**：默认拒绝自动升级——现用数据库升级
 * 属于需要单独确认的操作（任务书 §4.1/§8）。部署方确认后设置
 * `XINGJI_DB_ALLOW_MIGRATION=1` 重启；升级前自动写一份原库备份（`*.pre-v3.bak`，
 * 已有备份不覆盖）。新库（不存在）直接建 v3，不需要该开关。
 */
export const DB_MIGRATION_ENV = "XINGJI_DB_ALLOW_MIGRATION";

/**
 * 升级前备份：用 `VACUUM INTO` 产生**一致性快照**（连接上可见的全部已提交数据，
 * 含尚在 WAL 中未 checkpoint 的部分——直接复制主文件会漏掉这些数据）。
 * 备份必须验证可读（user_version 与 Memory 设置行齐全）才继续升级；
 * 已存在的备份也重新验证，损坏则停止升级（不覆盖最早一份原始备份）。
 */
function backupBeforeUpgrade(database: DatabaseSync, dbPath: string, originalVersion: number): void {
  const backupPath = `${dbPath}.pre-v3.bak`;
  const verifyBackup = () => {
    let verified: DatabaseSync | undefined;
    try {
      verified = new DatabaseSync(backupPath);
      // node:sqlite 打开损坏文件可能延迟报错：读取必须成功且结构齐全。
      const backupVersion = Number((verified.prepare("PRAGMA user_version").get() as { user_version?: number })?.user_version ?? 0);
      const settings = verified.prepare("SELECT COUNT(*) AS count FROM memory_settings WHERE id = 1").get() as { count?: number };
      if (backupVersion !== originalVersion || Number(settings?.count ?? 0) !== 1) {
        throw new Error("backup content incomplete");
      }
      verified.close();
    } catch (error) {
      try {
        verified?.close();
      } catch {
        /* 已关闭 */
      }
      const detail = error instanceof SqliteStoreError
        ? error.detail
        : "升级备份无法打开或内容不完整，已停止升级；请手动检查 .pre-v3.bak 后重试。";
      throw new SqliteStoreError("STORE_UNAVAILABLE", detail);
    }
  };
  if (existsSync(backupPath)) {
    // 保留最早一份原始备份，不覆盖；但必须可读才继续升级。
    verifyBackup();
    return;
  }
  database.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
  try {
    chmodSync(backupPath, 0o600);
  } catch {
    /* 某些文件系统不支持 chmod：不因此判定失败 */
  }
  verifyBackup();
}

/** 打开数据库：判定 → 建表/升级 → 设置 PRAGMA。任何异常都不留半成品。 */
export function openDatabase(dbPath = resolveDatabasePath()): DatabaseSync {
  const directory = path.dirname(dbPath);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  } catch {
    throw new SqliteStoreError("STORE_UNAVAILABLE", "存储目录不可用。");
  }

  const existed = existsSync(dbPath);
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(dbPath);
  } catch {
    // 损坏或不是 SQLite 文件：不删除、不重建。
    throw new SqliteStoreError("STORE_UNAVAILABLE", "存储不可用。");
  }

  try {
    const version = Number((database.prepare("PRAGMA user_version").get() as { user_version?: number })?.user_version ?? 0);
    if (existed) {
      const tables = tableNames(database);
      const complete = requiredTables(version).every((name) => tables.has(name));
      const settingsRow =
        version >= MEMORY_SCHEMA_VERSION && tables.has("memory_settings")
          ? (database.prepare("SELECT COUNT(*) AS count FROM memory_settings WHERE id = 1").get() as { count?: number })
          : undefined;
      const knownVersion = version === MEMORY_SCHEMA_VERSION || version === SESSION_SCHEMA_VERSION || version === SCHEMA_VERSION;
      if (!knownVersion || !complete || Number(settingsRow?.count ?? 0) !== 1) {
        throw new SqliteStoreError("STORE_UNAVAILABLE", "存储版本或结构不受支持。");
      }
      // 升级关口：v1/v2 现用库默认只读拒绝，防止未经确认的自动升级。
      if (version < SCHEMA_VERSION && process.env[DB_MIGRATION_ENV] !== "1") {
        throw new SqliteStoreError("DB_UPGRADE_REQUIRED",
          "存储结构需要升级（v1/v2 → v3）。请先备份存储文件，确认后在部署环境设置 XINGJI_DB_ALLOW_MIGRATION=1 并重启。");
      }
    } else if (version !== 0) {
      throw new SqliteStoreError("STORE_UNAVAILABLE", "存储版本或结构不受支持。");
    }

    database.exec(`PRAGMA busy_timeout = ${SQLITE_LIMITS.busyTimeoutMs}`);
    // 已确认是本库之后才切换日志模式。
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = FULL");

    if (!existed) {
      database.exec("BEGIN IMMEDIATE");
      try {
        createMemoryTables(database);
        createSessionTables(database);
        createAttemptTables(database);
        database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } else if (version < SCHEMA_VERSION) {
      // v1/v2 → v3：一个事务；既有 Memory、会话行、revision 与许可原值不动。
      // v3 只**新增**制图尝试表，不改既有表结构。失败整批回滚，保留原版本。
      // 进入升级前先写原库备份（已确认放行才会走到这里）。
      backupBeforeUpgrade(database, dbPath, version);
      database.exec("BEGIN IMMEDIATE");
      try {
        if (version === MEMORY_SCHEMA_VERSION) createSessionTables(database);
        createAttemptTables(database);
        database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        database.exec("COMMIT");
      } catch {
        database.exec("ROLLBACK");
        throw new SqliteStoreError("STORE_UNAVAILABLE", "存储升级失败，未做任何修改。");
      }
    }

    try {
      chmodSync(dbPath, 0o600);
    } catch {
      /* 某些文件系统不支持 chmod：不因此判定失败 */
    }
    return database;
  } catch (error) {
    database.close();
    throw error instanceof SqliteStoreError ? error : new SqliteStoreError("STORE_UNAVAILABLE", "存储不可用。");
  }
}

export function withDatabase<T>(dbPath: string | undefined, run: (database: DatabaseSync) => T): T {
  const database = openDatabase(dbPath ?? resolveDatabasePath());
  try {
    return run(database);
  } finally {
    database.close();
  }
}

/** 事务包装：整批成功或整批回滚，并把占用与校验错误区分开。 */
export function inTransaction<T>(database: DatabaseSync, run: () => T, mapError: (error: unknown, busy: boolean) => never): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const value = run();
    database.exec("COMMIT");
    return value;
  } catch (error) {
    database.exec("ROLLBACK");
    const message = error instanceof Error ? error.message : "";
    return mapError(error, /SQLITE_BUSY|database is locked|database table is locked/i.test(message));
  }
}
