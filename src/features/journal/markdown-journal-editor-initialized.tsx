"use client";

import { useEffect, useMemo, useRef } from "react";
import { ImagePlus } from "lucide-react";
import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  CreateLink,
  DiffSourceToggleWrapper,
  diffSourcePlugin,
  headingsPlugin,
  imagePlugin,
  InsertImage,
  InsertTable,
  InsertThematicBreak,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  ListsToggle,
  markdownShortcutPlugin,
  MDXEditor,
  type MDXEditorMethods,
  quotePlugin,
  Separator,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  UndoRedo
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import type { MarkdownJournalEditorProps } from "./markdown-journal-editor";
import { NotebookImageDialog as ImageDialog } from "@/features/notebook/notebook-image-dialog";

function translateJournalEditor(
  key: string,
  fallback: string,
  interpolations: Record<string, unknown> = {}
): string {
  const labels: Record<string, string> = {
    "imageEditor.deleteImage": "删除图片",
    "toolbar.undo": "撤销 {{shortcut}}",
    "toolbar.redo": "重做 {{shortcut}}",
    "toolbar.bold": "加粗",
    "toolbar.removeBold": "取消加粗",
    "toolbar.italic": "斜体",
    "toolbar.removeItalic": "取消斜体",
    "toolbar.bulletedList": "项目列表",
    "toolbar.numberedList": "编号列表",
    "toolbar.checkList": "待办列表",
    "toolbar.link": "插入链接",
    "toolbar.image": "插入图片",
    "toolbar.thematicBreak": "分隔线",
    "toolbar.blockTypeSelect.placeholder": "样式",
    "toolbar.blockTypeSelect.selectBlockTypeTooltip": "选择正文样式",
    "toolbar.blockTypes.paragraph": "正文",
    "toolbar.blockTypes.quote": "引用",
    "toolbar.blockTypes.heading": "标题 {{level}}"
  };
  return Object.entries(interpolations).reduce(
    (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
    labels[key] ?? fallback
  );
}

export function MarkdownJournalEditorInitialized({
  markdown,
  onChange,
  onError,
  onUploadImage,
  onInsertImages,
  resolveImageSource,
  toolbar = "full"
}: MarkdownJournalEditorProps) {
  const editorRef = useRef<MDXEditorMethods>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const lastEditorValue = useRef(markdown);

  const plugins = useMemo(
    () => [
      headingsPlugin({ allowedHeadingLevels: [2, 3, 4] }),
      quotePlugin(),
      listsPlugin(),
      linkPlugin(),
      linkDialogPlugin(),
      thematicBreakPlugin(),
      tablePlugin(),
      imagePlugin({
        imageUploadHandler: onUploadImage,
        imagePreviewHandler: resolveImageSource,
        disableImageResize: false,
        disableImageSettingsButton: true,
        allowSetImageDimensions: true,
        // 024：用项目自己的图片弹窗（文件选择是明确的按钮，且选中即可保存）。
        ImageDialog: ImageDialog
      }),
      markdownShortcutPlugin(),
      diffSourcePlugin({ viewMode: "rich-text" }),
      toolbarPlugin({
        toolbarClassName: `journal-markdown-toolbar${toolbar === "compact" ? " journal-markdown-toolbar--compact" : ""}`,
        toolbarContents: () =>
          toolbar === "compact" ? (
            <>
              <div className="journal-toolbar-group" role="group" aria-label="文字格式">
                <BlockTypeSelect />
                <BoldItalicUnderlineToggles options={["Bold", "Italic"]} />
              </div>
              <div className="journal-toolbar-group" role="group" aria-label="列表与插入">
                <ListsToggle options={["bullet", "number", "check"]} />
                <CreateLink />
                {onInsertImages ? (
                  <button
                    type="button"
                    className="journal-batch-image-button"
                    aria-label="添加图片（可多选）"
                    title="添加图片（可多选）"
                    onClick={() => imageInputRef.current?.click()}
                  >
                    <ImagePlus size={17} aria-hidden="true" />
                  </button>
                ) : (
                  <InsertImage />
                )}
                <InsertThematicBreak />
              </div>
              <div className="journal-toolbar-group" role="group" aria-label="编辑历史">
                <UndoRedo />
              </div>
            </>
          ) : (
            <DiffSourceToggleWrapper options={["rich-text", "source"]}>
              <UndoRedo />
              <Separator />
              <BlockTypeSelect />
              <BoldItalicUnderlineToggles options={["Bold", "Italic"]} />
              <Separator />
              <ListsToggle options={["bullet", "number", "check"]} />
              <CreateLink />
              <InsertImage />
              <InsertTable />
              <InsertThematicBreak />
            </DiffSourceToggleWrapper>
          )
      })
    ],
    [onUploadImage, onInsertImages, resolveImageSource, toolbar]
  );

  // MDXEditor 只在首次挂载读取 markdown；清空或外部恢复时需要显式同步。
  useEffect(() => {
    if (markdown === lastEditorValue.current) return;
    editorRef.current?.setMarkdown(markdown);
    lastEditorValue.current = markdown;
  }, [markdown]);

  return (
    <>
      {onInsertImages ? (
        <input
          ref={imageInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          hidden
          tabIndex={-1}
          aria-label="选择笔记图片"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (files.length > 0) void onInsertImages(files);
          }}
        />
      ) : null}
      <MDXEditor
        ref={editorRef}
        className="journal-markdown-editor"
        contentEditableClassName="journal-markdown-content"
        translation={translateJournalEditor}
        markdown={markdown}
        plugins={plugins}
        placeholder="写下今天看到的风景、味道和心情，也可以把照片直接拖到这里……"
        suppressHtmlProcessing
        onChange={(nextMarkdown) => {
          lastEditorValue.current = nextMarkdown;
          onChange(nextMarkdown);
        }}
        onError={({ error }) => onError(error)}
      />
    </>
  );
}
