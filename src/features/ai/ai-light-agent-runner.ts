/**
 * P8：整理检索结果的有界执行器（`organize_collection`）——**只读分组**。
 *
 * 流程固定、数量有限：冻结范围核对 → 计划输入预算 → 模型请求 1（结构化计划）→
 * 本地计划校验（工具白名单 / 范围只能收窄）→ 有界顺序执行 search_pages / read_pages →
 * 模型请求 2（结构化分组结果）→ 结果校验（来源必须恰好是实际读取集合）→
 * 保存前权威回读 → 落一条**只读** Proposal（status=draft）。
 *
 * 不建 Agent Runtime、不建步骤引擎、不建工具注册表（两个工具就是两个分支）、
 * 不自动重试、不自动修复模型输出后再请求。
 *
 * 只读承诺：本文件没有业务写路径。结果进入 AI 独立库的 proposals（draft，没有
 * accepted/applied 语义），不写正文、媒体或业务收据；Safe Commit 不认识该载荷。
 *
 * R4 边界：本文件属于**浏览器侧**，不导入任何 `src/server/**`；模型调用只经注入的
 * `callGateway`（生产为 `/api/ai/generate` 的最小请求函数）。
 *
 * 安全默认：手帐正文与模型输出都是**不可信数据**。正文里的指令不能新增工具、
 * 扩大范围或触发写入——工具只有两个，范围只做交集/包含校验。
 */
import {
  aiVisiblePages,
  createAiContextProvider,
  createAiReadScope,
  mergeAiReadScope,
  narrowNotebookScope,
  type AiContextProvider,
  type AiContextProviderOptions,
  type AiPageContext,
  type AiReadScope
} from "./ai-context";
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  createSearchProvider,
  type AiPageQuery,
  type SearchResponse
} from "./search-provider";
import {
  LIGHT_AGENT_BUDGETS,
  parseLightAgentPlan,
  parseLightAgentResult,
  resolveLightAgentBudgets,
  validatePlanAgainstScope,
  type LightAgentPlan,
  type LightAgentSearchStep
} from "./ai-light-agent-schema";
import {
  buildLightAgentPlanInput,
  buildLightAgentSynthesisInput,
  type LightAgentAllowedOptions,
  type LightAgentOption
} from "./prompts/light-agent";
import {
  previewProposal,
  type AiProposal,
  type AiSourceRef,
  type OrganizeCollectionPayload
} from "./ai-proposal";
import type { AiRepository } from "./ai-repository";
import {
  isOrganizeCollectionTaskInput,
  transitionAiTask,
  type AiTask,
  type CollectionScope,
  type OrganizeCollectionTaskInput
} from "./ai-task";
import type { AiGatewayCaller } from "./ai-gateway-client";
import {
  cancelTask,
  checkTaskCancellation,
  defaultIdFactory,
  fail,
  type TaskCancellationDecision
} from "./ai-task-runner";
import type { ArchiveCore } from "../notebook/notebook-repository";

/** 步骤进度：1 计划、2 工具执行、3 综合、4 完成（只读任务没有 waiting_user）。 */
export const LIGHT_AGENT_STEPS = { plan: 1, tools: 2, synthesize: 3, done: 4 } as const;

export type LightAgentTraceKind = "plan" | "search" | "read" | "synthesize";

/**
 * 运行轨迹的一条记录：**只有**步骤类型、计数、耗时、状态与安全错误码。
 * 不记录模型输出、隐藏思考、密钥或完整上游请求；也不持久化（只存在于本次会话）。
 */
export type LightAgentTraceStep = {
  kind: LightAgentTraceKind;
  status: "ok" | "failed" | "cancelled";
  durationMs: number;
  counts?: Record<string, number>;
  errorCode?: string;
};

export type OrganizeCollectionDeps = {
  /** 领域快照与媒体元数据（只读）。 */
  context: AiContextProviderOptions;
  ai: AiRepository;
  callGateway: AiGatewayCaller;
  /** 本任务使用的模型配置 ID；必须显式给出。 */
  selectConfig: () => string;
  /**
   * 冻结时用户可见的可选项展示名（地区/旅行/地点）。用于计划输入：
   * 模型只能在这些 id 里做选择，因此需要知道它们的名字。不做真实性判断。
   */
  allowedOptions?: LightAgentAllowedOptions;
  /**
   * 权威回读（例如 `notebookRepository.loadArchive()`）：
   * 外发综合请求前与保存提案前各核对一次来源是否仍然可见且内容未变化。
   */
  loadArchive?: () => Promise<ArchiveCore>;
  /** 额外的上下文读取范围上限（与本任务范围取交集/更小预算）。 */
  scope?: Partial<AiReadScope>;
  now?: () => Date;
  createId?: () => string;
  signal?: AbortSignal;
  /** 覆盖默认预算（键受约束，值必须是数字；默认值见 LIGHT_AGENT_BUDGETS）。 */
  budgets?: Partial<Record<keyof typeof LIGHT_AGENT_BUDGETS, number>>;
};

