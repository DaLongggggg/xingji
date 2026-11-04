import { completeMessageTimeline } from "@/features/workbench/workbench-message-timeline";
/**
 * T6a/T7：手机任务客户端——创建、观察、领取、交付与 ACK 的唯一出站通道。
 *
 * 职责（任务书 §9）：
 * - 全部请求经受控认证入口（apiFetch：Bearer + credentials omit），dataset 只走
 *   `X-Xingji-Dataset` 头，不从正文 fallback；
 * - 交付粘合 `deliverTaskToNative`：下载产物 → 复核 manifest 摘要 → 原生文件
 *   prepare（Directory.Data 独占发布）→ `applyTaskResult` 单事务（聊天结果、媒体
 *   引用与 tasks_inbox 收据）→ 提交成功才补本地 ACK 并请求服务端 ACK；
 * - 迟到/归属守卫：actor 捕获后交由 `applyTaskResult` 复核（stale-dataset 不 ACK、
 *   digest-conflict 不 ACK、replayed 只补 ACK 不重复效果）；结果未知不自动重发。
 * 摘要出口注入（移动端 HTTP 非安全上下文没有 crypto.subtle，走原生桥受控摘要）。
 */
import { apiFetch } from "@/lib/api-client";
import {
  agentTaskDigest,
  stableTaskJson,
  type AgentTaskCreateInput,
  type AgentTaskEvent,
  type AgentTaskFile,
  type AgentTaskResult,
  type AgentTaskSummary
} from "@/features/ai/agent-task-contract";
import type { WorkbenchMessage, WorkbenchMessageBlock, WorkbenchAdapter, WorkbenchTurnResult } from "@/features/workbench/workbench-types";
import type { WorkbenchStreamEvent } from "@/features/ai/stream-events";
import { isAllowedSkillPath } from "@/features/ai/skill-knowledge";
import { composeImageInstruction } from "@/features/creation/creation-image-rules";
import type { MemoryState } from "@/features/workbench/workbench-memory";
import type { NativeTaskDelivery, NativeTaskReceipt } from "./native-repositories";
import type { NativeActor, NativeDatabase } from "./native-database";
import type { NativeFiles, PreparedNativeFile } from "./native-files";

export type MobileTaskClientDeps = {
  /** 受控认证入口；测试注入。默认 apiFetch（Bearer 单一接缝）。 */
  fetchImpl?: typeof fetch;
  /** 摘要出口；默认 agentTaskDigest（crypto.subtle），移动端注入原生桥摘要。 */
  digest?(value: Uint8Array | string): Promise<string>;
  now?(): number;
};

export class MobileTaskClientError extends Error {
  constructor(readonly code: string, detail: string, readonly status?: number) {
    super(detail);
    this.name = "MobileTaskClientError";
  }
}

/** 客户端默认摘要出口：WebCrypto 可用时直接用；不可用要求调用方注入（原生桥）。 */
async function defaultSha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new MobileTaskClientError("DIGEST_UNAVAILABLE", "当前环境没有 WebCrypto；请注入受控摘要出口。");
  const buffer = await subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

type JsonRecord = Record<string, unknown>;
async function readJson(response: Response): Promise<JsonRecord> {
  const payload = (await response.json().catch(() => null)) as JsonRecord | null;
  if (!response.ok || !payload || payload.ok !== true) {
    const code = typeof payload?.error === "string" ? payload.error : "TASK_SERVICE_UNAVAILABLE";
    throw new MobileTaskClientError(code, `任务服务请求失败：${code}`, response.status);
  }
  return payload;
}
const isRecord = (value: unknown): value is JsonRecord => !!value && typeof value === "object" && !Array.isArray(value);

