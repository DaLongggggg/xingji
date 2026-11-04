"use client";

/**
 * P2-01～P2-04：单篇 AI 整理的**唯一协调入口**（flush → 任务 → 预览 → 接受/拒绝 → 安全提交）。
 *
 * 边界（Ponytail）：
 * - 不建 AI Manager / Service / 全局 store / 任务队列；状态与动作都在这一个 hook 内；
 * - 持久化与写管线全部复用 P1 与 Notebook 既有契约（AiRepository / runOrganizePageTask /
 *   applyAiProposal / flushAutosave），这里不新造写路径，也不重建 Context/检索/收据；
 * - 异步回调按**目标页身份 + 编辑会话身份 + 操作次序号**三层判定有效性，
 *   不读“当时选中页”、不靠“optionsRef 之后会更新”的假设。
 * - 恢复只读扫描任务与建议，**不修改归属不明的任务**（无法证明中断就不写）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createAiContextProvider } from "@/features/ai/ai-context";
import {
  createAiGatewayCaller,
  listAiConfigs,
  type AiPublicConfig,
  type AiGatewayCaller
} from "@/features/ai/ai-gateway-client";
import {
  acceptProposal,
  previewProposal,
  rejectProposal,
  withdrawAcceptedProposal,
  type AiProposal
} from "@/features/ai/ai-proposal";
import { transitionAiTask, type AiTask } from "@/features/ai/ai-task";
import { runOrganizePageTask, TASK_BUDGETS } from "@/features/ai/ai-task-runner";
import {
  PAGE_ORGANIZE_PROMPT,
  PAGE_ORGANIZE_PROMPT_VERSION
} from "@/features/ai/prompts/page-organize";
import { applyAiProposal, type SafeCommitOutcome } from "@/features/ai/ai-safe-commit";
import type { AiRepository } from "@/features/ai/ai-repository";
import {
  digestPageBlocks,
  isPageDeleted,
  type NotebookMedia,
  type NotebookPage
} from "@/features/notebook/notebook-model";
import type { ArchiveCore, NotebookRepository } from "@/features/notebook/notebook-repository";
import { buildOrganizeTextView, type OrganizeTextView } from "./page-organize-diff";

/** 一次整理的界面状态；只表达“执行到哪一步”，不代表用户正文已修改。 */
export type PageOrganizeStatus =
  | "loading-config"
  | "idle"
  | "config-missing"
  | "generating"
  | "preview"
  | "applying"
  | "applied"
  | "conflict"
  | "failed"
  | "cancelled";

/**
 * 组件在生成/接受时冻结的编辑身份。
 * 异步回调据此判定是否仍指向同一篇、同一编辑会话。
 *
 * `readDraftMarkdown` / `readEditSequence` 是**回调**（读最新草稿），
 * 其余字段是**冻结值**（发起动作那一刻的快照）——两者不能混用。
 */
export type PageOrganizeSession = {
  pageId: string;
  sessionId: number;
  /** 打开/上次成功保存后的页基线。 */
  baselineUpdatedAt: string;
  baselineBlocksDigest: string;
  /** 提交时读取**当前草稿正文**（确认接受的是已保存的那一版）。 */
  readDraftMarkdown: () => string;
  /** 草稿基线正文（beginEdit / 上次成功提交时冻结）。 */
  baselineMarkdown: string;
  /** 读取**当前**编辑序号（与冻结序号比较，判断应用窗口内是否有新输入）。 */
  readEditSequence?: () => number;
  /** 发起动作时冻结的编辑序号。 */
  committedEditSequence?: number;
};

export type PageOrganizeOptions = {
  ai: AiRepository;
  notebooks: NotebookRepository;
  /** 每个渲染传入当前选中篇；只有它作为整理目标。 */
  target: NotebookPage | null;
  /**
   * 当前编辑会话号（同一篇重新进入编辑会变新号）。
   * 用于识别“同一 pageId 的新编辑会话”，旧回调据此失效。
   */
  targetSessionId?: number;
  /** 领域快照提供者：每次需要时读取**最新**档案，不缓存旧 props。 */
  getArchive: () => ArchiveCore;
  getMedia: () => readonly (Omit<NotebookMedia, "blob"> & { blob?: Blob })[];
  /**
   * 读取**保存后本会话的最新权威基线**（Q4）。
   *
   * 组件在 flush 成功后调用它，返回实际提交页的 `updatedAt`/块摘要与冻结草稿。
   * 这样“自己刚保存的输入”不会被保存前的旧基线误判为外部冲突；
   * 返回 `undefined` 表示调用方没有可用基线（例如测试装配），此时回退到传入的 session 基线。
   */
  readBaseline?: () => PageOrganizeBaseline | undefined;
  enabled: boolean;
  /** 现有保存协调入口（`flushAutosave`）：返回 false 立即停止，不基于旧内容整理。 */
  onFlush: () => Promise<boolean>;
  /** 安全提交成功后：刷新档案并合并编辑基线（由 notebook-page 提供实际合并逻辑）。 */
  onApplied: (
    page: NotebookPage,
    /** 是否可安全刷新编辑器正文：应用期间没有新输入时为 true。 */
    apply: { refreshEditor: boolean },
    session: PageOrganizeSession
  ) => Promise<void> | void;
  /** 整理/提交引发的界面提示。 */
  onNotice?: (message: string) => void;
  /** 测试注入；缺省用同源实现与全局 fetch。 */
  callGateway?: AiGatewayCaller;
  listConfigs?: typeof listAiConfigs;
  now?: () => Date;
  createId?: () => string;
};

