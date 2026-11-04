import { AGENT_TASK_LIMITS, AGENT_TASK_TERMINAL, type AgentTaskCreateInput } from "@/features/ai/agent-task-contract";
import { requireBetaAccess, authJson } from "../auth-http.ts";
import { authenticateSession, serviceDb } from "../auth-store.ts";
import { currentServerId } from "../beta-data.ts";
import { ensureAgentTaskHost, freezeTaskBindings, resolveTaskCredential } from "./runner";
import {
  AgentTaskError, acknowledgeTask, cancelTask, createTask, drainTaskFileDeletes, ensureTaskSchema,
  findTaskReplay, listTasks, ownedTask, putTaskMaterial, readTaskArtifact, taskEvents, taskSummary,
  validateTaskInput, type TaskActor
} from "./store";

type Context = { params: Promise<{ id: string; fileId?: string }> };
function fail(error: unknown): Response {
  if (error instanceof AgentTaskError) return authJson({ ok: false, error: error.code }, error.status);
  return authJson({ ok: false, error: "TASK_SERVICE_UNAVAILABLE" }, 503);
}
function authenticate(request: Request): { userId: string; cookie: string | null } {
  const auth = authenticateSession(serviceDb(), request.headers.get("authorization"), request.headers.get("cookie"));
  if ("error" in auth) throw new AgentTaskError(auth.error, 401);
  return { userId: auth.user.id, cookie: auth.renewedCookie };
}
function dataset(request: Request): string | null { return request.headers.get("x-xingji-dataset")?.trim() || null; }
function actor(request: Request): TaskActor {
  const auth = authenticate(request);
  const datasetId = dataset(request);
  if (!datasetId) throw new AgentTaskError("DATASET_REQUIRED", 400);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(datasetId)) throw new AgentTaskError("TASK_DATASET_INVALID", 400);
  return { userId: auth.userId, datasetId };
}
async function bytes(request: Request, limit: number): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new AgentTaskError("TASK_BODY_TOO_LARGE", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) { combined.set(part, offset); offset += part.byteLength; }
  return combined;
}
async function json(request: Request): Promise<Record<string, unknown>> {
  const raw = await bytes(request, AGENT_TASK_LIMITS.jsonBytes);
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new AgentTaskError("TASK_BODY_INVALID", 400); }
}
async function endpoint(request: Request, action: () => Response | Promise<Response>): Promise<Response> {
  try {
    const auth = authenticate(request);
    const denied = requireBetaAccess(request);
    if (denied) return denied;
    ensureTaskSchema(serviceDb());
    const response = await action();
    if (auth.cookie) response.headers.set("set-cookie", auth.cookie);
    return response;
  } catch (error) { return fail(error); }
}
function readOwned(request: Request, taskId: string) {
  const identity = authenticate(request);
  return ownedTask(serviceDb(), { userId: identity.userId, datasetId: dataset(request) }, taskId);
}

