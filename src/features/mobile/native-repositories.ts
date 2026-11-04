import {
  EMPTY_ARCHIVE_CORE, MediaContentConflictError, RevisionConflictError, normalizeArchiveCore,
  type ArchiveCore, type NotebookRepository, type AiCommitOutcome
} from "@/features/notebook/notebook-repository";
import {
  AI_COMMIT_RECEIPT_LIMIT, applyPurge, isAiCommitReceipt, isNotebookMedia, purgeTargets,
  type NotebookMedia
} from "@/features/notebook/notebook-model";
import { isCaptureMedia, isCaptureMessage, updateCaptureMessage, type CaptureArchive, type CaptureMedia } from "@/features/capture/capture-model";
import type { CaptureRepository } from "@/features/capture/capture-repository";
import {
  AiRecordInvalidError, StaleAiWriteError, assertAppliedProposalImmutable, assertNoTerminalDowngrade,
  isAiPageMetadata, isAiProposal, isAiTask,
  type AiRepository, type AiWriteGuard, type AiTask, type AiProposal, type AiPageMetadata
} from "@/features/ai/ai-repository";
import { ACTOR_WHERE, actorValues, StaleNativeDatasetError, type NativeAccount, type NativeActor, type NativeDatabase } from "./native-database";
import { NativeFiles, type PreparedNativeFile } from "./native-files";
import type { WorkbenchMessage } from "@/features/workbench/workbench-types";

type Media = NotebookMedia | CaptureMedia;
type MediaKind = "notebook" | "capture";
export type NativeTaskReceipt = { taskId: string; digest: string; chatSessionId: string; appliedAt: string; ackedAt: string | null };
export type NativeTaskDelivery = { chatSessionId: string; messages: readonly WorkbenchMessage[]; proposals: readonly AiProposal[] };
export type NativeTaskApplyOutcome =
  | { status: "committed" | "replayed"; receipt: NativeTaskReceipt }
  | { status: "digest-conflict" | "stale-dataset" };

/** Keep original bytes out of archives, messages and backup domain JSON. */
export function nativeJson(value: unknown): string {
  return JSON.stringify(value, (key, item) => {
    if ((typeof Blob !== "undefined" && item instanceof Blob) || item instanceof ArrayBuffer || ArrayBuffer.isView(item) || (key === "dataUrl" && typeof item === "string" && item.startsWith("data:"))) throw new Error("NATIVE_JSON_BINARY_FORBIDDEN");
    return item;
  });
}
function parse<T>(value: unknown): T { return JSON.parse(String(value)) as T; }

