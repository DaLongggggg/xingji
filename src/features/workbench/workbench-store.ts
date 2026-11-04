"use client";

/**
 * 工作台会话状态：**界面缓存**（Zustand），持久化由薄 API 适配层负责。
 *
 * 规则（任务书 §5）：
 * - 同会话写入串行化；版本来自服务端回读，不自己递增；
 * - 流式正文按约 1 秒合并检查点；回合结束立即提交；
 * - 冲突停止本地写回并保留草稿，不自动覆盖、不排队续跑；
 * - 删除成功后本地移除；晚到响应不得重建会话。
 */
import { create } from "zustand";
import { createCaptureId } from "@/features/capture/capture-model";
import {
  SessionApiError,
  markInterrupted,
  toSessionPayload,
  type SessionApi,
  type SessionSummary,
  type WorkbenchPreference
} from "./workbench-sessions";
import type { WorkbenchMessage, WorkbenchScope, WorkbenchSession } from "./workbench-types";
import { completeMessageTimeline } from "./workbench-message-timeline";

export type SaveState = "idle" | "saving" | "saved" | "error" | "conflict";

type WorkbenchState = {
  sessions: WorkbenchSession[];
  activeId?: string;
  /** 初始化状态：读取失败不能当空库继续覆盖。 */
  status: "loading" | "ready" | "error";
  loadError?: string;
  /** 每会话保存状态与冲突标记（界面按它显示「已保存/保存失败/冲突」）。 */
  saveStates: Record<string, SaveState>;
  saveErrors: Record<string, string>;
  revisions: Record<string, number>;
  preferenceRevision: number;
  /** 中断提示：恢复时发现的 pending 条数。 */
  interrupted: Record<string, number>;

  createSession: (scope: WorkbenchScope, title?: string) => string;
  removeSession: (id: string) => void;
  selectSession: (id: string) => void;
  setScope: (id: string, scope: WorkbenchScope) => void;
  renameSession: (id: string, title: string) => void;
  setModels: (id: string, models: { textModelId?: string; imageModelId?: string }) => void;
  appendMessage: (id: string, message: WorkbenchMessage) => void;
  updateMessage: (id: string, messageId: string, patch: Partial<WorkbenchMessage>) => void;
  /** 用服务端记录覆盖/插入本地会话（只读恢复）。 */
  applyRecord: (session: WorkbenchSession, revision: number, accountId?: string | null, epoch?: number) => void;
  setStatus: (status: "loading" | "ready" | "error", error?: string) => void;
  setSaveState: (id: string, state: SaveState, error?: string, accountId?: string | null, epoch?: number) => void;
  setRevision: (id: string, revision: number, accountId?: string | null, epoch?: number) => void;
  setPreferenceRevision: (revision: number, accountId?: string | null, epoch?: number) => void;
  /**
   * T2a 账号守卫：模块单例 Store 跨越组件卸载存活，切号必须**同步**清空全部投影
   * 并登记当前账号；此后异步落店动作携带发起账号，不匹配即整体丢弃。
   * serverId 一并登记，供仓储默认工厂派生账号命名空间（如 useCaptureOrganize）。
   */
  resetForAccount: (userId: string, serverId?: string) => void;
  accountId: string | null;
  /** 账号代数：每次 resetForAccount 递增（A→B→A 后旧请求凭 userId 会重新匹配，须以代数判别）。 */
  accountEpoch: number;
  serverId: string | null;
};

const now = () => new Date().toISOString();

/** 会话标题取第一条用户消息的前 18 个字；没有消息时保持默认标题。 */
export function titleFromMessage(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "新会话";
  return clean.length > 18 ? `${clean.slice(0, 18)}…` : clean;
}

