/**
 * R1 统一图片执行器（任务书 C1–C3、§4.2）：自然语言入口与显式入口在计划固定后
 * 调用**同一个**执行器，包括用户补修的所有真实制图路径。
 *
 * 职责边界：
 * - 计划（`ImageTaskPlan`）在首个外部执行前固定；执行器只按计划逐项执行，
 *   不重新规划、不改写要求；重试只选择未完成项并复用已有提示快照；
 * - 每次出站有独立 `attemptId`，出站前先持久化 `prepared` 投影（保存失败零出站）；
 * - 预算：整批期限 `batchImageDeadlineMs(N)`；每次请求前检查剩余额度、取消；
 *   保存屏障有界等待 `Tsave`，到期停止后续付费请求；
 * - 结果未知不冒充失败：`dispatched` 先查询，过期无终态按未知恢复；只有显式
 *   「重新生成」才为未知项新建尝试；模型点评不能创建第二次尝试；
 * - 已成功未保存的产物优先恢复/保存（查询取回），不纳入再次制图集合；
 * - 状态的权威在服务端尝试表；会话投影与工具块只是展示。
 */
import {
  batchImageDeadlineMs,
  IMAGE_EXECUTION_BUDGET,
  type ImageAttemptIdentity,
  type ImageAttemptProjection,
  type ImageAttemptStatus,
  type ImagePromptSnapshot,
  type ImageTaskPlan
} from "@/features/ai/image-execution-contract";
import type { WorkbenchStreamEvent } from "@/features/ai/stream-events";
import type { MessageAttachment } from "./workbench-types";
import { SessionSaveFailureError } from "./workbench-types";

export type ImageExecutorSource = {
  sourceId: string;
  attachmentId: string;
  name: string;
  /** 解码后字节摘要（计划固定时算好）。 */
  digest: string;
  dataUrl: string;
};

export type ImageExecutorItem = ImageTaskPlan["items"][number];

/** 出站请求的归一化结果（由适配层把 Provider/HTTP 错误映射为确定失败或结果未知）。 */
export type ImageDispatchOutcome =
  | {
      ok: true;
      /** 产物 mime；转存引用场景可能缺省（命名回退 PNG）。 */
      mime?: string;
      imageBase64?: string;
      artifactId: string;
      artifactDigest: string;
      model?: string;
      /** 命中已保存结果（重复请求）：零新的供应商调用。 */
      reused?: true;
      /** 产物已转存进会话：按引用处理。 */
      transferred?: true;
      /** 产物已返回但服务端未能持久化终态：交付后停止后续项。 */
      pendingSave?: true;
    }
  | {
      ok: false;
      outcome: "failed" | "unknown" | "pending" | "conflict" | "capacity" | "config_changed" | "identity" | "error";
      detail: string;
      errorCode?: string;
      /**
       * `pending` 专用：服务端报告**另一条尝试已成功**（查询与重新登记之间的竞态）。
       * 执行器必须恢复这条原尝试（取回产物/更新投影），并移除尚未登记的新投影。
       */
      previous?: { attemptId: string; artifactId?: string; artifactDigest?: string };
    };

