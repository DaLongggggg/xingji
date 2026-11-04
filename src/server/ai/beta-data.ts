/**
 * 移动端内测数据根（T1）：`.local/mobile-beta/` 的解析、显式 init 与控制库 service.sqlite。
 *
 * 边界（连续实施任务书 §2.1）：
 * - 仅服务本任务新建的隔离资料；不迁移、不升级、不清空、不自动归属任何现有私人库。
 * - init 与正常启动分离：init 幂等（存在且标记匹配即无操作），存在非空无标记/未知版本即拒绝。
 * - 根路径链上出现 symlink（realpath 不等于字面路径）即拒绝。
 * - control 库含 schema 角色与版本标记，不能只凭 user_version 认库。
 * 自包含模块：CLI（scripts/account.ts）经相对路径共享，只使用可擦除 TS 语法。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, readdirSync, realpathSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const BETA_ROOT_ENV = "XINGJI_BETA_ROOT";
export const SERVICE_DB_NAME = "service.sqlite";
export const MANIFEST_NAME = "beta-manifest.json";
export const SERVICE_SCHEMA_VERSION = 1;

export type BetaManifest = { formatVersion: 1; serverId: string; createdAt: string };

export function defaultBetaRoot(): string {
  return path.join(process.cwd(), ".local", "mobile-beta");
}

export function resolveBetaRoot(): string {
  const fromEnv = process.env[BETA_ROOT_ENV];
  if (fromEnv !== undefined && fromEnv !== "") {
    if (!path.isAbsolute(fromEnv)) throw new Error(`${BETA_ROOT_ENV} 必须是绝对路径`);
    return fromEnv;
  }
  return defaultBetaRoot();
}

function assertNoSymlink(root: string): void {
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    return; // 不存在由调用方处理
  }
  if (real !== root) throw new Error(`beta 根路径包含符号链接，拒绝：${root}`);
}

/** 根内受控路径：resolve 后必须仍落在 root 内（防路径穿越），片段只接受白名单常量或 UUID。 */
export function pathInsideRoot(root: string, ...segments: string[]): string {
  const target = path.resolve(root, ...segments);
  const normalizedRoot = path.resolve(root);
  if (target !== normalizedRoot && !target.startsWith(normalizedRoot + path.sep)) {
    throw new Error("路径越出 beta 根，拒绝");
  }
  return target;
}

export function serviceDbPath(root: string = resolveBetaRoot()): string {
  return pathInsideRoot(root, SERVICE_DB_NAME);
}

export function betaRootStatus(root: string = resolveBetaRoot()): { root: string; initialized: boolean; manifest?: BetaManifest; problem?: string } {
  if (!existsSync(root)) return { root, initialized: false };
  assertNoSymlink(root);
  const manifestPath = pathInsideRoot(root, MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    const entries = readdirSync(root);
    if (entries.length > 0) return { root, initialized: false, problem: "目录非空且缺少 beta-manifest.json，拒绝复用未知目录" };
    return { root, initialized: false };
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BetaManifest;
    if (manifest.formatVersion !== 1 || typeof manifest.serverId !== "string" || !manifest.serverId) {
      return { root, initialized: false, problem: "beta-manifest.json 版本不符，拒绝复用" };
    }
    return { root, initialized: true, manifest };
  } catch (e) {
    return { root, initialized: false, problem: `beta-manifest.json 损坏：${String((e as Error)?.message || e)}` };
  }
}

