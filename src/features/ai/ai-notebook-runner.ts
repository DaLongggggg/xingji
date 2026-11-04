/**
 * P4：普通有限步骤任务执行（analyze_notebook）——**只读**本册分析。
 *
 * 步骤固定、数量有限：读 Context（本册可见篇）→ 冻结来源核对 → 预算 →
 * 拼 Prompt → 请求 Gateway → 结果校验 → 落一条只读 Proposal。
 * 不建 Agent Runtime、不建步骤引擎、不自动重试；取消与迟到结果由任务状态保护，
 * 落库复用 `saveTaskWithProposal` 的同库原子写。
 *
 * 只读承诺：本文件没有业务写路径。分析结果进入 AI 独立库的 proposals
 * （status=draft，没有 accepted/applied 语义），不会写正文、媒体或业务收据。
 *
 * R4 边界：本文件属于**浏览器侧**，不导入任何 `src/server/**`；模型调用只经注入的
 * `callGateway`（生产为 `/api/ai/generate` 的最小请求函数）。模型配置由调用方显式选择。
 */
import {
  createAiContextProvider,
  createAiReadScope,
  mergeAiReadScope,
  narrowNotebookScope,
  narrowScopeToNotebook,
  notebookSourceDigest,
  type AiContextProvider,
  type AiContextProviderOptions,
  type AiPageContext,
  type AiReadScope
} from "./ai-context";
import {
  parseNotebookAnalysisResult,
  type NotebookAnalysisResult
} from "./ai-notebook-result-schema";
import {
  previewProposal,
  type AiProposal,
  type AiSourceRef,
  type AnalyzeNotebookPayload
} from "./ai-proposal";
import type { AiRepository } from "./ai-repository";
import { transitionAiTask, type AiTask, type AnalyzeNotebookTaskInput } from "./ai-task";
import {
  buildNotebookAnalysisInput
} from "./prompts/notebook-analysis";
import type { AiGatewayCaller, AiGatewayTask } from "./ai-gateway-client";
import {
  cancelTask,
  checkTaskCancellation,
  defaultIdFactory,
  fail,
  type TaskCancellationDecision
} from "./ai-task-runner";

export const NOTEBOOK_ANALYSIS_BUDGETS = {
  /** 送入模型的输入字符上限（与服务端 GATEWAY_LIMITS.maxInputChars 取较小值生效）。 */
  maxInputChars: 50_000,
  /** 期望输出字符上限；超过即视为结果异常。 */
  maxOutputChars: 16_000,
  /**
   * 本册正文读入预算（字符）。整本分析比单篇需要更多输入，但仍必须有明确上限：
   * 超过就**拒绝并要求缩小范围**，绝不截断后声称“整本总结”。
   * 留出块身份等元数据的余量，取值小于 maxInputChars。
   */
  maxTotalTextChars: 30_000
} as const;

/**
 * 本册分析的读入门槛：任务范围上限与阶段预算取较小值。
 * hook 的预检与 runner 的强制检查共用这一个函数，避免两处各说一套。
 */
export function notebookAnalysisGate(scope: AiReadScope): {
  maxPages: number;
  maxTextChars: number;
} {
  return {
    maxPages: scope.maxPages,
    maxTextChars: Math.min(scope.maxTotalTextChars, NOTEBOOK_ANALYSIS_BUDGETS.maxTotalTextChars)
  };
}

export type AnalyzeNotebookDeps = {
  /** 领域快照与媒体元数据（只读）。 */
  context: AiContextProviderOptions;
  ai: AiRepository;
  callGateway: AiGatewayCaller;
  /** 本任务使用的模型配置 ID；必须显式给出，不在这里取列表第一项。 */
  selectConfig: () => string;
  scope?: Partial<AiReadScope>;
  now?: () => Date;
  createId?: () => string;
  budgets?: { maxInputChars?: number; maxOutputChars?: number };
  signal?: AbortSignal;
};

/** 覆盖范围：实际读入/未读入的篇数与原因，必须如实上报。 */
export type AnalyzeNotebookCoverage = {
  /** 当前本可见篇总数（分母）。 */
  totalVisible: number;
  /** 实际读入篇数；成功执行时等于 totalVisible。 */
  included: number;
  missing: { pageId: string; reason: string }[];
  skipped: string[];
};

