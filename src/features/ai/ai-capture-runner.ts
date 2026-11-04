/**
 * P3-02：organize_captures 有限步骤任务执行。
 *
 * 步骤固定且有限：校验冻结来源 → 输入预算检查 → 请求 Gateway → 严格解析 →
 * 投影为既有 JournalDraft → 冻结 Proposal → 原子保存 waiting_user Task 与 Proposal。
 *
 * 边界：
 * - 零 Notebook/Capture 业务写入：本文件不导入任何 Repository/写入接口；
 *   operationId = proposal.id 是后续提交约定，收据由提交阶段产生；
 * - 不建 Agent Runtime、不自动重试；
 * - 冻结：进入本函数即对来源、媒体映射与目标做深拷贝——调用方在异步过程中
 *   修改传入数组、来源或目标不影响当前任务与 Proposal；
 * - 跳过的来源连图片一并跳过：不进入草稿、不进入 includedMessageIds；
 * - 空 sections 表示没有可加入内容：任务完成但不生成空建议；
 *   输出与来源文字相同不等于"无需建议"（新增/追加本身是业务动作），不做该判断。
 *
 * 取消与竞争（P3-02 复审 R1/R2）：
 * - 请求前、响应后、落库前都同时核对 AbortSignal 与持久化任务状态/revision；
 *   信号已取消时不发送新请求；Gateway 忽略取消并迟到返回成功也不能生成有效建议；
 * - 不接管其他终态或其他 revision（以库中实际状态为准，明确报告竞争）；
 * - 原子落库成功后的取消不回滚已提交结果（返回已持久化的 waiting_user 事实）；
 * - 终态落库失败不返回虚构终态：回读实际持久状态；回读也失败明确报告
 *   "持久化状态未知"；区分存储失败与 CAS 竞争。
 */
import {
  sourceSnapshotDigest,
  type AppendSourceSnapshot,
  type JournalDraft,
  type JournalDraftEntry
} from "../notebook/append-service";
import { fingerprintParts, MAX_PAGE_TEXT_LENGTH } from "../notebook/notebook-model";
import {
  isFrozenCaptureSource,
  previewProposal,
  validateProposalPayload,
  type AiProposal,
  type AiSourceRef
} from "./ai-proposal";
import { transitionAiTask, type AiTask } from "./ai-task";
import { StaleAiWriteError, type AiRepository } from "./ai-repository";
import { parseCaptureOrganizeResult } from "./ai-capture-result-schema";
import { buildCaptureOrganizeInput } from "./prompts/capture-organize";
import type { AiGatewayCaller } from "./ai-gateway-client";

/** 与 P2 同一口径的字符预算（TASK_BUDGETS；服务端另有 60k 字符与 96KB 请求体边界）。 */
const MAX_INPUT_CHARS = 20_000;
const MAX_OUTPUT_CHARS = 8_000;

export type CaptureOrganizeDeps = {
  ai: AiRepository;
  /** 最小 Gateway 请求函数（浏览器边界）；测试可注入受控实现。 */
  callGateway: AiGatewayCaller;
  /** 本任务使用的模型配置 ID：必须由调用方显式给出。 */
  selectConfig: () => string;
  /**
   * 冻结的选中来源快照（调用方在生成前由 Capture 数据构建；顺序即输入顺序）。
   * 进入本函数即被深拷贝冻结。
   */
  sources: AppendSourceSnapshot[];
  /** 冻结的来源媒体身份映射（messageId+sourceMediaId → 手帐 assetId）。 */
  mediaLink: { messageId: string; sourceMediaId: string; assetId: string }[];
  now?: () => Date;
  /** 生成 ID；缺省用进程内单调计数器（避免并发任务 ID 碰撞）。 */
  createId?: () => string;
  /** 任务级预算覆盖（缺省与 P2 同值）。预算按 JS 字符数计（与 P2 口径一致；UTF-8 字节不在本层单列）。 */
  budgets?: { maxInputChars?: number; maxOutputChars?: number };
  /** 取消信号：向 Gateway 请求传播。 */
  signal?: AbortSignal;
};