/**
 * 一条可恢复建议**及它的关联任务**。
 * 任务必须来自持久化关系（`task.proposalId === proposal.id`），不能用界面上的上一条任务替代。
 */
export type PageOrganizeRecovered = {
  proposal: AiProposal;
  task: AiTask | null;
  view: OrganizeTextView;
};

/** 恢复后允许的动作：由持久化的建议/任务状态决定，不是界面猜测。 */
export type PageOrganizeRunAction =
  | "apply"
  | "reject"
  | "submit"
  | "withdraw"
  | "regenerate"
  | "none";

/**
 * 保存后本会话的最新权威基线。
 * 由组件在 flush 成功后读取（`mergeCommittedBaseline` 已把实际提交页写回基线），
 * 避免用保存前的旧基线误判“自己刚保存的输入”为外部冲突。
 */
export type PageOrganizeBaseline = {
  pageId: string;
  updatedAt: string;
  blocksDigest: string;
  /** 冻结的草稿正文（flush 完成后即为已保存正文）。 */
  markdown: string;
  /** 冻结的编辑序号。 */
  editSequence: number;
  /** 该基线对应的编辑会话号；与当前会话不同则视为已换会话。 */
  sessionId: number;
};

export type PageOrganizeApi = {
  status: PageOrganizeStatus;
  message?: string;
  configs: AiPublicConfig[];
  selectedConfigId: string;
  selectConfig: (configId: string) => void;
  /** 当前展示中的建议（预览/接受中/冲突时仍在）。 */
  proposal?: AiProposal;
  /** 与当前展示建议**成对**的任务（持久化关系恢复而来）。 */
  task?: AiTask;
  diff?: OrganizeTextView;
  /** 刷新后可恢复的建议（含各自关联任务）：需用户显式恢复，不自动应用、不自动请求。 */
  pending: PageOrganizeRecovered[];
  /**
   * 本页存在 `running` 任务但**无法证明归属**：只读说明，不提供任何批量修改入口。
   * 已进入 `accepting` 的建议也不在这里自动回退。
   */
  runInfo?: string;
  reloadPending: () => Promise<void>;
  /** 只重新读取服务端公开配置（不发任何模型请求）；配置补齐后即可用。 */
  reloadConfig: () => Promise<void>;
  /**
   * **只读**恢复扫描：返回本页显示为运行中的任务，**不修改任何记录**。
   *
   * 保留此入口是为了让调用方（含测试）能取得同一份事实；
   * 它不再有“批量标记中断”的副作用——无法证明归属就不写。
   */
  recoverInterrupted: () => Promise<AiTask[]>;
  generate: (session: PageOrganizeSession) => Promise<void>;
  cancel: () => Promise<void>;
  /** 依据建议当前持久状态执行：draft→接受，accepted/accepting→继续提交。 */
  apply: (session: PageOrganizeSession) => Promise<void>;
  /** `apply` 的同一实现（保留既有名称：接受与“继续提交”是同一条授权+提交路径）。 */
  accept: (session: PageOrganizeSession) => Promise<void>;
  /** 拒绝 draft；accepted 请用 `withdraw`（两者都只改 AI 状态，业务零写入）。 */
  reject: (session: PageOrganizeSession) => Promise<void>;
  /** 撤回已接受但未提交的建议（`accepting` 不可撤回，按 P1 边界）。 */
  withdraw: (session: PageOrganizeSession) => Promise<void>;
  /** 恢复一条待审建议到预览（连同它的任务；不自动应用、不自动请求）。 */
  resume: (proposalId: string) => void;
};

const CONFIG_MISSING_MESSAGE = "尚未配置可用模型，请前往设置添加。";
const CONFIG_DEV_ONLY_MESSAGE = "AI 未开启。";

function buildDiffView(page: NotebookPage, proposal: AiProposal): OrganizeTextView | undefined {
  if (proposal.payload.kind !== "organize_page") return undefined;
  return buildOrganizeTextView(page.blocks, proposal.payload.textBlocks);
}

function payloadPageId(proposal: AiProposal | undefined): string {
  return proposal?.payload.kind === "organize_page" ? proposal.payload.pageId : "";
}

/**
 * 冻结身份是否仍是当前有效会话（纯函数，可直接单测）。
 *
 * 判定顺序（任一不符即失效）：
 * 1. 操作次序号：切篇/取消/重新生成/卸载都会推进它；
 * 2. 目标页身份；
 * 3. **编辑会话号**——同一 pageId 重新进入编辑也算新会话。
 *
 * 只比较页 ID 会把“同一篇的新编辑会话”误判为仍然有效。
 */
