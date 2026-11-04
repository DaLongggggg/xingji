/**
 * ReAct Agent 循环（对应增量任务书 §4）。
 *
 * 形状最像 `s_full.py` 的 `agent_loop`，但边界完全不同：
 * - 只有受控资料/Skill/图片读取与制图工具，没有 shell、文件系统与任意命令；
 * - 步数、墙钟、单结果长度都有硬上限，超限以 `done.reason="limit"|"timeout"` 收束；
 * - 工具输出按**不可信数据**回灌给模型（明确标注为资料，不是指令），并且只保留配对骨架；
 * - 图片任务进入执行后直接交付，不再回到规划；写入笔记仍需用户确认。
 *
 * 依赖全部注入，便于隔离测试：`plan` 是一轮结构化决策，`answer` 是流式最终回答。
 */
import type { WorkbenchStreamEvent } from "@/features/ai/stream-events";
import { IMAGE_EXECUTION_BUDGET } from "@/features/ai/image-execution-contract";
import { checkWorkbenchToolArgs, executeTool, type ToolDeps, type ToolOutcome } from "./workbench-tools";
import { clipNativeSearchContent } from "@/features/ai/native-search-contract";
import { createCaptureId } from "@/features/capture/capture-model";

export type AgentToolDescriptor = { name: string; description: string; available?: boolean };

export type AgentLimits = {
  /** 计划轮数上限；默认与硬上限都是 10。 */
  maxSteps: number;
  /**
   * 决策阶段的墙钟上限（毫秒）。R1（C3）起**只覆盖规划/取资料**：
   * 任务交给图片执行器后决策期限结束，执行预算由统一执行器自带；
   * 交付后的结果说明轮有独立的 `answerDeadlineMs`。
   */
  deadlineMs: number;
  /** 交付后回答/说明阶段的墙钟上限（毫秒）。 */
  answerDeadlineMs?: number;
  /** 单条工具结果回灌给模型的最大字符数。 */
  resultChars: number;
};

/**
 * 默认预算（C3：决策轮数与图片数量分开）。
 * - 决策：最多 10 次模型请求（maxSteps），墙钟按「10 × Ttext + 60 秒」派生；
 * - 执行：交给统一图片执行器，预算 = `batchImageDeadlineMs(N)`（每项最多一次图片调用、
 *   两次提示准备请求，整批说明最多一次），不再用整轮墙钟覆盖执行；
 * - 说明：交付后最多一次对话请求 + 保存屏障，按 `Ttext + Tsave + 30 秒` 收束。
 */
export const HARD_MAX_STEPS = 10;
export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  maxSteps: HARD_MAX_STEPS,
  deadlineMs: IMAGE_EXECUTION_BUDGET.textRequestMs * HARD_MAX_STEPS + 60_000,
  answerDeadlineMs: IMAGE_EXECUTION_BUDGET.textRequestMs + IMAGE_EXECUTION_BUDGET.saveBarrierMs + 30_000,
  resultChars: 4_000
};

/** Planning selects a tool or enters the one final-answer request; it never generates the answer body. */
export type AgentDecision =
  | { action: "tool"; tool: string; args: Record<string, unknown>; summary?: string }
  | { action: "respond"; summary?: string; imageAdvice?: import("./workbench-types").ImageAdvice };

