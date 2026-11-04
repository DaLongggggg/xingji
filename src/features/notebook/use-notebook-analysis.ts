"use client";

/**
 * P4：本册智能整理的**唯一协调入口**（flush → 冻结来源 → 任务 → 只读结果 → 恢复）。
 *
 * 边界（Ponytail）：
 * - 不建 AI Manager / Service / 全局 store / 任务队列；状态与动作都在这一个 hook 内；
 * - 持久化与执行复用 P1/P4 既有契约（AiRepository / runAnalyzeNotebookTask /
 *   createAiContextProvider / flushAutosave），不新造写路径；
 * - **只读**：分析结果不进入 accepted/applied，不写正文、媒体与业务收据；
 * - 异步回调按「目标本身份 + 会话序号 + 操作次序号」三层判定有效性，
 *   不读“当时选中的本”、不靠“options ref 之后会更新”的假设；
 * - 恢复只读扫描任务与建议，**不修改归属不明的任务**（无法证明中断就不写）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createAiContextProvider,
  createAiReadScope,
  notebookSourceDigest,
  type AiContextProviderOptions,
  type AiPageContext
} from "@/features/ai/ai-context";
import {
  createAiGatewayCaller,
  listAiConfigs,
  type AiGatewayCaller,
  type AiPublicConfig
} from "@/features/ai/ai-gateway-client";
import type { NotebookAnalysisResult } from "@/features/ai/ai-notebook-result-schema";
import {
  notebookAnalysisGate,
  runAnalyzeNotebookTask,
  NOTEBOOK_ANALYSIS_BUDGETS,
  type AnalyzeNotebookCoverage
} from "@/features/ai/ai-notebook-runner";
import { transitionAiTask, type AiTask } from "@/features/ai/ai-task";
import { NOTEBOOK_ANALYSIS_PROMPT } from "@/features/ai/prompts/notebook-analysis";
import type { AiProposal } from "@/features/ai/ai-proposal";
import type { AiRepository } from "@/features/ai/ai-repository";
import type { NotebookMedia } from "@/features/notebook/notebook-model";
import type { ArchiveCore } from "@/features/notebook/notebook-repository";
import { isSessionIdentityCurrent } from "./use-page-organize";

export type NotebookAnalysisStatus =
  | "loading-config"
  | "idle"
  | "config-missing"
  | "generating"
  | "ready"
  | "failed"
  | "cancelled";

/** 单篇来源相对冻结摘要的当前状态。 */
export type NotebookAnalysisSourceState = {
  pageId: string;
  title: string;
  state: "fresh" | "stale" | "unavailable";
};

export type NotebookAnalysisViewState = {
  /** 只要有来源不可读就不展示为“有效”；有来源变化则为 stale。 */
  status: "fresh" | "stale" | "unavailable";
  sources: NotebookAnalysisSourceState[];
  /** 分析冻结时覆盖的篇数。 */
  frozenCount: number;
  /** 当前本可见篇数（分母）；与冻结值不同说明本册已变化。 */
  currentCount: number;
  /** 面向用户的过期/不可用说明；fresh 时为 undefined。 */
  reason?: string;
};

/**
 * 从冻结来源与**当前**档案派生来源状态。
 *
 * 可见性与摘要都走 `AiContextProvider`（`pageAvailability` + `pageSourceDigest`），
 * 不在这里复制第二套可见性判断：源被删除/不可读 → unavailable；
 * 源内容变化 → stale；否则 fresh。
 */