export type OrganizeCollectionOutcome =
  | {
      status: "completed";
      task: AiTask;
      proposal: AiProposal;
      /** 实际读取篇数（分组结果的来源集合大小）。 */
      readCount: number;
      gateway: { model: string; configId: string };
      trace: LightAgentTraceStep[];
    }
  | {
      status: "empty";
      task: AiTask;
      /** 无结果原因（检索无命中或计划未读取到任何篇）；**不发起综合请求**。 */
      detail: string;
      trace: LightAgentTraceStep[];
    }
  | { status: "failed"; task: AiTask; detail: string; code: string; trace: LightAgentTraceStep[] }
  | { status: "cancelled"; task: AiTask; trace: LightAgentTraceStep[] }
  | { status: "not-run"; task: AiTask; reason: "invalid-transition" | "stale-revision" };

/** 把冻结范围叠加到计划步骤上：模型没给的维度用冻结值，模型给了的必须已被校验为更窄。 */
export function applyFrozenScope(
  step: LightAgentSearchStep,
  scope: CollectionScope
): AiPageQuery {
  const notebookIds = step.notebookIds ?? scope.notebookIds;
  const regionIds = step.regionIds ?? scope.regionIds;
  const tripIds = step.tripIds ?? scope.tripIds;
  const placeIds = step.placeIds ?? scope.placeIds;
  const from = step.from ?? scope.from;
  const to = step.to ?? scope.to;
  return {
    mode: "keyword",
    ...(step.query !== undefined ? { query: step.query } : {}),
    ...(notebookIds !== null ? { notebookIds: [...notebookIds] } : {}),
    ...(regionIds !== null ? { regionIds: [...regionIds] } : {}),
    ...(tripIds !== null ? { tripIds: [...tripIds] } : {}),
    ...(placeIds !== null ? { placeIds: [...placeIds] } : {}),
    ...(from !== null ? { from } : {}),
    ...(to !== null ? { to } : {}),
    limit: step.limit ?? SEARCH_DEFAULT_LIMIT
  };
}

function scopeSummary(scope: CollectionScope, visiblePages: number): string {
  const list = (value: readonly string[] | null) => (value === null ? "(不限)" : value.join(","));
  return [
    `notebooks: ${list(scope.notebookIds)}`,
    `regions: ${list(scope.regionIds)}`,
    `trips: ${list(scope.tripIds)}`,
    `places: ${list(scope.placeIds)}`,
    `from: ${scope.from ?? "(不限)"}`,
    `to: ${scope.to ?? "(不限)"}`,
    `visiblePages: ${visiblePages}`
  ].join("\n");
}

/** 只把冻结范围里出现过的维度对应的选项发给模型（不泄漏范围外的 id/名字）。 */
function narrowOptions(
  options: readonly LightAgentOption[] | undefined,
  authorized: readonly string[] | null
): LightAgentOption[] {
  if (!options || options.length === 0) return [];
  if (authorized === null) return [...options];
  const allowed = new Set(authorized);
  return options.filter((option) => allowed.has(option.id));
}

/**
 * 执行一次 organize_collection。
 * `task` 必须是 queued（或由调用方先显式重试成 queued）；running/终态不会被本函数接管。
 */