export function postTasks(request: Request): Promise<Response> {
  return endpoint(request, async () => {
    const input = validateTaskInput(await json(request)) as AgentTaskCreateInput;
    const identity = actor(request);
    const replay = findTaskReplay(serviceDb(), identity, input);
    // Replays resolve before reading current model settings: an old idempotency key never silently rebinds.
    const created = replay ? { task: replay, replayed: true } : createTask(serviceDb(), identity, input, freezeTaskBindings(input, (kind, configId) => resolveTaskCredential(identity.userId, kind, configId)));
    ensureAgentTaskHost();
    return authJson({ ok: true, serverId: currentServerId(), replayed: created.replayed, task: taskSummary(created.task) }, created.replayed ? 200 : 201);
  });
}
export function getTasks(request: Request): Promise<Response> {
  return endpoint(request, () => authJson({ ok: true, tasks: listTasks(serviceDb(), actor(request)) }, 200));
}
export function getTaskDetail(request: Request, context: Context): Promise<Response> {
  return endpoint(request, async () => authJson({ ok: true, task: taskSummary(readOwned(request, (await context.params).id)) }, 200));
}
export function getTaskResult(request: Request, context: Context): Promise<Response> {
  return endpoint(request, async () => {
    const task = readOwned(request, (await context.params).id);
    if (task.status === "expired" || task.expiresAt <= Date.now()) throw new AgentTaskError("TASK_EXPIRED", 410);
    if (task.status !== "awaiting_ack" || !task.result) throw new AgentTaskError("TASK_RESULT_NOT_READY", 409);
    return authJson({ ok: true, taskId: task.id, digest: task.resultDigest, result: task.result }, 200);
  });
}
export function getTaskFile(request: Request, context: Context): Promise<Response> {
  return endpoint(request, async () => {
    const { id, fileId } = await context.params;
    readOwned(request, id);
    const { file, bytes: content } = readTaskArtifact(serviceDb(), actor(request), id, fileId ?? "");
    return new Response(Uint8Array.from(content), { headers: {
      "content-type": file.mime, "content-length": String(file.bytes), "cache-control": "no-store",
      "x-content-sha256": file.sha256, "x-content-type-options": "nosniff",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name || file.fileId)}`
    } });
  });
}
export function postTaskAck(request: Request, context: Context): Promise<Response> {
  return endpoint(request, async () => {
    const { id } = await context.params;
    const body = await json(request);
    const result = acknowledgeTask(serviceDb(), () => {
      try { return authenticate(request).userId; } catch { return null; }
    }, dataset(request), id, body.digest);
    drainTaskFileDeletes(serviceDb());
    return authJson(result, 200);
  });
}
export function postTaskCancel(request: Request, context: Context): Promise<Response> {
  return endpoint(request, async () => {
    const { id } = await context.params;
    readOwned(request, id);
    return authJson({ ok: true, task: cancelTask(serviceDb(), actor(request), id) }, 200);
  });
}
export function postTaskMaterials(request: Request, context: Context): Promise<Response> {
  return endpoint(request, async () => {
    const { id } = await context.params;
    readOwned(request, id); // Auth and ownership precede potentially expensive multipart buffering.
    const contentType = request.headers.get("content-type") ?? "";
    let refId: string;
    let data: string | Uint8Array;
    let mime: string | undefined;
    if (contentType.toLowerCase().startsWith("multipart/form-data;")) {
      const raw = await bytes(request, AGENT_TASK_LIMITS.imageBytes + 64 * 1024);
      let form: FormData;
      try { form = await new Response(Uint8Array.from(raw), { headers: { "content-type": contentType } }).formData(); }
      catch { throw new AgentTaskError("TASK_MULTIPART_INVALID", 400); }
      if ([...form.keys()].some((key) => key !== "refId" && key !== "file") || form.getAll("refId").length !== 1 || form.getAll("file").length !== 1) throw new AgentTaskError("TASK_MULTIPART_INVALID", 400);
      const ref = form.get("refId");
      const file = form.get("file");
      if (typeof ref !== "string" || !file || typeof file === "string") throw new AgentTaskError("TASK_MULTIPART_INVALID", 400);
      if (file.size > AGENT_TASK_LIMITS.imageBytes) throw new AgentTaskError("TASK_MATERIAL_LIMIT", 413);
      refId = ref;
      data = new Uint8Array(await file.arrayBuffer());
      mime = file.type;
    } else {
      const body = await json(request);
      if (typeof body.refId !== "string" || typeof body.text !== "string" || Object.keys(body).some((key) => key !== "refId" && key !== "text")) throw new AgentTaskError("TASK_MATERIAL_INVALID", 400);
      refId = body.refId;
      data = body.text;
    }
    // Reauthenticate after receiving the body; revoked sessions cannot attach late bytes.
    const result = putTaskMaterial(serviceDb(), actor(request), id, refId, data, mime);
    ensureAgentTaskHost();
    return authJson({ ok: true, ...result }, 200);
  });
}
export function getTaskStream(request: Request, context: Context): Promise<Response> {
  return endpoint(request, async () => {
    const { id } = await context.params;
    readOwned(request, id);
    const sinceRaw = new URL(request.url).searchParams.get("since") ?? "0";
    if (!/^\d{1,15}$/.test(sinceRaw) || !Number.isSafeInteger(Number(sinceRaw))) throw new AgentTaskError("TASK_CURSOR_INVALID", 400);
    let cursor = Number(sinceRaw);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closeStream: (() => void) | undefined;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (value: unknown) => controller.enqueue(encoder.encode(JSON.stringify(value) + "\n"));
        const close = () => {
          if (stopped) return;
          stopped = true;
          if (timer) clearTimeout(timer);
          request.signal.removeEventListener("abort", close);
          try { controller.close(); } catch { /* A cancelled observer already closed its stream. */ }
        };
        closeStream = close;
        const poll = () => {
          if (stopped) return;
          try {
            const auth = authenticate(request);
            const task = ownedTask(serviceDb(), { userId: auth.userId, datasetId: dataset(request) }, id);
            const events = taskEvents(serviceDb(), { userId: auth.userId, datasetId: task.datasetId }, id, cursor);
            for (const item of events) { send({ type: "event", event: item }); cursor = item.sequence; }
            if (events.length < 250 && (AGENT_TASK_TERMINAL.has(task.status) || task.expiresAt <= Date.now())) {
              send({ type: "end", status: task.expiresAt <= Date.now() && task.status !== "acked" ? "expired" : task.status, sequence: cursor });
              close();
              return;
            }
            timer = setTimeout(poll, events.length === 250 ? 0 : 500);
          } catch (error) {
            send({ type: "end", error: error instanceof AgentTaskError ? error.code : "TASK_SERVICE_UNAVAILABLE", sequence: cursor });
            close();
          }
        };
        request.signal.addEventListener("abort", close, { once: true });
        if (request.signal.aborted) close(); else poll();
      },
      cancel() { closeStream?.(); }
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  });
}