export type AnalyzeNotebookOutcome =
  | {
      status: "completed";
      task: AiTask;
      proposal: AiProposal;
      coverage: AnalyzeNotebookCoverage;
      gateway: { model: string; configId: string };
    }
  | { status: "failed"; task: AiTask; detail: string; code: string }
  | { status: "cancelled"; task: AiTask }
  | { status: "not-run"; task: AiTask; reason: "invalid-transition" | "stale-revision" };

function frozenSources(input: AnalyzeNotebookTaskInput) {
  return input.sources;
}

/**
 * 冻结来源与当前可见状态的一致性核对。
 * 返回 null 表示一致；否则给出失败码与说明（不静默部分读取）。
 */
function compareSources(
  input: AnalyzeNotebookTaskInput,
  notebookTitle: string,
  currentPages: AiPageContext[]
): { code: string; detail: string } | null {
  const frozen = frozenSources(input);
  if (currentPages.length === 0) {
    return { code: "AI_NOTEBOOK_EMPTY", detail: "这一本当前没有可读取的手帐篇。" };
  }
  const currentDigest = notebookSourceDigest({ title: notebookTitle }, currentPages.map((p) => p.id));
  if (currentDigest !== input.notebookDigest) {
    return {
      code: "AI_SOURCE_CHANGED",
      detail: "本册成员或标题在生成前已变化，请重新发起分析。"
    };
  }
  if (currentPages.length !== frozen.length) {
    return {
      code: "AI_SOURCE_CHANGED",
      detail: `冻结来源 ${frozen.length} 篇与当前 ${currentPages.length} 篇不一致，请重新发起分析。`
    };
  }
  for (const [index, source] of frozen.entries()) {
    const page = currentPages[index];
    if (page.id !== source.pageId) {
      return { code: "AI_SOURCE_CHANGED", detail: "来源顺序已变化，请重新发起分析。" };
    }
    if (page.sourceDigest !== source.sourceDigest) {
      return {
        code: "AI_SOURCE_CHANGED",
        detail: `篇《${page.title}》内容在生成后已变化，请重新发起分析。`
      };
    }
  }
  return null;
}

function textBudget(scope: AiReadScope, pages: readonly AiPageContext[]) {
  const gate = notebookAnalysisGate(scope);
  const totalChars = pages.reduce((sum, page) => sum + page.text.length, 0);
  if (pages.length > gate.maxPages) {
    return {
      code: "AI_OVER_BUDGET",
      detail: `本册有 ${pages.length} 篇，超过单次分析上限 ${gate.maxPages} 篇；请缩小范围（分批）后再试。`
    };
  }
  if (totalChars > gate.maxTextChars) {
    return {
      code: "AI_OVER_BUDGET",
      detail:
        `本册正文共 ${totalChars} 字，超过单次分析预算 ${gate.maxTextChars} 字；` +
        "内容过多，请缩小范围后分批分析。"
    };
  }
  return null;
}

/**
 * 执行一次 analyze_notebook。
 * `task` 必须是 queued（或由调用方先显式重试成 queued）；running/终态不会被本函数接管。
 */
