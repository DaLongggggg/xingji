"use client";

import { useDismissableLayer } from "@/lib/dismissable-layer";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

/**
 * 024 更新：覆盖式居中确认弹窗。
 *
 * 用于删除笔记、删除笔记本、单项永久删除与清空垃圾桶。
 * 明确的交互契约（对应本轮验收）：
 * - 覆盖在页面上、居中，**不插入页面顶部**，不推挤工作区高度；
 * - Escape 关闭、点遮罩关闭、右上角关闭按钮；
 * - 打开时把焦点移到**取消/安全项**（危险操作不默认聚焦确认）；
 * - 关闭后焦点回到打开它的元素；
 * - Tab 焦点锁在弹窗内（`aria-modal`）。
 */
export type NotebookDialogProps = {
  open: boolean;
  /** 对话框标题（同时作为 aria-label）。 */
  title: string;
  /** 危险级别：决定确认按钮样式与默认焦点落点。 */
  tone?: "normal" | "danger" | "permanent";
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
};

export function NotebookDialog({
  open,
  title,
  tone = "normal",
  confirmLabel,
  cancelLabel = "取消",
  busy = false,
  onConfirm,
  onCancel,
  children
}: NotebookDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  useDismissableLayer(dialogRef, open, onCancel);
  /** 打开前的焦点元素：关闭后还回去。 */
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    // 危险操作默认落在“取消”上：不能一个回车就把不可逆操作执行掉。
    cancelRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], select:not([disabled]), input:not([disabled]), [tabindex]'
      ) ?? []).filter(item => item.tabIndex >= 0 && !item.hidden && !item.matches(':disabled'));
      if (!items.length) return;
      event.preventDefault();
      const index = items.findIndex(item => item === document.activeElement);
      const next = index < 0 ? (event.shiftKey ? items.length - 1 : 0)
        : (index + (event.shiftKey ? -1 : 1) + items.length) % items.length;
      items[next].focus();
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      restoreRef.current?.focus?.();
    };
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="nb-dialog-layer">
      <button
        type="button"
        className="nb-dialog-scrim"
        aria-label="关闭弹窗"
        title="关闭弹窗"
        data-testid="nb-dialog-scrim"
        onClick={onCancel}
      />
      <div
        ref={dialogRef}
        className={
          tone === "permanent"
            ? "nb-dialog nb-dialog--permanent"
            : tone === "danger"
              ? "nb-dialog nb-dialog--danger"
              : "nb-dialog"
        }
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="nb-dialog-head">
          <strong id={titleId}>{title}</strong>
          <button
            type="button"
            className="nb-icon-button"
            aria-label="关闭"
            title="关闭"
            onClick={onCancel}
          >
            <X size={16} />
          </button>
        </header>
        {children ? <div className="nb-dialog-body">{children}</div> : null}
        <div className="nb-dialog-actions">
          <button
            ref={cancelRef}
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={tone === "normal" ? "primary-button" : "notebook-delete nb-dialog-confirm"}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
