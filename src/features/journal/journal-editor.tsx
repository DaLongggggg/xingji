"use client";

import { useCallback, useRef, useState } from "react";
import { Camera, Check, Star } from "lucide-react";
import {
  JournalImageError,
  MAX_JOURNAL_PHOTO_BYTES,
  MAX_JOURNAL_PHOTOS,
  MAX_JOURNAL_TOTAL_PHOTO_BYTES,
  readJournalPhoto,
  validateJournalPhoto
} from "./journal-image";
import { MarkdownJournalEditor } from "./markdown-journal-editor";
import {
  createEmptyJournal,
  createJournalPhotoSource,
  JOURNAL_PHOTO_SOURCE_PREFIX,
  loadJournal,
  MAX_JOURNAL_MARKDOWN_LENGTH,
  removeJournal,
  saveJournal,
  type JournalRating,
  type JournalStorage,
  type SpotJournal
} from "./journal-storage";

type JournalEditorProps = {
  spotId: string;
  spotName: string;
  storage?: JournalStorage;
};

type SaveState = "idle" | "saved" | "error";

function hasContent(journal: SpotJournal): boolean {
  return Boolean(
    journal.visited ||
    journal.visitedAt ||
    journal.rating ||
    journal.contentMarkdown.trim() ||
    journal.photos.length ||
    journal.updatedAt
  );
}

function getImageErrorMessage(error: unknown): string {
  if (!(error instanceof JournalImageError)) return "图片读取失败，请换一张图片重试。";

  switch (error.code) {
    case "JOURNAL_PHOTO_COUNT_EXCEEDED":
      return `本地体验版最多保存 ${MAX_JOURNAL_PHOTOS} 张照片。`;
    case "JOURNAL_PHOTO_TYPE_UNSUPPORTED":
      return "只支持 JPEG、PNG 或 WebP 图片。";
    case "JOURNAL_PHOTO_TOO_LARGE":
      return "单张照片不能超过 1 MB。";
    case "JOURNAL_PHOTO_TOTAL_TOO_LARGE":
      return "一篇游记的照片合计不能超过 2 MB。";
    case "JOURNAL_PHOTO_READ_FAILED":
      return "图片读取失败，请换一张图片重试。";
  }
}

