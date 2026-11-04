"use client";

/**
 * P8：整理检索结果的**唯一协调入口**（同意 → 冻结范围 → 任务 → 只读分组 → 恢复）。
 *
 * 边界（Ponytail）：
 * - 不建 AI Manager / Service / 全局 store / 任务队列；状态与动作都在这一个 hook 内；
 * - 持久化与执行复用既有契约（AiRepository / runOrganizeCollectionTask /
 *   createAiContextProvider / flushAutosave），不新造写路径；
 * - **只读**：分组提案固定 draft，不进 accepted/applied，不写正文、媒体与业务收据；
 * - 异步回调按「范围签名 + 会话序号 + 操作次序号」判定有效性：切换范围后旧结果立即作废，
 *   不读「当时选中的范围」、不靠「options ref 之后会更新」的假设；
 * - 恢复只读扫描任务与提案，**不修改归属不明的任务**（无法证明中断就不写）；
 * - 未配置 / P8 未启用 / 未同意 / 空范围 / 超预算都不发模型请求。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createAiReadScope,
  aiVisiblePages,
  type AiContextProviderOptions,
  type AiPageContext
} from "@/features/ai/ai-context";
import {
  createAiGatewayCaller,
  listAiConfigs,
  type AiGatewayCaller,
  type AiPublicConfig
} from "@/features/ai/ai-gateway-client";
import { rejectProposal, type AiProposal } from "@/features/ai/ai-proposal";
import type { AiRepository } from "@/features/ai/ai-repository";
import { LIGHT_AGENT_BUDGETS, type LightAgentResult } from "@/features/ai/ai-light-agent-schema";
import {
  checkCollectionSources,
  runOrganizeCollectionTask,
  type LightAgentTraceStep
} from "@/features/ai/ai-light-agent-runner";
import { LIGHT_AGENT_PLAN_PROMPT } from "@/features/ai/prompts/light-agent";
import type { LightAgentAllowedOptions } from "@/features/ai/prompts/light-agent";
import { transitionAiTask, type AiTask, type CollectionScope } from "@/features/ai/ai-task";
import type { NotebookMedia } from "@/features/notebook/notebook-model";
import type { ArchiveCore } from "@/features/notebook/notebook-repository";
import { isSessionIdentityCurrent } from "./use-page-organize";

export type LightAgentStatus =
  | "loading-config"
  /** 没有可用模型配置（与 P2 同一判定）。 */
  | "config-missing"
  /** P8 独立服务端开关关闭（默认）；不因为 P2 已配置而开放。 */
  | "disabled"
  | "idle"
  | "running"
  | "ready"
  | "empty"
  | "failed"
  | "cancelled";

export type LightAgentSourceState = {
  pageId: string;
  title: string;
  state: "fresh" | "stale" | "unavailable";
};

export type LightAgentViewState = {
  status: "fresh" | "stale" | "unavailable";
  sources: LightAgentSourceState[];
  /** 面向用户的过期/不可用说明；fresh 时为 undefined。 */
  reason?: string;
};

export type LightAgentRecovered = {
  proposal: AiProposal;
  task: AiTask | null;
  view: LightAgentViewState;
};

export type LightAgentApi = {
  status: LightAgentStatus;
  message?: string;
  configs: AiPublicConfig[];
  selectedConfigId: string;
  selectConfig: (configId: string) => void;
  goal: string;
  setGoal: (goal: string) => void;
  /** 本次将要使用的冻结范围（显示与告知都用它，不使用渲染期之外的口径）。 */
  scope: CollectionScope;
  agreed: boolean;
  pendingStart: boolean;
  /** 开始入口：未配置→只重读配置；未启用→只提示；未同意→先弹告知；都是零模型请求。 */
  requestStart: () => void;
  cancelStart: () => void;
  confirmStart: () => Promise<void>;
  proposal?: AiProposal;
  result?: LightAgentResult;
  viewState?: LightAgentViewState;
  trace: LightAgentTraceStep[];
  recovered: LightAgentRecovered[];
  runInfo?: string;
  /** 上一次恢复扫描的读取失败说明（可见，不伪装成「没有历史结果」）。 */
  recoveredMessage?: string;
  reloadRecovered: () => Promise<void>;
  reloadConfig: () => Promise<void>;
  cancel: () => Promise<void>;
  /** 丢弃这份只读提案（draft → rejected），不会写任何业务数据。 */
  discard: (proposalId: string) => Promise<void>;
  resume: (proposalId: string) => void;
  /** 打开来源篇：先经既有保存协调与权威可见性复核。 */
  openSource: (pageId: string) => Promise<void>;
};

