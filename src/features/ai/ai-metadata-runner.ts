/**
 * P5：单篇派生元数据生成（generate_page_metadata）的有限步骤执行。
 *
 * 步骤固定：读 Context（单篇全文）→ 冻结摘要核对 → 预算 → Gateway → 结果校验 →
 * 写 `pageMetadata`（AI 独立库）+ 任务终态。
 *
 * 只写派生数据：不写正文、媒体、业务收据，也不建索引。删除整个 AI 库不影响正文，
 * 搜索会退化到关键词并明确说明主题能力不可用（由调用方报告）。
 *
 * 迟到的保护：写入前**重新读取**该篇并核对摘要；源已变化则失败且不写 metadata，
 * 因此旧结果不会以“当前有效”的身份落库（写入后源再变化则由读取端按摘要派生 stale）。
 */
import {
  createAiContextProvider,
  createAiReadScope,
  mergeAiReadScope,
  type AiContextProviderOptions,
  type AiReadScope
} from "./ai-context";
import { parsePageMetadataResult } from "./ai-metadata-result-schema";
import type { AiPageMetadata, AiRepository } from "./ai-repository";
import { transitionAiTask, type AiTask, type GeneratePageMetadataTaskInput } from "./ai-task";
import { buildPageMetadataInput, PAGE_METADATA_PROMPT } from "./prompts/page-metadata";
import type { AiGatewayCaller, AiGatewayTask } from "./ai-gateway-client";
import { cancelTask, checkTaskCancellation, fail, type TaskCancellationDecision } from "./ai-task-runner";

export const PAGE_METADATA_BUDGETS = {
  maxInputChars: 20_000,
  maxOutputChars: 4_000
} as const;

export type GeneratePageMetadataDeps = {
  context: AiContextProviderOptions;
  ai: AiRepository;
  callGateway: AiGatewayCaller;
  selectConfig: () => string;
  scope?: Partial<AiReadScope>;
  now?: () => Date;
  budgets?: { maxInputChars?: number; maxOutputChars?: number };
  signal?: AbortSignal;
  /**
   * R6：提交前的**权威档案回读**（例如 `notebookRepository.loadArchive()`）。
   *
   * 存在的理由：`context.archive` 是创建时捕获的快照，请求期间仓库可能已被删除/改写。
   * 提供时，写入前会用最新档案重建 Context 重新核对可见性与摘要；
   * 未提供时退化为只读初始快照（调用方应始终提供；P5 hook 已提供）。
   * 注意：跨库回读不是跨库原子事务——它只让“旧结果不写成当前有效”，不承诺并发事务隔离。
   */
  loadArchive?: () => Promise<AiContextProviderOptions["archive"]>;
};

export type GeneratePageMetadataOutcome =
  | { status: "completed"; task: AiTask; metadata: AiPageMetadata }
  | { status: "failed"; task: AiTask; detail: string; code: string }
  | { status: "cancelled"; task: AiTask }
  | { status: "not-run"; task: AiTask; reason: "invalid-transition" | "stale-revision" };

