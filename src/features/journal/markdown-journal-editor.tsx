"use client";

import dynamic from "next/dynamic";

export type MarkdownJournalEditorProps = {
  markdown: string;
  onChange: (markdown: string) => void;
  onError: (message: string) => void;
  onUploadImage: (file: File) => Promise<string>;
  /** 笔记正文可一次选择多张，交由笔记草稿统一校验和插入。 */
  onInsertImages?: (files: File[]) => void | Promise<void>;
  resolveImageSource: (source: string) => Promise<string>;
  /**
   * 021-B：`compact` 只保留格式、列表、链接、插图与撤销/重做，
   * 不显示源码/差异切换（源码模式在需要时另开，不占日常工具栏）。
   * 缺省仍是完整工具栏，旧调用行为不变。
   */
  toolbar?: "full" | "compact";
};

const InitializedMarkdownJournalEditor = dynamic(
  () =>
    import("./markdown-journal-editor-initialized").then(
      (module) => module.MarkdownJournalEditorInitialized
    ),
  {
    ssr: false,
    loading: () => (
      <div className="journal-editor-loading" role="status">
        正在准备手账编辑器……
      </div>
    )
  }
);

/** 把不支持 SSR 的编辑器内核隔离在客户端动态边界内。 */
export function MarkdownJournalEditor(props: MarkdownJournalEditorProps) {
  return <InitializedMarkdownJournalEditor {...props} />;
}
