"use client";
import { useTimedNotice } from "@/lib/use-timed-notice";

/**
 * 随记：便签式素材区（工作台右栏 / 窄屏独立面板）。
 *
 * 定位：素材先进随记，再经「整理成笔记」或「用于对话」进入下一步；
 * 使用素材创作后原随记保留，不做任何原地删除或改写。
 *
 * 保存语义（复审 W1/W2/W5 后重写）：
 * - **输入即存**：新随记与编辑已有随记都按 700ms 防抖自动保存，界面状态对应当次真实写入结果；
 * - **一个条目一个槽位**：切换编辑对象不会取消另一个条目的待保存内容；关闭面板/离开工作台前
 *   把仍在防抖里的草稿立刻提交（不丢稿）；
 * - **提交串行**：一次写完再写下一次，并发基线用回读到的 updatedAt 更新，避免自我冲突；
 * - **结果归属提交版本**：只有“当前文本 == 刚写成功的文本”才显示「已自动保存」，
 *   旧请求完成不会把更新过的输入标成已保存；
 * - **删除各自计时、各自可撤销**：删除第二条不取消第一条，关闭面板也不是隐式撤销。
 *
 * 数据复用既有 capture 归档（真实持久化），本组件不做第二套存储。
 * 新增/编辑只处理文本；带图片的素材仍在记录侧（地图页捕获面板）产生，本面板负责展示与引用。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import type { ArchiveCore } from "@/features/notebook/notebook-repository";
import { CaptureOrganizePanel } from "@/features/capture/capture-organize-panel";
import type { CaptureMessage } from "@/features/capture/capture-model";
import type { MaterialReference, QuickNoteCandidate } from "./workbench-types";
import { useWorkbenchStore } from "./workbench-store";

type SaveStatus = { state: "idle" | "saving" | "saved" | "failed"; error?: string };

type SlotBaseline = { messageId?: string; updatedAt: string; text: string };
/** 排队中的一次保存：只记「哪个槽位、最新文本」，基线在执行时再取（见 commit）。 */
type Pending = { slot: string; text: string };
/**
 * 失败草稿：除了文字与原因，还要带上**条目身份**与并发基线。
 * 否则「新随记已创建、后续更新失败」的情况下，重试会因为找不到原条目 ID 而另建一条。
 */
type Draft = {
  text: string;
  error: string;
  messageId?: string;
  updatedAt?: string;
  /** 已成功写入的文本：恢复后用它判断“有没有改动”。 */
  baselineText?: string;
};

type Props = {
  messages: CaptureMessage[];
  mediaUrls: Record<string, string>;
  /** 整理成笔记的追加目标（既有笔记本档案）。 */
  archive: ArchiveCore;
  /** 既有 AI 能力状态：未启用时不假装可整理。 */
  aiEnabled: boolean;
  busy: boolean;
  /** 本地素材库不可用时的真实错误（不静默吞掉）。 */
  storeError?: string;
  /** 新建随记：返回写入后的条目，后续输入继续写同一条。 */
  onCreate: (input: { text: string }) => Promise<CaptureMessage>;
  /** 保存已有随记：返回状态与新的并发基线。 */
  onUpdate: (input: {
    messageId: string;
    text: string;
    expectedUpdatedAt: string;
  }) => Promise<{ status: string; updatedAt?: string } | string>;
  onDelete: (messageId: string) => Promise<void>;
  onUseAsMaterial: (items: MaterialReference[]) => void;
  onArchive: (ids: string[]) => Promise<void>;
  onReload: () => Promise<void>;
  search: (query: string, notes: { id: string; text: string; createdAt: string }[]) => Promise<QuickNoteCandidate[]>;
  onClose: () => void;
};

const SAVE_DEBOUNCE_MS = 700;
const DELETE_DELAY_MS = 4000;
/** 新随记槽位的固定 key：写入成功后升级为真实条目 id。 */
const NEW_SLOT = "new";