export const useWorkbenchStore = create<WorkbenchState>((set) => ({
  sessions: [],
  activeId: undefined,
  status: "loading",
  saveStates: {},
  saveErrors: {},
  revisions: {},
  preferenceRevision: 1,
  interrupted: {},
  accountId: null,
  accountEpoch: 0,
  serverId: null,

  resetForAccount: (userId, serverId) => {
    /*
     * T2a 复核残留 2（二轮补充）：模块级生命周期资源随账号一并撤销——
     * - 在途回合控制器 abort（旧账号的生成不再推进）；
     * - 自动保存定时器逐个 clearTimeout（**checkpoint 的 timer 存在 checkpoints
     *   里，清空 Map 不会取消 timeout**——探针确认旧定时器会以新账号语义 PUT）；
     * - pendingTimers、提交链、冲突与删除记账清空（旧链上的回调由发起账号+代数
     *   复核变成空操作）；
     * - 每次 reset 递增账号代数：A→B→A 后旧 A 请求的代数已过期，出站与回写
     *   共同核对，不会重新被接受。
     */
    clearAllFrozenCheckpoints();   // P2-c：旧账号屏障不跨生命周期残留
    for (const controller of turnControllers.values()) {
      try {
        controller.abort(new DOMException("account switched", "AbortError"));
      } catch {
        /* 尽力中止 */
      }
    }
    turnControllers.clear();
    for (const timer of pendingTimers.values()) clearTimeout(timer);
    pendingTimers.clear();
    for (const checkpoint of checkpoints.values()) clearTimeout(checkpoint.timer);
    checkpoints.clear();
    chains.clear();
    conflicted.clear();
    deleted.clear();
    deleting.clear();
    accountEpoch += 1;
    set({
      sessions: [],
      activeId: undefined,
      status: "loading",
      saveStates: {},
      saveErrors: {},
      revisions: {},
      preferenceRevision: 1,
      interrupted: {},
      accountId: userId,
      serverId: serverId ?? null,
      accountEpoch
    });
  },

  createSession: (scope, title) => {
    const session: WorkbenchSession = {
      id: createCaptureId("session"),
      title: title?.trim() || "新会话",
      scope,
      messages: [],
      updatedAt: now(),
      ...(title?.trim() ? { renamed: true } : {})
    };
    set((state) => ({ sessions: [session, ...state.sessions], activeId: session.id }));
    return session.id;
  },

  removeSession: (id) =>
    set((state) => {
      const sessions = state.sessions.filter((session) => session.id !== id);
      return { sessions, activeId: state.activeId === id ? sessions[0]?.id : state.activeId };
    }),

  selectSession: (id) => set({ activeId: id }),

  setScope: (id, scope) =>
    set((state) => ({
      sessions: state.sessions.map((session) => (session.id === id ? { ...session, scope, updatedAt: now() } : session))
    })),

  renameSession: (id, title) =>
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, title: title.trim() || session.title, renamed: true, updatedAt: now() } : session
      )
    })),

  setModels: (id, models) =>
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id
          ? {
              ...session,
              ...(models.textModelId === undefined ? {} : { textModelId: models.textModelId }),
              ...(models.imageModelId === undefined ? {} : { imageModelId: models.imageModelId })
            }
          : session
      )
    })),

  appendMessage: (id, message) =>
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id
          ? {
              ...session,
              // 第一条用户消息决定会话标题；手动命名后不再被覆盖。
              title:
                !session.renamed && session.messages.length === 0 && message.role === "user"
                  ? titleFromMessage(message.text)
                  : session.title,
              messages: [...session.messages, completeMessageTimeline(message)],
              updatedAt: now()
            }
          : session
      )
    })),

  updateMessage: (id, messageId, patch) =>
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id
          ? {
              ...session,
              messages: session.messages.map((message) => (message.id === messageId ? completeMessageTimeline({ ...message, ...patch }) : message)),
              updatedAt: now()
            }
          : session
      )
    })),

  applyRecord: (session, revision, accountId, epoch) =>
    set((state) => {
      // 账号守卫：迟到水合携带发起账号与代数，A→B→A 后旧请求代数过期即丢弃。
      if (accountId !== undefined && state.accountId !== accountId) return state;
      if (epoch !== undefined && state.accountEpoch !== epoch) return state;
      const exists = state.sessions.some((item) => item.id === session.id);
      return {
        sessions: exists ? state.sessions.map((item) => (item.id === session.id ? session : item)) : [session, ...state.sessions],
        revisions: { ...state.revisions, [session.id]: revision }
      };
    }),

  setStatus: (status, error) => set({ status, ...(error ? { loadError: error } : { loadError: undefined }) }),
  setSaveState: (id, saveState, error, accountId, epoch) =>
    set((state) => {
      if (accountId !== undefined && state.accountId !== accountId) return state;
      if (epoch !== undefined && state.accountEpoch !== epoch) return state;
      return {
        saveStates: { ...state.saveStates, [id]: saveState },
        saveErrors: { ...state.saveErrors, [id]: error ?? "" }
      };
    }),
  setRevision: (id, revision, accountId, epoch) =>
    set((state) => {
      if (accountId !== undefined && state.accountId !== accountId) return state;
      if (epoch !== undefined && state.accountEpoch !== epoch) return state;
      return { revisions: { ...state.revisions, [id]: revision } };
    }),
  setPreferenceRevision: (revision, accountId, epoch) =>
    set((state) => {
      if (accountId !== undefined && state.accountId !== accountId) return state;
      if (epoch !== undefined && state.accountEpoch !== epoch) return state;
      return { preferenceRevision: revision };
    })
}));

