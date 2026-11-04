"use client";

import { copyWorkbenchText } from "./workbench-clipboard";

import { useDismissableLayer } from "@/lib/dismissable-layer";
import { Copy, Expand, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

/** The same sanitized HAST table supplied by react-markdown; no second parser or DOM scraping. */
export type MarkdownTableNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: readonly MarkdownTableNode[];
};

function cellText(node: MarkdownTableNode): string {
  if (node.type === "text") return node.value ?? "";
  if (node.tagName === "br") return "\n";
  if (node.tagName === "img") return typeof node.properties?.alt === "string" ? node.properties.alt : "";
  return (node.children ?? []).map(cellText).join("");
}

/** Quoted TSV keeps cell tabs/newlines/quotes inside their original column, including empty cells. */
export function markdownTableToTsv(node?: MarkdownTableNode): string {
  const rows: string[][] = [];
  const readRows = (part: MarkdownTableNode) => {
    if (part.tagName === "tr") {
      rows.push((part.children ?? []).filter(cell => cell.tagName === "th" || cell.tagName === "td").map(cellText));
    } else if (part.tagName === "table" || part.tagName === "thead" || part.tagName === "tbody" || part.tagName === "tfoot") {
      for (const child of part.children ?? []) readRows(child);
    }
  };
  if (node) readRows(node);
  const quote = (value: string) => /[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return rows.map(row => row.map(quote).join("\t")).join("\n");
}

type ScrollPosition = { element: HTMLElement; top: number; left: number };
function ancestorScrollPositions(element: HTMLElement): ScrollPosition[] {
  const positions: ScrollPosition[] = [];
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement)
    positions.push({ element: ancestor, top: ancestor.scrollTop, left: ancestor.scrollLeft });
  return positions;
}
function restoreScroll(positions: ScrollPosition[]) {
  for (const { element, top, left } of positions) {
    if (!element.isConnected) continue;
    element.scrollTop = top;
    element.scrollLeft = left;
  }
}

/** Component identity stays fixed while GFM appends rows; inline and modal scroll containers stay mounted. */
export function WorkbenchMarkdownTable({ children, node, pending }: { children?: ReactNode; node?: MarkdownTableNode; pending?: ReactNode }) {
  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const backgroundScroll = useRef<ScrollPosition[]>([]);
  const titleId = useId();
  const close = useCallback(() => setExpanded(false), []);
  useDismissableLayer(dialog, expanded, close);

  useEffect(() => {
    if (!expanded) return;
    const element = dialog.current;
    if (!element) return;
    const opener = trigger.current;
    if (!element.open) element.showModal();
    closeButton.current?.focus({ preventScroll: true });
    restoreScroll(backgroundScroll.current);
    return () => {
      if (element.open) element.close();
      if (opener?.isConnected) {
        opener.focus({ preventScroll: true });
        restoreScroll(backgroundScroll.current);
      }
    };
  }, [expanded]);

  const copy = async () => {
    try {
      await copyWorkbenchText(markdownTableToTsv(node));
      setNotice("表格已复制，可粘贴到表格软件。");
    } catch { setNotice("复制失败，请选中表格内容手动复制。"); }
  };
  const copyButton = <button type="button" onClick={() => void copy()}><Copy size={14} aria-hidden />复制表格</button>;

  return <div className="wb-table-block">
    <div className="wb-table-toolbar">
      {copyButton}
      <button type="button" ref={trigger} aria-haspopup="dialog" onClick={() => {
        if (trigger.current) backgroundScroll.current = ancestorScrollPositions(trigger.current);
        setExpanded(true);
      }}><Expand size={14} aria-hidden />展开表格</button>
    </div>
    <div className="wb-table-scroll" role="region" aria-label="表格" tabIndex={0}><table>{children}</table></div>
    {pending}
    {notice ? <p className="wb-table-notice" role={expanded ? undefined : "status"} aria-hidden={expanded || undefined}>{notice}</p> : null}
    {expanded ? <dialog ref={dialog} className="wb-table-dialog" aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); close(); }}
      // Modal image loads may reach the chat's load handler; retain the background reading position locally.
      onLoad={() => restoreScroll(backgroundScroll.current)}>
      <header><h2 id={titleId}>表格预览</h2><div className="wb-table-toolbar">
        {copyButton}
        <button type="button" ref={closeButton} aria-label="关闭表格预览" onClick={close}><X size={18} aria-hidden /></button>
      </div></header>
      <div className="wb-table-scroll" role="region" aria-label="展开的表格" tabIndex={0}><table>{children}</table></div>
      {pending}
      {notice ? <p className="wb-table-notice" role="status">{notice}</p> : null}
    </dialog> : null}
  </div>;
}