export async function deriveAnalysisSourceState(
  proposal: AiProposal,
  context: AiContextProviderOptions
): Promise<NotebookAnalysisViewState> {
  const provider = createAiContextProvider(context);
  const sources: NotebookAnalysisSourceState[] = [];
  for (const ref of proposal.sourceRefs) {
    if (ref.kind !== "page") continue;
    const page = await provider.getPage(ref.id);
    if (!page) {
      sources.push({ pageId: ref.id, title: "(已不可用)", state: "unavailable" });
      continue;
    }
    sources.push({
      pageId: page.id,
      title: page.title,
      state: page.sourceDigest === ref.sourceDigest ? "fresh" : "stale"
    });
  }

  const notebookId =
    proposal.payload.kind === "analyze_notebook" ? proposal.payload.notebookId : "";
  const currentPages = notebookId
    ? await provider.listNotebookPages(notebookId, { scope: { notebookIds: [notebookId] } })
    : [];
  const currentCount = currentPages.length;

  const unavailable = sources.filter((source) => source.state === "unavailable");
  const stale = sources.filter((source) => source.state === "stale");
  if (unavailable.length > 0) {
    return {
      status: "unavailable",
      sources,
      frozenCount: sources.length,
      currentCount,
      reason: `有 ${unavailable.length} 篇来源已删除或不可读；本次分析不再作为当前结论展示。`
    };
  }
  if (stale.length > 0) {
    return {
      status: "stale",
      sources,
      frozenCount: sources.length,
      currentCount,
      reason: `有 ${stale.length} 篇来源在分析之后发生了变化；这是一份过期结果，可重新生成。`
    };
  }
  if (currentCount !== sources.length) {
    return {
      status: "stale",
      sources,
      frozenCount: sources.length,
      currentCount,
      reason: `本次分析基于当时的 ${sources.length} 篇；本册现有 ${currentCount} 篇，新篇未纳入，可重新生成。`
    };
  }
  return { status: "fresh", sources, frozenCount: sources.length, currentCount };
}

/** 一条可恢复的**只读**分析及它的关联任务（成对读取，不用界面上的上一条任务替代）。 */
export type NotebookAnalysisRecovered = {
  proposal: AiProposal;
  task: AiTask | null;
  view: NotebookAnalysisViewState;
};

export type NotebookAnalysisApi = {
  status: NotebookAnalysisStatus;
  message?: string;
  configs: AiPublicConfig[];
  selectedConfigId: string;
  selectConfig: (configId: string) => void;
  /** 当前展示的分析（只读）。 */
  proposal?: AiProposal;
  task?: AiTask;
  result?: NotebookAnalysisResult;
  /** 当前展示分析的来源状态（fresh/stale/unavailable）。 */
  viewState?: NotebookAnalysisViewState;
  /** 覆盖范围：分析基于多少篇；本册现有多少篇。 */
  coverage?: AnalyzeNotebookCoverage;
  /** 刷新后可恢复的分析（只读；需用户显式查看，不自动请求）。 */
  recovered: NotebookAnalysisRecovered[];
  /** 归属不明的运行中任务：只读说明，无修改入口。 */
  runInfo?: string;
  reloadRecovered: () => Promise<void>;
  reloadConfig: () => Promise<void>;
  /** 生成一次本册分析；未同意/未配置/空本/超预算都在这里明确拒绝且零模型请求。 */
  generate: () => Promise<void>;
  cancel: () => Promise<void>;
  /** 恢复一条已生成的分析到只读展示。 */
  resume: (proposalId: string) => void;
  /** 打开来源篇：先经既有保存协调，失败留在原会话并提示。 */
  openSource: (pageId: string) => Promise<boolean>;
};

const CONFIG_MISSING_MESSAGE = "尚未配置可用模型，请前往设置添加。";
const CONFIG_DEV_ONLY_MESSAGE = "AI 未开启。";

export type NotebookAnalysisOptions = {
  ai: AiRepository;
  /** 当前选中的笔记本；空串表示没有目标。只有它作为分析目标。 */
  notebookId: string;
  /** 渲染期的档案快照：用于派生来源是否过期（源变化后界面随即标记）。 */
  archive: ArchiveCore;
  /** 媒体元数据快照（不读 Blob）。 */
  media: (Omit<NotebookMedia, "blob"> & { blob?: Blob })[];
  /**
   * flush 之后的**权威**档案读取（例如 `notebookRepository.loadArchive()`）：
   * React 可能尚未重渲染，不能拿保存前的 props 当已保存内容来冻结来源。
   */
  loadArchive: () => Promise<ArchiveCore>;
  enabled: boolean;
  /** 现有保存协调入口（`flushAutosave`）：返回 false 立即停止，不基于旧内容分析。 */
  onFlush: () => Promise<boolean>;
  /** 打开来源篇（复用既有打开篇与自动保存协调）；返回 false 表示未离开当前会话。 */
  onOpenPage?: (pageId: string) => Promise<boolean> | boolean;
  onNotice?: (message: string) => void;
  callGateway?: AiGatewayCaller;
  listConfigs?: typeof listAiConfigs;
  now?: () => Date;
  createId?: () => string;
};