export function isSessionIdentityCurrent(input: {
  opId: number;
  currentOpId: number;
  sessionPageId: string;
  currentPageId: string | null | undefined;
  sessionId: number;
  currentSessionId: number | undefined;
}): boolean {
  if (input.opId !== input.currentOpId) return false;
  if (input.currentPageId !== input.sessionPageId) return false;
  if (
    input.currentSessionId !== undefined &&
    input.currentSessionId !== input.sessionId
  ) {
    return false;
  }
  return true;
}

/** 恢复后可用动作（纯函数，可直接单测）。 */
export function runActionsFor(
  proposal: Pick<AiProposal, "status">,
  options: { hasTask: boolean; targetUsable: boolean }
): PageOrganizeRunAction[] {
  if (!options.targetUsable) return ["none"];
  switch (proposal.status) {
    case "draft":
      return ["apply", "reject", "regenerate"];
    case "accepted":
      return ["submit", "withdraw", "regenerate"];
    case "accepting":
      // 已占用：可能是上一次业务已提交、AI 状态未落。可幂等继续提交；P1 不授权撤回。
      return ["submit"];
    case "applied":
      // 业务已完成：只展示事实，不重复写入。
      return ["none"];
    default:
      return ["none"];
  }
}

/**
 * 单篇整理协调 hook。所有会改动状态的回调都必须先通过 `isCurrent(opId)`；
 * 生成/接受还额外核对其冻结的页身份与会话身份。
 */