export function createMobileTaskClient(deps: MobileTaskClientDeps = {}) {
  const fetchImpl = deps.fetchImpl ?? apiFetch;
  const digest = deps.digest ?? defaultSha256;
  const headers = (datasetId: string): HeadersInit => ({ "x-xingji-dataset": datasetId });
  const headers2 = (datasetId: string): Headers => new Headers({ "x-xingji-dataset": datasetId });

  const client = {
    async cancelTask(taskId: string, datasetId: string): Promise<void> {
      await readJson(await fetchImpl(`/api/agent/tasks/${encodeURIComponent(taskId)}/cancel`, {
        method: "POST", headers: headers(datasetId)
      }));
    },
    /** 创建（幂等键 clientRequestId 冲突时返回原任务与 replayed 标记）。 */
    async createTask(input: AgentTaskCreateInput, datasetId: string): Promise<{ task: AgentTaskSummary; replayed: boolean }> {
      const response = await fetchImpl("/api/agent/tasks", {
        method: "POST",
        headers: { ...headers(datasetId), "content-type": "application/json" },
        body: JSON.stringify(input)
      });
      const payload = await readJson(response);
      if (!isRecord(payload.task)) throw new MobileTaskClientError("TASK_RESULT_INVALID", "创建返回缺少任务。");
      return { task: payload.task as unknown as AgentTaskSummary, replayed: payload.replayed === true };
    },

    async listTasks(datasetId: string): Promise<AgentTaskSummary[]> {
      const response = await fetchImpl("/api/agent/tasks", { headers: headers(datasetId) });
      const payload = await readJson(response);
      if (!Array.isArray(payload.tasks)) throw new MobileTaskClientError("TASK_RESULT_INVALID", "任务列表缺失。");
      return payload.tasks as unknown as AgentTaskSummary[];
    },

    async getTask(taskId: string, datasetId: string): Promise<AgentTaskSummary> {
      const response = await fetchImpl(`/api/agent/tasks/${encodeURIComponent(taskId)}`, { headers: headers(datasetId) });
      const payload = await readJson(response);
      if (!isRecord(payload.task)) throw new MobileTaskClientError("TASK_RESULT_INVALID", "任务详情缺失。");
      return payload.task as unknown as AgentTaskSummary;
    },

    async getResult(taskId: string, datasetId: string): Promise<{ taskId: string; digest: string; result: AgentTaskResult }> {
      const response = await fetchImpl(`/api/agent/tasks/${encodeURIComponent(taskId)}/result`, { headers: headers(datasetId) });
      const payload = await readJson(response);
      if (typeof payload.digest !== "string" || !isRecord(payload.result)) throw new MobileTaskClientError("TASK_RESULT_INVALID", "结果负载不完整。");
      return { taskId: String(payload.taskId), digest: payload.digest, result: payload.result as unknown as AgentTaskResult };
    },

    /** 下载产物并复核 manifest 摘要（服务端摘要是权威；落盘前后都以字节复核）。 */
    async downloadArtifact(taskId: string, datasetId: string, file: AgentTaskFile): Promise<Uint8Array> {
      const response = await fetchImpl(`/api/agent/tasks/${encodeURIComponent(taskId)}/files/${encodeURIComponent(file.fileId)}`, { headers: headers(datasetId) });
      if (!response.ok) {
        const code = `TASK_FILE_HTTP_${response.status}`;
        throw new MobileTaskClientError(code, `产物下载失败：${code}`, response.status);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength !== file.bytes) throw new MobileTaskClientError("TASK_FILE_SIZE_MISMATCH", "产物字节数与 manifest 不符。");
      const serverDigest = response.headers.get("x-content-sha256");
      const actual = await digest(bytes);
      if (actual !== file.sha256.toLowerCase() || (serverDigest && serverDigest.toLowerCase() !== actual)) {
        throw new MobileTaskClientError("TASK_FILE_DIGEST_MISMATCH", "产物字节摘要与 manifest 不符。");
      }
      return bytes;
    },

    /** 授权补料：图片材料 multipart（原字节）；文本材料 JSON。 */
    async uploadMaterial(taskId: string, datasetId: string, refId: string, data: Uint8Array | string, mime?: string): Promise<{ replayed: boolean; task: AgentTaskSummary }> {
      let body: BodyInit;
      const headers = headers2(datasetId);
      if (typeof data === "string") {
        headers.set("content-type", "application/json");
        body = JSON.stringify({ refId, text: data });
      } else {
        const form = new FormData();
        form.append("refId", refId);
        form.append("file", new Blob([Uint8Array.from(data)], { type: mime ?? "application/octet-stream" }), refId);
        body = form;
      }
      const response = await fetchImpl(`/api/agent/tasks/${encodeURIComponent(taskId)}/materials`, { method: "POST", headers, body });
      const payload = await readJson(response);
      if (!isRecord(payload.task)) throw new MobileTaskClientError("TASK_RESULT_INVALID", "补料返回缺少任务。");
      return { replayed: payload.replayed === true, task: payload.task as unknown as AgentTaskSummary };
    },

    async acknowledge(taskId: string, datasetId: string, digest: string): Promise<{ ok: boolean; alreadyAcked: boolean }> {
      const response = await fetchImpl(`/api/agent/tasks/${encodeURIComponent(taskId)}/ack`, {
        method: "POST",
        headers: { ...headers(datasetId), "content-type": "application/json" },
        body: JSON.stringify({ digest })
      });
      const payload = await readJson(response);
      return { ok: payload.ok === true, alreadyAcked: payload.alreadyAcked === true };
    },

    /** 观察事件流：转发 WorkbenchStreamEvent 形状的 stream 事件，结束返回终态。 */
    async observe(
      taskId: string,
      datasetId: string,
      onEvent: (event: AgentTaskEvent) => void,
      signal?: AbortSignal
    ): Promise<{ status: string; sequence: number }> {
      let cursor = 0;
      for (let connection = 0; connection < 3; connection++) {
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          const response = await fetchImpl(`/api/agent/tasks/${encodeURIComponent(taskId)}/stream?since=${cursor}`, {
            headers: headers(datasetId), ...(signal ? { signal } : {})
          });
          if (!response.ok || !response.body) throw new MobileTaskClientError(`TASK_STREAM_HTTP_${response.status}`, "事件流不可用。", response.status);
          reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { value, done } = await reader.read();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            if (done && buffer.trim()) buffer += "\n";
            let newline = buffer.indexOf("\n");
            while (newline >= 0) {
              const line = buffer.slice(0, newline).trim();
              buffer = buffer.slice(newline + 1); newline = buffer.indexOf("\n");
              if (!line) continue;
              let parsed: JsonRecord;
              try { parsed = JSON.parse(line) as JsonRecord; } catch { throw new MobileTaskClientError("TASK_STREAM_MALFORMED", "事件流出现无法解析的行。"); }
              if (parsed.type === "event" && isRecord(parsed.event)) {
                const event = parsed.event as unknown as AgentTaskEvent;
                if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) throw new MobileTaskClientError("TASK_STREAM_MALFORMED", "事件游标无效。");
                if (event.sequence <= cursor) continue;
                onEvent(event); cursor = event.sequence;
              } else if (parsed.type === "end") {
                return { status: String(parsed.status ?? "unknown"), sequence: Number(parsed.sequence ?? cursor) };
              }
            }
            if (done) break;
          }
        } catch (error) {
          if (signal?.aborted || error instanceof MobileTaskClientError && error.status >= 400 && error.status < 500) throw error;
          if (connection === 2) throw error;
        } finally { await reader?.cancel().catch(() => undefined); reader?.releaseLock(); }
        // Reconnect only this read-only observer from its durable cursor; never recreate/retry the paid task.
      }
      throw new MobileTaskClientError("TASK_STREAM_ENDED", "重连后仍未收到任务终态，任务未自动重发。");
    }
  };
  return client;
}

