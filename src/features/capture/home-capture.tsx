"use client";
import { useTimedNotice } from "@/lib/use-timed-notice";

import { useRef, useState, type ReactNode } from "react";
import { Check, LayoutTemplate, Plus, Trash2 } from "lucide-react";
import {
  readJournalPhoto,
  validateJournalPhoto,
  type JournalPhoto
} from "@/features/journal/journal-image";
import { baseLayoutMarkdown, buildBaseLayout, type BaseLayoutResult } from "./base-layout";
import { CaptureComposer, describeTarget } from "./capture-composer";
import { useNativeCaptureImage } from "./use-capture-archive";
import { CaptureOrganizePanel } from "./capture-organize-panel";
import { CaptureRecentList } from "./capture-recent-list";
import {
  MAX_CAPTURE_MEDIA,
  MAX_CAPTURE_MEDIA_BYTES,
  createCaptureId,
  type CaptureMedia,
  type CaptureMessage
} from "./capture-model";
import {
  listAppendTargets,
  type AppendDuplicatePolicy,
  type CaptureAssignmentOutcome,
  type CaptureRetryContext,
  type NotebookPageSummary
} from "./capture-assignment";
import type { JournalDraft, JournalDraftEntry } from "@/features/notebook/append-service";
import type { ArchiveCore } from "@/features/notebook/notebook-repository";
import { PAGE_CAPACITY_LIMITS } from "@/features/notebook/notebook-capacity";

/** 016：首页=全屏地图，记录页=输入/记录箱/勾选整理/目标归属。 */
export type CaptureView = "map" | "record";

export type HomeCaptureProps = {
  onAiSaved?: () => Promise<void>;
  aiExecutionAllowed?: boolean;
  messages: CaptureMessage[];
  mediaUrls: Record<string, string>;
  /** B4：单图按需读取出口（原生 metadataOnly 模式）；缺省走既有预读 mediaUrls。 */
  onLoadMediaView?: (mediaId: string) => Promise<string | null>;
  storageError?: string;
  onAddMessage: (input: {
    text: string;
    media?: CaptureMedia[];
  }) => Promise<{ id: string } | CaptureMessage | unknown>;
  onArchiveMessages: (messageIds: string[]) => Promise<void>;
  onDeleteMessage: (messageId: string) => Promise<void>;
  /**
   * 记录归属与追加：复用 014-A 追加服务与 revision 契约。
   * UI 只传命令与来源记录 ID，不在界面拼接 blocks 后覆盖档案。
   */
  onAssignCaptures: (input: {
    pageId: string;
    messageIds: string[];
    duplicatePolicy: AppendDuplicatePolicy;
    operationId: string;
    /** 用户确认后的正文草稿；保存结果必须与预览一致。 */
    draft?: JournalDraft;
    /** 重试时携带首次冻结的上下文（媒体映射与草稿）。 */
    retry?: CaptureRetryContext;
  }) => Promise<CaptureAssignmentOutcome>;
  onCreatePageFromCaptures: (input: {
    notebookId: string;
    title: string;
    messageIds: string[];
    duplicatePolicy: AppendDuplicatePolicy;
    operationId: string;
    draft?: JournalDraft;
    retry?: CaptureRetryContext;
  }) => Promise<CaptureAssignmentOutcome>;
  onCreateNotebook: (title: string) => Promise<{ id: string; title?: string }>;
  notebookArchive: ArchiveCore;
  /** 记录箱媒体，用于把记录里的图片复制成笔记本自有资产。 */
  captureMediaList?: CaptureMedia[];
  notebooks: { id: string; title: string }[];
  /** 记录流媒体，用于把记录里的图片复制成笔记媒体。 */
  /** F5：媒体视图（blob 可选）——metadataOnly 下为元数据条目。 */
  captureMedia: (Omit<CaptureMedia, "blob"> & { blob?: Blob })[];
  /**
   * 可选的行政区地图展示槽位（只读）。
   * 地图状态变化只影响这个槽位，不参与记录输入、选图或选择状态。
   */
  atlasSlot?: ReactNode;
  /**
   * 014-C：地图/城市列表打开的只读笔记详情渲染器。
   * 由首页渲染成面板，因此打开/关闭不会卸载记录输入、勾选或“存入”目标。
   */
  onOpenPageDetail?: () => ReactNode;
  /** 当前页面：地图页或记录页（缺省 map，保持老调用行为）。 */
  view?: CaptureView;
  /**
   * 020-C：记录页布局。
   * - classic：原“输入 + 完整记录流”单列（默认，保持既有行为）；
   * - notebook：桌面左侧搜索/新建/列表，右侧选中记录的正文与图片编辑。
   */
  recordLayout?: "classic" | "notebook" | "chat";
  /** 020-C：原地保存已有记录（保留 messageId，冲突不覆盖）。 */
  onUpdateMessage?: (input: {
    messageId: string;
    text: string;
    mediaIds: string[];
    expectedUpdatedAt: string;
    newMedia?: CaptureMedia[];
  }) => Promise<{
    status: "updated" | "not-found" | "conflict" | "invalid";
    current?: CaptureMessage;
  }>;
  /**
   * 切页入口。用**命名**入口而不是 `CaptureView` 字面值，避免与 `AppView` 里的
   * `"map"`（推荐地图页）撞名：地图页调 `open-record`，记录页调 `open-map`。
   */
  onNavigateView?: (target: "open-record" | "open-map") => void;
};

