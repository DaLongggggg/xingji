"use client";

import { useDismissableLayer } from "@/lib/dismissable-layer";

import { useEffect, useId, useRef, useState } from "react";
import { BookOpen, X } from "lucide-react";
import { fetchSkillContent, type SkillReadResult } from "@/features/ai/skill-knowledge";
import type { SkillReference } from "./workbench-types";

/** 引用仍是普通输入状态；点击预览只读取本机受控文本，发送才加载到 Agent。 */
export function WorkbenchSkillReferences({ value, onRemove }: {
  value: readonly SkillReference[];
  onRemove?: (id: string) => void;
}) {
  const [selected, setSelected] = useState<SkillReference>();
  const [content, setContent] = useState<SkillReadResult>();
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!selected) return;
    const element = dialog.current;
    if (element?.showModal && !element.open) element.showModal();
    else element?.setAttribute("open", "");
    let active = true;
    void fetchSkillContent({ id: selected.id })
      .then(result => { if (active) setContent(result.ok && result.nextOffset !== undefined
        ? { ok: false, code: "SKILL_UNREADABLE", detail: "技能文件未完整返回，请重新打开后再试。" }
        : result); });
    return () => { active = false; };
  }, [selected]);

  const close = () => {
    dialog.current?.close?.();
    dialog.current?.removeAttribute("open");
    setSelected(undefined);
    opener.current?.focus();
  };
  useDismissableLayer(dialog, Boolean(selected), close);
  if (!value.length && !selected) return null;
  return <>
    <div className="wb-skill-references" aria-label="技能引用">
      {value.map(ref => <span key={ref.id} className="wb-skill-reference" data-ref-chip="skill">
        <button type="button" aria-label={`查看技能：${ref.name}`} onClick={event => {
          opener.current = event.currentTarget;
          setContent(undefined);
          setSelected(ref);
        }}><BookOpen size={14} aria-hidden /><span>{ref.name}</span></button>
        {onRemove ? <button type="button" aria-label={`移除技能：${ref.name}`} title={`移除技能：${ref.name}`} onClick={() => onRemove(ref.id)}><X size={13} aria-hidden /></button> : null}
      </span>)}
    </div>
    <dialog ref={dialog} className="wb-skill-preview" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close(); }}>
      <header><h2 id={titleId}>{selected?.name}</h2><button type="button" aria-label="关闭技能预览" title="关闭技能预览" onClick={close}><X size={20} aria-hidden /></button></header>
      {!content ? <p role="status">正在读取技能…</p> : content.ok ? <>
        <p className="wb-muted">全文 {content.text.length} 字</p>
        <pre>{content.text}</pre>
      </> : <p role="alert">{content.detail}</p>}
    </dialog>
  </>;
}
