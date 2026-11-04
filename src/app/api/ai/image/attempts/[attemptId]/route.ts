/**
 * `/api/ai/image/attempts/[attemptId]`：只查询原尝试的状态/已有结果（R1 §4.2.5）。
 *
 * - **不触发**任何模型或图片请求：恢复、重复点击和重试先走查询；
 * - 复用会话路由的本机同源守卫，不开公共代理；
 * - `dispatched` 超过期限且没有终态证据时返回 `expired: true`，
 *   由客户端按「结果未知」恢复——本路由不自动接管或重新发起；
 * - 查询不到记录 → `IMAGE_ATTEMPT_NOT_FOUND`：只有新协议身份、现存未变的计划及
 *   本查询共同证明没有登记出站时，客户端才可视为未开始。
 */
import { getAttempt, type AttemptRow } from "@/server/ai/image-execution-store";
import { openDatabase } from "@/server/ai/sqlite-db";
import { sessionFailure, requireBetaAccess, sessionJson } from "@/server/ai/session-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ attemptId: string }> };

function attemptView(row: AttemptRow): Record<string, unknown> {
  const expired = row.status === "dispatched" && Date.now() > Date.parse(row.deadlineAt);
  let result: Record<string, unknown> | undefined;
  if (row.status === "succeeded" && row.resultJson) {
    try {
      const stored = JSON.parse(row.resultJson) as {
        mime?: string; imageBase64?: string; model?: string; configId?: string;
      };
      if (typeof stored.imageBase64 === "string" && typeof stored.mime === "string") {
        result = {
          mime: stored.mime, imageBase64: stored.imageBase64,
          bytes: Buffer.byteLength(stored.imageBase64, "base64"),
          ...(stored.model ? { model: stored.model } : {}),
          ...(stored.configId ? { configId: stored.configId } : {})
        };
      }
    } catch {
      result = undefined;
    }
  }
  return {
    attemptId: row.attemptId,
    sessionId: row.sessionId,
    messageId: row.messageId,
    executionId: row.executionId,
    itemId: row.itemId,
    attemptNo: row.attemptNo,
    status: row.status,
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    ...(row.artifactId ? { artifactId: row.artifactId } : {}),
    ...(row.artifactDigest ? { artifactDigest: row.artifactDigest } : {}),
    ...(row.artifactMime ? { artifactMime: row.artifactMime } : {}),
    deadlineAt: row.deadlineAt,
    updatedAt: row.updatedAt,
    expired,
    ...(result ? { result } : {})
  };
}

export async function GET(request: Request, context: Context): Promise<Response> {
  const blocked = requireBetaAccess(request);
  if (blocked) return blocked;
  const { attemptId } = await context.params;
  if (typeof attemptId !== "string" || attemptId.length === 0 || attemptId.length > 120) {
    return sessionFailure("SESSION_INVALID");
  }
  let row: AttemptRow | undefined;
  try {
    const database = openDatabase();
    try {
      row = getAttempt(database, attemptId);
    } finally {
      database.close();
    }
  } catch {
    return sessionFailure("SESSION_UNAVAILABLE");
  }
  if (!row) {
    return sessionJson({ ok: false, code: "IMAGE_ATTEMPT_NOT_FOUND", detail: "没有该尝试的执行记录。" }, 404);
  }
  return sessionJson({ ok: true, attempt: attemptView(row) }, 200);
}