export type MobileTaskClient = ReturnType<typeof createMobileTaskClient>;

export type NativeTaskDeliveryPorts = {
  client: MobileTaskClient;
  files: NativeFiles;
  repositories: {
    applyTaskResult(requestActor: NativeActor, taskId: string, digest: string, preparedFiles: readonly PreparedNativeFile[], delivery: NativeTaskDelivery): Promise<
      | { status: "committed" | "replayed"; receipt: NativeTaskReceipt }
      | { status: "digest-conflict" | "stale-dataset" }
    >;
    markTaskAcknowledged(taskId: string, digest: string): Promise<void>;
    listTaskReceipts(): Promise<NativeTaskReceipt[]>;
    readTaskReceipt(taskId: string): Promise<NativeTaskReceipt | null>;
  };
  actor: NativeActor;
  datasetId: string;
  /** 交付消息工厂（助手消息身份由调用方派生并冻结）。 */
  message: (result: AgentTaskResult, taskId: string) => WorkbenchMessage;
  /** 结果摘要出口（原生桥或测试注入；不使用 crypto.subtle 兜底假摘要）。 */
  digest(value: Uint8Array | string): Promise<string>;
};

export type TaskDeliveryOutcome =
  | { status: "committed"; receipt: NativeTaskReceipt; message: WorkbenchMessage }
  | { status: "replayed"; receipt: NativeTaskReceipt; message: WorkbenchMessage }
  | { status: "digest-conflict" | "stale-dataset" }
  | { status: "failed"; code: string };

/**
 * 结果领取与保存：下载产物 → 原生独占发布 → 单事务落地 → 提交成功才 ACK。
 * digest-conflict 与 stale-dataset 明确不 ACK（服务端保留原归属与 TTL）。
 */