export type CaptureOrganizeOutcome =
  | {
      status: "waiting_user";
      task: AiTask;
      proposal: AiProposal;
      gateway: { model: string; configId: string };
    }
  | { status: "completed"; task: AiTask; reason: "no-content" }
  | { status: "failed"; task: AiTask; detail: string; code: string }
  | { status: "cancelled"; task: AiTask }
  | { status: "not-run"; task: AiTask; reason: "invalid-transition" | "stale-revision" };

/** 全部冻结来源的聚合摘要：逐条 sourceSnapshotDigest 的稳定指纹（顺序敏感）。
 *  对非法元素不抛错（R3）：无效条目以类型标记参与指纹——非法来源会在
 *  validateFrozenSources 边界被拒绝，摘要比较只对合法来源有意义。 */
export function captureSourcesDigest(sources: readonly AppendSourceSnapshot[]): string {
  return fingerprintParts(
    sources.map((source) => {
      if (!source || typeof source !== "object" || typeof source.messageId !== "string") {
        return `invalid:${String((source as { messageId?: unknown } | null)?.messageId ?? typeof source)}`;
      }
      return sourceSnapshotDigest(source);
    })
  );
}

/**
 * 投影：每个输出来源一个 message entry（其图片按原确定性顺序随后附加）；
 * 跳过的来源连图片一并跳过。返回草稿与实际纳入的来源 ID（顺序一致）。
 */
export function draftFromCaptureSections(
  sources: readonly AppendSourceSnapshot[],
  sections: readonly { sourceIndex: number; content: string }[]
): { draft: JournalDraft; includedMessageIds: string[] } {
  const entries: JournalDraftEntry[] = [];
  const includedMessageIds: string[] = [];
  for (const section of sections) {
    const source = sources[section.sourceIndex];
    if (!source) continue; // 越界索引在解析阶段已被拒绝；此处不静默兜底可忽略。
    entries.push({
      kind: "message",
      messageId: source.messageId,
      blocks: [{ type: "text", text: section.content }]
    });
    for (const item of source.media) {
      // 图注沿用既有确定性来源信息（来源媒体名），AI 不生成图注。
      entries.push({ kind: "photo", assetId: item.assetId, caption: item.name });
    }
    includedMessageIds.push(source.messageId);
  }
  return { draft: { entries }, includedMessageIds };
}

// —— 冻结输入边界校验（R3：unknown 先验证结构再访问字段；请求前拒绝） ——

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** 来源形状与唯一性校验（null/错误类型/缺失来源都明确失败，不崩溃）。 */
function validateFrozenSources(sources: unknown): { code: string; detail: string } | undefined {
  if (!Array.isArray(sources) || sources.length === 0) {
    return { code: "AI_SOURCE_INVALID", detail: "本次没有选中的来源记录。" };
  }
  const seen = new Set<string>();
  for (const entry of sources) {
    if (!entry || typeof entry !== "object") {
      return { code: "AI_SOURCE_INVALID", detail: "来源记录不是合法对象。" };
    }
    const source = entry as Partial<AppendSourceSnapshot>;
    if (!isNonEmptyString(source.messageId)) {
      return { code: "AI_SOURCE_INVALID", detail: "来源记录缺少稳定 ID。" };
    }
    if (seen.has(source.messageId)) {
      return { code: "AI_SOURCE_DUPLICATE", detail: `来源记录重复：${source.messageId}。` };
    }
    seen.add(source.messageId);
    if (source.messageFound === false) {
      return {
        code: "AI_SOURCE_MISSING",
        detail: `来源记录 ${source.messageId} 无法读取，未生成建议（不按空文本继续）。`
      };
    }
    if (typeof source.text !== "string" || source.text.length > MAX_PAGE_TEXT_LENGTH) {
      return { code: "AI_SOURCE_INVALID", detail: `来源记录 ${source.messageId} 的文本不合法。` };
    }
    if (!isNonEmptyString(source.capturedAt)) {
      return { code: "AI_SOURCE_INVALID", detail: `来源记录 ${source.messageId} 缺少时间。` };
    }
    if (!isFrozenCaptureSource(source)) {
      return {
        code: "AI_SOURCE_INVALID",
        detail: `来源记录 ${source.messageId} 的快照或媒体字段不合法。`
      };
    }
  }
  return undefined;
}

