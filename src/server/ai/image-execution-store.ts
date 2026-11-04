/**
 * R1：制图尝试的**权威状态存储**（任务书 §4.1/§4.2）。
 *
 * 职责只有一件：为付费图片请求保存身份、出站状态与未交付结果，
 * 让「外部副作用与本地落盘」的双写问题有持久记录可查。
 * - 短事务：不持有 SQLite 事务等待供应商；并发靠条件更新与唯一约束；
 * - 容量：会话正文 + 未转存结果 + 在途预留合并计入现有会话 510 MiB 上限；
 *   出站前按最大响应预留，空间不足零供应商请求，不驱逐其他结果；
 * - 晚到响应只能条件更新已有行，不能重新插入、不能复活已删会话；
 * - 只清理已核实转存的结果（会话更新事务核对附件摘要后清除临时字节）；
 * - 不存密钥、完整模型上下文、Memory 快照或原图副本（原图用既有会话来源快照）。
 */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { inTransaction, type SqliteStoreError } from "./sqlite-db";
import type { ImageAttemptStatus } from "@/features/ai/image-execution-contract";

/** 来源 dataUrl → 字节摘要（转存核对用；格式与客户端可读性判定一致）。 */
export function digestImageDataUrl(dataUrl: string): string | undefined {
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) return undefined;
  return bytesDigest(new Uint8Array(Buffer.from(match[1]!, "base64")));
}

/** 请求摘要的规范输入（C2）：从服务端解析后的实际请求计算，不含任何客户端自报值。 */
export type RequestDigestInput = {
  mode: "generate" | "edit";
  prompt: string;
  size: string;
  quality: string;
  outputFormat?: "png" | "jpeg";
  /** 有序来源字节摘要（解码后 sha256，按出站顺序）。 */
  sourceDigests: string[];
  configDigest: string;
};

/** 服务端核定的请求摘要：绑定 attemptId 与实际出站内容；不同摘要必须拒绝。 */
export function requestDigest(input: RequestDigestInput): string {
  return createHash("sha256")
    .update(JSON.stringify({
      mode: input.mode,
      prompt: input.prompt,
      size: input.size,
      quality: input.quality,
      sourceDigests: input.sourceDigests,
      configDigest: input.configDigest,
      ...(input.outputFormat !== undefined ? { outputFormat: input.outputFormat } : {})
    }))
    .digest("hex");
}

/** 来源字节摘要（解码后 sha256）：计划固定与出站核对使用同一把尺子。 */
export function bytesDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type AttemptRow = {
  attemptId: string;
  sessionId: string;
  messageId: string;
  executionId: string;
  itemId: string;
  attemptNo: number;
  previousAttemptId: string | null;
  requestDigest: string;
  configDigest: string;
  status: ImageAttemptStatus;
  errorCode: string | null;
  deadlineAt: string;
  createdAt: string;
  updatedAt: string;
  reservedBytes: number;
  artifactId: string | null;
  artifactDigest: string | null;
  artifactMime: string | null;
  resultJson: string | null;
};

function rowToAttempt(row: Record<string, unknown> | undefined): AttemptRow | undefined {
  if (!row) return undefined;
  return {
    attemptId: String(row.attemptId),
    sessionId: String(row.sessionId),
    messageId: String(row.messageId),
    executionId: String(row.executionId),
    itemId: String(row.itemId),
    attemptNo: Number(row.attemptNo),
    previousAttemptId: row.previousAttemptId === null || row.previousAttemptId === undefined ? null : String(row.previousAttemptId),
    requestDigest: String(row.requestDigest),
    configDigest: String(row.configDigest),
    status: String(row.status) as ImageAttemptStatus,
    errorCode: row.errorCode === null || row.errorCode === undefined ? null : String(row.errorCode),
    deadlineAt: String(row.deadlineAt),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    reservedBytes: Number(row.reservedBytes ?? 0),
    artifactId: row.artifactId === null || row.artifactId === undefined ? null : String(row.artifactId),
    artifactDigest: row.artifactDigest === null || row.artifactDigest === undefined ? null : String(row.artifactDigest),
    artifactMime: row.artifactMime === null || row.artifactMime === undefined ? null : String(row.artifactMime),
    resultJson: row.resultJson === null || row.resultJson === undefined ? null : String(row.resultJson)
  };
}