export async function runOrganizeCollectionTask(
  deps: OrganizeCollectionDeps,
  task: AiTask
): Promise<OrganizeCollectionOutcome> {
  const now = deps.now ?? (() => new Date());
  // R4：覆盖值只允许合法有限值且只能降低；非法值保持硬默认，绝不变成隐式无限预算。
  const budgets = resolveLightAgentBudgets(deps.budgets);
  const trace: LightAgentTraceStep[] = [];

  if (task.type !== "organize_collection") {
    return { status: "not-run", task, reason: "invalid-transition" };
  }
  const input: OrganizeCollectionTaskInput = task.input;

  /*
   * 输入边界：范围为空数组（=没有权限）、缺目标或预算不合法时，
   * 这里明确失败且**不发出任何模型请求**，也不让存储边界的拒绝逃逸成未处理异常。
   */
  if (!isOrganizeCollectionTaskInput(input)) {
    return {
      status: "failed",
      task,
      detail: "任务输入不合法（整理目标或范围为空/格式错误）；未发出模型请求。",
      code: "AI_TASK_INVALID",
      trace: []
    };
  }

  // —— 超时：主动取消在途请求（不能只在返回后判断） ——
  const startedAt = now().getTime();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, budgets.maxDurationMs));
  const onExternalAbort = () => controller.abort();
  deps.signal?.addEventListener("abort", onExternalAbort);

  let toolCalls = 0;
  let modelRequests = 0;
  const readPages: AiPageContext[] = [];
  const readIds = new Set<string>();
  let readChars = 0;

  const budgetFailure = (): { code: string; detail: string } | null => {
    if (timedOut || now().getTime() - startedAt > budgets.maxDurationMs) {
      return {
        code: "AI_RUN_TIMEOUT",
        detail: `本次整理超过 ${Math.round(budgets.maxDurationMs / 1000)} 秒上限，已取消在途请求。`
      };
    }
    if (toolCalls > budgets.maxToolCalls) {
      return {
        code: "AI_OVER_BUDGET",
        detail: `工具调用超过 ${budgets.maxToolCalls} 次上限；请缩小整理范围。`
      };
    }
    if (modelRequests > budgets.maxModelRequests) {
      return { code: "AI_OVER_BUDGET", detail: `模型请求超过 ${budgets.maxModelRequests} 次上限。` };
    }
    if (readPages.length > budgets.maxReadPages) {
      return {
        code: "AI_OVER_BUDGET",
        detail: `读取篇数超过 ${budgets.maxReadPages} 篇上限；请缩小整理范围。`
      };
    }
    if (readChars > budgets.maxReadChars) {
      return {
        code: "AI_OVER_BUDGET",
        detail: `读取正文超过 ${budgets.maxReadChars} 字符预算；本次不会截断正文，请缩小整理范围。`
      };
    }
    return null;
  };

  /**
   * R4：**调用前**预占模型请求额度。额度不足立即失败，绝不先发请求再事后追认。
   * 零额度（0）语义明确：任何请求都被拒绝，且不会创建 Provider 之外的任何外部调用。
   */
  const reserveModelRequest = (): { code: string; detail: string } | null => {
    if (modelRequests + 1 > budgets.maxModelRequests) {
      return {
        code: "AI_OVER_BUDGET",
        detail: `模型请求超过 ${budgets.maxModelRequests} 次上限；未发出该请求。`
      };
    }
    modelRequests += 1;
    return null;
  };

  try {
    // —— 冻结范围：授权范围只能取交集，任务范围只能收窄 ——
    const declaredScope = createAiReadScope(deps.scope);
    const contextScope = createAiReadScope(deps.context.scope);
    const scopeBase = mergeAiReadScope(declaredScope, contextScope);
    const authorizedNotebooks = narrowNotebookScope(
      scopeBase.notebookIds,
      input.scope.notebookIds
    );
    const readScope: AiReadScope = {
      ...scopeBase,
      notebookIds: authorizedNotebooks,
      maxPages: Math.min(scopeBase.maxPages, budgets.maxReadPages),
      maxTotalTextChars: Math.min(scopeBase.maxTotalTextChars, budgets.maxReadChars)
    };

    // 首次执行：先把 queued 状态落库，后续迁移才能基于 revision 做 CAS。
    if (!(await deps.ai.getTask(task.id))) {
      await deps.ai.saveTask(task);
    }
    const running = transitionAiTask(task, "running", { step: LIGHT_AGENT_STEPS.plan }, now, task.revision);
    if (!running.ok) {
      return {
        status: "not-run",
        task: running.current,
        reason: running.reason as "invalid-transition"
      };
    }
    const runningTask = running.task;
    try {
      await deps.ai.saveTask(runningTask, { expectedRevision: task.revision });
    } catch {
      // 任务在“检查之后、写入之前”被别的路径推进/降级：绝不改写，如实报告未接管。
      const stored = await deps.ai.getTask(task.id).catch(() => null);
      return { status: "not-run", task: stored ?? runningTask, reason: "stale-revision" };
    }
    const current = runningTask;

    /** 取消/迟到：检查信号 + 持久状态；已终态只如实转述，绝不改写。 */
    const cancellationCheck = async (): Promise<OrganizeCollectionOutcome | null> =>
      cancellationOutcome(await checkTaskCancellation(deps, current, now), trace);

    /**
     * R1：**权威回读（或任何本地核对）返回后的统一守卫**。
     *
     * 顺序固定：取消与持久状态 → 全部预算（含总超时）→ 业务错误。
     * 三类返回（成功 / 业务失败 / 抛错归一）都走这里，避免只在成功分支加判断；
     * 取消或超时后绝不进入下一动作（不再发请求、不建提案、不写 completed）。
     */
    const afterAuthoritativeRead = async (
      check: { code: string; detail: string } | null
    ): Promise<OrganizeCollectionOutcome | null> => {
      const stopped = await cancellationCheck();
      if (stopped) return stopped;
      const over = budgetFailure();
      if (over) {
        return withTrace(await fail(deps, current, over.code, over.detail, now), trace);
      }
      if (check) {
        return withTrace(await fail(deps, current, check.code, check.detail, now), trace);
      }
      return null;
    };

    /** 来源重验永不抛：内部异常归为错误码，调用方统一走上面的守卫。 */
    const reverifySources = async (): Promise<{ code: string; detail: string } | null> => {
      try {
        return await verifySources(deps, readPages, input.scope);
      } catch (error) {
        return { code: "AI_CONTEXT_FAILED", detail: `核对来源失败：${describe(error)}` };
      }
    };

    const stoppedAtStart = await cancellationCheck();
    if (stoppedAtStart) return stoppedAtStart;

    // 空范围 = 没有权限，绝不解释成「全部」；这里零模型请求。
    if (authorizedNotebooks !== null && authorizedNotebooks.length === 0) {
      return withTrace(
        await fail(
          deps,
          current,
          "AI_SCOPE_EMPTY",
          "本次允许的手帐本范围为空：没有任何可读取的篇，也没有发出模型请求。",
          now
        ),
        trace
      );
    }

    let provider: AiContextProvider;
    let notebooks: LightAgentOption[];
    let visiblePages: number;
    try {
      provider = createAiContextProvider(deps.context);
      notebooks = (await provider.listNotebooks({ scope: readScope })).map((notebook) => ({
        id: notebook.id,
        label: notebook.title
      }));
      visiblePages = aiVisiblePages(deps.context.archive, readScope).length;
    } catch (error) {
      return withTrace(await fail(deps, current, "AI_CONTEXT_FAILED", describe(error), now), trace);
    }
    const stoppedAfterContext = await cancellationCheck();
    if (stoppedAfterContext) return stoppedAfterContext;

    if (visiblePages === 0) {
      return withTrace(
        await fail(
          deps,
          current,
          "AI_SCOPE_EMPTY",
          "本次范围内没有可读取的篇（可能已删除、已归档或不在选定手帐本内）；未发出模型请求。",
          now
        ),
        trace
      );
    }
    const overBudgetBeforePlan = budgetFailure();
    if (overBudgetBeforePlan) {
      return withTrace(
        await fail(deps, current, overBudgetBeforePlan.code, overBudgetBeforePlan.detail, now),
        trace
      );
    }

    // —— 模型请求 1：结构化计划 ——
    let configId: string;
    let planInput: string;
    try {
      configId = deps.selectConfig();
      planInput = buildLightAgentPlanInput({
        goal: input.goal,
        notebooks,
        visiblePages,
        from: input.scope.from,
        to: input.scope.to,
        allowed: {
          regions: narrowOptions(deps.allowedOptions?.regions, input.scope.regionIds),
          trips: narrowOptions(deps.allowedOptions?.trips, input.scope.tripIds),
          places: narrowOptions(deps.allowedOptions?.places, input.scope.placeIds)
        }
      });
    } catch (error) {
      return withTrace(await fail(deps, current, "AI_CONFIG_UNAVAILABLE", describe(error), now), trace);
    }
    if (planInput.length > budgets.maxPlanInputChars) {
      return withTrace(
        await fail(
          deps,
          current,
          "AI_INPUT_TOO_LARGE",
          `计划输入超过 ${budgets.maxPlanInputChars} 字符预算（范围过大）；请缩小范围后再试；未发出模型请求。`,
          now
        ),
        trace
      );
    }

    const planStarted = now().getTime();
    const planReservation = reserveModelRequest();
    if (planReservation) {
      return withTrace(
        await fail(deps, current, planReservation.code, planReservation.detail, now),
        trace
      );
    }
    let planResult;
    try {
      planResult = await deps.callGateway({
        configId,
        task: "plan_collection",
        input: planInput,
        signal: controller.signal
      });
    } catch (error) {
      const stopped = await cancellationCheck();
      if (stopped) return stopped;
      const over = budgetFailure();
      if (over) {
        trace.push({
          kind: "plan",
          status: "failed",
          durationMs: now().getTime() - planStarted,
          errorCode: over.code
        });
        return withTrace(await fail(deps, current, over.code, over.detail, now), trace);
      }
      trace.push({
        kind: "plan",
        status: "failed",
        durationMs: now().getTime() - planStarted,
        errorCode: "AI_REQUEST_FAILED"
      });
      return withTrace(await fail(deps, current, "AI_REQUEST_FAILED", describe(error), now), trace);
    }
    const stoppedAfterPlan = await cancellationCheck();
    if (stoppedAfterPlan) return stoppedAfterPlan;
    const overAfterPlan = budgetFailure();
    if (overAfterPlan) {
      return withTrace(
        await fail(deps, current, overAfterPlan.code, overAfterPlan.detail, now),
        trace
      );
    }
    if (!planResult.ok) {
      trace.push({
        kind: "plan",
        status: "failed",
        durationMs: now().getTime() - planStarted,
        errorCode: planResult.code
      });
      if (planResult.code === "AI_CANCELLED") return withTrace(await cancelTask(deps, current, now), trace);
      return withTrace(await fail(deps, current, planResult.code, planResult.detail, now), trace);
    }
    if (planResult.content.length > budgets.maxPlanOutputChars) {
      trace.push({
        kind: "plan",
        status: "failed",
        durationMs: now().getTime() - planStarted,
        errorCode: "AI_OUTPUT_TOO_LARGE"
      });
      return withTrace(
        await fail(
          deps,
          current,
          "AI_OUTPUT_TOO_LARGE",
          `计划输出超过 ${budgets.maxPlanOutputChars} 字符预算。`,
          now
        ),
        trace
      );
    }
    let plan: LightAgentPlan;
    try {
      plan = parseLightAgentPlan(planResult.content, { maxSearchLimit: SEARCH_MAX_LIMIT });
      const scopeIssues = validatePlanAgainstScope(plan, input.scope);
      if (scopeIssues.length > 0) {
        trace.push({
          kind: "plan",
          status: "failed",
          durationMs: now().getTime() - planStarted,
          counts: { steps: plan.steps.length, toolCalls: 0 },
          errorCode: "AI_SCOPE_DENIED"
        });
        return withTrace(
          await fail(deps, current, "AI_SCOPE_DENIED", scopeIssues.map((i) => i.detail).join("；"), now),
          trace
        );
      }
    } catch (error) {
      trace.push({
        kind: "plan",
        status: "failed",
        durationMs: now().getTime() - planStarted,
        errorCode: "AI_PLAN_INVALID"
      });
      return withTrace(await fail(deps, current, "AI_PLAN_INVALID", describe(error), now), trace);
    }
    trace.push({
      kind: "plan",
      status: "ok",
      durationMs: now().getTime() - planStarted,
      counts: { steps: plan.steps.length, requests: modelRequests }
    });

    // —— 有界顺序执行：每一步都是一次工具调用（失败与重复同样计数） ——
    const searchProvider = createSearchProvider({ archive: deps.context.archive, scope: readScope });
    const responses: (SearchResponse | undefined)[] = [];
    for (const [index, step] of plan.steps.entries()) {
      const executed = toolCalls + 1;
      if (executed > budgets.maxToolCalls) {
        return withTrace(
          await fail(
            deps,
            current,
            "AI_OVER_BUDGET",
            `工具调用超过 ${budgets.maxToolCalls} 次上限；请缩小整理范围。`,
            now
          ),
          trace
        );
      }
      toolCalls = executed;
      const stepStarted = now().getTime();
      try {
        if (step.tool === "search_pages") {
          const response = await searchProvider.searchWithReport(applyFrozenScope(step, input.scope));
          responses[index] = response;
          trace.push({
            kind: "search",
            status: "ok",
            durationMs: now().getTime() - stepStarted,
            counts: {
              step: executed,
              matches: response.results.length,
              totalMatches: response.totalMatches,
              truncated: response.truncated ? 1 : 0
            }
          });
        } else {
          const source = responses[step.fromStep];
          if (!source) {
            trace.push({
              kind: "read",
              status: "failed",
              durationMs: now().getTime() - stepStarted,
              counts: { step: executed },
              errorCode: "AI_PLAN_INVALID"
            });
            return withTrace(
              await fail(
                deps,
                current,
                "AI_PLAN_INVALID",
                `read 步骤引用的第 ${step.fromStep} 步没有可读取的检索结果。`,
                now
              ),
              trace
            );
          }
          const pending = source.results
            .map((result) => result.pageId)
            .filter((pageId) => !readIds.has(pageId));
          const remainingPages = budgets.maxReadPages - readPages.length;
          if (pending.length > remainingPages) {
            trace.push({
              kind: "read",
              status: "failed",
              durationMs: now().getTime() - stepStarted,
              counts: { step: executed, requested: pending.length },
              errorCode: "AI_OVER_BUDGET"
            });
            return withTrace(
              await fail(
                deps,
                current,
                "AI_OVER_BUDGET",
                `本次将读取 ${pending.length} 篇，超过剩余上限 ${remainingPages} 篇；` +
                  "不会静默少读，请缩小整理范围。",
                now
              ),
              trace
            );
          }
          /*
           * 读取：ID 来自本次检索结果，再由 Context 按 ID 重新核对**当前**范围与可见性；
           * 任何缺失/越界都整体失败，不做部分读取。
           */
          const readResult = await provider.getPages(pending, {
            scope: { ...readScope, maxPages: remainingPages }
          });
          /*
           超字符预算与「已不可见」必须分开报告：把超预算说成源消失会误导用户，
           而把源消失说成超预算会掩盖权限/删除。两者都不做部分读取。
          */
          const overBudget = readResult.missing.filter((item) => item.reason === "over-budget");
          if (overBudget.length > 0) {
            trace.push({
              kind: "read",
              status: "failed",
              durationMs: now().getTime() - stepStarted,
              counts: { step: executed, requested: pending.length },
              errorCode: "AI_OVER_BUDGET"
            });
            return withTrace(
              await fail(
                deps,
                current,
                "AI_OVER_BUDGET",
                `有 ${overBudget.length} 篇超出 ${budgets.maxReadChars} 字符读取预算；` +
                  "内容过多，请缩小整理范围。",
                now
              ),
              trace
            );
          }
          const vanishedCount =
            readResult.missing.filter((item) => item.reason !== "over-budget").length +
            readResult.skipped.length;
          if (vanishedCount > 0) {
            trace.push({
              kind: "read",
              status: "failed",
              durationMs: now().getTime() - stepStarted,
              counts: { step: executed, requested: pending.length },
              errorCode: "AI_SOURCE_CHANGED"
            });
            return withTrace(
              await fail(
                deps,
                current,
                "AI_SOURCE_CHANGED",
                `检索结果中有 ${vanishedCount} 篇在读取时已不可见（可能已删除、归档或移出范围）`,
                now
              ),
              trace
            );
          }
          const added = readResult.pages.reduce(
            (sum, page) => sum + page.title.length + page.text.length,
            0
          );
          if (readChars + added > budgets.maxReadChars) {
            trace.push({
              kind: "read",
              status: "failed",
              durationMs: now().getTime() - stepStarted,
              counts: { step: executed, requested: pending.length, chars: readChars + added },
              errorCode: "AI_OVER_BUDGET"
            });
            return withTrace(
              await fail(
                deps,
                current,
                "AI_OVER_BUDGET",
                `读取标题与正文将累计 ${readChars + added} 字符，超过 ${budgets.maxReadChars} 字符预算；` +
                  "内容过多，请缩小整理范围。",
                now
              ),
              trace
            );
          }
          readChars += added;
          for (const page of readResult.pages) {
            readPages.push(page);
            readIds.add(page.id);
          }
          trace.push({
            kind: "read",
            status: "ok",
            durationMs: now().getTime() - stepStarted,
            counts: {
              step: executed,
              pages: readResult.pages.length,
              readPages: readPages.length,
              readChars
            }
          });
        }
      } catch (error) {
        const stopped = await cancellationCheck();
        if (stopped) return stopped;
        const over = budgetFailure();
        const code = over?.code ?? (step.tool === "search_pages" ? "AI_SEARCH_FAILED" : "AI_CONTEXT_FAILED");
        trace.push({
          kind: step.tool === "search_pages" ? "search" : "read",
          status: "failed",
          durationMs: now().getTime() - stepStarted,
          counts: { step: executed },
          errorCode: code
        });
        return withTrace(await fail(deps, current, code, over?.detail ?? describe(error), now), trace);
      }
      // 每次 await 之后：取消 + 全部预算（含总耗时）
      const stoppedAfterStep = await cancellationCheck();
      if (stoppedAfterStep) return stoppedAfterStep;
      const overAfterStep = budgetFailure();
      if (overAfterStep) {
        return withTrace(
          await fail(deps, current, overAfterStep.code, overAfterStep.detail, now),
          trace
        );
      }
    }

    // —— 无结果：明确展示，不发起综合请求 ——
    if (readPages.length === 0) {
      const completed = transitionAiTask(
        current,
        "completed",
        { step: LIGHT_AGENT_STEPS.synthesize },
        now,
        current.revision
      );
      if (!completed.ok) {
        const afterCas = await cancellationCheck();
        if (afterCas) return afterCas;
        return {
          status: "failed",
          task: completed.current,
          detail: "任务状态在生成期间被改变。",
          code: "AI_TASK_RACE",
          trace
        };
      }
      try {
        await deps.ai.saveTask(completed.task, { expectedRevision: current.revision });
      } catch (error) {
        const afterFailure = await cancellationCheck();
        if (afterFailure) return afterFailure;
        return withTrace(await fail(deps, current, "AI_PERSIST_FAILED", describe(error), now), trace);
      }
      return {
        status: "empty",
        task: completed.task,
        detail: "本次范围内没有检索到需要整理的篇（只做了关键词与结构筛选）。",
        trace
      };
    }

    // —— 外发前核对来源（权威回读）：返回后先取消/预算，再处理业务错误 ——
    const beforeSend = await afterAuthoritativeRead(await reverifySources());
    if (beforeSend) return beforeSend;

    // —— 模型请求 2：结构化分组结果 ——
    let synthesisInput: string;
    try {
      synthesisInput = buildLightAgentSynthesisInput({
        goal: input.goal,
        scopeSummary: scopeSummary(input.scope, visiblePages),
        /*
         * R2：**只发已读取来源的正文**。未读取的检索结果只保留非内容计数与截断信息，
         * 不发送标题/摘要/候选片段——外发集合因此恰好等于已重验并绑定的读取集合。
         */
        searches: plan.steps.flatMap((step, index) => {
          const response = responses[index];
          if (step.tool !== "search_pages" || !response) return [];
          return [
            {
              step: index,
              matches: response.results.length,
              totalMatches: response.totalMatches,
              truncated: response.truncated,
              read: response.results.filter((result) => readIds.has(result.pageId)).length
            }
          ];
        }),
        pages: readPages
      });
    } catch (error) {
      return withTrace(await fail(deps, current, "AI_INPUT_TOO_LARGE", describe(error), now), trace);
    }
    if (synthesisInput.length > budgets.maxSynthInputChars) {
      return withTrace(
        await fail(
          deps,
          current,
          "AI_INPUT_TOO_LARGE",
          `综合输入超过 ${budgets.maxSynthInputChars} 字符预算；请缩小整理范围。`,
          now
        ),
        trace
      );
    }

    const synthStarted = now().getTime();
    const synthReservation = reserveModelRequest();
    if (synthReservation) {
      return withTrace(
        await fail(deps, current, synthReservation.code, synthReservation.detail, now),
        trace
      );
    }
    let synthResult;
    try {
      synthResult = await deps.callGateway({
        configId,
        task: "synthesize_collection",
        input: synthesisInput,
        signal: controller.signal
      });
    } catch (error) {
      const stopped = await cancellationCheck();
      if (stopped) return stopped;
      const over = budgetFailure();
      trace.push({
        kind: "synthesize",
        status: "failed",
        durationMs: now().getTime() - synthStarted,
        errorCode: over?.code ?? "AI_REQUEST_FAILED"
      });
      return withTrace(
        await fail(
          deps,
          current,
          over?.code ?? "AI_REQUEST_FAILED",
          over?.detail ?? describe(error),
          now
        ),
        trace
      );
    }
    const stoppedAfterSynth = await cancellationCheck();
    if (stoppedAfterSynth) return stoppedAfterSynth;
    const overAfterSynth = budgetFailure();
    if (overAfterSynth) {
      trace.push({
        kind: "synthesize",
        status: "failed",
        durationMs: now().getTime() - synthStarted,
        errorCode: overAfterSynth.code
      });
      return withTrace(
        await fail(deps, current, overAfterSynth.code, overAfterSynth.detail, now),
        trace
      );
    }
    if (!synthResult.ok) {
      trace.push({
        kind: "synthesize",
        status: "failed",
        durationMs: now().getTime() - synthStarted,
        errorCode: synthResult.code
      });
      if (synthResult.code === "AI_CANCELLED") return withTrace(await cancelTask(deps, current, now), trace);
      return withTrace(await fail(deps, current, synthResult.code, synthResult.detail, now), trace);
    }
    if (synthResult.content.length > budgets.maxSynthOutputChars) {
      trace.push({
        kind: "synthesize",
        status: "failed",
        durationMs: now().getTime() - synthStarted,
        errorCode: "AI_OUTPUT_TOO_LARGE"
      });
      return withTrace(
        await fail(
          deps,
          current,
          "AI_OUTPUT_TOO_LARGE",
          `综合输出超过 ${budgets.maxSynthOutputChars} 字符预算。`,
          now
        ),
        trace
      );
    }
    let parsed;
    try {
      parsed = parseLightAgentResult(synthResult.content, { allowedPageIds: readIds });
    } catch (error) {
      trace.push({
        kind: "synthesize",
        status: "failed",
        durationMs: now().getTime() - synthStarted,
        errorCode: "AI_RESULT_INVALID"
      });
      return withTrace(await fail(deps, current, "AI_RESULT_INVALID", describe(error), now), trace);
    }
    // 已通过 Schema 校验的结果：groups + ungroupedPageIds 恰好覆盖本次读取的 readIds。
    trace.push({
      kind: "synthesize",
      status: "ok",
      durationMs: now().getTime() - synthStarted,
      counts: { groups: parsed.groups.length, ungrouped: parsed.ungroupedPageIds.length }
    });

    // —— 保存前再次权威回读：返回后先取消/预算，再处理业务错误 ——
    const afterSynthCheck = await afterAuthoritativeRead(await reverifySources());
    if (afterSynthCheck) return afterSynthCheck;

    const sourceRefs: AiSourceRef[] = readPages.map((page) => ({
      kind: "page",
      id: page.id,
      blockIds: page.blocks.map((block) => block.blockId),
      sourceDigest: page.sourceDigest
    }));
    const payload: OrganizeCollectionPayload = {
      kind: "organize_collection",
      goal: input.goal,
      scope: input.scope,
      result: parsed
    };
    const proposalId = (deps.createId ?? defaultIdFactory("prop", now))();
    const draft: AiProposal = {
      id: proposalId,
      taskId: current.id,
      type: "organize_collection",
      status: "draft",
      revision: 0,
      sourceRefs,
      // 只读分组没有可写入的基线（与 P4 同一取舍）：源是否过期由读取时按 sourceDigest 判定。
      baselines: [],
      payload,
      createdAt: now().toISOString(),
      updatedAt: now().toISOString()
    };
    const previewed = previewProposal(draft, now);
    if (!previewed.ok) {
      return withTrace(
        await fail(deps, current, "AI_RESULT_REJECTED", "分组载荷不合法，已拒绝。", now),
        trace
      );
    }
    const completed = transitionAiTask(
      current,
      "completed",
      { proposalId, step: LIGHT_AGENT_STEPS.done },
      now,
      current.revision
    );
    if (!completed.ok) {
      const afterCas = await cancellationCheck();
      if (afterCas) return afterCas;
      return {
        status: "failed",
        task: completed.current,
        detail: "任务状态在生成期间被改变。",
        code: "AI_TASK_RACE",
        trace
      };
    }
    try {
      await deps.ai.saveTaskWithProposal({
        task: completed.task,
        proposal: previewed.proposal,
        expectedRevision: current.revision
      });
    } catch (error) {
      const afterFailure = await cancellationCheck();
      if (afterFailure) return afterFailure;
      return withTrace(await fail(deps, current, "AI_PERSIST_FAILED", describe(error), now), trace);
    }

    return {
      status: "completed",
      task: completed.task,
      proposal: previewed.proposal,
      readCount: readPages.length,
      gateway: { model: synthResult.model, configId: synthResult.configId },
      trace
    };
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onExternalAbort);
  }
}