/**
 * 媒体映射与来源媒体的完整对应（R4）：不只检查映射键存在——
 * 每个来源媒体的 assetId 必须与映射完全一致，映射不得包含来源之外的条目，
 * 同一 assetId 不得被多个来源使用；非法元素在访问字段前先拒绝。
 */
function validateMediaLink(
  sources: readonly AppendSourceSnapshot[],
  mediaLink: readonly unknown[]
): { code: string; detail: string } | undefined {
  if (!Array.isArray(mediaLink)) {
    return { code: "AI_INPUT_INVALID", detail: "媒体映射不是数组。" };
  }
  const byKey = new Map<string, string>();
  for (const entry of mediaLink) {
    if (!entry || typeof entry !== "object") {
      return { code: "AI_INPUT_INVALID", detail: "媒体映射存在非法元素。" };
    }
    const link = entry as Partial<{ messageId: string; sourceMediaId: string; assetId: string }>;
    if (
      !isNonEmptyString(link.messageId) ||
      !isNonEmptyString(link.sourceMediaId) ||
      !isNonEmptyString(link.assetId)
    ) {
      return { code: "AI_INPUT_INVALID", detail: "媒体映射元素缺少身份字段。" };
    }
    const key = `${link.messageId} ${link.sourceMediaId}`;
    const existing = byKey.get(key);
    if (existing !== undefined && existing !== link.assetId) {
      return { code: "AI_INPUT_MISMATCH", detail: `媒体映射冲突：${key} 对应多个资产。` };
    }
    byKey.set(key, link.assetId);
  }
  const sourceKeys = new Set<string>();
  const assetOwners = new Map<string, string>();
  for (const source of sources) {
    for (const item of source.media) {
      const key = `${source.messageId} ${item.sourceMediaId}`;
      sourceKeys.add(key);
      if (byKey.get(key) !== item.assetId) {
        return {
          code: "AI_INPUT_MISMATCH",
          detail: `来源媒体 ${key} 与冻结映射不一致（缺失或 assetId 不同）。`
        };
      }
      const owner = assetOwners.get(item.assetId);
      if (owner !== undefined && owner !== source.messageId) {
        return {
          code: "AI_INPUT_MISMATCH",
          detail: `资产 ${item.assetId} 被多个来源使用（${owner} 与 ${source.messageId}）。`
        };
      }
      assetOwners.set(item.assetId, source.messageId);
    }
  }
  for (const key of byKey.keys()) {
    if (!sourceKeys.has(key)) {
      return { code: "AI_INPUT_MISMATCH", detail: `媒体映射包含来源之外的条目：${key}。` };
    }
  }
  return undefined;
}

let idSequence = 0;
function defaultIdFactory(prefix: string, now: () => Date): () => string {
  return () => {
    idSequence += 1;
    const random = Math.random().toString(36).slice(2, 8);
    return `${prefix}-${now().getTime().toString(36)}-${idSequence.toString(36)}-${random}`;
  };
}