/** The existing repositories remain the UI boundary; this object binds all three to one captured actor. */
export function createNativeRepositories(database: NativeDatabase, files: NativeFiles, actorInput: NativeActor, now: () => Date = () => new Date()) {
  if (files.database !== database) throw new Error("NATIVE_DATABASE_MISMATCH");
  const actor = Object.freeze({ ...actorInput });
  actorValues(actor);
  const values = () => actorValues(actor);
  const transaction = <T,>(operation: () => Promise<T>) => database.transaction(async () => { await database.assertActor(actor); return operation(); });
  const archive = async (): Promise<ArchiveCore> => {
    const rows = await database.query(`SELECT json FROM mobile_archives WHERE ${ACTOR_WHERE} AND kind='notebook'`, values());
    return normalizeArchiveCore(rows[0] ? parse(rows[0].json) : EMPTY_ARCHIVE_CORE);
  };
  const writeArchive = (next: ArchiveCore) => database.run("INSERT INTO mobile_archives(server_id,user_id,dataset_id,kind,revision,json) VALUES(?,?,?,'notebook',?,?) ON CONFLICT(server_id,user_id,dataset_id,kind) DO UPDATE SET revision=excluded.revision,json=excluded.json", [...values(), next.revision, nativeJson(next)]);
  const captureArchive = async (): Promise<CaptureArchive> => {
    const rows = await database.query(`SELECT json FROM mobile_archives WHERE ${ACTOR_WHERE} AND kind='capture'`, values());
    if (!rows[0]) return { schemaVersion: 1, messages: [] };
    const data = parse<CaptureArchive>(rows[0].json);
    if (data.schemaVersion !== 1 || !Array.isArray(data.messages) || !data.messages.every(isCaptureMessage)) throw new Error("NATIVE_CAPTURE_CORRUPT");
    return data;
  };
  const writeCapture = (next: CaptureArchive) => {
    if (next.schemaVersion !== 1 || !next.messages.every(isCaptureMessage)) throw new Error("NATIVE_CAPTURE_INVALID");
    return database.run("INSERT INTO mobile_archives(server_id,user_id,dataset_id,kind,revision,json) VALUES(?,?,?,'capture',0,?) ON CONFLICT(server_id,user_id,dataset_id,kind) DO UPDATE SET json=excluded.json", [...values(), nativeJson(next)]);
  };
  const mediaRows = (kind: MediaKind) => database.query(`SELECT l.media_id,l.json,m.path,m.sha256,m.size,m.type FROM mobile_media_links l JOIN mobile_media m USING(server_id,user_id,dataset_id,media_id) WHERE l.server_id=? AND l.user_id=? AND l.dataset_id=? AND l.kind=?`, [...values(), kind]);
  const prepare = async (media: readonly Media[], kind: MediaKind) => {
    const prepared: PreparedNativeFile[] = [];
    try {
      for (const item of media) {
        if (!(kind === "notebook" ? isNotebookMedia(item) : isCaptureMedia(item))) throw new Error("NATIVE_MEDIA_INVALID");
        prepared.push(await files.prepare(actor, item));
      }
      return prepared;
    } catch (error) { files.releasePrepared(prepared); throw error; }
  };
  const linkMedia = async (kind: MediaKind, media: readonly Media[], prepared: readonly PreparedNativeFile[]) => {
    await files.commitPrepared(database, actor, prepared);
    for (const item of media) {
      const { blob, ...metadata } = item;
      void blob;
      // Existing metadata (especially confirmed GPS) is retained when identical originals are reused.
      await database.run("INSERT INTO mobile_media_links(server_id,user_id,dataset_id,kind,media_id,json) VALUES(?,?,?,?,?,?) ON CONFLICT(server_id,user_id,dataset_id,kind,media_id) DO NOTHING", [...values(), kind, item.id, nativeJson(metadata)]);
    }
  };
  const removeUnlinkedMedia = () => database.run(`DELETE FROM mobile_media WHERE ${ACTOR_WHERE} AND NOT EXISTS(SELECT 1 FROM mobile_media_links l WHERE l.server_id=mobile_media.server_id AND l.user_id=mobile_media.user_id AND l.dataset_id=mobile_media.dataset_id AND l.media_id=mobile_media.media_id)`, values());
  const clearMediaKind = async (kind: MediaKind) => {
    await database.run(`DELETE FROM mobile_media_links WHERE ${ACTOR_WHERE} AND kind=?`, [...values(), kind]);
    await removeUnlinkedMedia();
  };
  const loadMedia = async <T extends Media>(kind: MediaKind): Promise<T[]> => {
    const rows = await transaction(() => mediaRows(kind));
    const result: T[] = [];
    // Compatibility API is explicit. Normal galleries use metadata + loadMediaBlob by ID.
    for (const row of rows) {
      const blob = await files.read(actor, String(row.media_id));
      if (blob) result.push({ ...parse<Omit<T, "blob">>(row.json), blob } as T);
    }
    return result;
  };
  const loadBlob = async (kind: MediaKind, mediaId: string) => {
    const exists = await transaction(() => database.query(`SELECT media_id FROM mobile_media_links WHERE ${ACTOR_WHERE} AND kind=? AND media_id=?`, [...values(), kind, mediaId]));
    return exists.length ? files.read(actor, mediaId) : undefined;
  };

  const notebook: NotebookRepository & { loadMediaRecordMetadata(): Promise<Omit<NotebookMedia, "blob">[]> } = {
    loadArchive: () => transaction(archive),
    saveArchive: (next) => transaction(async () => { await archive(); await writeArchive(normalizeArchiveCore(next)); }),
    saveArchiveIfRevision: (next, expected) => transaction(async () => {
      const current = await archive();
      if (current.revision !== expected) throw new RevisionConflictError(expected, current.revision);
      const normalized = normalizeArchiveCore(next);
      await writeArchive(normalized); return { revision: normalized.revision };
    }),
    async commitJournalChange(change, options = {}) {
      const media = options.media ?? [];
      const prepared = await prepare(media, "notebook");
      try {
        return await transaction(async () => {
          const current = await archive();
          if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) throw new RevisionConflictError(options.expectedRevision, current.revision);
          const committed = { ...normalizeArchiveCore(change(current)), revision: current.revision + 1 };
          await linkMedia("notebook", media, prepared);
          await writeArchive(committed);
          return { archive: committed, revision: committed.revision };
        });
      } finally { files.releasePrepared(prepared); }
    },
    commitJournalChangeWithReceipt: (change, input, options = {}) => transaction<AiCommitOutcome>(async () => {
      const current = await archive();
      if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) return { status: "revision-conflict", currentRevision: current.revision };
      const requestedDigest = input.payloadDigest(current);
      const existing = current.aiCommitReceipts.find((receipt) => receipt.operationId === input.operationId);
      if (existing) return existing.payloadDigest === requestedDigest
        ? { status: "replayed", archive: current, revision: current.revision, receipt: existing }
        : { status: "conflict", existing, requestedDigest };
      if (current.aiCommitReceipts.length >= AI_COMMIT_RECEIPT_LIMIT) return { status: "receipt-limit", limit: AI_COMMIT_RECEIPT_LIMIT };
      const changed = change(current);
      const next = { ...changed.archive, revision: current.revision + 1 };
      if (options.guard) {
        const rows = await mediaRows("notebook");
        const available = new Set<string>();
        const sizes = new Map<string, number>();
        for (const row of rows) {
          const info = await files.port.stat(String(row.path));
          if (info?.size === row.size) { available.add(String(row.media_id)); sizes.set(String(row.media_id), Number(row.size)); }
        }
        options.guard.validate({ stored: current, next, resolvableMediaIds: available, assetSizes: sizes });
      }
      const receipt = { ...changed.receipt, operationId: input.operationId, payloadDigest: requestedDigest, appliedAt: (input.now ?? now)().toISOString() };
      if (!isAiCommitReceipt(receipt)) throw new Error("AI_COMMIT_RECEIPT_INVALID");
      const committed = normalizeArchiveCore({ ...next, aiCommitReceipts: [...current.aiCommitReceipts, receipt] });
      await writeArchive(committed);
      return { status: "committed", archive: committed, revision: committed.revision, receipt };
    }),
    loadMedia: () => loadMedia<NotebookMedia>("notebook"),
    loadMediaMetadata: () => transaction(async () => (await mediaRows("notebook")).map((row) => {
      const { id, name, type, size, createdAt, gps } = parse<Omit<NotebookMedia, "blob">>(row.json);
      return { id, name, type, size, createdAt, ...(gps ? { gps } : {}) };
    })),
    loadMediaRecordMetadata: () => transaction(async () => (await mediaRows("notebook")).map((row) => parse<Omit<NotebookMedia, "blob">>(row.json))),
    loadMediaBlob: (id) => loadBlob("notebook", id),
    loadMediaBlobs: (ids) => Promise.all(ids.map((id) => loadBlob("notebook", id))),
    async saveMedia(media) {
      const prepared = await prepare(media, "notebook");
      try { await transaction(() => linkMedia("notebook", media, prepared)); }
      finally { files.releasePrepared(prepared); }
    },
    updateMediaGps: (entries, options) => transaction(async () => {
      let written = 0;
      for (const entry of entries) {
        const row = (await database.query(`SELECT json FROM mobile_media_links WHERE ${ACTOR_WHERE} AND kind='notebook' AND media_id=?`, [...values(), entry.mediaId]))[0];
        if (!row) throw new Error(`MEDIA_NOT_FOUND:${entry.mediaId}`);
        const current = parse<Omit<NotebookMedia, "blob">>(row.json);
        if (options?.onlyIfAbsent && current.gps) continue;
        await database.run(`UPDATE mobile_media_links SET json=? WHERE ${ACTOR_WHERE} AND kind='notebook' AND media_id=?`, [nativeJson({ ...current, gps: entry.gps }), ...values(), entry.mediaId]); written += 1;
      }
      return written;
    }),
    clearMediaGps: (ids) => transaction(async () => {
      let cleared = 0;
      for (const id of ids) {
        const row = (await database.query(`SELECT json FROM mobile_media_links WHERE ${ACTOR_WHERE} AND kind='notebook' AND media_id=?`, [...values(), id]))[0];
        if (!row) continue;
        const { gps, ...rest } = parse<Omit<NotebookMedia, "blob">>(row.json);
        if (!gps) continue;
        await database.run(`UPDATE mobile_media_links SET json=? WHERE ${ACTOR_WHERE} AND kind='notebook' AND media_id=?`, [nativeJson(rest), ...values(), id]); cleared += 1;
      }
      return cleared;
    }),
    removeMedia: (id) => transaction(async () => { await database.run(`DELETE FROM mobile_media_links WHERE ${ACTOR_WHERE} AND kind='notebook' AND media_id=?`, [...values(), id]); await removeUnlinkedMedia(); }),
    purgeTrash: (input) => transaction(async () => {
      const current = await archive();
      if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) return { status: "conflict", currentRevision: current.revision };
      const plan = purgeTargets(current, input.targets);
      if (!plan.pageIds.length && !plan.notebookIds.length) return { status: "skipped", archive: current, reason: "identity-changed", skipped: plan.skipped };
      const committed = { ...normalizeArchiveCore(applyPurge(current, plan, now)), revision: current.revision + 1 };
      for (const id of plan.mediaIds) await database.run(`DELETE FROM mobile_media_links WHERE ${ACTOR_WHERE} AND kind='notebook' AND media_id=?`, [...values(), id]);
      await removeUnlinkedMedia(); await writeArchive(committed);
      return { status: "purged", archive: committed, revision: committed.revision, purged: plan };
    }),
    clear: () => transaction(async () => { await database.run(`DELETE FROM mobile_archives WHERE ${ACTOR_WHERE} AND kind='notebook'`, values()); await clearMediaKind("notebook"); })
  };
  const capture: CaptureRepository & { loadMediaMetadata(): Promise<Omit<CaptureMedia, "blob">[]> } = {
    loadArchive: () => transaction(captureArchive),
    saveArchive: (next) => transaction(() => writeCapture(next)),
    updateMessage: (input) => transaction(async () => {
      const current = await captureArchive();
      const result = updateCaptureMessage(current, input.messageId, { text: input.text, mediaIds: input.mediaIds }, input.expectedUpdatedAt);
      if (result.status === "updated") await writeCapture(result.archive);
      return result;
    }),
    loadMedia: () => loadMedia<CaptureMedia>("capture"),
    loadMediaMetadata: () => transaction(async () => (await mediaRows("capture")).map((row) => parse<Omit<CaptureMedia, "blob">>(row.json))),
    loadMediaBlob: (id) => loadBlob("capture", id),
    async saveMedia(media) {
      const prepared = await prepare(media, "capture");
      try { await transaction(() => linkMedia("capture", media, prepared)); }
      finally { files.releasePrepared(prepared); }
    },
    clear: () => transaction(async () => { await database.run(`DELETE FROM mobile_archives WHERE ${ACTOR_WHERE} AND kind='capture'`, values()); await clearMediaKind("capture"); })
  };

  const getRecord = async <T,>(kind: string, id: string): Promise<T | null> => {
    const row = (await database.query(`SELECT json FROM mobile_records WHERE ${ACTOR_WHERE} AND kind=? AND record_id=?`, [...values(), kind, id]))[0];
    return row ? parse<T>(row.json) : null;
  };
  const listRecords = async <T,>(kind: string): Promise<T[]> => (await database.query(`SELECT json FROM mobile_records WHERE ${ACTOR_WHERE} AND kind=?`, [...values(), kind])).map((row) => parse<T>(row.json));
  const putRecord = (kind: string, id: string, record: unknown) => database.run("INSERT INTO mobile_records(server_id,user_id,dataset_id,kind,record_id,json) VALUES(?,?,?,?,?,?) ON CONFLICT(server_id,user_id,dataset_id,kind,record_id) DO UPDATE SET json=excluded.json", [...values(), kind, id, nativeJson(record)]);
  const readTask = async (id: string) => { const record = await getRecord("task", id); return isAiTask(record) ? record : null; };
  const readProposal = async (id: string) => { const record = await getRecord("proposal", id); return isAiProposal(record) ? record : null; };
  const guard = (kind: "task" | "proposal", id: string, current: { status: string; revision: number } | null, expected?: AiWriteGuard) => {
    if (expected && ((expected.expectedStatus !== undefined && current?.status !== expected.expectedStatus) || (expected.expectedRevision !== undefined && current?.revision !== expected.expectedRevision))) throw new StaleAiWriteError(kind, id, { status: expected.expectedStatus, revision: expected.expectedRevision }, current);
  };
  const saveTask = async (task: AiTask, expected?: AiWriteGuard) => {
    if (!isAiTask(task)) throw new AiRecordInvalidError("task", String((task as { id?: unknown })?.id ?? ""));
    const current = await readTask(task.id);
    guard("task", task.id, current, expected); assertNoTerminalDowngrade(current, task); await putRecord("task", task.id, task);
  };
  const saveProposal = async (proposal: AiProposal, expected?: AiWriteGuard) => {
    if (!isAiProposal(proposal)) throw new AiRecordInvalidError("proposal", String((proposal as { id?: unknown })?.id ?? ""));
    const current = await readProposal(proposal.id);
    guard("proposal", proposal.id, current, expected); assertAppliedProposalImmutable(current, proposal); await putRecord("proposal", proposal.id, proposal);
  };
  const saveMetadata = async (metadata: AiPageMetadata) => {
    if (!isAiPageMetadata(metadata)) throw new AiRecordInvalidError("pageMetadata", String((metadata as { pageId?: unknown })?.pageId ?? ""));
    await putRecord("metadata", metadata.pageId, metadata);
  };
  const ai: AiRepository = {
    saveTask: (task, expected) => transaction(() => saveTask(task, expected)),
    getTask: (id) => transaction(() => readTask(id)), listTasks: () => transaction(async () => (await listRecords("task")).filter(isAiTask)),
    saveProposal: (proposal, expected) => transaction(() => saveProposal(proposal, expected)),
    getProposal: (id) => transaction(() => readProposal(id)), listProposals: () => transaction(async () => (await listRecords("proposal")).filter(isAiProposal)),
    savePageMetadata: (metadata) => transaction(() => saveMetadata(metadata)),
    getPageMetadata: (id) => transaction(async () => { const record = await getRecord("metadata", id); return isAiPageMetadata(record) ? record : null; }), listPageMetadata: () => transaction(async () => (await listRecords("metadata")).filter(isAiPageMetadata)),
    saveTaskWithProposal: (input) => transaction(async () => { await saveTask(input.task, { expectedRevision: input.expectedRevision }); await saveProposal(input.proposal); }),
    saveTaskWithMetadata: (input) => transaction(async () => { await saveTask(input.task, { expectedRevision: input.expectedRevision }); await saveMetadata(input.metadata); }),
    authorizeCommit: (input) => transaction(async () => {
      const current = await readProposal(input.proposalId);
      if (!current) throw new StaleAiWriteError("proposal", input.proposalId, { revision: input.expectedRevision }, null);
      if (current.revision !== input.expectedRevision) return { ok: false, status: current.status };
      const task = await readTask(current.taskId);
      if (!task || task.status !== "waiting_user" || task.proposalId !== current.id) return { ok: false, status: current.status };
      if (current.status === "accepting") return { ok: true, proposal: current };
      if (current.status !== "accepted") return { ok: false, status: current.status };
      const accepting = { ...current, status: "accepting" as const, revision: current.revision + 1 };
      await putRecord("proposal", accepting.id, accepting); return { ok: true, proposal: accepting };
    }),
    clear: () => transaction(() => database.run(`DELETE FROM mobile_records WHERE ${ACTOR_WHERE} AND kind IN ('task','proposal','metadata')`, values()))
  };

  const taskReceipt = async (taskId: string): Promise<NativeTaskReceipt | null> => {
    const row = (await database.query(`SELECT task_id,digest,chat_session_id,applied_at,acked_at FROM tasks_inbox WHERE ${ACTOR_WHERE} AND task_id=?`, [...values(), taskId]))[0];
    return row ? { taskId: String(row.task_id), digest: String(row.digest), chatSessionId: String(row.chat_session_id), appliedAt: String(row.applied_at), ackedAt: row.acked_at === null ? null : String(row.acked_at) } : null;
  };
  return {
    actor, notebook, capture, ai,
    async applyTaskResult(requestActor: NativeActor, taskId: string, digest: string, preparedFiles: readonly PreparedNativeFile[], delivery: NativeTaskDelivery): Promise<NativeTaskApplyOutcome> {
      if (JSON.stringify(actorValues(requestActor)) !== JSON.stringify(values())) { files.releasePrepared(preparedFiles); return { status: "stale-dataset" }; }
      if (!taskId || !/^[a-f0-9]{64}$/.test(digest) || !delivery.chatSessionId || delivery.messages.some((message) => !message.id || message.role !== "assistant" || message.status === "pending") || delivery.proposals.some((proposal) => !isAiProposal(proposal) || proposal.taskId !== taskId || proposal.status !== "draft")) throw new Error("NATIVE_TASK_RESULT_INVALID");
      try {
        return await transaction(async () => {
          const existing = await taskReceipt(taskId);
          if (existing) return existing.digest === digest && existing.chatSessionId === delivery.chatSessionId ? { status: "replayed", receipt: existing } : { status: "digest-conflict" };
          if (!await getRecord("session", delivery.chatSessionId)) throw new Error("NATIVE_CHAT_SESSION_MISSING");
          const usage = (await database.query(`SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(json AS BLOB))),0) AS bytes FROM mobile_records WHERE ${ACTOR_WHERE} AND kind='message' AND json_extract(json,'$.chatSessionId')=?`, [...values(), delivery.chatSessionId]))[0];
          if (Number(usage.count) + delivery.messages.length > 1000) throw new Error("NATIVE_SESSION_TOO_LARGE");
          const originalRows = await database.query(`SELECT DISTINCT m.media_id,m.size FROM mobile_media m JOIN mobile_media_links l USING(server_id,user_id,dataset_id,media_id) WHERE m.server_id=? AND m.user_id=? AND m.dataset_id=? AND (l.kind=? OR (l.kind LIKE 'task:%' AND json_extract(l.json,'$.chatSessionId')=?))`, [...values(), `session:${delivery.chatSessionId}`, delivery.chatSessionId]);
          const originalSizes = new Map(originalRows.map((row) => [String(row.media_id), Number(row.size)]));
          for (const file of preparedFiles) originalSizes.set(file.mediaId, file.size);
          const incomingBytes = new TextEncoder().encode(nativeJson(delivery.messages)).length;
          if (Number(usage.bytes) + incomingBytes + [...originalSizes.values()].reduce((sum, size) => sum + size, 0) > 510 * 1024 * 1024) throw new Error("NATIVE_SESSION_TOO_LARGE");
          await files.commitPrepared(database, actor, preparedFiles);
          for (const file of preparedFiles) await database.run("INSERT INTO mobile_media_links(server_id,user_id,dataset_id,kind,media_id,json) VALUES(?,?,?,?,?,?) ON CONFLICT(server_id,user_id,dataset_id,kind,media_id) DO NOTHING", [...values(), `task:${taskId}`, file.mediaId, nativeJson({ taskId, chatSessionId: delivery.chatSessionId })]);
          for (const message of delivery.messages) {
            const existing = await getRecord<{ chatSessionId: string }>("message", message.id);
            // 同一会话内的同 id 是发起时已持久化的 pending 占位（任务结果完成它）；
            // 跨会话占用同一消息 id 才是冲突，防止一个聊天认领另一个聊天的身份。
            if (existing && existing.chatSessionId !== delivery.chatSessionId) throw new Error("NATIVE_MESSAGE_ID_CONFLICT");
            await putRecord("message", message.id, { chatSessionId: delivery.chatSessionId, message });
          }
          for (const proposal of delivery.proposals) {
            if (await getRecord("proposal", proposal.id)) throw new Error("NATIVE_PROPOSAL_ID_CONFLICT");
            await saveProposal(proposal);
          }
          const receipt: NativeTaskReceipt = { taskId, digest, chatSessionId: delivery.chatSessionId, appliedAt: now().toISOString(), ackedAt: null };
          await database.run("INSERT INTO tasks_inbox(server_id,user_id,dataset_id,task_id,digest,chat_session_id,applied_at,acked_at) VALUES(?,?,?,?,?,?,?,NULL)", [...values(), taskId, digest, delivery.chatSessionId, receipt.appliedAt]);
          return { status: "committed", receipt };
        });
      } catch (error) {
        if (error instanceof StaleNativeDatasetError) return { status: "stale-dataset" };
        throw error;
      } finally { files.releasePrepared(preparedFiles); }
    },
    readTaskReceipt: (taskId: string) => transaction(() => taskReceipt(taskId)),
    listTaskReceipts: () => transaction(async () => (await database.query(`SELECT task_id,digest,chat_session_id,applied_at,acked_at FROM tasks_inbox WHERE ${ACTOR_WHERE} ORDER BY applied_at`, values())).map(row => ({
      taskId: String(row.task_id), digest: String(row.digest), chatSessionId: String(row.chat_session_id),
      appliedAt: String(row.applied_at), ackedAt: row.acked_at === null ? null : String(row.acked_at)
    }))),
    markTaskAcknowledged: (taskId: string, digest: string) => transaction(async () => {
      const receipt = await taskReceipt(taskId);
      if (!receipt || receipt.digest !== digest) throw new Error("NATIVE_ACK_RECEIPT_MISMATCH");
      if (!receipt.ackedAt) await database.run(`UPDATE tasks_inbox SET acked_at=? WHERE ${ACTOR_WHERE} AND task_id=? AND digest=?`, [now().toISOString(), ...values(), taskId, digest]);
    }),
    async clearCurrentData(newDatasetId: string) {
      // R6：清空、dataset 轮换与 pending-cleanup 线索**同一事务**——线索写入失败整个
      // 清空回滚（不出现"已清空但无清理线索"或反之）；失败保留记录供重开重试。
      const staleNamespace = await files.namespace(actor);
      const next = await database.clearAccountWithCleanup(actor, newDatasetId, async db => {
        await db.run("INSERT INTO mobile_records(server_id,user_id,dataset_id,kind,record_id,json) VALUES(?,?,?,?,?,?) ON CONFLICT(server_id,user_id,dataset_id,kind,record_id) DO UPDATE SET json=excluded.json",
          [actor.serverId, actor.userId, newDatasetId, "kv", `pending-cleanup:${staleNamespace}`, nativeJson({ namespace: staleNamespace, clearedAt: new Date().toISOString() })]);
      });
      files.releaseObjectUrls(actor);
      return {
        actor: next,
        // 即时清理成功即删记录；失败保留记录（F7 持久重试线索，由 boot 恢复路径收尾）。
        cleanup: async () => {
          await files.sweepNamespace(staleNamespace);
          await database.transaction(async db => {
            await db.run("DELETE FROM mobile_records WHERE server_id=? AND user_id=? AND dataset_id=? AND kind='kv' AND record_id=?",
              [next.serverId, next.userId, next.datasetId, `pending-cleanup:${staleNamespace}`]);
          });
        }
      };
    }
  };
}

