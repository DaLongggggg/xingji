/**
 * T1 认证核心（连续实施任务书 §4.1）：控制库账号/会话/限速，CLI 与 HTTP 共用。
 *
 * 冻结参数：scrypt N=32768/r=8/p=1/keyLen=32/maxmem=64MiB + timingSafeEqual；
 * 用户名 5 次失败锁 15 分钟（持久化跨重启）；IP 60 秒 30 次（有界进程内窗口，
 * 只信 start-beta 注入的 peer 元数据，不信任 X-Forwarded-For）。
 * 通道：Authorization 一旦存在（含空值）必须为有效 Bearer，否则 401 不回退 Cookie；
 * 有效 Bearer 与 Cookie 并存用 Bearer；Cookie 仅桌面（HttpOnly SameSite=Lax），
 * 闲置 14 天滑动（节流续期不超过剩余绝对期限）、绝对 90 天；Bearer 续期不建 Cookie。
 * 自包含：CLI 经相对路径共享，只用可擦除 TS 语法。
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { initBetaRoot, openServiceDb, serviceDbPath } from "./beta-data.ts";

// 同实例出口：门闸状态的读写与认证核心共享同一 beta-data 绑定（防别名路径分叉）。
export { setIsolationReadyForTests, isIsolationReady } from "./beta-data.ts";

export const AUTH_LIMITS = {
  idleMs: Number(process.env.XINGJI_AUTH_IDLE_MS || 14 * 24 * 3600_000),
  absoluteMs: Number(process.env.XINGJI_AUTH_ABSOLUTE_MS || 90 * 24 * 3600_000),
  touchThrottleMs: Number(process.env.XINGJI_AUTH_TOUCH_MS || 60_000),
  ipMax: Number(process.env.XINGJI_AUTH_IP_MAX || 30),
  ipWindowMs: Number(process.env.XINGJI_AUTH_IP_WINDOW_MS || 60_000),
  lockThreshold: Number(process.env.XINGJI_AUTH_LOCK_THRESHOLD || 5),
  lockMs: Number(process.env.XINGJI_AUTH_LOCK_MS || 15 * 60_000)
};

const SCRYPT = { N: 32768, r: 8, p: 1, keyLen: 32, maxmem: 64 * 1024 * 1024 };
const SCRYPT_OPTIONS = { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem };
export const SESSION_COOKIE = "xingji_session";
export const PEER_HEADER = "x-xingji-peer";
/**
 * T4/T2a 复核四：LAN 代理会把 Host 改写为内部地址（Next 路由需要），浏览器 Origin
 * 仍是外部公开地址——同源判定必须用**入口签名过的原始 Host**，否则正常同源请求被误拒。
 * 代理用同一 peerKey HMAC 签名原始 Host；直连内部地址（仅回环）无此头，回退真实 Host。
 */
export const TRUSTED_HOST_HEADER = "x-xingji-host";

const now = () => Date.now();
export const iso = (t: number) => new Date(t).toISOString();
const fromIso = (s: string) => Date.parse(s);
export const tokenHash = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

/* ---------- 密码 ---------- */
export function hashPassword(password: string): { salt: string; hash: string } {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT.keyLen, SCRYPT_OPTIONS);
  return { salt: salt.toString("base64"), hash: key.toString("base64") };
}