/** 供测试重置单调序号，避免跨用例互相影响。 */
export function resetCaptureIdSequence(): void {
  idSequence = 0;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// —— 持久化状态回读与终态收敛（R2：失败可见、区分 CAS 竞争与存储失败） ——

type StoredRead =
  { kind: "found"; task: AiTask } | { kind: "missing" } | { kind: "unavailable"; error: unknown };

/** 回读实际持久状态：missing（已清空）与读取失败（状态未知）分开表达。 */
async function readStoredTask(ai: AiRepository, id: string): Promise<StoredRead> {
  try {
    const stored = await ai.getTask(id);
    return stored ? { kind: "found", task: stored } : { kind: "missing" };
  } catch (error) {
    return { kind: "unavailable", error };
  }
}

/**
 * 终态收敛：本地迁移 → CAS 落库；失败时回读实际状态——
 * 库中已是该终态（含他人写入）→ 如实返回该终态；
 * 库中是其他状态 → 返回 failed（不覆盖他人进展，CAS 保证）；
 * 回读也失败 → 返回 failed 并明确"持久化状态未知"。
 */
async function convergeTerminal(
  deps: CaptureOrganizeDeps,
  task: AiTask,
  to: "completed" | "cancelled" | "failed",
  patch: { error?: { code: string; message: string }; step?: number },
  now: () => Date,
  semantic: { code: string; detail: string }
): Promise<CaptureOrganizeOutcome> {
  const transitioned = transitionAiTask(task, to, patch, now, task.revision);
  if (!transitioned.ok) {
    // 本地迁移被拒（终态不可离开/revision 不匹配）：以库中实际状态为准。
    const stored = await readStoredTask(deps.ai, task.id);
    if (stored.kind === "found") {
      if (to === "cancelled" && stored.task.status === "cancelled") {
        return { status: "cancelled", task: stored.task };
      }
      if (to === "failed") {
        return {
          status: "failed",
          task: stored.task,
          detail: semantic.detail,
          code: semantic.code
        };
      }
      return {
        status: "failed",
        task: stored.task,
        detail: `${semantic.detail}（任务当前状态：${stored.task.status}。）`,
        code: "AI_TASK_RACE"
      };
    }
    return {
      status: "failed",
      task,
      detail: `${semantic.detail}（任务状态迁移被拒绝且无法回读实际状态：持久化状态未知。）`,
      code: "AI_TASK_RACE"
    };
  }
  try {
    await deps.ai.saveTask(transitioned.task, { expectedRevision: task.revision });
    return to === "cancelled"
      ? { status: "cancelled", task: transitioned.task }
      : to === "completed"
        ? { status: "completed", task: transitioned.task, reason: "no-content" }
        : {
            status: "failed",
            task: transitioned.task,
            detail: semantic.detail,
            code: semantic.code
          };
  } catch (saveError) {
    const stored = await readStoredTask(deps.ai, task.id);
    const competition = saveError instanceof StaleAiWriteError;
    const reason = competition
      ? "任务状态已被其他实例推进（CAS 竞争）"
      : `终态写入失败（${describe(saveError)}）`;
    if (stored.kind === "found") {
      if (to === "cancelled" && stored.task.status === "cancelled") {
        return { status: "cancelled", task: stored.task };
      }
      if (to === "completed" && stored.task.status === "completed") {
        return { status: "completed", task: stored.task, reason: "no-content" };
      }
      return {
        status: "failed",
        task: stored.task,
        detail: `${semantic.detail}（${reason}；当前持久状态：${stored.task.status}。）`,
        code: competition ? "AI_TASK_RACE" : "AI_PERSIST_FAILED"
      };
    }
    if (stored.kind === "missing") {
      // 记录已被清空：终态未持久化，如实报告失败与已知信息。
      return {
        status: "failed",
        task,
        detail: `${semantic.detail}（${reason}；任务记录已不存在。）`,
        code: competition ? "AI_TASK_RACE" : "AI_PERSIST_FAILED"
      };
    }
    return {
      status: "failed",
      task,
      detail: `${semantic.detail}（${reason}；任务状态回读失败：持久化状态未知。）`,
      code: "AI_PERSIST_FAILED"
    };
  }
}

async function cancelTask(
  deps: CaptureOrganizeDeps,
  task: AiTask,
  now: () => Date
): Promise<CaptureOrganizeOutcome> {
  return convergeTerminal(deps, task, "cancelled", {}, now, {
    code: "AI_CANCEL_FAILED",
    detail: "取消未能落库。"
  });
}

async function fail(
  deps: CaptureOrganizeDeps,
  task: AiTask,
  code: string,
  detail: string,
  now: () => Date
): Promise<CaptureOrganizeOutcome> {
  return convergeTerminal(deps, task, "failed", { error: { code, message: detail } }, now, {
    code,
    detail
  });
}

/**
 * 执行一次 organize_captures。任务必须是 queued 的 organize_captures 任务；
 * running/终态/其他类型不会被本函数接管。
 */
export async function runCaptureOrganizeTask(
  deps: CaptureOrganizeDeps,
  task: AiTask
): Promise<CaptureOrganizeOutcome> {
  const now = deps.now ?? (() => new Date());
  const maxInputChars = deps.budgets?.maxInputChars ?? MAX_INPUT_CHARS;
  const maxOutputChars = deps.budgets?.maxOutputChars ?? MAX_OUTPUT_CHARS;

  if (task.type !== "organize_captures") {
    return { status: "not-run", task, reason: "invalid-transition" };
  }

  // Validate before cloning or accessing nested fields; freeze before the first await.
  let inputIssue = validateFrozenSources(deps.sources);
  let sources: AppendSourceSnapshot[] = [];
  let mediaLink: CaptureOrganizeDeps["mediaLink"] = [];
  let target = task.input.target;
  if (!inputIssue) inputIssue = validateMediaLink(deps.sources, deps.mediaLink);
  if (!inputIssue) {
    try {
      sources = structuredClone(deps.sources);
      mediaLink = structuredClone(deps.mediaLink);
      target = structuredClone(task.input.target);
    } catch {
      inputIssue = { code: "AI_INPUT_INVALID", detail: "输入无法冻结，未发送请求。" };
    }
  }

  // 初始读写错误边界（R2）：先落库 queued/running，后续失败才可能被持久化（P1 同一生命周期）。
  // 存储不可读/不可写时明确失败，不抛出、不停留在 running。
  let storedBeforeStart: Awaited<ReturnType<typeof deps.ai.getTask>>;
  try {
    storedBeforeStart = await deps.ai.getTask(task.id);
  } catch (error) {
    return {
      status: "failed",
      task,
      detail: `任务状态读取失败：${describe(error)}`,
      code: "AI_STORE_UNAVAILABLE"
    };
  }
  if (!storedBeforeStart) {
    try {
      await deps.ai.saveTask(task);
    } catch (error) {
      return {
        status: "failed",
        task,
        detail: `任务初始化写入失败：${describe(error)}`,
        code: "AI_PERSIST_FAILED"
      };
    }
  }

  const running = transitionAiTask(task, "running", { step: 1 }, now, task.revision);
  if (!running.ok) {
    return {
      status: "not-run",
      task: running.current,
      reason: running.reason as "invalid-transition"
    };
  }
  try {
    await deps.ai.saveTask(running.task, { expectedRevision: task.revision });
  } catch (error) {
    const stored = await readStoredTask(deps.ai, task.id);
    const competition = error instanceof StaleAiWriteError;
    if (stored.kind === "found") {
      return {
        status: "failed",
        task: stored.task,
        detail: `任务进入执行状态失败（${competition ? "已被其他实例推进（CAS 竞争）" : describe(error)}；当前持久状态：${stored.task.status}）。`,
        code: competition ? "AI_TASK_RACE" : "AI_PERSIST_FAILED"
      };
    }
    return {
      status: "failed",
      task: running.task,
      detail: `任务进入执行状态失败（${describe(error)}；${stored.kind === "missing" ? "任务记录已不存在" : "状态回读失败：持久化状态未知"}）。`,
      code: competition ? "AI_TASK_RACE" : "AI_PERSIST_FAILED"
    };
  }
  const current = running.task;

  // 输入边界校验（R3/R4）：全部在 Gateway 请求之前完成，null/非法元素明确失败不崩溃。
  // 任务已进入 running：校验失败经 fail() 持久化为 failed 终态。
  if (inputIssue) {
    return await fail(deps, current, inputIssue.code, inputIssue.detail, now);
  }
  const frozenMessageIds = sources.map((source) => source.messageId);
  if (
    task.input.sourceMessageIds.join(" ") !== frozenMessageIds.join(" ") ||
    task.input.sourcesDigest !== captureSourcesDigest(sources)
  ) {
    return await fail(
      deps,
      current,
      "AI_INPUT_MISMATCH",
      "任务输入与冻结来源不一致，请重新创建任务。",
      now
    );
  }

  /**
   * 取消/竞争核对（R1）：信号与持久化状态同时核对——
   * 信号已取消 → cancelled（不发新请求、不生成建议）；
   * 任务被清空 → cancelled；任务已 cancelled → cancelled；
   * 其他终态或 revision 被其他实例推进 → 不接管，明确报告竞争。
   * 信号在原子落库成功之后才发生：结果已提交，不会被假装撤销。
   */
  const cancellationCheck = async (): Promise<CaptureOrganizeOutcome | null> => {
    if (deps.signal?.aborted) {
      // 信号取消：经 cancelTask 收敛——尽力持久化 cancelled 终态，失败时如实报告。
      return await cancelTask(deps, current, now);
    }
    const stored = await readStoredTask(deps.ai, current.id);
    if (deps.signal?.aborted) return await cancelTask(deps, current, now);
    if (stored.kind === "unavailable") {
      // 状态不可读时无法证明安全：停止生成并如实报告（不当作取消）。
      return {
        status: "failed",
        task: current,
        detail: `任务状态读取失败：${describe(stored.error)}；持久化状态未知。`,
        code: "AI_STORE_UNAVAILABLE"
      };
    }
    if (stored.kind === "missing") return { status: "cancelled", task: current };
    if (stored.task.status === "cancelled") return { status: "cancelled", task: stored.task };
    if (stored.task.status !== current.status || stored.task.revision !== current.revision) {
      return await fail(
        deps,
        current,
        "AI_TASK_RACE",
        "任务状态在生成期间被其他实例改变，未接管。",
        now
      );
    }
    return null;
  };

  const stoppedAtStart = await cancellationCheck();
  if (stoppedAtStart) return stoppedAtStart;

  // 输入预算：覆盖最终构造的完整请求输入（含索引、边界与"含图"标记），不只统计正文。
  // 预算口径为 JS 字符数（与 P2 TASK_BUDGETS 一致）；UTF-8 字节不在本层单列（服务端另有请求体字节上限）。
  let input: string;
  let configId: string;
  if (deps.signal?.aborted) {
    return await cancelTask(deps, current, now);
  }
  try {
    input = buildCaptureOrganizeInput(sources);
    if (input.length > maxInputChars) {
      return await fail(
        deps,
        current,
        "AI_INPUT_TOO_LARGE",
        `所选记录整理请求超过 ${maxInputChars} 字符预算（含编号与标记），未截断、未拆批。`,
        now
      );
    }
    configId = deps.selectConfig();
  } catch (error) {
    return await fail(deps, current, "AI_CONFIG_UNAVAILABLE", describe(error), now);
  }

  let result;
  try {
    if (deps.signal?.aborted) return await cancelTask(deps, current, now);
    result = await deps.callGateway({
      configId,
      task: "organize_captures",
      input,
      ...(deps.signal ? { signal: deps.signal } : {})
    });
  } catch (error) {
    const cancelled = await cancellationCheck();
    if (cancelled) return cancelled;
    if (deps.signal?.aborted) return await cancelTask(deps, current, now);
    return await fail(deps, current, "AI_REQUEST_FAILED", describe(error), now);
  }

  const afterResponse = await cancellationCheck();
  if (afterResponse) return afterResponse;

  if (!result.ok) {
    if (result.code === "AI_CANCELLED") return await cancelTask(deps, current, now);
    return await fail(deps, current, result.code, result.detail, now);
  }

  // 总输出预算（字符口径）：超限即异常，不截断。
  if (result.content.length > maxOutputChars) {
    return await fail(
      deps,
      current,
      "AI_OUTPUT_TOO_LARGE",
      `模型输出超过 ${maxOutputChars} 字符预算。`,
      now
    );
  }

  let sections;
  try {
    sections = parseCaptureOrganizeResult(result.content, sources.length).sections;
  } catch (error) {
    return await fail(deps, current, "AI_RESULT_INVALID", describe(error), now);
  }

  // 空 sections：没有可加入内容，任务完成但不生成空建议。
  if (sections.length === 0) {
    if (deps.signal?.aborted) return await cancelTask(deps, current, now);
    return await convergeTerminal(deps, current, "completed", { step: 2 }, now, {
      code: "AI_TASK_RACE",
      detail: "任务完成状态未能落库。"
    });
  }

  // 投影（跳过的来源连图片一并跳过）→ 载荷 → 自校验。
  const { draft, includedMessageIds } = draftFromCaptureSections(sources, sections);
  const payload = {
    kind: "organize_captures" as const,
    target,
    sources,
    mediaLink,
    includedMessageIds,
    draft,
    outgoingInput: input
  };
  const payloadIssues = validateProposalPayload(payload);
  if (payloadIssues.length > 0) {
    return await fail(
      deps,
      current,
      "AI_RESULT_REJECTED",
      payloadIssues.map((issue) => `${issue.code}:${issue.detail}`).join("；"),
      now
    );
  }

  // 落库前的取消/清空检查：不留下孤立建议。
  const beforePersist = await cancellationCheck();
  if (beforePersist) return beforePersist;

  const proposalId = (deps.createId ?? defaultIdFactory("prop", now))();
  const sourceRefs: AiSourceRef[] = sources.map((source) => ({
    kind: "capture_message",
    id: source.messageId,
    sourceDigest: sourceSnapshotDigest(source)
  }));
  const proposal: AiProposal = {
    id: proposalId,
    taskId: current.id,
    type: "organize_captures",
    status: "draft",
    revision: 0,
    sourceRefs,
    // Capture 任务没有页面基线；来源身份由 sourceRefs（逐条快照摘要）承载。
    baselines: [],
    payload,
    createdAt: now().toISOString(),
    updatedAt: now().toISOString()
  };

  // 冻结预览（payloadDigest + previewedAt）：原子落库前完成，落库即可接受。
  const previewed = previewProposal(proposal, now);
  if (!previewed.ok) {
    return await fail(deps, current, "AI_PROPOSAL_INVALID", "建议载荷不合法，已拒绝。", now);
  }

  const waiting = transitionAiTask(
    current,
    "waiting_user",
    { proposalId, step: 2 },
    now,
    current.revision
  );
  if (!waiting.ok) {
    const afterCas = await cancellationCheck();
    if (afterCas) return afterCas;
    return {
      status: "failed",
      task: waiting.current,
      detail: "任务状态在生成期间被改变。",
      code: "AI_TASK_RACE"
    };
  }

  // 原子落库：事务提交 = 任务 waiting_user 与冻结建议同时存在。
  // 提交成功后的信号取消不回滚已提交结果。
  try {
    if (deps.signal?.aborted) return await cancelTask(deps, current, now);
    await deps.ai.saveTaskWithProposal({
      task: waiting.task,
      proposal: previewed.proposal,
      expectedRevision: current.revision
    });
  } catch (error) {
    const afterFailure = await cancellationCheck();
    if (afterFailure) return afterFailure;
    return await fail(deps, current, "AI_PERSIST_FAILED", describe(error), now);
  }

  return {
    status: "waiting_user",
    task: waiting.task,
    proposal: previewed.proposal,
    gateway: { model: result.model, configId: result.configId }
  };
}
