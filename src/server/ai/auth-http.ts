/**
 * T1 认证 HTTP 层（连续实施任务书 §4.1/§4.2）：
 * - requireBetaAccess：所有私有路由的统一门闸——先认证（401），再检查 beta 根初始化
 *   （503 BETA_NOT_INITIALIZED）与隔离就绪（503 BETA_ISOLATION_PENDING，T2a 逐项解除）。
 * - login/logout/password/session 处理器：路由文件只做薄壳导出。
 * 失败语义沿用 R 契约：坏/空 Authorization 一律 401 不回退；公开仅 health/login；
 * 普通错误回包不输出秘密。处理器只依赖 headers/body 结构（Next Request 结构兼容），
 * 本模块不做任何出站网络访问。
 */
import {
  AUTH_LIMITS,
  SESSION_COOKIE,
  authenticateSession,
  closeServiceDb,
  loginWithPassword,
  PEER_HEADER,
  TRUSTED_HOST_HEADER,
  serviceDb,
  sessionCookieHeader,
  verifyPassword,
  verifyPeerMetadata,
  hashPassword,
  iso
} from "./auth-store.ts";
import { currentServerId, isIsolationReady, resolveBetaRoot, betaRootStatus } from "./beta-data.ts";
import { buildScopeEnv, deriveUserPaths, enterBetaScope } from "./user-scope.ts";

let betaTestUser: { id: string; username: string } | null = null;
/** 仅测试夹具使用：注入恒定测试身份（生产路径恒为 null）。 */
export function setBetaTestUserOverride(user: { id: string; username: string } | null): void {
  betaTestUser = user;
}
function betaTestUserOverride(): { id: string; username: string } | null {
  return betaTestUser;
}

// 统一绑定出口：门闸状态的读写必须与 requireBetaAccess 同模块实例，
// 避免别名路径（@/…beta-data）与本文件（./beta-data.ts）解析出两份模块状态。
export { setIsolationReadyForTests, isIsolationReady } from "./beta-data.ts";
export { runInBetaScope, enterBetaScope, currentBetaScope, currentScopeEnv, isBetaScopeActive, deriveUserPaths, buildScopeEnv, type UserScopePaths, type BetaScopeEnv } from "./user-scope.ts";

const MAX_AUTH_BODY_BYTES = 64 * 1024;

/** Next Request 的结构子集（仅 headers/body 访问；不携带网络语义）。 */
type HeadersLike = { get(name: string): string | null };
type IncomingCall = { headers: HeadersLike; body: ReadableStream<Uint8Array> | null };

export function authJson(payload: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders }
  });
}

const AUTH_FAILURE_STATUS: Record<string, number> = {
  NO_CREDENTIAL: 401,
  SESSION_NOT_FOUND: 401,
  SESSION_REVOKED: 401,
  SESSION_EXPIRED_IDLE: 401,
  SESSION_EXPIRED_ABSOLUTE: 401,
  USER_DISABLED: 401
};

function authFailureResponse(error: string): Response {
  const status = AUTH_FAILURE_STATUS[error] ?? 401;
  return authJson({ ok: false, error }, status);
}

/**
 * 私有路由统一门闸。顺序：认证（401）→ beta 根初始化（503 BETA_NOT_INITIALIZED）→
 * 隔离就绪（503 BETA_ISOLATION_PENDING）。通过返回 undefined。
 * 说明：cookie 通道的节流续期在认证内已落库；Max-Age 刷新头自 T2a 业务放行时随响应携带。
 */
