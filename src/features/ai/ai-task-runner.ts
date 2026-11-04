/**
 * P1-05：普通有限步骤任务执行（organize_page）。
 *
 * 步骤固定、数量有限：读 Context → 拼 Prompt → 请求 Gateway → Schema 校验 → Proposal。
 * 不建 Agent Runtime、不建步骤引擎、不做自动重试；取消与迟到结果由任务状态保护。
 *
 * R4 边界：本文件属于**浏览器侧**，不导入任何 `src/server/**`；模型调用只经注入的
 * `callGateway`（生产为 `/api/ai/generate` 的最小请求函数）。模型配置由调用方**显式选择**。
 */
import type { AiReadScope } from "./ai-context";
import { createAiContextProvider, type AiContextProviderOptions } from "./ai-context";
import { digestPageBlocks } from "../notebook/notebook-model";
import { validateOrganizePayload, type AiProposal, type AiSourceRef } from "./ai-proposal";
import { parseOrganizePageResult } from "./ai-result-schema";
import type { AiRepository } from "./ai-repository";
import { isAiTaskTerminal, transitionAiTask, type AiTask, type AiTaskStatus } from "./ai-task";
import { buildPageOrganizeInput } from "./prompts/page-organize";
import type { AiGatewayCaller, AiGatewayTask } from "./ai-gateway-client";

export const TASK_BUDGETS = {
  /** 送入模型的输入字符上限（与服务端 GATEWAY_LIMITS.maxInputChars 取较小值生效）。 */
  maxInputChars: 20_000,
  /** 期望输出字符上限；超过即视为结果异常。 */
  maxOutputChars: 8_000
} as const;

export type OrganizePageDeps = {
  /** 领域快照与媒体元数据（只读）。 */
  context: AiContextProviderOptions;
  ai: AiRepository;
  /** 最小 Gateway 请求函数（浏览器边界）；测试可注入受控实现。 */
  callGateway: AiGatewayCaller;
  /**
   * 本任务使用的模型配置 ID。必须由调用方显式给出：
   * 不允许在这里悄悄取配置列表第一项。
   */
  selectConfig: () => string;
  scope?: Partial<AiReadScope>;
  now?: () => Date;
  /** 生成 ID；缺省用进程内单调计数器（避免并发任务 ID 碰撞）。 */
  createId?: () => string;
  /**
   * 任务级预算覆盖（缺省用 TASK_BUDGETS）。
   * 输入预算在送入 Gateway 前生效，输出预算在解析前生效，两者都明确失败也不静默截断。
   */
  budgets?: { maxInputChars?: number; maxOutputChars?: number };
  /** 取消信号：向 Gateway 请求传播。 */
  signal?: AbortSignal;
};

export type OrganizePageOutcome =
  | {
      status: "waiting_user";
      task: AiTask;
      proposal: AiProposal;
      gateway: { model: string; configId: string };
    }
  | { status: "failed"; task: AiTask; detail: string; code: string }
  | { status: "cancelled"; task: AiTask }
  | { status: "not-run"; task: AiTask; reason: "invalid-transition" | "stale-revision" };

/**
 * 进程内单调 ID：毫秒时间戳 + 单调序号 + 随机后缀。
 * 并发任务不能依赖“每次重新归零的毫秒计数器”。
 *
 * 导出给同层第二个普通任务 runner（P4 analyze_notebook）复用同一单调序号，
 * 避免各写一份 ID 生成器。
 */
let idSequence = 0;
export function defaultIdFactory(prefix: string, now: () => Date): () => string {
  return () => {
    idSequence += 1;
    const random = Math.random().toString(36).slice(2, 8);
    return `${prefix}-${now().getTime().toString(36)}-${idSequence.toString(36)}-${random}`;
  };
}

/** 供测试重置单调序号，避免跨用例互相影响。 */
export function resetAiIdSequence(): void {
  idSequence = 0;
}

/** 页快照 → 块数组：用于复用 notebook-model 的规范块摘要。 */
function toBlocksForDigest(page: {
  blocks: readonly {
    blockId: string;
    kind: string;
    text?: string;
    mediaId?: string;
    caption?: string;
    markdown?: string;
  }[];
}) {
  return page.blocks.map((block) =>
    block.kind === "text"
      ? { id: block.blockId, type: "text" as const, text: block.text ?? "" }
      : block.kind === "photo"
        ? {
            id: block.blockId,
            type: "photo" as const,
            mediaId: block.mediaId ?? "",
            caption: block.caption ?? ""
          }
        : {
            id: block.blockId,
            type: "unsupported-image" as const,
            markdown: block.markdown ?? ""
          }
  );
}

/**
 * 执行一次 organize_page。
 * `task` 必须是 queued（或由调用方先显式重试成 queued）；running/终态不会被本函数接管。
 */
