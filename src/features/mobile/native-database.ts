/** One native business database. All SQL callers share this connection and transaction queue. */
export type NativeActor = Readonly<{ serverId: string; userId: string; datasetId: string }>;
export type NativeAccount = Readonly<Pick<NativeActor, "serverId" | "userId">>;
export type SqlValue = string | number | null;
export interface NativeSqlConnection {
  query(sql: string, values?: SqlValue[]): Promise<{ values?: Record<string, unknown>[] }>;
  run(sql: string, values?: SqlValue[], transaction?: boolean): Promise<unknown>;
  execute(sql: string, transaction?: boolean): Promise<unknown>;
  beginTransaction(): Promise<unknown>;
  commitTransaction(): Promise<unknown>;
  rollbackTransaction(): Promise<unknown>;
}

export class StaleNativeDatasetError extends Error {
  constructor() { super("NATIVE_DATASET_STALE"); this.name = "StaleNativeDatasetError"; }
}
export class NativeDatabaseBlockedError extends Error {
  constructor() { super("NATIVE_DATABASE_ROLE_OR_VERSION_UNSUPPORTED"); this.name = "NativeDatabaseBlockedError"; }
}

export function actorValues(actor: NativeActor): SqlValue[] {
  validateAccount(actor);
  if (!actor.datasetId || actor.datasetId.length > 200) throw new Error("NATIVE_ACTOR_INVALID");
  return [actor.serverId, actor.userId, actor.datasetId];
}
export function validateAccount(account: NativeAccount): void {
  if (![account.serverId, account.userId].every((v) => typeof v === "string" && v.length > 0 && v.length <= 200)) {
    throw new Error("NATIVE_ACTOR_INVALID");
  }
}
export const ACTOR_WHERE = "server_id = ? AND user_id = ? AND dataset_id = ?";
const OWNER_COLUMNS = "server_id TEXT NOT NULL, user_id TEXT NOT NULL, dataset_id TEXT NOT NULL";
const OWNER_FK = "FOREIGN KEY(server_id,user_id,dataset_id) REFERENCES mobile_datasets(server_id,user_id,dataset_id) ON DELETE CASCADE";
const SCHEMA = [
  "CREATE TABLE mobile_schema (id INTEGER PRIMARY KEY CHECK(id=1), role TEXT NOT NULL, version INTEGER NOT NULL)",
  `CREATE TABLE mobile_datasets (${OWNER_COLUMNS}, created_at INTEGER NOT NULL, PRIMARY KEY(server_id,user_id,dataset_id))`,
  "CREATE TABLE mobile_accounts (server_id TEXT NOT NULL, user_id TEXT NOT NULL, dataset_id TEXT NOT NULL, PRIMARY KEY(server_id,user_id), FOREIGN KEY(server_id,user_id,dataset_id) REFERENCES mobile_datasets(server_id,user_id,dataset_id))",
  `CREATE TABLE mobile_archives (${OWNER_COLUMNS}, kind TEXT NOT NULL CHECK(kind IN ('notebook','capture')), revision INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(server_id,user_id,dataset_id,kind), ${OWNER_FK})`,
  `CREATE TABLE mobile_media (${OWNER_COLUMNS}, media_id TEXT NOT NULL, path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, size INTEGER NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(server_id,user_id,dataset_id,media_id), ${OWNER_FK})`,
  `CREATE TABLE mobile_media_links (${OWNER_COLUMNS}, kind TEXT NOT NULL, media_id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(server_id,user_id,dataset_id,kind,media_id), FOREIGN KEY(server_id,user_id,dataset_id,media_id) REFERENCES mobile_media(server_id,user_id,dataset_id,media_id) ON DELETE CASCADE)`,
  `CREATE TABLE mobile_records (${OWNER_COLUMNS}, kind TEXT NOT NULL CHECK(kind IN ('task','proposal','metadata','session','message','memory','skill','kv')), record_id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(server_id,user_id,dataset_id,kind,record_id), ${OWNER_FK})`,
  `CREATE TABLE tasks_inbox (${OWNER_COLUMNS}, task_id TEXT NOT NULL, digest TEXT NOT NULL, chat_session_id TEXT NOT NULL, applied_at TEXT NOT NULL, acked_at TEXT, PRIMARY KEY(server_id,user_id,dataset_id,task_id), ${OWNER_FK})`,
  `CREATE TABLE mobile_inflight (${OWNER_COLUMNS}, operation_id TEXT NOT NULL, media_id TEXT NOT NULL, temporary_path TEXT NOT NULL UNIQUE, final_path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, size INTEGER NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(server_id,user_id,dataset_id,operation_id), ${OWNER_FK})`
];