export function requireBetaAccess(input: IncomingCall): Response | undefined {
  /*
   * 同源写保护（沿用 R 契约）：带 Origin/Referer 的请求必须与 Host **同源**——
   * host 与协议都必须一致（本服务是 HTTP 局域网/本机部署，页面 origin 恒为
   * `http://<host>`）；https origin 或仅 host 相同都按跨源拒绝。无 Origin/Referer 的
   * 非浏览器客户端放行（认证仍必需）。
   * T4 复核四：LAN 代理把 Host 改写为内部地址——同源比对改用**入口签名过的原始
   * Host**（HMAC 防伪造）；直连内部（仅回环）无签名头，回退真实 Host。
   */
  const origin = input.headers.get("origin") ?? input.headers.get("referer");
  if (origin) {
    const host =
      verifyPeerMetadata(input.headers.get(TRUSTED_HOST_HEADER)) ?? input.headers.get("host");
    try {
      const parsed = new URL(origin);
      if (!host || parsed.origin !== `http://${host}`) {
        return authJson({ ok: false, error: "CROSS_ORIGIN_FORBIDDEN" }, 403);
      }
    } catch {
      return authJson({ ok: false, error: "CROSS_ORIGIN_FORBIDDEN" }, 403);
    }
  }
  // 测试身份注入（仅 vitest 夹具调用；生产路径恒为 null，无环境开关）：
  // 跳过 HTTP 凭证认证，但仍走用户 scope 派生——路径隔离真实生效。
  const override = betaTestUserOverride();
  const auth = override
    ? { user: override, session: { id: "", deviceLabel: "test", transport: "bearer" as const, absoluteExpiresAt: "" }, channel: "bearer" as const, renewedCookie: null }
    : authenticateSession(serviceDb(), input.headers.get("authorization"), input.headers.get("cookie"));
  if ("error" in auth) return authFailureResponse(auth.error);
  const status = betaRootStatus();
  if (!status.initialized) return authJson({ ok: false, error: "BETA_NOT_INITIALIZED" }, 503);
  try {
    // T2a：认证通过即按会话派生用户路径并注入请求作用域；派生失败（symlink/形状）
    // 一律 503，绝不回落到全局旧 Store/旧目录。所有 Store 默认 env 均读该 scope。
    const paths = deriveUserPaths(currentServerId() ?? "", auth.user.id, resolveBetaRoot());
    enterBetaScope(buildScopeEnv(paths));
  } catch (e) {
    return authJson({ ok: false, error: "BETA_SCOPE_UNAVAILABLE", detail: String((e as Error)?.message || e) }, 503);
  }
  return undefined;
}