export function useNotebookAnalysis(options: NotebookAnalysisOptions): NotebookAnalysisApi {
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const currentNow = () => optionsRef.current.now ?? (() => new Date());
  const currentContext = (archive: ArchiveCore): AiContextProviderOptions => ({
    archive,
    media: optionsRef.current.media
  });
  const callGateway = useMemo(
    () => options.callGateway ?? createAiGatewayCaller(),
    [options.callGateway]
  );
  const listConfigs = options.listConfigs ?? listAiConfigs;

  const [status, setStatus] = useState<NotebookAnalysisStatus>("loading-config");
  const [message, setMessage] = useState<string>();
  const [configs, setConfigs] = useState<AiPublicConfig[]>([]);
  const [selectedConfigId, setSelectedConfigId] = useState("");
  const [proposal, setProposal] = useState<AiProposal>();
  const [task, setTask] = useState<AiTask>();
  /**
   * R3/F1：派生状态与**实际参与计算的输入身份**一起保存。
   *
   * 只绑定 `proposalId` 不够：同一建议在 `archive`/`media` 变化后会被异步重算，
   * 重算期间旧状态仍然“匹配 proposalId”，面板因此还会满足派生正文的渲染条件，
   * 在来源已删除后的提交帧里继续显示旧 `fresh`（Astra F1 观察到 `[fresh, unavailable]`）。
   * 这里把计算时用的 `proposal`/`archive`/`media` 引用一并冻结并在渲染期比对：
   * 任一输入变化，本帧即失效（不需要等 effect 清空），重算完成后才重新暴露。
   *
   * 当前解决的问题只有一个：不让“上一次计算的结论”被当成“当前输入下的结论”。
   */
  const [viewEntry, setViewEntry] = useState<{
    proposalId: string;
    /** 计算时的档案与媒体快照（引用比较，正是 derive 实际消费的对象）。 */
    archive: ArchiveCore;
    media: (Omit<NotebookMedia, "blob"> & { blob?: Blob })[];
    state: NotebookAnalysisViewState;
  }>();
  const [recovered, setRecovered] = useState<NotebookAnalysisRecovered[]>([]);
  const [runInfo, setRunInfo] = useState<string>();

  /** 次序号：每次生成/取消/切本/换会话 +1；旧回调据此作废。 */
  const opIdRef = useRef(0);
  /**
   * 会话号：每次进入一个本（含切走再切回）都换新号。
   * 只比较 notebookId 会把“离开后回到同一本”的迟到结果误判为仍然有效。
   */
  const sessionIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const configsRef = useRef<AiPublicConfig[]>([]);
  const statusRef = useRef<NotebookAnalysisStatus>("loading-config");
  /** **本 hook 实例自己创建的**任务 id：只有这些在卸载时可以取消。 */
  const ownedTaskIdsRef = useRef<Set<string>>(new Set());

  const publish = useCallback((next: { status: NotebookAnalysisStatus; message?: string }) => {
    statusRef.current = next.status;
    setStatus(next.status);
    setMessage(next.message);
  }, []);

  const isCurrentFor = useCallback(
    (opId: number, notebookId: string, sessionId: number) =>
      isSessionIdentityCurrent({
        opId,
        currentOpId: opIdRef.current,
        sessionPageId: notebookId,
        currentPageId: optionsRef.current.notebookId,
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

  // —— 配置可用性（仅获取配置不构成模型调用） ——
  const loadConfigs = useCallback(async () => {
    const result = await listConfigs();
    if (result.status === "available") {
      configsRef.current = result.configs;
      setConfigs(result.configs);
      setSelectedConfigId((currentId) =>
        currentId || (result.configs.length === 1 ? result.configs[0].id : "")
      );
      publish({ status: "idle" });
      return result;
    }
    configsRef.current = [];
    setConfigs([]);
    if (result.status === "disabled") {
      publish({
        status: "config-missing",
        message:
          result.reason === "development-only" ? CONFIG_DEV_ONLY_MESSAGE : CONFIG_MISSING_MESSAGE
      });
      return result;
    }
    publish({ status: "config-missing", message: `读取模型配置失败：${result.detail}` });
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

  // —— 来源状态派生：源变化/删除后界面立即标记（只读展示，不自动重生成） ——
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
      const next = await deriveAnalysisSourceState(proposal, { archive, media });
      // 迟到保护：输入在等待期间又变了就丢弃这次结果（引用比较，与暴露条件同一判据）。
      if (!cancelled) setViewEntry({ proposalId: proposal.id, archive, media, state: next });
    })();
    return () => {
      cancelled = true;
    };
  }, [proposal, archive, media]);

  // —— 只读恢复扫描：不自动请求、不自动应用、不修改任何任务或建议 ——
  const loadRecovered = useCallback(
    async (notebookId: string, opId: number, sessionId: number) => {
      const ai = optionsRef.current.ai;
      const context = currentContext(optionsRef.current.archive);
      if (!notebookId) {
        if (isCurrentFor(opId, notebookId, sessionId)) {
          setRecovered([]);
          setRunInfo(undefined);
        }
        return;
      }
      let tasks: AiTask[] = [];
      try {
        tasks = (await ai.listTasks()).filter(
          (item) => item.type === "analyze_notebook" && item.input.notebookId === notebookId
        );
      } catch {
        tasks = [];
      }
      if (!isCurrentFor(opId, notebookId, sessionId)) return;

      const pairs = (
        await Promise.all(
          tasks.map(async (item) => {
            if (!item.proposalId) return null;
            const stored = await ai.getProposal(item.proposalId).catch(() => null);
            return stored ? { proposal: stored, task: item } : null;
          })
        )
      ).filter(
        (entry): entry is { proposal: AiProposal; task: AiTask } =>
          entry !== null &&
          entry.proposal.type === "analyze_notebook" &&
          entry.proposal.status !== "rejected"
      );
      if (!isCurrentFor(opId, notebookId, sessionId)) return;

      const entries: NotebookAnalysisRecovered[] = [];
      for (const pair of pairs) {
        // 载荷与本 ID 必须一致：不接受属于别的本的分析挂到当前本上。
        if (
          pair.proposal.payload.kind !== "analyze_notebook" ||
          pair.proposal.payload.notebookId !== notebookId
        ) {
          continue;
        }
        entries.push({
          proposal: pair.proposal,
          task: pair.task,
          view: await deriveAnalysisSourceState(pair.proposal, context)
        });
      }
      entries.sort((left, right) =>
        right.proposal.createdAt.localeCompare(left.proposal.createdAt)
      );
      setRecovered(entries);
      const running = tasks.filter((item) => item.status === "running");
      setRunInfo(
        running.length > 0
          ? `有 ${running.length} 个本册分析任务显示为运行中。可能是本机上次退出留下的，也可能是另一标签正在执行；` +
            "无法确认归属时不会改动它们。"
          : undefined
      );
    },
    [isCurrentFor]
  );

  // 目标本变化（含离开再回来）：作废在途操作、清掉上一条结果，并按需重新扫描。
  const notebookId = options.notebookId;
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    opIdRef.current += 1;
    // 每次进入一个本都换新会话号：离开后回到同一本的迟到结果不再有效。
    sessionIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setProposal(undefined);
    setTask(undefined);
    setViewEntry(undefined);
    setRecovered([]);
    setRunInfo(undefined);
    if (statusRef.current !== "config-missing" && configsRef.current.length > 0) {
      publish({ status: "idle" });
    }
    if (notebookId.length > 0) {
      void loadRecovered(notebookId, opIdRef.current, sessionIdRef.current);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [notebookId, publish, loadRecovered]);

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
    await loadRecovered(optionsRef.current.notebookId, opIdRef.current, sessionIdRef.current);
  }, [loadRecovered]);

  const reloadConfig = useCallback(async () => {
    await loadConfigs();
  }, [loadConfigs]);

  // —— 生成 ——
  const generate = useCallback(async () => {
    const opId = (opIdRef.current += 1);
    const sessionId = sessionIdRef.current;
    const current = optionsRef.current;
    const targetNotebookId = current.notebookId;
    if (!current.enabled || targetNotebookId.length === 0) return;
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
    publish({ status: "generating" });

    let flushed: boolean;
    try {
      flushed = await current.onFlush();
    } catch {
      flushed = false;
    }
    if (!isCurrentFor(opId, targetNotebookId, sessionId)) return;
    if (!flushed) {
      publish({ status: "failed", message: "保存未完成，已停止本册分析；草稿与已有结果均保留。" });
      return;
    }

    // flush 之后读取**权威档案**：不用保存前的 props 冻结来源。
    const afterFlush = optionsRef.current;
    let freshArchive: ArchiveCore;
    try {
      freshArchive = await afterFlush.loadArchive();
    } catch (error) {
      if (!isCurrentFor(opId, targetNotebookId, sessionId)) return;
      publish({ status: "failed", message: `读取已保存笔记本失败：${describe(error)}` });
      return;
    }
    if (!isCurrentFor(opId, targetNotebookId, sessionId)) return;

    const context: AiContextProviderOptions = {
      archive: freshArchive,
      media: afterFlush.media
    };
    const provider = createAiContextProvider(context);
    const scope = createAiReadScope({ notebookIds: [targetNotebookId] });
    let pages: AiPageContext[];
    try {
      pages = await provider.listNotebookPages(targetNotebookId, { scope });
    } catch (error) {
      if (!isCurrentFor(opId, targetNotebookId, sessionId)) return;
      publish({ status: "failed", message: `读取本册失败：${describe(error)}` });
      return;
    }
    if (!isCurrentFor(opId, targetNotebookId, sessionId)) return;

    // 空本：明确拒绝，零模型请求。
    if (pages.length === 0) {
      publish({ status: "failed", message: "这一本还没有可分析的篇；先写一篇再试。" });
      return;
    }
    const notebooks = await provider.listNotebooks({ scope });
    const notebook = notebooks.find((item) => item.id === targetNotebookId);
    if (!notebook) {
      publish({ status: "failed", message: "目标笔记本当前不可用（已删除或已归档）。" });
      return;
    }
    const gate = notebookAnalysisGate(scope);
    const totalChars = pages.reduce((sum, page) => sum + page.text.length, 0);
    if (pages.length > gate.maxPages || totalChars > gate.maxTextChars) {
      // 超预算：明确拒绝并要求缩小范围，零模型请求。
      publish({
        status: "failed",
        message:
          `本册现有 ${pages.length} 篇、正文共 ${totalChars} 字，超过单次分析预算` +
          `（${gate.maxPages} 篇 / ${gate.maxTextChars} 字）；请缩小范围（分批或拆分本册）后再试；` +
          "不会截断后冒充整本分析。"
      });
      return;
    }

    const input = {
      notebookId: targetNotebookId,
      sources: pages.map((page) => ({ pageId: page.id, sourceDigest: page.sourceDigest })),
      notebookDigest: notebookSourceDigest(notebook, pages.map((page) => page.id)),
      maxOutputChars: NOTEBOOK_ANALYSIS_BUDGETS.maxOutputChars
    };
    const idFactory = afterFlush.createId ?? defaultTaskId;
    const timestamp = currentNow()().toISOString();
    const queuedTask: AiTask = {
      id: idFactory(),
      type: "analyze_notebook",
      status: "queued",
      input,
      promptId: NOTEBOOK_ANALYSIS_PROMPT.id,
      promptVersion: NOTEBOOK_ANALYSIS_PROMPT.version,
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    ownedTaskIdsRef.current.add(queuedTask.id);
    setTask(queuedTask);

    const outcome = await runAnalyzeNotebookTask(
      {
        context,
        ai: afterFlush.ai,
        callGateway,
        selectConfig: () => configId,
        scope: { notebookIds: [targetNotebookId] },
        now: currentNow(),
        signal: controller.signal
      },
      queuedTask
    );
    if (!isCurrentFor(opId, targetNotebookId, sessionId)) return;

    setTask(outcome.task);
    if (outcome.status === "completed") {
      setProposal(outcome.proposal);
      publish({ status: "ready" });
      return;
    }
    if (outcome.status === "cancelled") {
      publish({ status: "cancelled", message: "已取消本册分析。" });
      return;
    }
    if (outcome.status === "failed") {
      publish({ status: "failed", message: `本册分析失败（${outcome.code}）：${outcome.detail}` });
      return;
    }
    publish({ status: "failed", message: `本册分析未执行（${outcome.reason}），任务状态未变化。` });
  }, [callGateway, isCurrentFor, publish, selectedConfigId]);

  // —— 取消 ——
  const cancel = useCallback(async () => {
    const opId = (opIdRef.current += 1);
    abortRef.current?.abort();
    abortRef.current = null;
    const currentTask = task;
    if (currentTask) await settleTaskCancelled(currentTask.id);
    if (opIdRef.current !== opId) return;
    publish({ status: "cancelled", message: "已取消本册分析；迟到结果不会出现。" });
  }, [publish, settleTaskCancelled, task]);

  /** 恢复一条已生成的分析：只读展示，不重新请求。 */
  const resume = useCallback(
    (proposalId: string) => {
      const entry = recovered.find((item) => item.proposal.id === proposalId);
      if (!entry) return;
      opIdRef.current += 1;
      setProposal(entry.proposal);
      /*
       * R3：不预先套用恢复列表里的旧状态。状态由当前档案重新派生；
       * 派生完成前 `viewState` 为 undefined，面板不渲染派生正文。
       */
      setViewEntry(undefined);
      setTask(entry.task ?? undefined);
      publish({
        status: "ready",
        message:
          entry.view.status === "fresh"
            ? "这是之前生成的分析（只读）。"
            : "这是之前生成的分析，但来源已经变化；结果已标记为过期。"
      });
    },
    [publish, recovered]
  );

  /** 打开来源篇：先走既有保存协调；保存失败留在原会话并明确提示。 */
  const openSource = useCallback(
    async (pageId: string) => {
      const current = optionsRef.current;
      let flushed: boolean;
      try {
        flushed = await current.onFlush();
      } catch {
        flushed = false;
      }
      if (!flushed) {
        publish({ status: statusRef.current, message: "保存未完成，未跳转来源；草稿保留。" });
        return false;
      }
      if (!current.onOpenPage) return false;
      const opened = await current.onOpenPage(pageId);
      if (opened === false) {
        publish({ status: statusRef.current, message: "目标篇当前不可打开（可能已删除）。" });
        return false;
      }
      return true;
    },
    [publish]
  );

  const result = useMemo(
    () =>
      proposal && proposal.payload.kind === "analyze_notebook"
        ? proposal.payload.result
        : undefined,
    [proposal]
  );
  /**
   * F1：只有“本次渲染的 proposal/archive/media”与派生时使用的输入**全部一致**时，
   * 才对外暴露状态；否则视为尚未算出（面板不渲染派生正文）。
   * 这是渲染期判定，所以变更后的**第一个提交帧**就已经失效。
   */
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
  const coverage = useMemo((): AnalyzeNotebookCoverage | undefined => {
    if (!viewState) return undefined;
    return {
      totalVisible: viewState.currentCount,
      included: viewState.frozenCount,
      missing: viewState.sources
        .filter((source) => source.state === "unavailable")
        .map((source) => ({ pageId: source.pageId, reason: "unavailable" })),
      skipped: []
    };
  }, [viewState]);

  return {
    status,
    message,
    configs,
    selectedConfigId,
    selectConfig: setSelectedConfigId,
    proposal,
    task,
    result,
    viewState,
    coverage,
    recovered,
    runInfo,
    reloadRecovered,
    reloadConfig,
    generate,
    cancel,
    resume,
    openSource
  };
}

/** 任务 ID：毫秒 + 单调序号 + 随机后缀；同一毫秒内的并发点击不碰撞。 */
let taskSequence = 0;
function defaultTaskId(): string {
  taskSequence += 1;
  return `nb-task-${Date.now().toString(36)}-${taskSequence.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