/**
 * F7：重开恢复——清理仍挂起的已清空命名空间（即时清理失败的持久重试路径）。
 * 清除成功才删记录；失败保留记录（清理线索）。只处理当前账号（serverId/userId 匹配）的记录。
 */
export async function recoverPendingCleanups(
  database: NativeDatabase,
  files: NativeFiles,
  account: NativeAccount
): Promise<{ swept: number; pending: number }> {
  const rows = await database.query<{ record_id: string; json: string; dataset_id: string }>(
    "SELECT record_id,json,dataset_id FROM mobile_records WHERE server_id=? AND user_id=? AND kind='kv' AND record_id LIKE 'pending-cleanup:%'",
    [account.serverId, account.userId]);
  let swept = 0;
  let pending = 0;
  for (const row of rows) {
    const record = parse<{ namespace?: string }>(row.json);
    if (!record.namespace || !/^xingji-mobile-v1\/[a-f0-9]{64}\/$/.test(record.namespace)) continue;
    try {
      await files.sweepNamespace(record.namespace);
      await database.transaction(async db => {
        await db.run("DELETE FROM mobile_records WHERE server_id=? AND user_id=? AND dataset_id=? AND kind='kv' AND record_id=?",
          [account.serverId, account.userId, row.dataset_id, row.record_id]);
      });
      swept += 1;
    } catch {
      pending += 1;
    }
  }
  return { swept, pending };
}

export { MediaContentConflictError };