/**
 * 写入失败的草稿：面板关闭或切页后实例已卸载，草稿不能只留在组件 state 里。
 * 放在模块级，重新打开随记时按槽位找回（同一浏览器会话内有效，不写浏览器存储）。
 *
 * T2a 复核二：草稿**按账号分桶**——账号来自挂载时的工作台 Store（XingjiApp 已在
 * 挂载业务前 reset 登记）；记住草稿/找回草稿都捕获发起账号，迟到的失败只写
 * **原账号**的桶，切号后的面板读不到上一账号的草稿，重试也不会写进新账号。
 */
const failedDrafts = new Map<string, Map<string, Draft>>();

function draftBucket(account: string | null): Map<string, Draft> {
  const key = account ?? "";
  let bucket = failedDrafts.get(key);
  if (!bucket) {
    bucket = new Map();
    failedDrafts.set(key, bucket);
  }
  return bucket;
}

function snapshotDrafts(account: string | null): Record<string, Draft> {
  return Object.fromEntries(draftBucket(account));
}

function formatTime(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

function labelOf(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 16) : "（无文字）";
}

function describe(status: SaveStatus | undefined): string {
  if (!status) return "";
  if (status.state === "saving") return "保存中…";
  if (status.state === "saved") return "已自动保存";
  if (status.state === "failed") return status.error ? `保存失败：${status.error}` : "保存失败";
  return "";
}