/** Shared strict decision validation for browser and durable task hosts; sources remain caller-authorized. */
export async function parseWorkbenchDecision(parsed: unknown, adviceDigest?: (sourceId: string) => Promise<string>): Promise<AgentDecision> {
  /*
     * 决策必须**严格**校验：缺工具名、动作不认识、args 不是对象都不能当成 final——
     * 那会把“本来要出图但没做成”伪装成一段文字回答（本轮修复的正是这个）。
     */
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("规划结果不是 JSON 对象，本次未执行任何操作。");
    const decision = parsed as { action?: unknown; tool?: unknown; args?: unknown; summary?: unknown; title?: unknown; body?: unknown; imageAdvice?: unknown };
    const explanation = typeof decision.summary === "string" && decision.summary.trim()
      ? { summary: decision.summary.trim().slice(0, 240) } : {};
    const args = decision.args;
    if (args !== undefined && args !== null && (typeof args !== "object" || args === null || Array.isArray(args)))
      throw new Error("规划结果的 args 必须是对象，本次未执行任何操作。");
    const argumentObject = (args ?? {}) as Record<string, unknown>;
    if (decision.action === "tool") {
      if (typeof decision.tool !== "string" || !decision.tool.trim())
        throw new Error("规划结果缺少工具名，本次未执行任何操作。");
      return { action: "tool", tool: decision.tool, args: argumentObject, ...explanation };
    }
    if (decision.action === "respond") {
      if (Object.keys(parsed).some(key => !["action", "summary", "imageAdvice"].includes(key)))
        throw new Error("respond 只允许进入回答及结构化建议，不接受规划正文或旧字段。");
      let imageAdvice: import("./workbench-types").ImageAdvice | undefined;
      if (decision.imageAdvice != null) {
        const advice = decision.imageAdvice as { items?: unknown };
        const checked = checkWorkbenchToolArgs("create_artwork", { mode: "edit", items: advice.items });
        if (!checked.ok) throw new Error(`图片建议结构无效：${checked.detail}`);
        const items = checked.args.items as { sourceId: string; instruction: string }[];
        imageAdvice = { items: await Promise.all(items.map(async item => {
          if (!adviceDigest) throw new Error("图片建议引用了本轮不可用的来源，本次未执行制图。");
          return { ...item, sourceDigest: await adviceDigest(item.sourceId) };
        })) };
      }
      return {
        action: "respond",
        ...(imageAdvice ? { imageAdvice } : {}),
        ...explanation
      };
    }
    throw new Error(`规划结果的动作不受支持（${JSON.stringify(decision.action)?.slice(0, 40) ?? "缺失"}），本次未执行任何操作。`);
}

export type AgentPlanInput = {
  /** 用户原始要求 + 已固化的范围/引用上下文。 */
  task: string;
  /** 之前几轮的观察记录（成功为截断正文，失败为简短原因）。 */
  observations: { tool: string; ok: boolean; content: string }[];
  repair?: { tool: string; args: Record<string, unknown>; error: string };
  /** 可供选择的工具清单（只给描述，不给实现）。 */
  tools: readonly AgentToolDescriptor[];
  /** 较早对话的压缩摘要（可能为空或被预算丢弃）。 */
  digest?: string;
  /** 当前上下文估算（token）。 */
  contextTokens?: number;
};

/**
 * 事件队列：回调里 push 立刻唤醒消费端，做到「边到边出」。
 * 不用切字计时器伪造流式，也不把整段回答缓冲到结束。
 */
class EventQueue {
  private items: WorkbenchStreamEvent[] = [];
  private waiters: (() => void)[] = [];
  private closed = false;

  push(event: WorkbenchStreamEvent): void {
    this.items.push(event);
    this.waiters.shift()?.();
  }

  close(): void {
    this.closed = true;
    for (const wake of this.waiters.splice(0)) wake();
  }