function withTrace<T extends { status: string }>(
  outcome: T,
  trace: LightAgentTraceStep[]
): T & { trace: LightAgentTraceStep[] } {
  return { ...outcome, trace };
}

export type CollectionSourceCheck = {
  pageId: string;
  title: string;
  state: "fresh" | "stale" | "unavailable";
};

/**
 * R3：按**提案冻结范围**核对来源（只读，不改任何东西）。
 *
 * 复用 `createSearchProvider().eligiblePages`：可见性 + 结构过滤（本/地区/旅行/地点/时间）
 * 只有那一处实现，P8 不再写第二套规则。判定：
 * - 不可见、或已不满足冻结范围（移本、时间越界、旅行/地点关系解除、地区不符）→ `unavailable`；
 * - 仍在范围内但 `sourceDigest` 变化 → `stale`；否则 `fresh`。
 *
 * `scope` 为 `null` 时（非 organize_collection 载荷）只核对可见性。
 */
export async function checkCollectionSources(
  refs: readonly { id: string; sourceDigest: string; title?: string }[],
  options: { archive: ArchiveCore; scope: CollectionScope | null }
): Promise<CollectionSourceCheck[]> {
  if (refs.length === 0) return [];
  const scope = options.scope;
  const eligible = new Map(
    (
      await createSearchProvider({ archive: options.archive }).eligiblePages({
        ...(scope?.notebookIds ? { notebookIds: scope.notebookIds } : {}),
        ...(scope?.regionIds ? { regionIds: scope.regionIds } : {}),
        ...(scope?.tripIds ? { tripIds: scope.tripIds } : {}),
        ...(scope?.placeIds ? { placeIds: scope.placeIds } : {}),
        ...(scope?.from ? { from: scope.from } : {}),
        ...(scope?.to ? { to: scope.to } : {})
      })
    ).map((result) => [result.pageId, result] as const)
  );
  return refs.map((ref) => {
    const hit = eligible.get(ref.id);
    if (!hit) {
      return {
        pageId: ref.id,
        title: ref.title ?? "(已不可用)",
        state: "unavailable" as const
      };
    }
    return {
      pageId: ref.id,
      title: hit.title,
      state: hit.sourceDigest === ref.sourceDigest ? ("fresh" as const) : ("stale" as const)
    };
  });
}

