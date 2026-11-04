/**
 * `/api/ai/sessions`：列表与创建（任务书 §4）。Node runtime、no-store、本机同源。
 * 管理读写不依赖 AI 执行开关；继续禁止无认证公网访问。
 */
import { createSession, listSessions } from "@/server/ai/session-store";
import { describeSessionError, readSessionBody, sessionFailure, requireBetaAccess, sessionJson } from "@/server/ai/session-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const blocked = requireBetaAccess(request);
  if (blocked) return blocked;
  try {
    return sessionJson({ ok: true, sessions: listSessions() }, 200);
  } catch (error) {
    return describeSessionError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const blocked = requireBetaAccess(request);
  if (blocked) return blocked;
  if (request.headers.get("content-type")?.includes("application/json") !== true) return sessionFailure("SESSION_INVALID");
  const raw = await readSessionBody(request);
  if (raw === null) return sessionFailure("SESSION_TOO_LARGE");
  if (!raw) return sessionFailure("SESSION_INVALID");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return sessionFailure("SESSION_INVALID");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return sessionFailure("SESSION_INVALID");
  const record = body as { id?: unknown; title?: unknown; payload?: unknown };
  if (typeof record.id !== "string") return sessionFailure("SESSION_INVALID");
  try {
    const session = createSession({
      id: record.id,
      ...(typeof record.title === "string" ? { title: record.title } : {}),
      payload: record.payload
    });
    return sessionJson({ ok: true, session }, 200);
  } catch (error) {
    return describeSessionError(error);
  }
}