export function verifyPassword(password: string, saltB64: string, hashB64: string): boolean {
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  const actual = scryptSync(password, salt, expected.length, SCRYPT_OPTIONS);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/* ---------- peer 元数据（start-beta 注入进程私密密钥；直接 Next 无可信元数据） ---------- */
let peerKey: string | null = process.env.XINGJI_PEER_KEY || null;
export function configurePeerKey(key: string): void {
  peerKey = key;
}
export function peerTrusted(): boolean {
  return peerKey !== null;
}
/** 校验 start-beta 注入的 peer 元数据；无密钥或校验失败返回 null（不可信）。 */
export function verifyPeerMetadata(peerHeaderValue: string | null): string | null {
  if (!peerKey || !peerHeaderValue) return null;
  const sep = peerHeaderValue.lastIndexOf("|");
  if (sep <= 0) return null;
  const address = peerHeaderValue.slice(0, sep);
  const mac = peerHeaderValue.slice(sep + 1);
  const expected = createHmac("sha256", peerKey).update(address).digest("hex");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? address : null;
}

/* ---------- 控制库单例（按进程缓存；CLI 每命令一次性打开亦可） ---------- */
let cachedDb: DatabaseSync | null = null;
export function serviceDb(): DatabaseSync {
  if (!cachedDb) {
    initBetaRoot();
    cachedDb = openServiceDb();
  }
  return cachedDb;
}
export function closeServiceDb(): void {
  try {
    cachedDb?.close();
  } catch {
    /* 尽力 */
  }
  cachedDb = null;
}

/* ---------- 用户（CLI 与登录共用；全部普通用户语义） ---------- */
export type BetaUser = { id: string; username: string; status: string };

export function createUser(db: DatabaseSync, username: string): { id: string; username: string; password: string } {
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) throw new Error("用户名需为 3-32 位字母数字_-");
  const password = randomBytes(16).toString("base64url");
  const { salt, hash } = hashPassword(password);
  const id = `usr-${randomBytes(12).toString("hex")}`;
  const t = iso(now());
  db.prepare(
    "INSERT INTO users(id, username, salt, password_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)"
  ).run(id, username, salt, hash, t, t);
  return { id, username, password };
}

export function userByName(db: DatabaseSync, username: string): { id: string; username: string; salt: string; password_hash: string; status: string } | undefined {
  return db.prepare("SELECT id, username, salt, password_hash, status FROM users WHERE username = ?").get(username) as
    | { id: string; username: string; salt: string; password_hash: string; status: string }
    | undefined;
}

export function listUsers(db: DatabaseSync): Array<Record<string, unknown>> {
  return db
    .prepare(
      "SELECT u.id, u.username, u.status, u.created_at, (SELECT COUNT(*) FROM auth_sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.absolute_expires_at > ?) AS active_sessions FROM users u ORDER BY u.created_at"
    )
    .all(iso(now()));
}

export function setUserStatus(db: DatabaseSync, username: string, status: "active" | "disabled"): boolean {
  const user = userByName(db, username);
  if (!user) return false;
  db.prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ?").run(status, iso(now()), user.id);
  if (status === "disabled") {
    db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(iso(now()), user.id);
  }
  return true;
}

export function resetPassword(db: DatabaseSync, username: string): { password: string } | null {
  const user = userByName(db, username);
  if (!user) return null;
  const password = randomBytes(16).toString("base64url");
  const { salt, hash } = hashPassword(password);
  db.prepare("UPDATE users SET salt = ?, password_hash = ?, updated_at = ? WHERE id = ?").run(salt, hash, iso(now()), user.id);
  db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(iso(now()), user.id);
  return { password };
}

export function revokeSessions(db: DatabaseSync, username: string, deviceLabel?: string): number {
  const user = userByName(db, username);
  if (!user) return 0;
  const result = deviceLabel
    ? db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND device_label = ? AND revoked_at IS NULL").run(iso(now()), user.id, deviceLabel)
    : db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(iso(now()), user.id);
  return Number(result.changes);
}

/* ---------- 登录限速：用户名持久锁定 + IP 进程内窗口 ---------- */
export function usernameLock(db: DatabaseSync, username: string): { locked: boolean; lockedUntil: string | null; failCount: number } {
  const row = db.prepare("SELECT fail_count, locked_until FROM login_throttle WHERE username = ?").get(username) as { fail_count: number; locked_until: string | null } | undefined;
  const lockedUntil = row?.locked_until ?? null;
  return { locked: !!(lockedUntil && fromIso(lockedUntil) > now()), lockedUntil, failCount: row?.fail_count ?? 0 };
}

