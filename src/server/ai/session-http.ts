/** 会话管理接口共用的响应、权限与有界请求读取；不属于 Next 路由导出。 */
import { SESSION_LIMITS, SessionStoreError, sessionErrorDetail } from "@/server/ai/session-store";

// T1 起统一认证门闸（beta 会话 + 隔离就绪检查）；旧 localAdminGuard 退役。
export { requireBetaAccess } from "./auth-http.ts";

// 请求还带会话 ID、revision 等信封字段，给 payload 上限留少量余量。
const MAX_BODY_BYTES = SESSION_LIMITS.maxPayloadBytes + 1024 * 1024;

export const SESSION_FAILURE_STATUS: Record<string, number> = {
  SESSION_INVALID: 400,
  SESSION_TOO_LARGE: 413,
  SESSION_FORBIDDEN: 403,
  SESSION_NOT_FOUND: 404,
  SESSION_EXISTS: 409,
  SESSION_VERSION_REQUIRED: 428,
  SESSION_CONFLICT: 409,
  SESSION_BUSY: 409,
  SESSION_UNAVAILABLE: 503
};

export function sessionJson(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

export function sessionFailure(code: string): Response {
  const status = SESSION_FAILURE_STATUS[code] ?? 503;
  return sessionJson({ ok: false, code, detail: sessionErrorDetail(code as Parameters<typeof sessionErrorDetail>[0]) }, status);
}

export function describeSessionError(error: unknown): Response {
  if (error instanceof SessionStoreError) return sessionFailure(error.code);
  return sessionFailure("SESSION_UNAVAILABLE");
}

export async function readSessionBody(request: Request): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value?.byteLength ?? 0;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch {
    return "";
  }
}