function getAttemptRow(database: DatabaseSync, attemptId: string): AttemptRow | undefined {
  return rowToAttempt(
    database.prepare("SELECT * FROM workbench_image_attempts WHERE attemptId = ?").get(attemptId) as Record<string, unknown> | undefined
  );
}

export function getAttempt(database: DatabaseSync, attemptId: string): AttemptRow | undefined {
  return getAttemptRow(database, attemptId);
}

/**
 * 会话当前占用：正文字节 + 未转存结果 + 在途预留（§4.2「按事务最终状态计算容量」）。
 * 成功但仍有 `resultJson` 的行按其实际字节计；失败/未知终态预留已释放，不计。
 */
function occupiedBytes(database: DatabaseSync, sessionId: string, excludeAttemptId?: string): { payloadBytes: number; reservedBytes: number } {
  const payloadRow = database
    .prepare("SELECT length(CAST(payloadJson AS BLOB)) AS bytes FROM workbench_sessions WHERE id = ?")
    .get(sessionId) as { bytes?: number } | undefined;
  const reservedRow = database
    .prepare(
      `SELECT COALESCE(SUM(reservedBytes), 0) AS bytes FROM workbench_image_attempts
       WHERE sessionId = ? AND attemptId <> ? AND (status IN ('prepared','dispatched') OR resultJson IS NOT NULL)`
    )
    .get(sessionId, excludeAttemptId ?? "") as { bytes?: number } | undefined;
  return { payloadBytes: Number(payloadRow?.bytes ?? 0), reservedBytes: Number(reservedRow?.bytes ?? 0) };
}

/** 会话的在途预留 + 未转存结果合计（供会话更新事务按最终状态校验总量）。 */
export function reservedBytesForSession(database: DatabaseSync, sessionId: string): number {
  const reservedRow = database
    .prepare(
      `SELECT COALESCE(SUM(reservedBytes), 0) AS bytes FROM workbench_image_attempts
       WHERE sessionId = ? AND (status IN ('prepared','dispatched') OR resultJson IS NOT NULL)`
    )
    .get(sessionId) as { bytes?: number } | undefined;
  return Number(reservedRow?.bytes ?? 0);
}

export type RegisterDispatchInput = {
  attemptId: string;
  sessionId: string;
  messageId: string;
  executionId: string;
  itemId: string;
  attemptNo: number;
  previousAttemptId?: string;
  requestDigest: string;
  configDigest: string;
  /** 出站前按最大响应预留的字节数。 */
  reservationBytes: number;
  /** 合并容量上限（会话正文 + 未转存结果 + 在途预留；调用方传入现有会话上限）。 */
  capacityLimitBytes: number;
  deadlineAt: string;
  now: string;
};

export type RegisterDispatchResult =
  | { ok: true; row: AttemptRow; /** true = 该 attemptId 早已登记（幂等重放）；调用方不得再次出站。 */ alreadyRegistered?: boolean }
  | {
      ok: false;
      code: "CAPACITY" | "DUPLICATE" | "STALE" | "ATTEMPT_CONFLICT" | "PREVIOUS_SUCCEEDED";
      row?: AttemptRow;
      detail: string;
    };

