/**
 * `/api/ai/memory`：Memory 本地 SQLite 的最小读写端点（任务书 §3.2）。
 *
 * - Node runtime、`no-store`；GET 读视图，PUT 整批提交（upsert / delete / set-enabled）。
 * - 记忆读写**与 AI 执行开关分离**：关闭 AI 不影响管理本地记忆；仍然只允许本机同源，
 *   且沿用「无认证生产环境关闭」的既有部署判定。
 * - 错误只回稳定码与固定文案：不回显数据库路径、原始异常或记忆正文。
 */
import { MemoryStoreError, memoryErrorDetail, readMemoryView, applyMemoryOperations, type MemoryOperation } from "@/server/ai/memory-store";
import { requireBetaAccess } from "@/server/ai/session-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

const FAILURE_STATUS: Record<string, number> = {
  MEMORY_INVALID: 400,
  MEMORY_TOO_LARGE: 413,
  MEMORY_FORBIDDEN: 403,
  MEMORY_VERSION_REQUIRED: 428,
  MEMORY_CONFLICT: 409,
  MEMORY_BUSY: 409,
  MEMORY_UNAVAILABLE: 503
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function failure(code: string, status = FAILURE_STATUS[code] ?? 503): Response {
  return json({ ok: false, code, detail: memoryErrorDetail(code as Parameters<typeof memoryErrorDetail>[0]) }, status);
}

function describe(error: unknown): Response {
  if (error instanceof MemoryStoreError) return failure(error.code);
  return failure("MEMORY_UNAVAILABLE");
}

async function readBody(request: Request): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  // 一个 decoder 跨块使用并最终 flush：中文字符被网络分块截断也能正确还原。
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
    text += decoder.decode();
    return text;
  } catch {
    // 非法 UTF-8：按非法正文处理，不当作存储错误。
    return "";
  }
}

const OPERATION_KINDS = new Set(["preference"]);

/** 严格校验每个 operation 的字段类型；任何不合规都整批拒绝（400）。 */
function parseOperations(value: unknown): MemoryOperation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const operations: MemoryOperation[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return undefined;
    const record = item as Record<string, unknown>;
    if (record.op === "set-enabled") {
      if (typeof record.enabled !== "boolean") return undefined;
      operations.push({ op: "set-enabled", enabled: record.enabled });
      continue;
    }
    if (typeof record.id !== "string" || !record.id.trim()) return undefined;
    if (record.op === "delete") {
      operations.push({ op: "delete", id: record.id });
      continue;
    }
    if (record.op !== "upsert") return undefined;
    if (typeof record.kind !== "string" || !OPERATION_KINDS.has(record.kind)) return undefined;
    if (typeof record.text !== "string") return undefined;
    if (record.allowModelUse !== undefined && typeof record.allowModelUse !== "boolean") return undefined;
    operations.push({
      op: "upsert",
      id: record.id,
      kind: "preference",
      text: record.text,
      ...(typeof record.allowModelUse === "boolean" ? { allowModelUse: record.allowModelUse } : {})
    });
  }
  return operations;
}

function guard(request: Request): Response | undefined {
  // requireBetaAccess 返回的是 Response（401/403/503）或 undefined——原样透传，
  // 不能与旧 localAdminGuard 的字符串码比较（那会让未认证请求穿透门闸）。
  return requireBetaAccess(request);
}

export async function GET(request: Request): Promise<Response> {
  const blocked = guard(request);
  if (blocked) return blocked;
  try {
    const view = readMemoryView();
    return json({ ok: true, ...view }, 200);
  } catch (error) {
    return describe(error);
  }
}

export async function PUT(request: Request): Promise<Response> {
  const blocked = guard(request);
  if (blocked) return blocked;
  if (request.headers.get("content-type")?.includes("application/json") !== true) {
    return failure("MEMORY_INVALID");
  }
  const raw = await readBody(request);
  if (raw === null) return failure("MEMORY_TOO_LARGE");
  if (raw.length === 0) return failure("MEMORY_INVALID");

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return failure("MEMORY_INVALID");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return failure("MEMORY_INVALID");
  const record = payload as { baseRevision?: unknown; operations?: unknown };
  const operations = parseOperations(record.operations);
  if (!operations) return failure("MEMORY_INVALID");

  try {
    const view = applyMemoryOperations({
      ...(typeof record.baseRevision === "number" ? { baseRevision: record.baseRevision } : {}),
      operations
    });
    // 成功以服务端回读为准。
    return json({ ok: true, ...view }, 200);
  } catch (error) {
    return describe(error);
  }
}
