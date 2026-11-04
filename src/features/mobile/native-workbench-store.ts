import { LOCAL_EDIT_ORIGIN, IMAGE_EDIT_METADATA } from "@/features/workbench/workbench-image-edit-contract";
import { SessionApiError, type SessionApi, type SessionPayload, type SessionRecord, type SessionSummary, type WorkbenchPreference } from "@/features/workbench/workbench-sessions";
import { MemoryClientError, type MemoryStore, type MemoryState, type MemoryOperation } from "@/features/workbench/workbench-memory";
import { isNativeMediaFileRef, type MessageAttachment, type NativeMediaFileRef, type WorkbenchMessage } from "@/features/workbench/workbench-types";
import { ACTOR_WHERE, actorValues, type NativeActor, type NativeDatabase } from "./native-database";
import { NativeFiles, type PreparedNativeFile } from "./native-files";
import { nativeJson } from "./native-repositories";

type StoredSession = Omit<SessionRecord, "payload"> & { payload: Omit<SessionPayload, "messages">; messageIds: string[] };
type MessageRow = { chatSessionId: string; message: WorkbenchMessage };
const MESSAGE_FIELDS = new Set(["localEdit", "id", "role", "text", "blocks", "eventSequence", "process", "request", "intent", "references", "skillReferences", "imageAdvice", "attachments", "result", "status", "reasoning", "tools", "imagePlan", "imageAttempts", "calls", "traces", "error", "saveFailed", "createdAt"]);
const FORBIDDEN = new Set(["signal", "apikey", "api_key", "authorization", "authorized", "credential", "credentials", "memory", "token", "password", "secret"]);
const SESSION_BYTES = 510 * 1024 * 1024;
function fail(code: string, status = 409): never { throw new SessionApiError(code, code === "SESSION_CONFLICT" ? "会话已更新，请重新读取后再保存。" : "会话内容无法保存，请检查资料后重试。", status); }
const parse = <T,>(value: unknown): T => JSON.parse(String(value)) as T;

export { isNativeMediaFileRef } from "@/features/workbench/workbench-types";
function cleanJson(value: unknown, depth = 0): void {
  if (depth > 32 || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint" || (typeof value === "number" && !Number.isFinite(value))) fail("SESSION_INVALID", 400);
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value) cleanJson(item, depth + 1); return; }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail("SESSION_INVALID", 400);
  for (const [key, item] of Object.entries(value)) { if (FORBIDDEN.has(key.toLowerCase())) fail("SESSION_INVALID", 400); cleanJson(item, depth + 1); }
}
function validatePayload(payload: SessionPayload): NativeMediaFileRef[] {
  cleanJson(payload);
  if (!payload || typeof payload !== "object" || Object.keys(payload).some((key) => !["scope", "textModelId", "imageModelId", "renamed", "messages"].includes(key)) || typeof payload.renamed !== "boolean" || !Array.isArray(payload.messages)) fail("SESSION_INVALID", 400);
  if (payload.messages.length > 1000) fail("SESSION_TOO_LARGE", 413);
  const scope = payload.scope;
  if (!scope || !["free", "notebook", "note"].includes(scope.kind) || (scope.kind !== "free" && (!scope.notebookId || !scope.notebookTitle)) || (scope.kind === "note" && (!scope.noteId || !scope.noteTitle))) fail("SESSION_INVALID", 400);
  const refs: NativeMediaFileRef[] = [];
  const ids = new Set<string>();
  for (const message of payload.messages) {
    if (!message || Object.keys(message).some((key) => !MESSAGE_FIELDS.has(key)) || !message.id || ids.has(message.id) || !["user", "assistant"].includes(message.role) || typeof message.text !== "string" || typeof message.createdAt !== "string") fail("SESSION_INVALID", 400);
    if (message.request && "webSearchEnabled" in message.request) fail("SESSION_INVALID", 400);
    if (message.localEdit && !LOCAL_EDIT_ORIGIN.safeParse(message.localEdit).success) fail("SESSION_INVALID", 400);
    ids.add(message.id);
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      for (const [key, item] of Object.entries(value)) {
        if (key === "fileRef") { if (!isNativeMediaFileRef(item)) fail("SESSION_INVALID", 400); refs.push(item); }
        else if (key === "dataUrl" && item !== undefined && item !== "") fail("SESSION_NATIVE_FILE_REQUIRED", 400);
        else visit(item);
      }
    };
    visit(message);
    for (const attachment of [...(message.attachments ?? []), ...(message.request?.attachments ?? [])]) {
      if (!attachment.id || !attachment.name || !attachment.fileRef) fail("SESSION_NATIVE_FILE_REQUIRED", 400);
      if (attachment.edit && !IMAGE_EDIT_METADATA.safeParse(attachment.edit).success) fail("SESSION_INVALID", 400);
    }
  }
  if (new TextEncoder().encode(nativeJson(payload)).length > SESSION_BYTES) fail("SESSION_TOO_LARGE", 413);
  return refs;
}