const SERVICE_SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS beta_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
  salt TEXT NOT NULL, password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS auth_sessions(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  device_label TEXT NOT NULL DEFAULT '',
  transport TEXT NOT NULL DEFAULT 'bearer',
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL, revoked_at TEXT)`,
  "CREATE TABLE IF NOT EXISTS login_throttle(username TEXT PRIMARY KEY, fail_count INTEGER NOT NULL DEFAULT 0, locked_until TEXT, updated_at TEXT NOT NULL)"
];

/** 显式 init：创建根、manifest 与 service.sqlite（幂等；非空无标记/未知版本/symlink 拒绝）。 */
export function initBetaRoot(root: string = resolveBetaRoot()): { ok: true; root: string; serverId: string; created: boolean } {
  if (existsSync(root)) assertNoSymlink(root);
  const status = betaRootStatus(root);
  if (status.problem) throw new Error(status.problem);
  const created = !status.initialized;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let serverId: string;
  if (status.initialized && status.manifest) {
    serverId = status.manifest.serverId;
  } else {
    serverId = randomUUID();
    writeFileSync(pathInsideRoot(root, MANIFEST_NAME), `${JSON.stringify({ formatVersion: 1, serverId, createdAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  }
  const db = new DatabaseSync(serviceDbPath(root));
  try {
    // PRAGMA/DDL 均为常量 SQL 文本，经 prepare 执行（不是 shell 命令）。
    db.prepare("PRAGMA journal_mode=WAL").get();
    db.prepare("PRAGMA busy_timeout=3000").get();
    db.prepare("PRAGMA foreign_keys=ON").run();
    if (!created) {
      const role = db.prepare("SELECT value FROM beta_meta WHERE key='schema_role'").get()?.value;
      const version = db.prepare("SELECT value FROM beta_meta WHERE key='schema_version'").get()?.value;
      if (role !== "service" || !["1", "2"].includes(String(version))) throw new Error("service 库角色或版本未知，拒绝 init");
      return { ok: true, root, serverId, created: false };
    }
    for (const statement of SERVICE_SCHEMA_STATEMENTS) {
      db.prepare(statement).run();
    }
    db.prepare("INSERT INTO beta_meta(key, value) VALUES('schema_role','service') ON CONFLICT(key) DO NOTHING").run();
    db.prepare("INSERT INTO beta_meta(key, value) VALUES('schema_version', ?)").run(String(SERVICE_SCHEMA_VERSION));
  } finally {
    db.close();
  }
  return { ok: true, root, serverId, created };
}

/** 打开控制库：角色/版本标记不符即拒绝（不能只凭 user_version 认库）。 */
export function openServiceDb(root: string = resolveBetaRoot()): DatabaseSync {
  if (!existsSync(serviceDbPath(root))) throw new Error("beta 根未初始化：先运行 account init");
  assertNoSymlink(root);
  const db = new DatabaseSync(serviceDbPath(root));
  const role = db.prepare("SELECT value FROM beta_meta WHERE key = 'schema_role'").get()?.value;
  const version = db.prepare("SELECT value FROM beta_meta WHERE key = 'schema_version'").get()?.value;
  if (role !== "service" || !["1", "2"].includes(String(version))) {
    db.close();
    throw new Error(`service 库 schema 标记不符（role=${String(role)} version=${String(version)}），拒绝打开`);
  }
  db.prepare("PRAGMA busy_timeout=3000").get();
  db.prepare("PRAGMA foreign_keys=ON").run();
  return db;
}

/* ---------- T1 隔离门闸状态 ----------
 * 生产默认 false：T2a 未接通的私有业务对有效账号也返回 503 BETA_ISOLATION_PENDING。
 * 仅测试夹具可显式置 true（独立 vitest 进程内的注入，不是运行时环境开关）；T2a 起由真实 UserScope 就绪状态接管。
 */
let isolationReadyForTests = false;
export function setIsolationReadyForTests(v: boolean): void {
  isolationReadyForTests = v;
}
export function isIsolationReady(): boolean {
  return isolationReadyForTests;
}

/** 当前 serverId（未初始化返回 null）。 */
export function currentServerId(): string | null {
  const status = betaRootStatus();
  return status.initialized && status.manifest ? status.manifest.serverId : null;
}

/** 用户根（T2a 使用，这里先提供解析与 symlink 防御）。 */
export function userRoot(serverId: string, userId: string, root: string = resolveBetaRoot()): string {
  const userDir = pathInsideRoot(root, "users", userId);
  if (existsSync(userDir) && realpathSync(userDir) !== userDir) throw new Error("用户目录包含符号链接，拒绝");
  return userDir;
}