export async function runAnalyzeNotebookTask(
  deps: AnalyzeNotebookDeps,
  task: AiTask
): Promise<AnalyzeNotebookOutcome> {
  const now = deps.now ?? (() => new Date());
  const maxInputChars = deps.budgets?.maxInputChars ?? NOTEBOOK_ANALYSIS_BUDGETS.maxInputChars;
  const maxOutputChars = deps.budgets?.maxOutputChars ?? NOTEBOOK_ANALYSIS_BUDGETS.maxOutputChars;

  if (task.type !== "analyze_notebook") {
    return { status: "not-run", task, reason: "invalid-transition" };
  }
  const input = task.input;
  /*
   * R1：范围只能**求交集**，不能覆盖。
   * 三层来源：Context 默认范围、调用方任务范围、任务目标本；任何一层不允许目标本，
   * 都必须在发出模型请求之前明确失败（零请求），也不得抬高预算或放宽可见性。
   */
  const declaredScope = createAiReadScope(deps.scope);
  const contextScope = createAiReadScope(deps.context.scope);
  const authorizedNotebooks = narrowNotebookScope(
    contextScope.notebookIds,
    declaredScope.notebookIds
  );
  const targetNotebooks = narrowScopeToNotebook(authorizedNotebooks, input.notebookId);
  const scope =
    targetNotebooks === null
      ? mergeAiReadScope(declaredScope, contextScope)
      : mergeAiReadScope(mergeAiReadScope(declaredScope, contextScope), {
          notebookIds: targetNotebooks
        });

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
   * R2：取消/迟到检查。检查**信号 + 持久状态**，不只是任务状态。
   * 上游即使把 abort 后的响应当成成功返回，也必须在这里停下；
   * 已是终态的任务只如实报告，绝不改写。
   */
  const cancellationCheck = async (): Promise<AnalyzeNotebookOutcome | null> => {
    const decision = await checkTaskCancellation(deps, current, now);
    return cancellationOutcome(decision);
  };

  const stoppedAtStart = await cancellationCheck();
  if (stoppedAtStart) return stoppedAtStart;

  /*
   * R1：目标本必须在三层范围的交集内。这里显式拒绝，保证零模型请求，
   * 也让“调用方不允许这个本”与“本不存在”有各自明确的结果。
   */
  if (targetNotebooks === null) {
    return await fail(
      deps,
      current,
      "AI_SCOPE_DENIED",
      `目标手帐本 ${input.notebookId} 不在本次允许的读取范围内；未读取任何内容、未发出模型请求。`,
      now
    );
  }

  // —— 1) 读取当前本册可见篇（只读，含完整正文与摘要） ——
  let provider: AiContextProvider;
  let notebookTitle = "";
  let visiblePages: AiPageContext[] = [];
  try {
    provider = createAiContextProvider(deps.context);
    const notebooks = await provider.listNotebooks({ scope });
    const notebook = notebooks.find((item) => item.id === input.notebookId);
    if (!notebook) {
      return await fail(
        deps,
        current,
        "AI_NOTEBOOK_UNAVAILABLE",
        "目标手帐本不存在、已删除或不在允许范围内。",
        now
      );
    }
    notebookTitle = notebook.title;
    visiblePages = await provider.listNotebookPages(input.notebookId, { scope });
  } catch (error) {
    return await fail(deps, current, "AI_CONTEXT_FAILED", describe(error), now);
  }

  // —— 2) 冻结来源核对 + 预算（两者都在任何模型请求之前） ——
  const changed = compareSources(input, notebookTitle, visiblePages);
  if (changed) {
    return await fail(deps, current, changed.code, changed.detail, now);
  }
  const overBudget = textBudget(scope, visiblePages);
  if (overBudget) {
    return await fail(deps, current, overBudget.code, overBudget.detail, now);
  }
  const frozenIds = new Set(input.sources.map((source) => source.pageId));
  // `listNotebookPages` 已按可见性过滤；这里再确认每篇都在冻结集合内（不做范围外读取）。
  const outOfScope = visiblePages.filter((page) => !frozenIds.has(page.id));
  if (outOfScope.length > 0) {
    return await fail(
      deps,
      current,
      "AI_SOURCE_CHANGED",
      `出现冻结来源之外的篇（${outOfScope.map((page) => page.id).join(",")}），请重新发起分析。`,
      now
    );
  }
  const coverage: AnalyzeNotebookCoverage = {
    totalVisible: visiblePages.length,
    included: visiblePages.length,
    missing: [],
    skipped: []
  };

  let promptInput: string;
  let configId: string;
  try {
    promptInput = buildNotebookAnalysisInput({
      notebookId: input.notebookId,
      notebookTitle,
      notebookDigest: input.notebookDigest,
      pages: visiblePages
    });
    if (promptInput.length > maxInputChars) {
      return await fail(
        deps,
        current,
        "AI_INPUT_TOO_LARGE",
        `输入超过 ${maxInputChars} 字符预算；请缩小范围（分批）后再试。`,
        now
      );
    }
    configId = deps.selectConfig();
  } catch (error) {
    return await fail(deps, current, "AI_CONFIG_UNAVAILABLE", describe(error), now);
  }

  // 发请求前再核对一次：已取消就不发（零请求）。
  const beforeRequest = await cancellationCheck();
  if (beforeRequest) return beforeRequest;

  let result;
  try {
    result = await deps.callGateway({
      configId,
      task: "analyze_notebook" satisfies AiGatewayTask,
      input: promptInput,
      ...(deps.signal ? { signal: deps.signal } : {})
    });
  } catch (error) {
    const cancelled = await cancellationCheck();
    if (cancelled) return cancelled;
    return await fail(deps, current, "AI_REQUEST_FAILED", describe(error), now);
  }

  // 响应后立即核对信号与状态：上游忽略取消而返回成功时也不能继续。
  const afterResponse = await cancellationCheck();
  if (afterResponse) return afterResponse;

  if (!result.ok) {
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

  // —— 3) 结果校验：结构 + 上限 + 引用必须属于冻结来源 ——
  let parsed: NotebookAnalysisResult;
  try {
    parsed = parseNotebookAnalysisResult(result.content, {
      allowedPageIds: frozenIds,
      allowedBlockIds: new Set(visiblePages.flatMap((page) => page.blocks.map((b) => b.blockId)))
    });
  } catch (error) {
    return await fail(deps, current, "AI_RESULT_INVALID", describe(error), now);
  }

  // 落库前的取消检查：响应后、建议写入前的取消/清空不能留下孤立建议。
  const beforePersist = await cancellationCheck();
  if (beforePersist) return beforePersist;

  const sourceRefs: AiSourceRef[] = visiblePages.map((page) => ({
    kind: "page",
    id: page.id,
    blockIds: page.blocks.map((block) => block.blockId),
    sourceDigest: page.sourceDigest
  }));
  const payload: AnalyzeNotebookPayload = {
    kind: "analyze_notebook",
    notebookId: input.notebookId,
    result: parsed
  };

  const proposalId = (deps.createId ?? defaultIdFactory("prop", now))();
  const draft: AiProposal = {
    id: proposalId,
    taskId: current.id,
    type: "analyze_notebook",
    status: "draft",
    revision: 0,
    sourceRefs,
    /*
     * 只读分析没有可写入的基线：不填占位摘要（`PageBaseline` 的用途是编辑冲突，
     * 本阶段不消费它）。源是否过期由读取时按 sourceRefs 的 sourceDigest 重新判定。
     */
    baselines: [],
    payload,
    createdAt: now().toISOString(),
    updatedAt: now().toISOString()
  };
  // 冻结预览：载荷身份（payloadDigest + previewedAt）在写入前确定。
  const previewed = previewProposal(draft, now);
  if (!previewed.ok) {
    return await fail(deps, current, "AI_RESULT_REJECTED", "分析载荷不合法，已拒绝。", now);
  }
  const proposal = previewed.proposal;

  const completed = transitionAiTask(
    current,
    "completed",
    { proposalId, step: 2 },
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
      code: "AI_TASK_RACE"
    };
  }

  /*
   * 与 organize_page 同一原子写契约：任务 completed 与建议同时存在，
   * 事务失败则两者都不在；任务身份用 revision 条件，终态不可被降级。
   */
  try {
    await deps.ai.saveTaskWithProposal({
      task: completed.task,
      proposal,
      expectedRevision: current.revision
    });
  } catch (error) {
    const afterFailure = await cancellationCheck();
    if (afterFailure) return afterFailure;
    return await fail(deps, current, "AI_PERSIST_FAILED", describe(error), now);
  }

  return {
    status: "completed",
    task: completed.task,
    proposal,
    coverage,
    gateway: { model: result.model, configId: result.configId }
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * R2：把共享取消判定映射为本 runner 的结果。
 * `already-settled` 表示别的路径已把任务推进到终态：本 runner 不改写，只如实转述。
 */
function cancellationOutcome(
  decision: TaskCancellationDecision
): AnalyzeNotebookOutcome | null {
  if (decision.kind === "continue") return null;
  if (decision.kind === "cancelled") return { status: "cancelled", task: decision.task };
  if (decision.status === "cancelled") return { status: "cancelled", task: decision.task };
  return { status: "not-run", task: decision.task, reason: "stale-revision" };
}
