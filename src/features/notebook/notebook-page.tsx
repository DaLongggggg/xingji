"use client";
import { isSemanticSearchEnabled } from "@/features/ai/search-chunks";
import { useDismissableLayer } from "@/lib/dismissable-layer";
import { useTimedNotice } from "@/lib/use-timed-notice";
import { SemanticSearchPanel } from "./semantic-search-panel";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  BookOpen,
  CalendarDays,
  MapPin,
  Check,
  ChevronRight,
  Copy,
  ImagePlus,
  Import,
  Info,
  Link2,
  Loader2,
  MessageSquare,
  MoveRight,
  Pencil,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  X
} from "lucide-react";
import {
  JournalImageError,
  readJournalPhoto,
  validateJournalPhoto,
  type JournalPhoto
} from "@/features/journal/journal-image";
import type { LegacyInspection, LegacyJournalCandidate } from "./legacy-compat";
import {
  listActiveNotebookPages,
  listTrash,
  digestPageBlocks,
  pageEditBaseline,
  PageBaselineConflictError,
  type PageEditBaseline,
  type PurgeTarget,
  type TrashListing,
  findLegacyImport,
  findTripJournal,
  extractLegacyPhotoIds,
  listNotebookPages,
  listVisibleNotebooks,
  isPageDeleted,
  MAX_PHOTO_BLOCKS_PER_PAGE,
  type NotebookMedia,
  type NotebookPage,
  type NotebookPageBlock
} from "./notebook-model";
import { PageRegionsSelect } from "./page-regions-editor";
import { tripJournalMetaSignature } from "./page-regions-command";
import { NotebookDialog } from "./notebook-dialog";
import { PageOrganizePanel } from "./page-organize-preview";
import { NotebookAnalysisPanel } from "./notebook-analysis-panel";
import { useNotebookAnalysis } from "./use-notebook-analysis";
import { NotebookSearchPanel } from "./notebook-search-panel";
import { useNotebookSearch } from "./use-notebook-search";
import { useNativeNotebookImage } from "./use-notebook-archive";
import { LightAgentPanel, formatScopeSummary, type ScopeLabels } from "./light-agent-panel";
import { useLightAgent } from "./use-light-agent";
import { canonicalRegionId, findRegion } from "@/features/regions/region-catalog";
import { PagePhotoLocation } from "./page-photo-location";
import { PageRegionSources, type RegionSourceView } from "./page-region-sources";
import {
  effectiveTripDateRange,
  formatTripDateRange,
  parseTripDateInput
} from "@/features/regions/trip-date";
import type { TripDateRange } from "./notebook-model";
import {
  nextRegionSourceId,
  normalizeRegionSources,
  regionsToUnlinkAfterRemoval,
  type RegionAssociationSource
} from "@/features/regions/region-sources";
import type { CollectionScope } from "@/features/ai/ai-task";
import { projectTripSlice, readTripSlice } from "@/features/trips/trip-model";
import {
  runActionsFor,
  usePageOrganize,
  type PageOrganizeBaseline,
  type PageOrganizeSession
} from "./use-page-organize";
import type { AiRepository } from "@/features/ai/ai-repository";
import type { AiGatewayCaller } from "@/features/ai/ai-gateway-client";
import { getPageText } from "./notebook-query";
import { NotebookList, NotebookPageList } from "./notebook-workspace-parts";
import { MarkdownJournalEditor } from "@/features/journal/markdown-journal-editor";
import { NotebookImageDeck } from "./notebook-image-deck";
import { blocksToMarkdown, createAssetReference, markdownToBlocks, parseAssetReference, removeMarkdownImage } from "./notebook-markdown";
import {
  checkMarkdownDraft,
  collectKnownMediaIds,
  collectPreexistingMissingIds
} from "./notebook-edit-draft";
import type { ArchiveCore, NotebookRepository } from "./notebook-repository";
import {
  checkBatchSize,
  checkSingleAssetSize,
  formatBytes,
  formatCapacityCounters,
  formatCapacityViolation,
  measurePageCapacity,
  PAGE_CAPACITY_LIMITS
} from "./notebook-capacity";

export type NotebookStorageStatus = {
  ready: boolean;
  migration?: {
    status: string;
    notebooks: number;
    pages: number;
    media: number;
    sourcePreserved: boolean;
    issues: string[];
  };
  error?: string;
};

/**
 * 024-A复审：编辑草稿的命名类型。
 * 提取到组件外：`buildEditBlocks(draft: NotebookEditDraft)` 若写
 * `NonNullable<typeof editDraft>` 会因参数名遮蔽 state 变量形成自引用环（TS2502）。
 */
type NotebookEditDraft = {
  pageId: string;
  /**
   * 024-A：编辑会话身份。beginEdit 递增生成新会话；
   * 保存成功后的基线刷新沿用同一会话，迟到回调只允许合并回**同一会话**，
   * 防止旧保存覆盖后续输入或把内容回填到另一篇。
   */
  sessionId: number;
  title: string;
  text: string;
  /** 保留的已存媒体引用。 */
  existingMediaIds: string[];
  /** 本次新加入、尚未落库的图片。 */
  addedPhotos: JournalPhoto[];
  /** block=纯文本＋图片块（阶段 A 兼容）；markdown=复用 Markdown 编辑器适配层。 */
  mode: "block" | "markdown";
  /** Markdown 模式下的正文，图片以 asset ID 引用。 */
  markdown: string;
  /**
   * 021-B：进入编辑时冻结的原块与原始正文。
   * 用来判断“是否真的改了”，从而做到无修改保存不重建块、不改块身份。
   */
  baselineBlocks: NotebookPageBlock[];
  baselineMarkdown: string;
  /** 024-B：打开编辑时该页的块摘要（页级基线的一部分）。 */
  baselineBlocksDigest: string;
  /** 024-B：打开编辑时该页的 updatedAt（页级基线的一部分）。 */
  baselineUpdatedAt: string;
  /**
   * 024-A复审：本会话基线的标题——beginEdit 取打开时的页标题，
   * 成功提交后随实际提交页刷新。无变化判定只与它比较，
   * 不读渲染态 archive（旧闭包可能过期）。
   */
  baselineTitle: string;
  /** 编辑开始时就无法解析的引用：保留并警告，但不阻止保存文字修改。 */
  preexistingMissingIds: string[];
  /** 本页中手工输入/修正的媒体引用（asset ID）。 */
  manualMediaIds: string[];
  /**
   * 文字块草稿：每个文字块一份，按原顺序排列；draftId 只存在于编辑期，不写入持久化数据。
   * 不把多个文字块拼接成一个字段（那会改变文字与图片的位置关系）。
   */
  textDrafts: { draftId: string; text: string }[];
  /** 本页原有的外部/不支持图片块：原样保留，编辑不得丢弃。 */
  unsupportedBlocks: { id: string; markdown: string }[];
  /**
   * 原块顺序计划：保存时按原位重建，保证文字/图片/外部图片的相对顺序不变。
   * 新加入的图片与引用追加在末尾。
   */
  blockPlan: (
    | { kind: "text"; draftId: string }
    | { kind: "photo"; mediaId: string }
    | { kind: "unsupported"; id: string }
  )[];
};

export type NotebookPageProps = {
  /** 复用应用导航的断点，只控制手机展示层级。 */
  mobile?: boolean;
  archive: ArchiveCore;
  /** F5：媒体视图（blob 可选）。 */
  media: (Omit<NotebookMedia, "blob"> & { blob?: Blob })[];
  mediaUrls: Record<string, string>;
  /** B4：单图按需读取出口（原生 metadataOnly 模式）；缺省走既有预读 mediaUrls。 */
  onLoadMediaView?: (mediaId: string) => Promise<string | null>;
  /** 从地图笔记详情跳转：按一次 token 消费，打开目标篇后通知调用方清除。 */
  openPageRequest?: { pageId: string; token: number } | null;
  onOpenPageRequestConsumed?: () => void;
  storage: NotebookStorageStatus;
  onAddNotebook: (title: string) => Promise<{ id: string }>;
  onUpdateNotebookTitle: (notebookId: string, title: string) => Promise<void>;
  onInspectLegacy: () => LegacyInspection;
  onLinkLegacy: () => Promise<{ linkedCount: number; skippedAlreadyLinked: number }>;
  onCopyLegacy: (
    candidate: LegacyJournalCandidate,
    options?: { force?: boolean }
  ) => Promise<{
    status: "complete" | "partial" | "skipped" | "failed";
    issues: string[];
    copiedMediaCount: number;
  }>;
  /** 带当前笔记本范围进入 AI 工作台。 */
  onOpenNotebookInWorkbench?: (notebookId: string, notebookTitle: string) => void;
  /** 带当前笔记范围进入 AI 工作台。 */
  onOpenNoteInWorkbench?: (input: {
    notebookId: string;
    notebookTitle: string;
    noteId: string;
    noteTitle: string;
  }) => void;
  /** 返回**已创建的页面对象**：调用方需要直接进入该页编辑，不必再猜 id。 */
  onCreatePage: (input: {
    notebookId: string;
    title: string;
    blocks: NotebookPageBlock[];
    /** 与页面一起提交的媒体；写入失败则整次保存失败。 */
    media?: NotebookMedia[];
  }) => Promise<NotebookPage>;
  /**
   * 024-A：返回**实际已提交**的页面（含新的 updatedAt 与最终块），
   * 保存方用它刷新完整编辑基线；不能用旧 props 或自行生成的时间代替。
   */
  onUpdatePage: (
    pageId: string,
    changes: {
      title?: string;
      blocks?: NotebookPageBlock[];
      media?: NotebookMedia[];
      allowedMissingMediaIds?: string[];
      /** 024：页级编辑基线；不符时抛 PageBaselineConflictError（界面进入冲突态）。 */
      baseline?: PageEditBaseline;
    }
  ) => Promise<NotebookPage>;
  onMovePage: (pageId: string, targetNotebookId: string) => Promise<{ moved: boolean }>;
  /** 024：删除页 = 进垃圾桶（可恢复），不是物理删除。 */
  onDeletePage: (pageId: string) => Promise<void>;
  /** 024：删除整本（只标记本，子页状态不变）。 */
  onDeleteNotebook?: (notebookId: string) => Promise<void>;
  /** 024：从垃圾桶恢复本 / 页。 */
  onRestoreNotebook?: (notebookId: string) => Promise<void>;
  onRestorePage?: (pageId: string, targetNotebookId?: string) => Promise<void>;
  /** 024：永久删除（单项或清空）；目标由确认时冻结。 */
  onPurgeTrash?: (targets: PurgeTarget[]) => Promise<{
    status: "purged" | "conflict" | "skipped";
    reason?: string;
  }>;
  onTrashAutoCleanupChange?: (enabled: boolean) => Promise<void>;
  /**
   * 014-C 地区关联命令：只改该篇 meta.regions；返回 ok=false 时保留草稿。
   * 未提供时界面不显示地区编辑器。
   */
  onRegionsChange?: (
    pageId: string,
    regionIds: string[],
    /** 打开编辑时冻结的 revision；冲突时不自动改用最新值重试。 */
    expectedRevision?: number,
    /** M1.5/M2：来源记录与旅行日期随地区一并保存（可缺省）。 */
    options?: {
      add?: RegionAssociationSource[];
      removeIds?: string[];
      manualReaffirm?: boolean;
      tripDateRange?: import("./notebook-model").TripDateRange | null;
    }
  ) => Promise<{ ok: boolean; message?: string; revision?: number; metaSignature?: string }>;
  /**
   * 记忆地图 M1：从笔记显式定位到地图（切回首页并逐级下钻选中）。
   * 只读操作：不修改地区关联，不制造任何精确坐标。
   */
  onLocateRegionOnMap?: (regionId: string) => void;
  /**
   * 024-A：注册全局离页守卫。App 在离开笔记本页的导航前调用它等待最新草稿落库；
   * 返回 false 表示保存失败（留在当前编辑区）。卸载时以 null 注销。
   */
  onRegisterLeaveGuard?: (guard: (() => Promise<boolean>) | null) => void;
  /**
   * P2-01：AI 依赖由 App 注入（各创建一次，见 `xingji-app.tsx`）。
   * 笔记本自身不创建第二份 Repository；AI 不可用时入口不出现，零模型请求。
   */
  aiRepository: AiRepository;
  aiGatewayCaller: AiGatewayCaller;
  /** P2-03：Safe Commit 需要同一份 Notebook Repository 做业务事务与收据。 */
  notebookRepository: NotebookRepository;
  /** 安全提交后刷新 Notebook hook 的真实档案（复用既有 reload 合并逻辑）。 */
  onReloadArchive?: () => Promise<void>;
};

let mediaIdCounter = 0;

/** 稳定、可预测的本地媒体 ID；不使用随机值，便于测试与引用排查。 */
function createMediaId(): string {
  mediaIdCounter += 1;
  return `md-${Date.now().toString(36)}-${mediaIdCounter.toString(36)}`;
}

/** 把表单读出的 Data URL 还原为 Blob，用于写入独立媒体存储。 */
async function dataUrlToBlob(dataUrl: string, type: string): Promise<Blob | undefined> {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) return undefined;
  const header = dataUrl.slice(0, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  try {
    if (!header.includes(";base64")) {
      return new Blob([decodeURIComponent(payload)], { type });
    }
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type });
  } catch {
    return undefined;
  }
}


/** 笔记本图片草稿：整篇 100 张 / 单张 50 MB / 图片总量 500 MB。 */
const notebookPhotoLimits = {
  maxPhotos: MAX_PHOTO_BLOCKS_PER_PAGE,
  maxPhotoBytes: PAGE_CAPACITY_LIMITS.mediaBytes,
  maxTotalBytes: PAGE_CAPACITY_LIMITS.totalBytes
};

/** 图片失败原因：容量类走 014-A 文案，类型/读取失败仍按原提示。 */
function describePhotoError(error: unknown): string {
  if (error instanceof JournalImageError) {
    if (error.code === "JOURNAL_PHOTO_COUNT_EXCEEDED") {
      return `一篇最多 ${MAX_PHOTO_BLOCKS_PER_PAGE} 张图片，超出部分未加入。`;
    }
    if (error.code === "JOURNAL_PHOTO_TOO_LARGE") {
      return `单张图片不能超过 ${formatBytes(PAGE_CAPACITY_LIMITS.mediaBytes)}。`;
    }
    if (error.code === "JOURNAL_PHOTO_TYPE_UNSUPPORTED") {
      return "仅支持 JPEG/PNG/WebP 图片。";
    }
    return "图片读取失败，未加入。";
  }
  if (error instanceof Error && error.message) return error.message;
  return "图片未能添加。";
}

/**
 * 容量预检：批次 50 张、单张 50 MB、整篇 100 张。
 * 不再静默截断批次，超限整批拒绝。
 */
function checkPhotoBatch(files: File[], existingPhotoCount: number): void {
  const batchViolation = checkBatchSize(files.length, PAGE_CAPACITY_LIMITS);
  if (batchViolation) throw new Error(formatCapacityViolation(batchViolation));
  for (const file of files) {
    const violation = checkSingleAssetSize(
      { assetId: file.name, name: file.name, size: file.size },
      PAGE_CAPACITY_LIMITS
    );
    if (violation) throw new Error(formatCapacityViolation(violation));
  }
  const remaining = MAX_PHOTO_BLOCKS_PER_PAGE - existingPhotoCount;
  if (files.length > remaining) {
    throw new Error(
      `一篇最多 ${MAX_PHOTO_BLOCKS_PER_PAGE} 张图片，当前已有 ${existingPhotoCount} 张，本次 ${files.length} 张未加入。`
    );
  }
}

/** 页面来源标签：明确区分四种状态，避免把关联查看说成完整导入。 */
export function pageSourceLabel(page: NotebookPage): string {
  if (page.source.kind === "legacy-journal") return "旧版关联查看（未复制，依赖旧游记存储）";
  if (page.source.kind === "copied-legacy-journal") return "已独立复制（不再依赖旧游记）";
  return "本地保存";
}

/** 委托正式查询层（P0-02）：实现单一来源。 */
function pageText(page: NotebookPage): string {
  return getPageText(page);
}


/** P2：按精度回填日期输入值（year→"2026"；month→"2026-05"；day→"2026-05-15"）。 */
function tripDateBackfill(range: import("@/features/regions/trip-date").TripDateRange | null): {
  value: string;
  toValue: string;
} {
  if (!range) return { value: "", toValue: "" };
  const from =
    range.precision === "year"
      ? range.from.slice(0, 4)
      : range.precision === "month"
        ? range.from.slice(0, 7)
        : range.from;
  const to =
    range.precision === "day" && range.to
      ? range.to
      : "";
  return { value: from, toValue: to };
}