/** 供组件读取当前会话（无会话时返回 undefined）。 */
export function activeSession(state: WorkbenchState): WorkbenchSession | undefined {
  return state.sessions.find((session) => session.id === state.activeId);
}

/* ---------- 持久化：串行写入 + 合并检查点 ---------- */

function modelsOf(session: WorkbenchSession): { textModelId?: string; imageModelId?: string } {
  return {
    ...(session.textModelId ? { textModelId: session.textModelId } : {}),
    ...(session.imageModelId ? { imageModelId: session.imageModelId } : {})
  };
}

/** 每个会话一条写入链：后一次提交必须等前一次结束（不并发、不乱序）。 */
const chains = new Map<string, Promise<void>>();
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const CHECKPOINT_MS = 1_000;
/**
 * T2a 复核二轮：账号代数——每次 resetForAccount 递增。A→B→A 后旧 A 请求的
 * userId 守卫会重新匹配，必须以代数共同核对（出站与回写双重检查）。
 */
let accountEpoch = 0;

function enqueue<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(sessionId) ?? Promise.resolve();
  // 串行执行，但把本次任务的结果（保存成功与否）返回给调用方。
  const next = previous.then(task, task);
  chains.set(sessionId, next.then(() => undefined, () => undefined));
  return next;
}

/**
 * SP2：保存冲突时停止**该会话**的在途回合（模型与工具调用一并停止），
 * 其他会话不受影响；冲突会话不再自动保存，直到重新读取。
 */
const turnControllers = new Map<string, AbortController>();
const conflicted = new Set<string>();
export const SAVE_CONFLICT_REASON = "SESSION_SAVE_CONFLICT";

export function registerTurn(sessionId: string, controller: AbortController): void {
  turnControllers.set(sessionId, controller);
}

export function unregisterTurn(sessionId: string, controller: AbortController): void {
  if (turnControllers.get(sessionId) === controller) turnControllers.delete(sessionId);
}

/** 冲突时取消该会话的执行：只影响这个会话。 */
export function abortSessionTurn(sessionId: string): void {
  const controller = turnControllers.get(sessionId);
  if (!controller || controller.signal.aborted) return;
  controller.abort(new DOMException(SAVE_CONFLICT_REASON, "AbortError"));
}

export function isSessionConflicted(sessionId: string): boolean {
  return conflicted.has(sessionId);
}

/** 重新读取（或用户显式重试保存）后解除冲突，允许再次保存。 */
export function clearSessionConflict(sessionId: string): void {
  conflicted.delete(sessionId);
}

/** 删除成功后：晚到的保存与响应不得复活该会话。 */
const deleted = new Set<string>();
/** 删除进行中：可撤销（失败后恢复可编辑/可保存）。 */
const deleting = new Set<string>();

export function beginSessionDelete(id: string): void {
  deleting.add(id);
  clearCheckpoint(id);
}

/** 删除失败：撤销删除中状态，会话恢复可编辑可保存。 */
export function cancelSessionDelete(id: string): void {
  deleting.delete(id);
}

/** 只有删除**成功**才进入永久禁写；仍防止晚到 PUT/响应复活。 */
export function markSessionDeleted(id: string): void {
  deleting.delete(id);
  deleted.add(id);
  clearCheckpoint(id);
}

/** 等待该会话在途保存收拢（删除前必须等，否则正常保存完成会造成删除冲突）。 */
export async function settleSession(sessionId: string): Promise<void> {
  await (chains.get(sessionId) ?? Promise.resolve());
}

/**
 * 提交一次快照。revision 来自服务端回读；冲突/失败只标记状态并保留本地内容。
 * `expectRevision` 为空表示这是一个还没落库的新会话 → 先创建。
 */
