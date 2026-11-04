"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, Moon, Settings2, Sun } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import type { UiTheme } from "@/features/app/ui-theme";
import { CUSTOM_INSTRUCTIONS_LIMIT, isCustomInstructionsView, type CustomInstructionsView } from "@/features/ai/custom-instructions";
import { buildWorkbenchMessages, buildWorkbenchPlanMessages, buildWorkbenchStreamMessages, NATIVE_WORKBENCH_PLAN_SYSTEM } from "@/features/ai/prompts/workbench";

const ENDPOINT = "/api/ai/settings/instructions";
const BUILTIN_PROMPTS = [
  { label: "Agent 规划（Web）", text: () => String(buildWorkbenchPlanMessages("{}")[0].content) },
  { label: "最终回答", text: () => String(buildWorkbenchStreamMessages("{}")[0].content) },
  { label: "Agent 规划（App）", text: () => NATIVE_WORKBENCH_PLAN_SYSTEM },
  { label: "图片编辑理解", text: () => String(buildWorkbenchMessages('{"interactiveEdit":true}')[0].content) }
];

export function GeneralSettings({ theme, onThemeChange, children }: {
  theme: UiTheme; onThemeChange?: (theme: UiTheme) => void; children: ReactNode;
}) {
  const [view, setView] = useState<CustomInstructionsView>();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [prompt, setPrompt] = useState(0);
  const [reload, setReload] = useState(0);
  const entry = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await apiFetch(ENDPOINT, { signal: controller.signal });
        const value: unknown = await response.json();
        if (!response.ok || !isCustomInstructionsView(value)) throw new Error("自定义指令读取失败，请重新读取。");
        if (!controller.signal.aborted) { setView(value); setDraft(value.text); setError(""); }
      } catch {
        if (!controller.signal.aborted) setError("自定义指令读取失败，请重新读取。");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [reload]);
  const close = () => { setDraft(view?.text ?? ""); setEditing(false); setError(""); queueMicrotask(() => entry.current?.focus()); };
  const save = async () => {
    if (!view || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await apiFetch(ENDPOINT, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: view.revision, text: draft }) });
      const value: unknown = await response.json();
      if (!response.ok || !isCustomInstructionsView(value)) {
        setError(response.status === 409 ? "设置已在别处更新，请复制本次内容后重新读取。" : "保存失败，本次内容仍保留，请重试。");
        return;
      }
      setView(value); setDraft(value.text); setEditing(false); setNotice("已保存，将用于后续对话。");
      window.dispatchEvent(new Event("xingji-settings-changed"));
      queueMicrotask(() => entry.current?.focus());
    } catch { setError("保存失败，本次内容仍保留，请重试。"); }
    finally { setBusy(false); }
  };
  if (editing) return <section className="settings-block settings-instructions" aria-labelledby="instructions-heading">
    <div className="settings-subpage-head"><button type="button" className="secondary-button" aria-label="返回通用设置" onClick={close} disabled={busy}><ArrowLeft size={16} aria-hidden /></button><h2 id="instructions-heading">自定义指令</h2></div>
    <p className="settings-block-note">适用于当前账号的所有对话，可填写回答风格或背景信息。留空沿用内置指令；保存后用于后续对话，并发送给你选择的对话模型。</p>
    <label className="settings-field" htmlFor="custom-instructions"><span>通用提示词</span><textarea autoFocus id="custom-instructions" value={draft} onChange={event => setDraft(event.target.value)} maxLength={CUSTOM_INSTRUCTIONS_LIMIT} disabled={busy || loading} rows={8} placeholder="例如：请使用简洁的中文回答，先给结论。" aria-describedby="instructions-count" /></label>
    <div className="settings-instructions-tools"><span id="instructions-count">{draft.length} / {CUSTOM_INSTRUCTIONS_LIMIT}</span><button type="button" className="secondary-button" disabled={busy || !draft} onClick={() => setDraft("")}>清空内容</button></div>
    {error ? <p className="notebook-error" role="alert">{error}</p> : null}
    <details className="settings-builtin"><summary>查看内置指令（只读）</summary><label className="settings-field"><span>任务阶段</span><select value={prompt} onChange={event => setPrompt(Number(event.target.value))}>{BUILTIN_PROMPTS.map((item, index) => <option key={item.label} value={index}>{item.label}</option>)}</select></label><pre tabIndex={0}>{BUILTIN_PROMPTS[prompt].text()}</pre></details>
    <div className="settings-editor-actions"><div className="settings-editor-secondary"><button type="button" className="secondary-button" disabled={busy || loading} onClick={() => { setLoading(true); setReload(value => value + 1); }}>重新读取</button></div><div className="settings-editor-primary"><button type="button" className="secondary-button" disabled={busy} onClick={close}>取消</button><button type="button" className="primary-button" disabled={busy || loading || !view || draft === view.text} onClick={() => void save()}>{busy ? "保存中…" : "保存"}</button></div></div>
  </section>;
  return <div className="settings-general">
    <section className="settings-block" aria-labelledby="general-heading"><h2 id="general-heading"><Settings2 size={18} aria-hidden />通用</h2>
      <fieldset className="settings-theme-choice" disabled={!onThemeChange}><legend>界面主题</legend><div>{[{ id: "light" as const, label: "日间", icon: Sun }, { id: "dark" as const, label: "夜间", icon: Moon }].map(({ id, label, icon: Icon }) => <label key={id} data-selected={theme === id}><input type="radio" name="ui-theme" value={id} checked={theme === id} onChange={() => onThemeChange?.(id)} /><Icon size={16} aria-hidden /><span>{label}</span></label>)}</div></fieldset>
    </section>
    {children}
    <section className="settings-block"><button ref={entry} type="button" className="settings-general-entry" disabled={loading || !view} onClick={() => { setDraft(view?.text ?? ""); setNotice(""); setEditing(true); }}><span><strong>自定义指令</strong><small>为所有对话设置回答偏好和背景信息</small></span><span className="settings-general-entry-value">{loading ? "读取中…" : view?.text.trim() ? "已设置" : "未设置"}</span><ChevronRight size={16} aria-hidden /></button>
    {error ? <div className="settings-general-error"><p className="notebook-error" role="alert">{error}</p><button type="button" className="secondary-button" onClick={() => { setLoading(true); setReload(value => value + 1); }}>重新读取</button></div> : null}
    {notice ? <p role="status" className="settings-block-note">{notice}</p> : null}</section>
  </div>;
}
