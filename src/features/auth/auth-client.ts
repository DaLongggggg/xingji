/**
 * T1 前端认证客户端（连续实施任务书 §4.1）。
 * 桌面浏览器走同源 Cookie（fetch 默认 same-origin 携带）；原生壳（T4）切到 Bearer 并
 * credentials: omit。token 只存在于登录响应与系统安全存储，不落 localStorage/日志。
 */

export type SessionInfo = {
  ok: true;
  user: { id: string; username: string };
  serverId: string | null;
  session: { deviceLabel: string; transport: string; absoluteExpiresAt: string };
};

export type LoginResult =
  | { ok: true; user: { id: string; username: string } }
  | { ok: false; error: string; lockedUntil?: string; retryAfterSeconds?: number };

export type SessionResult = SessionInfo | { ok: false; expired?: true; error?: "connection"; cancelled?: true };

/** A service/transport failure never impersonates an expired credential. */
export async function fetchSession(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<SessionResult> {
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 10_000), ...(options.signal ? [options.signal] : [])]);
  try {
    const response = await fetch("/api/auth/session", { credentials: "same-origin", headers: {}, signal });
    if (response.status === 401) {
      const body = await response.json().catch(() => null);
      return body?.error === "SESSION_EXPIRED_IDLE" || body?.error === "SESSION_EXPIRED_ABSOLUTE"
        ? { ok: false, expired: true } : { ok: false };
    }
    if (response.status !== 200) return { ok: false, error: "connection" };
    const body = await response.json();
    if (!body || body.ok !== true || typeof body.user?.id !== "string" || !body.user.id
      || typeof body.user.username !== "string" || !body.user.username
      || !(body.serverId === null || typeof body.serverId === "string" && body.serverId.length > 0)
      || typeof body.session?.deviceLabel !== "string" || typeof body.session.transport !== "string"
      || typeof body.session.absoluteExpiresAt !== "string" || !Number.isFinite(Date.parse(body.session.absoluteExpiresAt))) return { ok: false, error: "connection" };
    return body;
  } catch {
    return options.signal?.aborted ? { ok: false, cancelled: true } : { ok: false, error: "connection" };
  }
}

export async function login(username: string, password: string, deviceLabel: string): Promise<LoginResult> {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password, deviceLabel, transport: "cookie" })
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status !== 200 || !body.ok) {
    return {
      ok: false,
      error: String(body.error || `HTTP ${response.status}`),
      lockedUntil: typeof body.lockedUntil === "string" ? body.lockedUntil : undefined,
      retryAfterSeconds: typeof body.retryAfterSeconds === "number" ? body.retryAfterSeconds : undefined
    };
  }
  return { ok: true, user: body.user as { id: string; username: string } };
}

export async function logout(options: { requireConfirmation?: boolean } = {}): Promise<void> {
  const response = await fetch("/api/auth/logout", {
    method: "POST", credentials: "same-origin", headers: {},
    ...(options.requireConfirmation ? { signal: AbortSignal.timeout(10_000) } : {})
  });
  if (options.requireConfirmation && !response.ok && response.status !== 401) throw new Error("退出登录未能确认，请重试。");
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean; error?: string }> {
  const response = await fetch("/api/auth/password", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword })
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return response.status === 200 && !!body.ok ? { ok: true } : { ok: false, error: String(body.error || `HTTP ${response.status}`) };
}

/** 供后续 T2a 的受控私有 API 入口复用：401 时广播会话过期事件（不自动重试）。 */
export function notifySessionExpired(): void {
  window.dispatchEvent(new CustomEvent("xingji:session-expired"));
}
