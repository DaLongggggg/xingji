/**
 * 工作台偏好（任务书 §4）：只保存 activeSessionId 与自己的 revision。
 * 模型选择属于会话 payload（发送不再需要单独授权，因此没有可落库的许可）。
 */
import { readPreference, writePreference } from "@/server/ai/session-store";
import {
  describeSessionError,
  readSessionBody,
  sessionFailure,
  requireBetaAccess,
  sessionJson
} from "@/server/ai/session-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const blocked = requireBetaAccess(request);
  if (blocked) return blocked;
  try {
    return sessionJson({ ok: true, preference: readPreference() }, 200);
  } catch (error) {
    return describeSessionError(error);
  }
}

export async function PUT(request: Request): Promise<Response> {
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
  const record = body as { baseRevision?: unknown; activeSessionId?: unknown };
  try {
    const preference = writePreference({
      ...(typeof record.baseRevision === "number" ? { baseRevision: record.baseRevision } : {}),
      ...(record.activeSessionId === null
        ? { activeSessionId: null }
        : typeof record.activeSessionId === "string"
          ? { activeSessionId: record.activeSessionId }
          : {})
    });
    return sessionJson({ ok: true, preference }, 200);
  } catch (error) {
    return describeSessionError(error);
  }
}