export function recordLoginFailure(db: DatabaseSync, username: string): string | null {
  const current = usernameLock(db, username);
  if (current.locked) return current.lockedUntil;
  const failCount = current.failCount + 1;
  const lockedUntil = failCount >= AUTH_LIMITS.lockThreshold ? iso(now() + AUTH_LIMITS.lockMs) : current.lockedUntil;
  db.prepare(
    "INSERT INTO login_throttle(username, fail_count, locked_until, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(username) DO UPDATE SET fail_count = excluded.fail_count, locked_until = excluded.locked_until, updated_at = excluded.updated_at"
  ).run(username, failCount, lockedUntil, iso(now()));
  return lockedUntil;
}

export function clearLoginFailures(db: DatabaseSync, username: string): void {
  db.prepare("DELETE FROM login_throttle WHERE username = ?").run(username);
}

const ipAttempts = new Map<string, number[]>();
export function ipGate(address: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const t = now();
  let attempts = ipAttempts.get(address);
  if (!attempts) {
    attempts = [];
    ipAttempts.set(address, attempts);
  }
  while (attempts.length && t - attempts[0] > AUTH_LIMITS.ipWindowMs) attempts.shift();
  if (attempts.length >= AUTH_LIMITS.ipMax) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((attempts[0] + AUTH_LIMITS.ipWindowMs - t) / 1000)) };
  }
  attempts.push(t);
  if (ipAttempts.size > 10_000) {
    for (const [key, value] of ipAttempts) {
      if (!value.length || t - value[value.length - 1] > AUTH_LIMITS.ipWindowMs) ipAttempts.delete(key);
    }
  }
  return { allowed: true };
}