export async function runGeneratePageMetadataTask(
  deps: GeneratePageMetadataDeps,
  task: AiTask
): Promise<GeneratePageMetadataOutcome> {
  const now = deps.now ?? (() => new Date());
  const maxInputChars = deps.budgets?.maxInputChars ?? PAGE_METADATA_BUDGETS.maxInputChars;
  const maxOutputChars = deps.budgets?.maxOutputChars ?? PAGE_METADATA_BUDGETS.maxOutputChars;

  if (task.type !== "generate_page_metadata") {
    return { status: "not-run", task, reason: "invalid-transition" };
  }
  const input = task.input as GeneratePageMetadataTaskInput;

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

  /** R2：取消/迟到检查（信号 + 持久状态），上游把 abort 当成功返回时也必须停下。 */
  const cancellationCheck = async (): Promise<GeneratePageMetadataOutcome | null> => {
    const decision = await checkTaskCancellation(deps, current, now);
    return cancellationOutcome(decision);
  };
  // 用**收窄后**的 scope 读取：方法级/任务级都不能扩大范围或预算。
  const scope = mergeAiReadScope(createAiReadScope(deps.scope), deps.context.scope);
  const stoppedAtStart = await cancellationCheck();
  if (stoppedAtStart) return stoppedAtStart;

  const provider = createAiContextProvider(deps.context);

  let page;
  try {
    page = await provider.getPage(input.pageId, { scope });
  } catch (error) {
    return await fail(deps, current, "AI_CONTEXT_FAILED", describe(error), now);
  }
  if (!page) {
    return await fail(deps, current, "AI_SOURCE_UNAVAILABLE", "目标篇不存在或不可读。", now);
  }
  if (page.sourceDigest !== input.sourceDigest) {
    return await fail(deps, current, "AI_SOURCE_CHANGED", "源内容已变化，请重新生成。", now);
  }

  let promptInput: string;
  let configId: string;
  try {
    promptInput = buildPageMetadataInput(page);
    if (promptInput.length > maxInputChars) {
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

  // 发请求前再核对一次：已取消就不发（零请求）。
  const beforeRequest = await cancellationCheck();
  if (beforeRequest) return beforeRequest;

  let result;
  try {
    result = await deps.callGateway({
      configId,
      task: "generate_page_metadata" satisfies AiGatewayTask,
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

  let parsed;
  try {
    parsed = parsePageMetadataResult(result.content);
  } catch (error) {
    return await fail(deps, current, "AI_RESULT_INVALID", describe(error), now);
  }

  /*
   * R6：写入前**通过权威仓库回读**并重建 Context 重新核对。
   *
   * 不用创建时捕获的 archive 快照、不依赖 React 重渲染、不依赖对象原地修改：
   * 请求期间源被删除/归档/改写时，旧结果不得写成“当前有效”。
   * 跨库回读只保证“旧结果不落库”，不等于跨库原子事务（不引入锁/心跳/租约）。
   */
  let freshContext: AiContextProviderOptions = deps.context;
  if (deps.loadArchive) {
    try {
      freshContext = { ...deps.context, archive: await deps.loadArchive() };
    } catch (error) {
      return await fail(deps, current, "AI_CONTEXT_FAILED", describe(error), now);
    }
  }
  const afterReload = await cancellationCheck();
  if (afterReload) return afterReload;

  let recheck;
  try {
    recheck = await createAiContextProvider(freshContext).getPage(input.pageId, { scope });
  } catch (error) {
    return await fail(deps, current, "AI_CONTEXT_FAILED", describe(error), now);
  }
  if (!recheck) {
    return await fail(deps, current, "AI_SOURCE_UNAVAILABLE", "目标篇已不可读。", now);
  }
  if (recheck.sourceDigest !== input.sourceDigest) {
    return await fail(
      deps,
      current,
      "AI_SOURCE_CHANGED",
      "源内容在生成期间已变化，未写入主题标签。",
      now
    );
  }

  const beforePersist = await cancellationCheck();
  if (beforePersist) return beforePersist;

  const metadata: AiPageMetadata = {
    pageId: page.id,
    ...(parsed.summary !== undefined ? { summary: parsed.summary } : {}),
    topics: parsed.topics,
    sourceDigest: input.sourceDigest,
    model: result.model,
    promptId: PAGE_METADATA_PROMPT.id,
    promptVersion: PAGE_METADATA_PROMPT.version,
    generatedAt: now().toISOString()
  };
  const completed = transitionAiTask(current, "completed", { step: 2 }, now, current.revision);
  if (!completed.ok) {
    return {
      status: "failed",
      task: completed.current,
      detail: "任务状态在生成期间被改变。",
      code: "AI_TASK_RACE"
    };
  }

  /*
   * R5：任务终态与 metadata 在**同一个 AI 库事务**内提交（`saveTaskWithMetadata`）。
   * - 提交成功 = 两者都在 → completed 是真实的；
   * - 提交失败 = 两者都不在（不删已写内容，也不留下“completed 但状态仍旧”的谎报）→ 明确失败，
   *   并回读真实任务状态告诉调用方。任务被判为已完成/取消时事务内的守卫会拒绝覆盖。
   */
  try {
    await deps.ai.saveTaskWithMetadata({
      task: completed.task,
      metadata,
      expectedRevision: current.revision
    });
  } catch (error) {
    const afterFailure = await cancellationCheck();
    if (afterFailure) return afterFailure;
    const stored = await deps.ai.getTask(current.id).catch(() => null);
    return await fail(
      deps,
      current,
      "AI_PERSIST_FAILED",
      `主题标签与任务终态未能一起写入（草稿未保存）：${describe(error)}；` +
        `当前任务状态：${stored?.status ?? "unknown"}。可显式重试。`,
      now
    );
  }

  return { status: "completed", task: completed.task, metadata };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * R2：共享取消判定 → 本 runner 的结果。
 * `already-settled` 表示别的路径已推进到终态：不改写，只如实转述。
 */
function cancellationOutcome(
  decision: TaskCancellationDecision
): GeneratePageMetadataOutcome | null {
  if (decision.kind === "continue") return null;
  if (decision.kind === "cancelled") return { status: "cancelled", task: decision.task };
  if (decision.status === "cancelled") return { status: "cancelled", task: decision.task };
  return { status: "not-run", task: decision.task, reason: "stale-revision" };
}
