"use client";

import { useRef, useState } from "react";
import { ArrowUp, Camera, Inbox, Trash2 } from "lucide-react";
import {
  readJournalPhoto,
  validateJournalPhoto,
  type JournalPhoto
} from "@/features/journal/journal-image";
import {
  createCaptureId,
  MAX_CAPTURE_MEDIA,
  MAX_CAPTURE_MEDIA_BYTES,
  MAX_CAPTURE_TEXT_LENGTH
} from "./capture-model";
import { PAGE_CAPACITY_LIMITS } from "@/features/notebook/notebook-capacity";

export type ComposerTargetOption = {
  pageId: string;
  notebookTitle: string;
  pageTitle: string;
  editable: boolean;
};

type CaptureComposerProps = {
  chat?: boolean;
  busy: boolean;
  onSubmit: (input: { text: string; photos: JournalPhoto[] }) => Promise<void>;
  /** 可选归属目标（可见独立篇）。缺省时只有“存入记录箱”。 */
  targets?: ComposerTargetOption[];
  target?: { kind: "inbox" } | { kind: "page"; pageId: string };
  onTargetChange?: (target: { kind: "inbox" } | { kind: "page"; pageId: string }) => void;
};

/** 目标显示文案：笔记本名与笔记标题同时给出，避免重名误选。 */
export function describeTarget(targets: ComposerTargetOption[], pageId: string): string {
  const found = targets.find((item) => item.pageId === pageId);
  return found ? `${found.notebookTitle} · ${found.pageTitle}` : "目标笔记已不可用";
}

/**
 * 紧凑记录输入（展示组件）。
 * 只负责输入与图片草稿；失败时清理由调用方返回的 Promise rejection 决定，
 * 这里保留用户已输入内容，不清空。
 */
export function CaptureComposer({
  chat = false,
  busy,
  onSubmit,
  targets = [],
  target = { kind: "inbox" },
  onTargetChange
}: CaptureComposerProps) {
  const targetValue = target.kind === "page" ? target.pageId : "";
  const [text, setText] = useState("");
  const [photos, setPhotos] = useState<JournalPhoto[]>([]);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const next = [...photos];
    // 统一上限：一次 50 张、单张 50 MB；批次总字节按整篇上限计算。
    const limits = {
      maxPhotos: MAX_CAPTURE_MEDIA,
      maxPhotoBytes: MAX_CAPTURE_MEDIA_BYTES,
      maxTotalBytes: PAGE_CAPACITY_LIMITS.totalBytes
    };
    try {
      for (const file of Array.from(files)) {
        validateJournalPhoto(file, next, limits);
        next.push(await readJournalPhoto(file, createCaptureId("cap-media")));
      }
      setPhotos(next);
      setError(undefined);
    } catch {
      setError(
        `图片未能添加。一次最多 ${MAX_CAPTURE_MEDIA} 张，单张不超过 ${Math.round(
          MAX_CAPTURE_MEDIA_BYTES / 1_000_000
        )} MB。`
      );
    }
    if (inputRef.current) inputRef.current.value = "";
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed && photos.length === 0) return;
    setError(undefined);
    try {
      await onSubmit({ text: trimmed, photos });
      setText("");
      setPhotos([]);
    } catch (submitError) {
      // 失败保留输入与选图，便于直接重试。
      setError(
        submitError instanceof Error
          ? `保存失败，输入已保留：${submitError.message}`
          : "保存失败，输入已保留，请重试。"
      );
    }
  }

  return (
    <section className="capture-composer" data-chat={chat} aria-labelledby="capture-heading">
      <h2 id="capture-heading">记下这一刻</h2>
      <form onSubmit={(event) => void handleSubmit(event)}>
        <label htmlFor="capture-text" className="visually-hidden">
          记录内容
        </label>
        <textarea
          id="capture-text"
          rows={3}
          maxLength={MAX_CAPTURE_TEXT_LENGTH}
          value={text}
          disabled={busy}
          onKeyDown={(event) => {
            if (
              chat &&
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              if (!busy) event.currentTarget.form?.requestSubmit();
            }
          }}
          onChange={(event) => setText(event.target.value)}
          placeholder={chat ? "分享旅途见闻，或添加照片…" : "今天去了哪里？发生了什么？"}
        />
        {photos.length > 0 ? (
          <ul className="capture-draft-photos">
            {photos.map((photo) => (
              <li key={photo.id}>
                {/* Data URL 本地预览，next/image 不适用。 */}
                <img src={photo.dataUrl} alt={photo.name} />
                <button
                  type="button"
                  className="capture-draft-remove"
                  aria-label={`移除待保存图片 ${photo.name}`}
                  onClick={() =>
                    setPhotos((current) => current.filter((item) => item.id !== photo.id))
                  }
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="capture-target">
          <label htmlFor="capture-target">存入</label>
          <select
            id="capture-target"
            value={targetValue}
            disabled={busy}
            onChange={(event) => {
              onTargetChange?.(
                event.target.value
                  ? { kind: "page", pageId: event.target.value }
                  : { kind: "inbox" }
              );
            }}
          >
            <option value="">记录箱（默认，先保存素材）</option>
            {targets.map((item) => (
              <option key={item.pageId} value={item.pageId} disabled={!item.editable}>
                {item.notebookTitle} · {item.pageTitle}
                {item.editable ? "" : "（关联查看页，需先复制）"}
              </option>
            ))}
          </select>
          <span className="capture-target-current">
            <Inbox size={14} aria-hidden="true" />
            {target.kind === "page"
              ? `本次存入：${describeTarget(targets, target.pageId)}`
              : "本次存入：记录箱"}
          </span>
        </div>
        <div className="capture-actions">
          <label className="capture-file">
            <Camera size={16} aria-hidden="true" />
            {/* chat 布局下只留图标，文字由 .capture-file-label 隐藏。 */}
            <span className="capture-file-label">图片</span>
            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              aria-label="添加图片"
              onChange={(event) => void handleFiles(event.target.files)}
            />
          </label>
          <button
            className="primary-button"
            type="submit"
            aria-label={chat ? "发送记录" : undefined}
            title={chat ? "发送记录" : undefined}
            disabled={busy || (!text.trim() && photos.length === 0)}
          >
            {chat ? <ArrowUp size={20} /> : "记下来"}
          </button>
        </div>
      </form>
      {error ? (
        <p className="capture-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