export async function deliverTaskToNative(
  ports: NativeTaskDeliveryPorts,
  input: { taskId: string; chatSessionId: string }
): Promise<TaskDeliveryOutcome> {
  const { client, files, repositories, actor, datasetId, message, digest } = ports;
  let result: AgentTaskResult;
  let resultDigest: string;
  try {
    const fetched = await client.getResult(input.taskId, datasetId);
    // 服务端摘要是权威：客户端以同一稳定 JSON 规则复算，不一致按冲突处理（不 ACK）。
    // 服务端摘要是权威：客户端以同一稳定 JSON 规则复算，不一致按冲突处理（不 ACK）。
    const canonical = stableTaskJson(fetched.result);
    const computed = await digest(canonical);
    if (fetched.digest.toLowerCase() !== computed) {
      return { status: "digest-conflict" };
    }
    result = fetched.result;
    resultDigest = fetched.digest;
  } catch (error) {
    return { status: "failed", code: error instanceof MobileTaskClientError ? error.code : "TASK_RESULT_UNAVAILABLE" };
  }
  let prepared: PreparedNativeFile[] = [];
  try {
    prepared = [];
    for (const file of result.files ?? []) {
      const bytes = await client.downloadArtifact(input.taskId, datasetId, file);
      const preparedFile = await files.prepare(actor, {
        id: file.fileId,
        type: file.mime,
        size: file.bytes,
        blob: new Blob([Uint8Array.from(bytes)], { type: file.mime })
      });
      prepared.push(preparedFile);
    }
    // F2：结果 manifest 与已准备原件映射为消息附件（完整 fileRef），与媒体行/收据同一事务提交。
    const initialMessage = message(result, input.taskId);
    const baseMessage = { ...initialMessage, ...(result.tools ? { tools: result.tools } : {}), ...(result.blocks ? { blocks: result.blocks, eventSequence: Math.max(0, ...result.blocks.map(block => "endSequence" in block ? block.endSequence : block.sequence)) } : {}), ...(result.calls ? { calls: [...new Map([...(initialMessage.calls ?? []), ...result.calls].map(call => [call.callId, call])).values()] } : {}) };
    const manifestName = new Map((result.files ?? []).map(file => [file.fileId, file.name]));
    const deliveredMessage: WorkbenchMessage = prepared.length
      ? {
          ...baseMessage,
          attachments: prepared.map(file => ({
            id: file.mediaId,
            name: manifestName.get(file.mediaId) ?? `${file.mediaId}.${file.type.split("/")[1] ?? "bin"}`,
            fileRef: { serverId: actor.serverId, userId: actor.userId, datasetId: actor.datasetId,
              mediaId: file.mediaId, sha256: file.sha256, size: file.size, type: file.type }
          }))
        }
      : baseMessage;
    // 恢复领取没有实时观察器：由结果中的真实调用与产物建立最小公开时间线。
    if (!deliveredMessage.blocks) {
      const blocks: WorkbenchMessageBlock[] = (result.calls ?? []).map((call, index) => ({
        id: `task-call-${index}`, sequence: index + 1, type: "call", callId: call.callId
      }));
      if (deliveredMessage.attachments?.length) blocks.push({
        id: "task-images", sequence: blocks.length + 1, type: "images", attachmentIds: deliveredMessage.attachments.map(file => file.id)
      });
      if (deliveredMessage.text) blocks.push({
        id: "task-text", sequence: blocks.length + 1, endSequence: blocks.length + 1, type: "text", text: deliveredMessage.text
      });
      deliveredMessage.blocks = blocks;
      deliveredMessage.eventSequence = blocks.length;
    }
    const delivery: NativeTaskDelivery = {
      chatSessionId: input.chatSessionId,
      messages: [completeMessageTimeline(deliveredMessage)],
      proposals: []
    };
    const outcome = await repositories.applyTaskResult(actor, input.taskId, resultDigest, prepared, delivery);
    prepared = [];
    if (outcome.status === "committed" || outcome.status === "replayed") {
      // SQL 提交成功（或同键重放）后才补 ACK；重放不产生第二次效果。
      await repositories.markTaskAcknowledged(input.taskId, resultDigest);
      try {
        await client.acknowledge(input.taskId, datasetId, resultDigest);
      } catch (error) {
        // 本地收据已记账：服务端 ACK 可在重开后按原收据只补 ACK（T6a 恢复路径）。
        return { status: "failed", code: error instanceof MobileTaskClientError ? error.code : "TASK_ACK_UNREACHABLE" };
      }
      return { status: outcome.status, receipt: outcome.receipt, message: deliveredMessage };
    }
    return { status: outcome.status };
  } catch (error) {
    files.releasePrepared(prepared);
    return { status: "failed", code: error instanceof MobileTaskClientError ? error.code : error instanceof Error ? error.message : "TASK_DELIVERY_FAILED" };
  }
}

export { agentTaskDigest };

export type NativeTaskWorkbenchPorts = {
  files: NativeFiles;
  repositories: NativeTaskDeliveryPorts["repositories"];
  actor: NativeActor;
  datasetId: string;
  client: MobileTaskClient;
  digest(value: Uint8Array | string): Promise<string>;
  randomId(): Promise<string>;
  /** 复用工作台范围裁决；仅包含本轮所选笔记/笔记本的文本，不含照片原件。 */
  scopeDocuments?(request: Parameters<WorkbenchAdapter["send"]>[0]): readonly { id: string; title: string; text: string }[];
  /** 当前冻结配置（configId + 服务端 settings revision）；未就绪返回 null 让发送明确失败。 */
  configRef(): { configId: string; revision: string } | null;
  /** 会话读取（交付后回读权威 revision 用）。 */
  sessionApi: { read(id: string): Promise<{ id: string; revision: number; payload: { messages: WorkbenchMessage[] } }> };
  /**
   * R2：交付同步——权威交付消息（含完整 fileRef 附件）+ 会话 revision 一并交给
   * 调用方写入当前投影；避免"ACK 后页面只有文字、附件丢失"。
   */
  onDelivered(sessionId: string, revision: number, message: WorkbenchMessage): void;
  /** fileRef 附件原字节（按需读取；native-workbench-store.attachmentBlob）。 */
  attachmentBlobOf(attachment: { fileRef?: unknown }): Promise<Blob | undefined>;
  /** F3：看图理解副本（复用 prepareVisionImages 规则；与附件同序，逐项含上传字节）。 */
  prepareUnderstandingCopies(attachments: readonly { fileRef?: unknown }[]): Promise<{ sha256: string; mime: string; bytes: number; upload: Uint8Array }[]>;
  /** 当前冻结图像配置（显式制图/修图意图用）；未就绪返回 null。 */
  imageConfigRef?(): { configId: string; revision: string } | null;
  /** T9：本机 Skill 受控快照（snapshotForTask；选中且启用）。 */
  skillSnapshots?(selection: readonly { id: string; name: string }[]): Promise<Array<{ id: string; name: string; windows: { path: string; text: string }[] }>>;
};