export type ImageExecutorDeps = {
  plan: ImageTaskPlan;
  /** 本轮冻结来源（带字节；与 plan.sources 同一身份）。 */
  sources: ImageExecutorSource[];
  sessionId: string;
  messageId: string;
  signal: AbortSignal;
  /** 已有尝试投影（重试/恢复时传入；执行器只在其上追加或按查询更新状态）。 */
  attempts: readonly ImageAttemptProjection[];
  /** 会话屏障：把计划与尝试投影写入会话并等待保存回执；失败抛 SessionSaveFailureError。 */
  persist: (state: { plan: ImageTaskPlan; attempts: ImageAttemptProjection[] }) => Promise<void>;
  /** 单项交付：附件写入会话并取得保存回执（页面在同一事务语义下保存）。 */
  deliver: (input: { item: ImageExecutorItem; attachment: MessageAttachment }) => Promise<void>;
  /** 理解轮（≤1/项）：看本项真实图片，把本项要求落成完整 instruction。 */
  understand?: (input: {
    item: ImageExecutorItem;
    sources: ImageExecutorSource[];
    instruction: string;
  }) => Promise<{ ok: true; instruction: string } | { ok: false; detail: string }>;
  /** 设计轮（≤1/项）：完整 instruction → 校验后的提示快照（一旦出站不可改写）。 */
  design: (input: {
    item: ImageExecutorItem;
    sources: ImageExecutorSource[];
    instruction: string;
    /** 本项此前尝试实际使用的资源摘要与文件身份（跨回合钉定）；适配层据此核对已读内容。 */
    expectedSkillResources?: { id: string; digest: string; files?: { path: string; digest: string }[] }[];
  }) => Promise<{ ok: true; snapshot: ImagePromptSnapshot; skillResources?: { id: string; digest: string; files?: { path: string; digest: string }[] }[] } | { ok: false; detail: string }>;
  /** 出站（带身份信封）；实现方负责服务工具块事件与错误归类。 */
  dispatch: (input: {
    item: ImageExecutorItem;
    sources: ImageExecutorSource[];
    snapshot: ImagePromptSnapshot;
    identity: ImageAttemptIdentity;
    attemptNo: number;
  }) => Promise<ImageDispatchOutcome>;
  /**
   * 尝试查询（恢复/重复点击先走查询；不触发模型或图片请求）。
   * `notFound: true` = 服务端确认**无该尝试的执行记录**（权威 404）——这是
   * 「未登记出站」的证据，允许新建尝试；其他 `ok:false`（网络失败等）不能据此新建。
   */
  query: (attemptId: string) => Promise<{
    ok: true;
    attempt: {
      status: ImageAttemptStatus;
      errorCode?: string;
      artifactId?: string;
      artifactDigest?: string;
      expired?: boolean;
      result?: { mime: string; imageBase64: string };
    };
  } | { ok: false; detail: string; notFound?: boolean }>;
  onEvent: (event: WorkbenchStreamEvent) => void;
  /** 新尝试 ID：由代码生成（模型不能指定）。 */
  createAttemptId: () => string;
  /** 附件命名（标题 → 附件名，与既有规则一致）。 */
  attachmentName: (input: { title: string; dataUrl: string }) => string;
  now?: () => number;
  /** 未知结果项是否允许新建尝试（只有显式「重新生成」才为 true）。 */
  regenerateUnknown?: boolean;
};

export type ImageTaskItemOutcome =
  | { itemId: string; state: "succeeded"; attachment: MessageAttachment; sourceName: string; sourceId?: string; reused?: boolean }
  | { itemId: string; state: "failed"; sourceName: string; sourceId?: string; detail: string }
  | { itemId: string; state: "unknown"; sourceName: string; sourceId?: string; attemptId?: string; detail: string }
  | { itemId: string; state: "pending"; sourceName: string; sourceId?: string; attemptId?: string; detail: string };

export type ImageTaskExecution = {
  attempts: ImageAttemptProjection[];
  outcomes: ImageTaskItemOutcome[];
  /** 停止原因（未停止时缺省）：save/budget/conflict/capacity/config/identity。 */
  stopped?: "save" | "budget" | "conflict" | "capacity" | "config" | "identity";
  stopDetail?: string;
};

class Cancelled extends Error {
  constructor() {
    super("已取消");
    this.name = "AbortError";
  }
}

const SAVE_BARRIER_TIMEOUT = "SAVE_BARRIER_TIMEOUT";