export class NativeDatabase {
  private tail: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private poisoned = false;
  constructor(readonly connection: NativeSqlConnection) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.poisoned) throw new Error("NATIVE_DATABASE_REOPEN_REQUIRED");
      return operation();
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
  async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values: SqlValue[] = []): Promise<T[]> {
    return (await this.connection.query(sql, values)).values as T[] ?? [];
  }
  /** Explicit transaction owns every statement; never let the plugin nest an automatic transaction. */
  async run(sql: string, values: SqlValue[] = []): Promise<void> {
    await this.connection.run(sql, values, false);
  }
  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.connection.execute("PRAGMA foreign_keys = ON", false);
    const tables = await this.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    if (tables.length) {
      if (!tables.some((row) => row.name === "mobile_schema")) throw new NativeDatabaseBlockedError();
      const rows = await this.query("SELECT id,role,version FROM mobile_schema");
      if (rows.length !== 1 || rows[0].id !== 1 || rows[0].role !== "xingji-mobile-business" || rows[0].version !== 1 || SCHEMA.some((sql) => !tables.some((row) => row.name === /^CREATE TABLE (\w+)/.exec(sql)?.[1]))) {
        throw new NativeDatabaseBlockedError();
      }
    } else {
      await this.connection.beginTransaction();
      try {
        for (const sql of SCHEMA) await this.run(sql);
        await this.run("INSERT INTO mobile_schema(id,role,version) VALUES(1,'xingji-mobile-business',1)");
        await this.connection.commitTransaction();
      } catch (error) {
        await this.connection.rollbackTransaction().catch(() => { this.poisoned = true; });
        throw error;
      }
    }
    this.initialized = true;
  }
  transaction<T>(operation: (database: NativeDatabase) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      await this.initialize();
      await this.connection.beginTransaction();
      try {
        const result = await operation(this);
        await this.connection.commitTransaction();
        return result;
      } catch (error) {
        // A failed COMMIT may be ambiguous. A rollback failure poisons this handle until reopen.
        await this.connection.rollbackTransaction().catch(() => { this.poisoned = true; });
        throw error;
      }
    });
  }
  async assertActor(actor: NativeActor): Promise<void> {
    const rows = await this.query("SELECT dataset_id FROM mobile_accounts WHERE server_id=? AND user_id=?", actorValues(actor).slice(0, 2));
    if (rows[0]?.dataset_id !== actor.datasetId) throw new StaleNativeDatasetError();
  }
  async account(account: NativeAccount, newDatasetId: () => Promise<string>): Promise<NativeActor> {
    validateAccount(account);
    const datasetId = await newDatasetId();
    return this.transaction(async () => {
      const existing = await this.query("SELECT dataset_id FROM mobile_accounts WHERE server_id=? AND user_id=?", [account.serverId, account.userId]);
      if (existing.length) return Object.freeze({ ...account, datasetId: String(existing[0].dataset_id) });
      const actor = Object.freeze({ ...account, datasetId });
      await this.run("INSERT INTO mobile_datasets(server_id,user_id,dataset_id,created_at) VALUES(?,?,?,?)", [...actorValues(actor), Date.now()]);
      await this.run("INSERT INTO mobile_accounts(server_id,user_id,dataset_id) VALUES(?,?,?)", actorValues(actor));
      return actor;
    });
  }
  /** Capture the initiating actor. Clearing B never resolves a later global/current actor. */
  /** R6：清空+轮换+清理线索同一事务（extra 在轮换 SQL 内执行，任何失败整体回滚）。 */
  async clearAccountWithCleanup(actor: NativeActor, datasetId: string, extra: (db: NativeDatabase) => Promise<void>): Promise<NativeActor> {
    const next = Object.freeze({ serverId: actor.serverId, userId: actor.userId, datasetId });
    actorValues(next);
    if (datasetId === actor.datasetId) throw new Error("NATIVE_DATASET_MUST_ROTATE");
    return this.transaction(async () => {
      await this.assertActor(actor);
      await this.run("INSERT INTO mobile_datasets(server_id,user_id,dataset_id,created_at) VALUES(?,?,?,?)", [...actorValues(next), Date.now()]);
      await this.run("UPDATE mobile_accounts SET dataset_id=? WHERE server_id=? AND user_id=?", [datasetId, actor.serverId, actor.userId]);
      await this.run(`DELETE FROM mobile_datasets WHERE ${ACTOR_WHERE}`, actorValues(actor));
      await extra(this);
      return next;
    });
  }

  async clearAccount(actor: NativeActor, datasetId: string): Promise<NativeActor> {
    const next = Object.freeze({ serverId: actor.serverId, userId: actor.userId, datasetId });
    actorValues(next);
    if (datasetId === actor.datasetId) throw new Error("NATIVE_DATASET_MUST_ROTATE");
    return this.transaction(async () => {
      await this.assertActor(actor);
      await this.run("INSERT INTO mobile_datasets(server_id,user_id,dataset_id,created_at) VALUES(?,?,?,?)", [...actorValues(next), Date.now()]);
      await this.run("UPDATE mobile_accounts SET dataset_id=? WHERE server_id=? AND user_id=?", [datasetId, actor.serverId, actor.userId]);
      await this.run(`DELETE FROM mobile_datasets WHERE ${ACTOR_WHERE}`, actorValues(actor));
      return next;
    });
  }
}