export function QuickNotesPanel({
  messages,
  mediaUrls,
  archive,
  aiEnabled,
  busy,
  storeError,
  onCreate,
  onUpdate,
  onDelete,
  onUseAsMaterial,
  onArchive,
  onReload,
  search,
  onClose
}: Props) {
  // T2a：挂载时的账号（Store 已在业务树挂载前登记）；本面板实例的草稿读写都归属它。
  const account = useWorkbenchStore.getState().accountId;
  const accountRef = useRef(account);
  const [selected, setSelected] = useState<string[]>([]);
  /** 失败草稿的可见副本：跨卸载保留在 failedDrafts 里（仅本账号桶）。 */
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => snapshotDrafts(account));
  const [newText, setNewText] = useState(() => draftBucket(account).get(NEW_SLOT)?.text ?? "");
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  const [statuses, setStatuses] = useState<Record<string, SaveStatus>>((): Record<string, SaveStatus> => {
    const draft = draftBucket(account).get(NEW_SLOT);
    return draft ? { [NEW_SLOT]: { state: "failed", error: draft.error } } : {};
  });
  const [pendingDeletes, setPendingDeletes] = useState<{ id: string; text: string }[]>([]);
  const [finding, setFinding] = useState<{ open: boolean; query: string; candidates?: QuickNoteCandidate[]; picked: string[] }>({
    open: false,
    query: "",
    picked: []
  });
  const [notice, setNotice] = useTimedNotice();

  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const deleteTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const payloads = useRef(new Map<string, Pending>());
  /** 每个槽位「已排队 + 在途」的提交笔数：只有归零才算真的保存完。 */
  const outstanding = useRef(new Map<string, number>());
  const slots = useRef(new Map<string, SlotBaseline>());
  /** 提交串行链：并发基线始终来自上一次写入结果。 */
  const chain = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);

  const setStatus = useCallback((slot: string, status: SaveStatus) => {
    if (!mounted.current) return;
    setStatuses((current) => ({ ...current, [slot]: status }));
  }, []);

  /** 记下失败草稿：即使面板已经卸载也留得住，重新打开能找回，且仍指向同一条目。
   *  账号在面板实例创建时捕获——迟到的失败写回**原账号**的桶。 */
  const rememberDraft = useCallback((slot: string, text: string, error: string) => {
    const baseline = slots.current.get(slot);
    draftBucket(accountRef.current).set(slot, {
      text,
      error,
      ...(baseline?.messageId ? { messageId: baseline.messageId } : {}),
      ...(baseline ? { updatedAt: baseline.updatedAt, baselineText: baseline.text } : {})
    });
    if (mounted.current) setDrafts(snapshotDrafts(accountRef.current));
  }, []);

  const forgetDraft = useCallback((slot: string) => {
    if (!draftBucket(accountRef.current).delete(slot)) return;
    if (mounted.current) setDrafts(snapshotDrafts(accountRef.current));
  }, []);

  /** 真正写一次；失败保留草稿并显示原因，不谎报已保存。 */
  const commit = useCallback(
    async (payload: Pending) => {
      const { slot } = payload;
      // 关键：基线在**真正执行时**取，而不是排队时。
      // 上一笔刚回读到新 updatedAt / 新建刚拿到真实条目 id，这一笔就接着它写，
      // 否则会拿旧版本号自我冲突，或对同一条新随记重复创建。
      const baseline = slots.current.get(slot);
      try {
        if (baseline?.messageId) {
          // 文本没变就不写，避免无意义的版本推进。
          if (baseline.text === payload.text) {
            forgetDraft(slot);
            if ((outstanding.current.get(slot) ?? 1) <= 1) setStatus(slot, { state: "saved" });
            return;
          }
          const result = await onUpdate({
            messageId: baseline.messageId,
            text: payload.text,
            expectedUpdatedAt: baseline.updatedAt
          });
          // 允许实现只回状态字符串；带上 updatedAt 时用它更新并发基线。
          const status = typeof result === "string" ? result : result.status;
          const updatedAt = typeof result === "string" ? undefined : result.updatedAt;
          if (status !== "updated") {
            const reason = status === "conflict" ? "内容已在别处改动，请重新载入" : "这一条已不存在";
            rememberDraft(slot, payload.text, reason);
            setStatus(slot, { state: "failed", error: reason });
            return;
          }
          slots.current.set(slot, {
            messageId: baseline.messageId,
            updatedAt: updatedAt ?? baseline.updatedAt,
            text: payload.text
          });
        } else {
          const created = await onCreate({ text: payload.text });
          // 新建成功：槽位升级为这条真实条目，后续排队中的输入接续它更新。
          slots.current.set(slot, { messageId: created.id, updatedAt: created.updatedAt, text: payload.text });
        }
        forgetDraft(slot);
        if ((outstanding.current.get(slot) ?? 1) <= 1) setStatus(slot, { state: "saved" });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "写入未完成";
        rememberDraft(slot, payload.text, reason);
        setStatus(slot, { state: "failed", error: reason });
      } finally {
        outstanding.current.set(slot, Math.max(0, (outstanding.current.get(slot) ?? 1) - 1));
      }
    },
    [forgetDraft, onCreate, onUpdate, rememberDraft, setStatus]
  );

  const flush = useCallback(
    (slot: string) => {
      const payload = payloads.current.get(slot);
      if (!payload) return;
      payloads.current.delete(slot);
      const timer = timers.current.get(slot);
      if (timer) clearTimeout(timer);
      timers.current.delete(slot);
      chain.current = chain.current.then(() => commit(payload)).catch(() => {});
    },
    [commit]
  );

  /** 排队一次保存：同一槽位的新输入覆盖旧草稿，不同槽位互不影响。 */
  const schedule = useCallback(
    (slot: string, text: string) => {
      // 同一槽位已有排队中的一次提交时不再加计数：新文本会搭这一笔一起写。
      if (!payloads.current.has(slot)) {
        outstanding.current.set(slot, (outstanding.current.get(slot) ?? 0) + 1);
      }
      payloads.current.set(slot, { slot, text });
      const timer = timers.current.get(slot);
      if (timer) clearTimeout(timer);
      setStatus(slot, { state: "saving" });
      timers.current.set(
        slot,
        setTimeout(() => flush(slot), SAVE_DEBOUNCE_MS)
      );
    },
    [flush, setStatus]
  );

  /**
   * 恢复上次失败的草稿：把草稿携带的条目身份与基线放回槽位，
   * 这样「重试保存」更新的是原条目，而不是再新建一条。
   */
  useEffect(() => {
    for (const [slot, draft] of Object.entries(snapshotDrafts(account))) {
      if (!draft.messageId) continue;
      slots.current.set(slot, {
        messageId: draft.messageId,
        updatedAt: draft.updatedAt ?? "",
        text: draft.baselineText ?? ""
      });
    }
  }, []);

  /** 关闭面板 / 离开工作台：把还在防抖里的草稿立刻提交，不丢稿。 */
  useEffect(() => {
    mounted.current = true;
    // 固定住这份 Map：卸载时按当时仍在排队的槽位逐个提交。
    const pending = payloads.current;
    return () => {
      mounted.current = false;
      for (const slot of [...pending.keys()]) flush(slot);
      // 删除计时器**不清**：删除照常执行，关闭面板不等于撤销。
    };
  }, [flush]);

  const startEdit = (message: CaptureMessage) => {
    // 正在编辑这一条时撤回它待执行的删除：用户已经反悔了，不该在几秒后消失。
    if (deleteTimers.current.has(message.id)) {
      undoDelete(message.id);
    }
    // 切换编辑对象不做隐式丢弃：上一条的草稿有自己的槽位与计时器。
    slots.current.set(message.id, { messageId: message.id, updatedAt: message.updatedAt, text: message.text });
    // 上一次写入失败留下的草稿优先于已持久化文本，打开就能接着改。
    setEditing({ id: message.id, text: drafts[message.id]?.text ?? message.text });
    const draft = drafts[message.id];
    setStatus(message.id, draft ? { state: "failed", error: draft.error } : { state: "idle" });
  };

  const finishEdit = () => {
    if (editing) flush(editing.id);
    setEditing(undefined);
  };

  const resetNew = () => {
    setNewText("");
    slots.current.delete(NEW_SLOT);
    setStatuses((current) => ({ ...current, [NEW_SLOT]: { state: "idle" } }));
  };

  /** 删除：先登记，延迟执行，期间可单独撤销；彼此不互相取消。 */
  const remove = (message: CaptureMessage) => {
    setPendingDeletes((current) =>
      current.some((item) => item.id === message.id) ? current : [...current, { id: message.id, text: message.text }]
    );
    const timer = setTimeout(() => {
      void (async () => {
        deleteTimers.current.delete(message.id);
        try {
          await onDelete(message.id);
        } catch (error) {
          if (mounted.current) {
            setNotice(`删除「${labelOf(message.text)}」失败：${error instanceof Error ? error.message : "存储不可用"}`);
          }
          return;
        }
        if (!mounted.current) return;
        setPendingDeletes((current) => current.filter((item) => item.id !== message.id));
        setSelected((current) => current.filter((id) => id !== message.id));
        setEditing((current) => (current?.id === message.id ? undefined : current));
        setNotice("已删除 1 条随记。");
      })();
    }, DELETE_DELAY_MS);
    deleteTimers.current.set(message.id, timer);
  };

  const undoDelete = (id: string) => {
    const timer = deleteTimers.current.get(id);
    if (timer) clearTimeout(timer);
    deleteTimers.current.delete(id);
    setPendingDeletes((current) => current.filter((item) => item.id !== id));
    setNotice("已保留这条随记。");
  };

  const toggle = (id: string) =>
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));

  /** 引用到对话：选中条目按时间正序进入输入区，原随记保持不动。 */
  const referenceToChat = (ids: string[]) => {
    const items = messages
      .filter((message) => ids.includes(message.id))
      .sort((a, b) => (a.capturedAt < b.capturedAt ? -1 : 1))
      .map((message) => ({ id: message.id, text: message.text, createdAt: message.capturedAt }));
    if (items.length === 0) return;
    onUseAsMaterial(items);
    setSelected([]);
    setFinding({ open: false, query: "", picked: [] });
    setNotice(`已引用 ${items.length} 条随记，可在输入区查看或移除。`);
  };

  const runSearch = () => {
    void (async () => {
      const candidates = await search(
        finding.query,
        messages.map((message) => ({ id: message.id, text: message.text, createdAt: message.capturedAt }))
      );
      setFinding((current) => ({ ...current, candidates, picked: [] }));
    })();
  };

  const newStatus = statuses[NEW_SLOT];

  return (
    <section className="wb-panel wb-notes" aria-label="随记">
      <header className="wb-panel-head">
        <div>
          <h2 title={`随记（${messages.length} 条素材）`}>随记</h2>
          <p className="ui-secondary-copy">{messages.length} 条素材</p>
        </div>
        <button type="button" className="wb-icon-button" aria-label="关闭" title="关闭随记" onClick={onClose}>
          <X size={18} aria-hidden />
        </button>
      </header>

      {storeError ? (
        <p className="wb-notes-notice" role="alert">
          本地素材库读取失败：{storeError}（随记可能不完整，刷新后重试。）
        </p>
      ) : null}

      {/* 便签式新建：写一句就自动保存，不需要标题，也不用按保存。 */}
      {editing ? null : (
        <div className="wb-new-note">
          <label className="wb-field">
            <span className="ui-secondary-copy">新随记内容</span>
            <textarea
              rows={3}
              aria-label="新随记内容"
              title="新随记内容；停下来会自动保存"
              value={newText}
              disabled={busy}
              placeholder="写一条随记…停下来就会自动保存"
              onChange={(event) => {
                setNewText(event.target.value);
                schedule(NEW_SLOT, event.target.value);
              }}
              onBlur={() => {
                if (newText.trim()) flush(NEW_SLOT);
              }}
            />
          </label>
          <div className="wb-new-note-foot">
            <span className="wb-save-state" aria-live="polite">
              {newText ? describe(newStatus) : ""}
            </span>
            {newStatus?.state === "failed" ? (
              <button type="button" className="secondary-button" onClick={() => schedule(NEW_SLOT, newText)}>
                重试保存
              </button>
            ) : null}
            {newStatus?.state === "saved" && newText ? (
              <button type="button" className="secondary-button" onClick={resetNew}>
                <Plus size={13} aria-hidden /> 新的一条
              </button>
            ) : null}
          </div>
        </div>
      )}

      <div className="wb-notes-tools">
        <button
          type="button"
          className="secondary-button"
          aria-expanded={finding.open}
          onClick={() => setFinding((current) => ({ ...current, open: !current.open, candidates: undefined }))}
        >
          <Search size={14} aria-hidden /> 查找随记
        </button>
        <span className="wb-notes-count">已选 {selected.length} 条</span>
        <button
          type="button"
          className="primary-button"
          disabled={selected.length === 0}
          onClick={() => referenceToChat(selected)}
        >
          用于对话
        </button>
        {selected.length > 0 ? (
          <button type="button" className="secondary-button" onClick={() => setSelected([])}>
            清除选择
          </button>
        ) : null}
      </div>

      {finding.open ? (
        <div className="wb-find" aria-label="查找随记">
          <div className="wb-find-row">
            <label className="wb-search">
              <Search size={14} aria-hidden />
              <input
                value={finding.query}
                placeholder="想找什么素材，例如：吃的、住宿、路线"
                aria-label="查找随记的关键词"
                onChange={(event) => setFinding((current) => ({ ...current, query: event.target.value }))}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    runSearch();
                  }
                }}
              />
            </label>
            <button type="button" className="secondary-button" onClick={runSearch}>
              查找
            </button>
          </div>
          {finding.candidates ? (
            finding.candidates.length === 0 ? (
              <p className="wb-empty-note">没有找到候选随记，换个词试试。</p>
            ) : (
              <ul className="wb-find-list">
                {finding.candidates.map((candidate) => (
                  <li key={candidate.id}>
                    <label className="wb-find-item">
                      <input
                        type="checkbox"
                        checked={finding.picked.includes(candidate.id)}
                        onChange={() =>
                          setFinding((current) => ({
                            ...current,
                            picked: current.picked.includes(candidate.id)
                              ? current.picked.filter((id) => id !== candidate.id)
                              : [...current.picked, candidate.id]
                          }))
                        }
                      />
                      <span>{candidate.text || "（无文字）"}</span>
                      <small>{formatTime(candidate.createdAt)}</small>
                    </label>
                  </li>
                ))}
              </ul>
            )
          ) : null}
          <div className="wb-find-actions">
            <button
              type="button"
              className="primary-button"
              disabled={finding.picked.length === 0}
              onClick={() => referenceToChat(finding.picked)}
            >
              引用选中
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setFinding({ open: false, query: "", picked: [] })}
            >
              取消
            </button>
          </div>
        </div>
      ) : null}

      {notice ? (
        <p className="global-notice" role="status">
          {notice}
        </p>
      ) : null}

      {pendingDeletes.length > 0 ? (
        <ul className="wb-undo-list" aria-label="待删除的随记">
          {pendingDeletes.map((item) => (
            <li key={item.id} className="wb-undo">
              <span>「{labelOf(item.text)}」将在几秒后删除。</span>
              <button type="button" className="secondary-button" onClick={() => undoDelete(item.id)}>
                撤销
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {messages.length === 0 ? (
        <p className="wb-empty-note">还没有随记。</p>
      ) : (
        <ul className="wb-note-list">
          {messages.map((message) => {
            const isEditing = editing?.id === message.id;
            const status = statuses[message.id];
            return (
              <li key={message.id} className="wb-note" data-selected={selected.includes(message.id)}>
                <label className="wb-note-pick">
                  <input
                    type="checkbox"
                    checked={selected.includes(message.id)}
                    aria-label={`选择随记：${labelOf(message.text)}`}
                    onChange={() => toggle(message.id)}
                  />
                  <time dateTime={message.capturedAt}>{formatTime(message.capturedAt)}</time>
                </label>
                {isEditing ? (
                  <div className="wb-note-edit">
                    <label className="wb-field">
                      <span className="sr-only">随记内容</span>
                      <textarea
                        rows={3}
                        value={editing.text}
                        autoFocus
                        onChange={(event) => {
                          setEditing({ id: message.id, text: event.target.value });
                          schedule(message.id, event.target.value);
                        }}
                      />
                    </label>
                    <div className="wb-note-edit-foot">
                      <span className="wb-save-state" aria-live="polite">
                        {describe(status)}
                      </span>
                      {status?.state === "failed" ? (
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => schedule(message.id, editing.text)}
                        >
                          重试保存
                        </button>
                      ) : null}
                      <button type="button" className="secondary-button" onClick={finishEdit}>
                        <Check size={13} aria-hidden /> 完成
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {message.text ? <p className="wb-note-text">{message.text}</p> : null}
                    {message.mediaIds.length > 0 ? (
                      <ul className="wb-note-media">
                        {message.mediaIds.map((mediaId) =>
                          mediaUrls[mediaId] ? (
                            <li key={mediaId}>
                              {/* 本地 Data URL 预览，不走 next/image。 */}
                              <img src={mediaUrls[mediaId]} alt="" aria-hidden="true" />
                            </li>
                          ) : (
                            <li key={mediaId} className="wb-note-media-missing">
                              图片暂不可用
                            </li>
                          )
                        )}
                      </ul>
                    ) : null}
                    {drafts[message.id] ? (
                      <p className="wb-note-draft" role="status">
                        有未保存的草稿（{drafts[message.id].error}），编辑可继续。
                      </p>
                    ) : null}
                    <div className="wb-note-actions">
                      <button type="button" className="secondary-button" onClick={() => startEdit(message)}>
                        <Pencil size={13} aria-hidden /> 编辑
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={selected.includes(message.id)}
                        onClick={() => referenceToChat([message.id])}
                      >
                        用于对话
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        data-tone="danger"
                        onClick={() => remove(message)}
                      >
                        <Trash2 size={13} aria-hidden /> 删除
                      </button>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <details className="wb-organize" open={selected.length > 0}>
        <summary>整理成笔记（选中 {selected.length} 条）</summary>
        <CaptureOrganizePanel
          selected={selected}
          active={aiEnabled}
          archive={archive}
          onSaved={onReload}
          onArchive={onArchive}
        />
      </details>
    </section>
  );
}