/** Same SQLite/actor as task delivery. Session rows never contain a second copy of message bodies. */
export function createNativeWorkbenchStore(database: NativeDatabase, files: NativeFiles, actorInput: NativeActor, options: { now?: () => Date; assertCurrent?: () => void } = {}): { sessionApi: SessionApi; memoryStore: MemoryStore; attachmentBlob: (attachment: MessageAttachment) => Promise<Blob>; prepareAttachment: (media: { id: string; name: string; type: string; size: number; blob: Blob }) => Promise<{ attachment: MessageAttachment; prepared: PreparedNativeFile }>; commitAttachments: (prepared: readonly PreparedNativeFile[]) => Promise<void>; commitSessionWithAttachments: (input: { id: string; baseRevision?: number; title?: string; payload: SessionPayload }, prepared: readonly PreparedNativeFile[]) => Promise<SessionRecord> } {
  if (files.database !== database) throw new Error("NATIVE_DATABASE_MISMATCH");
  const actor = Object.freeze({ ...actorInput }); const values = () => actorValues(actor);
  const now = options.now ?? (() => new Date());
  const tx = <T,>(operation: () => Promise<T>) => database.transaction(async () => { options.assertCurrent?.(); await database.assertActor(actor); const result = await operation(); options.assertCurrent?.(); return result; });
  const get = async <T,>(kind: string, id: string): Promise<T | null> => { const row = (await database.query(`SELECT json FROM mobile_records WHERE ${ACTOR_WHERE} AND kind=? AND record_id=?`, [...values(), kind, id]))[0]; return row ? parse<T>(row.json) : null; };
  const put = (kind: string, id: string, data: unknown) => database.run("INSERT INTO mobile_records(server_id,user_id,dataset_id,kind,record_id,json) VALUES(?,?,?,?,?,?) ON CONFLICT(server_id,user_id,dataset_id,kind,record_id) DO UPDATE SET json=excluded.json", [...values(), kind, id, nativeJson(data)]);
  const messages = async (sessionId: string): Promise<MessageRow[]> => (await database.query(`SELECT json FROM mobile_records WHERE ${ACTOR_WHERE} AND kind='message' AND json_extract(json,'$.chatSessionId')=? ORDER BY rowid`, [...values(), sessionId])).map((row) => parse<MessageRow>(row.json));
  const deliveryVersion = async (id: string): Promise<{ count: number; latest: string | null }> => {
    const row = (await database.query(`SELECT COUNT(*) AS count,MAX(applied_at) AS latest FROM tasks_inbox WHERE ${ACTOR_WHERE} AND chat_session_id=?`, [...values(), id]))[0];
    return { count: Number(row.count), latest: row.latest ? String(row.latest) : null };
  };
  const summary = async (stored: StoredSession): Promise<SessionSummary> => {
    const delivered = await deliveryVersion(stored.id);
    const count = (await database.query(`SELECT COUNT(*) AS count FROM mobile_records WHERE ${ACTOR_WHERE} AND kind='message' AND json_extract(json,'$.chatSessionId')=?`, [...values(), stored.id]))[0];
    return { id: stored.id, title: stored.title, revision: stored.revision + delivered.count, createdAt: stored.createdAt, updatedAt: delivered.latest && delivered.latest > stored.updatedAt ? delivered.latest : stored.updatedAt, renamed: stored.renamed, messageCount: Number(count.count) };
  };
  const read = async (id: string): Promise<SessionRecord> => {
    const stored = await get<StoredSession>("session", id); if (!stored) fail("SESSION_NOT_FOUND", 404);
    const rows = await messages(id); const byId = new Map(rows.map((row) => [row.message.id, row.message]));
    const ordered = stored.messageIds.flatMap((messageId) => byId.get(messageId) ?? []);
    const known = new Set(stored.messageIds); ordered.push(...rows.filter((row) => !known.has(row.message.id)).map((row) => row.message));
    return { ...await summary(stored), payload: { ...stored.payload, messages: ordered } };
  };
  const verifyRefs = async (refs: readonly NativeMediaFileRef[]) => {
    let total = 0; const seen = new Set<string>();
    for (const ref of refs) {
      if (ref.serverId !== actor.serverId || ref.userId !== actor.userId || ref.datasetId !== actor.datasetId) fail("SESSION_FILE_OWNER_MISMATCH", 400);
      const row = (await database.query(`SELECT sha256,size,type,path FROM mobile_media WHERE ${ACTOR_WHERE} AND media_id=?`, [...values(), ref.mediaId]))[0];
      if (!row || row.sha256 !== ref.sha256 || row.size !== ref.size || row.type !== ref.type) fail("SESSION_FILE_MISSING", 409);
      const info = await files.port.stat(String(row.path)); if (info?.size !== ref.size) fail("SESSION_FILE_MISSING", 409);
      if (!seen.has(ref.mediaId)) { seen.add(ref.mediaId); total += ref.size; }
    }
    if (total > SESSION_BYTES) fail("SESSION_TOO_LARGE", 413);
    return total;
  };
  const writeSession = async (id: string, title: string | undefined, payload: SessionPayload, previous: StoredSession | null): Promise<SessionRecord> => {
    const refs = validatePayload(payload); const originalBytes = await verifyRefs(refs);
    if (originalBytes + new TextEncoder().encode(nativeJson(payload)).length > SESSION_BYTES) fail("SESSION_TOO_LARGE", 413);
    const currentMessages = await messages(id);
    for (const message of payload.messages) {
      const existing = await get<MessageRow>("message", message.id);
      if (existing && existing.chatSessionId !== id) fail("SESSION_MESSAGE_ID_CONFLICT", 409);
      await put("message", message.id, { chatSessionId: id, message });
    }
    const ids = new Set(payload.messages.map((message) => message.id));
    for (const row of currentMessages) if (!ids.has(row.message.id)) await database.run(`DELETE FROM mobile_records WHERE ${ACTOR_WHERE} AND kind='message' AND record_id=?`, [...values(), row.message.id]);
    const stamp = now().toISOString(); const { messages: ignored, ...metadata } = payload; void ignored;
    const nextTitle = title === undefined ? previous?.title ?? "新对话" : title.trim();
    if (!nextTitle || nextTitle.length > 120) fail("SESSION_INVALID", 400);
    const stored: StoredSession = { id, title: nextTitle, revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? stamp, updatedAt: stamp, renamed: payload.renamed, messageCount: ids.size, payload: metadata, messageIds: [...ids] };
    await put("session", id, stored);
    for (const ref of refs) await database.run("INSERT INTO mobile_media_links(server_id,user_id,dataset_id,kind,media_id,json) VALUES(?,?,?,?,?,?) ON CONFLICT(server_id,user_id,dataset_id,kind,media_id) DO NOTHING", [...values(), `session:${id}`, ref.mediaId, nativeJson({ chatSessionId: id })]);
    return read(id);
  };
  const preference = async (): Promise<WorkbenchPreference> => await get("kv", "workbench-preference") ?? { revision: 1 };
  const sessionApi: SessionApi = {
    list: () => tx(async () => {
      const rows = await database.query(`SELECT json FROM mobile_records WHERE ${ACTOR_WHERE} AND kind='session'`, values());
      const result = []; for (const row of rows) result.push(await summary(parse<StoredSession>(row.json)));
      return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }),
    read: (id) => tx(() => read(id)),
    create: (input) => tx(async () => { if (!input.id || input.id.length > 200) fail("SESSION_INVALID", 400); if (await get("session", input.id)) fail("SESSION_EXISTS", 409); return writeSession(input.id, input.title, input.payload, null); }),
    update: (input) => tx(async () => {
      const current = await get<StoredSession>("session", input.id); if (!current) fail("SESSION_NOT_FOUND", 404);
      const currentSummary = await summary(current);
      if (!Number.isInteger(input.baseRevision) || currentSummary.revision !== input.baseRevision) {
        console.error("[wb-conflict]", input.id, "base=", input.baseRevision, "summary=", currentSummary.revision, "stored=", current.revision, "delivered=", currentSummary.revision - current.revision);
        fail("SESSION_CONFLICT");
      }
      return writeSession(input.id, input.title, input.payload, current);
    }),
    remove: (input) => tx(async () => {
      const current = await get<StoredSession>("session", input.id); if (!current) fail("SESSION_NOT_FOUND", 404);
      if ((await summary(current)).revision !== input.baseRevision) fail("SESSION_CONFLICT");
      for (const row of await messages(input.id)) await database.run(`DELETE FROM mobile_records WHERE ${ACTOR_WHERE} AND kind='message' AND record_id=?`, [...values(), row.message.id]);
      await database.run(`DELETE FROM mobile_records WHERE ${ACTOR_WHERE} AND kind='session' AND record_id=?`, [...values(), input.id]);
      await database.run(`DELETE FROM mobile_media_links WHERE ${ACTOR_WHERE} AND kind=?`, [...values(), `session:${input.id}`]);
      const pref = await preference();
      const next = pref.activeSessionId === input.id ? { revision: pref.revision + 1 } : pref;
      if (next !== pref) await put("kv", "workbench-preference", next);
      return { id: input.id, preference: next };
    }),
    readPreference: () => tx(preference),
    writePreference: (input) => tx(async () => {
      const current = await preference(); if (current.revision !== input.baseRevision) fail("SESSION_CONFLICT");
      if (input.activeSessionId && !await get("session", input.activeSessionId)) fail("SESSION_NOT_FOUND", 404);
      const next = { revision: current.revision + 1, ...(input.activeSessionId ? { activeSessionId: input.activeSessionId } : {}) }; await put("kv", "workbench-preference", next); return next;
    })
  };
  let memoryRevision: number | undefined;
  const loadMemory = async (): Promise<MemoryState> => await get("memory", "state") ?? { revision: 1, enabled: false, entries: [] };
  const memoryStore: MemoryStore = {
    load: () => tx(async () => { const state = await loadMemory(); memoryRevision = state.revision; return state; }),
    apply: (operations: MemoryOperation[]) => tx(async () => {
      const current = await loadMemory();
      if (memoryRevision !== undefined && memoryRevision !== current.revision) throw new MemoryClientError("MEMORY_CONFLICT", "记忆已更新，请重新读取后再保存。");
      if (!Array.isArray(operations) || !operations.length || operations.length > 201) throw new MemoryClientError("MEMORY_INVALID", "记忆操作无效。");
      const entries = new Map(current.entries.map((entry) => [entry.id, { ...entry }])); let enabled = current.enabled; const stamp = now().toISOString();
      for (const operation of operations) {
        if (!operation || typeof operation !== "object") throw new MemoryClientError("MEMORY_INVALID", "记忆操作无效。");
        if (operation.op === "set-enabled" && typeof operation.enabled === "boolean") { enabled = operation.enabled; continue; }
        if (!("id" in operation) || !operation.id || operation.id.length > 200) throw new MemoryClientError("MEMORY_INVALID", "记忆标识无效。");
        if (operation.op === "delete") { entries.delete(operation.id); continue; }
        if (operation.op !== "upsert" || operation.kind !== "preference" || typeof operation.text !== "string" || !operation.text.trim() || operation.text.trim().length > 2000 || (operation.allowModelUse !== undefined && typeof operation.allowModelUse !== "boolean")) throw new MemoryClientError("MEMORY_INVALID", "记忆内容无效。");
        const previous = entries.get(operation.id);
        entries.set(operation.id, { id: operation.id, kind: "preference", text: operation.text.trim(), allowModelUse: operation.allowModelUse ?? previous?.allowModelUse ?? false, createdAt: previous?.createdAt ?? stamp, updatedAt: stamp });
      }
      if (entries.size > 200) throw new MemoryClientError("MEMORY_TOO_LARGE", "记忆条目超过上限。");
      const next = { revision: current.revision + 1, enabled, entries: [...entries.values()] }; await put("memory", "state", next); return next;
    }).then((state) => { memoryRevision = state.revision; return state; })
  };
  return {
    sessionApi, memoryStore,
    async attachmentBlob(attachment) {
      const ref = attachment.fileRef;
      if (!ref || !isNativeMediaFileRef(ref) || ref.serverId !== actor.serverId || ref.userId !== actor.userId || ref.datasetId !== actor.datasetId) fail("SESSION_FILE_OWNER_MISMATCH", 400);
      await tx(() => verifyRefs([ref])); const blob = await files.read(actor, ref.mediaId); options.assertCurrent?.(); if (!blob) fail("SESSION_FILE_MISSING"); return blob;
    },
    async prepareAttachment(media) {
      options.assertCurrent?.(); const prepared = await files.prepare(actor, media);
      const fileRef: NativeMediaFileRef = { ...actor, mediaId: media.id, sha256: prepared.sha256, size: prepared.size, type: prepared.type };
      return { attachment: { id: media.id, name: media.name, fileRef }, prepared };
    },
    async commitAttachments(prepared) {
      try { await tx(async () => { await files.commitPrepared(database, actor, prepared); for (const file of prepared) await database.run("INSERT INTO mobile_media_links(server_id,user_id,dataset_id,kind,media_id,json) VALUES(?,?,?,'workbench-input',?,?) ON CONFLICT(server_id,user_id,dataset_id,kind,media_id) DO NOTHING", [...values(), file.mediaId, nativeJson({ mediaId: file.mediaId })]); }); }
      finally { files.releasePrepared(prepared); }
    },
    async commitSessionWithAttachments(input, prepared) {
      try {
        return await tx(async () => {
          if (!input.id || input.id.length > 200) fail("SESSION_INVALID", 400);
          const previous = await get<StoredSession>("session", input.id);
          if (input.baseRevision === undefined) { if (previous) fail("SESSION_EXISTS"); }
          else if (!previous || (await summary(previous)).revision !== input.baseRevision) fail("SESSION_CONFLICT");
          await files.commitPrepared(database, actor, prepared);
          return writeSession(input.id, input.title, input.payload, previous);
        });
      } finally { files.releasePrepared(prepared); }
    }
  };
}