/**
 * 登记「即将出站」：容量核对 + 唯一约束在**同一事务**内完成；
 * 事务提交即代表 `dispatched` 已持久化，调用方才可以调用 Provider。
 *
 * 幂等与冲突（§4.2.3）：
 * - 相同 attemptId 再次登记：**完整身份绑定**（session/message/execution/item/序号/上一尝试）
 *   或摘要不一致 → `ATTEMPT_CONFLICT`（防止旧 ID 误取另一条消息的产物）；
 *   全部一致 → 返回已有行（调用方据此返回原结果/原状态，零新的供应商请求）；
 * - `(sessionId, executionId, itemId, attemptNo)` 已被占用 → `DUPLICATE`
 *   （双标签同时补修，只有一个登记成功）；
 * - 携带 previousAttemptId 时它必须是该项**仍为最新**的尝试；没有上一尝试时该项必须
 *   还没有任何已登记尝试 → 否则 `STALE`（客户端状态过期）；
 * - 上一尝试已 `succeeded` → `PREVIOUS_SUCCEEDED`（C2：已成功项必须取回原产物，
 *   不能再次调用供应商；调用方应引导走恢复查询）。
 */
export function registerDispatch(database: DatabaseSync, input: RegisterDispatchInput): RegisterDispatchResult {
  return inTransaction(
    database,
    () => {
      const existing = getAttemptRow(database, input.attemptId);
      if (existing) {
        const identityMatches =
          existing.sessionId === input.sessionId &&
          existing.messageId === input.messageId &&
          existing.executionId === input.executionId &&
          existing.itemId === input.itemId &&
          existing.attemptNo === input.attemptNo &&
          (existing.previousAttemptId ?? undefined) === input.previousAttemptId;
        if (!identityMatches || existing.requestDigest !== input.requestDigest) {
          return { ok: false as const, code: "ATTEMPT_CONFLICT" as const, row: existing,
            detail: "相同尝试 ID 携带了不同的身份绑定或请求内容，已拒绝。" };
        }
        return { ok: true as const, row: existing, alreadyRegistered: true };
      }
      // 上一尝试核对：必须在事务内确认它仍是该项最新尝试（阻止双标签同时补修）。
      const itemRows = database
        .prepare(
          "SELECT * FROM workbench_image_attempts WHERE sessionId = ? AND executionId = ? AND itemId = ? ORDER BY attemptNo DESC"
        )
        .all(input.sessionId, input.executionId, input.itemId) as Record<string, unknown>[];
      const previousRow = input.previousAttemptId
        ? itemRows.map(rowToAttempt).find((row) => row?.attemptId === input.previousAttemptId)
        : undefined;
      if (input.previousAttemptId) {
        if (!previousRow || Number(previousRow.attemptNo) !== Number(itemRows[0]?.attemptNo)) {
          return { ok: false as const, code: "STALE" as const,
            detail: "所携带的上一尝试已不是该项最新尝试；请刷新后按最新状态操作。" };
        }
        // C2：上一尝试已成功 = 产物已存在，必须取回而不是再次出站。
        if (previousRow.status === "succeeded") {
          return { ok: false as const, code: "PREVIOUS_SUCCEEDED" as const, row: previousRow,
            detail: "上一尝试已成功；请取回原产物，重复出站会造成重复计费。" };
        }
        if (Number(previousRow.attemptNo) + 1 !== input.attemptNo) {
          return { ok: false as const, code: "DUPLICATE" as const, detail: "尝试序号与上一尝试不连续，已拒绝。" };
        }
      } else if (itemRows.length > 0) {
        return { ok: false as const, code: "STALE" as const, detail: "该项已有已登记的尝试；新尝试必须携带上一尝试 ID。" };
      }

      const { payloadBytes, reservedBytes } = occupiedBytes(database, input.sessionId);
      if (payloadBytes + reservedBytes + input.reservationBytes > input.capacityLimitBytes) {
        return { ok: false as const, code: "CAPACITY" as const,
          detail: "会话存储空间不足（含未转存结果与在途预留），本次未发出任何图片请求。" };
      }
      database
        .prepare(
          `INSERT INTO workbench_image_attempts
           (attemptId, sessionId, messageId, executionId, itemId, attemptNo, previousAttemptId, requestDigest, configDigest,
            status, errorCode, deadlineAt, createdAt, updatedAt, reservedBytes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'dispatched', NULL, ?, ?, ?, ?)`
        )
        .run(
          input.attemptId, input.sessionId, input.messageId, input.executionId, input.itemId, input.attemptNo,
          input.previousAttemptId ?? null, input.requestDigest, input.configDigest,
          input.deadlineAt, input.now, input.now, input.reservationBytes
        );
      const row = getAttemptRow(database, input.attemptId)!;
      return { ok: true as const, row };
    },
    (error: unknown, busy: boolean): never => {
      const message = error instanceof Error ? error.message : "";
      // 唯一约束冲突：同一项的同一序号已被并发登记。
      if (/UNIQUE constraint failed/.test(message)) {
        throw new ImageExecutionStoreError("DUPLICATE", "该项已有相同序号的尝试正在登记；只接受第一个。");
      }
      const storeError = error as SqliteStoreError;
      if (storeError?.name === "ImageExecutionStoreError") throw storeError;
      throw new ImageExecutionStoreError(busy ? "BUSY" : "STORE_UNAVAILABLE",
        busy ? "存储正忙，本次未发出图片请求。" : "尝试存储暂时不可用。");
    }
  );
}

