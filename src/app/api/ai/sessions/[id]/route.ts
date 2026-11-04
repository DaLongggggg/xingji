/**
 * `/api/ai/sessions/[id]`：读取、更新、删除（任务书 §4）。
 * PUT 只更新已存在会话（不能复活已删除的）；DELETE 带 baseRevision 并在事务内清除指向它的偏好。
 */
import { deleteSession, readSession, updateSession } from "@/server/ai/session-store";
import {
  describeSessionError,
  readSessionBody,
  sessionFailure,
  requireBetaAccess,
  sessionJson
} from "@/server/ai/session-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const blocked = requireBetaAccess(request);
  if (blocked) return blocked;
  const { id } = await context.params;
  try {
    return sessionJson({ ok: true, session: readSession(id) }, 200);
  } catch (error) {
    return describeSessionError(error);
  }
}

export async function PUT(request: Request, context: Context): Promise<Response> {
  const blocked = requireBetaAccess(request);
  if (blocked) return blocked;
  if (request.headers.get("content-type")?.includes("application/json") !== true) return sessionFailure("SESSION_INVALID");
  const { id } = await context.params;
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
  const record = body as { baseRevision?: unknown; title?: unknown; payload?: unknown };
  try {
    const session = updateSession({
      id,
      ...(typeof record.baseRevision === "number" ? { baseRevision: record.baseRevision } : {}),
      ...(typeof record.title === "string" ? { title: record.title } : {}),
      payload: record.payload
    });
    return sessionJson({ ok: true, session }, 200);
  } catch (error) {
    return describeSessionError(error);
  }
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  const blocked = requireBetaAccess(request);
  if (blocked) return blocked;
  const { id } = await context.params;
  let baseRevision: unknown;
  const raw = await readSessionBody(request);
  if (raw) {
    try {
      baseRevision = (JSON.parse(raw) as { baseRevision?: unknown }).baseRevision;
    } catch {
      return sessionFailure("SESSION_INVALID");
    }
  }
  try {
    const removed = deleteSession({
      id,
      ...(typeof baseRevision === "number" ? { baseRevision } : {})
    });
    return sessionJson({ ok: true, ...removed }, 200);
  } catch (error) {
    return describeSessionError(error);
  }
}
