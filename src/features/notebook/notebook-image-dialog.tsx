"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { closeImageDialog$, imageDialogState$, saveImage$, useCellValue, usePublisher } from "@mdxeditor/editor";
import { NotebookDialog } from "./notebook-dialog";

/** 文件由组件直接持有，插入仍走编辑器的 saveImage$；复用笔记本已有弹窗。 */
export function NotebookImageDialog() {
  const state = useCellValue(imageDialogState$);
  const saveImage = usePublisher(saveImage$);
  const closeImageDialog = usePublisher(closeImageDialog$);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [values, setValues] = useState({ src: "", altText: "", title: "" });

  useEffect(() => {
    if (state.type === "inactive") return;
    setPickedFile(null);
    if (fileRef.current) fileRef.current.value = "";
    const initial = state.type === "editing" ? state.initialValues : undefined;
    setValues({ src: initial?.src ?? "", altText: initial?.altText ?? "", title: initial?.title ?? "" });
  }, [state]);

  if (state.type === "inactive") return null;

  function saveSelection() {
    if (pickedFile) {
      // MDXEditor 接受真正的 FileList，并从中取 item(0)。
      const transfer = new DataTransfer();
      transfer.items.add(pickedFile);
      saveImage({ file: transfer.files, altText: values.altText, title: values.title });
    } else if (values.src) {
      saveImage(values);
    }
  }

  return createPortal(
    <NotebookDialog open title="插入图片" confirmLabel="插入" onConfirm={saveSelection} onCancel={closeImageDialog}>
      <form className="nb-image-dialog-fields" onSubmit={event => { event.preventDefault(); event.stopPropagation(); saveSelection(); }}>
        <div className="nb-image-dialog-field">
          <span>从本机选择图片</span>
          <div className="nb-image-dialog-pick">
            <button type="button" className="primary-button" onClick={() => fileRef.current?.click()}>
              选择图片文件
            </button>
            <span className="nb-image-dialog-filename">{pickedFile?.name ?? "未选择文件"}</span>
            <input ref={fileRef} type="file" accept="image/*" tabIndex={-1} className="nb-image-dialog-input" aria-label="选择图片文件"
              onChange={event => setPickedFile(event.target.files?.[0] ?? null)} />
          </div>
        </div>
        <div className="nb-image-dialog-field">
          <label htmlFor="nb-image-src">或者填写图片链接</label>
          <input id="nb-image-src" type="text" value={values.src}
            onChange={event => setValues(current => ({ ...current, src: event.target.value }))} />
        </div>
        <div className="nb-image-dialog-field">
          <label htmlFor="nb-image-alt">替代文字</label>
          <input id="nb-image-alt" type="text" value={values.altText}
            onChange={event => setValues(current => ({ ...current, altText: event.target.value }))} />
        </div>
      </form>
    </NotebookDialog>,
    document.body
  );
}

export default NotebookImageDialog;