/**
 * 工作台任务适配器：send/stream 走服务端任务宿主（多步 Agent 在服务端运行），
 * 写笔记/检索等其余能力沿用桌面适配器实现。事件原样转发宿主产生的
 * WorkbenchStreamEvent；交付经 applyTaskResult 单事务后只补 ACK。
 */
/**
 * 重开恢复：本地收据已 ACK（ackedAt 记账）但服务端 ACK 可能因退出而未到达。
 * 对每条收据补发服务端 ACK；结果已过期/清理（404/410）时跳过（服务端终态保留）。
 * alreadyAcked 幂等，重复补发无第二次效果（§9.1 SQL 成功 ACK 前退出的恢复路径）。
 */
export async function recoverPendingAcknowledgments(ports: Pick<NativeTaskDeliveryPorts, "client" | "repositories" | "actor" | "datasetId">): Promise<{ confirmed: number; skipped: number }> {
  const receipts = await ports.repositories.listTaskReceipts();
  let confirmed = 0;
  let skipped = 0;
  for (const receipt of receipts) {
    if (!receipt.ackedAt) continue;
    try {
      const fetched = await ports.client.getResult(receipt.taskId, ports.datasetId);
      if (fetched.digest.toLowerCase() !== receipt.digest.toLowerCase()) { skipped += 1; continue; }
      await ports.client.acknowledge(receipt.taskId, ports.datasetId, receipt.digest);
      confirmed += 1;
    } catch (error) {
      // 结果已不在（stub 清理/TTL）＝服务端已终态；其余错误按跳过记录，不影响其余收据。
      skipped += 1;
      void error;
    }
  }
  return { confirmed, skipped };
}

/**
 * 重开恢复领取：客户端在交付前退出时，awaiting_ack 的结果留在服务端（原归属不变）。
 * 重开后按任务列表逐个领取：本地已有收据的跳过（由 recoverPendingAcknowledgments 补
 * 服务端 ACK）；交付消息优先复用该会话发起时的 pending 占位 id，否则新造结果 id。
 */
export async function recoverUnclaimedResults(ports: Omit<NativeTaskDeliveryPorts, "message"> & {
  findPendingAssistantMessageId?(chatSessionId: string): Promise<string | null>;
}): Promise<{ recovered: number; failed: number }> {
  const tasks = await ports.client.listTasks(ports.datasetId);
  let recovered = 0;
  let failed = 0;
  for (const task of tasks) {
    if (task.status !== "awaiting_ack") continue;
    const receipt = await ports.repositories.readTaskReceipt(task.id).catch((error) => {
      console.error("[t6a-recover] 收据读取失败", error instanceof Error ? error.message : error);
      return null;
    });
    if (receipt) continue;
    const pendingId = (await ports.findPendingAssistantMessageId?.(task.chatSessionId)) ?? null;
    const outcome = await deliverTaskToNative(
      { ...ports, message: result => ({
          id: pendingId ?? `task-result-${task.id.slice(0, 18)}`,
          role: "assistant",
          text: typeof result.text === "string" ? result.text : "",
          createdAt: new Date().toISOString(),
          status: "done"
        }) },
      { taskId: task.id, chatSessionId: task.chatSessionId }
    );
    if (outcome.status === "committed" || outcome.status === "replayed") recovered += 1;
    else failed += 1;
  }
  return { recovered, failed };
}

/**
 * B6/G6：任务材料 refId 只允许 [A-Za-z0-9_-]，而合法 Skill ID 含 `.`（isSkillId：
 * /^[a-z0-9][a-z0-9._-]{0,63}$/，如 city.guide）。编码稳定且无碰撞：
 * `_`→`__`、`.`→`_-`，其余原样（可逆、不同 ID 编码必不同）。
 * G6 长度受控：转义后 ≤121 用 `sk-` 前缀短形式；更长（最长合法 ID 全转义翻倍）
 * 用 `sk_` + 内容摘要——两种形式第三字符不同且长度不相交，互不碰撞。
 */
export async function skillMaterialRefId(
  id: string,
  digest: (value: string | Uint8Array) => Promise<string>
): Promise<string> {
  const escaped = id.replace(/[_.]/g, (char) => (char === "_" ? "__" : "_-"));
  return escaped.length <= 121 ? `sk-${escaped}` : `sk_${await digest(id)}`;
}

/** B6：快照收集所依赖的本机 Skill 出口（native.skills 的结构子集，测试可注入替身）。 */
export type SkillSnapshotSource = {
  catalog(): Promise<Array<{ id: string; enabled: boolean; readable: boolean; digest?: string }>>;
  settings(): Promise<{ skills: Array<{ id: string; fileDigests?: Record<string, string> }> }>;
  snapshotForTask(selection: ReadonlyArray<{ id: string; digest: string; windows: Array<{ path: string; offset: number; limit: number; digest: string }> }>): Promise<Array<{ id: string; name: string; digest: string; windows: Array<{ path: string; offset: number; digest: string; text: string; nextOffset?: number }> }>>;
};