const CONFIG_MISSING_MESSAGE = "尚未配置可用模型，请前往设置添加。";
const CONFIG_DEV_ONLY_MESSAGE = "AI 未开启。";
const DISABLED_MESSAGE =
  "整理检索结果功能未开启。";

export type LightAgentOptions = {
  ai: AiRepository;
  /** 本次允许的范围（上限）；只能由界面上的显式选择决定。 */
  scope: CollectionScope;
  /** 计划输入里允许模型引用的地区/旅行/地点展示名（只含用户可选项）。 */
  allowedOptions?: LightAgentAllowedOptions;
  /** 渲染期档案快照：用于派生来源是否过期（源变化后界面随即标记）。 */
  archive: ArchiveCore;
  media: readonly (Omit<NotebookMedia, "blob"> & { blob?: Blob })[];
  /** flush 之后的权威档案读取：不用保存前的 props 冻结来源。 */
  loadArchive: () => Promise<ArchiveCore>;
  enabled: boolean;
  onFlush: () => Promise<boolean>;
  onOpenPage?: (pageId: string) => Promise<boolean> | boolean;
  onNotice?: (message: string) => void;
  callGateway?: AiGatewayCaller;
  listConfigs?: typeof listAiConfigs;
  now?: () => Date;
  createId?: () => string;
};

/** 范围签名：字段顺序固定，仅用于判定「是否同一个范围」。 */
export function scopeSignature(scope: CollectionScope): string {
  const part = (value: readonly string[] | null) => (value === null ? "*" : `[${value.join(",")}]`);
  return [
    part(scope.notebookIds),
    part(scope.regionIds),
    part(scope.tripIds),
    part(scope.placeIds),
    scope.from ?? "*",
    scope.to ?? "*"
  ].join("|");
}

function sameScope(left: CollectionScope, right: CollectionScope): boolean {
  return scopeSignature(left) === scopeSignature(right);
}

/**
 * R3：从冻结来源与**当前**档案派生来源状态（只读）。
 *
 * 资格判定统一走 `checkCollectionSources`（复用 SearchProvider 的可见性 + 结构过滤），
 * **只使用提案自身的冻结范围**，不使用当前筛选去扩大授权：
 * - 已不满足冻结范围（移本、时间越界、旅行/地点关系解除…）或不可见 → `unavailable`；
 * - 仍在范围内但正文变化 → `stale`；否则 `fresh`。
 */
export async function deriveCollectionSourceState(
  proposal: AiProposal,
  context: AiContextProviderOptions
): Promise<LightAgentViewState> {
  const scope = proposal.payload.kind === "organize_collection" ? proposal.payload.scope : null;
  const refs = proposal.sourceRefs.filter((ref) => ref.kind === "page");
  const checks = await checkCollectionSources(
    refs.map((ref) => ({ id: ref.id, sourceDigest: ref.sourceDigest })),
    { archive: context.archive, scope }
  );
  const sources: LightAgentSourceState[] = checks.map((check) => ({
    pageId: check.pageId,
    title: check.title,
    state: check.state
  }));
  const unavailable = sources.filter((source) => source.state === "unavailable");
  if (unavailable.length > 0) {
    return {
      status: "unavailable",
      sources,
      reason: `有 ${unavailable.length} 篇来源已删除或已不在本次冻结范围内；本次分组不再作为当前结论展示。`
    };
  }
  const stale = sources.filter((source) => source.state === "stale");
  if (stale.length > 0) {
    return {
      status: "stale",
      sources,
      reason: `有 ${stale.length} 篇来源在整理之后发生了变化；这是一份过期结果，可重新整理。`
    };
  }
  return { status: "fresh", sources };
}