/** 保存屏障的有界等待：到期停止后续付费请求，不吞掉交付本身的失败。 */
function withinBarrier<T>(task: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(SAVE_BARRIER_TIMEOUT)), ms);
    let settled = false;
    task.then(
      value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function replaceAttempt(list: ImageAttemptProjection[], next: ImageAttemptProjection): void {
  const index = list.findIndex(item => item.attemptId === next.attemptId);
  if (index >= 0) list[index] = next;
  else list.push(next);
}

/** 执行一个计划；返回最终投影与逐项结果。用户取消抛 AbortError，其余停止以 `stopped` 表达。 */
export async function executeImageTask(deps: ImageExecutorDeps): Promise<ImageTaskExecution> {
  const { plan, signal, onEvent } = deps;
  const attempts: ImageAttemptProjection[] = deps.attempts.map(item => ({ ...item }));
  /** 本执行内各任务项设计实际采用的资源摘要与文件身份（跨回合钉定）。 */
  const designSkillResources = new Map<string, { id: string; digest: string; files?: { path: string; digest: string }[] }[]>();
  /*
   * 跨回合清理（以**服务端事实**为准）：`prepared` 投影可能对应已登记的付费请求
   * （登记允许在上一尝试仍 dispatched 时进行，上一尝试随后仍可晚到成功），
   * 客户端状态不能作为删除依据。逐个向服务端查询：
   * - 权威 404（从未登记）→ 清除投影；其提示快照保留给同要求补修（C1.6，不出站的那份最新鲜）；
   * - 已 succeeded → 更新为 succeeded，恢复路径取回原产物；
   * - dispatched / 查询失败 → 一律保留（在途付费请求或无法核对，交给后续步骤处理）。
   * （首回合内的登记拒绝残留由 dispatch 的 pending+previous 分支清理，见下。）
   */
  const carriedSnapshots = new Map<string, ImagePromptSnapshot>();
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const projection = attempts[index]!;
    if (projection.status !== "prepared") continue;
    const answer = await deps.query(projection.attemptId);
    if (!answer.ok && answer.notFound) {
      if (projection.promptSnapshot) carriedSnapshots.set(projection.itemId, projection.promptSnapshot);
      attempts.splice(index, 1);
      continue;
    }
    if (answer.ok && answer.attempt.status === "succeeded") {
      attempts[index] = {
        ...projection,
        status: "succeeded",
        ...(answer.attempt.artifactId ? { artifactId: answer.attempt.artifactId } : {}),
        ...(answer.attempt.artifactDigest ? { artifactDigest: answer.attempt.artifactDigest } : {})
      };
      continue;
    }
    if (answer.ok && answer.attempt.status === "dispatched") {
      // 已登记的付费请求：客户端投影同步为服务端事实，后续按在途查询处理（不重发）。
      attempts[index] = { ...projection, status: "dispatched" };
    }
  }
  const outcomes: ImageTaskItemOutcome[] = [];
  const startMs = deps.now?.() ?? Date.now();
  const deadline = startMs + batchImageDeadlineMs(plan.items.length);
  const remaining = () => deadline - (deps.now?.() ?? Date.now());
  const assertOpen = () => {
    if (signal.aborted) throw new Cancelled();
  };
  const persistState = async () => {
    assertOpen();
    await deps.persist({ plan, attempts: attempts.map(item => ({ ...item })) });
  };
  const notice = (message: string) => onEvent({ type: "notice", level: "warn", message });
  const sourcesOf = (item: ImageExecutorItem): ImageExecutorSource[] =>
    item.sourceIds
      .map(sourceId => deps.sources.find(source => source.sourceId === sourceId))
      .filter((source): source is ImageExecutorSource => source !== undefined);

  const attemptsFor = (itemId: string) =>
    attempts.filter(item => item.itemId === itemId).sort((a, b) => a.attemptNo - b.attemptNo);
  const latestOf = (itemId: string) => {
    const list = attemptsFor(itemId);
    return list[list.length - 1];
  };
  const itemTitle = (item: ImageExecutorItem) => {
    const primary = deps.sources.find(source => source.sourceId === item.sourceIds[0]);
    if (plan.mode === "generate") return primary ? `${primary.name} · 融合` : "图片作品";
    return (primary?.name ?? "图片").replace(/\.(png|jpe?g|webp)$/i, "").trim() || "图片";
  };

  /** 带保存屏障的交付；返回 false 表示保存屏障未确认（调用方停止批处理）。 */
  const deliver = async (item: ImageExecutorItem, attachment: MessageAttachment): Promise<"saved" | "barrier"> => {
    try {
      await withinBarrier(deps.deliver({ item, attachment }), IMAGE_EXECUTION_BUDGET.saveBarrierMs);
      return "saved";
    } catch (error) {
      if (error instanceof Error && error.message === SAVE_BARRIER_TIMEOUT) {
        notice("保存等待超时：已停止后续图片请求；保存完成后刷新即可取回。");
        return "barrier";
      }
      throw error;
    }
  };

  try {
    // ---- 0. 计划与初始投影先落盘：保存失败零出站（§4.2.1） ----
    await persistState();

    for (const [index, item] of plan.items.entries()) {
      assertOpen();
      const primary = deps.sources.find(source => source.sourceId === item.sourceIds[0]);
      const sourceName = primary?.name ?? `${plan.mode === "generate" ? "生成图片" : "图片"} ${index + 1}`;
      const sourceRef = plan.mode === "edit" ? item.sourceIds[0] : undefined;
      onEvent({
        type: "tool_call",
        id: `image-edit-${item.itemId}`,
        name: "image-edit",
        title: plan.items.length > 1
          ? `第 ${index + 1}/${plan.items.length} 项 · ${sourceName}`
          : sourceName,
        argsDigest: ""
      });

      let latest = latestOf(item.itemId);
      // ---- 1. 已交付项跳过（重试只选择未完成项） ----
      if (latest?.delivered) {
        onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: true, summary: "已完成（此前已保存）" });
        continue;
      }

      // ---- 2. 已成功未交付：先查询取回原结果，不重新出站 ----
      if (latest && latest.status === "succeeded") {
        const answer = await deps.query(latest.attemptId);
        if (answer.ok && answer.attempt.status === "succeeded" && answer.attempt.result) {
          const attachment: MessageAttachment = {
            id: answer.attempt.artifactId ?? latest.artifactId ?? latest.attemptId,
            name: deps.attachmentName({ title: itemTitle(item), dataUrl: `data:${answer.attempt.result.mime};base64,` }),
            dataUrl: `data:${answer.attempt.result.mime};base64,${answer.attempt.result.imageBase64}`
          };
          try {
            const saved = await deliver(item, attachment);
            if (saved === "barrier") {
              outcomes.push({ itemId: item.itemId, state: "pending", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}), attemptId: latest.attemptId, detail: "产物已取回，保存仍在进行" });
              onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: true, summary: "已取回；保存仍在进行，已停止后续项" });
              return { attempts, outcomes, stopped: "save", stopDetail: "保存等待超时" };
            }
          } catch (error) {
            if (error instanceof SessionSaveFailureError) {
              outcomes.push({ itemId: item.itemId, state: "failed", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}), detail: error.message });
              onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: false, summary: "产物已取回，但会话保存失败；已停止后续项" });
              return { attempts, outcomes, stopped: "save", stopDetail: error.message };
            }
            throw error;
          }
          replaceAttempt(attempts, { ...latest, delivered: true });
          outcomes.push({ itemId: item.itemId, state: "succeeded", attachment, sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}) });
          onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: true, summary: "已从原尝试取回并保存" });
          continue;
        }
        if (answer.ok && answer.attempt.status === "succeeded") {
          // 已转存进会话：本页附件随下次会话读取出现；按已交付处理，不再出站。
          replaceAttempt(attempts, { ...latest, delivered: true });
          outcomes.push({
            itemId: item.itemId, state: "succeeded", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}), reused: true,
            attachment: { id: latest.artifactId ?? latest.attemptId, name: deps.attachmentName({ title: itemTitle(item), dataUrl: "" }), dataUrl: "" }
          });
          onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: true, summary: "产物已在会话中（另一处保存），本页刷新后可见" });
          continue;
        }
        if (answer.ok && answer.attempt.status === "dispatched" && !answer.attempt.expired) {
          outcomes.push({ itemId: item.itemId, state: "pending", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}), attemptId: latest.attemptId, detail: "原尝试仍在处理中" });
          onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: true, summary: "原尝试仍在处理中；未重新发送" });
          continue;
        }
        // 查询失败 / 过期无终态：按结果未知恢复，不自动重新生成。
        if (!answer.ok) {
          replaceAttempt(attempts, { ...latest, errorCode: "IMAGE_ATTEMPT_QUERY_FAILED" });
          outcomes.push({ itemId: item.itemId, state: "unknown", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}), attemptId: latest.attemptId, detail: "无法核对尝试状态；未重新发送" });
          onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: false, summary: "无法核对尝试状态；未重新发送" });
          continue;
        }
        if (answer.attempt.expired) {
          replaceAttempt(attempts, { ...latest, status: "outcome_unknown" });
          latest = latestOf(item.itemId);
        }
      }

      // ---- 3. 结果未知：先做只读恢复（与新建许可无关），许可只控制是否新建付费尝试 ----
      if (latest?.status === "outcome_unknown") {
        const answer = await deps.query(latest.attemptId);
        if (answer.ok && answer.attempt.status === "succeeded" && answer.attempt.result) {
          // 服务端已有产物：取回交付是只读操作，不需要「重新生成」许可。
          const attachment: MessageAttachment = {
            id: answer.attempt.artifactId ?? latest.artifactId ?? latest.attemptId,
            name: deps.attachmentName({ title: itemTitle(item), dataUrl: `data:${answer.attempt.result.mime};base64,` }),
            dataUrl: `data:${answer.attempt.result.mime};base64,${answer.attempt.result.imageBase64}`
          };
          const saved = await deliver(item, attachment);
          if (saved === "barrier") {
            replaceAttempt(attempts, { ...latest, status: "succeeded", ...(answer.attempt.artifactId ? { artifactId: answer.attempt.artifactId } : {}), ...(answer.attempt.artifactDigest ? { artifactDigest: answer.attempt.artifactDigest } : {}) });
            outcomes.push({ itemId: item.itemId, state: "pending", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}), attemptId: latest.attemptId, detail: "产物已取回，保存仍在进行" });
            onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: true, summary: "已取回；保存仍在进行，已停止后续项" });
            return { attempts, outcomes, stopped: "save", stopDetail: "保存等待超时" };
          }
          replaceAttempt(attempts, { ...latest, status: "succeeded", ...(answer.attempt.artifactId ? { artifactId: answer.attempt.artifactId } : {}), ...(answer.attempt.artifactDigest ? { artifactDigest: answer.attempt.artifactDigest } : {}), delivered: true });
          outcomes.push({ itemId: item.itemId, state: "succeeded", attachment, sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}) });
          onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: true, summary: "原尝试已成功：已取回原产物（零新的供应商调用）" });
          continue;
        }
        if (answer.ok && answer.attempt.status === "succeeded") {
          // 已转存进会话：刷新即可见，不重新出站。
          replaceAttempt(attempts, { ...latest, status: "succeeded", delivered: true });
          outcomes.push({
            itemId: item.itemId, state: "succeeded", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}), reused: true,
            attachment: { id: latest.artifactId ?? latest.attemptId, name: deps.attachmentName({ title: itemTitle(item), dataUrl: "" }), dataUrl: "" }
          });
          onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: true, summary: "原尝试已成功且产物已在会话中，本页刷新后可见" });
          continue;
        }
        if (answer.ok && answer.attempt.status === "dispatched" && !answer.attempt.expired) {
          outcomes.push({ itemId: item.itemId, state: "pending", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}), attemptId: latest.attemptId, detail: "原尝试仍在处理中" });
          onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: true, summary: "原尝试仍在处理中；未重新发送" });
          continue;
        }
        if (answer.ok && answer.attempt.status === "failed") {
          replaceAttempt(attempts, { ...latest, status: "failed", ...(answer.attempt.errorCode ? { errorCode: answer.attempt.errorCode } : {}) });
          outcomes.push({ itemId: item.itemId, state: "failed", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}), detail: answer.attempt.errorCode ?? "原尝试已确定失败" });
          onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: false, summary: answer.attempt.errorCode ?? "原尝试已确定失败" });
          continue;
        }
        // 到这里查询确认没有可用产物：404（未登记）/ 过期仍未知 / 仍未知 / 查询失败。
        if (!deps.regenerateUnknown) {
          // 未获「重新生成」许可：保持未知，不新建付费尝试。
          outcomes.push({
            itemId: item.itemId, state: "unknown", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}),
            attemptId: latest.attemptId,
            detail: latest.errorCode ? `结果未知（${latest.errorCode}）` : "上次出站结果未知；未自动重新生成"
          });
          onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: false, summary: "结果未知；未自动重新生成" });
          continue;
        }
        if (!answer.ok && !answer.notFound) {
          // 查询请求本身失败（网络）：无法核对，不新建尝试。
          outcomes.push({ itemId: item.itemId, state: "unknown", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}), attemptId: latest.attemptId, detail: "无法核对尝试状态；未重新发送" });
          onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: false, summary: "无法核对尝试状态；未重新发送" });
          continue;
        }
        // 404（确认未登记出站）/ 过期仍未知 / 仍未知 + 显式许可 → 允许新建。
        if (!answer.ok && answer.notFound) {
          // C1.6：清除 ghost 投影前保留其快照（同要求补修复用）；序号从真实登记历史推导。
          if (latest.promptSnapshot) carriedSnapshots.set(item.itemId, latest.promptSnapshot);
          const ghostIndex = attempts.findIndex(entry => entry.attemptId === latest.attemptId);
          if (ghostIndex >= 0) attempts.splice(ghostIndex, 1);
          latest = latestOf(item.itemId);
        }
        notice("该项上次出站结果未知；按你的选择重新生成，可能再次计费。");
      }

      // ---- 4. 处理中的项不重复出站；终态变化按查询结果恢复 ----
      if (latest?.status === "dispatched") {
        const answer = await deps.query(latest.attemptId);
        if (answer.ok && answer.attempt.status === "dispatched" && !answer.attempt.expired) {
          outcomes.push({ itemId: item.itemId, state: "pending", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}), attemptId: latest.attemptId, detail: "原尝试仍在处理中" });
          onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: true, summary: "原尝试仍在处理中；未重新发送" });
          continue;
        }
        if (answer.ok && answer.attempt.status === "succeeded" && answer.attempt.result) {
          const attachment: MessageAttachment = {
            id: answer.attempt.artifactId ?? latest.attemptId,
            name: deps.attachmentName({ title: itemTitle(item), dataUrl: `data:${answer.attempt.result.mime};base64,` }),
            dataUrl: `data:${answer.attempt.result.mime};base64,${answer.attempt.result.imageBase64}`
          };
          const saved = await deliver(item, attachment);
          if (saved === "barrier") {
            replaceAttempt(attempts, { ...latest, status: "succeeded", artifactId: answer.attempt.artifactId, artifactDigest: answer.attempt.artifactDigest });
            outcomes.push({ itemId: item.itemId, state: "pending", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}), attemptId: latest.attemptId, detail: "产物已取回，保存仍在进行" });
            onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: true, summary: "已取回；保存仍在进行，已停止后续项" });
            return { attempts, outcomes, stopped: "save", stopDetail: "保存等待超时" };
          }
          replaceAttempt(attempts, { ...latest, status: "succeeded", artifactId: answer.attempt.artifactId, artifactDigest: answer.attempt.artifactDigest, delivered: true });
          outcomes.push({ itemId: item.itemId, state: "succeeded", attachment, sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}) });
          onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: true, summary: "已取回并保存" });
          continue;
        }
        if (!answer.ok) {
          outcomes.push({ itemId: item.itemId, state: "unknown", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}), attemptId: latest.attemptId, detail: "无法核对尝试状态；未重新发送" });
          onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: false, summary: "无法核对尝试状态；未重新发送" });
          continue;
        }
        if (answer.attempt.expired || answer.attempt.status === "outcome_unknown") {
          replaceAttempt(attempts, { ...latest, status: "outcome_unknown", ...(answer.attempt.errorCode ? { errorCode: answer.attempt.errorCode } : {}) });
          latest = latestOf(item.itemId);
          if (!deps.regenerateUnknown) {
            outcomes.push({ itemId: item.itemId, state: "unknown", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}), attemptId: latest.attemptId, detail: "结果未知；未自动重新生成" });
            onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: false, summary: "结果未知；未自动重新生成" });
            continue;
          }
        } else if (answer.attempt.status === "failed") {
          replaceAttempt(attempts, { ...latest, status: "failed", ...(answer.attempt.errorCode ? { errorCode: answer.attempt.errorCode } : {}) });
          outcomes.push({ itemId: item.itemId, state: "failed", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}), detail: answer.attempt.errorCode ?? "原尝试已确定失败" });
          onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: false, summary: answer.attempt.errorCode ?? "原尝试已确定失败" });
          continue;
        }
      }

      // ---- 5. 准备提示（≤2 次对话请求/项）：复用已有快照（含 404 清除前保留的那份），设计尚未成功才重新设计 ----
      let snapshot = latest?.promptSnapshot ?? carriedSnapshots.get(item.itemId);
      if (!snapshot) {
        const needText = IMAGE_EXECUTION_BUDGET.textRequestMs * (deps.understand ? 2 : 1);
        if (remaining() < needText) {
          notice("已到本批执行预算上限：未开始的项已停止，不再发起新的付费请求。");
          return { attempts, outcomes, stopped: "budget", stopDetail: "整批执行预算已用尽" };
        }
        // 跨回合资源钉定：只看**本项**此前尝试实际使用的资源摘要（不跨项串用）。
        const expectedSkillResources = attempts
          .filter(entry => entry.itemId === item.itemId && entry.skillResources?.length)
          .map(entry => entry.skillResources!)
          .at(-1);
        let instruction = item.instruction;
        if (deps.understand) {
          const understood = await deps.understand({ item, sources: sourcesOf(item), instruction });
          assertOpen();
          if (!understood.ok) {
            outcomes.push({ itemId: item.itemId, state: "failed", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}), detail: understood.detail });
            onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: false, summary: understood.detail.slice(0, 300) });
            continue;
          }
          instruction = understood.instruction;
        }
        const designed = await deps.design({ item, sources: sourcesOf(item), instruction,
          ...(expectedSkillResources ? { expectedSkillResources } : {}) });
        assertOpen();
        if (!designed.ok) {
          outcomes.push({ itemId: item.itemId, state: "failed", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}), detail: designed.detail });
          onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: false, summary: designed.detail.slice(0, 300) });
          continue;
        }
        snapshot = designed.snapshot;
        // 记录设计实际采用的资源摘要（跨回合钉定；投影创建时带上）。
        if (designed.skillResources?.length) designSkillResources.set(item.itemId, designed.skillResources);
      }

      // ---- 6. 出站前持久化 prepared（保存失败零出站） ----
      const isRedispatch = latest?.status === "prepared";
      const terminalPrevious = latest && (latest.status === "failed" || latest.status === "outcome_unknown" || latest.status === "succeeded")
        ? latest
        : undefined;
      const attemptNo = isRedispatch && latest ? latest.attemptNo : attemptsFor(item.itemId).length + 1;
      const attemptId = isRedispatch && latest ? latest.attemptId : deps.createAttemptId();
      const designResources = designSkillResources.get(item.itemId);
      const projection: ImageAttemptProjection = {
        attemptId,
        itemId: item.itemId,
        attemptNo,
        ...(isRedispatch && latest?.previousAttemptId
          ? { previousAttemptId: latest.previousAttemptId }
          : terminalPrevious?.attemptId
            ? { previousAttemptId: terminalPrevious.attemptId }
            : {}),
        status: "prepared",
        promptSnapshot: snapshot,
        ...(designResources ? { skillResources: designResources } : {})
      };
      replaceAttempt(attempts, projection);
      try {
        await persistState();
      } catch (error) {
        if (error instanceof SessionSaveFailureError) {
          outcomes.push({ itemId: item.itemId, state: "failed", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}), detail: error.message });
          onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: false, summary: "尚未出站：保存失败，本次未发送。" });
          return { attempts, outcomes, stopped: "save", stopDetail: error.message };
        }
        throw error;
      }
      assertOpen();
      if (remaining() < IMAGE_EXECUTION_BUDGET.imageRequestMs) {
        notice("已到本批执行预算上限：未开始的项已停止，不再发起新的付费请求。");
        return { attempts, outcomes, stopped: "budget", stopDetail: "整批执行预算已用尽" };
      }

      // ---- 7. 出站（统一预算/取消；身份信封绑定 attemptId） ----
      const identity: ImageAttemptIdentity = {
        sessionId: deps.sessionId,
        messageId: deps.messageId,
        executionId: plan.executionId,
        itemId: item.itemId,
        attemptId,
        ...(projection.previousAttemptId ? { previousAttemptId: projection.previousAttemptId } : {})
      };
      let outcome: ImageDispatchOutcome;
      try {
        outcome = await deps.dispatch({ item, sources: sourcesOf(item), snapshot, identity, attemptNo });
      } catch {
        if (signal.aborted) throw new Cancelled();
        // 出站后异常默认结果未知：不能凭一次异常推定未执行。
        replaceAttempt(attempts, { ...projection, status: "outcome_unknown", errorCode: "IMAGE_DISPATCH_ERROR" });
        outcomes.push({ itemId: item.itemId, state: "unknown", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}), attemptId, detail: "出站后连接中断，结果未知；未自动重试" });
        onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: false, summary: "出站后连接中断，结果未知；未自动重试" });
        continue;
      }
      if (!outcome.ok) {
        if (outcome.outcome === "failed") {
          replaceAttempt(attempts, { ...projection, status: "failed", ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}) });
          outcomes.push({ itemId: item.itemId, state: "failed", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}), detail: outcome.detail });
          onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: false, summary: outcome.detail.slice(0, 300) });
          continue;
        }
        if (outcome.outcome === "unknown") {
          replaceAttempt(attempts, { ...projection, status: "outcome_unknown", ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}) });
          outcomes.push({ itemId: item.itemId, state: "unknown", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}), attemptId, detail: outcome.detail });
          onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: false, summary: "结果未知；未自动重试" });
          continue;
        }
        if (outcome.outcome === "pending") {
          if (outcome.previous) {
            /*
             * 竞态恢复（§4.2）：查询与重新登记之间原尝试已成功。服务端拒绝登记新尝试
             * （表中没有新行），客户端同步移除新投影，并把原尝试恢复为 succeeded——
             * 能取回字节就直接交付，取不回也保留产物引用供刷新后恢复。
             */
            // 服务端拒绝登记 = 该新投影在尝试表中永远没有行：无论首回合还是重放都清除。
            const newIndex = attempts.findIndex(entry => entry.attemptId === attemptId);
            if (newIndex >= 0) attempts.splice(newIndex, 1);
            const answer = await deps.query(outcome.previous.attemptId);
            const previousProjection = attempts.find(entry => entry.attemptId === outcome.previous!.attemptId);
            if (answer.ok && answer.attempt.status === "succeeded" && answer.attempt.result) {
              const attachment: MessageAttachment = {
                id: answer.attempt.artifactId ?? outcome.previous.artifactId ?? outcome.previous.attemptId,
                name: deps.attachmentName({ title: itemTitle(item), dataUrl: `data:${answer.attempt.result.mime};base64,` }),
                dataUrl: `data:${answer.attempt.result.mime};base64,${answer.attempt.result.imageBase64}`
              };
              const saved = await deliver(item, attachment);
              if (previousProjection) {
                replaceAttempt(attempts, { ...previousProjection, status: "succeeded", artifactId: outcome.previous.artifactId, artifactDigest: outcome.previous.artifactDigest, ...(saved === "saved" ? { delivered: true as const } : {}) });
              }
              if (saved === "barrier") {
                outcomes.push({ itemId: item.itemId, state: "pending", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}), attemptId: outcome.previous.attemptId, detail: "原产物已取回，保存仍在进行" });
                onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: true, summary: "已取回原产物；保存仍在进行，已停止后续项" });
                return { attempts, outcomes, stopped: "save", stopDetail: "保存等待超时" };
              }
              outcomes.push({ itemId: item.itemId, state: "succeeded", attachment, sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}) });
              onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: true, summary: "原尝试已成功：已取回原产物（零新的供应商调用）" });
              continue;
            }
            if (previousProjection) {
              replaceAttempt(attempts, { ...previousProjection, status: "succeeded",
                ...(outcome.previous.artifactId ? { artifactId: outcome.previous.artifactId } : {}),
                ...(outcome.previous.artifactDigest ? { artifactDigest: outcome.previous.artifactDigest } : {}) });
            }
            outcomes.push({ itemId: item.itemId, state: "pending", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}), attemptId: outcome.previous.attemptId, detail: "原尝试已成功但取回未完成；请刷新后恢复取回" });
            onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: true, summary: "原尝试已成功；已停止重新出站，刷新后可恢复取回" });
            continue;
          }
          outcomes.push({ itemId: item.itemId, state: "pending", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}), attemptId, detail: outcome.detail });
          onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: true, summary: outcome.detail });
          continue;
        }
        // 冲突/容量/配置变化：整批停止（继续执行只会重复同类失败）。
        outcomes.push({ itemId: item.itemId, state: "failed", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}), detail: outcome.detail });
        onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: false, summary: outcome.detail.slice(0, 300) });
        return {
          attempts, outcomes,
          stopped: outcome.outcome === "conflict" ? "conflict"
            : outcome.outcome === "capacity" ? "capacity"
            : outcome.outcome === "config_changed" ? "config"
            : "identity",
          stopDetail: outcome.detail
        };
      }

      // ---- 8. 交付：附件写入会话并取得保存回执（Tsave 屏障） ----
      const attachment: MessageAttachment = outcome.imageBase64
        ? {
            id: outcome.artifactId,
            name: deps.attachmentName({ title: itemTitle(item), dataUrl: `data:${outcome.mime ?? "image/png"};base64,` }),
            dataUrl: `data:${outcome.mime ?? "image/png"};base64,${outcome.imageBase64}`
          }
        : { id: outcome.artifactId, name: deps.attachmentName({ title: itemTitle(item), dataUrl: "" }), dataUrl: "" };
      if (attachment.dataUrl) {
        let saved: "saved" | "barrier";
        try {
          saved = await deliver(item, attachment);
        } catch (error) {
          if (error instanceof SessionSaveFailureError) {
            // 产物已生成但会话保存失败：图片本身已出（attempt=succeeded），
            // 保存失败由消息的 saveFailed/错误字段与补修入口表达，不冒充生成失败。
            replaceAttempt(attempts, { ...projection, status: "succeeded", artifactId: outcome.artifactId, artifactDigest: outcome.artifactDigest });
            outcomes.push({ itemId: item.itemId, state: "failed", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}), detail: error.message });
            onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: true, summary: "已生成；会话保存失败，已停止后续项。" });
            return { attempts, outcomes, stopped: "save", stopDetail: error.message };
          }
          throw error;
        }
        if (saved === "barrier") {
          replaceAttempt(attempts, { ...projection, status: "succeeded", artifactId: outcome.artifactId, artifactDigest: outcome.artifactDigest });
          outcomes.push({ itemId: item.itemId, state: "pending", sourceName, ...(sourceRef ? { sourceId: sourceRef } : {}), attemptId, detail: "已生成；保存仍在进行" });
          onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: true, summary: "已生成；保存仍在进行，已停止后续项" });
          return { attempts, outcomes, stopped: "save", stopDetail: "保存等待超时" };
        }
      }
      replaceAttempt(attempts, {
        ...projection,
        status: "succeeded",
        artifactId: outcome.artifactId,
        artifactDigest: outcome.artifactDigest,
        delivered: true
      });
      outcomes.push({
        itemId: item.itemId, state: "succeeded", attachment, sourceName,
        ...(sourceRef ? { sourceId: sourceRef } : {}), ...(outcome.reused ? { reused: true } : {})
      });
      onEvent({ type: "tool_result", id: `image-edit-${item.itemId}`, name: "image-edit", ok: true, summary: outcome.reused ? "已复用原结果（零新的供应商调用）" : "已完成" });
      if (outcome.pendingSave) {
        notice("结果已保存到会话，但服务端尝试记录暂未确认；已停止后续项。");
        return { attempts, outcomes, stopped: "save", stopDetail: "服务端尝试记录暂未确认" };
      }
    }
    return { attempts, outcomes };
  } catch (error) {
    // 取消沿 signal 语义向上抛；其他异常如实向上传播（不冒充任何终态）。
    throw error;
  }
}