const SKILL_SNAPSHOT_WINDOW = 3200;
/** 与 store 侧单次 2MiB 上限一致；这里覆盖整个快照范围（含续读跨次调用累计）。 */
const SKILL_SNAPSHOT_BUDGET_BYTES = 2 * 1024 * 1024;

/**
 * B6：任务 Skill 快照收集——每个文件（SKILL.md 与 references/*.md，来自
 * settings.fileDigests）声明首窗后**循环续读直至 EOF**（旧实现只追加一窗，
 * 超 6400 字符被截断）；整个快照范围统一累计字节预算，超限明确失败不发
 * 半截材料。停用/不可读经 catalog 门禁拒绝，内容变化由 store 摘要复核抛错。
 */
export async function collectSkillSnapshots(
  store: SkillSnapshotSource,
  selection: readonly { id: string; name: string }[],
  limits?: { windowChars?: number; budgetBytes?: number }
): Promise<Array<{ id: string; name: string; windows: Array<{ path: string; text: string }> }>> {
  const windowChars = limits?.windowChars ?? SKILL_SNAPSHOT_WINDOW;
  const budgetBytes = limits?.budgetBytes ?? SKILL_SNAPSHOT_BUDGET_BYTES;
  const encoder = new TextEncoder();
  const catalog = await store.catalog();
  const view = await store.settings();
  const filesById = new Map(view.skills.map(skill => [skill.id, skill.fileDigests ?? {}] as const));
  const declared = selection.map(item => {
    const entry = catalog.find(candidate => candidate.id === item.id && candidate.enabled && candidate.readable);
    if (!entry?.digest) throw new Error(`Skill 不可用或未启用：${item.name}`);
    const files = filesById.get(item.id) ?? {};
    // G6：快照只声明 Agent 允许读取的文件（SKILL.md 与 references/*.md）。
    // LICENSE/PROVENANCE 等继续保存在安装包，但读取白名单不包含它们——
    // 声明它们会让 read 拒绝并拖垮整个 Skill 的发送。
    const windows = Object.entries(files)
      .filter(([path]) => isAllowedSkillPath(path))
      .map(([path, digest]) => ({ path, offset: 0, limit: windowChars, digest }));
    if (!windows.length) throw new Error(`Skill 没有可读取的文件：${item.name}`);
    return { id: entry.id, digest: entry.digest, windows };
  });
  const snapshots = await store.snapshotForTask(declared);
  let used = snapshots.reduce((sum, snapshot) =>
    sum + snapshot.windows.reduce((inner, item) => inner + encoder.encode(item.text).length, 0), 0);
  if (used > budgetBytes) throw new Error("TASK_SKILL_BUDGET_EXCEEDED：所选 Skill 授权内容超出快照预算，本次未发送。");
  for (const snapshot of snapshots) {
    const initialCount = snapshot.windows.length;
    const ordered = [] as typeof snapshot.windows;
    for (let index = 0; index < initialCount; index++) {
      const chain = [snapshot.windows[index]];
      let current: typeof snapshot.windows[number] | undefined = snapshot.windows[index];
      while (current?.nextOffset !== undefined) {
        const [more] = await store.snapshotForTask([{ id: snapshot.id, digest: snapshot.digest, windows: [{ path: current.path, offset: current.nextOffset, limit: windowChars, digest: current.digest }] }]);
        const next = more?.windows[0];
        if (!next) break;
        used += encoder.encode(next.text).length;
        if (used > budgetBytes) throw new Error("TASK_SKILL_BUDGET_EXCEEDED：所选 Skill 授权内容超出快照预算，本次未发送。");
        chain.push(next);
        current = next;
      }
      ordered.push(...chain);
    }
    snapshot.windows = ordered;
  }
  return snapshots.map(snapshot => ({ id: snapshot.id, name: snapshot.name, windows: snapshot.windows.map(item => ({ path: item.path, text: item.text })) }));
}