async function readAuthBody(body: ReadableStream<Uint8Array> | null): Promise<Record<string, unknown> | null> {
  const reader = body?.getReader();
  if (!reader) return {};
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value?.byteLength ?? 0;
      if (bytes > MAX_AUTH_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function peerAddressFrom(input: IncomingCall): string | null {
  return verifyPeerMetadata(input.headers.get(PEER_HEADER));
}

/** POST /api/auth/login：公开端点；peer 不可信或限速均拒绝，不做任何私有副作用。 */
export async function handleLogin(input: IncomingCall): Promise<Response> {
  const peer = verifyPeerMetadata(input.headers.get(PEER_HEADER));
  if (peer === null) return authJson({ ok: false, error: "PEER_UNTRUSTED" }, 503);
  const body = await readAuthBody(input.body);
  if (body === null || typeof body.username !== "string" || typeof body.password !== "string") {
    return authJson({ ok: false, error: "BAD_REQUEST" }, 400);
  }
  const transportRaw = typeof body.transport === "string" ? body.transport : "cookie";
  const transport = transportRaw === "bearer" ? "bearer" : "cookie";
  const deviceLabel = typeof body.deviceLabel === "string" ? body.deviceLabel.slice(0, 80) : "";
  const result = loginWithPassword(serviceDb(), body.username, body.password, transport, deviceLabel, peer);
  if (!result.ok) {
    if (result.code === "LOGIN_RATE_LIMITED") {
      return authJson({ ok: false, error: result.code, retryAfterSeconds: result.retryAfterSeconds }, 429, { "Retry-After": String(result.retryAfterSeconds ?? 30) });
    }
    if (result.code === "LOGIN_LOCKED") {
      return authJson({ ok: false, error: result.code, lockedUntil: result.lockedUntil }, 423);
    }
    if (result.code === "PEER_UNTRUSTED") return authJson({ ok: false, error: result.code }, 503);
    return authJson({ ok: false, error: result.code, lockedUntil: result.lockedUntil }, 401);
  }
  const extra: Record<string, string> = {};
  if (transport === "cookie") {
    extra["Set-Cookie"] = sessionCookieHeader(result.token, Math.floor(AUTH_LIMITS.idleMs / 1000));
  }
  return authJson({ ok: true, token: result.token, user: result.user, expiresAt: result.expiresAt, serverId: currentServerId() }, 200, extra);
}

/** POST /api/auth/logout：撤销当前会话；双通道均支持。 */
export async function handleLogout(input: IncomingCall): Promise<Response> {
  const auth = authenticateSession(serviceDb(), input.headers.get("authorization"), input.headers.get("cookie"));
  if ("error" in auth) return authFailureResponse(auth.error);
  serviceDb().prepare("UPDATE auth_sessions SET revoked_at = ? WHERE id = ?").run(iso(Date.now()), auth.session.id);
  const extra: Record<string, string> = {};
  if (auth.channel === "cookie") extra["Set-Cookie"] = sessionCookieHeader("", 0);
  return authJson({ ok: true }, 200, extra);
}

/** GET /api/auth/session：当前用户/到期/serverId（不输出秘密）。 */
export function handleSession(input: IncomingCall): Response {
  const auth = authenticateSession(serviceDb(), input.headers.get("authorization"), input.headers.get("cookie"));
  if ("error" in auth) return authFailureResponse(auth.error);
  return authJson(
    {
      ok: true,
      user: auth.user,
      session: { deviceLabel: auth.session.deviceLabel, transport: auth.session.transport, absoluteExpiresAt: auth.session.absoluteExpiresAt },
      serverId: currentServerId()
    },
    200
  );
}

/** POST /api/auth/password：改密保留当前、撤销其他；需当前密码。 */
export async function handlePassword(input: IncomingCall): Promise<Response> {
  const auth = authenticateSession(serviceDb(), input.headers.get("authorization"), input.headers.get("cookie"));
  if ("error" in auth) return authFailureResponse(auth.error);
  const body = await readAuthBody(input.body);
  if (body === null || typeof body.currentPassword !== "string" || typeof body.newPassword !== "string" || body.newPassword.length < 8) {
    return authJson({ ok: false, error: "BAD_REQUEST" }, 400);
  }
  const db = serviceDb();
  const row = db.prepare("SELECT salt, password_hash FROM users WHERE id = ?").get(auth.user.id) as { salt: string; password_hash: string } | undefined;
  if (!row || !verifyPassword(body.currentPassword, row.salt, row.password_hash)) {
    return authJson({ ok: false, error: "CURRENT_PASSWORD_WRONG" }, 401);
  }
  const { salt, hash } = hashPassword(body.newPassword);
  db.prepare("UPDATE users SET salt = ?, password_hash = ?, updated_at = ? WHERE id = ?").run(salt, hash, iso(Date.now()), auth.user.id);
  db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL").run(iso(Date.now()), auth.user.id, auth.session.id);
  return authJson({ ok: true, revokedOtherSessions: true }, 200);
}

/** beta 根与控制库状态（启动器/健康检查用）。 */
export function betaReadiness(): { initialized: boolean; serverId: string | null; problem?: string } {
  const status = betaRootStatus();
  return { initialized: status.initialized, serverId: status.initialized && status.manifest ? status.manifest.serverId : null, problem: status.problem };
}

/** 测试与优雅退出使用：关闭控制库连接。 */
export function closeAuthResources(): void {
  closeServiceDb();
}

export function betaRootPath(): string {
  return resolveBetaRoot();
}

export { SESSION_COOKIE };