export function usePageOrganize(options: PageOrganizeOptions): PageOrganizeApi {
  /** 最新依赖：异步动作读取它，避免闭包拿到过期 props。 */
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  /** 时间来源：从最新 options 读取，不在调用方暴露可变默认值。 */
  const currentNow = () => optionsRef.current.now ?? (() => new Date());
  const callGateway = useMemo(
    () => options.callGateway ?? createAiGatewayCaller(),
    [options.callGateway]
  );
  const listConfigs = options.listConfigs ?? listAiConfigs;

  const [status, setStatus] = useState<PageOrganizeStatus>("loading-config");
  const [message, setMessage] = useState<string>();
  const [configs, setConfigs] = useState<AiPublicConfig[]>([]);
  const [selectedConfigId, setSelectedConfigId] = useState("");
  const [proposal, setProposal] = useState<AiProposal>();
  const [task, setTask] = useState<AiTask>();
  const [pending, setPending] = useState<PageOrganizeRecovered[]>([]);
  const [runInfo, setRunInfo] = useState<string>();

  /** 次序号：每次生成/取消/切篇/换会话 +1；旧回调据此作废。 */
  const opIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const configsRef = useRef<AiPublicConfig[]>([]);
  const statusRef = useRef<PageOrganizeStatus>("loading-config");
  /**
   * **本 hook 实例自己创建的**任务 id。
   *
   * 只有这些任务在卸载时可以被本会话取消；绝不能按“同一篇”去推断归属
   * （同一篇完全可能正在另一标签运行，见 Q1）。
   */
  const ownedTaskIdsRef = useRef<Set<string>>(new Set());

  const publish = useCallback((next: { status: PageOrganizeStatus; message?: string }) => {
    statusRef.current = next.status;
    setStatus(next.status);
    setMessage(next.message);
  }, []);

  const isCurrent = useCallback((opId: number) => opIdRef.current === opId, []);

  /**
   * 回调是否仍属于当前有效会话：
   * 目标页身份 + 编辑会话号 + 操作次序号三者都要匹配。
   * 只比较页 ID 会把“同一篇的新编辑会话”误当成仍然有效。
   */
  const isCurrentFor = useCallback(
    (opId: number, session: Pick<PageOrganizeSession, "pageId" | "sessionId">) =>
      isSessionIdentityCurrent({
        opId,
        currentOpId: opIdRef.current,
        sessionPageId: session.pageId,
        currentPageId: optionsRef.current.target?.id,
        sessionId: session.sessionId,
        currentSessionId: optionsRef.current.targetSessionId
      }),
    []
  );

  /** 任务的合法终态迁移；CAS/终态冲突说明别的路径已推进，以库中实际值为准。 */
  const settleTask = useCallback(
    async (taskId: string, to: "completed" | "cancelled"): Promise<AiTask | null> => {
      const ai = optionsRef.current.ai;
      const stored = await ai.getTask(taskId).catch(() => null);
      if (!stored) return null;
      const next = transitionAiTask(stored, to, {}, currentNow(), stored.revision);
      if (!next.ok) return next.current;
      try {
        await ai.saveTask(next.task, { expectedRevision: stored.revision });
        return next.task;
      } catch {
        return (await ai.getTask(taskId).catch(() => null)) ?? next.task;
      }
    },
    []
  );

  // —— P2-01：配置可用性（仅获取配置不构成模型调用） ——
  const loadConfigs = useCallback(async () => {
    const result = await listConfigs();
    if (result.status === "available") {
      configsRef.current = result.configs;
      setConfigs(result.configs);
      // 只有一个可用配置时直接选中；多个由用户选择（不新增设置中心）。
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

  // —— P2-04：刷新后被恢复的建议与关联任务（**只读**扫描） ——
  /**
   * 只读扫描：不自动请求、不自动应用、**不修改任何任务或建议**。
   *
   * 为什么不做“批量把 running 标成中断”：同一篇完全可能正在另一标签执行，
   * 现有 API 无法区分“本会话崩溃遗留”与“他人正在执行”，revision CAS 也不能证明中断。
   * 因此这里只报告事实，恢复动作交给用户显式、逐个进行。
   */
  const loadRecovery = useCallback(async (page: NotebookPage | null, opId: number) => {
    const ai = optionsRef.current.ai;
    if (!page) {
      if (isCurrent(opId)) {
        setPending([]);
        setRunInfo(undefined);
      }
      return;
    }
    let tasks: AiTask[] = [];
    try {
      tasks = (await ai.listTasks()).filter((item) => item.input.pageId === page.id);
    } catch {
      tasks = [];
    }
    if (!isCurrent(opId)) return;
    const running = tasks.filter((item) => item.status === "running");
    // 建议与任务**成对**读取：任务必须自报 proposalId 与建议 id 一致。
    const pairs = (
      await Promise.all(
        tasks.map(async (item) => {
          if (!item.proposalId) return null;
          const stored = await ai.getProposal(item.proposalId).catch(() => null);
          return stored ? { proposal: stored, task: item } : null;
        })
      )
    ).filter((entry): entry is { proposal: AiProposal; task: AiTask } => entry !== null);
    if (!isCurrent(opId)) return;

    const entries: PageOrganizeRecovered[] = [];
    for (const pair of pairs) {
      if (pair.proposal.payload.pageId !== page.id) continue;
      if (pair.proposal.status === "rejected") continue;
      const view = buildDiffView(page, pair.proposal);
      if (view) entries.push({ proposal: pair.proposal, task: pair.task, view });
    }
    setPending(entries);
    setRunInfo(
      running.length > 0
        ? `有 ${running.length} 个任务显示为运行中。可能是本机上次退出留下的，也可能是另一标签正在执行；` +
          `无法确认归属时不会改动它们，也不会自动回退提交中的建议。`
        : undefined
    );
  }, [isCurrent]);

  // 目标篇或编辑会话变化：作废在途操作、清掉上一条建议，并按需重新扫描。
  const targetId = options.target?.id ?? "";
  const targetSessionId = options.targetSessionId;
  useEffect(() => {
    /*
     * 这里必须同步清掉“上一条建议/任务”的界面状态：它们是**派生自目标身份**的展示，
     * 换篇或同一篇换编辑会话后旧建议不能继续挂在界面上。
     */
    /* eslint-disable react-hooks/set-state-in-effect */
    opIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setProposal(undefined);
    setTask(undefined);
    setPending([]);
    setRunInfo(undefined);
    if (statusRef.current !== "config-missing" && configsRef.current.length > 0) {
      publish({ status: "idle" });
    }
    if (targetId.length > 0) {
      void loadRecovery(optionsRef.current.target, opIdRef.current);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    // 依赖目标页身份与编辑会话号：同一篇重新进入编辑同样要重新扫描。
  }, [targetId, targetSessionId, publish, loadRecovery]);

  /**
   * 卸载：取消本会话尚未提交的生成请求，使旧回调失效。
   *
   * 只 abort 信号，**不修改持久化任务状态**——任务可能是另一会话的，本会话无权改写它。
   * 已进入 accepting 的业务提交不在这里撤销：它按 P1 的收据与占用边界自行收敛。
   */
  const settleTaskRef = useRef(settleTask);
  useEffect(() => {
    settleTaskRef.current = settleTask;
  });
  useEffect(() => {
    const owned = ownedTaskIdsRef.current;
    return () => {
      // 卸载才执行：作废回调、取消在途请求，并收敛**本实例创建、仍在执行中**的任务。
      opIdRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      for (const taskId of owned) {
        void (async () => {
          const stored = await optionsRef.current.ai.getTask(taskId).catch(() => null);
          if (!stored || (stored.status !== "queued" && stored.status !== "running")) return;
          // 只取消本实例创建的任务（id 独占）；另一标签的任务不在 owned 里。
          // 已进入 accepting 的建议属于业务提交，按 P1 边界自行收敛，绝不在这里撤销。
          await settleTaskRef.current(taskId, "cancelled");
        })();
      }
      owned.clear();
    };
  }, []);

  const reloadPending = useCallback(async () => {
    await loadRecovery(optionsRef.current.target, opIdRef.current);
  }, [loadRecovery]);

  const reloadConfig = useCallback(async () => {
    await loadConfigs();
  }, [loadConfigs]);

  /**
   * **只读**扫描本页运行中的任务。
   *
   * 明确不做的事：不把 running 改成 failed、不改 revision、不自动回退 accepting 建议。
   * 现有 API 无法区分“本会话崩溃遗留”与“另一标签正在执行”，CAS 也不能证明中断；
   * 因此这里只返回事实，供界面做只读说明。
   */
  const recoverInterrupted = useCallback(async (): Promise<AiTask[]> => {
    const ai = optionsRef.current.ai;
    const page = optionsRef.current.target;
    if (!page) return [];
    try {
      const tasks = await ai.listTasks();
      return tasks.filter((item) => item.input.pageId === page.id && item.status === "running");
    } catch {
      return [];
    }
  }, []);

  // —— P2-02：生成与预览 ——
  const generate = useCallback(
    async (session: PageOrganizeSession) => {
      const opId = (opIdRef.current += 1);
      const current = optionsRef.current;
      if (!current.enabled || current.target?.id !== session.pageId) return;
      const configId = selectedConfigId;
      // 没有可用配置时**零模型请求**：明确提示并要求先在服务端配置。
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

      // 1) 先 await 保存协调：false/抛错立即停止，保留草稿。
      let flushed: boolean;
      try {
        flushed = await current.onFlush();
      } catch {
        flushed = false;
      }
      if (!isCurrentFor(opId, session)) return;
      if (!flushed) {
        publish({ status: "failed", message: "保存未完成，已停止整理；草稿与建议均保留。" });
        return;
      }

      /*
       * 2) 保存成功后取**权威新档案与本会话新基线**。
       *
       * 关键：不能在 flush 前冻结 `current`/`session` 然后在 flush 后继续用旧闭包。
       * React可能尚未重新渲染；这里从Repository回读实际已提交档案，再读取会话基线，
       * 因此“刚点整理前输入的内容被自己保存”不会被误判为外部冲突。
       */
      const afterFlush = optionsRef.current;
      let archive: ArchiveCore;
      try {
        archive = await afterFlush.notebooks.loadArchive();
      } catch (error) {
        if (!isCurrentFor(opId, session)) return;
        publish({ status: "failed", message: `读取已保存笔记本失败：${describe(error)}` });
        return;
      }
      if (!isCurrentFor(opId, session)) return;
      const baseline = afterFlush.readBaseline?.();
      const page = archive.pages.find((item) => item.id === session.pageId) ?? null;
      if (!page) {
        publish({ status: "failed", message: "目标篇已不存在，已停止整理。" });
        return;
      }
      /*
       * 只有调用方提供了权威基线时才与基线核对；没有基线（测试装配/降级路径）就与
       * **flush 后的实际档案**一致即可——档案本身就是权威来源。
       * 这样“自己刚保存的输入”不会因为保存前的旧基线被误判为冲突。
       */
      if (
        baseline !== undefined &&
        (page.updatedAt !== baseline.updatedAt ||
          digestPageBlocks(page) !== baseline.blocksDigest)
      ) {
        publish({
          status: "conflict",
          message:
            "这一篇在当前内容之外还有未处理的改动（可能来自其它标签）；未生成建议，请确认当前内容后再试。"
        });
        return;
      }
      const provider = createAiContextProvider({ archive, media: afterFlush.getMedia() });
      const context = await provider.getPage(page.id);
      if (!isCurrentFor(opId, session)) return;
      if (!context) {
        publish({ status: "failed", message: "这一篇当前不可整理（已删除或不可读）。" });
        return;
      }

      const idFactory = afterFlush.createId ?? defaultTaskId;
      const timestamp = currentNow()().toISOString();
      const queuedTask: AiTask = {
        id: idFactory(),
        type: "organize_page",
        status: "queued",
        input: {
          pageId: page.id,
          sourceDigest: context.sourceDigest,
          maxOutputChars: TASK_BUDGETS.maxOutputChars
        },
        promptId: PAGE_ORGANIZE_PROMPT.id,
        promptVersion: PAGE_ORGANIZE_PROMPT_VERSION,
        revision: 0,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      ownedTaskIdsRef.current.add(queuedTask.id);
      setTask(queuedTask);

      const outcome = await runOrganizePageTask(
        {
          context: { archive, media: afterFlush.getMedia() },
          ai: afterFlush.ai,
          callGateway,
          selectConfig: () => configId,
          now: currentNow(),
          signal: controller.signal
        },
        queuedTask
      );
      if (!isCurrentFor(opId, session)) return;

      if (outcome.status === "waiting_user") {
        const view = buildDiffView(page, outcome.proposal);
        if (!view) {
          publish({ status: "failed", message: "收到的建议类型不受支持，已忽略。" });
          return;
        }
        // 无差异：明确提示，不进入可接受状态，也不做任何业务写入。
        if (view.unchanged) {
          setTask(outcome.task);
          publish({ status: "idle", message: "模型没有给出任何正文改动，未产生建议。" });
          return;
        }
        // 冻结预览（payloadDigest + previewedAt）：接受的就是这一版。
        const previewed = previewProposal(outcome.proposal, currentNow());
        if (!previewed.ok) {
          publish({ status: "failed", message: "建议载荷不合法，已拒绝。" });
          return;
        }
        try {
          await afterFlush.ai.saveProposal(previewed.proposal, {
            expectedRevision: outcome.proposal.revision
          });
        } catch (error) {
          if (!isCurrentFor(opId, session)) return;
          setTask(outcome.task);
          publish({ status: "failed", message: `建议未能保存：${describe(error)}` });
          return;
        }
        if (!isCurrentFor(opId, session)) return;
        setTask(outcome.task);
        setProposal(previewed.proposal);
        publish({ status: "preview" });
        return;
      }

      if (!isCurrentFor(opId, session)) return;
      setTask(outcome.task);
      if (outcome.status === "cancelled") {
        publish({ status: "cancelled", message: "已取消整理。" });
        return;
      }
      if (outcome.status === "failed") {
        publish({ status: "failed", message: `整理失败（${outcome.code}）：${outcome.detail}` });
        return;
      }
      publish({ status: "failed", message: `整理未执行（${outcome.reason}），任务状态未变化。` });
    },
    [callGateway, isCurrentFor, publish, selectedConfigId]
  );

  // —— P2-04：取消 ——
  const cancel = useCallback(async () => {
    const opId = (opIdRef.current += 1);
    abortRef.current?.abort();
    abortRef.current = null;
    setProposal(undefined);
    setTask(undefined);
    const currentTask = task;
    if (currentTask) await settleTask(currentTask.id, "cancelled");
    if (!isCurrent(opId)) return;
    publish({ status: "cancelled", message: "已取消整理；迟到结果不会出现可接受预览。" });
  }, [isCurrent, publish, settleTask, task]);

  /**
   * 提交（apply）：依据**持久化状态**决定语义。
   *
   * - `draft`（已冻结预览）：核对本会话基线后授权为 accepted，随后进入 Safe Commit；
   * - `accepted` / `accepting`（刷新后恢复、或上次业务已提交但 AI 状态未落）：
   *   不再套用 `acceptProposal`，直接走既有授权与收据边界（幂等重放）。
   */
  const apply = useCallback(
    async (session: PageOrganizeSession) => {
      const current = optionsRef.current;
      const shown = proposal;
      const shownPageId = payloadPageId(shown);
      if (!shown || !shownPageId) return;
      if (current.target?.id !== shownPageId) {
        publish({ status: "conflict", message: "目标篇已切换，本建议不再适用。" });
        return;
      }
      if (shown.status === "applied") {
        publish({ status: "applied", message: "这条建议已应用，无需重复提交。" });
        return;
      }
      if (shown.status === "rejected" || shown.status === "conflicted") {
        publish({ status: "conflict", message: `建议状态是 ${shown.status}，不再授权应用。` });
        return;
      }

      const opId = (opIdRef.current += 1);
      publish({ status: "applying" });

      // 1) 提交占用前的最后一次保存协调：失败即停止，保留草稿与建议。
      let flushed: boolean;
      try {
        flushed = await current.onFlush();
      } catch {
        flushed = false;
      }
      if (!isCurrentFor(opId, session)) return;
      if (!flushed) {
        publish({ status: "conflict", message: "保存未完成，未应用建议；草稿与建议均保留。" });
        return;
      }

      // 2) 权威重读：建议仍在、目标仍可用、本会话仍指向它。
      const afterFlush = optionsRef.current;
      let archive: ArchiveCore;
      try {
        archive = await afterFlush.notebooks.loadArchive();
      } catch (error) {
        if (!isCurrentFor(opId, session)) return;
        publish({ status: "failed", message: `读取已保存笔记本失败：${describe(error)}` });
        return;
      }
      if (!isCurrentFor(opId, session)) return;
      const page = archive.pages.find((item) => item.id === shownPageId) ?? null;
      if (!page || isPageDeleted(page)) {
        publish({ status: "conflict", message: "目标篇已不可用，未应用建议。" });
        return;
      }
      let stored: AiProposal | null;
      try {
        stored = await afterFlush.ai.getProposal(shown.id);
      } catch (error) {
        if (!isCurrentFor(opId, session)) return;
        publish({ status: "failed", message: `读取建议失败：${describe(error)}；正文未应用，可重试。` });
        return;
      }
      /*
       * R3：读取返回后**先**判定身份，再进入任何 UI 分支（含“读不到建议”的错误分支）。
       * 读取挂起期间切页/换会话时，旧结果必须静默失效，不能把新页改成 conflict；
       * 当前有效会话确实读不到建议时，下面的错误分支照常可见。
       */
      if (!isCurrentFor(opId, session)) return;
      if (!stored) {
        publish({ status: "conflict", message: "这条建议已不在 AI 库中，授权失效。" });
        return;
      }

      let authorized: AiProposal = stored;
      if (stored.status === "draft") {
        /*
         * 3a) draft：接受的是**已冻结展示的那一版**。
         * 本会话基线必须与实际已保存内容一致，否则保留草稿与建议、显示冲突。
         * 这里不把建议基线替换成最新基线后强行应用。
         */
        const baseline = afterFlush.readBaseline?.();
        if (
          session.readDraftMarkdown() !== session.baselineMarkdown ||
          (baseline !== undefined &&
            (page.updatedAt !== baseline.updatedAt ||
              digestPageBlocks(page) !== baseline.blocksDigest))
        ) {
          publish({
            status: "conflict",
            message: "正文在整理之后又有未保存或外部改动；为不覆盖你的输入，本次未应用建议。"
          });
          return;
        }
        const accepted = acceptProposal(stored, currentNow());
        if (!accepted.ok) {
          publish({ status: "conflict", message: `建议状态已变化（${accepted.reason}），未应用。` });
          return;
        }
        try {
          await afterFlush.ai.saveProposal(accepted.proposal, { expectedRevision: stored.revision });
        } catch (error) {
          if (!isCurrentFor(opId, session)) return;
          publish({ status: "conflict", message: `授权写入失败：${describe(error)}` });
          return;
        }
        if (!isCurrentFor(opId, session)) return;
        authorized = accepted.proposal;
        setProposal(accepted.proposal);
      } else {
        /*
         * 3b) accepted / accepting：已授权（或已占用）。
         * 不再套用 `acceptProposal`；由 `applyAiProposal` 用持久化状态与冻结源身份核对，
         * 收据保证业务只提交一次（`accepting` 会幂等重放）。
         */
        setProposal(stored);
      }

      // 4) Safe Commit：授权占用 + 业务事务 + 收据（同一次业务写入）。
      let outcome: SafeCommitOutcome;
      try {
        outcome = await applyAiProposal(
          afterFlush.ai,
          afterFlush.notebooks,
          { proposal: authorized, expectedRevision: archive.revision, now: currentNow() },
          // 真实的保存协调函数（不是空函数）：输入窗口在 applying 期间已被冻结。
          () => optionsRef.current.onFlush()
        );
      } catch (error) {
        /*
         * R2：异常分支与成功分支一样，先确认本回调仍属于当前页/会话再更新界面。
         * 迟到的提交异常不得把新页面的 idle 改成 conflict。
         * 业务事务按 P1 原子性自行结束，这里只负责不污染新会话。
         */
        if (!isCurrentFor(opId, session)) return;
        publish({ status: "conflict", message: `应用建议失败：${describe(error)}` });
        return;
      }
      if (!isCurrentFor(opId, session)) return;

      if (outcome.status === "applied" || outcome.status === "replayed") {
        /*
         * R1：任务收敛必须跟随 **AI 建议状态**，而不是只跟随业务收据。
         *
         * P1 会返回“业务已提交、AI 建议仍是 accepting”的部分成功结果（`aiStateError`）。
         * 此时若提前把关联任务置为 `completed`，Safe Commit 的授权要求
         * （任务仍为 `waiting_user` 且指向该建议）就永久不成立，这条路径再也无法收敛。
         * 因此：
         * - 建议确已 `applied`：任务 `waiting_user → completed`；
         * - 仍是 `accepting`：任务保持 `waiting_user`，保留 P1 允许的幂等恢复路径；
         *   由用户显式“继续提交”经收据重放补记 `applied`，届时才收敛任务。
         */
        const aiSettled = !outcome.aiStateError && outcome.proposal.status === "applied";
        const currentTask = task ?? null;
        if (aiSettled && currentTask) {
          const finished = await settleTask(currentTask.id, "completed");
          if (!isCurrentFor(opId, session)) return;
          if (finished) setTask(finished);
        } else if (!isCurrentFor(opId, session)) {
          return;
        }
        setProposal(outcome.proposal);
        /*
         * 编辑器正文只在“应用窗口内没有新输入”时刷新：一旦用户在这段短窗口仍写入了内容，
         * 保留用户输入、只报成功，绝不把 AI 结果或旧正文覆盖到用户刚写的内容上。
         */
        const editorUnchanged =
          session.readEditSequence === undefined ||
          session.readEditSequence() === session.committedEditSequence;
        publish({
          status: "applied",
          message: outcome.aiStateError
            ? `正文已保存并应用，AI 状态待恢复：${outcome.aiStateError}`
            : outcome.status === "replayed"
              ? "已应用（未重复写入）。"
              : "整理结果已应用到正文。"
        });
        if (!isCurrentFor(opId, session)) return;
        try {
          await optionsRef.current.onApplied(outcome.page, { refreshEditor: editorUnchanged }, session);
        } catch (error) {
          /*
           * R3：刷新失败的通知同样只发给**原操作所属**的页/编辑会话。
           * 迟到失败不得把“界面刷新失败”的提示挂到新页面；当前会话的失败仍然可见。
           */
          if (!isCurrentFor(opId, session)) return;
          optionsRef.current.onNotice?.(`正文已应用，但界面刷新失败：${describe(error)}`);
        }
        return;
      }

      // 非成功分支：不改基线、不改业务内容，保留建议与草稿，给出与持久状态相符的动作。
      const detail = describeSafeCommit(outcome);
      if (outcome.status === "conflicted") setProposal(outcome.proposal);
      const conflictLike =
        outcome.status === "conflicted" ||
        outcome.status === "not-accepted" ||
        outcome.status === "digest-mismatch" ||
        outcome.status === "target-unavailable" ||
        // 业务事务的 revision 冲突同样需要用户重新确认，不当作“失败”丢弃建议。
        outcome.status === "revision-conflict";
      publish({ status: conflictLike ? "conflict" : "failed", message: detail });
    },
    [isCurrentFor, proposal, publish, settleTask, task]
  );

  // —— P2-03：拒绝（只改 AI 状态，业务零写入） ——
  const reject = useCallback(
    async (session: PageOrganizeSession) => {
      const current = optionsRef.current;
      const shown = proposal;
      if (!shown) return;
      if (payloadPageId(shown) !== session.pageId) return;
      if (shown.status !== "draft") {
        publish({
          status: "conflict",
          message: `建议状态是 ${shown.status}，不能用“拒绝”；已接受的建议请用“撤回”。`
        });
        return;
      }
      const opId = opIdRef.current;
      try {
        await current.ai.saveProposal(rejectProposal(shown, currentNow()), {
          expectedRevision: shown.revision
        });
      } catch (error) {
        if (!isCurrentFor(opId, session)) return;
        publish({ status: "preview", message: `拒绝未写入：${describe(error)}` });
        return;
      }
      if (!isCurrentFor(opId, session)) return;
      // 拒绝必须让关联任务正确收敛：waiting_user → cancelled（终态）。
      const currentTask = task;
      if (currentTask) await settleTask(currentTask.id, "cancelled");
      if (!isCurrentFor(opId, session)) return;
      setProposal(undefined);
      setTask(undefined);
      publish({ status: "idle", message: "已拒绝这条建议，正文没有任何改动。" });
    },
    [isCurrentFor, proposal, publish, settleTask, task]
  );

  // —— P2-03：撤回（已接受未提交；`accepting` 不撤回） ——
  const withdraw = useCallback(
    async (session: PageOrganizeSession) => {
      const current = optionsRef.current;
      const shown = proposal;
      if (!shown) return;
      if (payloadPageId(shown) !== session.pageId) return;
      if (shown.status === "accepting") {
        publish({
          status: "conflict",
          message:
            "建议正在提交，暂时无法撤回。" +
            "请点击“继续提交”确认保存结果。"
        });
        return;
      }
      if (shown.status !== "accepted") {
        publish({ status: "conflict", message: `建议状态是 ${shown.status}，无需撤回。` });
        return;
      }
      const opId = opIdRef.current;
      try {
        await current.ai.saveProposal(withdrawAcceptedProposal(shown, currentNow()), {
          expectedRevision: shown.revision
        });
      } catch (error) {
        if (!isCurrentFor(opId, session)) return;
        publish({ status: "conflict", message: `撤回未写入：${describe(error)}` });
        return;
      }
      if (!isCurrentFor(opId, session)) return;
      const currentTask = task;
      if (currentTask) await settleTask(currentTask.id, "cancelled");
      if (!isCurrentFor(opId, session)) return;
      setProposal(undefined);
      setTask(undefined);
      publish({ status: "idle", message: "已撤回这条建议，正文没有任何改动。" });
    },
    [isCurrentFor, proposal, publish, settleTask, task]
  );

  /** 恢复一条待审建议：**连同它的持久化关联任务**一起进入预览。 */
  const resume = useCallback(
    (proposalId: string) => {
      const entry = pending.find((item) => item.proposal.id === proposalId);
      if (!entry) return;
      opIdRef.current += 1;
      setProposal(entry.proposal);
      setTask(entry.task ?? undefined);
      publish({
        status: "preview",
        message:
          entry.proposal.status === "applied"
            ? "这条建议已经应用完成（只读展示）。"
            : entry.proposal.status === "accepting"
              ? "这条建议处于提交占用中；可用“继续提交”幂等确认结果。"
              : entry.proposal.status === "accepted"
                ? "这条建议已授权但尚未提交；可继续提交或撤回。"
                : "这是刷新前留下的待审建议；可接受、拒绝或重新整理。"
      });
    },
    [pending, publish]
  );

  const diff = useMemo(() => {
    if (!proposal || !options.target) return undefined;
    if (payloadPageId(proposal) !== options.target.id) return undefined;
    return buildDiffView(options.target, proposal);
  }, [proposal, options.target]);

  return {
    status,
    message,
    configs,
    selectedConfigId,
    selectConfig: setSelectedConfigId,
    proposal,
    task,
    diff,
    pending,
    runInfo,
    reloadPending,
    reloadConfig,
    recoverInterrupted,
    generate,
    cancel,
    apply,
    accept: apply,
    reject,
    withdraw,
    resume
  };
}

/** 任务 ID：毫秒 + 单调序号 + 随机后缀；同一毫秒内的并发点击不碰撞。 */
let taskSequence = 0;
function defaultTaskId(): string {
  taskSequence += 1;
  return `task-${Date.now().toString(36)}-${taskSequence.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeSafeCommit(outcome: SafeCommitOutcome): string {
  switch (outcome.status) {
    case "conflicted":
      return `原文在建议生成后已改变，未应用：${outcome.detail}`;
    case "not-accepted":
      return `建议授权已失效（${outcome.detail}），未应用。`;
    case "digest-mismatch":
      return `建议载荷与已接受版本不一致，未应用：${outcome.detail}`;
    case "payload-invalid":
      return `建议内容不合法，未应用：${outcome.detail}`;
    case "target-unavailable":
      return `目标篇不可用，未应用：${outcome.detail}`;
    case "revision-conflict":
      return `档案版本冲突（当前 ${outcome.currentRevision}），未应用；请重新打开这一篇再试。`;
    case "receipt-limit":
      return `AI 提交收据已达上限（${outcome.limit}），未应用。`;
    default:
      return "未应用建议。";
  }
}