/**
 * 记录框提交的纯判定：默认只保存到记录箱；只有显式选择了**仍然有效**的目标篇
 * 才继续追加。目标失效时不偷偷改投其他篇，由调用方给出明确提示。
 */
export function resolveComposerAssignment(
  target: { kind: "inbox" } | { kind: "page"; pageId: string },
  targets: { pageId: string; editable: boolean }[]
): { kind: "inbox" } | { kind: "page"; pageId: string } | { kind: "invalid" } {
  if (target.kind === "inbox") return { kind: "inbox" };
  const found = targets.find((item) => item.pageId === target.pageId);
  if (!found || !found.editable) return { kind: "invalid" };
  return { kind: "page", pageId: found.pageId };
}

/**
 * 把“确认后的预览”变成草稿契约：`layoutText` 是用户在预览里看到的正文（可能已编辑），
 * 图片按预览顺序携带**来源媒体 ID**（资产身份由服务在准备媒体后解析）。
 * 保存结果因此与确认的预览一致，而原始记录保持不变。
 */
export function buildLayoutDraft(layout: BaseLayoutResult, layoutText: string): JournalDraft {
  const entries: JournalDraftEntry[] = [
    {
      kind: "message",
      messageId: layout.sourceMessageIds[0] ?? "layout",
      blocks: [{ type: "text", text: layoutText.trim() }]
    }
  ];
  for (const mediaId of layout.usedMediaIds) {
    entries.push({ kind: "photo", assetId: mediaId, caption: "" });
  }
  return { entries };
}

let operationCounter = 0;