export async function runOrganizePageTask(
  deps: OrganizePageDeps,
  task: AiTask
): Promise<OrganizePageOutcome> {
  const now = deps.now ?? (() => new Date());
  const maxInputChars = deps.budgets?.maxInputChars ?? TASK_BUDGETS.maxInputChars;
  const maxOutputChars = deps.budgets?.maxOutputChars ?? TASK_BUDGETS.maxOutputChars;

  // 本函数只接管 organize_page；capture 等其他类型不在此执行（判别联合收窄 input 形状）。
  if (task.type !== "organize_page") {
    return { status: "not-run", task, reason: "invalid-transition" };
  }
  const pageId = task.input.pageId;
  const frozenSourceDigest = task.input.sourceDigest;

  // 首次执行：先把 queued 状态落库，后续迁移才能基于 revision 做 CAS。
  if (!(await deps.ai.getTask(task.id))) {
    await deps.ai.saveTask(task);
  }

  const running = transitionAiTask(task, "running", { step: 1 }, now, task.revision);
  if (!running.ok) {
    return {
      status: "not-run",
      task: running.current,
      reason: running.reason as "invalid-transition"
    };
  }
  await deps.ai.saveTask(running.task, { expectedRevision: task.revision });
  const current = running.task;

  /**
   * 取消/清空检查：
   * - 任务被取消 → cancelled；
   * - 任务在 AI 库里已不存在（数据被清空）→ 同样立即停止，不允许迟到回调重建任何东西。
   */
  const cancellationCheck = async (): Promise<OrganizePageOutcome | null> => {
    const stored = await deps.ai.getTask(current.id);
    if (!stored) return { status: "cancelled", task: current };
    if (stored.status === "cancelled") return { status: "cancelled", task: stored };
    return null;
  };

  const stoppedAtStart = await cancellationCheck();
  if (stoppedAtStart) return stoppedAtStart;

  // R5：Context 读取、预算、请求、解析、持久化异常都必须有明确结果，不能停在 running。
  let page;
  try {
    const provider = createAiContextProvider(deps.context);
    page = await provider.getPage(pageId, {
      ...(deps.scope ? { scope: deps.scope } : {})
    });
  } catch (error) {
    return await fail(deps, current, "AI_CONTEXT_FAILED", describe(error), now);
  }
  if (!page) {
    return await fail(deps, current, "AI_SOURCE_UNAVAILABLE", "目标篇不存在或不可读。", now);
  }
  if (page.sourceDigest !== frozenSourceDigest) {
    return await fail(deps, current, "AI_SOURCE_CHANGED", "源内容已变化，请重新创建任务。", now);
  }

  let input: string;
  let configId: string;
  try {
    input = buildPageOrganizeInput(page);
    if (input.length > maxInputChars) {
      return await fail(
        deps,
        current,
        "AI_INPUT_TOO_LARGE",
        `输入超过 ${maxInputChars} 字符预算。`,
        now
      );
    }
    configId = deps.selectConfig();
  } catch (error) {
    return await fail(deps, current, "AI_CONFIG_UNAVAILABLE", describe(error), now);
  }

  let result;
  try {
    result = await deps.callGateway({
      configId,
      task: "organize_page" satisfies AiGatewayTask,
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
    // 服务端把取消映射成 AI_CANCELLED；据此落到 cancelled 终态。
    if (result.code === "AI_CANCELLED") return await cancelTask(deps, current, now);
    return await fail(deps, current, result.code, result.detail, now);
  }

  if (result.content.length > maxOutputChars) {
    return await fail(
      deps,
      current,
      "AI_OUTPUT_TOO_LARGE",
      `模型输出超过 ${maxOutputChars} 字符预算。`,
      now
    );
  }

  let parsed;
  try {
    parsed = parseOrganizePageResult(result.content);
  } catch (error) {
    return await fail(deps, current, "AI_RESULT_INVALID", describe(error), now);
  }

  /**
   * P2-02：正文载荷投影在落库前完成。
   *
   * 本阶段只整理正文：即使模型返回 title/summary，也**不进入**载荷，
   * 因此不可能从预览冻结之后改载荷来“补救”，也不会写业务或元数据。
   * 其余状态与原子写语义（下文的 CAS + 同库原子落库）完全保持。
   */
  const payload = {
    kind: "organize_page" as const,
    pageId: page.id,
    textBlocks: parsed.textBlocks
  };
  const payloadIssues = validateOrganizePayload(payload);
  const blockIds = new Set(page.blocks.map((block) => block.blockId));
  const unknownBlocks = parsed.textBlocks.filter((block) => !blockIds.has(block.blockId));
  const nonTextBlocks = parsed.textBlocks.filter((block) => {
    const target = page.blocks.find((item) => item.blockId === block.blockId);
    return target !== undefined && target.kind !== "text";
  });
  if (payloadIssues.length > 0 || unknownBlocks.length > 0 || nonTextBlocks.length > 0) {
    return await fail(
      deps,
      current,
      "AI_RESULT_REJECTED",
      [
        ...payloadIssues.map((issue) => `${issue.code}:${issue.detail}`),
        ...unknownBlocks.map((block) => `BLOCK_UNKNOWN:${block.blockId}`),
        ...nonTextBlocks.map((block) => `BLOCK_NOT_TEXT:${block.blockId}`)
      ].join("；") || "结果被拒绝。",
      now
    );
  }

  // 落库阶段的取消检查：响应后、建议写入前的取消/清空不能留下孤立建议。
  const beforePersist = await cancellationCheck();
  if (beforePersist) return beforePersist;

  const proposalId = (deps.createId ?? defaultIdFactory("prop", now))();
  const sourceRef: AiSourceRef = {
    kind: "page",
    id: page.id,
    blockIds: page.blocks.map((block) => block.blockId),
    sourceDigest: page.sourceDigest
  };
  const proposal: AiProposal = {
    id: proposalId,
    taskId: current.id,
    type: "organize_page",
    status: "draft",
    revision: 0,
    sourceRefs: [sourceRef],
    // R2：冻结基线取自生成时的页状态，复用 PageEditBaseline 的同一摘要函数。
    baselines: [
      {
        pageId: page.id,
        updatedAt: page.updatedAt,
        blocksDigest: digestPageBlocks({ blocks: toBlocksForDigest(page) })
      }
    ],
    payload,
    createdAt: now().toISOString(),
    updatedAt: now().toISOString()
  };

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

  /*
   * F4/F5：任务状态迁移与建议落库是一次**同库原子写**。
   *
   * - 事务提交 = 任务 waiting_user 与建议同时存在；
   * - 任务被清空（clear 先完成）= 任务记录不存在 → 拒绝，迟到回调不能重建建议；
   * - 建议写入失败 = 事务不提交，任务仍是 running（不会再留下“waiting_user 却没有建议”）；
   * - 任务身份用 revision 条件，终态不可被降级。
   */
  try {
    await deps.ai.saveTaskWithProposal({
      task: waiting.task,
      proposal,
      expectedRevision: current.revision
    });
  } catch (error) {
    const afterFailure = await cancellationCheck();
    if (afterFailure) return afterFailure;
    // 原子写没有提交：任务仍为 running，显式落到 failed 并如实返回实际持久状态。
    return await fail(deps, current, "AI_PERSIST_FAILED", describe(error), now);
  }

  return {
    status: "waiting_user",
    task: waiting.task,
    proposal,
    gateway: { model: result.model, configId: result.configId }
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 任务收敛辅助（`fail` / `cancelTask`）：只依赖 AiRepository，供同层多个普通任务
 * runner 复用，避免各写一份“落终态 + 确认持久状态”的代码。
 */
type TaskSettlementDeps = { ai: AiRepository };

/**
 * R2：取消/迟到检查（P4 与 P5 的普通任务 runner 共用，避免各写一份而漏检信号）。
 *
 * 语义：
 * - 任务记录消失 → `cancelled`（迟到回调不得重建任何东西）；
 * - 已是终态（cancelled/completed/failed）→ `already-settled`，**不改写**，如实返回库中状态；
 * - 调用方已 abort（即使上游把取消后的响应当成成功返回）→ 只在**本任务**上落 cancelled；
 * - 其余 → `continue`。
 *
 * 只依赖注入的 signal 与持久状态，不依赖 Gateway 必然抛 AbortError。
 */
export type TaskCancellationDecision =
  | { kind: "continue" }
  | { kind: "cancelled"; task: AiTask }
  | { kind: "already-settled"; task: AiTask; status: AiTaskStatus };

export async function checkTaskCancellation(
  deps: { ai: AiRepository; signal?: AbortSignal },
  task: AiTask,
  now: () => Date
): Promise<TaskCancellationDecision> {
  const stored = await deps.ai.getTask(task.id);
  if (!stored) return { kind: "cancelled", task };
  if (isAiTaskTerminal(stored.status)) {
    return { kind: "already-settled", task: stored, status: stored.status };
  }
  if (deps.signal?.aborted) {
    const settled = await cancelTask(deps, stored, now);
    return { kind: "cancelled", task: settled.task };
  }
  return { kind: "continue" };
}

export async function cancelTask(
  deps: TaskSettlementDeps,
  task: AiTask,
  now: () => Date
): Promise<{ status: "cancelled"; task: AiTask }> {
  const cancelled = transitionAiTask(task, "cancelled", {}, now, task.revision);
  if (!cancelled.ok) return { status: "cancelled", task: cancelled.current };
  await deps.ai.saveTask(cancelled.task, { expectedRevision: task.revision });
  return { status: "cancelled", task: cancelled.task };
}

export async function fail(
  deps: TaskSettlementDeps,
  task: AiTask,
  code: string,
  detail: string,
  now: () => Date
): Promise<{ status: "failed"; task: AiTask; detail: string; code: string }> {
  const failed = transitionAiTask(
    task,
    "failed",
    { error: { code, message: detail } },
    now,
    task.revision
  );
  if (!failed.ok) return { status: "failed", task: failed.current, detail, code };
  try {
    await deps.ai.saveTask(failed.task, { expectedRevision: task.revision });
  } catch {
    // 状态写入失败也要给出明确结果，而不是抛出后停在 running。
  }
  return { status: "failed", task: failed.task, detail, code };
}