export async function saveSession(
  api: SessionApi,
  sessionId: string,
  options: { title?: string; onlyIfNewer?: boolean } = {}
): Promise<boolean> {
  if (deleted.has(sessionId) || conflicted.has(sessionId)) return false;
  // T2a 账号守卫：捕获发起账号与代数；切号后在途回执不再写新账号的投影。
  const account = useWorkbenchStore.getState().accountId;
  const epoch = accountEpoch;
  return enqueue(sessionId, async (): Promise<boolean> => {
    const state = useWorkbenchStore.getState();
    // T2a 复核残留 2：出站前复核发起账号与代数——排队期间切号后，旧请求不得以
    // 新账号的认证语义发出；A→B→A 后旧请求的代数已过期，同样拒绝。
    if (state.accountId !== account || accountEpoch !== epoch) return false;
    const session = state.sessions.find((item) => item.id === sessionId);
    /*
     * 排队中的任务在**真正执行时**重新判定：冲突（或删除）发生后，
     * 先前已排队的自动保存不再发请求（SP2）。
     */
    if (!session || deleted.has(sessionId) || conflicted.has(sessionId) || session.loaded === false || deleting.has(sessionId)) {
      return false;
    }
    const payload = toSessionPayload(session, modelsOf(session));
    useWorkbenchStore.getState().setSaveState(sessionId, "saving", undefined, account);
    try {
      const revision = state.revisions[sessionId];
      const record = revision
        ? await api.update({
            id: sessionId,
            baseRevision: revision,
            ...(options.title ? { title: options.title } : {}),
            payload
          })
        : await api.create({
            id: sessionId,
            ...(options.title ?? session.title ? { title: options.title ?? session.title } : {}),
            payload
          });
      if (deleted.has(sessionId)) return true;
      useWorkbenchStore.getState().setRevision(sessionId, record.revision, account, epoch);
      /*
       * 只有**当前内容仍等于刚提交的内容**才算已保存：
       * 提交期间又有新正文时不能把新内容标成已保存（旧快照完成不代表新内容落盘）。
       */
      const current = useWorkbenchStore.getState().sessions.find((item) => item.id === sessionId);
      // 会话内容通过不可变更新替换对象；保存状态 / revision 更新不会替换会话。
      // 避免每次回执再次序列化两份可能包含数百 MiB 原图的 payload。
      const unchanged = current === session;
      useWorkbenchStore.getState().setSaveState(sessionId, unchanged ? "saved" : "idle", undefined, account, epoch);
      return true;
    } catch (error) {
      if (deleted.has(sessionId)) return false;
      const conflict = error instanceof SessionApiError && (error.code === "SESSION_CONFLICT" || error.code === "SESSION_BUSY");
      /*
       * T2a 复核三轮残留：失败回执的**任何**副作用（投影写、冲突记账、清检查点、
       * 中止回合）都必须先复核发起账号与代数——A 的失败回执到达时 B 可能已建立
       * 同 id 的新回合与检查点，无条件执行会中止 B 的回合并阻止 B 的后续保存。
       */
      const current = useWorkbenchStore.getState();
      if (current.accountId !== account || accountEpoch !== epoch) return false;
      current
        .setSaveState(sessionId, conflict ? "conflict" : "error", error instanceof SessionApiError
          ? `${error.detail}（${error.code}）`
          : error instanceof Error ? error.message : "保存失败。", account, epoch);
      if (conflict) {
        // 冲突：停止该会话的自动保存，并取消它的在途回合（模型/工具调用随之停止）。
        conflicted.add(sessionId);
        clearCheckpoint(sessionId);
        abortSessionTurn(sessionId);
      }
      return false;
    }
  });
}

type Checkpoint = {
  firstAt: number;
  timer: ReturnType<typeof setTimeout>;
  /** 排程时身份：触发时复核，防止切号后旧定时器以新账号语义出站（复核二轮）。 */
  account: string | null;
  epoch: number;
};
const checkpoints = new Map<string, Checkpoint>();

/**
 * 流式正文的**有界**检查点：从第一次未保存改动起最多等约 1 秒，
 * 新分块只会把本次窗口提前、不会让它无限延期（否则连续输出等于从不落盘）。
 */