  async *drain(): AsyncGenerator<WorkbenchStreamEvent> {
    for (;;) {
      const next = this.items.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

/** 把「卡住的异步」变成可终止：到期/取消时立刻收束，不等它自己返回。 */
function withDeadline<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new DOMException("已取消", "AbortError"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    task.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

export type AgentDeps = {
  plan(input: AgentPlanInput, signal: AbortSignal): Promise<AgentDecision>;
  /** 上下文整理结果：摘要、估算与压缩提示（提示只在开头播报一次）。 */
  context?: { digest: string; tokens: number; notices: string[] };
  /** 最终回答：逐字流式，事件直接转发。 */
  answer(
    input: { task: string; observations: AgentPlanInput["observations"]; digest?: string; imageAdvice?: import("./workbench-types").ImageAdvice },
    onEvent: (event: WorkbenchStreamEvent) => void,
    signal: AbortSignal
  ): Promise<void>;
  tools: ToolDeps;
  initialObservations?: AgentPlanInput["observations"];
  toolCatalog?: readonly AgentToolDescriptor[];
  /** 每轮计划开始时重新派生；执行用同一份快照校验。 */
  getToolCatalog?: () => readonly AgentToolDescriptor[];
  limits?: Partial<AgentLimits>;
};

/** 把工具输出包装成“资料”，并标注来源与截断情况。 */
export function wrapObservation(tool: string, outcome: { ok: boolean; content: string; truncated?: true }): string {
  const body = outcome.content || "（无正文）";
  return `<tool-result name="${tool}" ok="${outcome.ok}">\n${body}\n</tool-result>`;
}

export async function* runWorkbenchAgent(
  task: string,
  deps: AgentDeps,
  signal: AbortSignal
): AsyncGenerator<WorkbenchStreamEvent> {
  const limits: AgentLimits = {
    ...DEFAULT_AGENT_LIMITS,
    ...deps.limits,
    maxSteps: Math.min(deps.limits?.maxSteps ?? DEFAULT_AGENT_LIMITS.maxSteps, HARD_MAX_STEPS)
  };
  /*
   * 墙钟不是装饰：到期或用户取消都会 abort 这个控制器，所有 await 都通过 withDeadline 参与 race，
   * 因此卡住的上游请求不会让整轮悬着。
   */
  const control = new AbortController();
  const onOuterAbort = () => control.abort(new DOMException("已取消", "AbortError"));
  if (signal.aborted) onOuterAbort();
  else signal.addEventListener("abort", onOuterAbort, { once: true });
  /*
   * 墙钟不是装饰：到期或用户取消都会 abort 这个控制器，所有 await 都通过 withDeadline 参与 race，
   * 因此卡住的上游请求不会让整轮悬着。
   * R1（C3）：这份墙钟只覆盖**决策**；任务交给图片执行器后停掉它，执行预算由执行器自带，
   * 交付后再按回答期限重启。
   */
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => control.abort(new Error("AGENT_DEADLINE")), limits.deadlineMs);
  const stopDeadlineTimer = () => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
  };
  const isDeadline = () => control.signal.aborted && !signal.aborted && deadlineTimer !== undefined;
  const observations: AgentPlanInput["observations"] = [...(deps.initialObservations ?? [])];
  let repair: AgentPlanInput["repair"];
  let parameterFailures = 0;
  let steps = 0;
  let delivery: ToolOutcome | undefined;
  let imageAdvice: import("./workbench-types").ImageAdvice | undefined;

  yield { type: "stage", stage: "preparing", label: "整理范围与素材" };
  if (deps.context?.notices.length) {
    for (const message of deps.context.notices) yield { type: "notice", level: "info", message };
  }
  if (deps.context) {
    yield {
      type: "notice",
      level: "info",
      message: `本轮上下文约 ${deps.context.tokens} token。`
    };
  }

  try {
  while (steps < limits.maxSteps) {
    if (signal.aborted) {
      yield { type: "done", reason: "cancelled" };
      return;
    }
    if (isDeadline()) break;
    steps += 1;
    yield { type: "step", index: steps, limit: limits.maxSteps };

    // 同一份冻结清单既发给模型，也用于下面的执行前核对。
    const tools = Object.freeze((deps.getToolCatalog?.() ?? deps.toolCatalog ?? [])
      .filter(tool => tool.available !== false)
      .map(tool => Object.freeze({ ...tool, available: true as const })));

    let decision: AgentDecision;
    try {
      yield { type: "stage", stage: "planning", label: "规划下一步" };
      const planned = deps.plan(
        {
          task,
          observations,
          ...(repair ? { repair } : {}),
          tools,
          ...(deps.context?.digest ? { digest: deps.context.digest } : {}),
          ...(deps.context ? { contextTokens: deps.context.tokens } : {})
        },
        control.signal
      );
      decision = await withDeadline(planned, control.signal);
    } catch (error) {
      if (signal.aborted) {
        yield { type: "done", reason: "cancelled" };
        return;
      }
      if (isDeadline()) break;
      yield {
        type: "error",
        code: "AI_AGENT_PLAN_FAILED",
        message: error instanceof Error ? error.message : "规划失败。",
        retryable: true
      };
      yield { type: "done", reason: "error" };
      return;
    }

    if (decision.summary) yield { type: "notice", level: "info", message: `计划：${decision.summary}` };
    if (decision.action === "respond") {
      if (decision.imageAdvice) { imageAdvice = decision.imageAdvice; yield { type: "image_advice", advice: imageAdvice }; }
      break;
    }
    if (repair && decision.tool !== repair.tool) {
      yield { type: "error", code: "AI_TOOL_REPAIR_FAILED", message: "参数纠正改变了工具，本次未执行操作。", retryable: true };
      yield { type: "done", reason: "error" };
      return;
    }

    yield { type: "stage", stage: "tool", label: `执行 ${decision.tool}` };
    // 新搜索在重试后的新位置显示，不覆盖历史搜索；图片等既有稳定 ID 保持原语义。
    const toolId = decision.tool === "web_search" ? createCaptureId("search") : `step-${steps}`;
    yield {
      type: "tool_call",
      id: toolId,
      name: decision.tool,
      title: decision.tool,
      argsDigest: JSON.stringify(decision.args ?? {}).slice(0, 200)
    };
    /*
     * 交付型工具（create_artwork）是边界：决策期限在任务交给执行器后结束（C3）。
     * 它使用**外层信号**运行（用户取消仍然立即中止），执行器自带整批预算；
     * 其他只读工具继续受决策期限控制。
     */
    const isDeliveryTool = decision.tool === "create_artwork";
    let delivered = false;
    let outcome: ToolOutcome;
    try {
      const allowed = tools.some(tool => tool.name === decision.tool && tool.available);
      const checked = checkWorkbenchToolArgs(decision.tool, decision.args ?? {});
      if (!checked.ok) {
        parameterFailures += 1;
        repair = { tool: decision.tool, args: decision.args, error: checked.detail };
      } else repair = undefined;
      if (isDeliveryTool && allowed && checked.ok) {
        stopDeadlineTimer();
        delivered = true;
      }
      outcome = !allowed
        ? { ok: false, content: "", summary: `工具 ${decision.tool} 不在本轮可执行清单中，已拒绝。` }
        : !checked.ok
          ? { ok: false, content: "", summary: `工具参数无效：${checked.detail}` }
          : isDeliveryTool
            ? await executeTool(decision.tool, checked.args, deps.tools, signal)
            : await withDeadline(executeTool(decision.tool, checked.args, deps.tools, control.signal), control.signal);
    } catch (error) {
      outcome = { ok: false, content: "", summary: error instanceof Error ? error.message : "工具执行失败。",
        ...(decision.tool === "create_artwork" ? { next: "answer" as const } : {}) };
    }
    if (delivered) {
      // 交付后只剩一次说明/回答：独立的短预算（不再覆盖整批执行）。
      deadlineTimer = setTimeout(() => control.abort(new Error("AGENT_DEADLINE")),
        limits.answerDeadlineMs ?? IMAGE_EXECUTION_BUDGET.textRequestMs + IMAGE_EXECUTION_BUDGET.saveBarrierMs + 30_000);
    }
    const clipped = decision.tool === "web_search" && outcome.ok
      ? clipNativeSearchContent(outcome.content, limits.resultChars)
      : outcome.content.length > limits.resultChars
        ? `${outcome.content.slice(0, limits.resultChars)}\n…（已省略 ${outcome.content.length - limits.resultChars} 字符）`
        : outcome.content;
    yield {
      type: "tool_result",
      id: toolId,
      name: decision.tool,
      ok: outcome.ok,
      summary: outcome.summary,
      ...(decision.tool === "web_search" && outcome.ok && outcome.search ? { search: outcome.search } : {}),
      ...(outcome.truncated || clipped !== outcome.content ? { truncated: true as const } : {})
    };
    // 回灌给模型的是“资料”：截断、标注来源，并明确不是指令。
    // 失败时把执行前校验的原因交回计划轮，模型才有机会在剩余步数内修正参数。
    observations.push({ tool: decision.tool, ok: outcome.ok, content: outcome.ok ? clipped : outcome.summary.slice(0, limits.resultChars) });
    if (parameterFailures > 1) {
      yield { type: "error", code: "AI_TOOL_ARGS_INVALID", message: `工具参数纠正后仍无效：${outcome.summary}`, retryable: true };
      yield { type: "done", reason: "error" };
      return;
    }
    if (outcome.next === "answer") {
      delivery = outcome;
      break;
    }
  }

  if (signal.aborted) {
    yield { type: "done", reason: "cancelled" };
    return;
  }
  if (isDeadline()) {
    // 预算到期后不再新增模型调用：直接如实收束。
    yield { type: "notice", level: "warn", message: "已到墙钟上限，未完成的步骤已停止。" };
    yield { type: "done", reason: "timeout" };
    return;
  }

  yield { type: "stage", stage: "answering", label: "生成回答" };
  const queue = new EventQueue();
  let answerFailure: unknown;
  const running = (async () => {
    try {
      await deps.answer(
        { task, observations, ...(imageAdvice ? { imageAdvice } : {}), ...(deps.context?.digest ? { digest: deps.context.digest } : {}) },
        (event) => {
          /*
           * 回答轮的事件**原样转发**（含 error/done）：边到边出，且终止状态以事件为准，
           * 循环不再自作主张补一个 done.stop。
           */
          queue.push(event);
        },
        control.signal
      );
    } catch (error) {
      answerFailure = error;
    } finally {
      queue.close();
    }
  })();

  /*
   * 回答阶段同样受整轮期限/取消控制：中止时唤醒队列并丢弃晚到事件，
   * 因此卡住的上游不会让整轮悬着（唯一终止事件仍然保证）。
   */
  const wakeOnAbort = () => queue.close();
  control.signal.addEventListener("abort", wakeOnAbort, { once: true });

  let sawTerminal = false;
  for await (const event of queue.drain()) {
    if (signal.aborted || isDeadline()) break;
    if (event.type === "done") sawTerminal = true;
    if (event.type === "done" && (event.reason === "stop" || event.reason === "limit") && delivery && !delivery.ok) {
      yield { type: "error", code: "AI_ACTION_INCOMPLETE", message: delivery.summary, retryable: true };
      yield { type: "done", reason: "error" };
    } else yield event;
    if (sawTerminal) break;
  }
  await Promise.race([running, Promise.resolve()]);
  control.signal.removeEventListener("abort", wakeOnAbort);

  if (signal.aborted) {
    if (!sawTerminal) yield { type: "done", reason: "cancelled" };
    return;
  }
  if (isDeadline()) {
    if (!sawTerminal) {
      yield { type: "error", code: "AI_TIMEOUT", message: "已到墙钟上限，回答未完成。", retryable: true };
      yield { type: "done", reason: "timeout" };
    }
    return;
  }
  if (answerFailure) {
    if (!sawTerminal) {
      const timedOut = isDeadline();
      yield {
        type: "error",
        code: timedOut ? "AI_TIMEOUT" : "AI_AGENT_ANSWER_FAILED",
        message: answerFailure instanceof Error ? answerFailure.message : "生成回答失败。",
        retryable: !timedOut
      };
      yield { type: "done", reason: timedOut ? "timeout" : "error" };
    }
    return;
  }
  if (sawTerminal) return;
  if (delivery && !delivery.ok) {
    yield { type: "error", code: "AI_ACTION_INCOMPLETE", message: delivery.summary, retryable: true };
    yield { type: "done", reason: "error" };
  } else {
    yield { type: "error", code: "AI_AGENT_STREAM_INCOMPLETE", message: "回答流未收到可靠终态，已保留输出内容。", retryable: true };
    yield { type: "done", reason: "error" };
  }
  } finally {
    stopDeadlineTimer();
    signal.removeEventListener("abort", onOuterAbort);
  }
}
