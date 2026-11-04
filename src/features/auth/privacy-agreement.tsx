"use client";

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { X } from "lucide-react";
import { useDismissableLayer } from "@/lib/dismissable-layer";
import type { AiPrivacyPermissions } from "@/features/ai/privacy-client";
import { privacyIntroduction, PRIVACY_OPTIONAL_NOTICE, PRIVACY_WITHDRAW_NOTICE } from "@/features/ai/privacy-content";

export function PrivacyAgreement({ permissions, onConfirm, onClose, returnFocusRef, busy = false, error }: {
  permissions: AiPrivacyPermissions;
  onConfirm: (permissions: AiPrivacyPermissions) => void;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  busy?: boolean;
  error?: string;
}) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(permissions);
  useDismissableLayer(dialogRef, true, onClose);
  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = returnFocusRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      opener?.focus();
    };
  }, [returnFocusRef]);

  return <dialog ref={dialogRef} className="auth-privacy-dialog" aria-labelledby={`${id}-title`} aria-busy={busy}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="auth-privacy-header">
      <h2 id={`${id}-title`}>隐私协议</h2>
      <button type="button" className="auth-privacy-close" aria-label="关闭隐私协议" title="关闭隐私协议" disabled={busy} onClick={onClose} autoFocus><X size={20} aria-hidden /></button>
    </header>
    <div className="auth-privacy-content">
      {privacyIntroduction().map(paragraph => <p key={paragraph}>{paragraph}</p>)}
      <fieldset className="auth-privacy-permissions" disabled={busy}>
        <legend>选择允许使用的功能</legend>
        <label><input type="checkbox" checked={draft.ai} onChange={event => setDraft(current => ({ ...current, ai: event.target.checked }))} /><span><strong>允许使用 AI</strong><small>将本次任务中输入或选择的内容发送给所选模型。</small></span></label>
        <label><input type="checkbox" checked={draft.images} onChange={event => setDraft(current => ({ ...current, images: event.target.checked }))} /><span><strong>允许生成和修改图片</strong><small>还需开启 AI，并配置图片模型。</small></span></label>
      </fieldset>
      <p>{PRIVACY_OPTIONAL_NOTICE}</p>
      <p>{PRIVACY_WITHDRAW_NOTICE}</p>
    </div>
    <footer className="auth-privacy-footer">
      {error ? <p className="auth-error" role="alert">{error}</p> : null}
      <button type="button" className="auth-submit" title="确认隐私协议与当前功能选择" disabled={busy} onClick={() => onConfirm(draft)}>{busy ? "正在保存…" : "同意协议并确认选择"}</button>
    </footer>
  </dialog>;
}