/* ---------- 会话 ---------- */
export function createSession(db: DatabaseSync, userId: string, deviceLabel: string, transport: "bearer" | "cookie"): string {
  const token = randomBytes(32).toString("base64url");
  const t = now();
  db.prepare(
    "INSERT INTO auth_sessions(id, user_id, device_label, transport, created_at, last_seen_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(tokenHash(token), userId, deviceLabel || "", transport, iso(t), iso(t), iso(t + AUTH_LIMITS.absoluteMs));
  return token;
}

export function sessionCookieHeader(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  const entry = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return entry ? entry.slice(name.length + 1) : null;
}

export type AuthFailure = { error: "NO_CREDENTIAL" | "SESSION_NOT_FOUND" | "SESSION_REVOKED" | "SESSION_EXPIRED_IDLE" | "SESSION_EXPIRED_ABSOLUTE" | "USER_DISABLED" };
export type AuthSuccess = {
  user: BetaUser;
  session: { id: string; deviceLabel: string; transport: "bearer" | "cookie"; absoluteExpiresAt: string };
  channel: "bearer" | "cookie";
  renewedCookie: string | null;
};

/** 会话认证：Authorization 一旦存在（含空值）必须为有效 Bearer，否则不回退 Cookie。 */
export function authenticateSession(db: DatabaseSync, authorizationHeader: string | null, cookieHeader: string | null): AuthSuccess | AuthFailure {
  let token: string | null = null;
  let channel: "bearer" | "cookie" | null = null;
  if (authorizationHeader !== null) {
    if (!authorizationHeader.startsWith("Bearer ")) return { error: "NO_CREDENTIAL" };
    const bearer = authorizationHeader.slice(7).trim();
    if (!bearer) return { error: "NO_CREDENTIAL" };
    token = bearer;
    channel = "bearer";
  } else {
    const cookie = readCookie(cookieHeader, SESSION_COOKIE);
    if (cookie) {
      token = cookie;
      channel = "cookie";
    }
  }
  if (!token || !channel) return { error: "NO_CREDENTIAL" };
  const row = db
    .prepare(
      "SELECT s.id, s.user_id, s.device_label, s.transport, s.created_at, s.last_seen_at, s.absolute_expires_at, s.revoked_at, u.username, u.status AS user_status " +
        "FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?"
    )
    .get(tokenHash(token)) as
    | { id: string; user_id: string; device_label: string; transport: "bearer" | "cookie"; created_at: string; last_seen_at: string; absolute_expires_at: string; revoked_at: string | null; username: string; user_status: string }
    | undefined;
  if (!row) return { error: "SESSION_NOT_FOUND" };
  if (row.revoked_at) return { error: "SESSION_REVOKED" };
  if (row.user_status !== "active") return { error: "USER_DISABLED" };
  if (fromIso(row.absolute_expires_at) <= now()) return { error: "SESSION_EXPIRED_ABSOLUTE" };
  if (now() - fromIso(row.last_seen_at) > AUTH_LIMITS.idleMs) return { error: "SESSION_EXPIRED_IDLE" };
  let renewedCookie: string | null = null;
  if (now() - fromIso(row.last_seen_at) > AUTH_LIMITS.touchThrottleMs) {
    db.prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?").run(iso(now()), row.id);
    if (channel === "cookie") {
      const remainingSeconds = Math.max(0, Math.floor((fromIso(row.absolute_expires_at) - now()) / 1000));
      const maxAge = Math.max(0, Math.min(Math.floor(AUTH_LIMITS.idleMs / 1000), remainingSeconds));
      renewedCookie = sessionCookieHeader(token, maxAge);
    }
  }
  return {
    user: { id: row.user_id, username: row.username, status: row.user_status },
    session: { id: row.id, deviceLabel: row.device_label, transport: row.transport, absoluteExpiresAt: row.absolute_expires_at },
    channel,
    renewedCookie
  };
}

/** 登录：校验密码并签发会话（transport 决定回包携带方式，不授予身份）。 */
export function loginWithPassword(
  db: DatabaseSync,
  username: string,
  password: string,
  transport: "bearer" | "cookie",
  deviceLabel: string,
  peerAddress: string | null
): { ok: true; token: string; user: BetaUser; expiresAt: string } | { ok: false; code: "LOGIN_FAILED" | "LOGIN_LOCKED" | "LOGIN_RATE_LIMITED" | "PEER_UNTRUSTED" | "USER_DISABLED"; lockedUntil?: string; retryAfterSeconds?: number } {
  if (!peerTrusted() || peerAddress === null) return { ok: false, code: "PEER_UNTRUSTED" };
  const gate = ipGate(peerAddress);
  if (!gate.allowed) return { ok: false, code: "LOGIN_RATE_LIMITED", retryAfterSeconds: gate.retryAfterSeconds };
  const lock = usernameLock(db, username);
  if (lock.locked && lock.lockedUntil) return { ok: false, code: "LOGIN_LOCKED", lockedUntil: lock.lockedUntil };
  const user = userByName(db, username);
  if (!user) {
    // 不存在的用户也做一次 scrypt，保持常量时间形状。
    scryptSync(password, Buffer.from("xingji-unknown-user"), SCRYPT.keyLen, SCRYPT_OPTIONS);
    const lockedUntil = recordLoginFailure(db, username);
    return { ok: false, code: "LOGIN_FAILED", lockedUntil: lockedUntil ?? undefined };
  }
  if (!verifyPassword(password, user.salt, user.password_hash)) {
    const lockedUntil = recordLoginFailure(db, username);
    return { ok: false, code: "LOGIN_FAILED", lockedUntil: lockedUntil ?? undefined };
  }
  if (user.status !== "active") return { ok: false, code: "USER_DISABLED" };
  clearLoginFailures(db, username);
  const token = createSession(db, user.id, deviceLabel, transport);
  return { ok: true, token, user: { id: user.id, username: user.username, status: user.status }, expiresAt: iso(now() + AUTH_LIMITS.idleMs) };
}
