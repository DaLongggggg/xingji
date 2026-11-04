/**
 * 021 原生笔记式笔记本工作区的三个子组件。
 *
 * 设计边界：
 * - 只负责**呈现与本地 UI 状态**（搜索词、移动端层级、更多面板开合）；
 * - 不持有草稿、不直接读写存储：保存、离开守卫、数据命令仍由 `NotebookPageView`
 *   的既有 `beginEdit` / `handleSaveEdit` / `requestSwitch` 链统一处理；
 * - 不读取图片 Blob 生成预览（篇条目只用标题、正文摘要与时间）。
 */
"use client";

import { useDismissableLayer } from "@/lib/dismissable-layer";

import { useRef, useState, type ReactNode, type KeyboardEvent } from "react";
import { ChevronRight, PanelLeftClose, Plus, Search, MoreHorizontal, MessageSquare, Folder, FolderPlus, SquarePen, ImagePlus } from "lucide-react";
import type { NotebookPage } from "./notebook-model";
import type { Notebook } from "./notebook-model";
import { getPageSummary, searchPages } from "./notebook-query";

/**
 * 第一篇正文摘要：委托正式查询层（P0-02）——实现单一来源，行为与原组件内版本一致。
 * 保留导出以兼容既有调用方。
 */
export function pageSummary(page: NotebookPage, max = 48): string {
  return getPageSummary(page, max);
}

export function pageTimeLabel(page: NotebookPage): string {
  return page.capturedAt.slice(0, 10);
}

export type NotebookListProps = {
  mobile?: boolean;
  mobileFooter?: ReactNode;
  onCreatePage?: () => void;
  renderPages?: () => ReactNode;
  notebooks: Notebook[];
  activeNotebookId: string;
  pageCounts: Record<string, number>;
  busy: boolean;
  onSelect: (notebookId: string) => void;
  onCreate: () => void;
  onCollapse?: () => void;
  onSearch?: () => void;
  searchOpen?: boolean;
  /**
   * 就地重命名当前笔记本（失焦或回车提交）。
   * 名字就是本栏顶部的输入框——改名入口放在顶部，不再占用栏底。
   */
  onRenameActive?: (title: string) => void;
  /** 带当前笔记本范围进入 AI 工作台。 */
  onOpenInWorkbench?: () => void;
  /** 本列表项「⋯」菜单里的整本只读分析。 */
  onAnalyze?: (notebook: Notebook) => void;
  /** 删除本走既有确认流程（移入垃圾桶，30 天内可恢复）。 */
  onDelete?: (notebook: Notebook) => void;
};