/** 稳定可读的操作 ID：同一目标 + 时间基，便于失败重试与排查。 */
function createOperationId(prefix: string): string {
  operationCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${operationCounter.toString(36)}`;
}

/** 从新保存的记录里取出稳定 ID：接口变化时明确报错，不猜“最后一条”。 */
function readSavedMessageId(saved: unknown): string {
  if (
    saved &&
    typeof saved === "object" &&
    "id" in saved &&
    typeof (saved as { id?: unknown }).id === "string"
  ) {
    return (saved as { id: string }).id;
  }
  throw new Error("SAVED_MESSAGE_ID_MISSING:记录已保存但拿不到稳定 ID，未继续加入笔记。");
}

async function dataUrlToBlob(dataUrl: string, type: string): Promise<Blob | undefined> {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) return undefined;
  const header = dataUrl.slice(0, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  try {
    if (!header.includes(";base64")) return new Blob([decodeURIComponent(payload)], { type });
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type });
  } catch {
    return undefined;
  }
}

function formatTime(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

async function toCaptureMedia(items: JournalPhoto[]): Promise<CaptureMedia[]> {
  const result: CaptureMedia[] = [];
  for (const photo of items) {
    const blob = await dataUrlToBlob(photo.dataUrl, photo.type);
    if (!blob) throw new Error(`图片 ${photo.name} 无法转换为本地媒体，未保存。`);
    result.push({
      id: photo.id,
      name: photo.name,
      type: photo.type,
      size: photo.size,
      createdAt: new Date().toISOString(),
      blob,
      origin: { kind: "capture-upload" }
    });
  }
  return result;
}

/**
 * 记录首页编排层（016）：同一份状态承载两个页面——
 * - 地图页 `view="map"`：只有全屏地图，没有记录输入/记录流；
 * - 记录页 `view="record"`：只有输入、记录箱、勾选整理与目标归属，没有地图。
 *
 * 两个页面**同时挂载**，非当前页用 `hidden` + `inert` 收起（不可聚焦、不可点），
 * 因此切页不会卸载 CaptureComposer 的正文/图片草稿、勾选或“存入”目标；
 * 也不使用 localStorage 保存 File/Blob。
 */
export function HomeCapture({
  onAiSaved,
  aiExecutionAllowed = true,
  messages,
  mediaUrls,
  onLoadMediaView,
  storageError,
  onAddMessage,
  onArchiveMessages,
  onDeleteMessage,
  onAssignCaptures,
  onCreatePageFromCaptures,
  onCreateNotebook,
  notebookArchive,
  captureMedia,
  notebooks,
  atlasSlot,
  onOpenPageDetail,
  view = "map",
  recordLayout = "classic",
  onUpdateMessage,
  onNavigateView
}: HomeCaptureProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useTimedNotice();
  const [selected, setSelected] = useState<string[]>([]);
  const [layout, setLayout] = useState<BaseLayoutResult>();
  const [layoutTitle, setLayoutTitle] = useState("");
  const [layoutText, setLayoutText] = useState("");
  const [targetNotebookId, setTargetNotebookId] = useState("");
  const [newNotebookTitle, setNewNotebookTitle] = useState("");
  /** 记录框的显式归属目标：默认记录箱，成功后保留，刷新回到记录箱。 */
  const [composerTarget, setComposerTarget] = useState<
    { kind: "inbox" } | { kind: "page"; pageId: string }
  >({ kind: "inbox" });
  /** 勾选整理的目标：新建或追加到已有篇。 */
  const [layoutTargetPageId, setLayoutTargetPageId] = useState("");
  /** 重复项的显式策略（用户选择后重试，不复用旧操作 ID）。 */
  const [duplicatePrompt, setDuplicatePrompt] = useState<{
    scope: "composer" | "layout";
    messageIds: string[];
    duplicateMessageIds: string[];
    retry?: CaptureRetryContext;
    outcome: CaptureAssignmentOutcome;
  }>();
  /** 已保存但尚未加入笔记：保留重试入口，不重新保存原始记录。 */
  const [pendingAppend, setPendingAppend] = useState<{
    outcome: CaptureAssignmentOutcome;
    messageIds: string[];
    scope: "composer" | "layout";
  }>();
  const streamRef = useRef<HTMLElement | null>(null);
  /**
   * 成功提示的归属：归档状态是次要步骤，它的完成/失败不能覆盖“已加入笔记”的提示，
   * 也不能把失败提示冲掉；因此由这里统一决定提示文案。
   */
  const noticeRef = useRef<string | undefined>(undefined);
  function showNotice(message: string | undefined) {
    noticeRef.current = message;
    setNotice(message);
  }
  const targets: NotebookPageSummary[] = listAppendTargets(notebookArchive);
  /** 还没归入笔记本的条数：status 仍是 draft。用于页头如实说明进度。 */
  const unprocessedCount = messages.filter((message) => message.status === "draft").length;

  function describeOutcomeFailure(outcome: CaptureAssignmentOutcome): string {
    const target =
      outcome.retry?.pageId !== undefined
        ? describeTarget(targets, outcome.retry.pageId)
        : outcome.retry?.title || "目标笔记本";
    return `记录已保存，尚未加入《${target}》：${outcome.detail ?? "追加未完成。"}`;
  }

  /** 按结果落到界面：成功/失败/需确认各自明确，不把部分成功显示成整体成功。 */
  function settleOutcome(
    outcome: CaptureAssignmentOutcome,
    messageIds: string[],
    scope: "composer" | "layout"
  ): void {
    if (outcome.status === "applied") {
      setPendingAppend(undefined);
      setDuplicatePrompt(undefined);
      const successNotice =
        outcome.blockIds.length > 0
          ? "已加入笔记末尾；原始记录仍保留在记录箱。"
          : (outcome.detail ?? "所选记录此前已加入，本次未重复写入。");
      showNotice(successNotice);
      // 归档状态是次要步骤：内容已经加入笔记，状态更新失败必须说明，
      // 并且不得因此再次追加（这里只改状态，不再调用追加服务）。
      // 状态更新**不会**覆盖已经显示的成功提示。
      void onArchiveMessages(messageIds).catch(() => {
        if (noticeRef.current === successNotice) showNotice("笔记本已保存，记录状态尚未更新。");
      });
      return;
    }
    if (outcome.status === "needs-confirmation") {
      setDuplicatePrompt({
        scope,
        messageIds,
        duplicateMessageIds: outcome.duplicateMessageIds ?? [],
        outcome
      });
      setError(undefined);
      return;
    }
    setPendingAppend({ outcome, messageIds, scope });
    setError(describeOutcomeFailure(outcome));
  }

  /**
   * 记录框发送：先保存原始记录；有明确目标时继续追加到该篇末尾。
   * 保存成功即冻结 messageId、来源快照与 operationId，重试复用同一身份。
   *
   * 注意：只有“保存记录”失败才向上抛（让输入框保留用户内容）；
   * 记录已保存之后的追加失败不再抛，避免输入框被误清空。
   */
  async function handleComposerSubmit(input: { text: string; photos: JournalPhoto[] }) {
    setBusy(true);
    setError(undefined);
    let saved: unknown;
    try {
      saved = await onAddMessage({
        text: input.text,
        media: await toCaptureMedia(input.photos)
      });
    } catch (saveError) {
      setBusy(false);
      // 交给 CaptureComposer 保留输入并显示失败：不吞掉这个错误。
      throw saveError;
    }

    let messageId: string;
    try {
      messageId = readSavedMessageId(saved);
    } catch (idError) {
      setBusy(false);
      setError(idError instanceof Error ? idError.message : "记录已保存但拿不到稳定 ID。");
      return;
    }

    const resolved = resolveComposerAssignment(composerTarget, targets);
    if (resolved.kind === "inbox") {
      showNotice("已保存到记录箱。");
      setBusy(false);
      return;
    }
    if (resolved.kind === "invalid") {
      setBusy(false);
      setError("目标笔记已不可用，记录只保存到记录箱；请重新选择目标后再加入笔记。");
      return;
    }
    try {
      const outcome = await onAssignCaptures({
        pageId: resolved.pageId,
        messageIds: [messageId],
        duplicatePolicy: "needs-confirmation",
        operationId: createOperationId("op-assign")
      });
      settleOutcome(outcome, [messageId], "composer");
    } catch (appendError) {
      setError(
        appendError instanceof Error
          ? `记录已保存，尚未加入笔记：${appendError.message}`
          : "记录已保存，尚未加入笔记。"
      );
    } finally {
      setBusy(false);
    }
  }

  /** 追加失败后的重试：沿用原 messageId 与 operationId，不再次保存原始记录。 */
  async function retryPendingAppend(policy: AppendDuplicatePolicy = "needs-confirmation") {
    if (!pendingAppend) return;
    const { outcome, messageIds } = pendingAppend;
    if (!outcome.retry) return;
    setBusy(true);
    setError(undefined);
    try {
      const next =
        outcome.retry.pageId !== undefined
          ? await onAssignCaptures({
              pageId: outcome.retry.pageId,
              messageIds,
              duplicatePolicy: policy,
              operationId:
                policy === "needs-confirmation"
                  ? outcome.retry.operationId
                  : createOperationId("op-retry")
            })
          : await onCreatePageFromCaptures({
              notebookId: outcome.retry.notebookId,
              title: outcome.retry.title,
              messageIds,
              duplicatePolicy: policy,
              operationId:
                policy === "needs-confirmation"
                  ? outcome.retry.operationId
                  : createOperationId("op-retry")
            });
      settleOutcome(next, messageIds, pendingAppend.scope);
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : "重试失败，记录仍在记录箱。");
    } finally {
      setBusy(false);
    }
  }

  /** 重复提醒的操作：跳过 / 仍然追加副本 / 取消。 */
  async function resolveDuplicate(policy: "skip" | "append-duplicate") {
    if (!duplicatePrompt) return;
    const { scope, messageIds } = duplicatePrompt;
    setBusy(true);
    setError(undefined);
    try {
      const operationId = createOperationId(`op-${policy}`);
      const draft = layout ? buildLayoutDraft(layout, layoutText) : undefined;
      const next =
        scope === "composer" && composerTarget.kind === "page"
          ? await onAssignCaptures({
              pageId: composerTarget.pageId,
              messageIds,
              duplicatePolicy: policy,
              operationId,
              draft
            })
          : layoutTargetPageId
            ? await onAssignCaptures({
                pageId: layoutTargetPageId,
                messageIds,
                duplicatePolicy: policy,
                operationId,
                draft
              })
            : await onCreatePageFromCaptures({
                notebookId: newNotebookId(),
                title: layoutTitle.trim() || layout?.title || "新的出行篇",
                messageIds,
                duplicatePolicy: policy,
                operationId,
                draft
              });
      settleOutcome(next, messageIds, scope);
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : "操作失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  function newNotebookId(): string {
    return targetNotebookId || notebooks[0]?.id || "";
  }

  function toggleSelected(messageId: string) {
    setSelected((current) =>
      current.includes(messageId)
        ? current.filter((id) => id !== messageId)
        : [...current, messageId]
    );
  }

  /** 基础排版：本地确定性模板，不调用模型。 */
  function handleLayout() {
    const chosen = messages.filter((message) => selected.includes(message.id));
    if (chosen.length === 0) return;
    const result = buildBaseLayout(chosen);
    setLayout(result);
    setLayoutTitle(result.title);
    setLayoutText(baseLayoutMarkdown(result));
    setError(undefined);
    setNotice(undefined);
  }

  /**
   * 保存基础排版草稿：先保存原始记录（若尚未保存），再按目标新建或追加。
   * 勾选多条已保存记录时不会重复保存；累计超过 10 张也整体提交（服务层不再按
   * 文件选择批次误挡），仍由整篇 100 图 / 500 MB 校验兜底。
   */
  async function handleSaveLayout() {
    if (!layout) return;
    setBusy(true);
    setError(undefined);
    try {
      const knownIds = new Set(messages.map((message) => message.id));
      const missing = layout.sourceMessageIds.filter((id) => !knownIds.has(id));
      if (missing.length > 0) {
        throw new Error(`有 ${missing.length} 条记录已不存在，未加入笔记。`);
      }
      const title = layoutTitle.trim() || layout.title;
      const operationId = createOperationId("op-layout");
      // 用户确认后的正文（可能已编辑）作为显式草稿传入服务；保存结果必须与预览一致。
      const draft = buildLayoutDraft(layout, layoutText);
      if (layoutTargetPageId) {
        const outcome = await onAssignCaptures({
          pageId: layoutTargetPageId,
          messageIds: layout.sourceMessageIds,
          duplicatePolicy: "needs-confirmation",
          operationId,
          draft
        });
        settleOutcome(outcome, layout.sourceMessageIds, "layout");
        if (outcome.status === "applied") {
          setLayout(undefined);
          setSelected([]);
        }
        return;
      }
      let notebookId = newNotebookId();
      if (!notebookId) {
        const created = await onCreateNotebook(newNotebookTitle.trim() || "我的笔记本");
        notebookId = created.id;
      }
      const outcome = await onCreatePageFromCaptures({
        notebookId,
        title,
        messageIds: layout.sourceMessageIds,
        duplicatePolicy: "needs-confirmation",
        operationId,
        draft
      });
      settleOutcome(outcome, layout.sourceMessageIds, "layout");
      if (outcome.status === "applied") {
        setLayout(undefined);
        setSelected([]);
      }
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? `保存笔记本失败，草稿已保留：${saveError.message}`
          : "保存笔记本失败，草稿已保留。"
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * 020-C：记录页笔记本模式的状态。
   * - 搜索只按本地正文匹配（标题取首行），无结果给明确空态，不改写数据；
   * - `selectedId` 是当前打开编辑的记录；`mode` 控制列表 / 选择整理两种工具栏；
   * - 已有记录的编辑草稿独立保存（正文 + 图片引用），显式保存、冲突保留草稿。
   */
  const [listQuery, setListQuery] = useState("");
  const [listMode, setListMode] = useState<"browse" | "select">("browse");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editorDraft, setEditorDraft] = useState<{
    messageId: string;
    text: string;
    /** 保留的已存媒体引用（顺序即展示顺序）。 */
    mediaIds: string[];
    /** 本次新加入、尚未落库的图片。 */
    addedPhotos: JournalPhoto[];
    /** 并发基线：打开编辑时冻结的 updatedAt。 */
    expectedUpdatedAt: string;
    /** 打开时记录的状态，保存不重置“已加入笔记”。 */
    status: "draft" | "saved";
  } | null>(null);
  const [editorNotice, setEditorNotice] = useState("");

  const filteredMessages = listQuery.trim()
    ? messages.filter((message) => {
        const keyword = listQuery.trim().toLowerCase();
        return (
          message.text.toLowerCase().includes(keyword) ||
          message.text.split("\n")[0]?.toLowerCase().includes(keyword)
        );
      })
    : messages;

  const selectedMessage = selectedId
    ? (messages.find((message) => message.id === selectedId) ?? null)
    : null;

  function openMessageEditor(message: CaptureMessage) {
    setSelectedId(message.id);
    setEditorDraft({
      messageId: message.id,
      text: message.text,
      mediaIds: [...message.mediaIds],
      addedPhotos: [],
      expectedUpdatedAt: message.updatedAt,
      status: message.status
    });
    setEditorNotice("");
    setError(undefined);
  }

  /**
   * 020-C：编辑器里新增图片。先做与记录箱相同的容量/类型校验，
   * 图片只进入本地草稿，点“保存修改”时才写入媒体库并提交消息。
   */
  async function handleEditorFiles(files: FileList | null) {
    if (!editorDraft || !files || files.length === 0) return;
    const current = editorDraft;
    const next = [...current.addedPhotos];
    try {
      const retainedBytes = captureMedia
        .filter((media) => current.mediaIds.includes(media.id))
        .reduce((total, media) => total + media.size, 0);
      const limits = {
        maxPhotos: MAX_CAPTURE_MEDIA - current.mediaIds.length,
        maxPhotoBytes: MAX_CAPTURE_MEDIA_BYTES,
        maxTotalBytes: Math.max(0, PAGE_CAPACITY_LIMITS.totalBytes - retainedBytes)
      };
      for (const file of Array.from(files)) {
        validateJournalPhoto(file, next, limits);
        next.push(await readJournalPhoto(file, createCaptureId("cap-media")));
      }
      setEditorDraft({ ...current, addedPhotos: next });
      setError(undefined);
    } catch (photoError) {
      setError(
        photoError instanceof Error
          ? `图片未能添加：${photoError.message}`
          : "图片未能添加，草稿保持不变。"
      );
    }
  }

  async function saveMessageEditor() {
    if (!editorDraft || !onUpdateMessage) return;
    setBusy(true);
    setError(undefined);
    try {
      const pending = await toCaptureMedia(editorDraft.addedPhotos);
      const result = await onUpdateMessage({
        messageId: editorDraft.messageId,
        text: editorDraft.text,
        mediaIds: [...editorDraft.mediaIds, ...pending.map((item) => item.id)],
        expectedUpdatedAt: editorDraft.expectedUpdatedAt,
        newMedia: pending
      });
      if (result.status === "updated") {
        setEditorNotice("已保存这条记录。");
        setEditorDraft(null);
        return;
      }
      if (result.status === "conflict") {
        // 冲突：保留草稿，提示重新打开以最新内容为基线，不覆盖他人修改。
        setError("这条记录在别处已被修改，未保存你的版本；草稿仍在这里，可复制后重新打开。");
        return;
      }
      setError("保存失败：记录可能已被删除，草稿已保留。");
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? `保存失败，草稿已保留：${saveError.message}`
          : "保存失败，草稿已保留。"
      );
    } finally {
      setBusy(false);
    }
  }

  const recordPage = (
    <div className={`capture-record${recordLayout === "chat" ? " capture-chat" : ""}`}>
      {/*
        020-A：去掉顶层大标题“记录”。页面名已在顶栏出现，
        这里只保留真实统计与返回地图入口，正文直接进入记录输入。
      */}
      <header className="capture-page-head">
        <p className="capture-page-stats">
          {recordLayout === "chat"
            ? "行迹 · 旅行聊天"
            : `${messages.length} 条记录 · ${notebooks.length} 本笔记本`}
        </p>
        {onNavigateView ? (
          <button
            type="button"
            className="secondary-button capture-back-map"
            onClick={() => onNavigateView("open-map")}
          >
            返回地图
          </button>
        ) : null}
      </header>

      {storageError ? (
        <p className="capture-error" role="alert">
          记录存储不可用：{storageError}
        </p>
      ) : null}
      {notice ? (
        <div className="global-notice" role="status">
          <span>{notice}</span>
          <button onClick={() => showNotice(undefined)} aria-label="关闭提示">
            <Check size={17} />
          </button>
        </div>
      ) : null}

      {recordLayout === "notebook" ? (
        <div className="capture-notebook">
          <aside className="capture-list" aria-label="记录列表">
            <div className="capture-list-tools">
              <input
                type="search"
                value={listQuery}
                onChange={(event) => setListQuery(event.target.value)}
                placeholder="搜索记录正文"
                aria-label="搜索记录正文"
              />
              <button
                type="button"
                className={
                  listMode === "select" ? "secondary-button is-active" : "secondary-button"
                }
                aria-pressed={listMode === "select"}
                onClick={() => setListMode(listMode === "select" ? "browse" : "select")}
              >
                选择模式
              </button>
              {/* 批量整理仍在工具栏：不因为布局简化删掉功能。 */}
              {listMode === "select" ? (
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy || selected.length < 1}
                  onClick={handleLayout}
                >
                  <LayoutTemplate size={15} /> 整理成笔记（{selected.length}）
                </button>
              ) : null}
            </div>
            {listQuery.trim() && filteredMessages.length === 0 ? (
              <p className="capture-list-empty">
                没有匹配「{listQuery.trim()}」的记录；搜索只匹配本机正文，不会改动数据。
              </p>
            ) : filteredMessages.length === 0 ? (
              <p className="capture-list-empty">还没有记录。在右侧写下第一条即可。</p>
            ) : (
              <ul className="capture-list-items">
                {filteredMessages.map((message) => (
                  <li key={message.id}>
                    <label className={message.id === selectedId ? "is-open" : ""}>
                      {listMode === "select" ? (
                        <input
                          type="checkbox"
                          checked={selected.includes(message.id)}
                          onChange={() => toggleSelected(message.id)}
                          aria-label={`选择记录 ${message.capturedAt.slice(0, 16).replace("T", " ")}`}
                        />
                      ) : null}
                      <button
                        type="button"
                        className="capture-list-item"
                        onClick={() => openMessageEditor(message)}
                        aria-current={message.id === selectedId ? "true" : undefined}
                      >
                        <strong>{message.text.split("\n")[0] || "（无正文）"}</strong>
                        <small>
                          {message.capturedAt.slice(0, 10)} ·{" "}
                          {message.mediaIds.length > 0
                            ? `${message.mediaIds.length} 张图片`
                            : "无图片"}
                          {message.status === "saved" ? " · 已加入笔记" : ""}
                        </small>
                      </button>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <div className="capture-editor">
            <button
              type="button"
              className="secondary-button capture-back-list"
              onClick={() => setSelectedId(null)}
            >
              返回列表
            </button>
            {editorDraft ? (
              <section className="capture-editor-pane" aria-label="编辑这条记录">
                <header>
                  <strong>编辑记录</strong>
                  <span className="capture-save-state" aria-live="polite">
                    {busy
                      ? "保存中…"
                      : editorDraft.text !== (selectedMessage?.text ?? "") ||
                          editorDraft.addedPhotos.length > 0 ||
                          JSON.stringify(editorDraft.mediaIds) !==
                            JSON.stringify(selectedMessage?.mediaIds ?? [])
                        ? "未保存"
                        : editorNotice || "已保存"}
                  </span>
                </header>
                {error ? <p className="capture-error" role="alert">{error}</p> : null}
                <label htmlFor="capture-edit-text">正文</label>
                <textarea
                  id="capture-edit-text"
                  rows={10}
                  value={editorDraft.text}
                  onChange={(event) => setEditorDraft({ ...editorDraft, text: event.target.value })}
                />
                <div className="capture-actions">
                  <label className="atlas-dev-file">
                    添加图片
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      multiple
                      onChange={(event) => void handleEditorFiles(event.target.files)}
                    />
                  </label>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy}
                    onClick={() => void saveMessageEditor()}
                  >
                    保存修改
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => {
                      // 放弃草稿：只丢未保存的编辑，不触碰已存记录。
                      setEditorDraft(null);
                      setEditorNotice("");
                    }}
                  >
                    放弃修改
                  </button>
                </div>
                {/* 已有图片：移除只影响本条记录的引用，媒体原件与其他页面不受影响。 */}
                <ul className="capture-edit-photos">
                  {editorDraft.mediaIds.map((mediaId) => (
                    <li key={mediaId}>
                      <NativeCapturePhoto mediaId={mediaId} mediaUrls={mediaUrls} load={onLoadMediaView} />
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() =>
                          setEditorDraft({
                            ...editorDraft,
                            mediaIds: editorDraft.mediaIds.filter((id) => id !== mediaId)
                          })
                        }
                      >
                        移除引用
                      </button>
                    </li>
                  ))}
                  {editorDraft.addedPhotos.map((photo) => (
                    <li key={photo.id}>
                      <img src={photo.dataUrl} alt={photo.name} />
                      <span>{photo.name} · 待保存</span>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() =>
                          setEditorDraft({
                            ...editorDraft,
                            addedPhotos: editorDraft.addedPhotos.filter(
                              (item) => item.id !== photo.id
                            )
                          })
                        }
                      >
                        移除
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="notebook-readonly">
                  仅修改这条原始记录；已经生成或追加的笔记保持当时的来源快照，不会自动改写。状态：
                  {editorDraft.status === "saved" ? "已加入笔记" : "未加入笔记"}
                </p>
              </section>
            ) : (
              <>
                <CaptureComposer
                  busy={busy}
                  onSubmit={handleComposerSubmit}
                  targets={targets.map((item) => ({
                    pageId: item.pageId,
                    notebookTitle: item.notebookTitle,
                    pageTitle: item.pageTitle,
                    editable: item.editable
                  }))}
                  target={composerTarget}
                  onTargetChange={setComposerTarget}
                />
                <CaptureRecentList
                  messages={messages}
                  mediaUrls={mediaUrls}
                  onViewAll={() => {
                    setListMode("select");
                    setNotice("已进入选择模式：勾选记录后可整理成笔记。");
                  }}
                />
              </>
            )}
          </div>
        </div>
      ) : null}

      {recordLayout !== "notebook" ? (
        <div className="capture-side">
          <CaptureComposer
            chat={recordLayout === "chat"}
            busy={busy}
            onSubmit={handleComposerSubmit}
            targets={targets.map((item) => ({
              pageId: item.pageId,
              notebookTitle: item.notebookTitle,
              pageTitle: item.pageTitle,
              editable: item.editable
            }))}
            target={composerTarget}
            onTargetChange={setComposerTarget}
          />
          {recordLayout !== "chat" && (
            <CaptureRecentList
              messages={messages}
              mediaUrls={mediaUrls}
              onViewAll={() =>
                streamRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
            />
          )}
          {recordLayout === "chat" && (
            <p className="capture-chat-disclaimer">
              发送内容仅保存到本机；勾选记录后可单独授权 AI 整理
            </p>
          )}
        </div>
      ) : null}

      {recordLayout !== "notebook" ? (
        <section className="capture-stream" aria-labelledby="stream-heading" ref={streamRef}>
          <div className="capture-stream-head">
            <div>
              <h2 id="stream-heading">{recordLayout === "chat" ? "旅行记录" : "全部记录"}</h2>
              <p>
                共 {messages.length} 条
                {unprocessedCount > 0
                  ? `；其中 ${unprocessedCount} 条还没归入笔记本`
                  : "；都已归入笔记本"}
                。勾选后可整理成笔记。
              </p>
            </div>
            <button
              className="secondary-button"
              disabled={busy || selected.length < 1}
              onClick={handleLayout}
            >
              <LayoutTemplate size={15} /> 整理成笔记（{selected.length}）
            </button>
          </div>
          {/*
            不再用 key={JSON.stringify(selected)} 重挂载：那会在勾选变化时卸载面板，
            从而静默 abort 正在进行的生成、丢掉已恢复的待处理建议。
            同意状态由面板自己在选中集合变化时重置（见 capture-organize-panel.tsx）。
          */}
          {aiExecutionAllowed ? <CaptureOrganizePanel selected={selected} active={view === "record"} archive={notebookArchive} onSaved={onAiSaved ?? (async () => {})} onArchive={onArchiveMessages} /> : <p role="status">手机任务服务尚未就绪，记录已保存在本机。</p>}
          {error ? (
            <p className="capture-error" role="alert">
              {error}
            </p>
          ) : null}
          {duplicatePrompt ? (
            <div className="capture-duplicate" role="alert">
              <strong>
                有 {duplicatePrompt.duplicateMessageIds.length} 条记录已在目标笔记本中。
              </strong>
              <p>默认不会重复写入。请选择如何处理：</p>
              <div className="capture-actions">
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void resolveDuplicate("skip")}
                >
                  跳过已加入记录
                </button>
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void resolveDuplicate("append-duplicate")}
                >
                  仍然追加副本
                </button>
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => setDuplicatePrompt(undefined)}
                >
                  取消
                </button>
              </div>
            </div>
          ) : null}
          {pendingAppend ? (
            <div className="capture-pending" role="alert">
              <strong>{describeOutcomeFailure(pendingAppend.outcome)}</strong>
              <p>原始记录已保存，重试不会再次保存同一条记录。</p>
              <div className="capture-actions">
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void retryPendingAppend()}
                >
                  重试加入笔记
                </button>
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => streamRef.current?.scrollIntoView({ behavior: "smooth" })}
                >
                  查看记录箱
                </button>
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => {
                    setPendingAppend(undefined);
                    setError(undefined);
                    showNotice("已取消本次追加；原始记录仍在记录箱。");
                  }}
                >
                  取消本次追加
                </button>
              </div>
            </div>
          ) : null}
          {messages.length === 0 ? (
            <div className="capture-empty">
              <h2>今天，想记下哪一段旅程？</h2>
              <p>聊聊沿途的故事，或分享一张照片。</p>
              {recordLayout === "chat" && (
                <p>
                  这里是你的旅行素材箱：先随手记下，之后再整理成笔记。归入笔记本需要先配置模型。
                </p>
              )}
              <button
                className="primary-button"
                onClick={() => document.getElementById("capture-text")?.focus()}
              >
                开始记一条
              </button>
            </div>
          ) : (
            <ul className="capture-list">
              {[...messages]
                .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
                .map((message) => (
                  <li key={message.id}>
                    <label className="capture-select">
                      <input
                        type="checkbox"
                        checked={selected.includes(message.id)}
                        onChange={() => toggleSelected(message.id)}
                        aria-label={`选择记录 ${formatTime(message.capturedAt)}`}
                      />
                      <time dateTime={message.capturedAt}>{formatTime(message.capturedAt)}</time>
                      <span className={`capture-status capture-status--${message.status}`}>
                        {message.status === "draft" ? "未归档草稿" : "已归档到笔记本"}
                      </span>
                    </label>
                    {message.text ? <p className="capture-text">{message.text}</p> : null}
                    {message.mediaIds.length > 0 ? (
                      <div className="capture-media">
                        {message.mediaIds.map((mediaId) => (
                          <NativeCapturePhoto key={mediaId} mediaId={mediaId} mediaUrls={mediaUrls} load={onLoadMediaView} />
                        ))}
                      </div>
                    ) : null}
                    <button
                      className="notebook-delete"
                      disabled={busy}
                      onClick={() => {
                        // 以前是 void onDeleteMessage(...)：写入失败时界面毫无反应，
                        // 用户会以为已删除。这里等待结果并把失败显示出来。
                        void (async () => {
                          try {
                            await onDeleteMessage(message.id);
                          } catch (deleteError) {
                            setError(
                              deleteError instanceof Error
                                ? `删除失败，记录仍在：${deleteError.message}`
                                : "删除失败，记录仍在。"
                            );
                          }
                        })();
                      }}
                      aria-label={`删除记录 ${formatTime(message.capturedAt)}`}
                    >
                      <Trash2 size={15} /> 删除记录
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </section>
      ) : null}

      {layout ? (
        <section className="capture-layout" aria-labelledby="layout-heading">
          <h2 id="layout-heading">基础排版预览</h2>
          <p className="capture-layout-note">
            由本地确定性模板生成，不是云端 AI 整理；你可以先改标题和正文再保存。
          </p>
          <label htmlFor="layout-title">标题</label>
          <input
            id="layout-title"
            type="text"
            value={layoutTitle}
            onChange={(event) => setLayoutTitle(event.target.value)}
          />
          <label htmlFor="layout-text">正文（Markdown，图片用 asset ID 引用）</label>
          <textarea
            id="layout-text"
            rows={8}
            value={layoutText}
            onChange={(event) => setLayoutText(event.target.value)}
          />
          <fieldset className="capture-layout-target">
            <legend>保存方式</legend>
            <div className="capture-target-modes">
              <label>
                <input
                  type="radio"
                  name="layout-mode"
                  value="new"
                  checked={layoutTargetPageId === ""}
                  onChange={() => setLayoutTargetPageId("")}
                />
                新建笔记
              </label>
              <label>
                <input
                  type="radio"
                  name="layout-mode"
                  value="append"
                  checked={layoutTargetPageId !== ""}
                  onChange={() => setLayoutTargetPageId(targets[0]?.pageId ?? "")}
                />
                追加到已有笔记本
              </label>
            </div>
            {layoutTargetPageId === "" ? (
              <div className="capture-target-new">
                <label htmlFor="layout-notebook">笔记本</label>
                <select
                  id="layout-notebook"
                  value={newNotebookId()}
                  onChange={(event) => setTargetNotebookId(event.target.value)}
                >
                  {notebooks.length === 0 ? <option value="">将创建新的一本</option> : null}
                  {notebooks.map((notebook) => (
                    <option key={notebook.id} value={notebook.id}>
                      {notebook.title}
                    </option>
                  ))}
                </select>
                {notebooks.length === 0 ? (
                  <label htmlFor="layout-new-notebook-title">
                    新本名称
                    <input
                      id="layout-new-notebook-title"
                      type="text"
                      value={newNotebookTitle}
                      placeholder="我的笔记本"
                      onChange={(event) => setNewNotebookTitle(event.target.value)}
                    />
                  </label>
                ) : null}
              </div>
            ) : (
              <div className="capture-target-existing">
                <label htmlFor="layout-target-page">追加到</label>
                <select
                  id="layout-target-page"
                  value={layoutTargetPageId}
                  onChange={(event) => setLayoutTargetPageId(event.target.value)}
                >
                  {targets.map((item) => (
                    <option key={item.pageId} value={item.pageId} disabled={!item.editable}>
                      {item.notebookTitle} · {item.pageTitle}
                      {item.editable ? "" : "（关联查看页，需先复制）"}
                    </option>
                  ))}
                </select>
                <p className="notebook-readonly">
                  已追加内容会放在该篇末尾，不改动已有标题与正文。
                </p>
              </div>
            )}
          </fieldset>
          <p className="notebook-readonly">
            参与排版的记录：{layout.sourceMessageIds.length} 条，图片 {layout.usedMediaIds.length}{" "}
            张。加入后原始记录仍保留在记录箱，可再次明确选择。
          </p>
          <div className="capture-actions">
            <button
              className="primary-button"
              disabled={busy || (layoutTargetPageId !== "" && targets.length === 0)}
              onClick={() => void handleSaveLayout()}
            >
              {layoutTargetPageId === "" ? (
                <>
                  <Plus size={15} /> 新建笔记并写入
                </>
              ) : (
                "追加到该篇末尾"
              )}
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => {
                setLayout(undefined);
                setDuplicatePrompt(undefined);
              }}
            >
              取消
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );

  /** 地图页：只有地图槽位；导航与地区入口都在槽位内的左右抽屉里（017）。 */
  const mapPage = <div className="capture-map">{atlasSlot}</div>;

  return (
    <div className="capture-page" data-view={view}>
      {/* 两页同时挂载：非当前页用 hidden + inert 收起，草稿/图片/勾选/目标都不丢。 */}
      <div className="capture-pane" hidden={view !== "record"} inert={view !== "record"}>
        {recordPage}
      </div>
      <div
        className="capture-pane capture-pane--map"
        hidden={view !== "map"}
        inert={view !== "map"}
      >
        {mapPage}
      </div>
      {/* Map-opened details must not inherit the inactive record pane's hidden/inert. */}
      {onOpenPageDetail ? <div className="capture-page-detail">{onOpenPageDetail()}</div> : null}
    </div>
  );
}


/** B4：单张记录图片按需读取（loading/missing/error 分态 + 显式重试；正文不被坏图阻断）。 */
function NativeCapturePhoto({ mediaId, mediaUrls, load }: { mediaId: string; mediaUrls: Record<string, string>; load?: (mediaId: string) => Promise<string | null> }) {
  const image = useNativeCaptureImage(mediaId, mediaUrls, load);
  if (image.state === "ready" && image.url) return <img src={image.url} alt={`记录图片 ${mediaId}`} />;
  if (image.state === "loading") return <span className="capture-missing-photo">图片 {mediaId} 读取中…</span>;
  return (
    <span className="capture-missing-photo">
      图片 {mediaId} 暂不可用
      {load && (image.state === "missing" || image.state === "error") && (
        <button type="button" className="secondary-button" onClick={image.retry}>重读</button>
      )}
    </span>
  );
}