export class ImageExecutionStoreError extends Error {
  constructor(readonly code: "DUPLICATE" | "BUSY" | "STORE_UNAVAILABLE", readonly detail: string) {
    super(detail);
    this.name = "ImageExecutionStoreError";
  }
}

export type TerminalOutcome =
  | {
      kind: "succeeded";
      artifactId: string;
      artifactDigest: string;
      artifactMime: string;
      /** 已校验的图片响应（含稳定 artifactId 与字节摘要）；转存核对后清除。 */
      result: Record<string, unknown>;
      resultBytes: number;
      model?: string;
    }
  | { kind: "failed"; errorCode: string }
  | { kind: "outcome_unknown"; errorCode?: string };

export type RecordTerminalResult =
  | { ok: true; row: AttemptRow }
  | { ok: false; code: "NOT_FOUND" | "FINAL"; row?: AttemptRow };

/**
 * 记录终态：**条件更新**已有行（晚到响应不能重新插入）。
 * - 已是终态的行保持原状（幂等；后来的终态证据不覆盖既有事实）；
 * - 明确失败/未知终止释放预留（身份记录保留）；成功把预留转为实际占用；
 * - 成功终态在行内暂存完整图片响应，供重复请求与恢复取回。
 */
export function recordTerminal(database: DatabaseSync, attemptId: string, outcome: TerminalOutcome, now: string): RecordTerminalResult {
  return inTransaction(
    database,
    () => {
      const row = getAttemptRow(database, attemptId);
      if (!row) return { ok: false as const, code: "NOT_FOUND" as const };
      if (row.status === "succeeded" || row.status === "failed" || row.status === "outcome_unknown") {
        return { ok: true as const, row };
      }
      if (outcome.kind === "succeeded") {
        database
          .prepare(
            `UPDATE workbench_image_attempts SET status = 'succeeded', errorCode = NULL, artifactId = ?, artifactDigest = ?,
             artifactMime = ?, resultJson = ?, reservedBytes = ?, updatedAt = ? WHERE attemptId = ? AND status = 'dispatched'`
          )
          .run(outcome.artifactId, outcome.artifactDigest, outcome.artifactMime, JSON.stringify(outcome.result),
            outcome.resultBytes, now, attemptId);
      } else if (outcome.kind === "failed") {
        database
          .prepare(
            `UPDATE workbench_image_attempts SET status = 'failed', errorCode = ?, resultJson = NULL,
             reservedBytes = 0, updatedAt = ? WHERE attemptId = ? AND status = 'dispatched'`
          )
          .run(outcome.errorCode, now, attemptId);
      } else {
        database
          .prepare(
            `UPDATE workbench_image_attempts SET status = 'outcome_unknown', errorCode = ?, resultJson = NULL,
             reservedBytes = 0, updatedAt = ? WHERE attemptId = ? AND status = 'dispatched'`
          )
          .run(outcome.errorCode ?? null, now, attemptId);
      }
      return { ok: true as const, row: getAttemptRow(database, attemptId)! };
    },
    (error: unknown, busy: boolean): never => {
      throw new ImageExecutionStoreError(busy ? "BUSY" : "STORE_UNAVAILABLE",
        busy ? "存储正忙，终态暂未落库。" : "尝试存储暂时不可用。");
    }
  );
}

