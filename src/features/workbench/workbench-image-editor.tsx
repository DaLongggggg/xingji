"use client";

import { useState, type ReactNode } from "react";
import { ArrowUp, Crop, Eraser, LoaderCircle, Maximize2, Palette, PenLine, RotateCw, ScanLine, Sparkles, Square } from "lucide-react";

import { LOCAL_IMAGE_EDIT, type ImageEditorDraft, type LocalImageEdit } from "./workbench-image-edit-contract";

type Props = {
  draft?: ImageEditorDraft;
  onDraft?: (draft: ImageEditorDraft) => void;
  onLocalEdit?: (operation: LocalImageEdit) => Promise<void>;
  onErase?: () => Promise<void>;
  eraseAvailable?: boolean;
  localBlocker?: string;
  localJob?: { label: string; cancel: () => void };
  value: string;
  onChange: (value: string) => void;
  blocker?: string;
  needsFile?: boolean;
  onPrepare: () => Promise<void>;
  onSubmit: () => Promise<void>;
  job?: { label: string; error?: string; queued?: boolean; running?: boolean; failed?: boolean; hasResult?: boolean };
  onCancel: () => void;
  onRetry: () => void;
  retryLabel?: string;
  onResult: () => void;
  actions?: ReactNode;
};

/** Only local input/read feedback lives here; execution state comes from the existing message/queue. */
export function WorkbenchImageEditor({ draft = {}, onDraft, onLocalEdit, onErase, eraseAvailable, localBlocker, localJob, value, onChange, blocker, needsFile, onPrepare, onSubmit, job, onCancel, onRetry, retryLabel = "重试", onResult, actions }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "操作未完成，请重试。"); }
    finally { setBusy(false); }
  };
  const resizing = draft.mode === "resize";
  const input = resizing ? draft.resizeText ?? "" : value;
  const submitDisabled = busy || !!localJob || !input.trim() || (resizing ? !onLocalEdit : !!blocker);
  const submit = async () => {
    if (submitDisabled) return;
    if (!resizing) return onSubmit();
    const dimensions = input.trim().match(/^(\d+)\s*[xX×*]\s*(\d+)$/);
    if (!dimensions) throw new Error("请输入宽×高，例如 1000×600（像素）。");
    const operation = LOCAL_IMAGE_EDIT.safeParse({ kind: "resize", width: Number(dimensions[1]), height: Number(dimensions[2]) });
    if (!operation.success) throw new Error("尺寸超出支持范围，请填写有效的正整数并缩小宽高后重试。");
    await onLocalEdit!(operation.data);
  };
  const preset = (instruction: string) => {
    onDraft?.({ ...draft, mode: undefined });
    setError("");
    onChange(instruction);
  };
  return <div className="wb-viewer-editor" aria-label="修改当前图片">
    {job ? <div className="wb-viewer-job" role="status"><span>{job.label}</span>
      {job.running || job.queued ? <button type="button" onClick={onCancel}><Square size={12} aria-hidden />{job.queued ? "移出队列" : "取消"}</button> : null}
      {job.failed ? <button type="button" onClick={onRetry}>{retryLabel}</button> : null}
      {job.hasResult ? <button type="button" onClick={onResult}>查看结果</button> : null}
      {job.error ? <span className="wb-viewer-editor-error">{job.error}</span> : null}
    </div> : null}
    {blocker && !resizing ? <p className="wb-viewer-editor-note">{blocker}</p> : null}
    {localJob ? <div className="wb-viewer-job" role="status"><span>{localJob.label}</span><button type="button" onClick={localJob.cancel}>取消本地处理</button></div> : null}
    {localBlocker ? <p className="wb-viewer-editor-note">{localBlocker}</p> : needsFile ? <div className="wb-viewer-source-read">
      <button type="button" disabled={busy} onClick={() => void run(onPrepare)}>{busy ? "正在读取…" : "读取源文件以编辑"}</button>
      <span>使用该图片的实际文件，不使用搜索缩略图。</span>
    </div> : <>
      {onLocalEdit && onDraft && draft.mode && !resizing ? <div className="wb-viewer-local-tools" aria-label="选区编辑参数">
          <p className="wb-viewer-editor-note">在图片上拖动框选，或输入原图像素坐标。选区期间暂停图片拖动，仍可用工具栏缩放。</p>
          <div className="wb-viewer-edit-fields">{(['left','top','right','bottom'] as const).map((field,index) => <label key={field}>{['左','上','右','下'][index]}<input type="number" min={0} aria-label={`选区${['左','上','右','下'][index]}`} value={draft.bounds?.[field] ?? ''}
            onChange={e => onDraft({ ...draft, bounds: { left: 0, top: 0, right: 0, bottom: 0, ...draft.bounds, [field]: Number(e.target.value) } })} /></label>)}</div>
          {draft.mode === 'annotate' ? <div className="wb-viewer-edit-fields">
            <label>标注<select aria-label="标注类型" value={draft.mark ?? 'rectangle'} onChange={e => onDraft({ ...draft, mark: e.target.value as ImageEditorDraft['mark'] })}><option value="rectangle">矩形</option><option value="arrow">箭头</option><option value="text">文字</option></select></label>
            {draft.mark === 'arrow' ? <label>箭头方向<select aria-label="箭头方向" value={draft.arrowDirection ?? 'down-right'} onChange={e => onDraft({ ...draft, arrowDirection: e.target.value as ImageEditorDraft['arrowDirection'] })}><option value="down-right">右下</option><option value="up-left">左上</option><option value="down-left">左下</option><option value="up-right">右上</option></select></label> : null}
            <label>颜色<input type="color" aria-label="标注颜色" value={draft.color ?? '#1476c5'} onChange={e => onDraft({ ...draft, color: e.target.value })} /></label>
            <label>字号<input type="number" aria-label="标注字号" value={draft.fontSize ?? 48} min={8} max={1024} onChange={e => onDraft({ ...draft, fontSize: Number(e.target.value) })} /></label>
            {(draft.mark ?? 'rectangle') === 'text' ? <input aria-label="标注文字" maxLength={500} value={draft.text ?? ''} onChange={e => onDraft({ ...draft, text: e.target.value })} /> : null}
          </div> : null}
          <button type="button" disabled={busy || !!localJob || !draft.bounds || draft.mode === 'erase' && (!eraseAvailable || !value.trim())}
            onClick={() => void run(() => draft.mode === 'erase' ? onErase!() : onLocalEdit(draft.mode === 'crop' ? { kind: 'crop', bounds: draft.bounds! }
              : { kind: 'annotate', mark: draft.mark ?? 'rectangle', bounds: draft.bounds!, color: draft.color ?? '#1476c5', fontSize: draft.fontSize ?? 48, ...(draft.mark === 'arrow' ? { arrowDirection: draft.arrowDirection ?? 'down-right' } : {}), ...(draft.text ? { text: draft.text } : {}) }))}>
            {draft.mode === 'crop' ? '保存裁剪版本' : draft.mode === 'erase' ? '擦除选区中的对象' : '保存标注版本'}
          </button>
          {draft.mode === 'erase' ? <p className="wb-viewer-editor-note">在下方描述要移除的对象。当前模型按矩形坐标编辑，无像素级遮罩；框外也可能变化。</p> : null}
      </div> : null}
      <div className="wb-viewer-tools" aria-label="图片快捷编辑" aria-description="左右滑动查看更多工具"
        onFocusCapture={event => { if (event.target instanceof HTMLButtonElement) event.target.scrollIntoView?.({ block: "nearest", inline: "nearest" }); }}>
        {onLocalEdit && onDraft ? <>
          {([['crop','裁剪',Crop],['resize','尺寸',Maximize2]] as const).map(([mode,label,Icon]) => <button key={mode} type="button" aria-pressed={draft.mode === mode}
            disabled={busy || !!localJob} onClick={() => { setError(""); onDraft({ ...draft, mode: draft.mode === mode ? undefined : mode }); }}><Icon size={16} aria-hidden />{label}</button>)}
          <button type="button" aria-label="顺时针旋转90°" title="顺时针旋转90°，本地保存新版本" disabled={busy || !!localJob} onClick={() => void run(() => onLocalEdit({ kind: 'rotate', quarterTurns: 1 }))}><RotateCw size={16} aria-hidden />旋转</button>
          {([['annotate','标注',PenLine],['erase','局部擦除',Eraser]] as const).map(([mode,label,Icon]) => <button key={mode} type="button" aria-pressed={draft.mode === mode}
            disabled={busy || !!localJob || mode === 'erase' && !eraseAvailable} onClick={() => { setError(""); onDraft({ ...draft, mode: draft.mode === mode ? undefined : mode }); }}><Icon size={16} aria-hidden />{label}</button>)}
          <button type="button" title="本地移除背景，首次下载约18MB运行资源，图片不上传" disabled={busy || !!localJob} onClick={() => void run(() => onLocalEdit({ kind: 'remove-background' }))}><ScanLine size={16} aria-hidden />移除背景</button>
        </> : null}
        <button type="button" title="填入调色指令，发送后由模型执行" disabled={busy || !!localJob || !!blocker} onClick={() => preset("自然调色，保持真实质感，保留原图构图和主体。") }><Palette size={16} aria-hidden />自然调色</button>
        <button type="button" title="填入调色指令，发送后由模型执行" disabled={busy || !!localJob || !!blocker} onClick={() => preset("去除灰雾，恢复通透层次，避免过度锐化和饱和，保留原图构图和主体。") }><Sparkles size={16} aria-hidden />去灰通透</button>
        {actions}
      </div>
      <form className="wb-viewer-edit-input" onSubmit={event => { event.preventDefault(); void run(submit); }}>
        <textarea aria-label={resizing ? "图片尺寸（像素）" : "图片修改要求"} placeholder={resizing ? "示例：300x500" : draft.mode === "erase" ? "示例：移除选区内的路人" : "示例：提亮画面"} value={input} rows={1}
          onChange={event => resizing ? onDraft?.({ ...draft, resizeText: event.target.value }) : onChange(event.target.value)} onKeyDown={event => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault(); void run(submit);
            }
          }} />
        <button type="submit" aria-label={resizing ? "应用尺寸（本地）" : "发送图片修改要求"} disabled={submitDisabled}>
          {busy ? <LoaderCircle size={18} aria-hidden /> : <ArrowUp size={18} aria-hidden />}
        </button>
      </form>
    </>}
    {(localBlocker || needsFile) && actions ? <div className="wb-viewer-tools" aria-label="图片笔记操作">{actions}</div> : null}
    {error ? <p className="wb-viewer-editor-error" role="alert">{error}</p> : null}
  </div>;
}