/** F4：交付屏障冻结的会话——检查点不再排程（在途保存照常收拢）。 */
// P2-c：冻结绑定会话+账号代数——切号清空全部冻结，旧 finally 的 thaw 不能解新生命周期的冻结。
const checkpointFrozen = new Map<string, number>();
export function freezeSessionCheckpoints(sessionId: string): number {
  const epoch = accountEpoch;
  checkpointFrozen.set(sessionId, epoch);
  clearCheckpoint(sessionId);
  return epoch;
}
export function thawSessionCheckpoints(sessionId: string, frozenAtEpoch?: number): void {
  if (frozenAtEpoch !== undefined) {
    // 旧屏障的 finally：代数已变（切号/重开）则放弃解冻——新生命周期有自己的屏障语义。
    if (checkpointFrozen.get(sessionId) !== frozenAtEpoch) return;
  }
  checkpointFrozen.delete(sessionId);
}
/** P2-c：resetForAccount 清全部冻结（旧账号屏障不跨生命周期残留）。 */
function clearAllFrozenCheckpoints(): void {
  checkpointFrozen.clear();
}

/** P2-c 测试出口：以当前 store 状态执行一次账号重置（含冻结清理）。 */
export function resetForAccountForTest(): void {
  useWorkbenchStore.getState().resetForAccount("test-user-p2c");
}
/** 等待该会话保存链收拢（含已排队项）；无在途保存立即返回。 */
export function awaitSessionSaves(sessionId: string): Promise<void> {
  return chains.get(sessionId) ?? Promise.resolve();
}

export function scheduleCheckpoint(api: SessionApi, sessionId: string): void {
  // 冲突后停止该会话的自动保存（不再反复 PUT），由重新读取或显式重试解除；
  // 交付屏障冻结期间不排新检查点（F4）。
  if (conflicted.has(sessionId) || deleted.has(sessionId) || checkpointFrozen.has(sessionId)) return;   // Map.has 同 Set 语义
  const now = Date.now();
  const existing = checkpoints.get(sessionId);
  const firstAt = existing?.firstAt ?? now;
  if (existing) clearTimeout(existing.timer);
  const delay = Math.max(0, CHECKPOINT_MS - (now - firstAt));
  // 排程时身份：触发时复核（切号后 reset 已取消定时器，此处是双保险）。
  const account = useWorkbenchStore.getState().accountId;
  const epoch = accountEpoch;
  const timer = setTimeout(() => {
    const scheduled = checkpoints.get(sessionId);
    checkpoints.delete(sessionId);
    const current = useWorkbenchStore.getState();
    if (current.accountId !== account || accountEpoch !== epoch) return;
    if (scheduled && (scheduled.account !== account || scheduled.epoch !== epoch)) return;
    void saveSession(api, sessionId);
  }, delay);
  checkpoints.set(sessionId, { firstAt, timer, account, epoch });
}

/** 还有未被检查点覆盖的改动。 */
export function hasPendingCheckpoint(sessionId: string): boolean {
  return checkpoints.has(sessionId);
}

/** 回合开始时清除在途检查点：原生任务交付会推高会话 revision，回合中的旧检查点保存必然冲突。 */
export function clearCheckpoint(sessionId: string): void {
  const existing = checkpoints.get(sessionId);
  if (!existing) return;
  clearTimeout(existing.timer);
  checkpoints.delete(sessionId);
}

/** 回合结束立即提交（不等检查点）。 */
export async function commitSession(api: SessionApi, sessionId: string, options: { title?: string } = {}): Promise<boolean> {
  clearCheckpoint(sessionId);
  return saveSession(api, sessionId, options);
}

/** 恢复：读取选中会话（列表不加载 payload），把 pending 标成中断，绝不自动续跑。 */
export async function loadSession(api: SessionApi, sessionId: string): Promise<{ interrupted: number }> {
  // T2a 复核残留 1：发起身份必须在 await **之前**捕获——迟到完成的加载按发起账号
  // 与代数守卫，不能读取落店时刻的当前账号（A→B→A 后 userId 守卫会重新匹配）。
  const account = useWorkbenchStore.getState().accountId;
  const epoch = accountEpoch;
  const record = await api.read(sessionId);
  if (useWorkbenchStore.getState().accountId !== account || accountEpoch !== epoch) return { interrupted: 0 };
  // 重新读取拿到权威版本后解除冲突状态。
  clearSessionConflict(sessionId);
  const { messages, interrupted } = markInterrupted(record.payload.messages);
  const session: WorkbenchSession = {
    id: record.id,
    title: record.title,
    scope: record.payload.scope,
    messages,
    updatedAt: record.updatedAt,
    loaded: true,
    ...(record.payload.textModelId ? { textModelId: record.payload.textModelId } : {}),
    ...(record.payload.imageModelId ? { imageModelId: record.payload.imageModelId } : {}),
    ...(record.payload.renamed ? { renamed: true } : {})
  };
  const store = useWorkbenchStore.getState();
  // 账号守卫：以发起账号与代数核对（双重保险，覆盖守卫读取与落店之间的窗口）。
  store.applyRecord(session, record.revision, account ?? undefined, epoch);
  /*
   * SP1：中断只是**本页展示覆盖**，不写回数据库——
   * 只读打开不能改写另一个标签正在生成的会话（那会推进 revision 并让对方冲突）。
   * 用户在本页开始新动作（发送/重试/重命名）时才走事务与版本检查。
   */
  if (interrupted > 0) {
    if (useWorkbenchStore.getState().accountId !== account || accountEpoch !== epoch) return { interrupted };
    useWorkbenchStore.setState((state) => ({ interrupted: { ...state.interrupted, [sessionId]: interrupted } }));
  }
  return { interrupted };
}

