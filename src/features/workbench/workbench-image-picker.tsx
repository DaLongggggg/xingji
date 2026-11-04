"use client";

import { useDismissableLayer } from "@/lib/dismissable-layer";

import { useEffect, useRef, useState } from "react";
import { FolderOpen, X } from "lucide-react";
import { blobToBase64 } from "@/features/creation/creation-image-port";
import { describeScope, type MessageAttachment, type WorkbenchNotebook, type WorkbenchScope } from "./workbench-types";

type Props = {
  scope: WorkbenchScope;
  notebooks: WorkbenchNotebook[];
  onSelect: (images: MessageAttachment[]) => void;
  onSystemFiles: () => void;
  onClose: () => void;
  maxSelection?: number;
};

/**
 * 只展示当前范围的已加载本地图片；不读取远程图片，不修改媒体记录。
 *
 * 媒体 URL 兼容两种形态：objectURL（use-notebook-archive 的 Blob 引用）与遗留
 * dataURL——两者都可直接展示；**选中** objectURL 时回读原字节转成 dataURL
 * （会话附件的持久形态，字节不变），与「添加图片」的持久附件契约一致。
 */
export function WorkbenchImagePicker({ scope, notebooks, onSelect, onSystemFiles, onClose, maxSelection = 9 }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useDismissableLayer(dialogRef, true, onClose);
  const [selected, setSelected] = useState<string[]>([]);
  const [converting, setConverting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 操作有效性标记：关闭（X / Escape / 确认后父级收起）、卸载或范围切换（父级按
   * scope 重挂载）都置 false——迟到的 objectURL 回读不得再调用 onSelect 或碰状态，
   * 只能静默丢弃；失败路径保留在组件存活期间可重试。
   *
   * StrictMode（开发双调用）：setup 里**先重新置 true**——effect 重放的 cleanup
   * （含 showModal 效果 cleanup 触发的 dialog `close()`）会把标记置 false，
   * 不在 setup 复位就会从挂载起永久失效，选图永远无法交付。
   *
   * 原生 `close` 事件是**异步派发**的（规范排队任务）：StrictMode 重放的
   * close→重新 showModal 之后，旧 close 事件才到达——因此失效处理必须识别
   * dialog 的**当前**打开状态，只在实际关闭时置 false；对话框已重新打开时
   * 到达的旧事件是重放残留，忽略。交付前仍以标记复核有效性。
   */
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    const dialog = dialogRef.current;
    const markInactive = () => {
      if (!dialog?.open) activeRef.current = false;
    };
    dialog?.addEventListener("close", markInactive);
    return () => {
      dialog?.removeEventListener("close", markInactive);
      activeRef.current = false;
    };
  }, []);
  const notes = scope.kind === "free" ? [] : (notebooks.find(book => book.id === scope.notebookId)?.notes ?? [])
    .filter(note => scope.kind === "notebook" || note.id === scope.noteId);
  const seen = new Set<string>();
  const images = notes.flatMap(note => (note.images ?? []).flatMap(image => {
    if (seen.has(image.id)) return [];
    seen.add(image.id);
    return [{ ...image, noteTitle: note.title }];
  }));
  const isUsable = (url: string | undefined): url is string =>
    !!url && (/^data:image\/(png|jpeg|webp);base64,/.test(url) || url.startsWith("blob:"));
  const picked = images.filter((image): image is typeof image & { dataUrl: string } =>
    selected.includes(image.id) && isUsable(image.dataUrl));

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => { dialog?.close(); previous?.focus(); };
  }, []);

  async function addPicked() {
    if (converting || !picked.length) return;
    setConverting(true);
    setError(null);
    try {
      const attachments: MessageAttachment[] = [];
      for (const image of picked) {
        let dataUrl = image.dataUrl;
        if (dataUrl.startsWith("blob:")) {
          const blob = await fetch(dataUrl).then(response => {
            if (!response.ok) throw new Error(`「${image.name}」暂时无法读取，请重试。`);
            return response.blob();
          });
          if (!activeRef.current) return; // 关闭/卸载/范围切换后丢弃迟到结果
          dataUrl = `data:${blob.type || "image/png"};base64,${await blobToBase64(blob)}`;
        }
        attachments.push({ id: `note-image-${image.id}`, name: image.name, dataUrl });
      }
      if (!activeRef.current) return;
      onSelect(attachments);
    } catch (caught) {
      if (!activeRef.current) return;
      setError(caught instanceof Error ? caught.message : "图片暂时无法处理，请重试。");
      setConverting(false);
    }
  }

  return (
    <dialog ref={dialogRef} className="wb-image-dialog" aria-label="选择图片" onCancel={onClose}>
      <header className="wb-modal-head">
        <h3>选择图片</h3>
        <button type="button" className="wb-icon-button" aria-label="关闭图片选择" title="关闭" onClick={onClose}><X size={18} aria-hidden /></button>
      </header>
      <p className="wb-panel-hint">{describeScope(scope)}</p>
      <button type="button" className="secondary-button wb-system-files" disabled={maxSelection === 0 || converting} onClick={() => { dialogRef.current?.close(); onSystemFiles(); }}>
        <FolderOpen size={18} aria-hidden /> 从系统文件选择
      </button>
      {images.length ? <div className="wb-image-grid">
        {images.map(image => {
          const available = isUsable(image.dataUrl);
          return <label key={image.id} className="wb-image-choice" data-selected={selected.includes(image.id)}>
            <input type="checkbox" checked={selected.includes(image.id)} disabled={!available || converting || (!selected.includes(image.id) && selected.length >= maxSelection)} aria-label={`选择图片：${image.name}`}
              onChange={event => setSelected(current => event.target.checked ? [...current, image.id] : current.filter(id => id !== image.id))} />
            {available ? (
              // eslint-disable-next-line @next/next/no-img-element -- 本地媒体 URL（objectURL/dataURL），不访问外部图片。
              <img src={image.dataUrl} alt={image.name} />
            ) : <span className="wb-image-missing">图片暂不可用</span>}
            <span>{image.name}</span><small>{image.noteTitle}</small>
          </label>;
        })}
      </div> : <p className="wb-empty-note">当前范围没有图片，可以从系统文件选择。</p>}
      {error ? <p className="wb-panel-hint" role="alert">{error}</p> : null}
      <footer className="wb-image-footer">
        <span>{maxSelection === 0 ? "已达到图片上限，请先移除已选图片" : converting ? "正在读取所选图片…" : `已选 ${picked.length} 张，本次最多 ${maxSelection} 张`}</span>
        <button type="button" className="primary-button" disabled={!picked.length || converting} onClick={() => { void addPicked(); }}>添加图片</button>
      </footer>
    </dialog>
  );
}
