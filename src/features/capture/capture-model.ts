import { MAX_PHOTO_BATCH_SIZE } from "@/features/notebook/notebook-model";

export const CAPTURE_DB_NAME = "xingji-capture";
export const CAPTURE_DB_VERSION = 1;
export const CAPTURE_STORE = "messages";
export const MAX_CAPTURE_TEXT_LENGTH = 5_000;
/**
 * 记录入口与笔记本统一容量（一次最多 50 张、单张 50,000,000 字节）。
 * 记录箱与笔记本是两个库，但产品配额一致，避免同一文件在一处通过、在另一处被拒。
 */
export const MAX_CAPTURE_MEDIA = MAX_PHOTO_BATCH_SIZE;
export const MAX_CAPTURE_MEDIA_BYTES = 50_000_000;
export const MAX_LAYOUT_MESSAGES = 50;

export type CaptureMediaOrigin = { kind: "capture-upload" };

export type CaptureMedia = {
  id: string;
  name: string;
  type: string;
  size: number;
  createdAt: string;
  /** 二进制以 ArrayBuffer 存储，对外以 Blob 暴露（与 notebook 媒体同样的理由）。 */
  blob: Blob;
  origin: CaptureMediaOrigin;
};

/** 原始记录：用户输入的最低层事实，一旦写入不再被排版/归档改写。 */
export type CaptureMessage = {
  schemaVersion: 1;
  id: string;
  text: string;
  mediaIds: string[];
  /** 未归档草稿状态；归档只改状态，不改内容。 */
  status: "draft" | "saved";
  capturedAt: string;
  updatedAt: string;
};

export type CaptureArchive = {
  schemaVersion: 1;
  messages: CaptureMessage[];
};

export const EMPTY_CAPTURE_ARCHIVE: CaptureArchive = { schemaVersion: 1, messages: [] };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isDateLike(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40;
}

export function isBlobLike(value: unknown): value is Blob {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Blob>;
  return (
    typeof candidate.size === "number" &&
    Number.isFinite(candidate.size) &&
    typeof candidate.type === "string" &&
    typeof candidate.slice === "function"
  );
}

export function isCaptureMessage(value: unknown): value is CaptureMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CaptureMessage>;
  return (
    candidate.schemaVersion === 1 &&
    isNonEmptyString(candidate.id) &&
    typeof candidate.text === "string" &&
    candidate.text.length <= MAX_CAPTURE_TEXT_LENGTH &&
    Array.isArray(candidate.mediaIds) &&
    candidate.mediaIds.every((id) => isNonEmptyString(id)) &&
    candidate.mediaIds.length <= MAX_CAPTURE_MEDIA &&
    (candidate.status === "draft" || candidate.status === "saved") &&
    isDateLike(candidate.capturedAt) &&
    isDateLike(candidate.updatedAt)
  );
}

export function isCaptureMedia(value: unknown): value is CaptureMedia {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CaptureMedia>;
  return (
    isNonEmptyString(candidate.id) &&
    isNonEmptyString(candidate.name) &&
    isNonEmptyString(candidate.type) &&
    typeof candidate.size === "number" &&
    candidate.size >= 0 &&
    candidate.size <= MAX_CAPTURE_MEDIA_BYTES &&
    isDateLike(candidate.createdAt) &&
    isBlobLike(candidate.blob) &&
    Boolean(candidate.origin) &&
    (candidate.origin as CaptureMediaOrigin).kind === "capture-upload"
  );
}

/** 记录流按时间倒序（最新在前）。 */
export function listCaptureMessages(archive: CaptureArchive): CaptureMessage[] {
  return [...archive.messages].sort((left, right) =>
    right.capturedAt.localeCompare(left.capturedAt)
  );
}

let idCounter = 0;

export function createCaptureId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export function createCaptureMessage(
  archive: CaptureArchive,
  input: { text: string; mediaIds?: string[]; status?: "draft" | "saved" },
  now: () => Date = () => new Date()
): { archive: CaptureArchive; message: CaptureMessage } {
  const timestamp = now().toISOString();
  const message: CaptureMessage = {
    schemaVersion: 1,
    id: createCaptureId("cap"),
    text: input.text.slice(0, MAX_CAPTURE_TEXT_LENGTH),
    mediaIds: input.mediaIds ?? [],
    status: input.status ?? "draft",
    capturedAt: timestamp,
    updatedAt: timestamp
  };
  return { archive: { ...archive, messages: [...archive.messages, message] }, message };
}

/**
 * 归档只更新状态，不改写正文或媒体引用：原始记录始终是用户写下的内容。
 * 不删除记录，也不因为生成笔记而丢弃原始输入。
 */
export function markMessagesArchived(
  archive: CaptureArchive,
  messageIds: string[],
  now: () => Date = () => new Date()
): CaptureArchive {
  const ids = new Set(messageIds);
  return {
    ...archive,
    messages: archive.messages.map((message) =>
      ids.has(message.id)
        ? { ...message, status: "saved", updatedAt: now().toISOString() }
        : message
    )
  };
}

/**
 * 020-C：编辑一条**已有**记录的正文/图片引用。
 *
 * 契约：
 * - 原地更新，**保留 messageId**，绝不删除后重建；
 * - `expectedUpdatedAt` 是并发基线：与当前持久化值不一致时返回 `conflict`，
 *   调用方必须保留草稿、不得覆盖（读取最新状态后由用户决定）；
 * - 只改 `text` / `mediaIds` / `updatedAt`，`capturedAt` 与 `status`（是否已加入笔记）不变；
 * - 不触碰笔记本侧任何内容：来源快照在加入笔记时已冻结。
 */
export type CaptureUpdateResult =
  | { status: "updated"; archive: CaptureArchive; message: CaptureMessage }
  | { status: "not-found"; archive: CaptureArchive }
  | { status: "conflict"; archive: CaptureArchive; current: CaptureMessage }
  | { status: "invalid"; archive: CaptureArchive; reason: string };

export function updateCaptureMessage(
  archive: CaptureArchive,
  messageId: string,
  patch: { text: string; mediaIds: string[] },
  expectedUpdatedAt: string,
  now: () => Date = () => new Date()
): CaptureUpdateResult {
  const existing = archive.messages.find((message) => message.id === messageId);
  if (!existing) return { status: "not-found", archive };
  if (existing.updatedAt !== expectedUpdatedAt) {
    return { status: "conflict", archive, current: existing };
  }
  if (patch.text.length > MAX_CAPTURE_TEXT_LENGTH) {
    return { status: "invalid", archive, reason: "CAPTURE_TEXT_TOO_LONG" };
  }
  if (patch.mediaIds.length > MAX_CAPTURE_MEDIA) {
    return { status: "invalid", archive, reason: "CAPTURE_MEDIA_TOO_MANY" };
  }
  const message: CaptureMessage = {
    ...existing,
    text: patch.text,
    mediaIds: [...patch.mediaIds],
    updatedAt: now().toISOString()
  };
  return {
    status: "updated",
    archive: {
      ...archive,
      messages: archive.messages.map((item) => (item.id === messageId ? message : item))
    },
    message
  };
}

export function removeCaptureMessage(archive: CaptureArchive, messageId: string): CaptureArchive {
  return { ...archive, messages: archive.messages.filter((message) => message.id !== messageId) };
}
