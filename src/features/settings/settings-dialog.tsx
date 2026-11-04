"use client";

import { useDismissableLayer } from "@/lib/dismissable-layer";
import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
export function SettingsDialog({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useDismissableLayer(ref, open, onClose);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return <dialog ref={ref} className="settings-dialog" aria-labelledby="settings-dialog-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="settings-dialog-surface">
      <header className="settings-dialog-header"><h1 id="settings-dialog-title">设置</h1><button type="button" className="settings-close" aria-label="关闭设置" title="关闭设置" onClick={onClose} autoFocus><X size={22} aria-hidden /></button></header>
      {children}
    </div>
  </dialog>;
}