/**
 * 会话更新事务内**核对已转存**产物并清除临时字节（§4.2.6）。
 * 必须在调用方已开启的事务内运行（先完成会话 payload 更新，再核对最终附件）：
 * 核对条件：行存在、状态 succeeded、artifactDigest 与声明一致、
 * 且最终 payload 中确实存在以 artifactId 为 id 的附件、其字节摘要与行内一致。
 * 只有全部成立才清除 `resultJson` 并释放预留；不成立的行原样保留（不悄悄放行）。
 */
export function clearTransferredArtifacts(
  database: DatabaseSync,
  sessionId: string,
  claims: { attemptId: string; artifactDigest?: string; messageId?: string }[],
  digestAttachment: (dataUrl: string) => string | undefined,
  now: string
): { cleared: number } {
  if (claims.length === 0) return { cleared: 0 };
  const payloadRow = database
    .prepare("SELECT payloadJson FROM workbench_sessions WHERE id = ?")
    .get(sessionId) as { payloadJson?: string } | undefined;
  let payload: { messages?: { id?: string; attachments?: { id?: string; dataUrl?: string }[] }[] };
  try {
    payload = JSON.parse(String(payloadRow?.payloadJson ?? "{}"));
  } catch {
    return { cleared: 0 };
  }
  let cleared = 0;
  for (const claim of claims) {
    const row = getAttemptRow(database, claim.attemptId);
    if (!row || row.sessionId !== sessionId || row.status !== "succeeded" || !row.resultJson) continue;
    if (!claim.artifactDigest || claim.artifactDigest !== row.artifactDigest) continue;
    if (!claim.messageId) continue;
    const message = (payload.messages ?? []).find((item) => item?.id === claim.messageId);
    const attachment = (message?.attachments ?? []).find((item) => item?.id === row.artifactId);
    if (!attachment?.dataUrl) continue;
    if (digestAttachment(attachment.dataUrl) !== row.artifactDigest) continue;
    database
      .prepare(
        "UPDATE workbench_image_attempts SET resultJson = NULL, reservedBytes = 0, updatedAt = ? WHERE attemptId = ? AND resultJson IS NOT NULL"
      )
      .run(now, claim.attemptId);
    cleared += 1;
  }
  return { cleared };
}

/**
 * 删除会话时在**同一事务**内删除关联尝试（调用方持有事务）；
 * 晚到响应因此不能再更新或复活任何记录。
 */
export function deleteSessionAttempts(database: DatabaseSync, sessionId: string): { deleted: number } {
  const info = database.prepare("DELETE FROM workbench_image_attempts WHERE sessionId = ?").run(sessionId);
  return { deleted: Number(info.changes ?? 0) };
}

/**
 * 供会话删除路径在同一事务内调用；这里只暴露行级操作，事务由调用方持有。
 * （`deleteSessionAttempts` 的调用方负责 BEGIN/COMMIT。）
 */
export function attemptClaimsFromPayload(messages: unknown): { attemptId: string; artifactDigest?: string; messageId?: string }[] {
  if (!Array.isArray(messages)) return [];
  const claims: { attemptId: string; artifactDigest?: string; messageId?: string }[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as { id?: unknown; imageAttempts?: unknown };
    if (typeof record.id !== "string" || !Array.isArray(record.imageAttempts)) continue;
    for (const attempt of record.imageAttempts) {
      if (!attempt || typeof attempt !== "object") continue;
      const projection = attempt as { attemptId?: unknown; status?: unknown; artifactDigest?: unknown };
      if (typeof projection.attemptId !== "string" || projection.status !== "succeeded") continue;
      claims.push({
        attemptId: projection.attemptId,
        ...(typeof projection.artifactDigest === "string" ? { artifactDigest: projection.artifactDigest } : {}),
        messageId: record.id
      });
    }
  }
  return claims;
}
