"use client";

import { useDismissableLayer } from "@/lib/dismissable-layer";

/**
 * 范围 / 目标选择器（一个组件三种用法，避免做三个几乎一样的弹窗）：
 * - `scope`：工作范围（自由对话 / 笔记本 / 笔记）；
 * - `insert-note`：插入到某篇笔记；
 * - `new-note`：选笔记本并填标题，保存为新笔记。
 *
 * 统一交互：搜索、空状态、返回与取消、Esc 关闭并把焦点还给打开它的按钮。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, BookText, Check, MessageSquare, NotebookPen, Search, X } from "lucide-react";
import { sameScope, type WorkbenchNotebook, type WorkbenchScope, type WriteTarget } from "./workbench-types";

export type PickerMode = "scope" | "insert-note" | "new-note";

type Props = {
  mode: PickerMode;
  notebooks: WorkbenchNotebook[];
  currentScope?: WorkbenchScope;
  onSelect: (value: WorkbenchScope | WriteTarget) => void;
  onClose: () => void;
};

const TITLES: Record<PickerMode, string> = {
  scope: "选择参考笔记",
  "insert-note": "插入到哪篇笔记",
  "new-note": "保存为新笔记"
};

export function WorkbenchPicker({ mode, notebooks, currentScope, onSelect, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [step, setStep] = useState<"list" | "title">("list");
  const [notebook, setNotebook] = useState<WorkbenchNotebook>();
  const [title, setTitle] = useState("");
  const modalRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  useDismissableLayer(cardRef, true, onClose);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  // 打开时聚焦搜索框，关闭时把焦点还给触发的按钮（键盘可用性要求）。
  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    return () => restoreRef.current?.focus?.();
  }, []);
  useEffect(() => {
    if (step === "list") searchRef.current?.focus();
  }, [step]);

  const isSelected = (scope: WorkbenchScope) => mode === "scope" && currentScope !== undefined && sameScope(currentScope, scope);

  const keyword = query.trim();
  const groups = useMemo(
    () =>
      notebooks
        .map((item) => {
          const notebookHit = !keyword || item.title.includes(keyword);
          const notes = notebookHit ? item.notes : item.notes.filter((note) => note.title.includes(keyword));
          return { notebook: item, notes, visible: notebookHit || notes.length > 0 };
        })
        .filter((group) => group.visible),
    [notebooks, keyword]
  );

  const pickNotebook = (target: WorkbenchNotebook) => {
    if (mode === "scope") {
      onSelect({ kind: "notebook", notebookId: target.id, notebookTitle: target.title });
      return;
    }
    if (mode === "insert-note") return; // 插入必须落到具体笔记
    setNotebook(target);
    setTitle("");
    setStep("title");
  };

  return (
    <div
      ref={modalRef}
      className="wb-modal wb-reference-picker"
      data-picker-mode={mode}
      onKeyDown={event => {
        if (event.key !== "Tab") return;
        const nodes = Array.from(modalRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), [tabindex='0']") ?? []);
        const first = nodes[0]; const last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}
      role="dialog"
      aria-modal="true"
      aria-label={TITLES[mode]}
    >
      <div ref={cardRef} className="wb-modal-card">
        <header className="wb-modal-head">
          {step === "title" ? <button type="button" className="wb-icon-button" aria-label="返回" title="返回" onClick={() => setStep("list")}><ArrowLeft size={18} aria-hidden /></button> : null}
          <h3>{TITLES[mode]}</h3>
          <button type="button" className="wb-icon-button" aria-label="关闭" title="关闭" onClick={onClose}>
            <X size={18} aria-hidden />
          </button>
        </header>

        {step === "title" ? (
          <div className="wb-modal-title-step">
            <p className="wb-modal-hint">
              笔记本：<strong>{notebook?.title}</strong>
            </p>
            <label className="wb-field">
              <span>笔记标题</span>
              <input
                value={title}
                autoFocus
                placeholder="例如：松阳三天的整理"
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <div className="wb-modal-actions">
              <button
                type="button"
                className="primary-button"
                disabled={title.trim().length === 0}
                onClick={() =>
                  notebook &&
                  onSelect({ kind: "new-note", notebookId: notebook.id, notebookTitle: notebook.title, title: title.trim() })
                }
              >
                使用这个标题
              </button>
              <button type="button" className="secondary-button" onClick={() => setStep("list")}>
                返回
              </button>
            </div>
          </div>
        ) : (
          <>
            <label className="wb-search">
              <Search size={14} aria-hidden />
              <input
                ref={searchRef}
                value={query}
                placeholder="搜索笔记本或笔记标题"
                aria-label="搜索笔记本或笔记"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>

            <div className="wb-picker-results">
            {mode === "scope" ? (
              <button
                type="button"
                className="wb-picker-free"
                onClick={() => onSelect({ kind: "free" })}
                aria-label="切换到自由对话"
                title="自由对话"
                data-selected={isSelected({ kind: "free" }) || undefined}
                aria-current={isSelected({ kind: "free" }) || undefined}
              >
                <MessageSquare size={16} aria-hidden />
                <span>
                  <strong>自由对话</strong>
                </span>
                {isSelected({ kind: "free" }) ? <Check size={16} className="wb-picker-check" aria-hidden /> : null}
              </button>
            ) : null}

            {notebooks.length === 0 ? (
              <p className="wb-empty-note">还没有笔记本。先在「笔记本」里新建一本，再回来选范围。</p>
            ) : groups.length === 0 ? (
              <p className="wb-empty-note">没有匹配「{keyword}」的笔记本或笔记。</p>
            ) : (
              <ul className="wb-picker-list">
                {groups.map(({ notebook: item, notes }) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="wb-picker-notebook"
                      title={item.title}
                      data-selected={isSelected({ kind: "notebook", notebookId: item.id, notebookTitle: item.title }) || undefined}
                      aria-current={isSelected({ kind: "notebook", notebookId: item.id, notebookTitle: item.title }) || undefined}
                      disabled={mode === "insert-note"}
                      onClick={() => pickNotebook(item)}
                    >
                      <BookText size={15} aria-hidden />
                      <span>{item.title}</span>
                      <small>{item.notes.length} 篇笔记</small>
                      {isSelected({ kind: "notebook", notebookId: item.id, notebookTitle: item.title }) ? <Check size={16} className="wb-picker-check" aria-hidden /> : null}
                    </button>
                    {notes.length > 0 ? (
                      <ul className="wb-picker-notes">
                        {notes.map((note) => (
                          <li key={note.id}>
                            <button
                              type="button"
                              disabled={mode === "new-note"}
                              title={note.title}
                              data-selected={isSelected({ kind: "note", notebookId: item.id, notebookTitle: item.title, noteId: note.id, noteTitle: note.title }) || undefined}
                              aria-current={isSelected({ kind: "note", notebookId: item.id, notebookTitle: item.title, noteId: note.id, noteTitle: note.title }) || undefined}
                              onClick={() =>
                                onSelect({
                                  kind: mode === "scope" ? "note" : "insert-into-note",
                                  notebookId: item.id,
                                  notebookTitle: item.title,
                                  noteId: note.id,
                                  noteTitle: note.title
                                })
                              }
                            >
                              <NotebookPen size={14} aria-hidden />
                              <span>{note.title}</span>
                              {isSelected({ kind: "note", notebookId: item.id, notebookTitle: item.title, noteId: note.id, noteTitle: note.title }) ? <Check size={16} className="wb-picker-check" aria-hidden /> : null}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