export function NotebookPageView({
  mobile = false,
  archive,
  media,
  mediaUrls,
  onLoadMediaView,
  openPageRequest,
  onOpenPageRequestConsumed,
  storage,
  onAddNotebook,
  onUpdateNotebookTitle,
  onInspectLegacy,
  onLinkLegacy,
  onCopyLegacy,
  onCreatePage,
  onOpenNotebookInWorkbench,
  onOpenNoteInWorkbench,
  onUpdatePage,
  onMovePage,
  onDeletePage,
  onDeleteNotebook,
  onRestoreNotebook,
  onRestorePage,
  onPurgeTrash,
  onTrashAutoCleanupChange,
  onRegionsChange,
  onRegisterLeaveGuard,
  onReloadArchive,
  aiRepository,
  aiGatewayCaller,
  notebookRepository
}: NotebookPageProps) {
  const notebooks = listVisibleNotebooks(archive);
  const [selectedNotebookId, setSelectedNotebookId] = useState("");
  const [notebooksCollapsed, setNotebooksCollapsed] = useState(false);
  const [directoryWidth, setDirectoryWidth] = useState(300);
  const directoryDrag = useRef({ x: 0, width: 300 });
  const resizeDirectory = (width: number) => setDirectoryWidth(Math.max(240, Math.min(400, width)));
  const [notice, setNotice] = useTimedNotice();
  const [error, setErrorNotice] = useState<{ message: string }>();
  // 每次报错都创建一条新提示，相同错误再次发生时也重新计时。
  const setError = (message?: string) => setErrorNotice(message ? { message } : undefined);
  useEffect(() => {
    if (!error) return;
    const closeTimer = setTimeout(() => setErrorNotice(undefined), 2000);
    return () => clearTimeout(closeTimer);
  }, [error]);
  const [busy, setBusy] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [draftPhotos, setDraftPhotos] = useState<JournalPhoto[]>([]);
  /** 编辑草稿独立于已保存页面：取消即丢弃，不触碰原页面。 */
  const [editWarnings, setEditWarnings] = useState<string[]>([]);
  const [moveTargets, setMoveTargets] = useState<Record<string, string>>({});
  const [editDraft, setEditDraft] = useState<NotebookEditDraft | undefined>(undefined);
  // 本轮调整：容量计量已移到 currentPage 之后（currentCapacity），随「篇信息」展示。
  /**
   * 编辑器上传是异步的：setState 之后紧跟的保存可能仍读到旧闭包。
   * 用 ref 保存最新草稿，上传与保存都走同一份最新值。
   */
  const editDraftRef = useRef<NotebookEditDraft | undefined>(undefined);
  /** 024-A：编辑会话序号；每次 beginEdit 递增，作为草稿的会话身份。 */
  const editSessionSeqRef = useRef(0);
  /**
   * 024-A复审：切换意图序号。保存期间（在途等待）的任何新选择——包括点回
   * 当前篇——都会递增它，使等待中的旧切换在完成后因序号不符而不再执行。
   */
  const switchSeqRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const activeNotebookId = selectedNotebookId || notebooks[0]?.id || "";
  /** 024：只列活动篇（本未删除且篇未删除）。 */
  const pages = activeNotebookId ? listActiveNotebookPages(archive, activeNotebookId) : [];
  /**
   * 024：垃圾桶（删除本 + 独立删除页）。
   * 依赖 `purgeVersion`：永久删除后强制重算，避免面板残留已清除的条目。
   * 注意 `purgeVersion` 必须在它之前声明（否则是 TDZ，会整页渲染失败）。
   */
  const [purgeVersion, setPurgeVersion] = useState(0);
  const trash = useMemo(() => listTrash(archive), [archive, purgeVersion]);
  const legacy = onInspectLegacy();
  const pendingLinkCount = legacy.journals.filter((entry) => !entry.linked).length;

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const next = [...draftPhotos];
    try {
      const batch = Array.from(files);
      checkPhotoBatch(batch, next.length);
      for (const file of batch) {
        validateJournalPhoto(file, next, notebookPhotoLimits);
        next.push(await readJournalPhoto(file, createMediaId()));
      }
      setDraftPhotos(next);
      setError(undefined);
    } catch (error) {
      setError(describePhotoError(error));
    }
    if (inputRef.current) inputRef.current.value = "";
  }

  /** 只从本次草稿移除，不影响已保存页面的媒体。 */
  function handleRemoveDraftPhoto(photoId: string) {
    setDraftPhotos((current) => current.filter((photo) => photo.id !== photoId));
  }

  /** 把表单/编辑草稿中的图片转成待落库的媒体记录（Blob 来自 Data URL 解码）。 */
  async function toMedia(photos: JournalPhoto[]): Promise<NotebookMedia[]> {
    const items: NotebookMedia[] = [];
    for (const photo of photos) {
      const blob = await dataUrlToBlob(photo.dataUrl, photo.type);
      if (!blob) {
        throw new Error(`图片 ${photo.name} 无法转换为本地媒体，未保存。`);
      }
      items.push({
        id: photo.id,
        name: photo.name,
        type: photo.type,
        size: photo.size,
        createdAt: new Date().toISOString(),
        blob,
        origin: { kind: "local-upload" }
      });
    }
    return items;
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draftText.trim();
    if (!text && draftPhotos.length === 0) return;
    const busyOwner = claimBusy();
    setError(undefined);
    try {
      let notebookId = activeNotebookId;
      if (!notebookId) {
        const created = await onAddNotebook("我的笔记本");
        notebookId = created.id;
        setSelectedNotebookId(notebookId);
      }
      const blocks: NotebookPageBlock[] = [];
      if (text) blocks.push({ id: `blk-${createMediaId()}`, type: "text", text });
      const draftMedia = await toMedia(draftPhotos);
      draftPhotos.forEach((photo, index) => {
        blocks.push({
          id: `blk-photo-${photo.id}`,
          type: "photo",
          mediaId: photo.id,
          caption: photo.name || `图片 ${index + 1}`
        });
      });
      await onCreatePage({
        notebookId,
        title: text.slice(0, 24) || `照片记录（${draftPhotos.length} 张）`,
        blocks,
        media: draftMedia
      });
      setDraftText("");
      setDraftPhotos([]);
      setNotice(
        draftMedia.length > 0
          ? `已保存到本机：正文与 ${draftMedia.length} 张图片已写入独立媒体存储。`
          : "已保存到本机笔记本（本地保存，未发送到云端）。"
      );
    } catch (submitError) {
      // 保存失败时保留草稿内容，方便用户重试或删除图片。
      setError(
        submitError instanceof Error
          ? `保存失败，编辑内容已保留：${submitError.message}`
          : "保存失败，未写入任何内容；编辑内容已保留。"
      );
    } finally {
      releaseBusy(busyOwner);
    }
  }

  function updateEditDraft(next: NonNullable<typeof editDraft> | undefined) {
    editDraftRef.current = next;
    setEditDraft(next);
  }

  /**
   * 020-B：当前编辑篇、未保存判定与保存状态文案。
   * `editDirty` 用“草稿与已存页面的规范快照”比较，避免只看某个字段漏判。
   */
  const editPageId = editDraft?.pageId ?? "";
  const editPage = editPageId
    ? (archive.pages.find((item) => item.id === editPageId) ?? null)
    : null;
  const editDirty = (() => {
    if (!editDraft || !editPage) return false;
    const base = {
      title: editPage.title,
      markdown: blocksToMarkdown(editPage.blocks),
      mode: "block" as const,
      mediaIds: editPage.blocks
        .filter(
          (block): block is Extract<NotebookPageBlock, { type: "photo" }> => block.type === "photo"
        )
        .map((block) => block.mediaId)
    };
    return (
      // 新建的空篇（没有任何块）在保存前都属于未保存状态。
      (editDraft.blockPlan.length === 0 && editDraft.addedPhotos.length === 0) ||
      editDraft.title !== base.title ||
      editDraft.markdown !== base.markdown ||
      editDraft.addedPhotos.length > 0 ||
      editDraft.manualMediaIds.length > 0 ||
      JSON.stringify([...editDraft.existingMediaIds].sort()) !==
        JSON.stringify([...base.mediaIds].sort()) ||
      editDraft.textDrafts.some((draft, index) => {
        const original = editPage.blocks.filter((block) => block.type === "text")[index];
        return !original || original.type !== "text" || original.text !== draft.text;
      })
    );
  })();
  /** 已保存提示：显式保存成功后才显示，切换/失败都会清掉。 */
  const [savedNotice, setSavedNotice] = useState("");

  /**
   * P2：首次使用前的外发告知与整理面板展开状态。
   * 告知只记在当前应用会话（组件状态），刷新后重新确认；不新建持久化系统。
   */
  const [organizePanelCollapsed, setOrganizePanelCollapsed] = useState(true);

  /**
   * P4：总结整本面板的展开状态与**独立**的外发告知。
   *
   * 单篇整理的外发同意只覆盖“这一篇”，不能自动扩大为“整本”；因此这里是
   * 第二次明确告知（同样只记在当前应用会话，刷新后重新确认）。
   */
  const [analysisPanelCollapsed, setAnalysisPanelCollapsed] = useState(false);

  /** P5：搜索笔记面板展开状态（检索本身是本地的，不需要外发同意）。 */
  const [searchPanelCollapsed, setSearchPanelCollapsed] = useState(false);

  /**
   * P8：检索区域内「整理检索结果」面板的展开状态。
   * 它的外发告知由 hook 的 pendingStart 驱动（所有首次执行/重试/重新运行共用同一处）。
   */
  const [agentPanelCollapsed, setAgentPanelCollapsed] = useState(true);


  /** 目录工具沿用右侧面板；整本分析由笔记本菜单打开居中弹窗。 */
  const [aiDisclosureAgreed, setAiDisclosureAgreed] = useState(false);
  const [aiDisclosureOpen, setAiDisclosureOpen] = useState(false);
  const [analysisDisclosureAgreed, setAnalysisDisclosureAgreed] = useState(false);
  const [analysisDisclosureOpen, setAnalysisDisclosureOpen] = useState(false);
  const [analysisModalOpen, setAnalysisModalOpen] = useState(false);
  const analysisModalRef = useRef<HTMLDivElement>(null);
  const analysisOpenerRef = useRef<HTMLElement | null>(null);
  const [workPanel, setWorkPanel] = useState<"search" | "regions" | null>(null);
  const workPanelRef = useRef<HTMLElement>(null);
  useDismissableLayer(analysisModalRef, analysisModalOpen, closeAnalysisModal);
  const [photoLocationActionSlot, setPhotoLocationActionSlot] = useState<HTMLSpanElement | null>(null);

  /**
   * 计划顺序中，位于“第 index 个文字块之后、下一个文字块之前”的外部图片块 id。
   * 用于在编辑界面按原位展示，顺序可见且内容不被改写。
   */
  function unsupportedAfterText(
    plan: { kind: "text" | "photo" | "unsupported"; id?: string }[],
    index: number
  ): string[] {
    const textSlotIndexes = plan
      .map((slot, slotIndex) => ({ slot, slotIndex }))
      .filter(({ slot }) => slot.kind === "text")
      .map(({ slotIndex }) => slotIndex);
    const from = textSlotIndexes[index];
    if (from === undefined) return [];
    const to = textSlotIndexes[index + 1] ?? plan.length;
    return plan
      .slice(from + 1, to)
      .filter((slot): slot is { kind: "unsupported"; id: string } => slot.kind === "unsupported")
      .map((slot) => slot.id);
  }

  function beginEdit(page: NotebookPage) {
    updateEditDraft({
      pageId: page.id,
      sessionId: ++editSessionSeqRef.current,
      title: page.title,
      text: pageText(page),
      existingMediaIds: page.blocks
        .filter(
          (block): block is Extract<NotebookPageBlock, { type: "photo" }> => block.type === "photo"
        )
        .map((block) => block.mediaId),
      addedPhotos: [],
      mode: "markdown",
      markdown: blocksToMarkdown(page.blocks),
      baselineBlocks: page.blocks.map((block) => ({ ...block })),
      baselineMarkdown: blocksToMarkdown(page.blocks),
      baselineBlocksDigest: digestPageBlocks(page),
      baselineUpdatedAt: page.updatedAt,
      baselineTitle: page.title,
      preexistingMissingIds: collectPreexistingMissingIds(
        blocksToMarkdown(page.blocks),
        media.map((item) => item.id)
      ),
      manualMediaIds: [],
      unsupportedBlocks: page.blocks
        .filter(
          (block): block is Extract<NotebookPageBlock, { type: "unsupported-image" }> =>
            block.type === "unsupported-image"
        )
        .map((block) => ({ id: block.id, markdown: block.markdown })),
      textDrafts: page.blocks
        .filter(
          (block): block is Extract<NotebookPageBlock, { type: "text" }> => block.type === "text"
        )
        .map((block, index) => ({ draftId: `draft-text-${index + 1}`, text: block.text })),
      blockPlan: page.blocks.map((block, index, all) => {
        if (block.type === "text") {
          // 用“第几个文字块”定位对应草稿，保证位置与内容一一对应。
          const textIndex = all.slice(0, index).filter((item) => item.type === "text").length;
          return { kind: "text" as const, draftId: `draft-text-${textIndex + 1}` };
        }
        if (block.type === "unsupported-image") {
          return { kind: "unsupported" as const, id: block.id };
        }
        return { kind: "photo" as const, mediaId: block.mediaId };
      })
    });
    setError(undefined);
    setNotice(undefined);
    setSavedNotice("");
    // 进入编辑即检查：只提示，不删除引用、不自动修复、不在读取时写回。
    const initialMarkdown = blocksToMarkdown(page.blocks);
    const missing = collectPreexistingMissingIds(
      initialMarkdown,
      media.map((item) => item.id)
    );
    setEditWarnings(
      missing.length > 0
        ? [
            `本页有 ${missing.length} 张图片引用在原存储中缺失：引用会被保留，你仍可修改文字；新增的无效引用不能保存。`
          ]
        : []
    );
  }

  /**
   * 取消编辑：只丢弃草稿，不触碰已保存页面。
   * 024-A：同时取消待执行的自动保存定时器；在途提交完成后的合并受会话守卫约束
   * （草稿已丢弃 → 合并直接跳过），旧保存不会把内容回填回来。
   */
  function cancelEdit() {
    cancelAutosave();
    updateEditDraft(undefined);
    setEditWarnings([]);
    setSavedNotice("");
    setError(undefined);
  }

  /**
   * 在途移动的篇 → 该篇**移动前**的 `updatedAt`。
   *
   * 移动会改 `updatedAt`，因此移动期间不接受用「当前 props 里的页对象」建会话
   * （那可能已经是移动后的权威版本，也可能还是旧的，取决于谁先到）。
   * 排队重开一律以这里的**原始等待基线**为准：命令完成与权威档案哪个先到都能完成该意图。
   */
  const movingPagesRef = useRef<Map<string, string>>(new Map());
  /**
   * 被移动挡下的重新打开意图：记下目标篇**移动前**的 `updatedAt`，
   * 等 archive 出现不同的值（移动已落库）后再打开，避免从移动前版本建立可写会话。
   */
  /** 每次移动结束（成功/失败/no-op）自增：用于在“档案先到、命令后到”时重查排队意图。 */
  const [moveEpoch, setMoveEpoch] = useState(0);
  const [pendingReopen, setPendingReopen] = useState<{
    pageId: string;
    updatedAtBefore: string;
    /** 建立该意图时的切换序号：新的选篇/选本/撤回会让它失效（最新选择优先）。 */
    switchSeq: number;
  }>();
  /**
   * 忙碌状态归属：移动/关联/复制等操作会 await。释放忙碌必须是**自己的**那次，
   * 否则迟到的 finally 会把后来操作（或另一个篇）的忙碌状态清掉。
   */
  const busyOwnerRef = useRef(0);
  /** 领取一次忙碌占用：返回的令牌用于“只释放自己那一次”。 */
  const claimBusy = () => {
    const owner = ++busyOwnerRef.current;
    setBusy(true);
    return owner;
  };
  const releaseBusy = (owner: number) => {
    if (busyOwnerRef.current === owner) setBusy(false);
  };
  /** 与 `pendingReopen` 同步的镜像：在 effect 中同步，避免渲染期间写 ref。 */
  const pendingReopenRef = useRef<
    { pageId: string; updatedAtBefore: string; switchSeq: number } | undefined
  >(undefined);
  useEffect(() => {
    pendingReopenRef.current = pendingReopen;
  }, [pendingReopen]);

  /**
   * 只结束**仍然属于该次打开**的编辑会话。
   *
   * 用于 await 之后：等待保存期间用户可能已经切到别的篇（甚至重开同一篇的新会话），
   * 那时 `cancelEdit()` 会关掉别人的输入框——`hadEditSession` 只是 await 之前的快照，
   * 不能授权清理 await 之后才建立的新会话。`editDraftRef` 同步更新，因此这里读到的是最新会话。
   */
  function cancelEditSession(
    pageId: string,
    sessionId: number | undefined
  ): boolean {
    const current = editDraftRef.current;
    /*
     * 三个条件缺一不可：会话 id 必须**等于**发起时那一次（不是“存在就算”），
     * 页也必须还是同一篇——否则会把移动等待期间用户新开的会话（同一篇的新 session
     * 或另一篇的 session）一起关掉。`sessionId` 冻结在 await 之前，因此这里看到的
     * 差异正说明“界面已经换人了”，本次移动无权清理。
     */
    if (
      sessionId === undefined ||
      !current ||
      current.sessionId !== sessionId ||
      current.pageId !== pageId
    ) {
      return false;
    }
    cancelEdit();
    return true;
  }

  /**
   * 编辑器内插图：写入现有媒体 Repository 并返回稳定资产引用。
   * 失败时抛出，编辑器不会插入引用；草稿与光标附近内容保持不变。
   */
  async function uploadEditorImage(file: File): Promise<string> {
    const draft = editDraftRef.current;
    if (!draft) throw new Error("没有处于编辑状态的页面。");
    // 024-A：冻结会话身份——读取文件的异步期间可能切篇/取消编辑，
    // 完成后的回填只允许落到同一会话，防止把图片归入另一篇。
    const sessionId = draft.sessionId;
    const currentCount = draft.existingMediaIds.length + draft.addedPhotos.length;
    if (currentCount + 1 > MAX_PHOTO_BLOCKS_PER_PAGE) {
      throw new Error(`一篇最多 ${MAX_PHOTO_BLOCKS_PER_PAGE} 张图片。`);
    }
    validateJournalPhoto(file, draft.addedPhotos, notebookPhotoLimits);
    const photo = await readJournalPhoto(file, createMediaId());
    const latest = editDraftRef.current;
    if (latest && latest.sessionId === sessionId) {
      updateEditDraft({ ...latest, addedPhotos: [...latest.addedPhotos, photo] });
    }
    return createAssetReference(photo.id);
  }

  /**
   * 正文工具栏的“插图”：直接开文件选择器（不用手输 asset ID）。
   * 走与编辑器内部上传完全相同的校验与资产回调，拿到 asset 引用后插到正文末尾。
   */
  async function insertImageFiles(batch: File[]) {
    if (batch.length === 0) return;
    const startingDraft = editDraftRef.current;
    if (!startingDraft) return;
    setError(undefined);
    try {
      checkPhotoBatch(batch, startingDraft.existingMediaIds.length + startingDraft.addedPhotos.length);
      const stagedPhotos: JournalPhoto[] = [];
      const stagedWithExisting = [...startingDraft.addedPhotos];
      for (const file of batch) {
        validateJournalPhoto(file, stagedWithExisting, notebookPhotoLimits);
        const photo = await readJournalPhoto(file, createMediaId());
        stagedPhotos.push(photo);
        stagedWithExisting.push(photo);
      }
      const current = editDraftRef.current;
      // 异步读取期间切篇或取消后，整批都不写入新篇。
      if (!current || current.sessionId !== startingDraft.sessionId) return;
      checkPhotoBatch(batch, current.existingMediaIds.length + current.addedPhotos.length);
      const nextPhotos = [...current.addedPhotos];
      for (const [index, file] of batch.entries()) {
        validateJournalPhoto(file, nextPhotos, notebookPhotoLimits);
        nextPhotos.push(stagedPhotos[index]);
      }
      const addition = stagedPhotos
        .map((photo, index) => `![图片 ${index + 1}](${createAssetReference(photo.id)})`)
        .join("\n\n");
      const markdown = current.markdown
        ? `${current.markdown}\n\n${addition}`
        : addition;
      updateEditDraft({ ...current, markdown, addedPhotos: nextPhotos });
      markDirty();
      setNotice(`已插入 ${stagedPhotos.length} 张图片；保存后写入本机笔记本媒体库。`);
    } catch (insertError) {
      setError(describePhotoError(insertError));
    }
  }

  /**
   * G3/H4/J4：原生模式下编辑器引用的原件按需读取（metadataOnly 启动不预读全库）。
   * H4 按请求身份管理在途结算：另一张图先结算、正文编辑等无关渲染**不取消**
   * 仍有效的请求（在途集合按 mediaId 跟踪，effect 重跑不重建也不中断）。
   * J4 页面生命周期成对管理：StrictMode 的 setup→cleanup→setup 重放不再让
   * mounted 标记永久为 false（旧实现只有 cleanup 写 false）——成对 setup 记
   * 新代数、cleanup 封存旧代数，取消的请求释放 attempt 记账使其可重新请求；
   * 迟到失败不再把状态写丢成永久 loading。图片结果（URL）按资源保存，状态条
   * 始终按当前页引用投影（切页收敛，旧页错误不回流到纯文字页）。
   */
  const [editorImageUrls, setEditorImageUrls] = useState<Record<string, string>>({});
  const [editorImageStates, setEditorImageStates] = useState<Record<string, "loading" | "missing" | "error">>({});
  const [editorImageRetry, setEditorImageRetry] = useState<Record<string, number>>({});
  const editorReadRef = useRef(new Set<string>());
  const editorRequestsRef = useRef(new Map<string, { cancelled: boolean }>());
  const editorLifecycleRef = useRef(0);
  /** J4：当前页引用镜像（ref）——迟到结算只允许写当前页引用的资源状态。 */
  const editorAssetIdsRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    editorLifecycleRef.current += 1;
    return () => {
      for (const request of editorRequestsRef.current.values()) request.cancelled = true;
    };
  }, []);
  const editorAssetIds = useMemo(
    () => (editDraft
      ? [...new Set(editDraft.blockPlan.filter(slot => slot.kind === "photo").map(slot => (slot as { kind: "photo"; mediaId: string }).mediaId))]
      : []),
    [editDraft]
  );
  useEffect(() => {
    editorAssetIdsRef.current = new Set(editorAssetIds);
  }, [editorAssetIds]);
  useEffect(() => {
    if (!onLoadMediaView) return;
    // H4/J4：状态条收敛到当前页引用——切页后旧页的 loading/错误不再显示
    // （纯文字页 assetIds 为空也会执行收敛）。
    setEditorImageStates(current => {
      const next: Record<string, "loading" | "missing" | "error"> = {};
      for (const id of editorAssetIds) if (current[id] !== undefined) next[id] = current[id];
      const nextKeys = Object.keys(next);
      const currentKeys = Object.keys(current);
      return nextKeys.length === currentKeys.length && nextKeys.every(key => current[key] === next[key]) ? current : next;
    });
    if (editorAssetIds.length === 0) return;
    const lifecycle = editorLifecycleRef.current;
    for (const id of editorAssetIds) {
      if (mediaUrls[id] || editorImageUrls[id] || editorRequestsRef.current.has(id)) continue;
      const attemptKey = `${id}#${editorImageRetry[id] ?? 0}`;
      if (editorReadRef.current.has(attemptKey)) continue;
      editorReadRef.current.add(attemptKey);
      const request = { cancelled: false };
      editorRequestsRef.current.set(id, request);
      setEditorImageStates(current => ({ ...current, [id]: "loading" }));
      onLoadMediaView(id).then(url => {
        editorRequestsRef.current.delete(id);
        if (request.cancelled || editorLifecycleRef.current !== lifecycle) {
          // J4：取消/旧生命周期的结算释放 attempt 记账——有效生命周期可重新请求。
          editorReadRef.current.delete(attemptKey);
          return;
        }
        if (url) {
          setEditorImageUrls(current => ({ ...current, [id]: url }));
          setEditorImageStates(current => { const next = { ...current }; delete next[id]; return next; });
        } else if (editorAssetIdsRef.current.has(id)) {
          setEditorImageStates(current => ({ ...current, [id]: "missing" }));
        } else {
          // J4：结果不属于当前页引用——释放 attempt 记账，回到该页时可重新请求。
          editorReadRef.current.delete(attemptKey);
        }
      }).catch(() => {
        editorRequestsRef.current.delete(id);
        if (request.cancelled || editorLifecycleRef.current !== lifecycle) {
          editorReadRef.current.delete(attemptKey);
          return;
        }
        // J4：迟到失败只写当前页引用的资源（按资源保存结果、状态按当前页投影）；
        // 不属于当前页的失败释放 attempt 记账——回到该页时可重新请求。
        if (editorAssetIdsRef.current.has(id)) {
          setEditorImageStates(current => ({ ...current, [id]: "error" }));
        } else {
          editorReadRef.current.delete(attemptKey);
        }
      });
    }
  }, [editorAssetIds, mediaUrls, editorImageUrls, onLoadMediaView, editorImageRetry]);
  const retryEditorImage = (id: string) => setEditorImageRetry(current => ({ ...current, [id]: (current[id] ?? 0) + 1 }));
  const editorMediaUrls = useMemo(() => ({ ...mediaUrls, ...editorImageUrls }), [mediaUrls, editorImageUrls]);

  /** 显示层解析：资产引用 -> 本地媒体地址；外部链接原样返回。 */
  async function resolveEditorImage(source: string): Promise<string> {
    const assetId = parseAssetReference(source);
    if (!assetId) return source;
    return editorMediaUrls[assetId] ?? source;
  }

  /** 解除本篇的一次图片引用，沿用草稿与自动保存链。 */
  function removeDraftImage(position: number) {
    const draft = editDraftRef.current;
    if (!draft) return;
    const markdown = removeMarkdownImage(draft.markdown, position);
    if (markdown === draft.markdown) return;
    const removed = markdownToBlocks(draft.markdown).filter((block) => block.type !== "text")[position];
    const removedPendingId = removed?.type === "photo" && !markdownToBlocks(markdown).some(
      (block) => block.type === "photo" && block.mediaId === removed.mediaId
    ) ? removed.mediaId : undefined;
    updateEditDraft({
      ...draft,
      markdown,
      // 只释放本次删掉且已无引用的待保存图片；不碰其他上传或已存原件。
      addedPhotos: draft.addedPhotos.filter((photo) => photo.id !== removedPendingId)
    });
    markDirty();
  }

  /**
   * 024-A：把**冻结的编辑快照**整理为最终块列表（不再中途读取 ref，
   * 异步过程中不会混入后续草稿）。Markdown 模式使用正文资产引用，
   * block 模式使用文字块与图片块。
   */
  async function buildEditBlocks(editDraft: NotebookEditDraft): Promise<{
    blocks: NotebookPageBlock[];
    media: NotebookMedia[];
  }> {
    const addedMedia = await toMedia(editDraft.addedPhotos);

    if (editDraft.mode === "markdown") {
      const check = checkMarkdownDraft(
        editDraft.markdown,
        collectKnownMediaIds(media, editDraft.addedPhotos),
        {
          preexistingMissingIds: editDraft.preexistingMissingIds,
          // 021-B：尽量沿用原块 id，避免改一个字就整篇换身份。
          originalBlocks: editDraft.baselineBlocks
        }
      );
      if (!check.ok) throw new Error(check.error);
      if (check.warnings.length > 0) setEditWarnings(check.warnings);
      return { blocks: check.blocks, media: addedMedia };
    }

    // 按原块顺序计划重建，保证相对位置不变；新增内容追加在末尾。
    const imageBlocks = new Map<string, NotebookPageBlock>();
    editDraft.existingMediaIds.forEach((mediaId, index) => {
      const stored = media.find((item: Omit<NotebookMedia, "blob"> & { blob?: Blob }) => item.id === mediaId);
      imageBlocks.set(mediaId, {
        id: `blk-photo-${mediaId}`,
        type: "photo",
        mediaId,
        caption: stored?.name ?? `图片 ${index + 1}`
      });
    });
    editDraft.addedPhotos.forEach((photo, index) => {
      imageBlocks.set(photo.id, {
        id: `blk-photo-${photo.id}`,
        type: "photo",
        mediaId: photo.id,
        caption: photo.name || `图片 ${index + 1}`
      });
    });
    editDraft.manualMediaIds.forEach((mediaId, index) => {
      imageBlocks.set(mediaId, {
        id: `blk-manual-${mediaId}`,
        type: "photo",
        mediaId,
        caption: media.find((item) => item.id === mediaId)?.name ?? `引用 ${index + 1}`
      });
    });
    const unsupportedBlocks = new Map(
      editDraft.unsupportedBlocks.map((block) => [block.id, block] as const)
    );

    const blocks: NotebookPageBlock[] = [];
    const textDraftById = new Map(
      editDraft.textDrafts.map((draft) => [draft.draftId, draft] as const)
    );
    const emittedText = new Set<string>();
    for (const slot of editDraft.blockPlan) {
      if (slot.kind === "text") {
        // 每个文字块独立写回原位置，不合并、不搬迁。
        const draft = textDraftById.get(slot.draftId);
        if (!draft) continue;
        emittedText.add(slot.draftId);
        blocks.push({
          id: `blk-text-${editDraft.pageId}-${slot.draftId}`,
          type: "text",
          text: draft.text.trim()
        });
        continue;
      }
      if (slot.kind === "unsupported") {
        const stored = unsupportedBlocks.get(slot.id);
        if (stored) {
          blocks.push({
            id: stored.id,
            type: "unsupported-image",
            markdown: stored.markdown
          });
        }
        continue;
      }
      // 已移除的图片引用不再写回（只解除引用，不删媒体）。
      const image = imageBlocks.get(slot.mediaId);
      if (image) {
        blocks.push(image);
        imageBlocks.delete(slot.mediaId);
      }
    }
    // 会话中新增的文字块与图片引用：追加到末尾。
    editDraft.textDrafts
      .filter((draft) => !emittedText.has(draft.draftId))
      .forEach((draft) =>
        blocks.push({
          id: `blk-text-${editDraft.pageId}-${draft.draftId}`,
          type: "text",
          text: draft.text.trim()
        })
      );
    imageBlocks.forEach((block) => blocks.push(block));
    return { blocks, media: addedMedia };
  }

  /**
   * 020-B：显式保存。返回是否成功，供“保存后离开”复用；
   * 失败时保留草稿、不改旧页面（与既有语义一致）。
   */
  /**
   * 024-A：把**实际已提交**的页写回编辑基线（更新完整基线：updatedAt、块摘要、块列表）。
   * 会话守卫：只有当前草稿仍是**同一次编辑会话**（未被取消、未切篇、未被新 beginEdit
   * 覆盖）才合并；合并保留用户在保存期间继续输入的内容字段，只刷新基线与媒体簿记，
   * 并把已提交的照片从待写入列表移除——迟到回调不会覆盖后续输入，也不会回填已取消的草稿。
   */
  function mergeCommittedBaseline(
    committed: NotebookPage,
    submitted: NotebookEditDraft
  ) {
    const latest = editDraftRef.current;
    if (
      !latest ||
      latest.sessionId !== submitted.sessionId ||
      latest.pageId !== submitted.pageId
    ) {
      return;
    }
    // 已存媒体引用以**实际提交页**的图片引用为准（移除的不在、新增的在内）。
    const committedPhotoIds = committed.blocks
      .filter(
        (block): block is Extract<NotebookPageBlock, { type: "photo" }> => block.type === "photo"
      )
      .map((block) => block.mediaId);
    const committedPhotoIdSet = new Set(committedPhotoIds);
    const submittedManualIds = new Set(submitted.manualMediaIds);
    updateEditDraft({
      ...latest,
      baselineBlocks: committed.blocks.map((block) => ({ ...block })),
      baselineMarkdown: blocksToMarkdown(committed.blocks),
      baselineBlocksDigest: digestPageBlocks(committed),
      baselineUpdatedAt: committed.updatedAt,
      baselineTitle: committed.title,
      // 已随本次提交落库的照片不再重复提交；保存期间新插图仍在列表里。
      addedPhotos: latest.addedPhotos.filter((photo) => !committedPhotoIdSet.has(photo.id)),
      existingMediaIds: committedPhotoIds,
      // 已提交的手工引用移出待提交集合，避免“无变化”场景被误判为需要重建。
      manualMediaIds: latest.manualMediaIds.filter((id) => !submittedManualIds.has(id)),
      // 迟到输入可能引入新的缺失引用；并集保留（不静默删引用）。
      preexistingMissingIds: Array.from(
        new Set([...submitted.preexistingMissingIds, ...latest.preexistingMissingIds])
      )
    });
  }

  /**
   * 024-A：所有保存入口的最终提交点（防抖、立即保存、表单提交、切篇/切本/离页都经
   * flushAutosave 协调到这里）。提交时冻结页身份、会话身份、序号、标题、正文、图片与
   * 基线；异步过程不混用后续草稿。成功用**实际已提交页**刷新完整基线。
   * 失败/冲突保留草稿并抛出（含 PageBaselineConflictError），由协调层区分状态。
   */
  async function handleSaveEdit(): Promise<boolean> {
    // 冻结快照：updateEditDraft 是整体替换，捕获后旧快照不受后续输入影响。
    const draft = editDraftRef.current;
    if (!draft) return true;
    const submitted = draft;
    /*
     * 忙碌必须**认领**：这次保存的完成只释放自己那一次。
     * 否则一个更早开始、更晚结束的操作（例如 A 的移动）会在结束时把 B 正在进行的保存的忙碌清掉，
     * 界面提前解禁（按钮可用）而保存仍未完成。
     */
    const busyOwner = claimBusy();
    setError(undefined);
    try {
      /**
       * 021-B 无损优先：正文与块都与进入编辑时一致、且没有新加/移除图片时，
       * 直接沿用原来的块（id、顺序、内容、资产引用一个都不动），只考虑标题。
       */
      const baselinePhotoIds = submitted.baselineBlocks
        .filter(
          (block): block is Extract<NotebookPageBlock, { type: "photo" }> => block.type === "photo"
        )
        .map((block) => block.mediaId);
      const untouched =
        submitted.markdown === submitted.baselineMarkdown &&
        submitted.addedPhotos.length === 0 &&
        submitted.manualMediaIds.length === 0 &&
        JSON.stringify([...submitted.existingMediaIds]) === JSON.stringify(baselinePhotoIds);
      if (untouched) {
        const nextTitle = submitted.title.trim() || "未命名笔记";
        /*
         * 024-A复审修复：无变化判定只与本编辑会话的基线标题比较——
         * 基线在 beginEdit 时取自打开时的页，成功提交后随实际提交页刷新。
         * 不读渲染态 archive（旧闭包可能是过期档案：A→提交B→保存期间改回A
         * 时会误判“无变化”跳过写入，数据库停留在B）。基线已是最近一次真实
         * 提交/打开时快照，这里跳过写入时不能再用旧 props 回退基线。
         */
        if (nextTitle === submitted.baselineTitle) {
          setSavedNotice("已保存");
          return true;
        }
        // 024-A：标题单独修改同样校验页级基线，不静默覆盖外部改动。
        const committed = await onUpdatePage(submitted.pageId, {
          title: nextTitle,
          baseline: {
            pageId: submitted.pageId,
            updatedAt: submitted.baselineUpdatedAt,
            blocksDigest: submitted.baselineBlocksDigest
          }
        });
        mergeCommittedBaseline(committed, submitted);
        setSelectedPageId(submitted.pageId);
        setSavedNotice("已保存");
        setNotice("没有改动正文与图片，只更新了标题。");
        return true;
      }
      const { blocks, media: addedMedia } = await buildEditBlocks(submitted);
      /*
       * 页级基线：用**打开编辑时冻结**（或上次成功保存刷新）的 updatedAt + 块摘要，
       * 不是“刚读到的 revision”。别的页变动不会让这里误判冲突。
       */
      const committed = await onUpdatePage(submitted.pageId, {
        baseline: {
          pageId: submitted.pageId,
          updatedAt: submitted.baselineUpdatedAt,
          blocksDigest: submitted.baselineBlocksDigest
        },
        title: submitted.title.trim() || "未命名笔记",
        blocks,
        media: addedMedia,
        // 编辑前已存在的缺失引用允许保留（不静默删图）；新增的无效引用仍会被拒绝。
        allowedMissingMediaIds: submitted.preexistingMissingIds
      });
      /**
       * 021-B/024-A：保存成功后**留在连续编辑器**，但只刷新基线与媒体簿记——
       * 保存期间继续输入的标题/正文/新插图保留在草稿里，由下一轮提交，不被覆盖。
       */
      mergeCommittedBaseline(committed, submitted);
      setSelectedPageId(submitted.pageId);
      setSavedNotice("已保存");
      setNotice("已保存修改：标题、正文与图片引用已更新。");
      return true;
    } catch (saveError) {
      // 024-A：冲突单独穿透给协调层（状态显示“冲突”，不与普通失败混同）；
      // 其余失败保留草稿，原页面不受影响。
      if (saveError instanceof PageBaselineConflictError) throw saveError;
      setError(
        saveError instanceof Error
          ? `保存修改失败，草稿已保留：${saveError.message}`
          : "保存修改失败，原页面未被改动；草稿已保留。"
      );
      return false;
    } finally {
      releaseBusy(busyOwner);
    }
  }

  /** 020-B：左侧本/篇面板可收起，把宽度让给中央编辑区。 */
  const [panelOpen, setPanelOpen] = useState(true);

  /**
   * 024：删除与垃圾桶的界面状态。
   * 删除前先确认名称、活动篇数与保留期；永久删除一律二次确认。
   */
  const [deletePrompt, setDeletePrompt] = useState<
    | { kind: "notebook"; id: string; title: string; pageCount: number }
    | { kind: "page"; id: string; title: string }
  >();
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashCleanupPrompt, setTrashCleanupPrompt] = useState(false);
  const trashEntryRef = useRef<HTMLButtonElement>(null);
  const trashAutoCleanup = Number.isFinite(Date.parse(archive.trashConfirmedAt ?? ""));
  function closeTrash() {
    setTrashOpen(false);
    requestAnimationFrame(() => trashEntryRef.current?.focus({ preventScroll: true }));
  }
  useEffect(() => {
    if (mobile && trashOpen) {
      document.getElementById("nb-trash-panel")?.querySelector<HTMLButtonElement>(".nb-mobile-back")?.focus({ preventScroll: true });
    }
  }, [mobile, trashOpen]);
  async function changeTrashAutoCleanup(enabled: boolean) {
    if (!onTrashAutoCleanupChange) return;
    const busyOwner = claimBusy();
    try {
      await onTrashAutoCleanupChange(enabled);
      setTrashCleanupPrompt(false);
      setNotice(enabled ? "已开启 30 天自动清理。" : "已关闭自动清理。");
    } catch (error) {
      setError(error instanceof Error ? error.message : "自动清理设置未保存，请重试。");
    } finally {
      releaseBusy(busyOwner);
    }
  }
  const [purgePrompt, setPurgePrompt] = useState<
    | { kind: "item"; label: string; targets: PurgeTarget[] }
    | { kind: "all"; label: string; targets: PurgeTarget[] }
  >();
  /** 恢复页时原归属失效：要求显式选择有效目标本。 */
  const [restoreTarget, setRestoreTarget] = useState<{ pageId: string }>();

  async function confirmDelete() {
    const prompt = deletePrompt;
    if (!prompt) return;
    const busyOwner = claimBusy();
    setError(undefined);
    // 024-A：确认删除后先停掉待执行的自动保存；在途提交由会话守卫约束，
    // 完成后不会把草稿回填（删除成功即清空草稿）。
    cancelAutosave();
    try {
      if (prompt.kind === "notebook") {
        await onDeleteNotebook?.(prompt.id);
        setNotice(`已把《${prompt.title}》移入垃圾桶，可在垃圾桶恢复。`);
        // 当前本被删除：清空选择，避免继续编辑垃圾桶里的本。
        if (prompt.id === activeNotebookId) {
          updateEditDraft(undefined);
          setSelectedNotebookId("");
          setSelectedPageId("");
        }
      } else {
        await onDeletePage(prompt.id);
        setNotice(`已把《${prompt.title}》移入垃圾桶，可在垃圾桶恢复。`);
        if (editDraft?.pageId === prompt.id) updateEditDraft(undefined);
        if (selectedPageId === prompt.id) setSelectedPageId("");
      }
      setDeletePrompt(undefined);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? `删除失败，内容仍在：${deleteError.message}`
          : "删除失败，内容仍在。"
      );
    } finally {
      releaseBusy(busyOwner);
    }
  }

  /** 冻结垃圾桶里的全部条目用于“清空”。 */
  function freezeAllTrashTargets(): PurgeTarget[] {
    return [
      ...trash.notebooks.map((entry) => ({
        kind: "notebook" as const,
        id: entry.notebook.id,
        deletedAt: entry.deletedAt
      })),
      ...trash.pages.map((entry) => ({
        kind: "page" as const,
        id: entry.page.id,
        deletedAt: entry.deletedAt
      }))
    ];
  }

  async function confirmPurge() {
    const prompt = purgePrompt;
    if (!prompt || !onPurgeTrash) return;
    const busyOwner = claimBusy();
    setError(undefined);
    try {
      const outcome = await onPurgeTrash(prompt.targets);
      if (outcome.status === "purged") {
        setNotice("已永久删除所选条目；相关无人引用的笔记图片已一并回收。");
        setPurgePrompt(undefined);
        setPurgeVersion((current) => current + 1);
      } else if (outcome.status === "conflict") {
        setError("档案在别处已变化，未执行永久删除。请重新打开垃圾桶再确认。");
      } else {
        setError(outcome.reason ?? "条目已变化，未执行永久删除。");
      }
    } catch (purgeError) {
      setError(
        purgeError instanceof Error
          ? `永久删除失败，未删除任何内容：${purgeError.message}`
          : "永久删除失败，未删除任何内容。"
      );
    } finally {
      releaseBusy(busyOwner);
    }
  }

  async function restoreFromTrash(
    target:
      { kind: "notebook"; id: string } | { kind: "page"; id: string; targetNotebookId?: string }
  ) {
    const busyOwner = claimBusy();
    setError(undefined);
    try {
      if (target.kind === "notebook") {
        await onRestoreNotebook?.(target.id);
        setNotice("已恢复笔记本；此前单独删除的页仍在垃圾桶。");
      } else {
        await onRestorePage?.(target.id, target.targetNotebookId);
        setNotice("已恢复这一页。");
        setRestoreTarget(undefined);
      }
    } catch (restoreError) {
      const message = restoreError instanceof Error ? restoreError.message : "";
      if (message.includes("PAGE_RESTORE_TARGET_REQUIRED")) {
        setRestoreTarget({ pageId: target.kind === "page" ? target.id : "" });
        setError("原本已不存在或也在垃圾桶里：请先选择一个有效笔记本再恢复。");
      } else {
        setError(
          restoreError instanceof Error
            ? `恢复失败：${restoreError.message}`
            : "恢复失败，垃圾桶内容未改动。"
        );
      }
    } finally {
      releaseBusy(busyOwner);
    }
  }

  /**
   * 020-B：新建一篇 = 先创建空白页，再进入同一套大编辑区。
   * 不预先塞占位正文；标题与正文由用户在大编辑区里写。
   */
  /**
   * 021-B：新建一篇属于“切换当前篇”，必须与切篇走同一个脏草稿守卫。
   * 守卫通过后才真正建页并进入编辑。
   */
  function createBlankPage() {
    const seq = ++switchSeqRef.current;
    void leaveWithAutosave(() => {
      if (seq !== switchSeqRef.current) return;
      void performCreateBlankPage();
    });
  }

  async function performCreateBlankPage() {
    let notebookId = activeNotebookId;
    if (!notebookId) {
      setError("请先新建一本笔记本，再新建篇。");
      return;
    }
    const busyOwner = claimBusy();
    setError(undefined);
    try {
      // onCreatePage 直接返回新页面对象：立刻进入大编辑区，不等 props 刷新。
      const created = await onCreatePage({
        notebookId,
        title: "未命名笔记",
        blocks: []
      });
      beginEdit(created);
      // 手机上新建后直接进入正文工作区（三栏只显示一层）。
      setMobileStage("editor");
    } catch (createError) {
      setError(
        createError instanceof Error
          ? `新建篇失败：${createError.message}`
          : "新建篇失败，未创建空页面。"
      );
    } finally {
      releaseBusy(busyOwner);
    }
  }

  /**
   * 024-A：离开当前篇/本/新建前等待最新草稿落库。
   *
   * - 有未保存内容：先 flush（含在途等待与续提交）；成功才执行切换；
   * - flush 失败/冲突：**留在当前编辑区**（不执行 run），草稿与选择原样保留，
   *   失败可见，可显式重试或取消编辑后再离开；不弹离页确认、不注册 beforeunload；
   * - 无改动：清理空草稿后直接切换。
   *
   * 明确限制：浏览器关闭/刷新无法保证异步保存完成（不注册 beforeunload，也不做同步卸载保存）。
   */
  async function leaveWithAutosave(run: () => void): Promise<boolean> {
    if (editDraftRef.current && editDirty) {
      cancelAutosave();
      const saved = await flushAutosave();
      if (!saved) {
        if (mobile) setMobileStage("editor");
        setError(
          lastSaveOutcomeRef.current === "conflict"
            ? "这篇在其他地方已被修改，保存未执行：草稿仍保留在编辑区，未覆盖外部内容。"
            : "离开前自动保存未完成，草稿仍保留在本页编辑区；可重试保存，或取消编辑后离开。"
        );
        return false;
      }
    } else {
      cancelEdit();
    }
    run();
    return true;
  }

  /**
   * 移动页面到另一个笔记本。
   *
   * 该篇正开着编辑会话时：草稿已保存就直接结束会话（页面转为既有只读渲染，重点开
   * 即可继续写）；还有未保存内容则先落库，失败/冲突**不移动**、草稿保留。
   * 移动本身只改归属，正文与图片引用不变。
   */
  async function handleMove(page: NotebookPage) {
    const target = moveTargets[page.id];
    if (!target) {
      setError("请先选择目标笔记本。");
      return;
    }
    /*
     * 该篇正开着编辑会话时，先把最新草稿落库、再结束会话，然后才移动。
     *
     * 不能直接移动：`movePage` 会改 `updatedAt`，而草稿冻结着打开编辑时的
     * `baselineUpdatedAt`，留着旧基线的草稿会让**下一次自动保存**误报
     * “这篇在其他地方已被修改”，用户改不动也存不下去。
     * 复用 `leaveWithAutosave` 而不是另写一次 flush：失败/冲突的提示与草稿保留
     * 策略与切篇完全一致（失败时不移动，草稿留在编辑区）。
     */
    /*
     * 归属在**首次异步等待之前**冻结：前置保存、移动请求与回读发布整段都属于这一次命令。
     * 若等到保存之后才取，等待期间用户点开的 B 会被误认成本次移动的 UI owner，
     * A 的迟到结果就会写到 B 的界面上。
     * 判据用切换序号（选篇/选本/撤回都会让它前进），因此**自己合法收起编辑会话**不会
     * 把本次成功/失败反馈吞掉，而用户切走后也不会污染新界面。
     */
    const ownerSwitchSeq = switchSeqRef.current;
    /*
     * 登记该篇**移动前**的时间戳：排队重开一律以它为等待基线。
     * 必须在任何 await 之前登记——否则权威档案可能已带移动后的 `updatedAt`，
     * 排队意图就再也等不到“不同的值”，编辑器不会自动打开。
     */
    movingPagesRef.current.set(page.id, page.updatedAt);

    const session = editDraftRef.current;
    const hadEditSession = session?.pageId === page.id;
    // await 之前冻结会话身份：等待保存期间用户可能切到别的篇并建立新会话。
    const editSessionId = hadEditSession ? session?.sessionId : undefined;
    if (hadEditSession) {
      const flushed = await leaveWithAutosave(() => undefined);
      if (!flushed) {
        // 前置保存失败/冲突时尚未发起移动，也不会进入下方 finally。
        // 结束这篇的移动等待，保留保存协调器留下的草稿与错误。
        movingPagesRef.current.delete(page.id);
        setPendingReopen((pending) => pending?.pageId === page.id ? undefined : pending);
        setMoveEpoch((current) => current + 1);
        return;
      }
      /*
       * 只结束仍属于本次移动的那个会话：切到 B（或重开 A）之后建立的新会话不归这次移动管，
       * 关掉它会打断用户正在写的输入。保存已经落库，被移动的篇下次打开会拿到新基线。
       */
      cancelEditSession(page.id, editSessionId);
    }
    /** 界面仍是发起这次移动时的那个（没有更新的选篇/选本/撤回）才允许发布反馈。 */
    const ownsUi = () => switchSeqRef.current === ownerSwitchSeq;

    const busyOwner = claimBusy();
    setError(undefined);
    try {
      const result = await onMovePage(page.id, target);
      if (!result.moved) {
        // no-op：没有发生写入，排队中的重开意图不会等到权威变化，直接结束它。
        if (pendingReopenRef.current?.pageId === page.id) setPendingReopen(undefined);
        if (!ownsUi()) return;
        setNotice("该页已经在目标笔记本中，未做改动。");
      } else {
        if (!ownsUi()) return;
        const name = notebooks.find((notebook) => notebook.id === target)?.title ?? "目标笔记本";
        setNotice(
          hadEditSession
            ? `已移动到「${name}」；正文与图片引用保持不变。本次编辑已收起，重新点开该篇可继续写。`
            : `已移动到「${name}」；正文与图片引用保持不变。`
        );
      }
    } catch (moveError) {
      // 移动失败：结束排队中的重开意图（不会有权威变化来满足它）。
      if (pendingReopenRef.current?.pageId === page.id) setPendingReopen(undefined);
      // 失败反馈同样只发给发起它的那次会话：切到 B 之后不能把 A 的失败显示在 B 上。
      if (!ownsUi()) return;
      // 失败保持原归属。
      setError(
        moveError instanceof Error
          ? `移动失败，页面仍在原笔记本：${moveError.message}`
          : "移动失败，页面仍在原笔记本。"
      );
    } finally {
      movingPagesRef.current.delete(page.id);
      setMoveEpoch((current) => current + 1);
      // 只释放自己那次的忙碌：后来的操作（关联/复制/保存/另一次移动）不能被这行清掉。
      releaseBusy(busyOwner);
    }
  }

  /**
   * 被移动挡下的重新打开：等 archive 真的带上移动结果再打开。
   *
   * 判据是目标篇的 `updatedAt` 与移动前不同——只有权威数据里出现了新版本，
   * 才说明移动已经落库。仅判“移动不再进行”不够：移动刚完成时 props 可能还是
   * 移动前那一份，按它开会话仍会留下过期基线，下一次保存被 `PAGE_BASELINE_CONFLICT` 拒绝。
   */

  async function handleLink() {
    const ownerSwitchSeq = switchSeqRef.current;
    const busyOwner = claimBusy();
    try {
      const result = await onLinkLegacy();
      if (switchSeqRef.current !== ownerSwitchSeq) return;
      setNotice(
        result.linkedCount > 0
          ? `已建立 ${result.linkedCount} 条旧版关联查看。关联查看不复制图片，仍需“复制到笔记本”才算独立。`
          : "没有新的旧游记可关联。"
      );
    } catch {
      if (switchSeqRef.current !== ownerSwitchSeq) return;
      setError("建立关联查看失败，旧游记数据未被修改。");
    } finally {
      releaseBusy(busyOwner);
    }
  }

  async function handleCopy(candidate: LegacyJournalCandidate) {
    const ownerSwitchSeq = switchSeqRef.current;
    const busyOwner = claimBusy();
    setError(undefined);
    try {
      const result = await onCopyLegacy(candidate);
      // 迟到结果只发给发起它的那个界面（切篇/切本后不再覆盖新界面）。
      if (switchSeqRef.current !== ownerSwitchSeq) return;
      if (result.status === "complete") {
        setNotice(`已独立复制正文与 ${result.copiedMediaCount} 张图片，此页不再依赖旧游记存储。`);
      } else if (result.status === "partial") {
        setError(`复制不完整：${result.issues.join(" ")} 可重试。`);
      } else if (result.status === "skipped") {
        setNotice("此前已完整复制且来源未变化，未重复创建。");
      } else {
        setError(result.issues.join(" ") || "复制失败，未标记为已复制。");
      }
    } finally {
      releaseBusy(busyOwner);
    }
  }


  /**
   * 020-B：中央大编辑区。表单体与原实现逐字段一致，只是从篇卡片里移出来，
   * 让“编辑一篇完整旅行手账”成为页面主体；保存/取消/容量/引用逻辑都没变。
   * `editDraft` 存在时才有内容，且只渲染这一份。
   */
  /**
   * 编辑表单体：与原实现逐字段一致，只是从篇卡片移到中央大编辑区；
   * 保存 / 取消 / 容量 / 引用校验逻辑都没改。
   */

  /**
   * 021：三栏工作区的 UI 状态（与持久化数据完全分开）。
   * `selectedPageId` 只记“当前打开哪一篇”；草稿仍由 `editDraft` 单一持有。
   */
  const [selectedPageId, setSelectedPageId] = useState("");
  const consumedOpenPageRequestRef = useRef(0);
  const [pageSearch, setPageSearch] = useState("");
  const [mobileStage, setMobileStage] = useState<"notebooks" | "pages" | "editor">("notebooks");

  const [searchReturnStage, setSearchReturnStage] = useState<"notebooks" | "pages">("notebooks");
  const [captureOpen, setCaptureOpen] = useState(false);
  /**
   * 工具栏弹层互斥：篇信息 / 移动 / 右侧工具面板，任何时刻只允许一个。
   * 地区编辑统一放在定位侧栏。
   */
  function openToolPanel(panel: "search" | "regions") {
    setInfoOpen(false);
    setMoveOpen(false);
    setWorkPanel((current) => (current === panel ? null : panel));
  }

  /**
   * 同上互斥规则的“只开不关”版：列表「⋯ → 移动到其他笔记本」是从另一个入口
   * 打开工具栏的移动面板，必须先关掉其余弹层，避免与篇信息或侧栏重叠。
   */
  function openMovePanel() {
    setInfoOpen(false);
    setWorkPanel(null);
    setMoveOpen(true);
  }
  const [infoOpen, setInfoOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const infoPanelRef = useRef<HTMLDivElement>(null);
  const movePanelRef = useRef<HTMLDivElement>(null);
  useDismissableLayer(infoPanelRef, infoOpen, () => setInfoOpen(false));
  useDismissableLayer(movePanelRef, moveOpen, () => setMoveOpen(false));
  /** 每次明确的地区 / 日期操作触发同一串行保存链。 */
  const [regionSaveSignal, setRegionSaveSignal] = useState(0);
  const [regionSaving, setRegionSaving] = useState(false);
  useDismissableLayer(workPanelRef, workPanel !== null, () => {
    if (workPanel === "regions" && (busy || regionSaving)) return;
    if (workPanel === "search") setMobileStage(searchReturnStage);
    setWorkPanel(null);
  });
  useEffect(() => { if (workPanel !== "regions") setRegionSaving(false); }, [workPanel]);
  /**
   * M1.5：地区面板的受控草稿。照片位置识别的候选从这里追加（不覆盖手动选择），
   * 每次明确操作触发同一命令链。
   */
  const [regionDraftIds, setRegionDraftIds] = useState<string[] | null>(null);
  /**
   * M1.5：待存来源记录随地区一并落库，只在本次保存成功后清空——
   * 草稿未保存时不宣称关联已落库。
   */
  const [pendingRegionSources, setPendingRegionSources] = useState<RegionAssociationSource[]>([]);
  /** P2（N19）：**当前页面**的实时 ref（切篇 effect 更新）——保存回调
   * 用它与发起时捕获的 savedPageId 比较判断归属，不用过期的闭包值。 */
  const currentPageIdRef = useRef<string | null>(null);

  /** 当前篇已存关联的 regionId 列表（受控草稿的缺省基线）。 */
  function regionsOf(pageId: string): string[] {
    return (findTripJournal(archive, pageId)?.regions ?? []).map((ref) => ref.regionId);
  }

  /** 当前篇已落库的来源记录（双 ID 归一）。 */
  function savedSourcesOf(pageId: string): RegionAssociationSource[] {
    return normalizeRegionSources(findTripJournal(archive, pageId)?.regionSources);
  }

  /**
   * 024-B：自动保存状态。
   *
   * - `editSequence` 每次修改 +1；提交时把 sequence 冻结进快照，
   *   旧请求返回只确认**它提交的那一版**，不会覆盖更新的输入；
   * - `autoStatus` 只反映真实写入结果：未保存 / 保存中 / 已保存 / 保存失败 / 冲突；
   * - 冲突与失败都保留草稿，不自动重试、不自动覆盖。
   */
  const [editSequence, setEditSequence] = useState(0);
  const [autoStatus, setAutoStatus] = useState<
    "idle" | "dirty" | "saving" | "saved" | "failed" | "conflict"
  >("idle");
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editSequenceRef = useRef(0);
  /** 024-A复审：在途提交任务，类型与实际返回一致（不用断言掩盖）。 */
  const inFlightRef = useRef<Promise<{ ok: boolean; settled: boolean }> | null>(null);
  /** 024-A：最近一次提交结果（ref 供异步回调读取，不受渲染闭包陈旧影响）。 */
  const lastSaveOutcomeRef = useRef<"ok" | "failed" | "conflict">("ok");

  /** 每次修改都推进编辑序号，并重置 1000ms 防抖。 */
  function markDirty() {
    editSequenceRef.current += 1;
    setEditSequence(editSequenceRef.current);
    setAutoStatus("dirty");
    if (autoTimerRef.current) clearTimeout(autoTimerRef.current);
    autoTimerRef.current = setTimeout(() => {
      autoTimerRef.current = null;
      void flushAutosave();
    }, 1000);
  }

  function cancelAutosave() {
    if (autoTimerRef.current) {
      clearTimeout(autoTimerRef.current);
      autoTimerRef.current = null;
    }
  }

  /**
   * 024-A：单次提交（冻结提交时刻的序号）。返回 `{ ok, settled }`：
   * - ok=false：失败或冲突，草稿保留；冲突单独显示，不自动覆盖、不自动重试；
   * - settled=true：提交后没有新输入（状态可置“已保存”）；
   * - settled=false：保存期间又有新输入，状态保持“未保存”，由协调层继续提交。
   */
  function submitCurrentSave(): Promise<{ ok: boolean; settled: boolean }> {
    const sequence = editSequenceRef.current;
    setAutoStatus("saving");
    return (async () => {
      try {
        const saved = await handleSaveEdit();
        if (!saved) {
          // 024-A复审：失败后消费待执行防抖定时器，不自动再次提交（允许显式重试）。
          cancelAutosave();
          lastSaveOutcomeRef.current = "failed";
          setAutoStatus("failed");
          return { ok: false, settled: true };
        }
        const settled = editSequenceRef.current === sequence;
        lastSaveOutcomeRef.current = "ok";
        setAutoStatus(settled ? "saved" : "dirty");
        return { ok: true, settled };
      } catch (saveError) {
        const message = saveError instanceof Error ? saveError.message : "";
        // 024-A复审：冲突/失败同样取消遗留防抖定时器，不自动重试。
        cancelAutosave();
        if (message.includes("PAGE_BASELINE_CONFLICT")) {
          lastSaveOutcomeRef.current = "conflict";
          setAutoStatus("conflict");
        } else {
          lastSaveOutcomeRef.current = "failed";
          setAutoStatus("failed");
        }
        return { ok: false, settled: true };
      }
    })();
  }

  /**
   * 024-A：保存协调的唯一入口（防抖到期、立即保存、表单提交、切篇/切本/新建、
   * 全局离页守卫都走这里）。成功含义：截至本次调用时最新的修改已保存——
   * 已有请求在途时**等待**它；期间新增的修改在成功后继续提交；失败或冲突
   * 立即结束返回 false，不做循环重试。无草稿（或无变化不写库）不产生写入。
   */
  async function flushAutosave(): Promise<boolean> {
    while (true) {
      const pending = inFlightRef.current;
      if (pending) {
        const outcome = await pending;
        // 在途请求失败/冲突：立即结束，不续提交、不循环重试。
        if (!outcome.ok) return false;
        // 在途请求成功且提交后无新输入：最新状态已落库，视为成功。
        if (outcome.settled) return true;
        continue;
      }
      const draft = editDraftRef.current;
      if (!draft) return true;
      const task = submitCurrentSave();
      inFlightRef.current = task;
      const outcome = await task;
      if (inFlightRef.current === task) inFlightRef.current = null;
      if (!outcome.ok) return false;
      if (outcome.settled) return true;
      // 保存期间又有新输入：继续下一轮提交（不重试失败，只提交新增量）。
    }
  }

  // 卸载时清掉定时器，避免离开页面后仍触发保存。
  useEffect(() => {
    return () => {
      if (autoTimerRef.current) clearTimeout(autoTimerRef.current);
    };
  }, []);

  /*
   * 024-A：向 App 注册全局离页守卫（切到地图/记录/设置前等待最新草稿落库）。
   * flushAutosave 每次渲染重建，用 ref 保存最新一份；守卫本身稳定注册一次，
   * 组件卸载时注销（此后全局导航不再等待本页）。
   */
  const flushRef = useRef(flushAutosave);
  useEffect(() => {
    flushRef.current = flushAutosave;
  });
  const leaveGuardRef = useRef<() => Promise<boolean>>(() => flushRef.current());
  useEffect(() => {
    onRegisterLeaveGuard?.(() => leaveGuardRef.current());
    return () => onRegisterLeaveGuard?.(null);
  }, [onRegisterLeaveGuard]);

  /** 每本的篇数（只按 notebookId 计数，不读图片 Blob）。 */
  const pageCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    archive.pages.forEach((page) => {
      counts[page.notebookId] = (counts[page.notebookId] ?? 0) + 1;
    });
    return counts;
  }, [archive.pages]);

  /**
   * 打开一篇 = 直接进入正文工作区。
   * 可编辑的篇立刻建草稿（无需再点“编辑”）；旧游记关联页保持只读。
   * 024-A：有未保存内容时先等待保存落库（见 `leaveWithAutosave`）；
   * 失败/冲突留在当前编辑区，不切换、不丢草稿。
   *
   * `options.move`：来自列表「⋯ → 移动到其他笔记本」，选中该篇后接着展开工具栏的
   * 移动面板。意图必须在这里**按次快照**，不能由调用方在 `openPage` 之后自己
   * `setMoveOpen(true)`——切篇要等自动保存落库，晚到的回调会把刚打开的面板关掉。
   * 切换被更新的点击取代时（seq 不匹配）回调直接返回，面板不会弹在错的篇上。
   */
  /** 该篇当前应作为“移动前版本”的时间戳：在途移动时是移动前的值。 */
  function moveBaselineFor(pageId: string, current: string): string {
    return movingPagesRef.current.get(pageId) ?? current;
  }

  function openPage(page: NotebookPage, options?: { move?: boolean }) {
    const moveIntent = options?.move === true;
    /*
     * 该篇正在移动中：不做“打开后再想基线”的事——移动结果还没回来，这时建立的会话
     * 一定带着旧 `updatedAt`。先记下意图，等 archive 更新（移动落库后的权威版本）再开。
     */
    if (movingPagesRef.current.has(page.id)) {
      // 意图建立时冻结切换序号：之后的选篇/选本/撤回（更晚的意图）会让它失效。
      const seqAtIntent = switchSeqRef.current;
      /*
       * 等待基线用**移动前**的时间戳，不是当前 props 的：权威档案可能先于移动回调到达，
       * 若在这里改用它的 updatedAt，之后就不会再出现“不同的值”，排队意图永远完不成。
       */
      const baseline = moveBaselineFor(page.id, page.updatedAt);
      setPendingReopen({ pageId: page.id, updatedAtBefore: baseline, switchSeq: seqAtIntent });
      setNotice("这篇正在移动中，移动完成后会自动打开，可继续编辑。");
      return;
    }
    // 024-A复审：点回当前篇=撤回在途的切换意图，同样使旧切换失效。
    if (editDraft?.pageId === page.id) {
      switchSeqRef.current += 1;
      setMobileStage("editor");
      // 只有显式“移动”意图才动面板；点回当前篇其余情况保持面板原状。
      if (moveIntent) openMovePanel();
      return;
    }
    const seq = ++switchSeqRef.current;
    void leaveWithAutosave(() => {
      // 等待保存期间用户又点了其他篇/点回当前篇：本次意图已过期，只保留已落库的保存。
      if (seq !== switchSeqRef.current) return;
      setSelectedPageId(page.id);
      setInfoOpen(false);
      // 移动意图：走互斥入口；其余情况维持“切篇就收起移动面板”的原有行为。
      if (moveIntent) openMovePanel();
      else setMoveOpen(false);
      setMobileStage("editor");
      if (page.source.kind === "legacy-journal") {
        cancelEdit();
        return;
      }
      beginEdit(page);
    });
  }

  /**
   * 地图笔记详情的一次性跳转请求：目标篇确认存在后才消费，档案尚未加载完
   * 时保留请求等下一次 archive 更新；token 防止重复打开。
   */
  useEffect(() => {
    const request = openPageRequest;
    if (!request || consumedOpenPageRequestRef.current === request.token) return;
    const target = archive.pages.find((item) => item.id === request.pageId);
    if (!target) return;
    consumedOpenPageRequestRef.current = request.token;
    setSelectedNotebookId(target.notebookId);
    onOpenPageRequestConsumed?.();
    openPage(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 目标篇只按请求 token 消费一次
  }, [archive, openPageRequest, onOpenPageRequestConsumed]);

  /**
   * 移动落库后自动打开被挡下的那一篇。
   *
   * 判据是目标篇的 `updatedAt` 与移动前不同：只有权威数据里出现新版本才说明移动已落库。
   * 仅判“移动不再进行”不够——移动刚完成时 props 可能还是移动前那一份，
   * 按它开会话仍会留下过期基线，下一次保存被 `PAGE_BASELINE_CONFLICT` 拒绝。
   */
  useEffect(() => {
    // 用 state 本身（依赖里已有它）作为判据；ref 只给回调场景做镜像，不能当 effect 的输入。
    const pending = pendingReopen;
    if (!pending) return;
    /*
     * 该意图必须仍是**最新选择**：用户在排队期间点了别的篇/本（或点回当前篇撤回）都会让
     * `switchSeqRef` 前进，此时旧意图作废——否则移动回读到达时会夺取用户后来选的界面。
     */
    if (pending.switchSeq !== switchSeqRef.current) {
      setPendingReopen(undefined);
      return;
    }
    /*
     * 移动还在途：**保留意图**并等它结束（`moveEpoch` 会再触发本 effect）。
     * 这里不能调 `openPage`：那会把它重新排一次队，而当前 props 若已是移动后的权威档案，
     * 新基线就等于档案值，“不同的值”再也不会出现——既打不开也会自激成死循环。
     */
    if (movingPagesRef.current.has(pending.pageId)) return;
    /*
     * 判据是“权威 archive 里这篇的 `updatedAt` 与**移动前**基线不同”：那才说明移动已落库。
     * 两种到达顺序都要能完成：命令回调先到（archive 随后变化）或权威档案先到（命令完成后
     * `moveEpoch` 触发本次 effect，此时基线仍是移动前的值）。
     */
    const target = archive.pages.find((item) => item.id === pending.pageId);
    if (!target || target.updatedAt === pending.updatedAtBefore) return;
    setPendingReopen(undefined);
    setNotice(undefined);
    openPage(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 判据是 archive/意图/移动完成信号，openPage 每次渲染重建
  }, [archive, pendingReopen, moveEpoch]);

  /**
   * 切换本：先自动提交当前草稿，再清掉选择并退回篇列表层级。
   */
  function switchNotebook(notebookId: string, afterSwitch?: () => void) {
    if (notebookId === activeNotebookId) {
      // 已选中同一本：手机上这一步是“进入该本的篇列表”，不是切换。
      switchSeqRef.current += 1;
      setMobileStage(mobile ? "pages" : "notebooks");
      afterSwitch?.();
      return;
    }
    const seq = ++switchSeqRef.current;
    void leaveWithAutosave(() => {
      if (seq !== switchSeqRef.current) return;
      setSelectedNotebookId(notebookId);
      setSelectedPageId("");
      updateEditDraft(undefined);
      setMobileStage(mobile ? "pages" : "notebooks");
      afterSwitch?.();
    });
  }

  /** 快速新建用的表单（与中栏折叠区共用同一份，不复制第二套逻辑）。 */
  const captureForm = (
    <form className="notebook-capture" onSubmit={(event) => void handleSubmit(event)}>
      <label htmlFor="notebook-capture-text">现在记点什么</label>
      <textarea
        id="notebook-capture-text"
        value={draftText}
        onChange={(event) => setDraftText(event.target.value)}
        placeholder="例如：今天在伊犁河边走了很久，风很大。"
        rows={4}
      />
      {draftPhotos.length > 0 ? (
        <ul className="notebook-draft-photos">
          {draftPhotos.map((photo) => (
            <li key={photo.id}>
              {/* Data URL 本地预览，next/image 不适用。 */}
              <img src={photo.dataUrl} alt={photo.name} />
              <span>
                {photo.name} · {formatBytes(photo.size)} · 待写入
              </span>
              <button
                type="button"
                className="notebook-draft-remove"
                onClick={() => handleRemoveDraftPhoto(photo.id)}
                aria-label={`移除待保存图片 ${photo.name}`}
              >
                <Trash2 size={14} /> 移除
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="notebook-capture-actions">
        <div className="nb-capture-tools">
          <button type="button" className="nb-icon-button" aria-label="添加图片" title="添加图片" disabled={busy} onClick={() => inputRef.current?.click()}>
            <ImagePlus size={18} aria-hidden />
          </button>
          <input ref={inputRef} type="file" hidden accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => void handleFiles(event.target.files)} />
        </div>
        <div className="nb-capture-tools">
          <button type="button" className="nb-icon-button" aria-label="取消" title="取消，保留草稿" disabled={busy} onClick={() => setCaptureOpen(false)}>
            <X size={18} aria-hidden />
          </button>
          <button type="submit" className="nb-icon-button nb-capture-save" aria-label="保存到本机" title="保存" disabled={busy || (!draftText.trim() && draftPhotos.length === 0)}>
            <Check size={18} aria-hidden />
          </button>
        </div>
      </div>
    </form>
  );

  /** 左栏“更多”内容：旧游记兼容（原样保留）。 */
  const morePanel = (
    <>
      <div className="notebook-legacy">
        <h3>
          <Import size={15} /> 1.x 旧数据
        </h3>
        <p>
          找到 {legacy.journals.length} 篇旧游记、{legacy.trips.length} 条旧行程。旧游记是{" "}
          <strong>只读来源</strong>，本工具不会修改或清空它。
        </p>
        <button
          className="secondary-button"
          disabled={busy || pendingLinkCount === 0}
          onClick={() => void handleLink()}
        >
          <Link2 size={15} />
          {pendingLinkCount === 0 ? "没有待关联的旧游记" : `建立关联查看（${pendingLinkCount}）`}
        </button>

        {legacy.journals.length > 0 ? (
          <ul className="notebook-legacy-list">
            {legacy.journals.map((candidate) => {
              const record = findLegacyImport(archive, candidate.spotId);
              const statusText = candidate.copied
                ? candidate.sourceChanged
                  ? "已独立复制 · 来源已变化"
                  : "已独立复制"
                : candidate.linked
                  ? "旧版关联查看（未复制）"
                  : "未关联";
              return (
                <li key={candidate.spotId}>
                  <div>
                    <strong>{candidate.spotId}</strong>
                    <small>
                      {statusText} · {candidate.photoCount} 张图片
                      {record?.copyStatus === "partial" ? " · 上次复制不完整" : ""}
                    </small>
                  </div>
                  <button
                    className="secondary-button"
                    disabled={busy || candidate.copied}
                    onClick={() => void handleCopy(candidate)}
                  >
                    <Copy size={15} />
                    {candidate.copied ? "已复制" : "复制到笔记本"}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        {legacy.trips.length > 0 ? (
          <p className="notebook-legacy-note">
            旧行程暂无笔记本导入方式，其原始数据仍保留在浏览器中，不会被删除。
          </p>
        ) : null}
      </div>
    </>
  );

  /**
   * 021：当前篇（右栏工作区的主体）。兼容两种来源：
   * - 正在编辑的篇（editDraft 存在）用草稿；
   * - 刚选中的篇（尚未产生草稿）用已存内容只读展示。
   */
  const currentPage =
    editPage ??
    (selectedPageId ? (archive.pages.find((item) => item.id === selectedPageId) ?? null) : null);

  /** 切篇时重置受控地区草稿与来源待办：属于具体一篇，不跟随切换残留。 */
  useEffect(() => {
    currentPageIdRef.current = currentPage?.id ?? null;
    setRegionDraftIds(null);
    setPendingRegionSources([]);
    setRegionSaving(false);
  }, [currentPage?.id]);

  /**
   * P1（冲突重试收紧）：地区面板打开（或开着面板切篇）时冻结该篇元数据
   * 基线。保存冲突时用它判断：元数据自打开以来未变 → 冲突来自正文自动
   * 保存等字段不相交的写入，可按最新 revision 重试；变了 → 其他操作改过
   * 地区/日期等元数据，保留草稿并提示，不强行覆盖。保存成功后刷新基线。
   */
  const regionPanelBaselineRef = useRef<{ pageId: string; signature: string } | null>(null);
  useEffect(() => {
    if (workPanel !== "regions" || !currentPage) {
      regionPanelBaselineRef.current = null;
      return;
    }
    regionPanelBaselineRef.current = {
      pageId: currentPage.id,
      signature: tripJournalMetaSignature(archive, currentPage.id)
    };
    // 故意不依赖 archive：基线只在开面板/切篇时冻结，保存期间的档案更新
    // （含其他实例的 meta 写入）不得刷新基线，否则冲突会被误判为安全。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workPanel, currentPage?.id]);

  /** 关联详情沿用已存 / 待存来源，只显示当前关联的地区。 */
  const regionSourceViews: RegionSourceView[] = useMemo(() => {
    if (!currentPage) return [];
    const ids = [...new Set((regionDraftIds ?? regionsOf(currentPage.id)).map(canonicalRegionId))];
    return ids.map(regionId => ({
      regionId,
      records: [
        ...savedSourcesOf(currentPage.id).filter(source => source.regionId === regionId)
          .map(source => ({ source, persisted: true, pendingUndo: false })),
        ...pendingRegionSources.filter(source => source.regionId === regionId)
          .map(source => ({ source, persisted: false, pendingUndo: false }))
      ]
    }));
  }, [currentPage, regionDraftIds, archive, pendingRegionSources]);

  /**
   * M2 旅行日期编辑：打开面板时从 meta 读当前值（tripDateRange 优先，旧
   * tripDate 按 day 兼容显示）；有效选择直接沿原地区命令保存；精度表达部分
   * 日期，不伪装具体某天；来源只有用户补填（manual）。
   */
  const effectiveDate = currentPage
    ? effectiveTripDateRange(findTripJournal(archive, currentPage.id))
    : null;
  /**
   * P2：按精度回填输入——重开月份记录时输入应为 "2026-05"（解析器要求），
   * 不是归一化后的 "2026-05-01"；年份同理 "2026"。编辑往返一致。
   */
  const [tripDateDraft, setTripDateDraft] = useState<{
    precision: TripDateRange["precision"];
    value: string;
    toValue: string;
  }>(() => ({
    precision: effectiveDate?.precision ?? "day",
    ...tripDateBackfill(effectiveDate)
  }));
  const [tripDateTouched, setTripDateTouched] = useState(false);
  const [tripDateOpen, setTripDateOpen] = useState(false);
  const tripDatePopoverRef = useRef<HTMLDivElement>(null);
  const tripDatePopoverId = useId();
  const tripDateVisible = tripDateOpen && workPanel === "regions" && !!currentPage;
  useDismissableLayer(tripDatePopoverRef, tripDateVisible, () => setTripDateOpen(false));
  useEffect(() => {
    if (tripDateVisible) tripDatePopoverRef.current?.focus({ preventScroll: true });
  }, [tripDateVisible]);
  useEffect(() => { setTripDateOpen(false); }, [workPanel, currentPage?.id]);
  useEffect(() => {
    setTripDateDraft({
      precision: effectiveDate?.precision ?? "day",
      ...tripDateBackfill(effectiveDate)
    });
    setTripDateTouched(false);
  }, [currentPage?.id]); // 打开篇时重置为已存值；保存成功后由 revision 变化回填
  /** 解析当前草稿；空输入=清除日期。 */
  const parsedTripDate = useMemo<
    TripDateRange | null | { error: string }
  >(() => {
    if (!tripDateTouched) return effectiveDate;
    if (!tripDateDraft.value.trim()) return null;
    return parseTripDateInput(tripDateDraft);
  }, [tripDateDraft, tripDateTouched, effectiveDate]);

  function changeTripDate(next: typeof tripDateDraft) {
    setTripDateDraft(next);
    setTripDateTouched(Boolean(next.value));
    if (next.value && !("error" in parseTripDateInput(next))) {
      setRegionSaveSignal(signal => signal + 1);
    }
  }

  function clearTripDate() {
    setTripDateDraft(current => ({ ...current, value: "", toValue: "" }));
    setTripDateTouched(true);
    setRegionSaveSignal(signal => signal + 1);
  }

  /** 媒体名映射（来源面板显示照片名）。 */
  const mediaNamesById = useMemo(() => {
    const names: Record<string, string> = {};
    for (const item of media) names[item.id] = item.name;
    return names;
  }, [media]);

  function removeRegion(regionId: string) {
    if (!currentPage) return;
    const target = canonicalRegionId(regionId);
    setRegionDraftIds((regionDraftIds ?? regionsOf(currentPage.id))
      .filter(id => canonicalRegionId(id) !== target));
    setPendingRegionSources(current => current.filter(source => source.regionId !== target));
    setRegionSaveSignal(signal => signal + 1);
  }


  /**
   * P2：单篇整理的协调入口。
   *
   * 目标篇 = **正在编辑的这一篇**（`editDraft.pageId`）：只有可编辑的本地篇才能整理，
   * 旧游记关联查看页（只读）不出现入口。
   * 依赖通过 ref/闭包读取最新值，异步回调不依赖旧 props。
   */
  const aiTarget =
    editDraft && archive.pages.some((item) => item.id === editDraft.pageId)
      ? (archive.pages.find((item) => item.id === editDraft.pageId) ?? null)
      : null;
  /** 旧游记关联查看页只读，不参与整理。 */
  const aiReady = aiTarget !== null && aiTarget.source.kind !== "legacy-journal";

  /**
   * Q4：flush 成功后读取**本会话最新权威基线**。
   * 基线在 `mergeCommittedBaseline` 里随实际提交页刷新，因此“自己刚保存的输入”
   * 不会被保存前的旧基线误判成外部冲突；外部并发改动仍会与它不一致。
   */
  const readOrganizeBaseline = (): PageOrganizeBaseline | undefined => {
    const draft = editDraftRef.current;
    if (!draft) return undefined;
    return {
      pageId: draft.pageId,
      updatedAt: draft.baselineUpdatedAt,
      blocksDigest: draft.baselineBlocksDigest,
      markdown: draft.baselineMarkdown,
      editSequence: editSequenceRef.current,
      sessionId: draft.sessionId
    };
  };

  /** 从**当前已保存的草稿**构造会话快照；只在事件/回调里调用，不在渲染期读 ref。 */
  const buildSessionSnapshot = (draft: NotebookEditDraft): PageOrganizeSession => ({
    pageId: draft.pageId,
    sessionId: draft.sessionId,
    baselineUpdatedAt: draft.baselineUpdatedAt,
    baselineBlocksDigest: draft.baselineBlocksDigest,
    readDraftMarkdown: () => editDraftRef.current?.markdown ?? "",
    readEditSequence: () => editSequenceRef.current,
    baselineMarkdown: draft.baselineMarkdown,
    committedEditSequence: editSequenceRef.current
  });

  const organize = usePageOrganize({
    ai: aiRepository,
    notebooks: notebookRepository,
    target: aiTarget,
    // 同一篇重新进入编辑会换会话号：hook 用它识别“同页新会话”，旧回调据此失效。
    targetSessionId: editDraft?.sessionId,
    // 传入本次渲染的档案/媒体；hook 内部保存最新值，异步动作读取它而不是旧闭包。
    getArchive: () => archive,
    getMedia: () => media,
    readBaseline: readOrganizeBaseline,
    enabled: aiReady,
    onFlush: () => flushAutosave(),
    onApplied: async (page, apply, session) => {
      const latest = editDraftRef.current;
      if (latest && latest.sessionId === session.sessionId && latest.pageId === session.pageId) {
        /*
         * 先按实际提交页刷新基线；再在“应用窗口内没有新输入”时把编辑器正文同步为
         * 已提交内容（否则界面会停留在旧正文、与库不一致，下一次输入会把旧正文写回去）。
         * 有新输入时保留用户输入，只更新基线，由下一轮保存提交。
         */
        if (apply.refreshEditor) {
          // 用**实际提交页的块**重建编辑器正文（与保存路径同一转换），避免界面停留在旧正文。
          const committedMarkdown = blocksToMarkdown(page.blocks);
          if (latest.markdown !== committedMarkdown) {
            updateEditDraft({ ...latest, markdown: committedMarkdown });
          }
        }
        mergeCommittedBaseline(page, editDraftRef.current ?? latest);
      }
      // 复用既有 refresh 入口：档案、媒体与容量计数都按实际提交结果刷新。
      await onReloadArchive?.();
      setNotice(
        `已应用整理结果并回读确认（页版本 ${page.updatedAt.slice(0, 19).replace("T", " ")}）。`
      );
    },
    onNotice: (text) => setNotice(text),
    callGateway: aiGatewayCaller
  });
  /**
   * P4：本册智能整理的协调入口。
   *
   * 目标 = **当前选中的笔记本**（不是当前篇）：入口与结果都不离开笔记本页面，
   * 不新增顶层入口。只读分析，不写正文、媒体或业务收据。
   */
  const activeNotebookTitle =
    notebooks.find((notebook) => notebook.id === activeNotebookId)?.title ?? "";
  const analysis = useNotebookAnalysis({
    ai: aiRepository,
    notebookId: activeNotebookId,
    archive,
    media,
    // flush 之后读取权威档案：不用保存前的 props 冻结来源。
    loadArchive: () => notebookRepository.loadArchive(),
    enabled: activeNotebookId.length > 0 && activeNotebookTitle.length > 0,
    onFlush: () => flushAutosave(),
    // 打开来源篇复用既有 openPage（它内部先经 leaveWithAutosave，失败留在当前会话）。
    onOpenPage: (pageId) => {
      const page = archive.pages.find((item) => item.id === pageId);
      if (!page || isPageDeleted(page)) return false;
      openPage(page);
      return true;
    },
    onNotice: (text) => setNotice(text),
    callGateway: aiGatewayCaller
  });

  function closeAnalysisModal() {
    setAnalysisModalOpen(false);
    if (analysis.status === "generating") void analysis.cancel();
  }

  useEffect(() => {
    if (!analysisModalOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    analysisModalRef.current?.querySelector<HTMLElement>(".nb-analysis-toggle")?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (analysisOpenerRef.current?.isConnected) analysisOpenerRef.current.focus();
    };
  }, [analysisModalOpen]);

  /**
   * P5：搜索笔记的协调入口。
   *
   * 检索本身不离开本机（关键词/时间/地区/本都在本地档案上做），只有“生成主题标签”
   * 是显式外发动作；因此面板不需要外发同意，单篇生成单独确认。
   */
  const visibleNotebooks = useMemo(
    () => notebooks.map((notebook) => ({ id: notebook.id, title: notebook.title })),
    [notebooks]
  );
  const search = useNotebookSearch({
    ai: aiRepository,
    archive,
    media,
    loadArchive: () => notebookRepository.loadArchive(),
    enabled: true,
    onFlush: () => flushAutosave(),
    onOpenPage: (pageId) => {
      const page = archive.pages.find((item) => item.id === pageId);
      if (!page || isPageDeleted(page)) return false;
      openPage(page);
      return true;
    },
    onNotice: (text) => setNotice(text),
    callGateway: aiGatewayCaller
  });

  // 直接派生（每次渲染的数组很小，不引入额外 memo 身份）。
  // R1：只投影通过记录校验的旅行/地点；坏记录由面板的 damage 报告，绝不在这里清理或写回。
  const tripStore = projectTripSlice(readTripSlice(archive));
  const tripOptions = tripStore.trips
    .filter((trip) => !trip.deletedAt)
    .map((trip) => ({ id: trip.id, title: trip.title }));
  const placeOptions = tripStore.places
    .filter((place) => !place.deletedAt)
    .map((place) => ({ id: place.id, name: place.name }));

  /**
   * P8：整理检索结果（只读分组）的协调入口。
   *
   * 范围 = 检索区里**已经选好的结构筛选**（本/地区/旅行/地点/时间）：用户在这里确认范围，
   * 不另造第二套筛选表单，也不新增顶层入口。关键词框不参与整理——整理目标会转成检索关键词。
   */
  const lightAgentScope = useMemo<CollectionScope>(
    () => ({
      notebookIds: search.filters.notebookId ? [search.filters.notebookId] : null,
      regionIds: search.filters.regionId ? [search.filters.regionId] : null,
      tripIds: search.filters.tripId ? [search.filters.tripId] : null,
      placeIds: search.filters.placeId ? [search.filters.placeId] : null,
      from: search.filters.from || null,
      to: search.filters.to || null
    }),
    [
      search.filters.notebookId,
      search.filters.regionId,
      search.filters.tripId,
      search.filters.placeId,
      search.filters.from,
      search.filters.to
    ]
  );
  /*
   * 显示名查找：只是展示用途，不承担任何身份语义（范围身份用字符串签名比较），
   * 因此不做 memo，避免把每次渲染重建的派生数组当成稳定依赖。
   */
  const lightAgentLabels: ScopeLabels = {
    notebook: (notebookId: string) =>
      notebooks.find((notebook) => notebook.id === notebookId)?.title ?? notebookId,
    trip: (tripId: string) => tripOptions.find((trip) => trip.id === tripId)?.title ?? tripId,
    place: (placeId: string) => placeOptions.find((place) => place.id === placeId)?.name ?? placeId
  };
  const lightAgent = useLightAgent({
    ai: aiRepository,
    scope: lightAgentScope,
    /*
     * 计划输入里只广告「当前选定维度」的可选项：hook 只在发请求时读取它，
     * 因此不需要 memo（每次渲染重建对象即可，避免把可变的派生数组当成稳定依赖）。
     */
    allowedOptions: {
      regions: search.filters.regionId
        ? [
            {
              id: search.filters.regionId,
              label: findRegion(search.filters.regionId)?.name ?? search.filters.regionId
            }
          ]
        : [],
      trips: tripOptions.map((trip) => ({ id: trip.id, label: trip.title })),
      places: placeOptions.map((place) => ({ id: place.id, label: place.name }))
    },
    archive,
    media,
    loadArchive: () => notebookRepository.loadArchive(),
    enabled: true,
    onFlush: () => flushAutosave(),
    onOpenPage: (pageId) => {
      const page = archive.pages.find((item) => item.id === pageId);
      if (!page || isPageDeleted(page)) return false;
      openPage(page);
      return true;
    },
    onNotice: (text) => setNotice(text),
    callGateway: aiGatewayCaller
  });
  const lightAgentScopeLines = formatScopeSummary(lightAgentScope, lightAgentLabels);

  const buildOrganizeSessionRef = useRef<() => PageOrganizeSession | null>(() => null);  useEffect(() => {
    // 渲染期不读 ref；每次提交后把“如何构造会话快照”同步进 ref，事件回调读取最新一份。
    buildOrganizeSessionRef.current = () => {
      const draft = editDraftRef.current;
      return draft ? buildSessionSnapshot(draft) : null;
    };
  });
  /** 事件回调里构造会话快照（不在渲染期执行）。 */
  const readOrganizeSession = () => buildOrganizeSessionRef.current();

  /**
   * Q5：**所有会发模型请求的入口**共用同一处外发同意检查。
   *
   * 首次整理、错误后重试、以及“刷新后恢复预览再重新生成”都必须经过这里；
   * 不能用按钮文案或入口隐藏代替请求前的检查，也不因为已有旧建议就推断已同意。
   */
  const requestGenerate = () => {
    const session = readOrganizeSession();
    if (!session) return;
    setOrganizePanelCollapsed(false);
    if (!aiDisclosureAgreed) { setAiDisclosureOpen(true); return; }
    void organize.generate(session);
  };
  /** 入口按钮：未配置时只重新读取配置，不发模型请求。 */
  const requestOrganize = () => {
    if (organize.pending.length > 0 || organize.diff || organize.runInfo) {
      setOrganizePanelCollapsed(false);
      return;
    }
    if (organize.status === "config-missing") {
      setOrganizePanelCollapsed(false);
      void organize.reloadConfig();
      return;
    }
    requestGenerate();
  };

  /** 应用/提交：draft → 接受；accepted/accepting → 幂等继续提交。 */
  const requestApply = () => {
    const session = readOrganizeSession();
    if (session) void organize.apply(session);
  };
  const requestReject = () => {
    const session = readOrganizeSession();
    if (session) void organize.reject(session);
  };
  const requestWithdraw = () => {
    const session = readOrganizeSession();
    if (session) void organize.withdraw(session);
  };

  /**
   * P4：总结整本的**唯一**发请求入口。
   * 未配置时只重新读取配置；隐私许可由设置统一管理，服务端再次检查。
   */
  const requestAnalysis = () => {
    setAnalysisPanelCollapsed(false);
    if (analysis.status === "generating") return;
    if (analysis.status === "config-missing") {
      void analysis.reloadConfig();
      return;
    }
    if (!analysisDisclosureAgreed) { setAnalysisDisclosureOpen(true); return; }
    void analysis.generate();
  };


  /**
   * 篇容量计量（014-A）：图片 x/100、容量 y/500 MB。
   * 本轮调整：从编辑器底部移到「篇信息」面板展示；未编辑时按已存内容计量，
   * 编辑中仍按原语义（已存块 + 本轮新增待写入照片）。
   */
  const currentCapacity = useMemo(() => {
    const assetSizes: Record<string, number> = {};
    media.forEach((item) => {
      assetSizes[item.id] = item.size;
    });
    editDraft?.addedPhotos.forEach((photo) => {
      assetSizes[photo.id] = photo.size;
    });
    const page = editDraft
      ? archive.pages.find((item) => item.id === editDraft.pageId)
      : currentPage;
    return measurePageCapacity({
      page: {
        title: editDraft?.title ?? currentPage?.title ?? "",
        blocks: page?.blocks ?? [],
        source: page?.source ?? { kind: "manual" },
        capturedAt: page?.capturedAt ?? ""
      },
      assetSizes,
      limits: PAGE_CAPACITY_LIMITS
    });
  }, [archive.pages, currentPage, editDraft, media]);

  /**
   * 024 更新：可移动目标 = 其他**未删除**的笔记本。
   * 为空时不显示“移动”图标（只展示已实现且适用于当前篇的操作）。
   */
  const movableTargets = currentPage
    ? notebooks.filter((notebook) => notebook.id !== currentPage.notebookId)
    : [];

  /**
   * 列表「⋯ → 移动到其他笔记本」是否可用：当前本之外还有可移入的本。
   * 与上面工具栏移动入口同一判据；列表里所有篇都属于当前本，所以按 activeNotebookId 判断。
   */
  const hasOtherNotebooks = notebooks.some((notebook) => notebook.id !== activeNotebookId);

  /** 篇来源标签与只读判定（旧游记关联页不能直接编辑）。 */
  const currentIsLegacy = currentPage?.source.kind === "legacy-journal";

  /**
   * 021-B：右栏编辑表单体。
   * 结构＝标题输入 + 连续正文（默认 Markdown 所见即所得）+ “更多”（兼容模式与图片引用）。
   * 保存/取消/离开守卫沿用既有链，未另造。
   */
  const editFormBody = editDraft ? (
    <form
      className="notebook-edit"
      onSubmit={(event) => {
        event.preventDefault();
        // 024-A：表单提交也走统一保存协调（在途等待/续提交/失败可见），不绕行。
        void flushAutosave();
      }}
    >
      {/* 本轮调整：标题输入已上移到编辑栏顶部，表单体只保留正文与“更多”。 */}
      {editDraft.mode === "markdown" ? (
        <>
          <NotebookImageDeck
            key={editDraft.pageId}
            markdown={editDraft.markdown}
            mediaUrls={editorMediaUrls}
            pendingPhotos={editDraft.addedPhotos}
            onRemove={removeDraftImage}
          />
          {/* G3：原生按需读取状态条——未就绪引用的分态与显式重试（叠牌保持原占位）。 */}
          {onLoadMediaView && Object.keys(editorImageStates).length > 0 ? (
            <div className="nb-editor-image-status" role="group" aria-label="编辑器图片按需读取">
              {Object.entries(editorImageStates).map(([id, state]) => (
                <span key={id} className="nb-editor-image-status-item">
                  图片 {id}：{state === "loading" ? "原件读取中…" : state === "error" ? "读取失败" : "暂不可用"}
                  {state !== "loading" ? (
                    <button type="button" className="notebook-delete" onClick={() => retryEditorImage(id)}>重读</button>
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}
          <MarkdownJournalEditor
            toolbar="compact"
            markdown={editDraft.markdown}
            onChange={(markdown) => {
              updateEditDraft({
                ...(editDraftRef.current ?? editDraft),
                markdown
              });
              markDirty();
            }}
            /*
              原来这里写「可改用『文字与图片块』继续编辑」，但那个模式并不存在
              （唯一被赋值的 mode 是 "markdown"）。改为如实说明：报错不影响已输入内容。
            */
            onError={(message) => setError(`编辑器提示：${message}。已输入的内容仍保留在草稿里。`)}
            onUploadImage={uploadEditorImage}
            onInsertImages={insertImageFiles}
            resolveImageSource={resolveEditorImage}
          />
          {/* 本轮调整：底部关于 journal-photo 引用的实现说明已按反馈移除。 */}
        </>
      ) : null}
      {editDraft.addedPhotos.length > 0 ? (
        <ul className="notebook-edit-photos">
          {editDraft.addedPhotos.map((photo) => (
            <li key={photo.id}>
              <img src={photo.dataUrl} alt={photo.name} />
              <span>
                {photo.name} · {formatBytes(photo.size)} · 待写入
              </span>
              <button
                type="button"
                className="notebook-draft-remove"
                onClick={() => handleRemoveDraftPhoto(photo.id)}
                aria-label={`移除待保存图片 ${photo.name}`}
              >
                <Trash2 size={14} /> 移除
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {editWarnings.length > 0 ? (
        <ul className="notebook-edit-warnings" role="status">
          {editWarnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </form>
  ) : null;

  const pageList = (
    <section className="nb-col nb-col--pages" aria-label="篇列表">
      <NotebookPageList
        key={mobile ? activeNotebookId : undefined}
        mobile={mobile}
        onBackToNotebooks={mobile ? () => setMobileStage("notebooks") : undefined}
        onRename={mobile ? title => { if (activeNotebookId) void onUpdateNotebookTitle(activeNotebookId, title); } : undefined}
        onOpenInWorkbench={mobile && activeNotebookId && activeNotebookTitle && onOpenNotebookInWorkbench ? () => onOpenNotebookInWorkbench(activeNotebookId, activeNotebookTitle) : undefined}
        onCapture={() => setCaptureOpen(current => !current)}
        captureOpen={captureOpen}
        notebookTitle={notebooks.find((notebook) => notebook.id === activeNotebookId)?.title ?? ""}
        pages={pages}
        activePageId={currentPage?.id ?? ""}
        busy={busy}
        query={pageSearch}
        onQueryChange={setPageSearch}
        onSelect={openPage}
        onDelete={(page) => setDeletePrompt({ kind: "page", id: page.id, title: page.title })}
        onMove={hasOtherNotebooks ? (page) => openPage(page, { move: true }) : undefined}
        onCreate={() => void createBlankPage()}
        backClassName="nb-stage-back"
      />
      {!mobile ? <button
        type="button"
        className="nb-capture-toggle"
        aria-expanded={captureOpen}
        onClick={() => setCaptureOpen((current) => !current)}
      >
        <ImagePlus size={15} aria-hidden />
        {captureOpen ? "收起" : "从文字或图片新建"}
      </button> : null}
      {captureOpen ? <div className="nb-capture">{captureForm}</div> : null}
    </section>
  );


  const trashEntry = (
      <button
        ref={trashEntryRef}
        type="button"
        className={`${trashOpen ? "nb-trash-entry is-active" : "nb-trash-entry"}${mobile ? " nb-mobile-trash-entry" : ""}`}
        aria-expanded={trashOpen}
        aria-controls="nb-trash-panel"
        aria-label={`垃圾桶${
          trash.notebooks.length + trash.pages.length > 0
            ? `（${trash.notebooks.length + trash.pages.length}）`
            : ""
        }`}
        title="垃圾桶"
        onClick={() => setTrashOpen((current) => !current)}
      >
        <Trash2 size={17} />
        <span>垃圾桶</span>
        {trash.notebooks.length + trash.pages.length > 0 ? (
          <em>{trash.notebooks.length + trash.pages.length}</em>
        ) : null}
      </button>
  );

  const notebookList = (
    <nav className="nb-col nb-col--notebooks" aria-label="笔记本列表">
      <div
        className="nb-directory-resize"
        role="separator"
        aria-label="调整笔记目录宽度"
        aria-orientation="vertical"
        aria-valuemin={240}
        aria-valuemax={400}
        aria-valuenow={directoryWidth}
        tabIndex={0}
        title="拖动调整宽度，双击恢复默认"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          directoryDrag.current = { x: event.clientX, width: directoryWidth };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            resizeDirectory(directoryDrag.current.width + event.clientX - directoryDrag.current.x);
          }
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onDoubleClick={() => setDirectoryWidth(300)}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          resizeDirectory(event.key === "Home" ? 240 : event.key === "End" ? 400 : directoryWidth + (event.key === "ArrowRight" ? 10 : -10));
        }}
      />
      <button
        type="button"
        className="nb-rail-toggle nb-icon-button"
        aria-label="展开笔记本目录"
        title="展开笔记本目录"
        aria-expanded={false}
        onClick={() => setNotebooksCollapsed(false)}
      >
        {/*
          图标用书本而不是面板符号：两个目录栏都收起时，栏目里若都是同一个
          面板图标就分不清哪条是哪条。书本与全站导航里「笔记本」的图标一致。
        */}
        <BookOpen size={18} />
      </button>
      <NotebookList
        mobile={mobile}
        mobileFooter={mobile ? trashEntry : undefined}
        onCreatePage={() => void createBlankPage()}
        renderPages={mobile ? undefined : () => pageList}
        notebooks={notebooks}
        activeNotebookId={activeNotebookId}
        pageCounts={pageCounts}
        busy={busy}
        onSelect={switchNotebook}
        searchOpen={workPanel === "search"}
        onSearch={() => {
          setSearchPanelCollapsed(false);
          if (workPanel !== "search") setSearchReturnStage(mobileStage === "pages" ? "pages" : "notebooks");
          openToolPanel("search");
          setMobileStage(workPanel === "search" ? searchReturnStage : "editor");
        }}
        onCollapse={() => setNotebooksCollapsed(true)}
        onRenameActive={(title) => {
          if (!activeNotebookId) return;
          void onUpdateNotebookTitle(activeNotebookId, title);
        }}
        onAnalyze={(notebook) => {
          analysisOpenerRef.current = document.activeElement as HTMLElement;
          setInfoOpen(false);
          setMoveOpen(false);
          setWorkPanel(null);
          switchNotebook(notebook.id, () => {
            setAnalysisPanelCollapsed(false);
            setAnalysisModalOpen(true);
          });
        }}
        onDelete={(notebook) =>
          setDeletePrompt({
            kind: "notebook",
            id: notebook.id,
            title: notebook.title,
            pageCount: listActiveNotebookPages(archive, notebook.id).length
          })
        }
        onOpenInWorkbench={
          activeNotebookId && activeNotebookTitle
            ? () => onOpenNotebookInWorkbench?.(activeNotebookId, activeNotebookTitle)
            : undefined
        }
        onCreate={() => {
          const seq = ++switchSeqRef.current;
          void leaveWithAutosave(() => {
            if (seq !== switchSeqRef.current) return;
            void onAddNotebook("新的笔记本").then((created) => {
              if (seq !== switchSeqRef.current) return;
              updateEditDraft(undefined);
              setSelectedNotebookId(created.id);
              setSelectedPageId("");
              // 新本已出现在当前列表，保留手机列表上下文。
              setMobileStage("notebooks");
            }).catch((createError: unknown) => {
              setError(createError instanceof Error ? `新建笔记本失败：${createError.message}` : "新建笔记本失败，请重试。");
            });
          });
        }}
      />
      {!mobile ? trashEntry : null}
    </nav>
  );

  /** 024：垃圾桶面板（删除本 + 独立删除页；本内页不重复列）。 */
  const trashPanel = trashOpen ? (
    <section className="nb-trash" id="nb-trash-panel" aria-label="垃圾桶">
      <header className={`nb-col-head${mobile ? " nb-trash-mobile-head" : ""}`}>
        {mobile ? (
          <>
            <button type="button" className="nb-mobile-back" aria-label="返回笔记本列表" onClick={closeTrash}>
              <ChevronRight size={21} className="nb-icon-back" aria-hidden="true" />
              <span>笔记本</span>
            </button>
            <h2>垃圾桶</h2>
          </>
        ) : (
          <>
            <strong>垃圾桶</strong>
            <button type="button" className="nb-icon-button" aria-label="关闭垃圾桶" onClick={closeTrash}>
              <X size={16} />
            </button>
          </>
        )}
      </header>
      <p className="nb-trash-note">
        {trashAutoCleanup ? "删除满 30 天后自动清理；永久删除不可撤销。" : "自动清理未开启，可恢复或手动永久删除。"}
      </p>
      {onTrashAutoCleanupChange ? (
        <button type="button" className="secondary-button" disabled={busy}
          onClick={() => trashAutoCleanup ? void changeTrashAutoCleanup(false) : setTrashCleanupPrompt(true)}>
          {trashAutoCleanup ? "关闭自动清理" : "开启 30 天自动清理"}
        </button>
      ) : null}
      {trash.notebooks.length + trash.pages.length === 0 ? (
        <p className="nb-empty">垃圾桶是空的。</p>
      ) : (
        <ul className="nb-trash-list">
          {trash.notebooks.map((entry) => (
            <li key={entry.notebook.id}>
              <div>
                <strong>《{entry.notebook.title}》</strong>
                <small>
                  笔记本 · {entry.activePageCount} 篇活动页
                  {entry.separatelyDeletedPageCount > 0
                    ? ` · ${entry.separatelyDeletedPageCount} 篇此前单独删除`
                    : ""}
                  {entry.expired ? " · 已过期" : ""}
                </small>
              </div>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => void restoreFromTrash({ kind: "notebook", id: entry.notebook.id })}
              >
                恢复
              </button>
              <button
                type="button"
                className="notebook-delete"
                disabled={busy}
                onClick={() =>
                  setPurgePrompt({
                    kind: "item",
                    label: `笔记本《${entry.notebook.title}》及其仍在其中的页`,
                    targets: [
                      { kind: "notebook", id: entry.notebook.id, deletedAt: entry.deletedAt }
                    ]
                  })
                }
              >
                永久删除
              </button>
            </li>
          ))}
          {trash.pages.map((entry) => (
            <li key={entry.page.id}>
              <div>
                <strong>{entry.page.title}</strong>
                <small>
                  笔记 ·{" "}
                  {entry.originalNotebookValid ? "原归属仍有效" : "原归属不可用，需选择目标本"}
                  {entry.expired ? " · 已过期" : ""}
                </small>
              </div>
              {restoreTarget?.pageId === entry.page.id ? (
                <select
                  className="nb-trash-target"
                  aria-label="恢复到哪个笔记本"
                  value=""
                  onChange={(event) => {
                    if (!event.target.value) return;
                    void restoreFromTrash({
                      kind: "page",
                      id: entry.page.id,
                      targetNotebookId: event.target.value
                    });
                  }}
                >
                  <option value="">选择目标笔记本…</option>
                  {notebooks.map((notebook) => (
                    <option key={notebook.id} value={notebook.id}>
                      {notebook.title}
                    </option>
                  ))}
                </select>
              ) : (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void restoreFromTrash({ kind: "page", id: entry.page.id })}
                >
                  恢复
                </button>
              )}
              <button
                type="button"
                className="notebook-delete"
                disabled={busy}
                onClick={() =>
                  setPurgePrompt({
                    kind: "item",
                    label: `笔记《${entry.page.title}》`,
                    targets: [{ kind: "page", id: entry.page.id, deletedAt: entry.deletedAt }]
                  })
                }
              >
                永久删除
              </button>
            </li>
          ))}
        </ul>
      )}
      {trash.notebooks.length + trash.pages.length > 0 ? (
        <button
          type="button"
          className="notebook-delete nb-trash-empty"
          disabled={busy}
          onClick={() =>
            setPurgePrompt({
              kind: "all",
              label: `垃圾桶里全部 ${trash.notebooks.length + trash.pages.length} 项`,
              // 冻结目标 ID 与删除标记：执行时重新核对，之后新增的条目不在本次范围。
              targets: freezeAllTrashTargets()
            })
          }
        >
          清空垃圾桶（{trash.notebooks.length + trash.pages.length}）
        </button>
      ) : null}
    </section>
  ) : null;


  const editorPane = (
    <section
      className="nb-col nb-col--editor"
      aria-label="正文编辑"
      /*
       * 未选中具体篇时右栏只留水印：功能面板与编辑框都收起（见 notebook.css
       * 的 .nb-col--editor[data-has-page="false"]）。用属性 + CSS 而不是条件渲染，
       * 是为了让面板保持挂载——它们的展开状态与挂载时的恢复扫描都不该被反复重置。
       */
      data-has-page={currentPage ? "true" : "false"}
    >
      <header className="nb-editor-bar">
        {mobileStage === "editor" ? (
          <button
            type="button"
            className={`nb-icon-button nb-stage-back${mobile ? " nb-mobile-back" : ""}`}
            aria-label={mobile ? (workPanel === "search" && searchReturnStage === "notebooks" ? "返回笔记本列表" : "返回笔记列表") : "返回笔记本目录"}
            onClick={() => { if (workPanel === "search") { setWorkPanel(null); setMobileStage(searchReturnStage); } else setMobileStage(mobile ? "pages" : "notebooks"); }}
          >
            <ChevronRight size={18} className="nb-icon-back" />
            {mobile ? <span>{workPanel === "search" && searchReturnStage === "notebooks" ? "笔记本" : "笔记"}</span> : null}
          </button>
        ) : null}
        {/*
          本轮调整：标题直接在顶部编辑（原先顶栏只有静态标题，
          下方另有独立标题输入框，两处重复且占编辑区纵向空间）。
          onChange 与原独立输入框完全一致：写入草稿并标记 dirty，保存链不变。
        */}
        {editDraft ? (
          <input
            className="nb-editor-title nb-editor-title-input"
            type="text"
            value={editDraft.title}
            placeholder="标题"
            aria-label="笔记标题"
            readOnly={organize.status === "applying"}
            aria-busy={organize.status === "applying"}
            onChange={(event) => {
              updateEditDraft({
                ...(editDraftRef.current ?? editDraft),
                title: event.target.value
              });
              markDirty();
            }}
          />
        ) : (
          <strong className={`nb-editor-title${currentPage ? "" : " ui-secondary-copy"}`}>
            {currentPage?.title || "未选择篇"}
          </strong>
        )}
        {/*
          024-B：状态只反映真实写入结果；日常不再放大保存按钮，
          只留一个图标（失败/冲突时图标变成重试提示）。
        */}
        <span className="notebook-save-state" aria-live="polite" data-status={autoStatus}>
          {/*
            只看 autoStatus，不再叠加页面级 busy：busy 也被删除/移动/恢复/新建等
            与保存无关的操作置位，叠加后会在这些操作期间谎称「保存中…」。
            真正保存时保存链自己会把 autoStatus 置为 saving。
          */}
          {autoStatus === "saving"
            ? "保存中…"
            : autoStatus === "conflict"
              ? "冲突"
              : autoStatus === "failed"
                ? "保存失败"
                : autoStatus === "dirty"
                  ? "未保存"
                  : editDraft
                    ? "已保存"
                    : savedNotice}
        </span>
        {editDraft ? (
          <button
            type="button"
            className="nb-icon-button nb-autosave-flush"
            aria-label={
              autoStatus === "failed" || autoStatus === "conflict" ? "重试保存" : "立即保存"
            }
            title={autoStatus === "failed" || autoStatus === "conflict" ? "重试保存" : "立即保存"}
            disabled={busy || autoStatus === "saving"}
            onClick={() => void flushAutosave()}
          >
            {autoStatus === "failed" || autoStatus === "conflict" ? (
              <RotateCcw size={17} />
            ) : (
              <Check size={17} />
            )}
          </button>
        ) : null}
        <div className="nb-editor-actions" role="group" aria-label="笔记操作">
          {/* 带当前这一篇的范围进入 AI 工作台（笔记本/笔记两级各一个入口，不重复）。 */}
          {currentPage && onOpenNoteInWorkbench ? (
            <button
              type="button"
              className="nb-icon-button"
              data-testid="open-note-in-workbench"
              aria-label={`在 AI 工作台中打开笔记：${currentPage.title}`}
              title="在 AI 工作台中打开这篇笔记"
              onClick={() =>
                onOpenNoteInWorkbench({
                  notebookId: currentPage.notebookId,
                  notebookTitle:
                    notebooks.find((notebook) => notebook.id === currentPage.notebookId)?.title ?? "",
                  noteId: currentPage.id,
                  noteTitle: currentPage.title
                })
              }
            >
              <MessageSquare size={17} aria-hidden />
            </button>
          ) : null}
          {/*
            P2-01：当前篇工具栏的「整理这篇」入口。
            只在可编辑的本地篇出现；整理中/应用中/保存未完成时禁用并给出原因，
            点击先给出外发告知（首次），未同意不发任何模型请求。
          */}
          {editDraft && aiTarget && !currentIsLegacy ? (
            <button
              type="button"
              className="nb-icon-button nb-organize-open"
              data-testid="organize-open"
              aria-label="AI 整理这篇正文"
              aria-expanded={!organizePanelCollapsed}
              title={
                aiTarget.blocks.every((block) => block.type !== "text")
                  ? "这一篇还没有文字块"
                  : organize.status === "config-missing"
                    ? "模型尚未配置（打开查看说明）"
                    : "AI 整理这篇（只改正文）"
              }
              disabled={
                organize.status === "generating" ||
                organize.status === "applying" ||
                autoStatus === "saving" ||
                aiTarget.blocks.every((block) => block.type !== "text")
              }
              onClick={requestOrganize}
            >
              <Sparkles size={17} />
            </button>
          ) : null}
          {/* 地区是篇工具；整本分析从笔记本行右侧菜单打开。 */}
          {currentPage ? (
            <button
              type="button"
              className="nb-icon-button"
              data-testid="regions-open"
              aria-label="选择地区"
              title="选择地区（选择笔记所属的省份与城市）"
              aria-expanded={workPanel === "regions"}
              onClick={() => openToolPanel("regions")}
            >
              <MapPin size={17} />
            </button>
          ) : null}
          {/* 取消编辑按钮按用户要求移除（草稿由自动保存与切篇协调处理）。 */}
          {/*
            024 更新：去掉「篇信息」「更多操作」两层折叠入口，
            改成工具栏上的独立小图标——只显示已实现且适用于当前篇的操作：
            - 信息：打开轻量面板（来源/时间/地区）；
            - 移动：当前本之外还有可移动目标时才出现，点击直接进入移动面板；
            - 删除：移入垃圾桶（可恢复）；
            - 旧游记关联页只读，不显示移动/删除。
          */}
          {currentIsLegacy ? (
            <span className="nb-toolbar-note">旧游记关联页：只读</span>
          ) : (
            <>
              {/*
                篇信息面板本身以 currentPage 为条件渲染（见下方 nb-page-info），
                因此没有选中篇时必须一起隐藏这个图标——否则点下去什么都不发生。
              */}
              {currentPage ? (
                <button
                  type="button"
                  className="nb-icon-button"
                  aria-label="笔记信息"
                  title="笔记信息（来源、时间、容量）"
                  aria-expanded={infoOpen}
                  aria-controls="nb-page-info"
                  onClick={() => {
                    setInfoOpen((current) => !current);
                    setMoveOpen(false);
                    setWorkPanel(null);
                  }}
                >
                  <Info size={17} />
                </button>
              ) : null}
              {currentPage && movableTargets.length > 0 ? (
                <button
                  type="button"
                  className="nb-icon-button"
                  aria-label="移动到其他笔记本"
                  title="移动到其他笔记本"
                  aria-expanded={moveOpen}
                  aria-controls="nb-page-move"
                  onClick={() => {
                    setMoveOpen((current) => !current);
                    setInfoOpen(false);
                    setWorkPanel(null);
                  }}
                >
                  <MoveRight size={17} />
                </button>
              ) : null}
              {/* 删除笔记按钮按用户要求移除；删除改由笔记目录的「⋯」气泡菜单提供。 */}
            </>
          )}
        </div>
      </header>
      {/*
        编辑列的下半部分：内容区与右侧工作面板并排，面板不再覆盖工具栏。
      */}
      <div className="nb-editor-main">
        <div className="nb-editor-content">

      {/*
        P2-02：编辑区**上方**的内联整理预览（不新增主导航或设置页）。
        可用动作由建议的**持久化状态**决定（draft/accepted/accepting/applied），
        因此刷新后恢复的建议同样有明确、有效的后续动作。
      */}
      {editDraft && aiTarget && !currentIsLegacy && !organizePanelCollapsed ? (
        <PageOrganizePanel
          status={organize.status}
          message={organize.message}
          pageTitle={aiTarget.title}
          proposalStatus={organize.proposal?.status}
          taskStatus={organize.task?.status}
          diff={organize.diff}
          actions={
            organize.proposal
              ? runActionsFor(organize.proposal, {
                  hasTask: Boolean(organize.task),
                  targetUsable: true
                })
              : []
          }
          busy={busy || organize.status === "applying"}
          collapsed={organizePanelCollapsed}
          onToggleCollapsed={() => setOrganizePanelCollapsed((current) => !current)}
          onApply={requestApply}
          onReject={requestReject}
          onWithdraw={requestWithdraw}
          onRegenerate={requestGenerate}
          onCancel={() => void organize.cancel()}
          onReloadConfig={() => void organize.reloadConfig()}
          onDismiss={() => {
            if (organize.status === "generating" || organize.status === "applying") {
              void organize.cancel();
              return;
            }
            setOrganizePanelCollapsed(true);
          }}
          pending={organize.pending}
          onResume={(proposalId) => {
            setOrganizePanelCollapsed(false);
            organize.resume(proposalId);
          }}
          runInfo={organize.runInfo}
        />
      ) : null}
      {currentPage && moveOpen && movableTargets.length > 0 ? (
        <div ref={movePanelRef} className="nb-page-menu" id="nb-page-move">
          <div className="notebook-move">
            <label htmlFor={`move-${currentPage.id}`}>移动《{currentPage.title}》到</label>
            <select
              id={`move-${currentPage.id}`}
              value={moveTargets[currentPage.id] ?? ""}
              onChange={(event) =>
                setMoveTargets((current) => ({
                  ...current,
                  [currentPage.id]: event.target.value
                }))
              }
            >
              <option value="">选择目标…</option>
              {movableTargets.map((notebook) => (
                <option key={notebook.id} value={notebook.id}>
                  {notebook.title}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="primary-button"
              disabled={busy || !moveTargets[currentPage.id]}
              onClick={() => {
                setMoveOpen(false);
                void handleMove(currentPage);
              }}
              aria-label={`确认移动笔记 ${currentPage.title}`}
            >
              移动
            </button>
          </div>
        </div>
      ) : null}

      {currentPage && infoOpen ? (
        <div ref={infoPanelRef} className="nb-page-info" id="nb-page-info">
          <p className="notebook-readonly">
            来源：{pageSourceLabel(currentPage)} · 记录时间 {currentPage.capturedAt.slice(0, 10)}
          </p>
          <p className="notebook-readonly">
            旅行日期：{effectiveDate ? formatTripDateRange(effectiveDate) : "未设置"}
          </p>
          {/* 本轮调整：容量指示从编辑器底部移到这里。 */}
          <p className="notebook-readonly" aria-live="polite" data-testid="page-capacity">
            {formatCapacityCounters(currentCapacity)}
          </p>
        </div>
      ) : null}


        {editDraft ? (
          <div
            className={
              organize.status === "applying" ? "nb-edit-window is-locked" : "nb-edit-window"
            }
            aria-busy={organize.status === "applying"}
            inert={organize.status === "applying"}
          >
            {editFormBody}
          </div>
        ) : currentPage ? (
          <div className="nb-readonly-pane">
            {currentPage.blocks.map((block) =>
              block.type === "text" ? (
                <p key={block.id}>{block.text}</p>
              ) : block.type === "unsupported-image" ? (
                <p key={block.id} className="notebook-unsupported-image">
                  未支持的图片源（原样保留，不下载）：{block.markdown}
                </p>
              ) : (
                <figure key={block.id}>
                  <NotebookPhoto
                    mediaId={block.mediaId}
                    caption={block.caption}
                    width={block.width}
                    height={block.height}
                    mediaUrls={mediaUrls}
                    load={onLoadMediaView}
                  />
                  <figcaption>{block.caption}</figcaption>
                </figure>
              )
            )}
            {currentIsLegacy ? (
              <div className="notebook-legacy-photos">
                {extractLegacyPhotoIds(pageText(currentPage)).map((photoId) => {
                  const mediaItem = media.find(
                    (item) =>
                      item.origin.kind === "legacy-journal-photo" &&
                      item.origin.photoId === photoId &&
                      item.origin.spotId ===
                        (currentPage.source.kind === "legacy-journal"
                          ? currentPage.source.spotId
                          : "")
                  );
                  return (
                    <span key={photoId} className="notebook-missing-photo">
                      关联查看不复制图片：{photoId}
                      {mediaItem ? "（已复制到独立页）" : ""}
                    </span>
                  );
                })}
              </div>
            ) : null}
            {currentIsLegacy ? null : (
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => beginEdit(currentPage)}
              >
                <Pencil size={15} /> 编辑这一篇
              </button>
            )}
          </div>
        ) : (
          <div className="nb-readonly-pane nb-watermark-pane">
            <p className="nb-watermark" title={notebooks.length === 0
              ? "点击左侧目录的 + 新建笔记本。"
              : pages.length === 0
                ? "点击笔记本下方的 + 新建笔记。"
                : "在左侧目录中选择笔记。"}>{notebooks.length === 0 ? "新建第一本笔记" : "选择一篇笔记"}</p>
            <p className="nb-empty ui-secondary-copy">
              {notebooks.length === 0
                ? "点击左侧目录的 + 新建笔记本。"
                : pages.length === 0
                  ? "点击笔记本下方的 + 新建笔记。"
                  : "在左侧目录中选择笔记。"}
            </p>
          </div>
        )}

        </div>

      {workPanel ? (
                <aside
                  ref={workPanelRef}
                  className="nb-work-panel"
                  data-testid="nb-work-panel"
                  data-panel={workPanel}
                  aria-label={workPanel === "regions" ? "选择地区" : "搜索笔记"}
                >
                  {workPanel === "search" ? (
        <NotebookSearchPanel
          semantic={isSemanticSearchEnabled() && <SemanticSearchPanel archive={archive} filters={search.filters} ai={aiRepository} loadArchive={() => notebookRepository.loadArchive()} onFlush={() => flushAutosave()} openSource={search.openSource} />}
          agent={
            <LightAgentPanel
              agent={lightAgent}
              labels={lightAgentLabels}
              collapsed={agentPanelCollapsed}
              onToggleCollapsed={() => setAgentPanelCollapsed((current) => !current)}
              onDismiss={() => setAgentPanelCollapsed(true)}
              pageTitle={(pageId) => archive.pages.find((item) => item.id === pageId)?.title ?? pageId}
              onOpenSource={(pageId) => void lightAgent.openSource(pageId)}
              onDiscard={(proposalId) => void lightAgent.discard(proposalId)}
              onResume={(proposalId) => {
                setAgentPanelCollapsed(false);
                lightAgent.resume(proposalId);
              }}
            />
          }
          search={search}
          notebooks={visibleNotebooks}
          tripOptions={tripOptions}
          placeOptions={placeOptions}
          notebookTitle={(notebookId) =>
            notebooks.find((notebook) => notebook.id === notebookId)?.title ?? notebookId
          }
          collapsed={searchPanelCollapsed}
          onToggleCollapsed={() => setSearchPanelCollapsed((current) => !current)}
          onDismiss={() => { setWorkPanel(null); setMobileStage(searchReturnStage); }}
        />
          ) : workPanel === "regions" ? (
        <>
      {currentPage && !currentIsLegacy ? (
        <div className="nb-regions-section">
          <header className="nb-popover-head">
            <strong>地区</strong>
            <div className="nb-region-heading-actions">
              {regionSaving ? <Loader2 size={14} className="is-spinning" role="status" aria-label="保存中" /> : null}
              <button type="button" className={`nb-icon-button nb-trip-date-trigger${tripDateVisible || tripDateDraft.value ? " is-set" : ""}`}
                aria-label="旅行日期" title="旅行日期" aria-haspopup="dialog" aria-expanded={tripDateVisible} aria-controls={tripDatePopoverId}
                onClick={event => { event.currentTarget.focus({ preventScroll: true }); setTripDateOpen(open => !open); }}>
                <CalendarDays size={16} aria-hidden />
              </button>
              {tripDateVisible ? createPortal(
                <div className="nb-trip-date-layer">
                  <div ref={tripDatePopoverRef} id={tripDatePopoverId} className="nb-trip-date-popover" role="dialog" aria-labelledby={`${tripDatePopoverId}-title`} tabIndex={-1}>
                    <fieldset className="nb-trip-date-fields" data-testid="trip-date" disabled={busy || regionSaving}>
                      <div className="nb-trip-date-head">
                        <strong id={`${tripDatePopoverId}-title`}>旅行日期</strong>
                        <button type="button" className="nb-icon-button" aria-label="清除日期" title="清除日期" disabled={!tripDateDraft.value && !effectiveDate} onClick={clearTripDate}><Trash2 size={16} aria-hidden /></button>
                      </div>
                      <div className="nb-trip-date-row">
                        <span className="nb-trip-date-precision">
                          <select aria-label="日期精度" value={tripDateDraft.precision} onChange={event => {
                            const precision = event.target.value as TripDateRange["precision"];
                            const length = precision === "day" ? 10 : precision === "month" ? 7 : 4;
                            const value = tripDateDraft.value.length >= length ? tripDateDraft.value.slice(0, length) : "";
                            changeTripDate({ precision, value, toValue: precision === "day" ? tripDateDraft.toValue : "" });
                          }}>
                            <option value="day">日</option>
                            <option value="month">月</option>
                            {tripDateDraft.precision === "year" ? <option value="year">年</option> : null}
                          </select>
                        </span>
                        <input aria-label="旅行日期" type={tripDateDraft.precision === "year" ? "number" : tripDateDraft.precision === "month" ? "month" : "date"} value={tripDateDraft.value} onChange={event => changeTripDate({ ...tripDateDraft, value: event.target.value })} />
                      </div>
                      {tripDateDraft.precision === "day" ? (
                        <details className="nb-trip-date-range" open={Boolean(tripDateDraft.toValue)}>
                          <summary>结束日期</summary>
                          <input type="date" aria-label="结束日期（可选）" min={tripDateDraft.value || undefined} value={tripDateDraft.toValue} onChange={event => changeTripDate({ ...tripDateDraft, toValue: event.target.value })} />
                        </details>
                      ) : null}
                      {parsedTripDate && "error" in parsedTripDate ? <p className="notebook-error" role="alert">{parsedTripDate.error}</p> : null}
                    </fieldset>
                  </div>
                </div>, document.body
              ) : null}
              <span className="nb-region-photo-action" ref={setPhotoLocationActionSlot} />
              <button type="button" className="nb-icon-button" title="关闭地区选择" disabled={busy || regionSaving} aria-label="关闭地区选择" onClick={() => { setWorkPanel(null); setRegionSaving(false); }}><X size={16} aria-hidden /></button>
            </div>
          </header>
          <PageRegionsSelect
            key={currentPage.id}
            pageId={currentPage.id}
            regions={findTripJournal(archive, currentPage.id)?.regions ?? []}
            draftRegionIds={regionDraftIds ?? undefined}
            onDraftChange={ids => { setRegionDraftIds(ids); setRegionSaveSignal(signal => signal + 1); }}
            revision={archive.revision}
            busy={busy}
            saveSignal={regionSaveSignal}
            onSavingChange={setRegionSaving}
            onRetry={() => setRegionSaveSignal(signal => signal + 1)}
            onSaved={(count) =>
              setNotice(`地区关联已保存（${count} 个）`)
            }
            onSave={async (regionIds, expectedRevision) => {
              if (!onRegionsChange) return { ok: false, message: "当前环境不支持修改地区。" };
              // P2（N19）：捕获发起时的页面 ID 与待办快照。回调用
              // currentPageIdRef（切篇 effect 实时更新）判断归属：
              // - 切篇后返回（ref ≠ savedPageId）→ 不动任何待办；
              // - 同篇期间新增操作 → 只移除快照中的条目（Set diff）。
              const savedPageId = currentPage.id;
              const sourcesSnapshot = pendingRegionSources;
              const tripDateOption =
                tripDateTouched && parsedTripDate && !("error" in parsedTripDate)
                  ? parsedTripDate
                  : tripDateTouched
                    ? null
                    : undefined;
              if (tripDateTouched && parsedTripDate && "error" in parsedTripDate) {
                return { ok: false, message: `旅行日期未保存：${parsedTripDate.error}` };
              }
              const options = {
                // 来源记录随地区保存，日期不改变既有照片来源。
                add: sourcesSnapshot,
                manualReaffirm: false,
                tripDateRange: tripDateOption
              };
              let outcome = await onRegionsChange(currentPage.id, regionIds, expectedRevision, options);
              // N9（P1 收紧）：只有该篇地区元数据自打开面板以来未被改动时，
              // 冲突才可能来自正文自动保存等字段不相交的写入——按最新档案
              // revision 重试一次。元数据真的变了（其他实例/操作保存了地区
              // 或日期等字段）→ 保留草稿并提示，不取消版本限制强行覆盖。
              if (!outcome.ok && outcome.message?.includes("REVISION_CONFLICT")) {
                const baseline = regionPanelBaselineRef.current;
                const latest = await notebookRepository
                  .loadArchive()
                  .catch(() => null);
                if (latest && baseline && baseline.pageId === currentPage.id) {
                  if (tripJournalMetaSignature(latest, currentPage.id) === baseline.signature) {
                    outcome = await onRegionsChange(
                      currentPage.id,
                      regionIds,
                      latest.revision,
                      options
                    );
                  } else {
                    outcome = {
                      ok: false,
                      message:
                        "保存期间该篇的地区信息被其他操作修改，草稿已保留；请核对后重新保存。"
                    };
                  }
                }
                // 读不到最新档案或没有基线：保守不重试，保留原冲突提示。
              }
              if (outcome.ok) {
                // P2（N19）：切篇后返回（ref ≠ savedPageId）→ 不动任何待办。
                if (currentPageIdRef.current !== savedPageId) return outcome;
                // 同篇：只移除快照中的条目（Set diff），保存期间新增的保留。
                const srcToRemove = new Set(sourcesSnapshot.map((item) => item.id));
                setPendingRegionSources((current) =>
                  current.filter((item) => !srcToRemove.has(item.id))
                );
                // 只接纳本次事务返回的基线。保存后重读档案可能已经包含他人
                // 的下一次写入，不能把它当作自己的保存结果允许旧草稿覆盖。
                regionPanelBaselineRef.current = outcome.metaSignature === undefined
                  ? null
                  : { pageId: savedPageId, signature: outcome.metaSignature };
              }
              return outcome;
            }}
          />
          {notebookRepository ? (
            <PagePhotoLocation
              page={currentPage}
              repository={notebookRepository}
              actionSlot={photoLocationActionSlot}
              disabled={busy || regionSaving}
              draftRegionIds={regionDraftIds ?? regionsOf(currentPage.id)}
              onAddRegion={(regionId, contribution) => {
                // 函数式更新保留同一渲染期间依次确认的所有地区。
                const target = canonicalRegionId(regionId);
                setRegionDraftIds((current) => {
                  const base = current ?? regionsOf(currentPage.id);
                  return base.some((id) => canonicalRegionId(id) === target)
                    ? base
                    : [...base, regionId];
                });
                // 来源贡献（photo-confirm/rule）：hadPrior = 记录时该地区已存在
                // 已存关联（手动/历史）→ 撤销贡献不删除关联（保守）。
                if (contribution && contribution.mediaIds.length > 0) {
                  const saved = regionsOf(currentPage.id);
                  setPendingRegionSources((existing) => [
                    ...existing.filter(
                      (item) => !(item.regionId === target && item.kind === contribution.kind)
                    ),
                    {
                      id: nextRegionSourceId(),
                      regionId: target,
                      kind: contribution.kind,
                      mediaIds: contribution.mediaIds,
                      at: new Date().toISOString(),
                      hadPriorAssociation: saved.some((id) => canonicalRegionId(id) === target)
                    }
                  ]);
                }
                setRegionSaveSignal(signal => signal + 1);
              }}
            />
          ) : null}
          {currentPage ? (
            <PageRegionSources
              views={regionSourceViews}
              mediaNames={mediaNamesById}
              onRemoveRegion={removeRegion}
              disabled={busy || regionSaving}
            />
          ) : null}
        </div>
      ) : null}

        </>
          ) : null}
                </aside>
              ) : null}
      </div>
    </section>
  );

  return (
    <section className="notebook-page" data-mobile-layout={mobile} aria-labelledby="notebook-heading">
      {analysisModalOpen && activeNotebookTitle ? (
        <div className="nb-analysis-modal-layer">
          <button
            type="button"
            className="nb-analysis-modal-scrim"
            aria-label="点击空白处关闭总结整本"
            onClick={closeAnalysisModal}
          />
          <div
            ref={analysisModalRef}
            className="nb-analysis-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`总结整本：${activeNotebookTitle}`}
            data-testid="analysis-modal"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeAnalysisModal();
                return;
              }
              if (event.key !== "Tab") return;
              const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>(
                "button:not([disabled])"
              );
              const first = buttons[0];
              const last = buttons[buttons.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }}
          >
            <NotebookAnalysisPanel
              notebookTitle={activeNotebookTitle}
              status={analysis.status}
              message={analysis.message}
              result={analysis.result}
              viewState={analysis.viewState}
              coverage={analysis.coverage}
              recovered={analysis.recovered}
              runInfo={analysis.runInfo}
              collapsed={analysisPanelCollapsed}
              onToggleCollapsed={() => setAnalysisPanelCollapsed((current) => !current)}
              onGenerate={requestAnalysis}
              onCancel={() => void analysis.cancel()}
              onReloadConfig={() => void analysis.reloadConfig()}
              onDismiss={closeAnalysisModal}
              onResume={(proposalId) => {
                setAnalysisPanelCollapsed(false);
                analysis.resume(proposalId);
              }}
              onOpenSource={(pageId) => {
                void analysis.openSource(pageId).then((opened) => {
                  if (opened) setAnalysisModalOpen(false);
                });
              }}
              pageTitle={(pageId) =>
                archive.pages.find((item) => item.id === pageId)?.title ?? pageId
              }
            />
          </div>
        </div>
      ) : null}
      <NotebookDialog open={aiDisclosureOpen} title="整理这篇笔记？" confirmLabel="确认发送并整理" cancelLabel="取消" onCancel={() => setAiDisclosureOpen(false)} onConfirm={() => { setAiDisclosureAgreed(true); setAiDisclosureOpen(false); const session = readOrganizeSession(); if (session) void organize.generate(session); }}>
        <p>将这篇笔记的正文、标题、日期、地区和图片说明发送给模型，不发送图片原文件或其他笔记。整理结果确认后才会保存。</p>
      </NotebookDialog>
      <NotebookDialog open={analysisDisclosureOpen} title="总结整本笔记？" confirmLabel="确认发送并总结" cancelLabel="取消" onCancel={() => setAnalysisDisclosureOpen(false)} onConfirm={() => { setAnalysisDisclosureAgreed(true); setAnalysisDisclosureOpen(false); void analysis.generate(); }}>
        <p>将《{activeNotebookTitle}》中可见笔记的正文、标题、日期、地区和图片说明发送给模型，不发送图片原文件。总结不会修改原笔记。</p>
      </NotebookDialog>
      {/*
        024 更新：删除确认统一为覆盖式居中 dialog（不占页面高度、不推挤工作区）。
        「移入垃圾桶」用普通语气并说明可恢复；永久删除单独用 danger 语气。
      */}


      {/*
        P5：单篇主题标签生成前的独立外发告知（与整理、总结整本各自独立）。
      */}
      <NotebookDialog
        open={Boolean(search.pendingMetadataPageId)}
        title="确认发送这篇笔记以生成标签？"
        confirmLabel="同意并生成"
        cancelLabel="暂不"
        onCancel={search.cancelMetadataRequest}
        onConfirm={() => void search.confirmMetadata()}
      >
        <p>发送到你配置的模型：</p>
        <ul>
          <li>这一篇的正文文字块（完整内容，不做截断）；</li>
          <li>篇标题、记录时间与已关联的地区名；</li>
          <li>图片的说明文字（如有）。</li>
        </ul>
        <p className="nb-dialog-note">
          只写 AI 独立库里的主题标签与摘要，不改动正文、图片或笔记本结构；一次只处理你点选的这一篇，
          不会后台整库调用模型。删除 AI 库后关键词检索照常可用，只是主题筛选不可用。
        </p>
      </NotebookDialog>

      {/*
        P8：「整理检索结果」的**独立**外发告知。它发送的内容与单篇整理、总结整本都不同
        （两次请求：计划只发目标与范围；综合发检索标题摘要与实际读取的完整正文），
        因此不复用其它同意；同样只记在当前应用会话，刷新后重新确认。
        首次执行、失败重试与重新运行共用这一个入口。
      */}
      <NotebookDialog
        open={lightAgent.pendingStart}
        title="确认发送所选笔记以整理搜索结果？"
        confirmLabel="同意并开始整理"
        cancelLabel="暂不"
        onCancel={lightAgent.cancelStart}
        onConfirm={() => void lightAgent.confirmStart()}
      >
        <p>一共两次请求，都发送到你配置的模型：</p>
        <ul>
          <li>第一次（计划）：你写的整理目标；</li>
          <li>第一次（计划）：下面列出的范围字段——笔记本给 ID 与标题，地区/旅行/地点给 ID 与名称，以及时间边界；</li>
          <li>第二次（分组）：实际读取篇的标题、完整正文、记录时间、地区名、来源摘要值与篇/块身份 ID（发送前会再次核对它们仍在本次范围内且内容未变）；</li>
          <li>第二次（分组）：检索的覆盖计数——每个检索步骤命中多少条、是否截断、其中读取了几篇；<strong>未读取的候选篇不发送标题或摘要</strong>。</li>
        </ul>
        <p>本次范围（就是实际发送的范围字段）：</p>
        <ul>
          {lightAgentScopeLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="nb-dialog-note">
          不发送图片二进制、不发送未读取候选篇的标题或摘要、不发送范围外的笔记本、
          不发送被删除或归档的内容，也不发送整份档案；
          只做关键词与结构筛选（不做语义检索），因此无法保证召回「没有明确出现关键词、但语义相关」的内容；
          结果是只读分组建议，不会新建笔记、不改正文、不生成出版作品。
          本次同意只对当前应用会话有效，刷新后需要重新确认。
        </p>
      </NotebookDialog>

      <NotebookDialog
        open={Boolean(deletePrompt)}
        title={
          deletePrompt?.kind === "notebook"
            ? `删除笔记本《${deletePrompt.title}》？`
            : `删除笔记《${deletePrompt?.title ?? ""}》？`
        }
        tone="danger"
        confirmLabel="移入垃圾桶"
        busy={busy}
        onCancel={() => setDeletePrompt(undefined)}
        onConfirm={() => void confirmDelete()}
      >
        <p>
          {deletePrompt?.kind === "notebook"
            ? `这本有 ${deletePrompt.pageCount} 篇活动页，会一起移入垃圾桶。`
            : "这一页会移入垃圾桶。"}
        </p>
        <p className="nb-dialog-note">
          {trashAutoCleanup
            ? "30 天内可以恢复，满 30 天后自动永久删除。仍被其他笔记引用的图片会保留。"
            : "可以在垃圾桶恢复；自动清理未开启，永久删除需另行确认。"}
        </p>
      </NotebookDialog>

      <NotebookDialog open={trashCleanupPrompt} title="开启 30 天自动清理？" tone="permanent"
        confirmLabel="开启自动清理" busy={busy}
        onCancel={() => setTrashCleanupPrompt(false)} onConfirm={() => void changeTrashAutoCleanup(true)}>
        <p>垃圾桶中删除已满 30 天的笔记和笔记本将永久删除，包括当前已有的到期记录。此操作无法撤销。</p>
        <p className="nb-dialog-note">仍被其他笔记引用的图片会保留。应用打开期间执行检查；可随时在垃圾桶关闭自动清理。</p>
      </NotebookDialog>

      <NotebookDialog
        open={Boolean(purgePrompt)}
        title={`永久删除 ${purgePrompt?.label ?? ""}？`}
        tone="permanent"
        confirmLabel="永久删除"
        busy={busy}
        onCancel={() => setPurgePrompt(undefined)}
        onConfirm={() => void confirmPurge()}
      >
        <p>
          <strong>无法撤销。</strong>
          会清除这些笔记，并回收它们引用、且删除后无人引用的笔记图片副本。
        </p>
        <p className="nb-dialog-note">
          其他笔记本、原始记录与旧游记不会受影响；垃圾桶里其他条目不在本次范围内。
        </p>
      </NotebookDialog>

      {error ? (
        <div className="notebook-error-toast" role="alert">
          <span>{error.message}</span>
          <button type="button" onClick={() => setErrorNotice(undefined)}>
            确认
          </button>
        </div>
      ) : null}
      {storage.error ? (
        <div className="notebook-error" role="alert">
          本地存储不可用：{storage.error} 已保存的内容不会被删除。
        </div>
      ) : null}
      {storage.migration?.issues.length ? (
        <p className="notebook-error" role="alert">
          迁移提示：{storage.migration.issues.join(" ")}
        </p>
      ) : null}

      <h1 id="notebook-heading" className="sr-only">
        笔记本
      </h1>

      {/*
        桌面保留统一树目录与正文两栏；手机逐层显示本、篇与正文。
      */}
      <div
        className={`nb-workspace nb-directory nb-stage--${mobileStage}${trashOpen ? " is-trash-open" : ""}`}
        style={{ "--nb-directory-width": `${directoryWidth}px` } as CSSProperties}
        data-notebooks-collapsed={notebooksCollapsed}
      >
        {notebookList}
        {mobile ? pageList : null}
        {trashPanel}
        {editorPane}
      </div>

      {notice ? (
        <div
          className="global-notice"
          role="status"
        >
          <span>{notice}</span>
          <button onClick={() => setNotice(undefined)} aria-label="关闭提示">
            <Check size={17} />
          </button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * B4：笔记正文图片块按需读取（loading/missing/error 分态 + 显式重试）。
 * 有效图片不会因 mediaUrls 为空被误报不可用；单张坏图只降级本块。
 */
function NotebookPhoto({
  mediaId,
  caption,
  width,
  height,
  mediaUrls,
  load
}: {
  mediaId: string;
  caption: string;
  width?: number;
  height?: number;
  mediaUrls: Record<string, string>;
  load?: (mediaId: string) => Promise<string | null>;
}) {
  const image = useNativeNotebookImage(mediaId, mediaUrls, load);
  if (image.state === "ready" && image.url) {
    return <img src={image.url} alt={caption} width={width} height={height} />;
  }
  if (image.state === "loading") {
    return <span className="notebook-missing-photo">媒体 {mediaId} 读取中…</span>;
  }
  return (
    <span className="notebook-missing-photo">
      媒体 {mediaId} 暂不可用
      {load && (image.state === "missing" || image.state === "error") && (
        <button type="button" className="notebook-delete" onClick={image.retry}>重读</button>
      )}
    </span>
  );
}