/**
 * 来源权威回读：只读、不修改任何东西。
 * 返回 null 表示一致；否则给出失败码与说明。
 * 不提供 `loadArchive` 时按注入快照核对（仍然核对可见性与摘要在冻结范围内的资格）。
 */
async function verifySources(
  deps: OrganizeCollectionDeps,
  pages: readonly AiPageContext[],
  scope: CollectionScope | null
): Promise<{ code: string; detail: string } | null> {
  let archive: ArchiveCore;
  try {
    archive = deps.loadArchive ? await deps.loadArchive() : deps.context.archive;
  } catch (error) {
    return { code: "AI_CONTEXT_FAILED", detail: `读取已保存手帐失败：${describe(error)}` };
  }
  const checks = await checkCollectionSources(
    pages.map((page) => ({ id: page.id, sourceDigest: page.sourceDigest, title: page.title })),
    { archive, scope }
  );
  for (const check of checks) {
    if (check.state === "unavailable") {
      return {
        code: "AI_SOURCE_UNAVAILABLE",
        detail: `篇《${check.title}》已删除或已不在本次冻结范围内：本次结果不可用，也不会展示旧派生内容。`
      };
    }
    if (check.state === "stale") {
      return {
        code: "AI_SOURCE_CHANGED",
        detail: `篇《${check.title}》的内容已变化：本次结果已过期，请重新整理。`
      };
    }
  }
  return null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 与 P4 同一套共享取消判定 → 本 runner 的结果（已终态只如实转述，不改写）。 */
function cancellationOutcome(
  decision: TaskCancellationDecision,
  trace: LightAgentTraceStep[]
): OrganizeCollectionOutcome | null {
  if (decision.kind === "continue") return null;
  if (decision.kind === "cancelled") return { status: "cancelled", task: decision.task, trace };
  if (decision.status === "cancelled") return { status: "cancelled", task: decision.task, trace };
  return { status: "not-run", task: decision.task, reason: "stale-revision" };
}