/** 初始化：列表 + 偏好；读取失败保持 error，不当作空库。 */
export async function hydrateSessions(api: SessionApi): Promise<{ sessions: SessionSummary[]; preference: WorkbenchPreference }> {
  const store = useWorkbenchStore.getState();
  // T2a 账号守卫：捕获发起账号与代数；切号后迟到的列表/详情/偏好一律丢弃。
  const account = store.accountId;
  const epoch = accountEpoch;
  store.setStatus("loading");
  try {
    const [sessions, preference] = await Promise.all([api.list(), api.readPreference()]);
    if (useWorkbenchStore.getState().accountId !== account || accountEpoch !== epoch) return { sessions, preference };
    store.setStatus("ready");
    /*
     * SP3：保留**全部**摘要作为入口（loaded:false 的占位），只给活动会话加载详情。
     * 未加载的会话不会被写回（saveSession 直接拒绝），所以不会用空消息覆盖服务端。
     */
    useWorkbenchStore.setState({
      sessions: sessions.map(summary => ({
        id: summary.id,
        title: summary.title,
        scope: { kind: "free" as const },
        messages: [],
        updatedAt: summary.updatedAt,
        loaded: false,
        ...(summary.renamed ? { renamed: true } : {})
      })),
      activeId: undefined,
      revisions: Object.fromEntries(sessions.map(summary => [summary.id, summary.revision])),
      preferenceRevision: preference.revision
    });
    /*
     * 有偏好会话就读它；没有偏好（例如会话是新建后直接发送的）退回最近更新的一条，
     * 刷新后仍然能看到记录，而不是空列表。
     */
    const target = preference.activeSessionId ?? sessions[0]?.id;
    if (target) {
      await loadSession(api, target);
      if (useWorkbenchStore.getState().accountId !== account || accountEpoch !== epoch) return { sessions, preference };
      useWorkbenchStore.setState({ activeId: target });
    }
    return { sessions, preference };
  } catch (error) {
    if (useWorkbenchStore.getState().accountId !== account || accountEpoch !== epoch) throw error;
    store.setStatus("error", error instanceof Error ? error.message : "读取会话失败。");
    throw error;
  }
}

/** 激活会话（新建/首次发送后）：本地选中 + 写入偏好；偏好失败不影响会话可用。 */
export async function activateSession(api: SessionApi, sessionId: string): Promise<void> {
  useWorkbenchStore.setState({ activeId: sessionId });
  const account = useWorkbenchStore.getState().accountId;
  const epoch = accountEpoch;
  const revision = useWorkbenchStore.getState().preferenceRevision;
  try {
    const preference = await api.writePreference({ baseRevision: revision, activeSessionId: sessionId });
    useWorkbenchStore.getState().setPreferenceRevision(preference.revision, account ?? undefined, epoch);
  } catch {
    /* 偏好写失败不影响会话本身 */
  }
}

/** 切换会话：先尝试提交当前会话，失败就留在原处（不允许丢草稿）。 */
export async function switchSession(api: SessionApi, nextId: string): Promise<boolean> {
  const current = useWorkbenchStore.getState().activeId;
  if (current && current !== nextId) {
    /*
     * 只以**本次提交的结果**放行：读取 await 之前的 saveStates 会拿到陈旧状态，
     * 让刚失败的保存被旧的「已保存」放行（SP6）。
     */
    const saved = await commitSession(api, current);
    if (!saved) return false;
  }
  await loadSession(api, nextId);
  await activateSession(api, nextId);
  return true;
}