/** 左栏：笔记本列表。 */
export function NotebookList({
  mobile = false,
  mobileFooter,
  onCreatePage,
  renderPages,
  notebooks,
  activeNotebookId,
  pageCounts,
  busy,
  onSelect,
  onCreate,
  onCollapse,
  onSearch,
  searchOpen,
  onRenameActive,
  onAnalyze,
  onDelete,
  onOpenInWorkbench
}: NotebookListProps) {
  const [collapsedNotebookId, setCollapsedNotebookId] = useState<string | null>(null);
  const activeNotebook = notebooks.find((notebook) => notebook.id === activeNotebookId);
  /**
   * 名称用非受控输入 + key 跟随当前本：切本时自动换成新名字，
   * 打字期间不触发上层写入，只在失焦/回车提交一次。
   */
  const listContent = (notebooks.length === 0 ? (
        <p className="nb-empty" title="还没有笔记本。新建一本，或先把记录整理成笔记。">还没有笔记本<span className="ui-secondary-copy">。新建一本，或先把记录整理成笔记。</span></p>
      ) : (
        <ul className={mobile ? "nb-list nb-mobile-folders" : "nb-list"}>
          {notebooks.map((notebook) => (
            <li key={notebook.id}>
              <div className="nb-row">
                <button
                  type="button"
                  className={
                    !mobile && notebook.id === activeNotebookId ? "nb-list-item is-active" : "nb-list-item"
                  }
                  aria-current={!mobile && notebook.id === activeNotebookId ? "true" : undefined}
                  aria-expanded={mobile ? undefined : notebook.id === activeNotebookId && collapsedNotebookId !== notebook.id}
                  aria-controls={mobile ? undefined : `nb-book-pages-${notebook.id}`}
                  onClick={() => {
                    if (mobile) {
                      onSelect(notebook.id);
                    } else if (notebook.id === activeNotebookId) {
                      setCollapsedNotebookId((current) => current === notebook.id ? null : notebook.id);
                    } else {
                      setCollapsedNotebookId(null);
                      onSelect(notebook.id);
                    }
                  }}
                >
                  {mobile ? <Folder size={22} className="nb-mobile-folder-icon" aria-hidden /> : null}
                  <span>{notebook.title}</span>
                  <small>{pageCounts[notebook.id] ?? 0}{mobile ? "" : " 篇"}</small>
                  <ChevronRight size={15} aria-hidden />
                </button>
                {onAnalyze || onDelete ? (
                  <RowMenu
                    label={`笔记本操作：${notebook.title}`}
                    items={[
                      ...(onAnalyze
                        ? [{ key: "analyze", text: "总结整本", onSelect: () => onAnalyze(notebook) }]
                        : []),
                      ...(onDelete
                        ? [{ key: "delete", text: "删除笔记本", danger: true, onSelect: () => onDelete(notebook) }]
                        : [])
                    ]}
                  />
                ) : null}
              </div>
              {!mobile && notebook.id === activeNotebookId && collapsedNotebookId !== notebook.id ? (
                <div className="nb-book-pages" id={`nb-book-pages-${notebook.id}`}>
                  {renderPages?.()}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ));
  return (
    <div className={mobile ? "nb-col-body nb-mobile-folder-list" : "nb-col-body"} data-testid="notebook-list">
      {mobile ? (
        <header className="nb-mobile-heading">
          <h2 className="nb-mobile-title">笔记本</h2>
          <button type="button" className="nb-icon-button" aria-label="新建笔记本" title="新建笔记本" disabled={busy} onClick={onCreate}>
            <FolderPlus size={22} aria-hidden />
          </button>
        </header>
      ) : (
      <div className="nb-col-head">
        {activeNotebook && onRenameActive ? (
          /*
           * 名称用非受控输入 + key 跟随当前本：切本时自动换成新名字，
           * 打字期间不触发上层写入，只在失焦/回车提交一次。
           */
          <input
            className="nb-notebook-name"
            type="text"
            key={`${activeNotebook.id}:${activeNotebook.title}`}
            defaultValue={activeNotebook.title}
            aria-label="笔记本名称"
            title="改名（回车或失焦保存）"
            maxLength={60}
            onBlur={(event) => {
              const next = event.currentTarget.value.trim();
              if (!next || next === activeNotebook.title) event.currentTarget.value = activeNotebook.title;
              else onRenameActive(next);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.currentTarget.value = activeNotebook.title;
                event.currentTarget.blur();
              }
            }}
          />
        ) : (
          <strong>笔记本</strong>
        )}
        {onSearch && <button type="button" className="nb-icon-button" data-testid="search-open" aria-label="搜索笔记" title="搜索笔记" aria-expanded={searchOpen} onClick={onSearch}><Search size={16} aria-hidden /></button>}
        <button
          type="button"
          className="nb-icon-button"
          aria-label="新建笔记本"
          title="新建笔记本"
          disabled={busy}
          onClick={onCreate}
        >
          <Plus size={16} />
        </button>
        {/* 带着这一本的范围进 AI 工作台，避免到工作台再选一次。 */}
        {activeNotebook && onOpenInWorkbench ? (
          <button
            type="button"
            className="nb-icon-button"
            data-testid="open-in-workbench"
            aria-label={`在 AI 工作台中打开笔记本：${activeNotebook.title}`}
            title="在 AI 工作台中打开这本笔记本"
            onClick={onOpenInWorkbench}
          >
            <MessageSquare size={16} aria-hidden />
          </button>
        ) : null}
        {onCollapse ? (
          <button
            type="button"
            className="nb-icon-button nb-collapse-button"
            aria-label="收起笔记本目录"
            title="收起笔记本目录"
            onClick={onCollapse}
          >
            <PanelLeftClose size={16} />
          </button>
        ) : null}
      </div>
      )}
      {mobile ? <div className="nb-mobile-list-scroll">{listContent}{mobileFooter}</div> : listContent}
      {mobile ? (
        <div className="nb-mobile-bottom-bar">
          {onSearch ? <button type="button" className="nb-mobile-search-launcher" data-testid="search-open" aria-label="搜索笔记" title="搜索笔记" aria-expanded={searchOpen} onClick={onSearch}><Search size={20} aria-hidden /><span>搜索笔记</span></button> : null}
          {onCreatePage ? <button type="button" className="nb-icon-button nb-mobile-compose" aria-label="新建一篇" title="新建笔记" disabled={busy || !activeNotebookId} onClick={onCreatePage}><SquarePen size={23} aria-hidden /></button> : null}
        </div>
      ) : null}
    </div>
  );
}

export type NotebookPageListProps = {
  mobile?: boolean;
  onRename?: (title: string) => void;
  onOpenInWorkbench?: () => void;
  onCapture?: () => void;
  captureOpen?: boolean;
  notebookTitle: string;
  pages: NotebookPage[];
  activePageId: string;
  busy: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  onSelect: (page: NotebookPage) => void;
  onCreate: () => void;
  onBackToNotebooks?: () => void;
  /** 本轮调整：返回按钮附加类名（桌面端三栏常驻时用 `nb-stage-back` 隐藏）。 */
  backClassName?: string;
  onCollapse?: () => void;
  /**
   * 行内「⋯」气泡菜单的删除项（移入垃圾桶，可恢复）。
   * 删除走既有的删除确认流程，不在这里另写删除逻辑。
   */
  onDelete?: (page: NotebookPage) => void;
  /**
   * 行内「⋯」气泡菜单的移动项：选中该篇并展开工具栏既有的移动面板。
   * 只在**还有其他笔记本**可移入时由父层传入（与工具栏移动入口同一判据）；
   * 旧游记关联页只读，即使传入也不显示（见下方 `canMovePage`）。
   */
  onMove?: (page: NotebookPage) => void;
};

/** 中栏：当前本的篇列表（标题 + 摘要 + 时间，不读图片）。 */
export function NotebookPageList({
  mobile = false,
  onRename,
  onOpenInWorkbench,
  onCapture,
  captureOpen,
  notebookTitle,
  pages,
  activePageId,
  busy,
  query,
  onQueryChange,
  onSelect,
  onCreate,
  onBackToNotebooks,
  backClassName,
  onCollapse,
  onDelete,
  onMove
}: NotebookPageListProps) {
  // P0-02：搜索走正式查询层——匹配完整 text block，不再截断 500 字。
  const filtered = searchPages(pages, query);

  const listContent = (pages.length === 0 ? (
        <p className="nb-empty" title="还没有笔记，点击 + 开始记录。">还没有笔记<span className="ui-secondary-copy">，点击 + 开始记录。</span></p>
      ) : filtered.length === 0 ? (
        <p className="nb-empty">
          没有找到「{query.trim()}」，清空搜索查看全部笔记。
        </p>
      ) : (
        <ul className={mobile ? "nb-list nb-mobile-notes" : "nb-list"}>
          {filtered.map((page) => (
            <li key={page.id}>
              <div className="nb-row">
                <button
                  type="button"
                  className={page.id === activePageId ? "nb-list-item is-active" : "nb-list-item"}
                  aria-current={page.id === activePageId ? "true" : undefined}
                  onClick={() => onSelect(page)}
                >
                  <strong>{page.title}</strong>
                  {pageSummary(page) !== "（还没有正文）" ? <p>{pageSummary(page)}</p> : null}
                  <small>
                    {pageTimeLabel(page)}
                    {page.source.kind === "legacy-journal" ? " · 旧游记只读" : ""}
                  </small>
                </button>
                {onDelete || onMove ? (
                  <RowMenu
                    label={`笔记操作：${page.title}`}
                    items={[
                      /*
                       * 旧游记关联页只读、不显示移动（与工具栏移动入口同一判据）；
                       * 本栏所有篇都属于当前本，因此「还有别的本」由父层决定传不传 onMove。
                       */
                      ...(onMove && page.source.kind !== "legacy-journal"
                        ? [
                            {
                              key: "move",
                              text: "移动到其他笔记本",
                              onSelect: () => onMove(page)
                            }
                          ]
                        : []),
                      ...(onDelete
                        ? [
                            {
                              key: "delete",
                              text: "删除这一篇",
                              danger: true,
                              onSelect: () => onDelete(page)
                            }
                          ]
                        : [])
                    ]}
                  />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ));

  return (
    <div className={mobile ? "nb-col-body nb-mobile-page-list" : "nb-col-body"} data-testid="notebook-page-list">
      {mobile ? (
        <>
          <div className="nb-mobile-page-actions">
            {onBackToNotebooks ? <button type="button" className="nb-mobile-back" aria-label="返回笔记本列表" title="返回笔记本列表" onClick={onBackToNotebooks}><ChevronRight size={21} className="nb-icon-back" aria-hidden /><span>笔记本</span></button> : null}
            {onOpenInWorkbench ? <button type="button" className="nb-icon-button" aria-label={`在 AI 工作台中打开笔记本：${notebookTitle}`} title="在 AI 工作台中打开这本笔记本" data-testid="open-in-workbench" onClick={onOpenInWorkbench}><MessageSquare size={21} aria-hidden /></button> : null}
          </div>
          <header className="nb-mobile-heading">
            {onRename ? <input key={notebookTitle} className="nb-mobile-title" defaultValue={notebookTitle} aria-label="笔记本名称" title="改名（回车或失焦保存）" maxLength={60} onBlur={event => {
              const next = event.currentTarget.value.trim();
              if (!next || next === notebookTitle) event.currentTarget.value = notebookTitle;
              else onRename(next);
            }} onKeyDown={event => {
              if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
              if (event.key === "Escape") { event.preventDefault(); event.currentTarget.value = notebookTitle; event.currentTarget.blur(); }
            }} /> : <h2 className="nb-mobile-title">{notebookTitle}</h2>}
            <p className="nb-mobile-count">{pages.length} 篇笔记</p>
          </header>
        </>
      ) : (
      <div className="nb-col-head">
        {onBackToNotebooks ? (
          <button
            type="button"
            className={backClassName ? `nb-icon-button ${backClassName}` : "nb-icon-button"}
            aria-label="返回笔记本列表"
            title="返回笔记本列表"
            onClick={onBackToNotebooks}
          >
            <ChevronRight size={16} className="nb-icon-back" />
          </button>
        ) : null}
        <label className="nb-search-input">
        <Search size={14} aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索本内笔记"
          aria-label="搜索本内笔记"
        />
      </label>
        <button
          type="button"
          className="nb-icon-button"
          aria-label="新建一篇"
          title="新建笔记"
          disabled={busy || !notebookTitle}
          onClick={onCreate}
        >
          <Plus size={16} />
        </button>
        {onCollapse ? (
          <button
            type="button"
            className="nb-icon-button nb-collapse-button"
            aria-label="收起篇目录"
            title="收起篇目录"
            onClick={onCollapse}
          >
            <PanelLeftClose size={16} />
          </button>
        ) : null}
      </div>
      )}
      {mobile ? <div className="nb-mobile-list-scroll">{listContent}</div> : listContent}
      {mobile ? (
        <div className="nb-mobile-bottom-bar">
          {onCapture ? <button type="button" className="nb-icon-button" aria-label={captureOpen ? "收起图文新建" : "从文字或图片新建"} title={captureOpen ? "收起图文新建" : "从文字或图片新建"} aria-expanded={captureOpen} onClick={onCapture}><ImagePlus size={21} aria-hidden /></button> : null}
          <label className="nb-search-input"><Search size={19} aria-hidden /><input type="search" value={query} onChange={event => onQueryChange(event.target.value)} placeholder="搜索本内笔记" aria-label="搜索本内笔记" /></label>
          <button type="button" className="nb-icon-button nb-mobile-compose" aria-label="新建一篇" title="新建笔记" disabled={busy || !notebookTitle} onClick={onCreate}><SquarePen size={23} aria-hidden /></button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 行内「⋯」气泡菜单：取代原来的左滑操作栏。
 *
 * 左滑在桌面鼠标下几乎不可发现，`.nb-swipe-actions` 默认 `visibility:hidden`
 * 也让键盘与读屏都到不了删除/移动。改为显式的「⋯」按钮 + 气泡菜单。
 */
function RowMenu({
  label,
  items
}: {
  label: string;
  items: { key: string; text: string; danger?: boolean; onSelect: () => void }[];
}) {
  const [open, setOpen] = useState(false);
  /** 目录列表是 `overflow:auto` 的裁切容器：下方放不下就向上弹，否则气泡被裁掉一半。 */
  const [dropUp, setDropUp] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useDismissableLayer(menuRef, open, reason => close(reason === "escape"));

  /**
   * 气泡需要的高度上限（两项 44px + 内边距与边框）。取略大的常量而不是渲染后再量：
   * 一次渲染就能定好方向，不必二次测量再翻面。
   */
  const MENU_CLEARANCE = 104;

  /** 从「⋯」往上找第一个会裁切气泡的滚动祖先（`.nb-list`）；找不到就看视口。 */
  function clipLimit(trigger: HTMLElement): number {
    for (let node = trigger.parentElement; node; node = node.parentElement) {
      const { overflowY } = getComputedStyle(node);
      if (
        overflowY === "auto" ||
        overflowY === "scroll" ||
        overflowY === "hidden" ||
        overflowY === "clip"
      ) {
        return node.getBoundingClientRect().bottom;
      }
    }
    return window.innerHeight;
  }

  function toggle() {
    const next = !open;
    if (next && triggerRef.current) {
      const trigger = triggerRef.current;
      const room = clipLimit(trigger) - trigger.getBoundingClientRect().bottom;
      setDropUp(room < MENU_CLEARANCE);
    }
    setOpen(next);
  }

  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }

  /**
   * `role="menu"` 的最小键盘约定：上下键在「⋯」与菜单项之间移动，Escape 关闭并把焦点还给「⋯」。
   * 每一项都是真实 button，因此只用 Tab 也能到达；这里补齐菜单语义，不做别的自定义键位。
   */
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      close(true);
      return;
    }
    if (!open || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    const menuItems = popRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    const stops: HTMLElement[] = [
      ...(triggerRef.current ? [triggerRef.current] : []),
      ...Array.from(menuItems ?? [])
    ];
    const step = event.key === "ArrowDown" ? 1 : -1;
    const current = stops.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();
    stops[(current + step + stops.length) % stops.length]?.focus();
  }

  return (
    <div ref={menuRef} className="nb-row-menu" onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className="nb-icon-button nb-row-menu-open"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <MoreHorizontal size={16} aria-hidden />
      </button>
      {open ? (
          <div
            ref={popRef}
            className={dropUp ? "nb-row-menu-pop is-up" : "nb-row-menu-pop"}
            role="menu"
            aria-label={label}
          >
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                className={item.danger ? "nb-row-menu-item is-danger" : "nb-row-menu-item"}
                onClick={() => {
                  close(true);
                  item.onSelect();
                }}
              >
                {item.text}
              </button>
            ))}
          </div>
      ) : null}
    </div>
  );
}