export function JournalEditor({ spotId, spotName, storage }: JournalEditorProps) {
  const activeStorage =
    storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
  const initialJournal = activeStorage
    ? loadJournal(spotId, activeStorage)
    : createEmptyJournal(spotId);
  const [journal, setJournal] = useState<SpotJournal>(initialJournal);
  const journalRef = useRef(initialJournal);
  const photoSequence = useRef(0);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [message, setMessage] = useState("");

  const replaceJournal = useCallback((nextJournal: SpotJournal) => {
    journalRef.current = nextJournal;
    setJournal(nextJournal);
  }, []);

  const updateJournal = useCallback(
    (patch: Partial<SpotJournal>) => {
      replaceJournal({ ...journalRef.current, ...patch });
      setSaveState("idle");
      setMessage("");
    },
    [replaceJournal]
  );

  function handleSave() {
    if (!activeStorage) {
      setSaveState("error");
      setMessage("当前浏览器不支持本地游记存储。");
      return;
    }
    if (journalRef.current.contentMarkdown.length > MAX_JOURNAL_MARKDOWN_LENGTH) {
      setSaveState("error");
      setMessage(`手账正文不能超过 ${MAX_JOURNAL_MARKDOWN_LENGTH} 个字符。`);
      return;
    }
    try {
      const saved = saveJournal(journalRef.current, activeStorage);
      replaceJournal(saved);
      setSaveState("saved");
      setMessage("已经保存在当前浏览器中");
    } catch {
      setSaveState("error");
      setMessage("保存失败，本地空间可能不足。请删除部分照片后重试。");
    }
  }

  function handleClear() {
    if (!window.confirm(`确定清空“${spotName}”的本地游记吗？此操作无法撤销。`)) return;
    if (!activeStorage) {
      setSaveState("error");
      setMessage("当前浏览器不支持本地游记存储。");
      return;
    }
    try {
      replaceJournal(removeJournal(spotId, activeStorage));
      setSaveState("saved");
      setMessage("这篇本地游记已清空");
    } catch {
      setSaveState("error");
      setMessage("清空失败，请检查浏览器存储权限后重试。");
    }
  }

  const handleImageUpload = useCallback(
    async (file: File): Promise<string> => {
      try {
        validateJournalPhoto(file, journalRef.current.photos);
        photoSequence.current += 1;
        const id = `${spotId}-${Date.now()}-${photoSequence.current}`;
        const photo = await readJournalPhoto(file, id);

        // 多张图片可能由粘贴同时触发，读取完成后再次检查最新总量。
        validateJournalPhoto(file, journalRef.current.photos);
        replaceJournal({
          ...journalRef.current,
          photos: [...journalRef.current.photos, photo]
        });
        setSaveState("idle");
        setMessage("");
        return createJournalPhotoSource(photo.id);
      } catch (error) {
        setSaveState("error");
        setMessage(getImageErrorMessage(error));
        throw error;
      }
    },
    [replaceJournal, spotId]
  );

  const resolveImageSource = useCallback(async (source: string): Promise<string> => {
    if (!source.startsWith(JOURNAL_PHOTO_SOURCE_PREFIX)) return source;
    const id = source.slice(JOURNAL_PHOTO_SOURCE_PREFIX.length);
    return journalRef.current.photos.find((photo) => photo.id === id)?.dataUrl ?? source;
  }, []);

  return (
    <section className="journal-panel" aria-labelledby="journal-heading">
      <div className="journal-heading-row">
        <div>
          <span className="eyebrow">
            <Camera size={15} /> Markdown 手账
          </span>
          <h3 id="journal-heading">我的游记</h3>
          <p>图文都写在一页里，只保存在当前浏览器。</p>
        </div>
        {journal.updatedAt ? (
          <time dateTime={journal.updatedAt}>
            更新于 {new Date(journal.updatedAt).toLocaleString("zh-CN")}
          </time>
        ) : null}
      </div>

      <label className="visited-toggle">
        <input
          type="checkbox"
          checked={journal.visited}
          onChange={(event) => updateJournal({ visited: event.currentTarget.checked })}
        />
        <span aria-hidden="true">{journal.visited ? <Check size={17} /> : null}</span>
        我去过 {spotName}
      </label>

      <label className="journal-field">
        <span>
          到访日期 <small>选填</small>
        </span>
        <input
          type="date"
          value={journal.visitedAt}
          onChange={(event) => updateJournal({ visitedAt: event.currentTarget.value })}
        />
      </label>

      <fieldset className="journal-rating">
        <legend>我的评分</legend>
        <div>
          {([1, 2, 3, 4, 5] as JournalRating[]).map((rating) => (
            <button
              key={rating}
              type="button"
              className={journal.rating && rating <= journal.rating ? "is-active" : ""}
              aria-label={`${rating} 分`}
              aria-pressed={journal.rating === rating}
              onClick={() => updateJournal({ rating })}
            >
              <Star size={24} fill="currentColor" />
            </button>
          ))}
          {journal.rating ? <strong>{journal.rating}.0</strong> : <small>还没有评分</small>}
        </div>
      </fieldset>

      <div className="journal-markdown-field">
        <div className="journal-markdown-heading">
          <span>手账正文</span>
          <small
            className={
              journal.contentMarkdown.length > MAX_JOURNAL_MARKDOWN_LENGTH ? "is-over" : ""
            }
          >
            {journal.contentMarkdown.length} / {MAX_JOURNAL_MARKDOWN_LENGTH}
          </small>
        </div>
        <MarkdownJournalEditor
          markdown={journal.contentMarkdown}
          onChange={(contentMarkdown) => updateJournal({ contentMarkdown })}
          onError={() => {
            setSaveState("error");
            setMessage("这段 Markdown 暂时无法解析，请切换到源码模式检查格式。");
          }}
          onUploadImage={handleImageUpload}
          resolveImageSource={resolveImageSource}
        />
        <small className="journal-markdown-help">
          支持标题、强调、列表、引用、链接、表格和图片。图片最多 {MAX_JOURNAL_PHOTOS} 张， 单张{" "}
          {MAX_JOURNAL_PHOTO_BYTES / 1024 / 1024} MB，合计
          {MAX_JOURNAL_TOTAL_PHOTO_BYTES / 1024 / 1024} MB。
        </small>
      </div>

      <div className="journal-actions">
        <button type="button" className="primary-button" onClick={handleSave}>
          保存游记
        </button>
        <button
          type="button"
          className="secondary-button journal-clear-button"
          onClick={handleClear}
          disabled={!hasContent(journal)}
        >
          清空
        </button>
      </div>

      {message ? (
        <p
          className={`journal-message is-${saveState}`}
          role={saveState === "error" ? "alert" : "status"}
        >
          {message}
        </p>
      ) : null}
    </section>
  );
}