let nativeDatabasePromise: Promise<NativeDatabase> | undefined;
/** Native only: no Web/IDB fallback, and no per-repository connections. */
export function openNativeDatabase(): Promise<NativeDatabase> {
  nativeDatabasePromise ??= (async () => {
    const { Capacitor } = await import("@capacitor/core");
    if (!Capacitor.isNativePlatform()) throw new Error("NATIVE_SQLITE_REQUIRED");
    const { CapacitorSQLite, SQLiteConnection } = await import("@capacitor-community/sqlite");
    const manager = new SQLiteConnection(CapacitorSQLite);
    const name = "xingji-mobile-business-v1";
    // 插件连接比 WebView 页面存活更久。刷新可能打断显式事务，必须先回滚再关库；
    // Android 直接关闭仍在事务内的连接会遗留被占用的连接池，后续 open 被锁住。
    let connection;
    if ((await manager.isConnection(name, false)).result) {
      connection = await manager.retrieveConnection(name, false);
    } else {
      try {
        connection = await manager.createConnection(name, false, "no-encryption", 1, false);
      } catch (error) {
        if (!/already exists/i.test(error instanceof Error ? error.message : String(error))) throw error;
        if ((await CapacitorSQLite.isTransactionActive({ database: name, readonly: false })).result) {
          await CapacitorSQLite.rollbackTransaction({ database: name, readonly: false });
        }
        await manager.closeConnection(name, false);
        connection = await manager.createConnection(name, false, "no-encryption", 1, false);
      }
    }
    await connection.open();
    return new NativeDatabase(connection);
  })().catch((error) => { nativeDatabasePromise = undefined; throw error; });
  return nativeDatabasePromise;
}