export function createNativeTaskWorkbenchAdapter(desktop: WorkbenchAdapter, ports: NativeTaskWorkbenchPorts): WorkbenchAdapter {
  const datasetId = ports.datasetId;
  const materialize = async (input: { text: string; references: readonly { id: string; text: string }[]; memory?: MemoryState; skills?: readonly { id: string; name: string }[] }) => {
    const materials: { refId: string; kind: "text"; sha256: string; bytes: number; text: string }[] = [];
    const seen = new Set<string>();
    const push = async (refId: string, text: string) => {
      if (!refId || seen.has(refId) || !text.trim()) return;
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(refId)) throw new Error(`授权材料标识不合法：${refId.slice(0, 40)}`);
      seen.add(refId);
      materials.push({ refId, kind: "text", sha256: await ports.digest(text), bytes: new TextEncoder().encode(text).length, text });
    };
    for (const reference of input.references) await push(reference.id, reference.text);
    if (input.memory?.enabled) {
      for (const entry of input.memory.entries) if (entry.allowModelUse) await push(entry.id, entry.text);
    }
    // T9：选中且启用的 Skill 以本地受控快照进入任务授权材料（不读桌面文件）。
    if (input.skills?.length) {
      if (!ports.skillSnapshots) throw new Error("TASK_SKILL_UNAVAILABLE：本机 Skill 快照不可用，本次未发送。");
      const snapshots = await ports.skillSnapshots(input.skills);
      for (const snapshot of snapshots) {
        const text = `Skill《${snapshot.name}》授权内容：\n${snapshot.windows.map(window => `【${window.path}】\n${window.text}`).join("\n\n")}`;
        await push(await skillMaterialRefId(snapshot.id, ports.digest), text);
      }
    }
    return materials;
  };

  const runTurn = async (
    input: Parameters<WorkbenchAdapter["send"]>[0],
    onEvent?: (event: WorkbenchStreamEvent) => void
  ): Promise<WorkbenchTurnResult> => {
    const ref = ports.configRef();
    if (!ref) throw new Error("TASK_CONFIG_REQUIRED：请先选择可用对话模型再发送。");
    if (!input.sessionId) throw new Error("TASK_SESSION_REQUIRED：会话尚未保存，无法发起任务。");
    if (!input.assistantMessageId) throw new Error("TASK_MESSAGE_ID_REQUIRED：缺少本轮回答消息身份。");
    const scopeDocs = input.scope.kind === "free" ? [] : ports.scopeDocuments?.(input);
    if (!scopeDocs) throw new Error("TASK_SCOPE_UNAVAILABLE：当前参考笔记无法读取，本次未发送。");
    const materials = await materialize({ text: input.text, references: [
      ...scopeDocs.map(doc => ({ id: doc.id, text: `笔记标题：${doc.title}\n${doc.text}` })),
      ...input.references
    ], memory: input.memory, ...(input.skillReferences?.length ? { skills: input.skillReferences } : {}) });
    // fileRef 附件作为授权图片材料（原字节清单；字节经补料端点上传，不进创建正文）。
    const imageMaterials: { refId: string; sha256: string; bytes: number; mime: string; upload: Uint8Array }[] = [];
    const wantsImageIntent = input.intent === "image-generate" || input.intent === "image-edit";
    // F3：看图理解不走原件——按既有视觉规则生成理解副本（≤1024px、去元数据 JPEG、
    // 单张/累计预算）作为任务材料上传；原件与 fileRef 保持不变。修图/生成仍用原件。
    const understandingCopies = !wantsImageIntent && input.attachments.length
      ? await ports.prepareUnderstandingCopies(input.attachments) : [];
    for (let index = 0; index < input.attachments.length; index++) {
      const attachment = input.attachments[index]!;
      if (!attachment.fileRef) throw new Error("native 模式附件必须是原生原件（fileRef）；请重新选择图片。");
      if (!wantsImageIntent) {
        const copy = understandingCopies[index];
        if (!copy) throw new Error(`理解副本生成失败：${attachment.name}；本次未外发。`);
        imageMaterials.push({ refId: `vision-${attachment.fileRef.mediaId}`, sha256: copy.sha256, bytes: copy.bytes, mime: copy.mime, upload: copy.upload });
        continue;
      }
      const blob = await ports.attachmentBlobOf(attachment);
      if (!blob) throw new Error(`附件原件不可读：${attachment.name}`);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      imageMaterials.push({
        refId: attachment.fileRef.mediaId,
        sha256: attachment.fileRef.sha256,
        bytes: attachment.fileRef.size,
        mime: attachment.fileRef.type,
        upload: bytes
      });
    }
    const createInput: AgentTaskCreateInput = {
      version: 1,
      chatSessionId: input.sessionId,
      clientRequestId: await ports.randomId(),
      kind: "workbench",
      config: { text: ref, ...(ports.imageConfigRef?.() ? { image: ports.imageConfigRef!()! } : {}) },
      manifest: {
        resources: [
          ...materials.map(({ refId, kind, sha256, bytes }) => ({ refId, kind, sha256, bytes })),
          ...imageMaterials.map(({ refId, sha256, bytes, mime }) => ({ refId, kind: "image" as const, sha256, bytes, mime }))
        ]
      },
      snapshot: { text: input.text, resources: materials.map(({ refId, text }) => ({ refId, text })) },
      ...(wantsImageIntent ? {
        // 意图与执行参数对应：generate 把全部附图材料作为参考图 sourceRefs 下发
        // （宿主消费为 generate 参考图原件，不再静默丢图；无附图即纯文字生成）。
        // edit 恰好一张原件；非一张保持 edit 意图由宿主按协议拒绝，不静默改写成生成。
        payload: {
          intent: input.intent === "image-edit" ? "image-edit" : "image-generate",
          prompt: input.intent === "image-generate" ? composeImageInstruction(input.text, input.imageOptions) ?? input.text : input.text,
          ...(input.imageOptions?.size ? { size: input.imageOptions.size } : {}),
          ...(input.imageOptions?.outputFormat ? { outputFormat: input.imageOptions.outputFormat } : {}),
          ...(input.intent === "image-edit"
            ? (imageMaterials.length === 1 ? { sourceRefs: [imageMaterials[0]!.refId] } : {})
            : (imageMaterials.length ? { sourceRefs: imageMaterials.map(material => material.refId) } : {}))
        }
      } : {})
    };
    const { task } = await ports.client.createTask(createInput, datasetId);
    const cancelRemote = () => { void ports.client.cancelTask(task.id, datasetId).catch(() => undefined); };
    input.signal.addEventListener("abort", cancelRemote, { once: true });
    try {
      if (input.signal.aborted) { cancelRemote(); throw new DOMException("已取消", "AbortError"); }
      // 缺料补齐：waiting_material → multipart 原字节上传 → queued（宿主继续）。
      for (const material of imageMaterials) {
        if (!task.missingRefs.includes(material.refId)) continue;
        await ports.client.uploadMaterial(task.id, datasetId, material.refId, material.upload, material.mime);
      }
      let failureCode: string | undefined;
      const end = await ports.client.observe(task.id, datasetId, event => {
        if (event.type === "failed" && isRecord(event.data) && typeof event.data.errorCode === "string") failureCode ??= event.data.errorCode;
        if (event.type === "stream" && isRecord(event.data) && event.data.type === "error" && typeof event.data.message === "string") failureCode = event.data.message;
        if (event.type === "stream" && onEvent) onEvent({ ...event.data, sequence: event.sequence } as WorkbenchStreamEvent);
      }, input.signal);
      if (input.signal.aborted) throw new DOMException("已取消", "AbortError");
      if (end.status !== "awaiting_ack") throw new Error(failureCode === "TASK_CONFIG_CHANGED"
        ? "模型配置已变化（TASK_CONFIG_CHANGED），请刷新模型后重试。"
        : `任务没有完成（${failureCode ?? end.status}），未自动重发。`);
      const assistantId = input.assistantMessageId;
      // F4/R4 交付屏障：冻结新检查点并等待在途保存收拢。屏障本身抛错（取消/切号）也
      // 必须解冻——包 finally；后续交付段已有自己的 finally。
      try {
        await input.onBeforeDeliver?.();
      } catch (error) {
        input.onAfterDeliver?.();
        throw error;
      }
      const checkpoint = await ports.sessionApi.read(input.sessionId);
      const observedMessage = checkpoint.payload.messages.find(message => message.id === assistantId);
      let deliveredMessage: WorkbenchMessage | undefined;
      const outcome = await deliverTaskToNative(
        {
          files: ports.files,
          repositories: ports.repositories,
          actor: ports.actor,
          datasetId: ports.datasetId,
          client: ports.client,
          digest: ports.digest,
          message: result => {
            const message: WorkbenchMessage = {
              ...observedMessage,
              id: assistantId,
              role: "assistant",
              text: typeof result.text === "string" ? result.text : "",
              createdAt: new Date().toISOString(),
              status: "done"
            };
            deliveredMessage = message;
            return message;
          }
        },
        { taskId: task.id, chatSessionId: input.sessionId }
      );
      // R4：屏障释放保证在任何路径（成功/失败/取消/异常/切号拒绝）都执行——
      // 冻结泄漏会让后续所有检查点停摆。交付拒绝在此转为明确错误抛出（finally 解冻）。
      try {
        if (outcome.status === "digest-conflict") throw new Error("任务结果摘要与服务端不符，未确认接收。");
        if (outcome.status === "stale-dataset") throw new Error("任务结果不属于当前账号资料（迟到结果已丢弃），未确认。");
        if (outcome.status === "failed") throw new Error(`任务交付失败（${outcome.code}）；重开后按收据恢复，不自动重发。`);
        // 交付把 delivered 计入 summary revision：回读权威值并同步，下一次保存不再冲突；
        // 同步完成后恢复检查点（顺序：同步 → 恢复，避免恢复后立即用旧 revision 保存）。
        const authoritative = outcome.status === "committed" || outcome.status === "replayed" ? outcome.message : deliveredMessage;
        try {
          const record = await ports.sessionApi.read(input.sessionId);
          ports.onDelivered(input.sessionId, record.revision, authoritative ?? { id: assistantId, role: "assistant", text: "", createdAt: new Date().toISOString(), status: "done" });
        } catch {
          // 回读失败只影响下一次保存的便利性，不改变交付结果。
        }
        return { id: assistantId, kind: "text", title: "回答", body: authoritative?.text ?? "", demo: false };
      } finally {
        input.onAfterDeliver?.();
      }
    } finally {
      input.signal.removeEventListener("abort", cancelRemote);
    }
  };

  return {
    ...desktop,
    async stream(input, onEvent) {
      return runTurn(input, onEvent);
    },
    async send(input) {
      return runTurn(input);
    }
  };
}