export function useLightAgent(options: LightAgentOptions): LightAgentApi {
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const currentNow = () => optionsRef.current.now ?? (() => new Date());
  const callGateway = useMemo(
    () => options.callGateway ?? createAiGatewayCaller(),
    [options.callGateway]
  );
  const listConfigs = options.listConfigs ?? listAiConfigs;

  const [status, setStatus] = useState<LightAgentStatus>("loading-config");
  const [message, setMessage] = useState<string>();
  const [configs, setConfigs] = useState<AiPublicConfig[]>([]);
  const [selectedConfigId, setSelectedConfigId] = useState("");
  const [goal, setGoal] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [pendingStart, setPendingStart] = useState(false);
  const [proposal, setProposal] = useState<AiProposal>();
  const [task, setTask] = useState<AiTask>();
  const [trace, setTrace] = useState<LightAgentTraceStep[]>([]);
  const [recovered, setRecovered] = useState<LightAgentRecovered[]>([]);
  const [runInfo, setRunInfo] = useState<string>();
  const [recoveredMessage, setRecoveredMessage] = useState<string>();

  /**
   * F1 同款：派生状态与**实际参与计算的输入身份**一起保存并在渲染期比对，
   * 任一输入（proposal/archive/media）变化则本帧即失效，重算完成前不暴露旧结论。
   */
  const [viewEntry, setViewEntry] = useState<{
    proposalId: string;
    archive: ArchiveCore;
    media: readonly (Omit<NotebookMedia, "blob"> & { blob?: Blob })[];
    state: LightAgentViewState;
  }>();

  const opIdRef = useRef(0);
  const sessionIdRef = useRef(0);
  /**
   * R5：两个**确有独立并发操作**时才需要的序号：
   * - `scanSeqRef`：同范围的多次恢复扫描（刷新/丢弃后重扫）谁最新，旧扫描不得覆盖新列表；
   * - `jumpSeqRef`：来源跳转意图（等待 flush/回读期间又点了别的来源，旧意图作废）。
   * 其余身份继续复用现有 opId + 会话号，不新增全局状态、锁或 Manager。
   */
  const scanSeqRef = useRef(0);
  const jumpSeqRef = useRef(0);
  /** 当前展示的提案（供异步动作读取最新值，不把过期闭包当成当前状态）。 */
  const proposalRef = useRef<AiProposal | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const configsRef = useRef<AiPublicConfig[]>([]);
  const enabledRef = useRef(false);
  /**
   * 配置读取的有效性用**本 hook 实例的生命周期**判定（卸载才 +1），
   * 不用会话号：切换范围会换会话，但不该作废还没落地的「配置是否可用」读取。
   */
  const lifetimeRef = useRef(0);
  const statusRef = useRef<LightAgentStatus>("loading-config");
  /** **本 hook 实例自己创建的**任务 id：只有这些在卸载时可以取消。 */
  const ownedTaskIdsRef = useRef<Set<string>>(new Set());

  const scope = options.scope;
  const scopeSig = scopeSignature(scope);
  const scopeRef = useRef(scopeSig);
  useEffect(() => {
    scopeRef.current = scopeSig;
  }, [scopeSig]);

  const publish = useCallback((next: { status: LightAgentStatus; message?: string }) => {
    statusRef.current = next.status;
    setStatus(next.status);
    setMessage(next.message);
  }, []);

  const isCurrentFor = useCallback(
    (opId: number, sessionId: number, startedSig: string) =>
      isSessionIdentityCurrent({
        opId,
        currentOpId: opIdRef.current,
        // 范围身份由签名承担：它变了就等于换了会话目标。
        sessionPageId: startedSig,
        currentPageId: scopeRef.current,
        sessionId,
        currentSessionId: sessionIdRef.current
      }),
    []
  );

  /** 任务的合法终态迁移；CAS/终态冲突说明别的路径已推进，以库中实际值为准。 */
  const settleTaskCancelled = useCallback(async (taskId: string): Promise<void> => {
    const ai = optionsRef.current.ai;
    const stored = await ai.getTask(taskId).catch(() => null);
    if (!stored) return;
    const next = transitionAiTask(stored, "cancelled", {}, currentNow(), stored.revision);
    if (!next.ok) return;
    try {
      await ai.saveTask(next.task, { expectedRevision: stored.revision });
    } catch {
      // 状态写入失败不改变本方法的结论：以库中实际值为准。
    }
  }, []);

  // —— 配置可用性 + P8 独立开关（仅读取，不构成模型调用） ——
  const loadConfigs = useCallback(async () => {
    const lifetime = lifetimeRef.current;
    const result = await listConfigs();
    if (lifetimeRef.current !== lifetime) return result;
    if (result.status === "available") {
      configsRef.current = result.configs;
      setConfigs(result.configs);
      setSelectedConfigId(
        (currentId) => currentId || (result.configs.length === 1 ? result.configs[0].id : "")
      );
      // P8 独立开关：即使模型可用，未显式开启也不进入可执行状态。
      enabledRef.current = result.p8Enabled;
      publish(
        result.p8Enabled ? { status: "idle" } : { status: "disabled", message: DISABLED_MESSAGE }
      );
      return result;
    }
    configsRef.current = [];
    setConfigs([]);
    enabledRef.current = false;
    publish({
      status: "config-missing",
      message:
        result.status === "disabled"
          ? result.reason === "development-only"
            ? CONFIG_DEV_ONLY_MESSAGE
            : CONFIG_MISSING_MESSAGE
          : `读取模型配置失败：${result.detail}`
    });
    return result;
  }, [listConfigs, publish]);

  useEffect(() => {
    if (!options.enabled) return;
    let cancelled = false;
    void (async () => {
      await loadConfigs();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [options.enabled, loadConfigs]);

  // —— 来源状态派生：源变化/删除后界面立即标记（只读，不自动重生成） ——
  const archive = options.archive;
  const media = options.media;
  useEffect(() => {
    if (!proposal) {
      /* eslint-disable-next-line react-hooks/set-state-in-effect */
      setViewEntry(undefined);
      return;
    }
    let cancelled = false;
    void (async () => {
      const next = await deriveCollectionSourceState(proposal, { archive, media });
      if (!cancelled) setViewEntry({ proposalId: proposal.id, archive, media, state: next });
    })();
    return () => {
      cancelled = true;
    };
  }, [proposal, archive, media]);

  useEffect(() => {
    proposalRef.current = proposal;
  }, [proposal]);

  // —— 只读恢复扫描：不自动请求、不自动应用、不修改任何任务或建议 ——
  const loadRecovered = useCallback(
    async (scanId: number, startedSig: string, opId: number, sessionId: number) => {
      /** R5：扫描身份 = 最新扫描序号 + 操作序号 + 会话 + 范围签名。 */
      const isCurrentScan = () =>
        scanSeqRef.current === scanId && isCurrentFor(opId, sessionId, startedSig);
      if (!isCurrentScan()) return;
      const ai = optionsRef.current.ai;
      const context = { archive: optionsRef.current.archive, media: optionsRef.current.media };
      let tasks: AiTask[];
      try {
        tasks = (await ai.listTasks()).filter((item) => item.type === "organize_collection");
      } catch (error) {
        // R5：读取失败必须可见——不伪装成「没有历史结果」。
        if (!isCurrentScan()) return;
        setRecovered([]);
        setRunInfo(undefined);
        setRecoveredMessage(`读取历史整理结果失败：${describe(error)}`);
        return;
      }
      if (!isCurrentScan()) return;
      setRecoveredMessage(undefined);

      let loaded: ({ proposal: AiProposal; task: AiTask } | null)[];
      try {
        loaded = await Promise.all(
          tasks.map(async (item) => {
            if (!item.proposalId) return null;
            const stored = await ai.getProposal(item.proposalId);
            return stored ? { proposal: stored, task: item } : null;
          })
        );
      } catch (error) {
        if (!isCurrentScan()) return;
        setRecoveredMessage(`读取历史整理结果失败：${describe(error)}`);
        return;
      }
      const pairs = loaded.filter(
        (entry): entry is { proposal: AiProposal; task: AiTask } =>
          entry !== null &&
          entry.proposal.type === "organize_collection" &&
          entry.proposal.status !== "rejected" &&
          entry.proposal.payload.kind === "organize_collection" &&
          // 只展示**同一范围**的既有结果：换范围不会把上一范围的结论带过来。
          sameScope(entry.proposal.payload.scope, optionsRef.current.scope)
      );
      if (!isCurrentScan()) return;

      const entries: LightAgentRecovered[] = [];
      for (const pair of pairs) {
        const view = await deriveCollectionSourceState(pair.proposal, context);
        // 逐条派生后即判定：旧扫描既不做无谓工作，也不可能发布。
        if (!isCurrentScan()) return;
        entries.push({ proposal: pair.proposal, task: pair.task, view });
      }
      entries.sort((left, right) =>
        right.proposal.createdAt.localeCompare(left.proposal.createdAt)
      );
      // R5：**最终发布前**重判扫描序号 + 操作序号 + 会话 + 范围。
      if (!isCurrentScan()) return;
      setRecovered(entries);
      const running = tasks.filter((item) => item.status === "running");
      setRunInfo(
        running.length > 0
          ? `有 ${running.length} 个整理任务显示为运行中。可能是本机上次退出留下的，也可能是另一标签正在执行；` +
              "无法确认归属时不会改动它们。"
          : undefined
      );
    },
    [isCurrentFor]
  );

  // 范围变化：作废在途操作、清掉上一条结果，并按新范围重新扫描。
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    opIdRef.current += 1;
    sessionIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setProposal(undefined);
    setTask(undefined);
    setTrace([]);
    setViewEntry(undefined);
    setRecovered([]);
    setRunInfo(undefined);
    // 配置/开关尚未确定时保持原状态：不能把「还在读配置」提前说成 idle。
    if (
      statusRef.current !== "loading-config" &&
      statusRef.current !== "config-missing" &&
      statusRef.current !== "disabled"
    ) {
      publish({ status: "idle" });
    }
    setRecoveredMessage(undefined);
    void loadRecovered(
      (scanSeqRef.current += 1),
      scopeSignature(optionsRef.current.scope),
      opIdRef.current,
      sessionIdRef.current
    );
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [scopeSig, publish, loadRecovered]);

  /**
   * 卸载：取消本会话尚未完成的生成请求并使旧回调失效。
   * 只处理**本实例创建**的任务；另一标签的任务不在 owned 里，绝不改写。
   */
  const settleTaskRef = useRef(settleTaskCancelled);
  useEffect(() => {
    settleTaskRef.current = settleTaskCancelled;
  });
  useEffect(() => {
    const owned = ownedTaskIdsRef.current;
    return () => {
      lifetimeRef.current += 1;
      opIdRef.current += 1;
      sessionIdRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      for (const taskId of owned) {
        void (async () => {
          const stored = await optionsRef.current.ai.getTask(taskId).catch(() => null);
          if (!stored || (stored.status !== "queued" && stored.status !== "running")) return;
          await settleTaskRef.current(taskId);
        })();
      }
      owned.clear();
    };
  }, []);

  const reloadRecovered = useCallback(async () => {
    // 每次扫描都换新序号：同范围的旧扫描不得覆盖新扫描的结果。
    await loadRecovered(
      (scanSeqRef.current += 1),
      scopeRef.current,
      opIdRef.current,
      sessionIdRef.current
    );
  }, [loadRecovered]);

  const reloadConfig = useCallback(async () => {
    await loadConfigs();
  }, [loadConfigs]);

  // —— 生成（唯一发模型请求的路径） ——
  const generate = useCallback(
    async (startedSig: string) => {
      const opId = (opIdRef.current += 1);
      const sessionId = sessionIdRef.current;
      const current = optionsRef.current;
      const targetGoal = goal.trim();
      if (!current.enabled || targetGoal.length === 0) return;
      // P8 独立开关：未启用时明确说明，且不发出任何请求（服务端也会拒绝）。
      if (!enabledRef.current) {
        publish({ status: "disabled", message: DISABLED_MESSAGE });
        return;
      }
      const configId = selectedConfigId;
      if (!configId) {
        publish({ status: "config-missing", message: CONFIG_MISSING_MESSAGE });
        return;
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setProposal(undefined);
      setTask(undefined);
      setTrace([]);
      publish({ status: "running" });

      let flushed: boolean;
      try {
        flushed = await current.onFlush();
      } catch {
        flushed = false;
      }
      if (!isCurrentFor(opId, sessionId, startedSig)) return;
      if (!flushed) {
        publish({ status: "failed", message: "保存未完成，已停止整理；草稿与已有结果均保留。" });
        return;
      }

      // flush 之后读取**权威档案**：不用保存前的 props 冻结来源。
      const afterFlush = optionsRef.current;
      let freshArchive: ArchiveCore;
      try {
        freshArchive = await afterFlush.loadArchive();
      } catch (error) {
        if (!isCurrentFor(opId, sessionId, startedSig)) return;
        publish({ status: "failed", message: `读取已保存笔记本失败：${describe(error)}` });
        return;
      }
      if (!isCurrentFor(opId, sessionId, startedSig)) return;

      const frozenScope = afterFlush.scope;
      const contextOptions: AiContextProviderOptions = {
        archive: freshArchive,
        media: afterFlush.media
      };
      const readScope = createAiReadScope({
        notebookIds: frozenScope.notebookIds,
        maxPages: LIGHT_AGENT_BUDGETS.maxReadPages,
        maxTotalTextChars: LIGHT_AGENT_BUDGETS.maxReadChars
      });
      // 空范围：明确拒绝，零模型请求（与执行器的 AI_SCOPE_EMPTY 同一口径）。
      if (aiVisiblePages(freshArchive, readScope).length === 0) {
        publish({
          status: "failed",
          message: "本次范围内没有可读取的篇（已删除、已归档或不在选定笔记本内）；未发出模型请求。"
        });
        return;
      }

      const timestamp = currentNow()().toISOString();
      const queuedTask: AiTask = {
        id: (afterFlush.createId ?? defaultCollectionTaskId)(),
        type: "organize_collection",
        status: "queued",
        input: {
          goal: targetGoal,
          scope: frozenScope,
          maxOutputChars: LIGHT_AGENT_BUDGETS.maxSynthOutputChars
        },
        promptId: LIGHT_AGENT_PLAN_PROMPT.id,
        promptVersion: LIGHT_AGENT_PLAN_PROMPT.version,
        revision: 0,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      ownedTaskIdsRef.current.add(queuedTask.id);
      setTask(queuedTask);

      let outcome: Awaited<ReturnType<typeof runOrganizeCollectionTask>>;
      try {
        outcome = await runOrganizeCollectionTask(
          {
            context: contextOptions,
            ai: afterFlush.ai,
            callGateway,
            selectConfig: () => configId,
            ...(afterFlush.allowedOptions ? { allowedOptions: afterFlush.allowedOptions } : {}),
            loadArchive: () => optionsRef.current.loadArchive(),
            scope: {
              notebookIds: frozenScope.notebookIds,
              maxPages: LIGHT_AGENT_BUDGETS.maxReadPages,
              maxTotalTextChars: LIGHT_AGENT_BUDGETS.maxReadChars
            },
            now: currentNow(),
            signal: controller.signal
          },
          queuedTask
        );
      } catch (error) {
        // 执行器内部异常（例如取消与别的路径竞争 CAS）也要如实可见，不能静默停住。
        if (!isCurrentFor(opId, sessionId, startedSig)) return;
        publish({ status: "failed", message: `整理中断：${describe(error)}` });
        return;
      }
      if (!isCurrentFor(opId, sessionId, startedSig)) return;

      setTask(outcome.task);
      if (outcome.status === "not-run") {
        // 未接管（状态竞争/非法迁移）：不改写任何任务记录。
        setTrace([]);
        publish({
          status: "failed",
          message: `整理未执行（${outcome.reason}），任务状态未变化。`
        });
        return;
      }
      setTrace(outcome.trace);
      if (outcome.status === "completed") {
        setProposal(outcome.proposal);
        publish({
          status: "ready",
          message: `已整理 ${outcome.readCount} 篇，按主题分组（只读建议）。`
        });
        return;
      }
      if (outcome.status === "empty") {
        publish({ status: "empty", message: outcome.detail });
        return;
      }
      if (outcome.status === "cancelled") {
        publish({ status: "cancelled", message: "已取消整理；迟到结果不会出现。" });
        return;
      }
      if (outcome.status === "failed") {
        publish({ status: "failed", message: `整理失败（${outcome.code}）：${outcome.detail}` });
        return;
      }
    },
    [callGateway, goal, isCurrentFor, publish, selectedConfigId]
  );

  const requestStart = useCallback(() => {
    const current = optionsRef.current;
    if (!current.enabled) return;
    if (!enabledRef.current) {
      // 未读/未配置：重新读一次配置（零模型请求）；已读到开关关闭：明确说明。
      if (statusRef.current === "config-missing") void loadConfigs();
      else if (statusRef.current !== "loading-config") {
        publish({ status: "disabled", message: DISABLED_MESSAGE });
      }
      return;
    }
    if (goal.trim().length === 0) {
      publish({
        status: statusRef.current,
        message: "先写下这次要整理什么（例如：整理提到咖啡的篇）。"
      });
      return;
    }
    if (!agreed) {
      setPendingStart(true);
      return;
    }
    void generate(scopeRef.current);
  }, [agreed, generate, goal, loadConfigs, publish]);

  const cancelStart = useCallback(() => setPendingStart(false), []);

  const confirmStart = useCallback(async () => {
    setAgreed(true);
    setPendingStart(false);
    await generate(scopeRef.current);
  }, [generate]);

  const cancel = useCallback(async () => {
    const opId = (opIdRef.current += 1);
    abortRef.current?.abort();
    abortRef.current = null;
    const currentTask = task;
    if (currentTask) await settleTaskCancelled(currentTask.id);
    if (opIdRef.current !== opId) return;
    publish({ status: "cancelled", message: "已取消整理；迟到结果不会出现。" });
  }, [publish, settleTaskCancelled, task]);

  const discard = useCallback(
    async (proposalId: string) => {
      const ai = optionsRef.current.ai;
      /*
       * R5：目标是**这一份**提案，持久化动作与 UI 发布分开。
       * 入参即身份，因此不需要用闭包里的 proposal 或"当前会话"去猜要丢哪一份。
       */
      const sessionId = sessionIdRef.current;
      const opId = opIdRef.current;
      const isCurrentDiscard = () => sessionIdRef.current === sessionId && opIdRef.current === opId;
      try {
        const stored = await ai.getProposal(proposalId);
        if (!stored || stored.type !== "organize_collection") return;
        const rejected = rejectProposal(stored, currentNow());
        if (rejected === stored) return;
        // CAS + draft 约束保持有效：只把这一份 draft 改成 rejected。
        await ai.saveProposal(rejected, { expectedRevision: stored.revision });
      } catch (error) {
        // 当前会话的真实保存错误必须可见；已切走则不污染新会话。
        if (isCurrentDiscard()) {
          publish({ status: statusRef.current, message: `丢弃失败：${describe(error)}` });
        }
        return;
      }
      // 会话已换：不通知、不刷新、不清空新会话的任何结果。
      if (!isCurrentDiscard()) return;
      if (optionsRef.current.onNotice) {
        optionsRef.current.onNotice("已丢弃这份整理建议（未写入笔记本）。");
      }
      await reloadRecovered();
      /*
       * 期间已发起新的生成/切换（opId 变化）→ 不发布任何 UI 变化，
       * 免得旧丢弃清掉新提案或把状态改成 idle。
       */
      if (opIdRef.current !== opId || sessionIdRef.current !== sessionId) return;
      if (proposalRef.current?.id !== proposalId) return;
      setProposal(undefined);
      setViewEntry(undefined);
      publish({ status: "idle", message: "已丢弃这份整理建议（未写入笔记本）。" });
    },
    [publish, reloadRecovered]
  );

  const resume = useCallback(
    (proposalId: string) => {
      const entry = recovered.find((item) => item.proposal.id === proposalId);
      if (!entry) return;
      opIdRef.current += 1;
      setProposal(entry.proposal);
      setViewEntry(undefined);
      setTask(entry.task ?? undefined);
      setTrace([]);
      publish({
        status: "ready",
        message: "这是之前生成的整理建议（只读）。"
      });
    },
    [publish, recovered]
  );

  /**
   * 打开来源篇：先走既有保存协调，再用**提案冻结范围**复核来源资格（R3）。
   *
   * R5：跳转意图有序号——等待 flush/回读期间用户切换范围、卸载或点了另一来源，
   * 旧意图立即作废（连错误消息也不写入新会话）。
   */
  const openSource = useCallback(
    async (pageId: string) => {
      const jumpId = (jumpSeqRef.current += 1);
      const sessionId = sessionIdRef.current;
      const isCurrentJump = () =>
        jumpSeqRef.current === jumpId && sessionIdRef.current === sessionId;
      const notify = (text: string) => {
        if (!isCurrentJump()) return;
        publish({ status: statusRef.current, message: text });
      };
      const target = proposalRef.current;
      if (!target) return;
      const ref = target.sourceRefs.find((item) => item.kind === "page" && item.id === pageId);
      if (!ref) {
        notify("目标篇不属于这份整理建议的来源，未跳转。");
        return;
      }
      const scope = target.payload.kind === "organize_collection" ? target.payload.scope : null;
      const current = optionsRef.current;
      let flushed: boolean;
      try {
        flushed = await current.onFlush();
      } catch {
        flushed = false;
      }
      if (!isCurrentJump()) return;
      if (!flushed) {
        notify("保存未完成，未跳转来源；草稿保留。");
        return;
      }
      let freshArchive: ArchiveCore;
      try {
        freshArchive = await current.loadArchive();
      } catch (error) {
        notify(`读取已保存笔记本失败：${describe(error)}`);
        return;
      }
      if (!isCurrentJump()) return;
      const [check] = await checkCollectionSources(
        [{ id: ref.id, sourceDigest: ref.sourceDigest, title: "" }],
        { archive: freshArchive, scope }
      );
      if (!isCurrentJump()) return;
      if (!check || check.state === "unavailable") {
        notify("目标篇已删除或已不在本次冻结范围内，未跳转。");
        return;
      }
      if (!current.onOpenPage) return;
      const opened = await current.onOpenPage(pageId);
      if (!isCurrentJump()) return;
      if (opened === false) notify("目标篇当前不可打开（可能已删除）。");
    },
    [publish]
  );

  const result = useMemo(
    () =>
      proposal && proposal.payload.kind === "organize_collection"
        ? proposal.payload.result
        : undefined,
    [proposal]
  );

  const viewState = useMemo(
    () =>
      viewEntry &&
      proposal &&
      viewEntry.proposalId === proposal.id &&
      viewEntry.archive === archive &&
      viewEntry.media === media
        ? viewEntry.state
        : undefined,
    [viewEntry, proposal, archive, media]
  );

  return {
    status,
    message,
    configs,
    selectedConfigId,
    selectConfig: setSelectedConfigId,
    goal,
    setGoal,
    scope,
    agreed,
    pendingStart,
    requestStart,
    cancelStart,
    confirmStart,
    proposal,
    result,
    viewState,
    trace,
    recovered,
    runInfo,
    recoveredMessage,
    reloadRecovered,
    reloadConfig,
    cancel,
    discard,
    resume,
    openSource
  };
}

/** 任务 ID：毫秒 + 单调序号 + 随机后缀；同一毫秒内的并发点击不碰撞。 */
let collectionTaskSequence = 0;
function defaultCollectionTaskId(): string {
  collectionTaskSequence += 1;
  return `col-task-${Date.now().toString(36)}-${collectionTaskSequence.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { AiPageContext };
