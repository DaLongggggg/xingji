"use client";

import { copyWorkbenchText } from "./workbench-clipboard";

import { useDismissableLayer } from "@/lib/dismissable-layer";
import { useTimedNotice } from "@/lib/use-timed-notice";

/** 工作台使用注入的适配层；生产为受控网关与本地笔记写入，测试可使用 demo。 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useReducer, useId } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  BookText,
  Brain,
  ChevronDown,
  ArrowUp,
  ArrowDown,
  PanelLeft,
  SlidersHorizontal,
  Copy,
  Download,
  FileInput,
  FilePlus2,
  Image as ImageIcon,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Plus,
  GripVertical,
  CornerDownRight,
  Square,
  ShieldCheck,
  StickyNote,
  Trash2,
  Wrench,
  X
} from "lucide-react";
import { fetchSkillCatalog, skillDisplayName, SKILL_CATALOG_CHANGED_EVENT, type SkillCatalogEntry } from "@/features/ai/skill-knowledge";
import { WorkbenchSkillReferences } from "./workbench-skill-references";
import { imagePresetModelLabel } from "@/features/ai/model-presets";
import { createCaptureId } from "@/features/capture/capture-model";
import { CREATION_VISION_LIMITS } from "@/features/creation/creation-media";
import { blobToBase64 } from "@/features/creation/creation-image-port";
import {
  IMAGE_STYLE_GROUPS,
  IMAGE_STYLE_LABELS,
  composeImageInstruction,
  imageOutputFormats,
  ratioTiles,
  sizeRatio,
  type ImageStyle,
  type ImageOutputFormat
} from "@/features/creation/creation-image-rules";
import { PhotoViewer, type PhotoViewImage } from "@/features/photos/photo-viewer";
function setStreamScrollTop(element: HTMLElement, top: number): void {
  element.scrollTop = top;
}

/** T8：原生分享出口（connected/测试可替换；undefined=非原生环境不显示分享）。 */
export let nativeImageShare: ((input: { title: string; text: string; url: string; blob?: Blob; fileName: string }) => Promise<void>) | undefined;
export function setNativeImageShare(share: typeof nativeImageShare): void { nativeImageShare = share; }
import { StackedImageDeck } from "@/features/notebook/notebook-image-deck";
import { CapabilitiesPanel } from "./workbench-capabilities-panel";
import { SessionApiError, toSessionPayload, type SessionApi, type SessionRecord, type SessionPayload } from "./workbench-sessions";
import {
  SAVE_CONFLICT_REASON,
  activateSession,
  beginSessionDelete,
  cancelSessionDelete,
  awaitSessionSaves,
  clearCheckpoint,
  commitSession,
  freezeSessionCheckpoints,
  thawSessionCheckpoints,
  markSessionDeleted,
  registerTurn,
  scheduleCheckpoint,
  saveSession,
  settleSession,
  switchSession,
  unregisterTurn
} from "./workbench-store";
import { QuickNotesPanel } from "./quick-notes-panel";
import { WorkbenchImagePicker } from "./workbench-image-picker";
import { WorkbenchSearchBlock } from "./workbench-search-block";
import { WorkbenchMarkdown } from "./workbench-markdown";
import { WorkbenchMarkdownDocuments } from "./workbench-markdown-documents";
import { WorkbenchSearchImages, type PreviewSearchImage, type WorkbenchSearchImage } from "./workbench-search-images";
import { messageSearchImages, projectMessageSearchMedia, searchImageIdentity } from "./workbench-media-projection";
import { editImageFile } from "./workbench-image-edit-client";
import { WorkbenchImageSelection } from "./workbench-image-selection";
import { LOCAL_IMAGE_EDIT, IMAGE_BOUNDS, type LocalImageEdit, type ImageEditorDraft } from "./workbench-image-edit-contract";
import { createBrowserImagePort } from "@/features/creation/creation-media";
import { supportsInteractiveImageEdit, validImageEditBounds } from "@/features/creation/creation-image-rules";
import { detectGlobalBridge, digestBytes } from "@/features/mobile/native-host";
import { WorkbenchImageEditor } from "./workbench-image-editor";
import { readWorkbenchImageFile, downloadWorkbenchImageFile, type WorkbenchImageFile } from "./workbench-image-file";
import { partitionMessageBlocks } from "./workbench-presentation";
import { WorkbenchProcessDisclosure } from "./workbench-process-disclosure";
import { WorkbenchPicker, type PickerMode } from "./workbench-scope-picker";
import { activeSession, useWorkbenchStore } from "./workbench-store";
import type {
  MaterialReference,
  SkillReference,
  MessageAttachment,
  WorkbenchAdapter,
  WorkbenchIntent,
  WorkbenchMessage,
  WorkbenchToolBlock,
  WorkbenchNotebook,
  WorkbenchResult,
  WorkbenchScope,
  WorkbenchRequest,
  WorkbenchTurnResult,
  WriteReceipt,
  WriteTarget
} from "./workbench-types";
import {
  SessionSaveFailureError,
  settleWorkbenchTools,
  buildWritePreview,
  describeScope,
  formatDuration,
  hasInlineData,
  imageAttachmentName,
  imageEditProgress,
  imagePlanProgress,
  referencedImageCount,
  requestFromHistory,
  resolveReusableImageGroup
} from "./workbench-types";
import type { ImageAttemptProjection, ImageTaskPlan } from "@/features/ai/image-execution-contract";
import { appendTimelineEvent, completeMessageTimeline, messageTimeline, retryMessageContent } from "./workbench-message-timeline";
import { WorkbenchToolDuration } from "./workbench-tool-duration";
import { finishProcess, startProcess } from "./workbench-process";
import { queryImageAttempt } from "@/features/ai/ai-gateway-client";
import { NATIVE_SEARCH_RESULT } from "@/features/ai/native-search-contract";
import { resolveImageNumbers, imageDisplayEntries, deriveImageSources, historyWithImageSources, withCurrentTurnSources, type ImageSourceCatalog } from "./workbench-image-sources";

/** R1：计划消息的未完成/未知判定（按钮文案与恢复入口共用同一份派生）。 */
function planUnfinished(message: WorkbenchMessage) {
  if (!message.imagePlan) return [];
  return imagePlanProgress(message.imagePlan, message.imageAttempts ?? [], message.attachments ?? [])
    .items.filter(item => !item.attachment);
}
function planHasUnknown(message: WorkbenchMessage): boolean {
  return planUnfinished(message).some(item => item.pendingState === "outcome_unknown");
}
function planHasUnfinished(message: WorkbenchMessage): boolean {
  return planUnfinished(message).length > 0;
}

type QuickNotesProps = Parameters<typeof QuickNotesPanel>[0];

type Props = {
  adapter: WorkbenchAdapter;
  loadSkills?: typeof fetchSkillCatalog;
  /** T9/P1-5：本机 Skill 目录注入（entries 为本地 catalog；与选择→发送→快照同源）。 */
  nativeSkillCatalog?: () => Promise<{ ok: boolean; entries: SkillCatalogEntry[]; error?: string }>;
  onOpenSettings?: () => void;
  controls?: ReactNode;
  modelLabel?: string;
  /** 现有模型菜单中的非阻断能力说明。 */
  modelStatus?: ReactNode;
  /** 是否已具备发送条件；发 false 会中止在途请求。 */
  requestAllowed?: boolean;
  /** native 附件输入：原字节经独占发布进入 Directory.Data，会话只保存 fileRef。 */
  nativeAttachments?: {
    prepare(media: { id: string; name: string; type: string; size: number; blob: Blob }): Promise<{ attachment: MessageAttachment; prepared: { release: () => void } }>;
    commit(prepared: readonly { release: () => void }[]): Promise<void>;
    commitSession?(input: { id: string; baseRevision?: number; title?: string; payload: SessionPayload }, prepared: readonly { release: () => void }[]): Promise<SessionRecord>;
  };
  /** 发送条件不满足时的可操作原因；未提供时沿用模型未选提示。 */
  requestBlockReason?: string;
  /** 当前记忆快照：每次发送/重试前由调用方按最新 revision 提供。 */
  memory?: import("./workbench-memory").MemoryState;
  /** 记忆被改动时自增：取消在途回合，避免继续用旧快照。 */
  memoryEpoch?: number;
  memoryStore?: import("./workbench-memory").MemoryStore;
  onMemoryChanged?: () => void;
  /** 记忆读取状态：未就绪或失败时必须先作出选择，不能静默按无记忆发送。 */
  memoryStatus?: "loading" | "ready" | "error";
  onMemoryRetry?: () => void;
  /** 权威重读：每个外发点调用；失败即让本轮失败（不按空记忆继续）。 */
  ensureMemory?: () => Promise<import("./workbench-memory").MemoryState>;
  /** 会话持久化 API；测试不传时完全跳过落库。 */
  sessionApi?: SessionApi;
  /** 会话读取状态：读取失败不能当空库继续创建/发送。 */
  sessionStatus?: "loading" | "ready" | "error";
  sessionError?: string;
  /** 恢复提示（中断/模型失效），来自持久化读取。 */
  restoreNotice?: string;
  /** 当前选择的模型：随会话保存（仅用于显示；模型选择不是发送许可）。 */
  models?: { textModelId?: string; imageModelId?: string };
  imageTool?: {
    enabled: boolean;
    modelId: string;
    size?: string;
    style: ImageStyle;
    outputFormat?: ImageOutputFormat;
    /** 依赖被停用等情况下，直接说明不可用原因（而不是让用户猜）。 */
    reason?: string;
    /** `model` 是端点上真实的模型 ID（配置名称常常就是它），显示时换算成可读名称。 */
    models: { id: string; label: string; model?: string; capabilities: { generate: boolean; edit: boolean }; imageSizes: string[] }[];
    onModelChange: (id: string) => void;
    onSizeChange: (size?: string) => void;
    onStyleChange: (style: ImageStyle) => void;
    onOutputFormatChange?: (format: ImageOutputFormat) => void;
  };
  notebooks: WorkbenchNotebook[];
  quickNotes: Omit<QuickNotesProps, "onUseAsMaterial" | "onClose">;
};

type PanelKind = "preview" | "notes" | "capabilities";

function formatTime(iso: string): string {
  return iso.slice(5, 16).replace("T", " ");
}

/** 比例瓦片的形状：竖版按宽度定尺寸、横版按高度定，方形两者相同。 */
function ratioShape(ratio: string): "portrait" | "square" | "landscape" {
  const [w, h] = ratio.split(":").map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w === h) return "square";
  return w < h ? "portrait" : "landscape";
}

/**
 * F1/F6：native 附件统一按需资源出口（fileRef → objectURL）。
 *
 * - 生命周期绑定：条目键含 `${serverId}/${userId}/${datasetId}`；切换来源（切号/
 *   清空/卸载）时撤销全部 objectURL、清空条目并使在途回调失效，不回填另一生命周期。
 * - 渲染只读：peekNativeView 无副作用；装载只经显式 load/resolve（effect 与查看器
 *   路径），渲染不发起读取——LRU 逐出与渲染解耦，不形成逐出重读循环。
 * - 失败稳定：missing/error 不自动重试；仅显式 retry 才再次读取。
 * - blob URL 不进消息 JSON：注册表仅存内存 URL/Blob，会话持久化仍是 fileRef。
 */
export type NativeViewResource = { state: "idle" | "loading" | "ready" | "missing" | "error"; url?: string; blob?: Blob };
type NativeViewEntry = NativeViewResource & { promise?: Promise<NativeViewResource> };
const nativeViews = new Map<string, NativeViewEntry>();
/**
 * 覆盖单消息 9 图 + 结果 + 输入区仍不逐出（超出才撤销最旧，且渲染不会重载它）。
 * B7：限额是残留兜底而非唯一界——当前可见/查看器/输入区/在途资源受保护
 * 不逐出；可见集可暂时超限，离开视口后按事件释放。
 */
const NATIVE_VIEW_LIMIT = 24;
/**
 * B7：受保护资源。可见性是**状态**（任一观察器报告即置位/清除，幂等），
 * 查看器/输入区是**持有者**（引用计数）——两条轨道独立，互不解对方的保护。
 */
const nativeViewVisible = new Set<string>();
const nativeViewHolders = new Map<string, number>();
let nativeViewLoader: ((attachment: MessageAttachment) => Promise<Blob | undefined>) | null = null;
let nativeViewLifecycle = "";
let nativeViewTicket = 0;
let nativeViewListener: (() => void) | null = null;
/** 测试观测口：实际读取次数（回归断言“稳定后不再增长”用）。 */
export const nativeViewStats = { loads: 0 };

const nativeViewKey = (attachment: MessageAttachment) => `${nativeViewLifecycle}#${attachment.id}`;
const nativeViewIdOfKey = (key: string) => key.slice(key.indexOf("#") + 1);
const holdNativeView = (id: string) => { nativeViewHolders.set(id, (nativeViewHolders.get(id) ?? 0) + 1); };
const unholdNativeView = (id: string) => {
  const count = nativeViewHolders.get(id);
  if (count === undefined) return;
  if (count <= 1) nativeViewHolders.delete(id);
  else nativeViewHolders.set(id, count - 1);
};
const isNativeViewProtected = (id: string) => nativeViewVisible.has(id) || nativeViewHolders.has(id);
/**
 * B7：离开视口的有界释放——未受保护（不可见、查看器未开、非输入区）且非在途的
 * 资源撤销 objectURL 并移出注册表；重新进入视口会经观察器再次装载（观察不撤销）。
 */
function releaseNativeView(id: string): boolean {
  if (isNativeViewProtected(id)) return false;
  const key = `${nativeViewLifecycle}#${id}`;
  const entry = nativeViews.get(key);
  if (!entry || entry.state === "loading") return false;
  if (entry.url) URL.revokeObjectURL(entry.url);
  nativeViews.delete(key);
  return true;
}

/** connected 装配：按需读取出口与生命周期（切号/清空/卸载时以新生命周期调用即全部撤销）。 */
export function setNativeAttachmentSource(
  loader: ((attachment: MessageAttachment) => Promise<Blob | undefined>) | null,
  lifecycle: string
): void {
  nativeViewTicket += 1;
  nativeViewLifecycle = lifecycle;
  for (const entry of nativeViews.values()) if (entry.url) URL.revokeObjectURL(entry.url);
  nativeViews.clear();
  nativeViewVisible.clear();
  nativeViewHolders.clear();
  nativeViewLoader = loader;
}

function rememberNativeView(key: string, entry: NativeViewEntry): void {
  const existing = nativeViews.get(key);
  if (existing?.url && existing.url !== entry.url) URL.revokeObjectURL(existing.url);
  nativeViews.set(key, entry);
  while (nativeViews.size > NATIVE_VIEW_LIMIT) {
    // B7：只逐出既不受保护也不在途的最旧条目；全部受保护时允许超限
    // （可见集大小即实际上界，离开视口/关闭查看器后按事件释放回收）。
    let victim: string | undefined;
    for (const candidate of nativeViews.keys()) {
      const candidateEntry = nativeViews.get(candidate);
      if (candidateEntry?.state === "loading" || isNativeViewProtected(nativeViewIdOfKey(candidate))) continue;
      victim = candidate;
      break;
    }
    if (victim === undefined) break;
    const evicted = nativeViews.get(victim);
    if (evicted?.url) URL.revokeObjectURL(evicted.url);
    nativeViews.delete(victim);
  }
}

/** 渲染路径唯一出口：纯读，不装载。 */
export function peekNativeView(attachment: MessageAttachment): NativeViewResource {
  if (attachment.dataUrl || !attachment.fileRef) return { state: "ready", url: attachment.dataUrl };
  const entry = nativeViews.get(nativeViewKey(attachment));
  if (!entry) return { state: "idle" };
  return { state: entry.state, ...(entry.url ? { url: entry.url, blob: entry.blob } : {}) };
}

/**
 * 显式装载（effect/查看器/重试路径）。幂等：loading/ready/missing/error 状态直接返回，
 * 仅 idle（或 retry）才发起读取——同一资源稳定后读取次数不再增长。
 */
export function loadNativeView(attachment: MessageAttachment, options: { retry?: boolean } = {}): Promise<NativeViewResource> {
  if (attachment.dataUrl || !attachment.fileRef) return Promise.resolve({ state: "ready", url: attachment.dataUrl });
  const key = nativeViewKey(attachment);
  const existing = nativeViews.get(key);
  if (existing?.promise && existing.state === "loading") return existing.promise;
  if (existing && existing.state !== "idle" && !options.retry) {
    return Promise.resolve({ state: existing.state, ...(existing.url ? { url: existing.url, blob: existing.blob } : {}) });
  }
  if (!nativeViewLoader) {
    rememberNativeView(key, { state: "error" });
    return Promise.resolve({ state: "error" });
  }
  const ticket = nativeViewTicket;
  nativeViewStats.loads += 1;
  const promise = nativeViewLoader(attachment).then(
    blob => {
      if (ticket !== nativeViewTicket) return { state: "error" as const };
      const settled: NativeViewEntry = blob
        ? { state: "ready", url: URL.createObjectURL(blob), blob }
        : { state: "missing" };
      rememberNativeView(key, settled);
      nativeViewListener?.();
      return { state: settled.state, ...(settled.url ? { url: settled.url, blob: settled.blob } : {}) };
    },
    () => {
      if (ticket !== nativeViewTicket) return { state: "error" as const };
      rememberNativeView(key, { state: "error" });
      nativeViewListener?.();
      return { state: "error" as const };
    }
  );
  rememberNativeView(key, { state: "loading", promise });
  return promise;
}

/** 新附加文件直接注册（发送前已有 Blob，避免一次多余读取）。 */
function registerNativeView(attachment: MessageAttachment, blob: Blob): void {
  if (!attachment.fileRef) return;
  rememberNativeView(nativeViewKey(attachment), { state: "ready", url: URL.createObjectURL(blob), blob });
}

function resultToMessage(result: WorkbenchResult): string {
  return result.kind === "text" ? result.body : result.kind === "image" ? `配图：${result.caption}` : result.title;
}

function imageResultFor(message: WorkbenchMessage, attachment: MessageAttachment): Extract<WorkbenchResult, { kind: "image" }> | undefined {
  if (message.role !== "assistant") return undefined;
  if (message.result?.kind === "image" && message.result.id === attachment.id) return message.result;
  return { id: attachment.id, kind: "image", title: attachment.name.replace(/\.(png|jpe?g|webp)$/i, ""), caption: "", from: "", to: "", dataUrl: peekNativeView(attachment).url, demo: false };
}

/**
 * 排队中的回合：**入队时的快照**（正文/意图/引用/附图/选中的结果）。
 * 范围、模型、尺寸与风格仍取真正发出时的当前工具状态——那些是工具面板的值，不是这条消息的一部分。
 */
type QueuedTurn = {
  id: string;
  sessionId: string;
  text: string;
  intent: WorkbenchIntent;
  imageRequested?: true;
  references: MaterialReference[];
  attachments: MessageAttachment[];
  skillReferences?: SkillReference[];
  sourceResultChoice?: { sessionId: string; result: WorkbenchResult };
};

type ViewerImage = PhotoViewImage & { ownerId?: string; attachment?: MessageAttachment; search?: WorkbenchSearchImage };
type ConversationViewer = { sessionId: string; initialId: string; images: ViewerImage[]; trigger: HTMLButtonElement };

function ownsViewerImage(messages: WorkbenchMessage[], image: ViewerImage): boolean {
  const index = messages.findIndex(message => message.id === image.ownerId);
  const message = messages[index];
  if (!message) return false;
  if (image.search) return messageSearchImages(message).some(candidate => searchImageIdentity(candidate) === image.id);
  const sources = [...message.attachments ?? []];
  if (message.result?.kind === "image" && message.result.dataUrl) sources.push({ id: message.result.id, name: message.result.title, dataUrl: message.result.dataUrl });
  if (message.role === "user" && messages[index + 1]?.role === "assistant") sources.push(...messages[index + 1].request?.attachments ?? []);
  const attachment = image.attachment;
  return !!attachment && sources.some(source => source.id === attachment.id && source.dataUrl === attachment.dataUrl);
}

/**
 * 一条回答里的**文字**也当成一个文字结果：图片+文字的内容块里，
 * 文字那一半要有自己的一行操作（改这段文字 / 插入笔记 / 保存 / 下载文字），
 * 与图片那行（改这张图片 / 下载图片）互不冲突。
 */
function textResultFor(message: WorkbenchMessage): Extract<WorkbenchResult, { kind: "text" }> {
  return { id: `${message.id}-text`, kind: "text", title: "对话回复", body: message.text ?? "", demo: false };
}

function visibleTrace(line: string, message: WorkbenchMessage): string {
  if (!line.startsWith("阶段：")) return line;
  const label = line.slice(3);
  if (label === "准备附图") return "正在查看图片";
  if (label === "走生图/修图流程") {
    if (message.request?.intent === "image-generate") return "正在生成图片";
    if (message.request?.intent === "image-edit") return "正在修改图片";
    return "正在处理图片";
  }
  return label;
}

function visibleToolTitle(tool: WorkbenchToolBlock, message: WorkbenchMessage): string {
  if (!/^item-[\w-]+$/.test(tool.title)) return tool.title;
  const index = message.imagePlan?.items.findIndex(item => item.itemId === tool.title) ?? -1;
  const fallback = message.tools?.filter(item => item.name === "image-edit").findIndex(item => item.id === tool.id) ?? -1;
  return `${message.imagePlan?.mode === "generate" ? "生成图片" : "图片"} ${Math.max(0, index >= 0 ? index : fallback) + 1}`;
}

/** 演示文件导出：文本/手帐页给 Markdown，演示配图给 SVG；真实图片由 download 直接下载字节。 */
function resultFile(result: WorkbenchResult): { name: string; type: string; content: string } {
  if (result.kind === "image") {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="640">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${result.from}"/><stop offset="1" stop-color="${result.to}"/>
  </linearGradient></defs>
  <rect width="1024" height="640" fill="url(#g)"/>
  <text x="48" y="320" fill="#ffffff" font-size="40" font-family="system-ui">${result.caption}</text>
  <text x="48" y="380" fill="#ffffff" font-size="22" font-family="system-ui">演示图 · 未调用模型</text>
</svg>`;
    return { name: `${result.title}.svg`, type: "image/svg+xml", content: svg };
  }
  const content =
    result.kind === "text"
      ? result.body
      : `# ${result.title}\n\n_${result.subtitle}_\n\n${result.blocks
          .map((block) => `## ${block.heading}\n\n${block.body}`)
          .join("\n\n")}\n`;
  return { name: `${result.title}.md`, type: "text/markdown", content };
}

export function WorkbenchPage({
  adapter,
  loadSkills = fetchSkillCatalog,
  /** T9/P1-5：本机 Skill 目录（当前手机账号本地 store catalog；提供时优先于服务端目录）。 */
  nativeSkillCatalog,
  notebooks,
  quickNotes,
  controls,
  onOpenSettings,
  modelLabel = "选择模型",
  modelStatus,
  requestAllowed = true,
  nativeAttachments,
  requestBlockReason,
  memory,
  memoryEpoch = 0,
  memoryStore,
  onMemoryChanged,
  memoryStatus = "ready",
  onMemoryRetry,
  ensureMemory,
  sessionApi,
  sessionStatus = "ready",
  sessionError,
  restoreNotice,
  models,
  imageTool
}: Props) {
  const sessions = useWorkbenchStore((state) => state.sessions);
  const activeId = useWorkbenchStore((state) => state.activeId);
  const session = useWorkbenchStore(activeSession);
  const displayImageSources = useMemo(() => deriveImageSources(session?.messages ?? [], { max: Infinity }).sources, [session?.messages]);
  const { createSession, removeSession, selectSession, setScope, appendMessage, updateMessage, renameSession } = useWorkbenchStore.getState();
  const saveStates = useWorkbenchStore(state => state.saveStates);

  const [skillReferences, setSkillReferences] = useState<SkillReference[]>([]);
  const [skillCatalog, setSkillCatalog] = useState<{ entries: SkillCatalogEntry[]; loading: boolean; error?: string }>({ entries: [], loading: true });
  const skillCatalogTicket = useRef(0);
  useEffect(() => () => { skillCatalogTicket.current += 1; }, []);
  const refreshSkills = useCallback(async () => {
    const ticket = ++skillCatalogTicket.current;
    setSkillCatalog(current => ({ ...current, loading: true, error: undefined }));
    try {
      // P1-5：本地目录优先（手机账号本地权威）；不可用明确报错不回退服务端（手机端服务端目录非权威）。
      if (nativeSkillCatalog) {
        const local = await nativeSkillCatalog();
        if (ticket !== skillCatalogTicket.current) return;
        if (local.ok) {
          setSkillCatalog({ entries: local.entries, loading: false });
          setSkillReferences(current => current.map(ref => {
            const entry = local.entries.find(item => item.id === ref.id);
            return entry ? { ...ref, name: skillDisplayName(entry).slice(0, 200) } : ref;
          }));
          return;
        }
        setSkillCatalog({ entries: [], loading: false, error: local.error ?? "本机 Skill 目录不可读。" });
        return;
      }
      const entries = await loadSkills();
      if (ticket === skillCatalogTicket.current) {
        setSkillCatalog({ entries, loading: false });
        // Refresh only the unsent input. Queued/history references retain their snapshot names.
        setSkillReferences(current => current.map(ref => {
          const entry = entries.find(item => item.id === ref.id);
          return entry ? { ...ref, name: skillDisplayName(entry).slice(0, 200) } : ref;
        }));
      }
    } catch (error) {
      if (ticket === skillCatalogTicket.current) setSkillCatalog({ entries: [], loading: false, error: error instanceof Error ? error.message : "技能列表暂时不可用。" });
    }
  }, [loadSkills, nativeSkillCatalog]);
  useEffect(() => {
    const changed = () => { void refreshSkills(); };
    window.addEventListener(SKILL_CATALOG_CHANGED_EVENT, changed);
    return () => window.removeEventListener(SKILL_CATALOG_CHANGED_EVENT, changed);
  }, [refreshSkills]);
  const [text, setText] = useState("");
  const [intent, setIntent] = useState<WorkbenchIntent>("chat");
  const [imageToolOpen, setImageToolOpen] = useState(false);
  const imageFieldGroup = useId();
  const [references, setReferences] = useState<MaterialReference[]>([]);
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  /** native 附件按需读取完成时重渲染（注册表 LRU 触碰/装载完成）。 */
  const [, bumpNativeViews] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    nativeViewListener = bumpNativeViews;
    return () => { nativeViewListener = null; };
  }, [bumpNativeViews]);
  const activeIdForViews = useWorkbenchStore((state) => state.activeId);
  const nativeViewSessionRef = useRef(activeIdForViews);
  useEffect(() => {
    // G5：切会话——旧会话的可见保护全部解除并释放无持有者资源（查看器/输入区
    // 持有者不受影响）。旧会话缓存不再永久受保护突破限额；仍可见的元素随后由
    // 新观察器初始回调重新置位（ready 条目幂等返回，不重读）。
    if (nativeViewSessionRef.current !== activeIdForViews) {
      nativeViewSessionRef.current = activeIdForViews;
      for (const id of [...nativeViewVisible]) {
        nativeViewVisible.delete(id);
        releaseNativeView(id);
      }
      nativeViewListener?.();
    }
    // P2-a/B7：视口驱动装载与有界释放——进入视口装载并保护（pin），离开视口
    // 释放（unpin + release）。观察不撤销：重新进入视口会再次装载，可见资源
    // 不会被 LRU 逐出成空白。30 张长时间线只保持视口内几张。
    const nodes = document.querySelectorAll<HTMLElement>("[data-attachment-id]");
    const loadAttachmentById = (id: string) => {
      const state = useWorkbenchStore.getState();
      for (const message of state.sessions.find(item => item.id === activeIdForViews)?.messages ?? []) {
        for (const attachment of [...(message.attachments ?? []), ...(message.request?.attachments ?? [])]) {
          if (attachment.fileRef && attachment.id === id) void loadNativeView(attachment);
        }
      }
    };
    // 测试环境无 IO：降级为 DOM 存在即视为可见——保护并装载。
    if (typeof IntersectionObserver === "undefined") {
      for (const element of nodes) {
        const id = element.dataset.attachmentId!;
        nativeViewVisible.add(id);
        loadAttachmentById(id);
      }
      const heldInput = new Set<string>();
      for (const attachment of attachments) if (attachment.fileRef) { holdNativeView(attachment.id); heldInput.add(attachment.id); void loadNativeView(attachment); }
      return;
    }
    const io = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.attachmentId!;
        if (entry.isIntersecting) {
          nativeViewVisible.add(id);
          loadAttachmentById(id);
        } else {
          nativeViewVisible.delete(id);
          if (releaseNativeView(id)) nativeViewListener?.();
        }
      }
    }, { root: streamRef.current, rootMargin: "200px" });
    for (const element of nodes) io.observe(element);
    // 输入区附件始终装载并保护（不在时间线视口内）；本轮之后的移除随之解除持有。
    const heldInput = new Set<string>();
    for (const attachment of attachments) if (attachment.fileRef) { holdNativeView(attachment.id); heldInput.add(attachment.id); void loadNativeView(attachment); }
    return () => {
      io.disconnect();
      for (const id of heldInput) unholdNativeView(id);
    };
  }, [activeIdForViews, attachments]);
  // 时间线 DOM 变化（新消息/滚动加载）→ 新缩略图进入观察（由 IO 判定可见性，此处不装载）。
  useEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;
    if (typeof IntersectionObserver === "undefined") return;
    let ioForNew: IntersectionObserver | undefined;
    let observed: HTMLElement[] = [];
    const observer = new MutationObserver(() => {
      const nodes = [...stream.querySelectorAll<HTMLElement>("[data-attachment-id]")];
      // Rich-text batches do not change thumbnail identity. Re-observing them restarts IO callbacks
      // and can repeatedly release/read files and rerender the entire page during layout.
      if (nodes.length === observed.length && nodes.every((node, index) => node === observed[index])) return;
      observed = nodes;
      if (ioForNew) ioForNew.disconnect();
      ioForNew = new IntersectionObserver(entries => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.attachmentId!;
          if (entry.isIntersecting) {
            nativeViewVisible.add(id);
            const state = useWorkbenchStore.getState();
            for (const message of state.sessions.find(item => item.id === activeIdForViews)?.messages ?? []) {
              for (const attachment of [...(message.attachments ?? []), ...(message.request?.attachments ?? [])]) {
                if (attachment.fileRef && attachment.id === id) void loadNativeView(attachment);
              }
            }
          } else {
            nativeViewVisible.delete(id);
            if (releaseNativeView(id)) nativeViewListener?.();
          }
        }
      }, { root: stream, rootMargin: "200px" });
      for (const element of nodes) ioForNew.observe(element);
    });
    observer.observe(stream, { childList: true, subtree: true });
    return () => { observer.disconnect(); ioForNew?.disconnect(); };
  }, [activeIdForViews]);
  /** native 附件：待提交的原生发布凭据（预览 URL 为模块级 Map，见 nativePreviewUrls）。 */
  const pendingPreparedRef = useRef<{ release: () => void }[]>([]);
  const [readingImages, setReadingImages] = useState(false);
  const readingImagesRef = useRef(false);
  const [sourceResultChoice, setSourceResultChoice] = useState<{ sessionId: string; result: WorkbenchResult }>();
  /**
   * 运行中排队等待发送的回合。`queueRef` 是同步可读的那一份：
   * 本轮收尾（finally）和"确认真的要发了"的判定都在同一 tick 里读它，不能等一次渲染。
   */
  const [queue, setQueue] = useState<QueuedTurn[]>([]);
  const queueRef = useRef<QueuedTurn[]>([]);
  const setQueued = (next: QueuedTurn[]) => { queueRef.current = next; setQueue(next); };
  const [queueEdit, setQueueEditState] = useState<{ id: string; text: string }>();
  const queueEditRef = useRef<typeof queueEdit>(undefined);
  const setQueueEdit = (next: typeof queueEdit) => { queueEditRef.current = next; setQueueEditState(next); };
  const queueEditorRef = useRef<HTMLTextAreaElement>(null);
  const queuePanelRef = useRef<HTMLElement>(null);
  const queueMenuRef = useRef<HTMLDivElement>(null);
  const queueMenuTrigger = useRef<HTMLButtonElement>(null);
  const [queueMenu, setQueueMenuState] = useState<{ id: string; kind: "actions" | "order"; top: number; right: number }>();
  const queueMenuStateRef = useRef<typeof queueMenu>(undefined);
  const queueDragRef = useRef<{ id: string; targetId: string; pointerId: number; startY: number; moved: boolean;
    wasOpen: boolean; sessionId: string | undefined; handle: HTMLButtonElement } | undefined>(undefined);
  const [queueDrop, setQueueDrop] = useState<{ id: string; targetId: string }>();
  const [queuedStartingId, setQueuedStartingState] = useState<string>();
  const queuedStartingRef = useRef<string | undefined>(undefined);
  const setQueuedStarting = (id: string | undefined) => { queuedStartingRef.current = id; setQueuedStartingState(id); };
  const queueOrderIndex = queue.findIndex(entry => entry.id === queueMenu?.id);
  const queueOrderUp = queue[queueOrderIndex - 1], queueOrderDown = queue[queueOrderIndex + 1];
  const latestSendRef = useRef<((entry?: QueuedTurn) => Promise<void>) | undefined>(undefined);
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  function resumeQueue() {
    if (!mountedRef.current || queueEditRef.current || queueDragRef.current || queueMenuStateRef.current?.kind === "order" || abortRef.current) return;
    const head = queueRef.current[0];
    if (head) void latestSendRef.current?.(head);
  }
  const setQueueMenu = (next: typeof queueMenu) => {
    const wasOrdering = queueMenuStateRef.current?.kind === "order";
    queueMenuStateRef.current = next;
    setQueueMenuState(next);
    if (wasOrdering && next?.kind !== "order") queueMicrotask(() => resumeQueue());
  };
  useEffect(() => {
    if (queueEdit?.id) queueEditorRef.current?.focus({ preventScroll: true });
    else if (queueMenuTrigger.current?.isConnected) queueMenuTrigger.current.focus({ preventScroll: true });
  }, [queueEdit?.id]);
  useEffect(() => { if (queueMenu) queueMenuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true }); }, [queueMenu]);
  useDismissableLayer(queuePanelRef, Boolean(queueMenu), () => {
    setQueueMenu(undefined);
    queueMenuTrigger.current?.focus({ preventScroll: true });
  });
  const sourceResult = sourceResultChoice && sourceResultChoice.sessionId === activeId ? sourceResultChoice.result : undefined;
  const sourceImageResult = sourceResult?.kind === "image" ? sourceResult : undefined;
  const [pendingWriteResult, setPendingWriteResult] = useState<WorkbenchResult>();
  const [preparingNoteImage, setPreparingNoteImage] = useState<string | null>(null);
  const noteImageTicket = useRef(0);
  const [sending, setSending] = useState(false);
  const [panel, setPanel] = useState<PanelKind>("preview");
  const [panelOpen, setPanelOpen] = useState(false);
  const [pane, setPane] = useState<"chat" | "sessions" | "panel">("chat");
  /** 桌面侧栏可收起，把宽度让给对话；窄屏用逐级进入，不受这个状态影响。 */
  const [sidebar, setSidebar] = useState<"open" | "collapsed">("open");
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const resizeSidebar = (width: number) => setSidebarWidth(Math.max(220, Math.min(360, width)));
  const [imagePicker, setImagePicker] = useState(false);
  const [viewer, setViewer] = useState<ConversationViewer>();
  const viewerRef = useRef<ConversationViewer | undefined>(undefined);
  useEffect(() => {
    // B7：查看器打开期间其图片受持有保护（不被 LRU 逐出/离开释放）；关闭后解除，
    // 交回视口观察与限额兜底。
    if (!viewer) return;
    const ids = viewer.images.filter(image => image.attachment?.fileRef).map(image => image.id);
    for (const id of ids) holdNativeView(id);
    return () => { for (const id of ids) unholdNativeView(id); };
  }, [viewer]);
  const [viewerFiles, setViewerFiles] = useState<Record<string, WorkbenchImageFile>>({});
  const viewerReads = useRef(new WeakMap<ConversationViewer, Map<string, Promise<WorkbenchImageFile>>>());
  const [viewerDrafts, setViewerDrafts] = useState<Record<string, string>>({});
  const [viewerEditDrafts, setViewerEditDrafts] = useState<Record<string, ImageEditorDraft>>({});
  const [localJobs, setLocalJobs] = useState<Record<string, { messageId: string; controller: AbortController }>>({});
  const localJobsRef = useRef(new Map<string, AbortController>());
  const nearBottomRef = useRef(true);
  const scrollSessionRef = useRef<string | undefined>(undefined);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLFormElement>(null);
  const imageToolsRef = useRef<HTMLDetailsElement>(null);
  const [picker, setPicker] = useState<PickerMode>();
  /** 还没有会话时先记住范围：用户在空状态直接说话也能建会话，不必先点「新建会话」。 */
  const [draftScope, setDraftScope] = useState<WorkbenchScope>({ kind: "free" });
  const [write, setWrite] = useState<{ target?: WriteTarget; receipt?: WriteReceipt; result?: WorkbenchResult; noteBody?: string; baseline?: import("@/features/notebook/notebook-model").PageEditBaseline }>({});
  const [notice, setNotice] = useTimedNotice();
  /** 用户明确选择「本次不用记忆」后才允许在读取失败时继续。 */
  const [memoryBypass, setMemoryBypass] = useState(false);
  const [memoryLoadingSlow, setMemoryLoadingSlow] = useState(false);
  useEffect(() => {
    if (memoryStatus !== "loading") return;
    const timer = window.setTimeout(() => setMemoryLoadingSlow(true), 1000);
    return () => {
      window.clearTimeout(timer);
      setMemoryLoadingSlow(false);
    };
  }, [memoryStatus]);

  /** 只重试保存时的进行中标记（防重复提交）。 */
  const [saveBusy, setSaveBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string>();
  /** 重命名输入：沿用简单输入框，不做弹窗。 */
  const [renaming, setRenaming] = useState<{ id: string; title: string }>();
  /** 手帐页预览的是哪条结果：默认最后一条，点「打开预览」可切到更早的结果。 */
  const [previewId, setPreviewId] = useState<string>();
  const [writing, setWriting] = useState(false);
  const writingRef = useRef(false);
  const writeTriggerRef = useRef<HTMLButtonElement>(null);
  const writeDialogRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  useDismissableLayer(panelRef, panelOpen, () => { setPanelOpen(false); setPane("chat"); });
  const writeCardRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const commandRef = useRef<HTMLDetailsElement>(null);
  const [commandQuery, setCommandQuery] = useState<string | null>(null);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const [draggingImage, setDraggingImage] = useState(false);
  const activeRequestRef = useRef<WorkbenchRequest | undefined>(undefined);
  const commandActions = skillCatalog.entries.filter(entry => commandQuery === null ||
    `${skillDisplayName(entry)} ${entry.name} ${entry.id} ${entry.description}`.toLowerCase().includes(commandQuery.toLowerCase()));
  useEffect(() => {
    if (commandQuery !== null) commandRef.current?.querySelector('[data-highlighted="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [commandIndex, commandQuery]);

  const requestAllowedFor = useCallback((request: WorkbenchRequest): boolean => {
    if (request.imageOptions && (request.imageOptions.requested || request.intent === "image-generate" || request.intent === "image-edit")) {
      const modelId = request.imageOptions.modelId;
      const model = imageTool?.models.find(candidate => candidate.id === modelId);
      const capability = request.intent === "image-edit" ? "edit" : "generate";
      return requestAllowed && imageTool?.enabled === true && !!model &&
        (request.imageOptions.requested ? model.capabilities.generate || model.capabilities.edit : model.capabilities[capability]) &&
        (!request.imageOptions.size || model.imageSizes.includes(request.imageOptions.size)) &&
        (!request.imageOptions.outputFormat || imageOutputFormats(model.model ?? "").includes(request.imageOptions.outputFormat));
    }
    return requestAllowed;
  }, [requestAllowed, imageTool]);
  const isImageIntent = imageToolOpen || intent === "image-generate" || intent === "image-edit";
  useLayoutEffect(() => {
    if (isImageIntent || !imageToolsRef.current) return;
    imageToolsRef.current.open = false;
    imageToolsRef.current.querySelectorAll<HTMLDetailsElement>("details[open]").forEach(field => { field.open = false; });
  }, [isImageIntent]);
  const selectedImageModel = imageTool?.models.find(model => model.id === imageTool.modelId);
  const availableImageFormats = imageOutputFormats(selectedImageModel?.model ?? "");
  const selectedImageFormat = imageTool?.outputFormat && availableImageFormats.includes(imageTool.outputFormat)
    ? imageTool.outputFormat : availableImageFormats[0];
  /** 制图模型显示名：优先预设里的可读名称，认不出才用配置自己的名称。 */
  const imageModelName = (model: { label: string; model?: string }) =>
    (model.model ? imagePresetModelLabel(model.model) : undefined) ?? model.label;
  const imageCapability = intent === "image-edit" ? "edit" : "generate";
  /*
   * 只在**真不能出图**时给一句原因（能力没开 / 没选模型 / 该模型不支持这个动作）。
   * 一切就绪时不再写"对话模型先理解要求…"这类解释性文案：用户要的是参数，不是说明书。
   */
  const imageToolBlocker = !imageTool ? undefined
    : !imageTool.enabled ? (imageTool.reason ?? "图片能力尚未启用。")
    : !selectedImageModel ? "请选择制图模型。"
    : !(imageToolOpen ? selectedImageModel.capabilities.generate || selectedImageModel.capabilities.edit : selectedImageModel.capabilities[imageCapability])
      ? `该模型不支持${intent === "image-edit" ? "修改图片" : "生成图片"}。`
    : undefined;



  // 默认 1 行，最多 8 行；宽度变化时重新计算换行，超出只在输入框内滚动。
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    // Native field sizing avoids height=auto → scrollHeight forcing the whole long chat to relayout.
    if (typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content")) {
      if (input.style.height) input.style.removeProperty("height");
      return;
    }
    const resize = () => {
      const style = getComputedStyle(input);
      const line = parseFloat(style.lineHeight) || 25.6;
      const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
      const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
      input.style.height = "auto";
      input.style.height = `${Math.max(line + padding + border, Math.min(input.scrollHeight + border, line * 8 + padding + border))}px`;
    };
    resize();
    let width = input.getBoundingClientRect().width;
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
      const next = input.getBoundingClientRect().width;
      if (next !== width) { width = next; resize(); }
    });
    observer?.observe(input);
    return () => observer?.disconnect();
  }, [text]);

  const latestResult = (() => {
    const messages = session?.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "assistant" && !message.result && message.attachments?.length) {
        const last = message.attachments[message.attachments.length - 1];
        return imageResultFor(message, last);
      }
      if (messages[index].result) return messages[index].result;
    }
    return undefined;
  })();
  const latestPreviewResult = useMemo(() => {
    const messages = session?.messages ?? [];
    if (previewId) {
      const picked = messages.find(message => message.id === previewId && message.result?.kind === "handbook-page");
      if (picked?.result) return picked.result;
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const result = messages[index].result;
      if (result?.kind === "handbook-page") return result;
    }
    return undefined;
  }, [session, previewId]);

  useEffect(() => {
    if (write.target) writeDialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [write.target]);

  const scrollToBottom = () => {
    const stream = streamRef.current;
    if (stream) setStreamScrollTop(stream, stream.scrollHeight);
  };
  useLayoutEffect(() => {
    if (scrollSessionRef.current !== session?.id) {
      scrollSessionRef.current = session?.id;
      nearBottomRef.current = true;
      setAwayFromBottom(false);
      viewerRef.current = undefined;
      setViewer(undefined); setViewerFiles({});
    }
    if (nearBottomRef.current) scrollToBottom();
  }, [session?.id, session?.messages, sending]);

  // 侧栏、窗口或输入高度改变时重排正文；仅沿用原贴底许可，不打断上翻阅读。
  useLayoutEffect(() => {
    const stream = streamRef.current;
    if (!stream || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (nearBottomRef.current) stream.scrollTop = stream.scrollHeight;
    });
    observer.observe(stream);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const jobs = localJobsRef.current;
    return () => { mountedRef.current = false; queueDragRef.current = undefined; abortRef.current?.abort(); for (const controller of jobs.values()) controller.abort(); };
  }, []);
  useEffect(() => {
    const drag = queueDragRef.current;
    if (!drag || drag.sessionId === activeId) return;
    queueDragRef.current = undefined;
    setQueueDrop(undefined);
    if (drag.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
  }, [activeId]);
  useEffect(() => {
    if (activeRequestRef.current && !requestAllowedFor(activeRequestRef.current)) abortRef.current?.abort();
  }, [requestAllowedFor]);

  /**
   * R1 恢复（§4.2.5/§4.4）：会话加载后，把「结果已在尝试表、尚未进入会话」的产物取回；
   * 未知/过期按未知展示——**不自动重新生成**（查询是纯查询端点，零模型/图片请求）。
   * 每个会话每次加载只跑一次。
   */
  const recoveredSessionsRef = useRef(new Set<string>());
  useEffect(() => {
    const sessionId = session?.id;
    if (!sessionId || !sessionApi || !session?.loaded) return;
    if (recoveredSessionsRef.current.has(sessionId)) return;
    if (sending || abortRef.current) return;
    const plans = session.messages.filter(message => message.imagePlan);
    if (!plans.length) return;
    recoveredSessionsRef.current.add(sessionId);
    const currentMessages = () =>
      useWorkbenchStore.getState().sessions.find(item => item.id === sessionId)?.messages ?? [];
    const currentMessage = (messageId: string) => currentMessages().find(item => item.id === messageId);
    void (async () => {
      let changed = 0;
      let restored = 0;
      let unknowns = 0;
      for (const message of plans) {
        const plan = message.imagePlan!;
        const attempts = message.imageAttempts ?? [];
        const progress = imagePlanProgress(plan, attempts, message.attachments ?? []);
        for (const item of progress.items) {
          if (item.attachment) continue;
          const live = currentMessage(message.id);
          if (!live) break;
          const liveAttempts = live.imageAttempts ?? attempts;
          const itemAttempts = liveAttempts.filter(entry => entry.itemId === item.itemId)
            .sort((a, b) => a.attemptNo - b.attemptNo);
          const latest = itemAttempts[itemAttempts.length - 1];
          if (!latest || latest.delivered) continue;
          if (latest.status !== "succeeded" && latest.status !== "dispatched") continue;
          const answer = await queryImageAttempt(latest.attemptId).catch(() => undefined);
          if (!answer?.ok) continue;
          const patchAttempts = (next: ImageAttemptProjection) =>
            updateMessage(sessionId, message.id, {
              imageAttempts: (currentMessage(message.id)?.imageAttempts ?? liveAttempts).map(entry =>
                entry.attemptId === next.attemptId ? next : entry)
            });
          if (answer.attempt.status === "succeeded" && answer.attempt.result) {
            const primary = plan.sources.find(source => source.sourceId === item.sourceIds[0]);
            const title = plan.mode === "generate"
              ? (primary ? `${primary.name} · 融合` : "图片作品")
              : (primary?.name ?? "图片").replace(/\.(png|jpe?g|webp)$/i, "").trim() || "图片";
            const attachment = {
              id: answer.attempt.artifactId ?? latest.attemptId,
              name: imageAttachmentName({ title, dataUrl: `data:${answer.attempt.result.mime};base64,` }),
              dataUrl: `data:${answer.attempt.result.mime};base64,${answer.attempt.result.imageBase64}`
            };
            updateMessage(sessionId, message.id, {
              attachments: [...(currentMessage(message.id)?.attachments ?? []), attachment]
                .filter((entry, index, all) => all.findIndex(other => other.id === entry.id) === index)
            });
            patchAttempts({ ...latest, delivered: true });
            restored += 1;
            changed += 1;
          } else if (answer.attempt.status === "dispatched" && answer.attempt.expired) {
            patchAttempts({ ...latest, status: "outcome_unknown" });
            unknowns += 1;
            changed += 1;
          } else if (answer.attempt.status === "failed" || answer.attempt.status === "outcome_unknown") {
            patchAttempts({
              ...latest,
              status: answer.attempt.status,
              ...(answer.attempt.errorCode ? { errorCode: answer.attempt.errorCode } : {})
            });
            changed += 1;
          }
        }
      }
      if (changed > 0) await commitSession(sessionApi, sessionId);
      if (restored > 0) setNotice(`已从原尝试取回 ${restored} 张未保存的图片。`);
      if (unknowns > 0) setNotice(`有 ${unknowns} 项出站结果未知；未自动重新生成。`);
    })();
  }, [session?.id, session?.loaded, session?.messages, sessionApi, sending, setNotice, updateMessage]);

  useEffect(() => {
    if (!imageTool?.size) return;
    const selected = imageTool.models.find(model => model.id === imageTool.modelId);
    if (selected && !selected.imageSizes.includes(imageTool.size)) {
      imageTool.onSizeChange(undefined);
      queueMicrotask(() => setNotice("新制图模型不支持原尺寸，已改回自动。"));
    }
  }, [imageTool, setNotice]);

  /** 新建会话：本地建好就立即落盘并设为偏好，刷新后才找得回来。 */
  const openSession = (scope: WorkbenchScope) => {
    setSourceResultChoice(undefined);
    setIntent("chat");
    setImageToolOpen(false);
    const id = createSession(scope);
    if (sessionApi) void activateSession(sessionApi, id);
    return id;
  };
  const currentScope: WorkbenchScope = session?.scope ?? draftScope;
  const scopedNote = currentScope.kind === "note"
    ? notebooks.find(book => book.id === currentScope.notebookId)?.notes.find(note => note.id === currentScope.noteId)
    : undefined;
  // 笔记媒体 URL 可能是 objectURL（use-notebook-archive 现用 Blob 引用）或遗留 dataURL：
  // 展示两者都可用；进入附件时由 selectNoteImage 统一回读为 dataURL（会话载荷形态）。
  const isUsableMediaUrl = (url: string | undefined): url is string =>
    !!url && (/^data:image\/(png|jpeg|webp);base64,/.test(url) || url.startsWith("blob:"));
  const noteCards = (scopedNote?.images ?? []).map((image, position) => ({
    key: `note-image-${position}-${image.id}`,
    label: image.name,
    src: isUsableMediaUrl(image.dataUrl) ? image.dataUrl : "",
    position
  }));
  const selectedNoteImages = noteCards.filter(card => attachments.some(item => item.id === card.key)).map(card => card.key);
  const scopeKey = currentScope.kind === "note" ? `note:${currentScope.notebookId}:${currentScope.noteId}`
    : currentScope.kind === "notebook" ? `notebook:${currentScope.notebookId}` : "free";
  const previousScopeKey = useRef(scopeKey);
  useEffect(() => {
    if (previousScopeKey.current !== scopeKey) {
      noteImageTicket.current += 1;
      setPreparingNoteImage(null);
      setAttachments(current => current.filter(item => !item.id.startsWith("note-image-")));
      previousScopeKey.current = scopeKey;
    }
  }, [scopeKey]);
  const selectNoteImage = async (key: string) => {
    const card = noteCards.find(item => item.key === key);
    const image = card ? scopedNote?.images?.[card.position] : undefined;
    if (!isUsableMediaUrl(image?.dataUrl)) return;
    if (preparingNoteImage) return;
    if (attachments.some(item => item.id === key)) {
      setAttachments(current => current.filter(item => item.id !== key));
      return;
    }
    if (attachments.length >= CREATION_VISION_LIMITS.images) {
      setNotice(`一次最多附加 ${CREATION_VISION_LIMITS.images} 张图片，请先移除一张。`);
      return;
    }
    const ticket = ++noteImageTicket.current;
    setPreparingNoteImage(key);
    try {
      // 原字节直附（与直接上传附件一致）：看图出站由 prepareVisionImages 派生，
      // 修图出站由 prepareSourceImages 直传或明确拒绝；选择阶段不提前缩图，
      // 笔记原件引用不因进工作台而丢失；会话总容量由服务端统一兜底。
      // objectURL 在这里回读为 dataURL（会话附件的持久形态，字节不变）。
      let dataUrl = image.dataUrl;
      if (dataUrl.startsWith("blob:")) {
        const blob = await fetch(dataUrl).then(response => {
          if (!response.ok) throw new Error("笔记图片暂时无法读取，请重试。");
          return response.blob();
        });
        dataUrl = `data:${blob.type || "image/png"};base64,${await blobToBase64(blob)}`;
      }
      if (ticket !== noteImageTicket.current) return;
      setAttachments(current => current.some(item => item.id === key) ? current : [...current, { id: key, name: image.name, dataUrl }]);
      setSourceResultChoice(undefined);
      setNotice(undefined);
    } catch (error) {
      if (ticket === noteImageTicket.current) setNotice(error instanceof Error ? error.message : "图片暂时无法处理，请换一张试试。");
    } finally {
      if (ticket === noteImageTicket.current) setPreparingNoteImage(null);
    }
    inputRef.current?.focus();
  };
  /** 选完就收起芯片（`<details>` 不会自己关）；Esc 也走同一入口。 */
  const closeChip = (event: { currentTarget: HTMLElement }) => {
    const details = event.currentTarget.closest("details");
    if (details) {
      details.removeAttribute("open");
      details.querySelector("summary")?.focus();
    }
  };
  const closeChipOnEscape = (event: { key: string; preventDefault: () => void; currentTarget: HTMLDetailsElement }) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.currentTarget.open = false;
    event.currentTarget.querySelector("summary")?.focus();
  };
  const chooseSkill = (entry: SkillCatalogEntry) => {
    if (!entry.enabled || !entry.readable) return;
    if (skillReferences.length >= 9 && !skillReferences.some(ref => ref.id === entry.id)) { setNotice("每轮最多引用 9 个技能。"); return; }
    setSkillReferences(current => current.some(ref => ref.id === entry.id) ? current : [...current, { id: entry.id, name: skillDisplayName(entry).slice(0, 200) }]);
    if (commandRef.current) commandRef.current.open = false;
    setSkillMenuOpen(false);
    setText(current => commandQuery !== null ? "" : current);
    setCommandQuery(null);
    inputRef.current?.focus();
  };

  /**
   * 跑一轮对话：优先流式（事件边到边出），终止状态以事件为准。
   * `send` 与 `retry` 共用这一份实现，避免两套路径给出不同的成功语义。
   */
  /** 最新记忆快照：供适配层在每个外发点重新筛选。 */
  const memoryRef = useRef(memory);
  useEffect(() => {
    memoryRef.current = memory;
  }, [memory]);

  const finishMessageProcess = (sessionId: string, messageId: string, outcome: NonNullable<WorkbenchMessage["process"]>["outcome"]) => {
    const process = useWorkbenchStore.getState().sessions.find(item => item.id === sessionId)?.messages.find(item => item.id === messageId)?.process;
    if (process && outcome) updateMessage(sessionId, messageId, { process: finishProcess(process, outcome) });
  };

  const runTurn = async (options: {
    sessionId: string;
    assistantId: string;
    request: WorkbenchRequest;
    controller: AbortController;
    /** 本回合是否跳过记忆：由调用方在回合开始时确定并消费一次。 */
    bypassMemory?: boolean;
    /** 本回合冻结的图片候选（只从当前会话派生，不持久化）。 */
    imageSources?: ImageSourceCatalog;
    /** R1：重试/恢复时沿用原计划与尝试投影（不重新规划）。 */
    imageResume?: { plan: ImageTaskPlan; attempts: ImageAttemptProjection[]; regenerateUnknown?: boolean };
  }): Promise<{ ok: boolean; result?: WorkbenchResult; batch?: true }> => {
    const { sessionId, assistantId, request, controller, bypassMemory = false, imageSources, imageResume } = options;
    /** 回合结束立即提交；失败保留回复并提示可重试保存（不重试模型）。 */
    const commit = async () => {
      const current = messageOf();
      if (current && current.status !== "pending") finishMessageProcess(sessionId, assistantId,
        current.status === "failed" ? terminal === "timeout" ? "timeout" : "error" : terminal ?? "stop");
      if (!sessionApi) return true;
      const saved = await commitSession(sessionApi, sessionId);
      if (!saved) {
        updateMessage(sessionId, assistantId, { saveFailed: true });
        const reason = useWorkbenchStore.getState().saveErrors[sessionId];
        setNotice(`回复已保留在当前页面，但保存失败；可重试保存。${reason ? `原因：${reason}` : ""}`);
      }
      return saved;
    };
    /** 本回合的执行总量：初始是本轮附件，解析出图片请求后换成那份快照的来源。 */
    let executionSources = request.attachments;
    /** 本轮是否出现过保存失败（是否仍在失败由最终提交结果决定，不用它冒充当前状态）。 */
    let saveFailureSeen = false;
    /**
     * R1（C2）：有计划的任务从任务项/尝试投影派生进度；旧消息（无计划）沿用工具块口径。
     * 完成口径：最新尝试已成功**且**产物已作为附件写入本条消息。
     */
    const messageOf = () =>
      useWorkbenchStore.getState().sessions.find(item => item.id === sessionId)
        ?.messages.find(item => item.id === assistantId);
    if (!messageOf()?.process) updateMessage(sessionId, assistantId, { process: startProcess() });
    const executionProgress = () => {
      const message = messageOf();
      if (message?.imagePlan) {
        const progress = imagePlanProgress(message.imagePlan, message.imageAttempts ?? [], message.attachments ?? []);
        return { total: progress.total, completed: progress.completed, completedSourceIds: progress.completedItemIds,
          unfinished: progress.items.filter(item => !item.attachment).map(item => ({
            id: item.sourceIds[0] ?? item.itemId,
            name: message.imagePlan!.sources.find(source => source.sourceId === item.sourceIds[0])?.name ?? item.itemId,
            state: item.pendingState
          })) };
      }
      return imageEditProgress(message?.request?.attachments ?? executionSources, message?.tools);
    };
    const deliveredSources = new Set(executionProgress().completedSourceIds);
    /*
     * 用户选择「本次不用记忆」时，本轮**完全不提供**记忆来源：
     * 即使随后初始化完成、或别的标签放开了许可，也不会带进这次请求。
     */
    const turnContext = bypassMemory
      ? { sessionId }
      : {
          sessionId,
          ...(memory ? { memory } : {}),
          getMemory: () => memoryRef.current,
          // 每个外发点向权威来源重读，感知其他标签的撤销/删除。
          ...(ensureMemory ? { ensureMemory } : {})
        };
    /**
     * 部分完成核对：正常收尾、error/timeout 与异常收尾共用同一份判定。
     * 有计划时按任务项/尝试投影；旧消息按已解析请求与工具块。
     */
    const partialImages = () => {
      const stored = messageOf();
      if (stored?.imagePlan) {
        const progress = imagePlanProgress(stored.imagePlan, stored.imageAttempts ?? [], stored.attachments ?? []);
        return { sources: stored.request?.intent === "image-edit" ? stored.request.attachments : [],
          images: stored.attachments ?? [], tools: stored.tools ?? [],
          total: progress.total, completed: progress.completed, completedItemIds: progress.completedItemIds,
          unfinished: progress.items.filter(item => !item.attachment) };
      }
      const sources = stored?.request?.intent === "image-edit" ? stored.request.attachments : [];
      const images = stored?.attachments ?? [];
      const tools = stored?.tools ?? [];
      return { sources, images, tools,
        total: imageEditProgress(sources, tools).total,
        completed: imageEditProgress(sources, tools).completed,
        completedItemIds: imageEditProgress(sources, tools).completedSourceIds,
        unfinished: imageEditProgress(sources, tools).unfinished.map(source => ({ sourceIds: [source.id], pendingState: undefined, instruction: "", itemId: source.id, detail: undefined })) };
    };

    /** 部分完成的收尾：先写完整状态再提交，提交失败才提示重试保存。 */
    const finishPartialImages = async (note: string, prefix = "") => {
      const partial = partialImages();
      const tools = partial.tools;
      const unknownCount = partial.unfinished.filter(item => item.pendingState === "outcome_unknown").length;
      updateMessage(sessionId, assistantId, {
        status: "failed",
        tools,
        saveFailed: undefined,
        text: `${prefix}已完成 ${partial.completed}/${partial.total} 张，还有 ${partial.unfinished.length} 张未完成。${saveFailureSeen ? "本轮曾因保存失败停止后续修改。" : ""}${note}`,
        error: unknownCount > 0
          ? `图片没有全部完成：${unknownCount} 项结果未知；未自动重新生成，可显式「重新生成」。`
          : saveFailureSeen
            ? "图片没有全部完成：本轮曾因保存失败停止修改；可重试未完成的图片。"
            : "图片没有全部完成；可以用「重试未完成的图片」只补未完成的那几张。"
      });
      // 保存的快照必须包含 failed、N/M 与逐张状态；提交后不再修改成功状态。
      const saved = await commit();
      if (!saved || useWorkbenchStore.getState().saveStates[sessionId] === "error") {
        updateMessage(sessionId, assistantId, {
          saveFailed: true,
          error: "图片没有全部完成：会话尚未保存成功，请先重试保存，再补修未完成的图片。"
        });
      } else setNotice(undefined);
      return { ok: false, batch: true as const };
    };

    /*
     * 本轮图片候选与「图片执行状态」回调：回调绑定**最初的** sessionId/assistantId，
     * 先把计划/尝试投影（以及可选的已解析请求、新产物附件）写回这条回答并落盘；
     * 保存失败就不继续调用图片服务（执行器在每个出站屏障前调用）。
     */
    const imageTurnContext = {
      ...(imageSources?.sources.length ? { imageSources: imageSources.sources } : {}),
      ...(imageSources?.truncated ? { imageSourcesTruncated: true } : {}),
      ...(imageSources?.unreadable ? { imageSourcesUnreadable: imageSources.unreadable } : {}),
      ...(imageSources?.expectedCount ? { expectedSourceCount: imageSources.expectedCount } : {}),
      assistantMessageId: assistantId,
      ...(imageResume ? { imageResume } : {}),
      onImageStateResolved: async (state: {
        plan: ImageTaskPlan;
        attempts: ImageAttemptProjection[];
        request?: WorkbenchRequest;
        attachment?: MessageAttachment;
      }) => {
        // 本回合的执行总量以这份已解析快照为准（自然续接的原始附件是空的）。
        if (state.request) executionSources = state.request.attachments;
        const current = messageOf();
        const attachments = state.attachment
          ? [...(current?.attachments ?? []), state.attachment]
            .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index)
          : current?.attachments;
        updateMessage(sessionId, assistantId, {
          ...(state.request ? { request: state.request } : {}),
          imagePlan: state.plan,
          imageAttempts: state.attempts,
          ...(attachments ? { attachments } : {})
        });
        const saved = await commit();
        if (!saved) {
          saveFailureSeen = true;
          const reason = useWorkbenchStore.getState().saveErrors[sessionId];
          throw new SessionSaveFailureError(`图片请求已确定，但会话保存失败；已停止本次图片调用。${reason ? `原因：${reason}` : ""}请重试保存后再试。`);
        }
      }
    };
    const streaming = typeof adapter.stream === "function";
    let frozenEpoch: number | undefined;
    // 重试是新片段，预留一个边界序号，不能续接上一轮最后的流式文本。
    const priorSequence = messageOf()?.eventSequence ?? 0;
    const sequenceOffset = priorSequence > 0 ? priorSequence + 1 : 0;
    let receivedSequence = 0;
    let live = "";
    /** 总量保留供旧接口兼容；实际展示按 blocks 中的发生位置分段。 */
    let thinking = "";
    /** 终止状态以事件为准：error/timeout/error-done 都算失败，绝不默认成功。 */
    let terminal: "stop" | "cancelled" | "limit" | "timeout" | "error" | undefined;
    let streamError: string | undefined;
    /** 读回当前这条消息上的工具块（事件是增量的，必须基于最新状态追加）。 */
    const toolsOf = (targetSession: string, targetMessage: string) =>
      useWorkbenchStore
        .getState()
        .sessions.find(item => item.id === targetSession)
        ?.messages.find(item => item.id === targetMessage)?.tools ?? [];
    const trace = (line: string) =>
      updateMessage(sessionId, assistantId, {
        traces: [
          ...(useWorkbenchStore
            .getState()
            .sessions.find(item => item.id === sessionId)
            ?.messages.find(item => item.id === assistantId)?.traces ?? []),
          line
        ]
      });

    let result: WorkbenchTurnResult;
    try {
      result = streaming
        ? await adapter.stream!({ ...request, ...turnContext, ...imageTurnContext, signal: controller.signal,
          // P2-c：屏障代数由 onBeforeDeliver 捕获；切号后旧 finally 不解新冻结。

          onBeforeDeliver: async () => {
            // F4/P2-c：冻结新检查点（绑定当前账号代数）+ 收拢在途/已排队保存。
            frozenEpoch = freezeSessionCheckpoints(sessionId);
            await awaitSessionSaves(sessionId);
          },
          onAfterDeliver: () => thawSessionCheckpoints(sessionId, frozenEpoch) }, async event => {
          if (controller.signal.aborted) return; // 取消后丢弃晚到事件
          const sequence = event.sequence ?? receivedSequence + 1;
          if (sequence <= receivedSequence) return; // 有序流重放不重复正文或工具结果
          receivedSequence = sequence;
          if (event.type === "image_result" && deliveredSources.has(event.sourceId)) return;
          const currentMessage = messageOf();
          if (!currentMessage) return;
          updateMessage(sessionId, assistantId, appendTimelineEvent(currentMessage, { ...event, sequence: sequenceOffset + sequence }));
          if (sessionApi) scheduleCheckpoint(sessionApi, sessionId);
          if (event.type === "text") {
            live += event.delta;
            updateMessage(sessionId, assistantId, { text: live });
            // 合并检查点：约 1 秒一次，不按 token 写库。
            if (sessionApi) scheduleCheckpoint(sessionApi, sessionId);
            return;
          }
          if (event.type === "image_advice") {
            updateMessage(sessionId, assistantId, { imageAdvice: event.advice });
            if (sessionApi) scheduleCheckpoint(sessionApi, sessionId);
            return;
          }
          if (event.type === "stage") {
            if (event.stage !== "planning") trace(`阶段：${event.label}`);
            return;
          }
          if (event.type === "reasoning") {
            thinking += event.delta;
            updateMessage(sessionId, assistantId, { reasoning: thinking });
            if (sessionApi) scheduleCheckpoint(sessionApi, sessionId);
            return;
          }
          if (event.type === "tool_call") {
            /*
             * 同一个 id 就地更新而不是追加：重试未完成项时会重新发出同 id 的调用，
             * 追加会留下永不配对的重复块（结果只更新第一个匹配项）。
             */
            // 重新发出的同 id 调用要重开计时（结果是按最新一次调用计时的）。
            const current = toolsOf(sessionId, assistantId);
            const index = current.findIndex(tool => tool.id === event.id);
            const startedAt = current[index]?.ok === undefined ? current[index]?.startedAt ?? Date.now() : Date.now();
            const next = index >= 0
              ? current.map((tool, position) => position === index
                  ? { ...tool, name: event.name, title: event.title, argsDigest: event.argsDigest, ok: undefined, cancelled: undefined, summary: undefined, search: undefined, truncated: undefined, ms: undefined, startedAt }
                  : tool)
              : [...current, { id: event.id, name: event.name, title: event.title, argsDigest: event.argsDigest, startedAt }];
            updateMessage(sessionId, assistantId, { tools: next });
            if (sessionApi) scheduleCheckpoint(sessionApi, sessionId);
            return;
          }
          if (event.type === "tool_result") {
            // 结果回到它自己的调用块上；找不到对应调用（例如重放半个流）才补一块。
            const current = toolsOf(sessionId, assistantId);
            const index = current.findIndex(tool => tool.id === event.id);
            const startedAt = current[index]?.startedAt;
            const ms = startedAt === undefined ? undefined : Math.max(0, Date.now() - startedAt);
            const parsedSearch = event.ok && event.name === "web_search" ? NATIVE_SEARCH_RESULT.safeParse(event.search) : undefined;
            const search = parsedSearch?.success && parsedSearch.data.sources.length ? parsedSearch.data : undefined;
            const next = index >= 0
              ? current.map((tool, position) => position === index
                  ? {
                      ...tool,
                      ok: event.ok,
                      startedAt: undefined,
                      cancelled: undefined,
                      summary: event.summary,
                      search,
                      truncated: event.truncated,
                      ...(ms === undefined ? {} : { ms }),
                    }
                  : tool)
              : [...current, {
                  id: event.id, name: event.name, title: event.name, argsDigest: "",
                  ok: event.ok, summary: event.summary, search, truncated: event.truncated, ...(ms === undefined ? {} : { ms })
                }];
            updateMessage(sessionId, assistantId, { tools: next });
            if (sessionApi) scheduleCheckpoint(sessionApi, sessionId);
            return;
          }
          if (event.type === "image_result") {
            if (deliveredSources.has(event.sourceId)) return;
            deliveredSources.add(event.sourceId);
            /*
             * R1：事件把产物合并进附件（按 id 去重）；保存由 onImageStateResolved 桥
             * 承担（Tsave 屏障在执行器内），这里不再做第二次保存。直接调用本事件的
             * 替身适配器（无状态桥）也能正确显示进度。
             */
            const current = messageOf();
            const images = [...(current?.attachments ?? []), event.attachment]
              .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
            const progress = executionProgress();
            updateMessage(sessionId, assistantId, {
              attachments: images,
              text: `已完成 ${progress.completed}/${progress.total} 张，正在继续修改…`
            });
            return;
          }
          if (event.type === "call") {
            const current = messageOf();
            const calls = current?.calls ?? [];
            updateMessage(sessionId, assistantId, { calls: calls.some(call => call.callId === event.call.callId)
              ? calls.map(call => call.callId === event.call.callId ? { ...call, ...event.call } : call)
              : [...calls, event.call] });
            // 元信息更新同一调用；进行中状态由时间线条目展示，不追加重复兼容轨迹。
            if (event.call.endedAt === undefined) return;
            // 模型请求耗时可核对（§7.1）：工具耗时已有工具块，模型调用耗时入轨迹行。
            const ms = event.call.endedAt - event.call.startedAt;
            return trace(`调用 ${event.call.stage} · ${formatDuration(ms)}${event.call.usage ? ` · 输入 ${event.call.usage.inputTokens ?? "?"} / 输出 ${event.call.usage.outputTokens ?? "?"} tokens` : " · 用量未知"}`);
          }
          if (event.type === "step") return; // 决策预算不是用户工作进度
          if (event.type === "notice") {
            return trace(event.message);
          }
          if (event.type === "usage")
            return trace(`用量：输入 ${event.inputTokens ?? "?"} / 输出 ${event.outputTokens ?? "?"}`);
          if (event.type === "error") {
            streamError = event.message;
            return trace(`错误：${event.message}`);
          }
          if (event.type === "done") {
            terminal = event.reason;
            finishMessageProcess(sessionId, assistantId, event.reason);
          }
        })
        : await adapter.send({ ...request, ...turnContext, ...imageTurnContext, signal: controller.signal });
    } catch (error) {
      // 显式多图等直达路径会直接抛错；部分完成仍走同一份逐张状态收尾。
      const aborted = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
      finishMessageProcess(sessionId, assistantId, aborted ? "cancelled" : "error");
      updateMessage(sessionId, assistantId, { tools: settleWorkbenchTools(toolsOf(sessionId, assistantId), aborted) });
      const partial = partialImages();
      if (!aborted && partial.sources.length > 1 && partial.images.length > 0 && partial.unfinished.length > 0) {
        return await finishPartialImages("（本轮遇到错误，已停止后续修改。）", live.trim() ? `${live}\n\n` : "");
      }
      throw error;
    }

    if (controller.signal.aborted || terminal === "cancelled") {
      updateMessage(sessionId, assistantId, { tools: settleWorkbenchTools(toolsOf(sessionId, assistantId), true) });
      throw new DOMException("已取消", "AbortError");
    }
    /*
     * R1：有计划的消息，工具块由执行器按任务项发出（id = image-edit-<itemId>），
     * 状态以尝试投影派生——这里不再按来源追加第二套「已完成」块。
     */
    const hasPlan = !!useWorkbenchStore.getState().sessions.find(item => item.id === sessionId)
      ?.messages.find(item => item.id === assistantId)?.imagePlan;
    const storedRequest = useWorkbenchStore.getState().sessions.find(item => item.id === sessionId)
      ?.messages.find(item => item.id === assistantId)?.request;
    const singleSources = request.intent === "image-edit" && request.attachments.length
      ? request.attachments : storedRequest?.intent === "image-edit" ? storedRequest.attachments : [];
    const completedSources = hasPlan ? [] : result.kind === "image-batch" ? result.images.map(item => ({ id: item.sourceId, name: item.sourceName }))
      : result.kind === "image" && result.dataUrl && singleSources.length === 1 ? singleSources : [];
    if (completedSources.length) {
      const tools = [...toolsOf(sessionId, assistantId)];
      for (const source of completedSources) {
        const id = `image-edit-${source.id}`;
        const index = tools.findIndex(tool => tool.id === id);
        const completed = { ...(index < 0 ? { id, name: "image-edit", title: source.name, argsDigest: "" } : tools[index]!),
          ok: true, summary: "已完成" };
        if (index < 0) tools.push(completed);
        else tools[index] = completed;
      }
      updateMessage(sessionId, assistantId, { tools });
    }
    const failed = terminal === "error" || terminal === "timeout";
    if (failed) {
      updateMessage(sessionId, assistantId, { tools: settleWorkbenchTools(toolsOf(sessionId, assistantId)) });
      /*
       * 规划/回答失败或超时同样要核对部分完成：首图已生成但保存失败时，
       * 这里不能只留一句通用失败文案而丢掉 1/2 与补修入口。
       */
      const partial = partialImages();
      if (partial.sources.length > 1 && partial.images.length > 0 && partial.unfinished.length > 0) {
        return await finishPartialImages(
          streamError ?? (terminal === "timeout" ? "（本轮生成超时，已停止后续修改。）" : "（本轮生成没有完成，已停止后续修改。）"),
          live.trim() ? `${live}\n\n` : ""
        );
      }
      updateMessage(sessionId, assistantId, {
        status: "failed",
        saveFailed: undefined,
        error: streamError ?? (terminal === "timeout" ? "这次生成超时。" : "这次生成没有完成。"),
        // 失败也保留已经到达的部分正文。
        text: saveFailureSeen && partial.images.length === 0
          ? "图片未生成：本轮曾因会话保存失败停止图片调用。"
          : live || "生成失败。"
      });
      const saved = await commit();
      if (!saved) updateMessage(sessionId, assistantId, { saveFailed: true, error: "最终状态未保存到本地，请先重试保存。" });
      else setNotice(undefined);
      return { ok: false };
    }
    if (result.kind === "image-batch") {
      /*
       * 部分完成后再重试时这条回答已经有成功附件：合并而不是覆盖，
       * 总量仍按该条回答的**全量**已解析来源算（本次只重试了未完成的那几张）。
       */
      const existing = useWorkbenchStore.getState().sessions.find(item => item.id === sessionId)
        ?.messages.find(item => item.id === assistantId)?.attachments ?? [];
      const merged = [...existing, ...result.images.map(item => item.attachment)]
        .filter((attachment, index, all) => all.findIndex(item => item.id === attachment.id) === index);
      updateMessage(sessionId, assistantId, { attachments: merged });
      const progress = executionProgress();
      if (progress.unfinished.length && merged.length)
        return await finishPartialImages("", live.trim() ? `${live}\n\n` : "");
      updateMessage(sessionId, assistantId, {
        status: merged.length > 0 ? "done" : "failed",
        result: undefined,
        attachments: merged,
        text: `${live.trim() ? `${live}\n\n` : ""}已修改 ${progress.completed}/${progress.total} 张图片${result.failures.length ? `；${result.failures.length} 张失败，原因见上方逐张状态。` : "。"}`,
        error: merged.length > 0 ? undefined : "所有图片修改失败；查看逐张原因后可重试。"
      });
      await commit();
      return { ok: merged.length > 0, batch: true };
    }
    /*
     * 生图/修图的结果**同时作为这条消息的附件**：对话区就地显示图片，
     * 用户在同一段对话里继续看图、继续改；会话持久化本身带 dataUrl，
     * 刷新后图片仍在，图片下方操作行负责后续保存和下载。
     * 部分完成后重试的收尾（只重放了未完成的那几张）要**追加**而不是覆盖已有图片。
     */
    const previousAttachments = useWorkbenchStore.getState().sessions.find(item => item.id === sessionId)
      ?.messages.find(item => item.id === assistantId)?.attachments ?? [];
    const appended = result.kind === "image" && result.dataUrl
      ? { id: result.id, name: imageAttachmentName(result), dataUrl: result.dataUrl }
      : undefined;
    const mergedAttachments = appended
      ? [...previousAttachments, appended].filter((attachment, index, all) => all.findIndex(item => item.id === attachment.id) === index)
      : previousAttachments;
    const retryRemainder = appended !== undefined && previousAttachments.length > 0 && request.intent === "image-edit";
    /*
     * 未完成来源：正常收尾同样要核对（自然续接在首张之后的写库失败会让工具层
     * 把错误交给结果交付），不把这一回合标成完成，并补出补修入口。
     */
    const partial = partialImages();
    if (partial.sources.length > 1 && partial.images.length > 0 && partial.unfinished.length > 0) {
      return await finishPartialImages("", live.trim() ? `${live}\n\n` : "");
    }
    if (saveFailureSeen && mergedAttachments.length === 0) {
      // 快照保存失败后图片工具在本轮禁用；模型的文字收尾不能冒充出图成功。
      updateMessage(sessionId, assistantId, {
        status: "failed",
        saveFailed: undefined,
        text: "图片未生成：本轮曾因会话保存失败停止图片调用。",
        error: "图片请求未完成；可在会话保存恢复后重试本轮。"
      });
      const saved = await commit();
      if (!saved) updateMessage(sessionId, assistantId, { saveFailed: true, error: "会话尚未保存成功，请先重试保存。" });
      else setNotice(undefined);
      return { ok: false };
    }
    updateMessage(sessionId, assistantId, {
      status: "done",
      result,
      ...(mergedAttachments.length ? { attachments: mergedAttachments } : {}),
      /*
       * 只补修未完成项时，回答正文之外仍要给出**全量**进度（与批量分支同一写法），
       * 否则用户看不到“还差几张”。流式已有正文时不要用结果标题把它覆盖掉。
       */
      text: retryRemainder
        ? `${live.trim() ? `${live}\n\n` : ""}已修改 ${executionProgress().completed}/${executionProgress().total} 张图片。`
        : streaming && live.trim() ? live : resultToMessage(result)
    });
    await commit();
    return { ok: true, result };
  };

  /**
   * 运行中把输入框里的内容收进队列（正文/意图/引用/附图/选中的结果一起快照），输入框当场清空。
   * `position: "head"` 给"立即发送"用：这条插到队首，本轮被打断后会先发它。
   */
  const enqueueDraft = (position: "tail" | "head" = "tail"): boolean => {
    if (!activeId) return false;
    if (preparingNoteImage) { setNotice("正在准备图片，请稍候再加入队列。"); return false; }
    if (readingImagesRef.current) { setNotice("正在添加图片，请稍候再加入队列。"); return false; }
    const body = text.trim();
    if (!body && references.length === 0 && attachments.length === 0 && skillReferences.length === 0) return false;
    const entry: QueuedTurn = { id: createCaptureId("queue"), sessionId: activeId, text: body, intent,
      ...(imageToolOpen ? { imageRequested: true as const } : {}),
      references, attachments, skillReferences: skillReferences.map(ref => ({ ...ref })), sourceResultChoice };
    setQueued(position === "head" ? [entry, ...queueRef.current] : [...queueRef.current, entry]);
    setText("");
    setReferences([]);
    setSkillReferences([]);
    setAttachments([]);
    setSourceResultChoice(undefined);
    if (position === "tail") setNotice("已加入队列；本轮结束后自动发送。");
    return true;
  };

  /**
   * 立即发送：正文插到队首并打断当前轮——本轮收尾时会先发它，后面的排队项照旧跟着发。
   * 不做"插进正在跑的那一轮"：那一轮的请求在开始时已经固定，没有中途注入通道（见任务记录）。
   */
  const sendQueuedNow = () => {
    const inserted = enqueueDraft("head");
    if (!inserted && queueRef.current.length === 0) { setNotice("先写下要发送的内容。"); return; }
    setNotice("已打断当前一轮；马上发送这条。");
    abortRef.current?.abort();
  };

  const openQueueMenu = (handle: HTMLButtonElement, id: string, kind: NonNullable<typeof queueMenu>["kind"]) => {
    queueMenuTrigger.current = handle;
    const rect = handle.getBoundingClientRect(), panel = queuePanelRef.current!.getBoundingClientRect();
    const height = kind === "order" ? 100 : 56;
    setQueueMenu(queueMenuStateRef.current?.id === id && queueMenuStateRef.current.kind === kind ? undefined : {
      id, kind, top: rect.bottom + height < window.innerHeight ? rect.bottom - panel.top : rect.top - panel.top - height,
      right: Math.max(0, Math.min(panel.width - 152, panel.right - rect.right))
    });
  };
  const moveQueued = (id: string, targetId: string) => {
    const entries = queueRef.current, from = entries.findIndex(item => item.id === id), to = entries.findIndex(item => item.id === targetId);
    if (queueEditRef.current || from < 0 || to < 0 || from === to) return;
    const starting = entries.findIndex(item => item.id === queuedStartingRef.current);
    if (starting >= Math.min(from, to) && starting <= Math.max(from, to)) return;
    const reordered = entries.filter(item => item.id !== id);
    reordered.splice(to, 0, entries[from]);
    setQueued(reordered);
    setNotice(`已移到第 ${to + 1} 条。`);
  };
  const moveQueuedBy = (direction: -1 | 1) => {
    const id = queueMenuStateRef.current?.id, entries = queueRef.current;
    const index = entries.findIndex(entry => entry.id === id), target = entries[index + direction];
    if (id && index >= 0 && target) moveQueued(id, target.id);
    setQueueMenu(undefined);
    queueMenuTrigger.current?.focus({ preventScroll: true });
  };
  const finishQueueDrag = (commit: boolean, point?: { x: number; y: number }) => {
    const drag = queueDragRef.current;
    if (!drag) return;
    queueDragRef.current = undefined;
    setQueueDrop(undefined);
    if (commit && drag.sessionId === useWorkbenchStore.getState().activeId) {
      const bounds = drag.handle.closest("ol")?.getBoundingClientRect();
      if (!drag.moved && !drag.wasOpen) openQueueMenu(drag.handle, drag.id, "order");
      else if (point && bounds && point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom) {
        moveQueued(drag.id, drag.targetId);
      }
    }
    if (drag.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
    resumeQueue();
  };
  const saveQueueEdit = (resume = true): boolean => {
    const edit = queueEditRef.current;
    if (!edit) return true;
    const item = queueRef.current.find(entry => entry.id === edit.id);
    if (!item) { setQueueEdit(undefined); return false; }
    const body = edit.text.trim();
    if (!body && !item.attachments.length && !item.references.length && !item.skillReferences?.length) {
      setNotice("待办内容不能为空。");
      queueEditorRef.current?.focus();
      return false;
    }
    setQueued(queueRef.current.map(entry => entry.id === edit.id ? { ...entry, text: body } : entry));
    setQueueEdit(undefined);
    if (resume) resumeQueue();
    return true;
  };
  const cancelQueueEdit = () => { setQueueEdit(undefined); resumeQueue(); };
  const runQueuedNow = (id: string) => {
    if (queuedStartingRef.current === id) return;
    if (queueEditRef.current && (queueEditRef.current.id !== id || !saveQueueEdit(false))) return;
    const item = queueRef.current.find(entry => entry.id === id);
    if (!item) return;
    if (item.sessionId !== useWorkbenchStore.getState().activeId) {
      setNotice("请返回这条待办所属的会话后执行。"); return;
    }
    setQueueMenu(undefined);
    setQueued([item, ...queueRef.current.filter(entry => entry.id !== id)]);
    if (abortRef.current) {
      setNotice("正在停止当前任务，随后立即执行这条待办。");
      abortRef.current.abort();
    } else resumeQueue();
  };
  const removeQueued = (id: string) => {
    if (queuedStartingRef.current === id) { setNotice("这条待办正在启动，请使用取消按钮停止。"); return; }
    setQueueMenu(undefined);
    if (queueEditRef.current?.id === id) setQueueEdit(undefined);
    setQueued(queueRef.current.filter(entry => entry.id !== id));
    resumeQueue();
  };

  /**
   * 发送一轮。`queued` 是排队项：正文/意图/引用/附图/选中的结果都用**入队时的快照**，
   * 其余（范围、制图模型、尺寸、风格、记忆许可）按发出时的当前状态走。
   */
  const send = async (queued?: QueuedTurn) => {
    if (!mountedRef.current || abortRef.current) return;
    // 回合开始即取消在途检查点：原生任务交付会推高会话 revision（§9.1 交付保护），
    // 回合中带旧 revision 的自动保存必然冲突并中止回合；收尾由 commitSession 统一提交。
    const activeSessionIdForTurn = useWorkbenchStore.getState().activeId;
    if (activeSessionIdForTurn) clearCheckpoint(activeSessionIdForTurn);
    // native 附件：发送前把本轮 prepared 媒体先提交入库（媒体行+links），消息引用随后落库。
    if (nativeAttachments && pendingPreparedRef.current.length > 0) {
      const prepared = [...pendingPreparedRef.current];
      pendingPreparedRef.current = [];
      try { await nativeAttachments.commit(prepared); }
      catch { pendingPreparedRef.current = prepared; throw new Error("附件原件未能保存，本轮未发送；请重试。"); }
    }
    if (queued) {
      queued = queueRef.current.find(item => item.id === queued?.id);
      if (!queued || queueEditRef.current || queueDragRef.current || queueMenuStateRef.current?.kind === "order") return;
      const state = useWorkbenchStore.getState();
      if (queued.sessionId !== state.activeId) return;
      if (state.saveStates[queued.sessionId] === "error" || state.saveStates[queued.sessionId] === "conflict" ||
        state.sessions.find(item => item.id === queued?.sessionId)?.messages.some(item => item.saveFailed)) {
        setNotice("会话尚未保存成功，请先重试保存，再执行待办。"); return;
      }
    }
    const turnText = queued ? queued.text : text;
    const turnIntent = queued ? queued.intent : intent;
    const turnReferences = queued ? queued.references : references;
    const turnAttachments = queued ? queued.attachments : attachments;
    const turnSkills = queued ? queued.skillReferences ?? [] : skillReferences;
    const turnChoice = queued ? queued.sourceResultChoice : sourceResultChoice;
    const turnSourceResult = turnChoice && turnChoice.sessionId === activeId ? turnChoice.result : undefined;
    const turnSourceImageResult = turnSourceResult?.kind === "image" ? turnSourceResult : undefined;
    /*
     * J6：原生（任务宿主）模式没有桌面 create_artwork 计划工具——图像生成入口
     * 走显式图像意图任务（payload.intent=image-edit/generate，宿主图像执行服务）。
     * 打开图像工具（imageRequested）且未绑定源图/附件时按生成意图直发；有源图
     * 走既有的"继续修改"（image-edit）路径。
     */
    const directImageIntent = turnIntent === "image-generate" || turnIntent === "image-edit";
    const imageRequested = queued ? queued.imageRequested === true : imageToolOpen;
    if (preparingNoteImage) { setNotice("正在准备图片，请稍候再发送。"); return; }
    if (readingImagesRef.current) { setNotice("正在添加图片，请稍候再发送。"); return; }
    if (abortRef.current) return;
    if (!requestAllowed) { setNotice(requestBlockReason ?? "请先选择对话模型。"); return; }
    // 会话尚未从本地读取完成（或读取失败）：先解决它，避免覆盖已有记录。
    if (sessionApi && sessionStatus !== "ready") {
      setNotice(sessionStatus === "loading" ? "正在读取本地会话…" : (sessionError ?? "读取本地会话失败，未发送。"));
      return;
    }
    // 记忆未就绪或读取失败：先让用户明确选择，不静默降级继续发送。
    if (!directImageIntent && !imageRequested && !memoryBypass && memoryStatus !== "ready") {
      setNotice(
        memoryStatus === "loading"
          ? "正在读取本地记忆；可稍候，或选择「本次不用记忆」继续。"
          : "读取本地记忆失败；可重试，或选择「本次不用记忆」继续。"
      );
      return;
    }
    const body = turnText.trim();
    const referencedCount = body ? referencedImageCount(body) : undefined;
    if ((directImageIntent || imageRequested) && !body) {
      setNotice("先写下图片生成或修改要求。");
      return;
    }
    let reusedHistoryAttachments: MessageAttachment[] | undefined;
    if (referencedCount !== undefined) {
      if (referencedCount > CREATION_VISION_LIMITS.images) {
        setNotice(`一次最多处理 ${CREATION_VISION_LIMITS.images} 张图片，请分批附加。`);
        return;
      }
      if (turnAttachments.length > 0 && turnAttachments.length !== referencedCount) {
        setNotice(`你提到 ${referencedCount} 张图片，但本轮附加了 ${turnAttachments.length} 张；请重新选择要处理的图片。`);
        return;
      }
      /*
       * 自然聊天（intent=chat）**不**用旧的“数量 + 最后一组”规则先行否决：
       * 会话里有多个同数量图片组时，该规则只会报 ambiguous，而真正指向哪一组要由计划轮
       * 结合候选身份、来源类别与前轮建议判断（用户说“刚生成的这两张”时旧规则必然误判）。
       * 这里只保留代码能确定的事：上限，以及**显式工具**（修改图片）的复用选择。
       */
      if (turnAttachments.length === 0 && turnIntent === "image-edit") {
        if (turnSourceImageResult && referencedCount !== 1) {
          setNotice(`本轮已选中 1 张图片，但你提到 ${referencedCount} 张；请重新附加想处理的图片。`);
          return;
        }
        if (!turnSourceImageResult) {
          const reusable = resolveReusableImageGroup(session?.messages ?? [], referencedCount, CREATION_VISION_LIMITS.images);
          if (reusable.kind !== "match") {
            setNotice(reusable.kind === "ambiguous"
              ? `当前会话有多个符合数量的图片组；请重新附加想处理的 ${referencedCount} 张图片。`
              : reusable.kind === "unreadable"
                ? "找到对应图片组，但其中有图片无法读取；请重新附加整组图片。"
                : reusable.kind === "too-many"
                  ? `一次最多处理 ${CREATION_VISION_LIMITS.images} 张图片，请分批附加。`
                  : `当前会话没有找到对应的 ${referencedCount} 张图片；请附加或选择要修改的图片。`);
            return;
          }
          reusedHistoryAttachments = reusable.attachments;
        }
      }
    }
    if (!body && turnReferences.length === 0 && turnAttachments.length === 0 && turnSkills.length === 0) {
      // 输入框空但队列里还有（例如刚因保存失败停下）：直接把队首先发出去，不让它悬着。
      const pendingHead = queued ? undefined : queueRef.current[0];
      if (pendingHead) { void send(pendingHead); return; }
      setNotice("先写点内容，或引用随记素材、附加一张图片。");
      return;
    }
    if (turnIntent === "image-edit" && !turnAttachments.length && !turnSourceImageResult) {
      const catalog = deriveImageSources(session?.messages ?? []);
      const numbered = resolveImageNumbers(body, catalog.sources, historyWithImageSources(session?.messages ?? [], catalog.sources));
      if (numbered && !numbered.ok) { setNotice(numbered.detail); return; }
      if (numbered?.ok) reusedHistoryAttachments = numbered.sourceIds.map(id => {
        const source = catalog.sources.find(source => source.sourceId === id)!;
        return { id: source.sourceId, name: source.name, dataUrl: source.dataUrl! };
      });
    }
    const requestAttachments = turnAttachments.length ? turnAttachments : reusedHistoryAttachments ?? turnAttachments;
    // J6：原生直发图像意图——打开图像工具（生成/编辑）即按显式图像意图直发；
    // 附图作为图像材料（sourceRefs），无附件为纯生成。
    const nativeDirectImage = !!nativeAttachments && imageRequested && !directImageIntent;
    const effectiveDirectImageIntent = directImageIntent || nativeDirectImage;
    /*
     * 本轮图片候选：只从**当前已加载会话**派生（用户附件、助手生成结果、回答侧快照），
     * 再把本轮明确附图放到最前。它们只活在本回合的请求上下文里，不写进会话字段。
     */
    const sessionMessages = session?.messages ?? [];
    const userMessageId = createCaptureId("msg");
    const derivedSources = deriveImageSources(sessionMessages);
    const imageSources: ImageSourceCatalog = {
      ...derivedSources,
      sources: withCurrentTurnSources(derivedSources.sources, requestAttachments, { messageId: userMessageId }),
      // 明确说出的张数只在**没有本轮附图**时才是对旧图的指代；有附图时用户已直接选定。
      ...(referencedCount !== undefined && requestAttachments.length === 0 ? { expectedCount: referencedCount } : {})
    };
    const selectedImage = imageTool?.models.find(model => model.id === imageTool.modelId);
    let request: WorkbenchRequest = {
      text: body || (turnSkills.length ? "请按引用的技能指导完成任务。" : body),
      ...(turnSkills.length ? { skillReferences: turnSkills.map(ref => ({ ...ref })) } : {}),
      intent: nativeDirectImage ? "image-generate" : turnIntent,
      references: effectiveDirectImageIntent ? [] : turnReferences,
      attachments: requestAttachments,
      scope: currentScope,
      ...(effectiveDirectImageIntent ? {} : { history: historyWithImageSources(sessionMessages, derivedSources.sources) }),
      targetResult: effectiveDirectImageIntent
        ? turnIntent === "image-edit"
          ? requestAttachments.length === 0
            ? turnSourceImageResult ?? (latestResult?.kind === "image" ? latestResult : undefined)
            : undefined
          : undefined
        : reusedHistoryAttachments ? undefined : turnSourceResult ?? (latestResult?.kind === "image" ? undefined : latestResult),
      ...(effectiveDirectImageIntent
        ? { imageOptions: { modelId: imageTool?.modelId ?? "", size: imageTool?.size, style: imageTool?.style ?? "none",
            ...(selectedImageFormat ? { outputFormat: selectedImageFormat } : {}) } }
        : imageTool?.modelId ? { imageOptions: {
            modelId: imageTool.modelId,
            /*
             * 纯文字续接也要固化用户在工具栏选的尺寸与风格：修图请求可能由计划轮在本轮才决定，
             * 那时再补就晚了（解析后的快照必须已经带完整选项）。普通文字回答不调用图片工具，
             * 带上这些字段不改变任何行为。
             */
            size: imageTool.size,
            style: imageTool.style ?? "none",
            ...(selectedImageFormat ? { outputFormat: selectedImageFormat } : {}),
            ...(imageRequested ? { requested: true as const } : {})
          } } : {})
    };
    if (!requestAllowedFor(request)) {
      setNotice(imageTool?.reason ?? (!imageTool?.enabled
        ? "图片能力尚未启用，请在设置中启用后再试。"
        : !selectedImage
          ? "请选择可用的制图模型。"
          : `所选制图模型不支持${turnIntent === "image-edit" ? "修改图片" : "生成图片"}。`));
      return;
    }
    try { if (!effectiveDirectImageIntent) request = adapter.prepare?.(request) ?? request; }
    catch (error) { setNotice(error instanceof Error ? error.message : "无法读取范围资料。"); return; }
    /*
     * 跳过选择只对**当前回合**有效：这里消费一次，本回合的计划轮/回答轮沿用同一个 turnContext，
     * 之后的回合必须重新面对读取屏障。
     */
    const bypassThisTurn = effectiveDirectImageIntent || imageRequested || memoryBypass;
    if (bypassThisTurn) setMemoryBypass(false);

    /*
     * 发出去什么就显示什么：选了风格/比例的"生成图片"回合，对话模型收到的是拼接后的模板
     * （适配层用同一个 composeImageInstruction 再拼一次），用户气泡也显示这一句。
     * 请求里仍然只放原文 body，重试重放与历史快照都不受显示影响。
     */
    const displayText = turnIntent === "image-generate"
      ? composeImageInstruction(body, { size: imageTool?.size, style: imageTool?.style ?? "none" }) ?? body
      : body;
    const userMessage: WorkbenchMessage = {
      id: userMessageId,
      role: "user",
      text: displayText,
      ...(turnSkills.length ? { skillReferences: turnSkills.map(ref => ({ ...ref })) } : {}),
      intent: turnIntent,
      references: effectiveDirectImageIntent ? [] : turnReferences,
      // Reused history bytes live in the retry snapshot; messageMedia shows that snapshot here
      // without persisting a second copy on this user message.
      attachments: reusedHistoryAttachments ? [] : requestAttachments,
      createdAt: new Date().toISOString()
    };
    // 没有会话就地建一个：自由对话不需要先去点「新建会话」。
    const sessionId = session?.id ?? createSession(currentScope);
    const assistantId = createCaptureId("msg");
    // 首次异步保存前即占用原控制器，快速重复点击不能启动第二轮。
    const controller = new AbortController();
    abortRef.current = controller;
    setQueuedStarting(queued?.id);
    activeRequestRef.current = request;
    if (!queued) { nearBottomRef.current = true; setAwayFromBottom(false); }
    appendMessage(sessionId, userMessage);
    appendMessage(sessionId, {
      id: assistantId,
      role: "assistant",
      blocks: [],
      eventSequence: 0,
      process: startProcess(),
      text: "",
      status: "pending",
      // 绑定本次请求：重试重放它，不受之后新增消息影响。
      request,
      createdAt: new Date().toISOString()
    });
    if (!queued) {
      setText("");
      setReferences([]);
      setSkillReferences([]);
      setAttachments([]);
      setSourceResultChoice(undefined);
      setIntent("chat");
      setImageToolOpen(false);
    }
    setNotice(undefined);
    // 模型选择随会话保存（发送不需要另一次许可，见 connected 面板的说明）。
    if (models) useWorkbenchStore.getState().setModels(sessionId, models);
    setSending(true);
    registerTurn(sessionId, controller);

    try {
      /*
       * 先落盘再发模型：原问题与 pending 占位必须在调用模型前持久化；
       * 落盘失败就保留输入并停止本轮（不制造没有记录的后台回合）。
       */
      if (sessionApi) {
        if (!session?.id) await activateSession(sessionApi, sessionId);
        const persisted = await saveSession(sessionApi, sessionId);
        if (!persisted) {
          finishMessageProcess(sessionId, assistantId, controller.signal.aborted ? "cancelled" : "error");
          const persistenceError = useWorkbenchStore.getState().saveErrors[sessionId];
          updateMessage(sessionId, assistantId, {
            status: "failed",
            saveFailed: true,
            error: persistenceError
              ? `本次未保存到本地，已停止发送。存储错误：${persistenceError} 内容仍在此处，可重试保存。`
              : "本次未保存到本地，已停止发送；内容仍在此处，可重试保存。"
          });
          setNotice(persistenceError
            ? `会话未保存到本地，未发起模型请求。存储错误：${persistenceError}`
            : "会话未保存到本地，未发起模型请求。");
          return;
        }
      }
      /*
       * 排队项确认真的要发了才出队：被上面的任何一道屏障挡下时它留在队列里，
       * 不把用户写下的内容悄悄丢掉。
       */
      if (queued) { const id = queued.id; setQueued(queueRef.current.filter(item => item.id !== id)); }
      setQueuedStarting(undefined);
      if (controller.signal.aborted) throw new DOMException("已取消", "AbortError");
      const outcome = await runTurn({ sessionId, assistantId, request, controller, bypassMemory: bypassThisTurn, imageSources });
      if (outcome.ok && outcome.result?.kind === "handbook-page" && useWorkbenchStore.getState().activeId === sessionId) {
        setPreviewId(assistantId); setPanel("preview"); setPanelOpen(true);
      } else if (outcome.ok && (outcome.result || outcome.batch)) {
        setPanelOpen(false); setPane("chat");
      }
    } catch (error) {
      const conflictAbort = controller.signal.reason instanceof DOMException && controller.signal.reason.message === SAVE_CONFLICT_REASON;
      const aborted = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
      finishMessageProcess(sessionId, assistantId, aborted ? "cancelled" : "error");
      if (conflictAbort) {
        /*
         * 保存冲突：停止本轮（模型与工具调用已随信号中止），
         * **保留已生成内容与草稿**，提示重新读取后继续。
         */
        const current = useWorkbenchStore.getState().sessions.find(item => item.id === sessionId);
        const kept = current?.messages.find(item => item.id === assistantId)?.text ?? "";
        updateMessage(sessionId, assistantId, {
          status: "failed",
          text: kept,
          tools: current?.messages.find(item => item.id === assistantId)?.tools?.map(tool => tool.ok === undefined
            ? { ...tool, ok: false, summary: "已中断" } : tool),
          saveFailed: true,
          error: "会话已在别处更新，本轮已停止；已生成内容与草稿保留，重新读取后再继续。"
        });
        setNotice("会话已在别处更新：本轮已停止，内容已保留。");
        return;
      }
      const current = useWorkbenchStore.getState().sessions.find(item => item.id === sessionId)?.messages.find(item => item.id === assistantId);
      /*
       * 批量判断与总量都读该条回答**当前已解析请求**（自然续接发出的原始附件是空的，
       * 用原始 request 会把已经改好的图当不存在，提示 1/0）；读不到就退回本回合原始请求
       * ——这里在 runTurn 作用域之外，不能引用它的局部变量。
       * R1：有计划的消息按任务项/尝试投影派生（与运行中的口径一致）。
       */
      const progress = current?.imagePlan
        ? (() => {
            const plan = imagePlanProgress(current.imagePlan, current.imageAttempts ?? [], current.attachments ?? []);
            return { total: plan.total, completed: plan.completed, completedSourceIds: plan.completedItemIds,
              unfinished: plan.items.filter(item => !item.attachment).map(item => ({ id: item.itemId, name: item.itemId })) };
          })()
        : imageEditProgress(current?.request?.attachments ?? request.attachments, current?.tools);
      const batch = progress.total > 0 && (request.intent === "image-edit" || current?.tools?.some(tool => tool.name === "image-edit"));
      const saveFailed = useWorkbenchStore.getState().saveStates[sessionId] === "error";
      updateMessage(sessionId, assistantId, {
        status: aborted ? "done" : "failed",
        text: batch ? `${aborted ? "已取消" : "已中断"}修图；已完成 ${progress.completed}/${progress.total} 张。` : aborted ? "已取消这次生成。" : "生成失败。",
        tools: settleWorkbenchTools(current?.tools, aborted),
        ...(saveFailed ? { saveFailed: true } : {}),
        error: aborted ? undefined : error instanceof Error ? error.message : "未知错误"
      });
      /*
       * SP4：抛异常或用户取消后的最终状态同样要落盘（与正常/失败终止同一条提交路径），
       * 落盘失败保留内容并给出可重试保存的提示。
       */
      if (sessionApi && !saveFailed) {
        const saved = await commitSession(sessionApi, sessionId);
        if (!saved) {
          updateMessage(sessionId, assistantId, { saveFailed: true, error: "最终状态未保存到本地，可重试保存。" });
        }
      }
      if (!aborted) setNotice(undefined);
    } finally {
      unregisterTurn(sessionId, controller);
      setSending(false);
      abortRef.current = null;
      activeRequestRef.current = undefined;
      setQueuedStarting(undefined);
      const head = queueRef.current[0];
      if (head) {
        /*
         * 会话还没保存成功就先不发下一条：保存是发送的前提（与页面其它地方同一道屏障），
         * 排队项留在队列里，等用户重试保存。
         */
        const unsaved = useWorkbenchStore.getState().sessions.find(item => item.id === sessionId)
          ?.messages.find(item => item.id === assistantId)?.saveFailed;
        if (unsaved) setNotice(`有 ${queueRef.current.length} 条排队消息未发送：会话尚未保存成功，请先重试保存。`);
        else resumeQueue();
      }
    }
  };
  useLayoutEffect(() => { latestSendRef.current = send; });

  const retry = (message: WorkbenchMessage) => {
    if (message.localEdit) { setNotice("这是本地编辑，请打开源图重新应用对应操作；不会调用模型。"); return; }
    if (!session || abortRef.current) return;
    const originalRequest = message.request ?? requestFromHistory(session.messages, message.id, currentScope);
    const request = { ...originalRequest };
    const directImageRequest = !!request.imageOptions && (request.imageOptions.requested || request.intent === "image-generate" || request.intent === "image-edit");
    if (!requestAllowed) {
      setNotice(requestBlockReason ?? "请先选择对话模型后再重试。");
      return;
    }
    if (directImageRequest && !requestAllowedFor(request)) {
      setNotice("本轮选定的制图模型或尺寸已不可用；请重新选择后新建一轮，重试不会改用其他模型。");
      return;
    }
    // 与首次发送同一道屏障：读取失败/未就绪时重试也不能绕过。
    if (!directImageRequest && !memoryBypass && memoryStatus !== "ready") {
      setNotice(
        memoryStatus === "loading"
          ? "正在读取本地记忆；可稍候，或选择「本次不用记忆」后再重试。"
          : "读取本地记忆失败；可重试读取，或选择「本次不用记忆」后再重试。"
      );
      return;
    }
    const bypassThisTurn = directImageRequest || memoryBypass;
    if (bypassThisTurn) setMemoryBypass(false);

    /*
     * R1：有计划的任务沿用**原计划**重试（不重新规划、不改写逐项要求），
     * 只补未完成项；未知结果项只有显式「重新生成」才新建尝试。
     */
    if (message.imagePlan) {
      const progress = imagePlanProgress(message.imagePlan, message.imageAttempts ?? [], message.attachments ?? []);
      const unfinished = progress.items.filter(item => !item.attachment);
      if (!unfinished.length) {
        setNotice("所选图片已全部处理完成；如需继续调整，请发送新的要求。");
        return;
      }
      const hasUnknown = unfinished.some(item => item.pendingState === "outcome_unknown");
      const hasRetryable = unfinished.some(item => item.pendingState === "failed" || item.pendingState === "not_started" || item.pendingState === undefined);
      /*
       * 产物已在回复里 = 已保存事实：即使 delivered 标记因保存屏障失败未落库，
       * 重试前也按附件补齐，避免对已交付项再走恢复查询。
       */
      const resume = {
        plan: message.imagePlan,
        attempts: (message.imageAttempts ?? []).map(attempt =>
          attempt.artifactId && message.attachments?.some(attachment => attachment.id === attempt.artifactId)
            ? { ...attempt, delivered: true as const }
            : attempt),
        ...(hasUnknown ? { regenerateUnknown: true } : {})
      };
      if (hasUnknown && !hasRetryable) {
        setNotice("正在重新生成结果未知的项；可能再次计费。");
      }
      updateMessage(session.id, message.id, {
        status: "pending", error: undefined, saveFailed: undefined,
        process: startProcess(message.process),
        ...retryMessageContent(message)
      });
      setSending(true);
      activeRequestRef.current = request;
      const controller = new AbortController();
      abortRef.current = controller;
      const sessionId = session.id;
      registerTurn(sessionId, controller);
      void (async () => {
        try {
          if (sessionApi) {
            const persisted = await saveSession(sessionApi, sessionId);
            if (!persisted) {
              finishMessageProcess(sessionId, message.id, controller.signal.aborted ? "cancelled" : "error");
              updateMessage(sessionId, message.id, {
                status: "failed", saveFailed: true,
                error: "本次未保存到本地，已停止发送；内容仍在此处，可先重试保存。"
              });
              setNotice("会话未保存到本地，未发起模型请求。");
              return;
            }
          }
          const outcome = await runTurn({
            sessionId,
            assistantId: message.id,
            request,
            controller,
            bypassMemory: bypassThisTurn,
            imageResume: resume,
            imageSources: {
              ...deriveImageSources(session.messages),
              sources: withCurrentTurnSources(deriveImageSources(session.messages).sources, request.attachments)
            }
          });
          if (outcome.ok && outcome.result?.kind === "handbook-page" && useWorkbenchStore.getState().activeId === sessionId) {
            setPreviewId(message.id); setPanel("preview"); setPanelOpen(true);
          } else if (outcome.ok && (outcome.result || outcome.batch)) {
            setPanelOpen(false); setPane("chat");
          }
        } catch (error) {
          const aborted = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
          finishMessageProcess(sessionId, message.id, aborted ? "cancelled" : "error");
          const conflictAbort = controller.signal.reason instanceof DOMException && controller.signal.reason.message === SAVE_CONFLICT_REASON;
          if (conflictAbort) {
            const current = useWorkbenchStore.getState().sessions.find(item => item.id === sessionId);
            const kept = current?.messages.find(item => item.id === message.id)?.text ?? "";
            updateMessage(sessionId, message.id, {
              status: "failed",
              text: kept,
              tools: current?.messages.find(item => item.id === message.id)?.tools?.map(tool => tool.ok === undefined
                ? { ...tool, ok: false, summary: "已中断" } : tool),
              saveFailed: true,
              error: "会话已在别处更新，本轮已停止；已生成内容与草稿保留，重新读取后再继续。"
            });
            setNotice("会话已在别处更新：本轮已停止，内容已保留。");
            return;
          }
          const saveFailed = useWorkbenchStore.getState().saveStates[sessionId] === "error";
          const current = useWorkbenchStore.getState().sessions.find(item => item.id === sessionId)?.messages.find(item => item.id === message.id);
          const kept = current?.text ?? "";
          updateMessage(sessionId, message.id, {
            status: aborted ? "done" : "failed",
            text: aborted ? `${kept ? `${kept}\n\n` : ""}已取消。` : kept || "生成失败。",
            tools: settleWorkbenchTools(current?.tools, aborted),
            ...(saveFailed ? { saveFailed: true } : {}),
            error: aborted ? undefined : error instanceof Error ? error.message : "未知错误"
          });
          if (sessionApi && !saveFailed) {
            const saved = await commitSession(sessionApi, sessionId);
            if (!saved) updateMessage(sessionId, message.id, { saveFailed: true, error: "最终状态未保存到本地，可重试保存。" });
          }
        } finally {
          unregisterTurn(sessionId, controller);
          setSending(false);
          abortRef.current = null;
          activeRequestRef.current = undefined;
          resumeQueue();
        }
      })();
      return;
    }

    /*
     * 旧消息（无计划）：批量修图无法可靠还原逐项要求，按任务书要求新建请求，不猜测迁移；
     * 单图（完整原话即可靠要求）仍可重试。
     */
    const { completedSourceIds, unfinished: pendingSources } = imageEditProgress(request.attachments, message.tools);
    if (request.intent === "image-edit" && request.attachments.length > 1) {
      setNotice("这轮早于逐项计划记录，无法可靠补修其中的某几张；请重新发送要求。");
      return;
    }
    if (request.intent === "image-edit" && request.attachments.length) {
      if ((message.attachments?.length ?? 0) > request.attachments.length) {
        setNotice("这一轮含有重复的历史图片结果，无法可靠补修；请选中需要修改的图片后发送新的要求。");
        return;
      }
      if (!pendingSources.length) {
        setNotice("所选图片已全部处理完成；如需继续调整，请发送新的要求。");
        return;
      }
    }
    const retryRequest = pendingSources.length && pendingSources.length < request.attachments.length
      ? { ...request, attachments: pendingSources }
      : request;
    const batch = request.attachments.length > 1 && (request.intent === "image-edit" || message.tools?.some(tool => tool.name === "image-edit"));
    const keepProgress = completedSourceIds.size > 0 && message.attachments?.length;
    updateMessage(session.id, message.id, {
      status: "pending", error: undefined, saveFailed: undefined,
      process: startProcess(message.process),
      // 已有成功图片时保留进度与附件；否则按全新的批量回合清空重放。
      ...retryMessageContent(message),
      ...(batch && !keepProgress ? { result: undefined, attachments: [], tools: [], traces: [], reasoning: undefined, blocks: [], eventSequence: 0 } : {})
    });
    setSending(true);
    activeRequestRef.current = retryRequest;
    const controller = new AbortController();
    abortRef.current = controller;
    const sessionId = session.id;
    registerTurn(sessionId, controller);
    void (async () => {
      try {
        /*
         * SP4：重试与首次发送共用同一个前置条件 ——
         * 原问题与 pending 占位没落盘就不发模型，避免绕过「先落盘再请求」。
         */
        if (sessionApi) {
          const persisted = await saveSession(sessionApi, sessionId);
          if (!persisted) {
            finishMessageProcess(sessionId, message.id, controller.signal.aborted ? "cancelled" : "error");
            updateMessage(sessionId, message.id, {
              status: "failed",
              saveFailed: true,
              error: "本次未保存到本地，已停止发送；内容仍在此处，可先重试保存。"
            });
            setNotice("会话未保存到本地，未发起模型请求。");
            return;
          }
        }
        // 重放这条回答自己的请求；没有记录时退回到它之前最近的一条用户输入。
        // 与 send 走同一条路径（含流式与终止状态契约）。重试同样带本轮候选：
        // 已解析的图片请求直接用快照来源（不再重新选图），未解析的重建当前会话候选。
        const liveMessages = useWorkbenchStore.getState().sessions.find(item => item.id === sessionId)?.messages ?? session.messages;
        const retryImageSources = deriveImageSources(liveMessages);
        // 重放的是页面构造的请求（没有已解析来源）时，用户当时说出的张数要求仍然有效。
        const retryExpectedCount = retryRequest.attachments.length || !retryRequest.text
          ? undefined
          : referencedImageCount(retryRequest.text);
        const outcome = await runTurn({
          sessionId,
          assistantId: message.id,
          // 只重放未完成的来源；已解析的全量快照仍留在该条回答上。
          request: retryRequest,
          controller,
          bypassMemory: bypassThisTurn,
          imageSources: {
            ...retryImageSources,
            sources: retryRequest.attachments.length
              ? withCurrentTurnSources(retryImageSources.sources, retryRequest.attachments)
              : retryImageSources.sources,
            ...(retryExpectedCount ? { expectedCount: retryExpectedCount } : {})
          }
        });
        if (outcome.ok && outcome.result?.kind === "handbook-page" && useWorkbenchStore.getState().activeId === sessionId) {
          setPreviewId(message.id); setPanel("preview"); setPanelOpen(true);
        } else if (outcome.ok && (outcome.result || outcome.batch)) {
          setPanelOpen(false); setPane("chat");
        }
      } catch (error) {
        const aborted = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
        finishMessageProcess(sessionId, message.id, aborted ? "cancelled" : "error");
        const conflictAbort = controller.signal.reason instanceof DOMException && controller.signal.reason.message === SAVE_CONFLICT_REASON;
        if (conflictAbort) {
          const current = useWorkbenchStore.getState().sessions.find(item => item.id === sessionId);
          const kept = current?.messages.find(item => item.id === message.id)?.text ?? "";
          updateMessage(sessionId, message.id, {
            status: "failed",
            text: kept,
            tools: current?.messages.find(item => item.id === message.id)?.tools?.map(tool => tool.ok === undefined
              ? { ...tool, ok: false, summary: "已中断" } : tool),
            saveFailed: true,
            error: "会话已在别处更新，本轮已停止；已生成内容与草稿保留，重新读取后再继续。"
          });
          setNotice("会话已在别处更新：本轮已停止，内容已保留。");
          return;
        }
        const current = useWorkbenchStore.getState().sessions.find(item => item.id === sessionId)?.messages.find(item => item.id === message.id);
        const progress = current?.imagePlan
          ? (() => {
              const plan = imagePlanProgress(current.imagePlan, current.imageAttempts ?? [], current.attachments ?? []);
              return { total: plan.total, completed: plan.completed };
            })()
          : imageEditProgress(current?.request?.attachments ?? retryRequest.attachments, current?.tools);
        const saveFailed = useWorkbenchStore.getState().saveStates[sessionId] === "error";
        updateMessage(sessionId, message.id, {
          status: aborted ? "done" : "failed",
          text: batch ? `${aborted ? "已取消" : "已中断"}修图；已完成 ${progress.completed}/${progress.total} 张。` : aborted ? "已取消这次生成。" : "生成失败。",
          tools: settleWorkbenchTools(current?.tools, aborted),
          ...(saveFailed ? { saveFailed: true } : {}),
          error: aborted ? undefined : error instanceof Error ? error.message : "未知错误"
        });
        // SP4：重试的取消/异常也要走同一最终提交路径。
        if (sessionApi && !saveFailed) {
          const saved = await commitSession(sessionApi, sessionId);
          if (!saved) updateMessage(sessionId, message.id, { saveFailed: true, error: "最终状态未保存到本地，可重试保存。" });
        }
      } finally {
        unregisterTurn(sessionId, controller);
        setSending(false);
        abortRef.current = null;
        activeRequestRef.current = undefined;
        resumeQueue();
      }
    })();
  };

  /** 只重试保存（不发模型）：用于「未保存到本地」的失败回合。 */
  const retrySave = (message: WorkbenchMessage) => {
    if (!session || !sessionApi || saveBusy) return;
    setSaveBusy(true);
    void (async () => {
      // 先清除失败标记再提交，使重试成功后的记录本身也是已保存状态。
      updateMessage(session.id, message.id, { saveFailed: undefined, error: undefined });
      const saved = await commitSession(sessionApi, session.id);
      if (!saved) updateMessage(session.id, message.id, { saveFailed: true, error: "仍未保存成功，可稍后再试。" });
      // 保存恢复：之前因保存失败压住的排队项接着发。
      else resumeQueue();
      setSaveBusy(false);
    })();
  };

  // 记忆被关闭/删除/改许可时取消在途回合：不让旧快照继续外发。
  useEffect(() => {
    const active = activeRequestRef.current;
    const directImage = active?.imageOptions && (active.imageOptions.requested || active.intent === "image-generate" || active.intent === "image-edit");
    if (memoryEpoch > 0 && !directImage) abortRef.current?.abort();
  }, [memoryEpoch]);

  const attachImages = async (files: FileList | null) => {
    if (!files || files.length === 0 || sending) return;
    if (readingImagesRef.current) { setNotice("正在添加图片，请稍候再选择。"); if (fileRef.current) fileRef.current.value = ""; return; }
    const next: MessageAttachment[] = [];
    const images = Array.from(files).filter(file => ["image/png", "image/jpeg", "image/webp"].includes(file.type));
    if (images.length + attachments.length > CREATION_VISION_LIMITS.images) {
      setNotice(`一次最多附加 ${CREATION_VISION_LIMITS.images} 张图片；已有 ${attachments.length} 张，本次选了 ${images.length} 张。`);
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    if (images.length === 0) { setNotice("仅支持 PNG、JPEG 和 WebP 图片。"); if (fileRef.current) fileRef.current.value = ""; return; }
    readingImagesRef.current = true;
    setReadingImages(true);
    try {
      if (nativeAttachments) {
        // native：原字节直接进入 Directory.Data（独占发布 + inflight 登记），
        // 会话只保存 fileRef；预览用内存 objectURL，不落 base64。
        for (const file of images) {
          const id = createCaptureId("att");
          const { attachment, prepared } = await nativeAttachments.prepare({
            id, name: file.name, type: file.type, size: file.size, blob: file
          });
          pendingPreparedRef.current.push(prepared as unknown as { release: () => void });
          registerNativeView(attachment, file);
          next.push(attachment);
        }
      } else {
        for (const file of images) {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error("读取图片失败"));
            reader.onload = () => resolve(String(reader.result));
            reader.readAsDataURL(file);
          });
          next.push({ id: createCaptureId("att"), name: file.name, dataUrl });
        }
      }
      setAttachments((current) => [...current, ...next]);
      if (next.length > 0) setSourceResultChoice(undefined);
      setNotice(images.length !== files.length ? "已跳过不支持的文件；仅支持 PNG、JPEG 和 WebP 图片。" : undefined);
    } catch {
      setNotice("读取图片失败，未添加本次选择；请重试。");
    } finally {
      readingImagesRef.current = false;
      setReadingImages(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const download = (result: WorkbenchResult) => {
    if (result.kind === "image" && result.dataUrl) {
      const link = document.createElement("a");
      link.href = result.dataUrl;
      const ext = result.dataUrl.startsWith("data:image/jpeg;") ? "jpg" : result.dataUrl.startsWith("data:image/webp;") ? "webp" : "png";
      link.download = `${result.title}.${ext}`;
      link.click();
      return;
    }
    const file = resultFile(result);
    const url = URL.createObjectURL(new Blob([file.content], { type: file.type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.click();
    URL.revokeObjectURL(url);
  };

  /**
   * 文字结果不落成文件，直接复制正文：失败要明说（非安全上下文/未授权时剪贴板不可用），
   * 不能静默当成功。
   */
  const copyText = async (result: WorkbenchResult) => {
    const body = result.kind === "text" ? result.body : "";
    if (!body) return;
    try {
      await copyWorkbenchText(body);
      setNotice("已复制这段文字。");
    } catch {
      setNotice("复制失败：当前环境不允许访问剪贴板，请手动选中文字复制。");
    }
  };

  const openWritePicker = (mode: "insert-note" | "new-note", result: WorkbenchResult, trigger: HTMLButtonElement) => {
    writeTriggerRef.current = trigger;
    setPendingWriteResult(result);
    setNotice(undefined);
    setPicker(mode);
  };

  const resultActions = (result: WorkbenchResult, onImage = false) => {
    const isImage = result.kind === "image";
    const editLabel = isImage ? "继续修改这张图片" : "继续修改这段文字";
    const downloadLabel = "下载这张图片";
    return <div className={`wb-image-actions${onImage ? " wb-image-actions--overlay" : ""}`} role="group" aria-label={`${isImage ? "图片" : "文字"}操作：${result.title}`}>
      <button type="button" className="wb-image-action" aria-label={editLabel} onClick={() => {
        setSourceResultChoice({ sessionId: activeId ?? "", result });
        if (isImage) setAttachments([]);
        setIntent(isImage ? "image-edit" : "chat");
        setPanelOpen(false);
        setPane("chat");
        inputRef.current?.focus();
      }}><Pencil size={18} aria-hidden /><span className="wb-image-action-tooltip">{editLabel}</span></button>
      <button type="button" className="wb-image-action" aria-label="插入已有笔记" onClick={event => openWritePicker("insert-note", result, event.currentTarget)}>
        <FileInput size={18} aria-hidden /><span className="wb-image-action-tooltip">插入已有笔记</span>
      </button>
      <button type="button" className="wb-image-action" aria-label="保存为新笔记" onClick={event => openWritePicker("new-note", result, event.currentTarget)}>
        <FilePlus2 size={18} aria-hidden /><span className="wb-image-action-tooltip">保存为新笔记</span>
      </button>
      {/* 图片存成文件，文字直接进剪贴板——两行是两回事，动作也不一样。 */}
      {isImage ? (
        <button type="button" className="wb-image-action" aria-label={downloadLabel} onClick={() => download(result)}>
          <Download size={18} aria-hidden /><span className="wb-image-action-tooltip">{downloadLabel}</span>
        </button>
      ) : (
        <button type="button" className="wb-image-action" aria-label="复制这段文字" onClick={() => void copyText(result)}>
          <Copy size={18} aria-hidden /><span className="wb-image-action-tooltip">复制这段文字</span>
        </button>
      )}
    </div>;
  };

  const openImagePreview = async (attachment: MessageAttachment, trigger: HTMLButtonElement, siblings?: MessageAttachment[]) => {
    if (!activeId) return;
    const ownerId = trigger.closest<HTMLElement>("[data-message-id]")?.dataset.messageId;
    const owner = session?.messages.find(message => message.id === ownerId);
    const sourceEntries = owner ? imageDisplayEntries(owner, displayImageSources) : [];
    // F1：统一按需出口——fileRef 附件先显式装载（幂等、失败稳定），仅可读项进入查看器；
    // 全部不可读时不挂载查看器（空数组曾使 PhotoViewer 崩溃），如实提示。
    const candidates = siblings?.length ? siblings : [attachment];
    const settled = await Promise.all(candidates.map(async image => ({ image, view: image.dataUrl ? { state: "ready" as const, url: image.dataUrl } : await loadNativeView(image) })));
    const images = settled.filter(({ image, view }) => view.url || image.dataUrl).map(({ image, view }) => ({ id: image.id, name: image.name, url: image.dataUrl ?? view.url!, ...(view.blob ? { blob: view.blob } : {}), ...(image.fileRef ? { fileRef: image.fileRef } : {}),
      attachment: image, ownerId, versionLabel: image.id,
      sourceLabel: sourceEntries.find(entry => entry.attachment.id === image.id)?.sourceLabel ?? (owner?.role === "user" ? "会话附图" : "会话图片结果") }));
    if (images.length === 0) {
      setNotice(`「${attachment.name}」原图暂不可读（缺失或读取失败），可在时间线中重读。`);
      return;
    }
    const next: ConversationViewer = { sessionId: activeId, initialId: settled.some(entry => entry.view.url && entry.image.id === attachment.id) || attachment.dataUrl ? attachment.id : images[0]!.id, trigger, images };
    viewerRef.current = next; setViewer(next); setViewerFiles({});
  };
  const openRemoteImagePreview: PreviewSearchImage = useCallback((image, trigger, images) => {
    if (!activeId) return;
    const ownerId = trigger.closest<HTMLElement>("[data-message-id]")?.dataset.messageId;
    const next: ConversationViewer = { sessionId: activeId, initialId: searchImageIdentity(image), trigger,
      images: images.map(candidate => ({ id: searchImageIdentity(candidate), name: candidate.title || "搜索图片", url: candidate.url,
        sourceUrl: candidate.sourceUrl, sourceLabel: "网页图片源文件", ownerId, search: candidate })) };
    viewerRef.current = next; setViewer(next); setViewerFiles({});
  }, [activeId, setViewer, setViewerFiles]);
  const viewerKey = (selection: ConversationViewer, image: ViewerImage) => `${selection.sessionId}:${image.ownerId}:${image.id}`;
  const assertViewerSource = (selection: ConversationViewer, image: ViewerImage) => {
    const state = useWorkbenchStore.getState();
    const messages = state.sessions.find(item => item.id === selection.sessionId)?.messages;
    if (state.activeId !== selection.sessionId || !messages || !ownsViewerImage(messages, image))
      throw new Error("图片或会话已变化，请重新打开要处理的图片。");
  };
  const ensureViewerFile = async (selection: ConversationViewer, image: ViewerImage): Promise<WorkbenchImageFile> => {
    assertViewerSource(selection, image);
    const key = viewerKey(selection, image);
    let reads = viewerReads.current.get(selection);
    if (!reads) { reads = new Map(); viewerReads.current.set(selection, reads); }
    let pending = reads.get(key);
    if (!pending) {
      pending = readWorkbenchImageFile(image);
      reads.set(key, pending);
      const currentReads = reads;
      void pending.catch(() => { currentReads.delete(key); });
    }
    const file = viewerFiles[key] ?? await pending;
    // A late read may finish after switching image or closing the dialog; only the captured source/session can be used.
    assertViewerSource(selection, image);
    if (viewerRef.current === selection) setViewerFiles(current => ({ ...current, [key]: file }));
    return file;
  };
  const imageEditBlocker = !requestAllowed ? requestBlockReason ?? "请先配置并选择可用的模型。"
    : !imageTool?.enabled ? imageTool?.reason ?? "图片编辑尚未启用。"
      : !selectedImageModel?.capabilities.edit ? "请在模型设置中选择支持修改图片的制图模型。" : undefined;
  const submitViewerEdit = async (selection: ConversationViewer, image: ViewerImage, instruction: string) => {
    if (imageEditBlocker) throw new Error(imageEditBlocker);
    const body = instruction.trim();
    if (!body) throw new Error("先描述想如何修改这张图片。");
    const file = await ensureViewerFile(selection, image);
    if (!mountedRef.current) return;
    const state = useWorkbenchStore.getState();
    if (state.saveStates[selection.sessionId] === "error" || state.saveStates[selection.sessionId] === "conflict" ||
      state.sessions.find(item => item.id === selection.sessionId)?.messages.some(message => message.saveFailed))
      throw new Error("会话尚未保存成功，请先重试保存。");
    if (readingImagesRef.current || preparingNoteImage) throw new Error("正在准备其他图片，请稍后发送。");
    const entry: QueuedTurn = { id: createCaptureId("queue"), sessionId: selection.sessionId, text: body,
      intent: "image-edit", attachments: [file.attachment], references: [], skillReferences: [] };
    // Use the existing queue even when idle: it owns one immutable target snapshot and leaves the main draft untouched.
    setQueued([...queueRef.current, entry]);
    setViewerDrafts(current => {
      const key = viewerKey(selection, image);
      return current[key] === instruction ? { ...current, [key]: "" } : current;
    });
    resumeQueue();
  };
  const submitLocalImageEdit = async (selection: ConversationViewer, image: ViewerImage, operation: LocalImageEdit, expectedDigest?: string) => {
    const edit = LOCAL_IMAGE_EDIT.parse(operation), key = viewerKey(selection, image);
    if ([...localJobsRef.current.keys()].some(id => id.startsWith(selection.sessionId + ":"))) throw new Error("本会话正在保存一张本地编辑图片，请完成或取消后再试。");
    const accountId = useWorkbenchStore.getState().accountId, controller = new AbortController();
    // Reserve the session before the first file/hash await, including when the viewer is closed and reopened.
    localJobsRef.current.set(key, controller);
    let file: WorkbenchImageFile, sourceDigest: string;
    try {
      file = await ensureViewerFile(selection, image);
      sourceDigest = await digestBytes(new Uint8Array(await file.blob.arrayBuffer()), detectGlobalBridge());
      controller.signal.throwIfAborted();
      if (expectedDigest && expectedDigest !== sourceDigest) throw new Error("原图版本已变化，不能重放旧选区。");
      assertViewerSource(selection, image);
      const state = useWorkbenchStore.getState();
      if (state.accountId !== accountId) throw new Error("账号已变化，未开始处理原图。");
      if (state.saveStates[selection.sessionId] === "error" || state.saveStates[selection.sessionId] === "conflict") throw new Error("会话尚未保存成功，请先重试保存。");
    } catch (error) { localJobsRef.current.delete(key); throw error; }
    const label = { crop: "裁剪", rotate: "旋转", resize: "调整尺寸", annotate: "标注", "remove-background": "移除背景" }[edit.kind];
    const id = createCaptureId("local-edit"), started = startProcess();
    const origin = { sourceId: file.attachment.id, sourceDigest, operation: edit };
    const pending: WorkbenchMessage = { id, role: "assistant", text: "", createdAt: new Date().toISOString(), status: "pending", localEdit: origin,
      process: started, blocks: [{ id: "local-edit-start", sequence: 1, type: "trace", text: `本地${label}：处理冻结的原件，不调用模型。` }], eventSequence: 1 };
    setLocalJobs(previous => ({ ...previous, [key]: { messageId: id, controller } }));
    appendMessage(selection.sessionId, pending);
    const assertOwner = () => {
      const state = useWorkbenchStore.getState();
      const current = state.sessions.find(item => item.id === selection.sessionId);
      if (state.accountId !== accountId || !current || !ownsViewerImage(current.messages, image) || !current.messages.some(message => message.id === id)) throw new Error("图片归属已变化，未写入其他会话。");
      controller.signal.throwIfAborted();
    };
    let prepared: { release: () => void } | undefined;
    let localEpoch: number | undefined;
    try {
      if (sessionApi && !await commitSession(sessionApi, selection.sessionId)) throw new Error("任务未保存，未开始处理原图。");
      assertOwner();
      const result = await editImageFile(file.blob, edit, controller.signal);
      assertOwner();
      const draft = viewerEditDrafts[key];
      if ("bounds" in edit && draft?.sourceWidth && (draft.sourceWidth !== result.sourceWidth || draft.sourceHeight !== result.sourceHeight)) throw new Error("原图显示尺寸已变化，请重新框选。");
      const mediaId = createCaptureId("edit-result"), name = `${file.attachment.name.replace(/\.[^.]+$/, "")}-${label}.png`;
      let attachment: MessageAttachment;
      if (nativeAttachments) {
        const value = await nativeAttachments.prepare({ id: mediaId, name, type: "image/png", size: result.blob.size, blob: result.blob });
        prepared = value.prepared; assertOwner();
        attachment = value.attachment;
      } else attachment = { id: mediaId, name, dataUrl: `data:image/png;base64,${await blobToBase64(result.blob)}` };
      assertOwner();
      attachment = { ...attachment, edit: { ...origin, width: result.width, height: result.height } };
      const completed: WorkbenchMessage = completeMessageTimeline({ ...pending, status: "done", text: `本地${label}新版本（${result.width} × ${result.height}），原图保留。`, attachments: [attachment], process: finishProcess(started, "stop") });
      if (nativeAttachments && prepared) {
        if (!nativeAttachments.commitSession) throw new Error("原生会话保存尚未就绪，未交付结果。");
        localEpoch = freezeSessionCheckpoints(selection.sessionId); await awaitSessionSaves(selection.sessionId); assertOwner();
        const latest = useWorkbenchStore.getState().sessions.find(item => item.id === selection.sessionId)!;
        const account = useWorkbenchStore.getState().accountId;
        const snapshot = { ...latest, messages: latest.messages.map(message => message.id === id ? completed : message) };
        const record = await nativeAttachments.commitSession({ id: latest.id, baseRevision: useWorkbenchStore.getState().revisions[latest.id], title: latest.title, payload: toSessionPayload(snapshot, { textModelId: latest.textModelId, imageModelId: latest.imageModelId }) }, [prepared]);
        prepared = undefined;
        // The transaction owns cancellation after its commit; never undo or resend a saved result.
        if (useWorkbenchStore.getState().accountId === account && useWorkbenchStore.getState().sessions.some(item => item.id === latest.id)) {
          registerNativeView(attachment, result.blob); updateMessage(latest.id, id, completed);
          useWorkbenchStore.getState().setRevision(latest.id, record.revision, account ?? undefined);
        }
      } else {
        updateMessage(selection.sessionId, id, completed);
        if (sessionApi && !await commitSession(sessionApi, selection.sessionId)) {
          updateMessage(selection.sessionId, id, { saveFailed: true, error: "新版本尚未保存到会话，请重试保存。" });
          throw new Error("新版本尚未保存到会话，请关闭查看器后重试保存。");
        }
      }
    } catch (error) {
      prepared?.release();
      const current = useWorkbenchStore.getState().sessions.find(item => item.id === selection.sessionId)?.messages.find(message => message.id === id);
      if (useWorkbenchStore.getState().accountId === accountId && current && !current.attachments?.length) {
        updateMessage(selection.sessionId, id, { status: "failed", text: controller.signal.aborted ? "本地编辑已取消，原图保留。" : `本地${label}未完成，原图保留。`, error: error instanceof Error ? error.message : "处理失败。",
          process: finishProcess(started, controller.signal.aborted ? "cancelled" : "error") });
        if (sessionApi) await commitSession(sessionApi, selection.sessionId);
      }
      throw error;
    } finally { if (localEpoch !== undefined) thawSessionCheckpoints(selection.sessionId, localEpoch); localJobsRef.current.delete(key); setLocalJobs(previous => { const next = { ...previous }; delete next[key]; return next; }); }
  };
  const renderViewerEditor = (activeImage: PhotoViewImage) => {
    if (!viewer) return null;
    const image = viewer.images.find(candidate => candidate.id === activeImage.id);
    if (!image) return null;
    const key = viewerKey(viewer, image), file = viewerFiles[key], editDraft = viewerEditDrafts[key] ?? {};
    const sourceId = file?.attachment.id ?? image.attachment?.id;
    const queued = sourceId ? queue.find(entry => entry.sessionId === viewer.sessionId && entry.intent === "image-edit" && entry.attachments.some(item => item.id === sourceId)) : undefined;
    const message = sourceId ? session?.messages.findLast(item => item.role === "assistant" && (item.localEdit?.sourceId === sourceId || item.request?.intent === "image-edit" && item.request.attachments.some(source => source.id === sourceId))) : undefined;
    const result = message?.attachments?.[0] ?? (message?.result?.kind === "image" && message.result.dataUrl
      ? { id: message.result.id, name: message.result.title, dataUrl: message.result.dataUrl } : undefined);
    const owner = session?.messages.find(item => item.id === image.ownerId);
    const writable = owner?.role === "assistant" && image.attachment ? imageResultFor(owner, image.attachment) : undefined;
    return <WorkbenchImageEditor key={key} value={viewerDrafts[key] ?? ""} onChange={value => setViewerDrafts(current => ({ ...current, [key]: value }))}
      draft={editDraft} onDraft={draft => setViewerEditDrafts(previous => ({ ...previous, [key]: draft }))}
      localBlocker={!image.ownerId ? "该图片没有可核对的会话来源，仅可查看。" : undefined}
      onLocalEdit={operation => submitLocalImageEdit(viewer, image, operation)}
      localJob={localJobs[key] ? { label: "本地处理并保存新版本…", cancel: () => localJobs[key].controller.abort() } : undefined}
      eraseAvailable={!imageEditBlocker && !!selectedImageModel && supportsInteractiveImageEdit(selectedImageModel.model ?? "")}
      onErase={async () => {
        const bounds = IMAGE_BOUNDS.parse(editDraft.bounds), original = await ensureViewerFile(viewer, image);
        const dimensions = await createBrowserImagePort().decode(original.blob);
        if (editDraft.sourceWidth && (editDraft.sourceWidth !== dimensions.width || editDraft.sourceHeight !== dimensions.height)) throw new Error("原图尺寸已变化，请重新框选。");
        const instruction = `<bbox>${bounds.left} ${bounds.top} ${bounds.right} ${bounds.bottom}</bbox>移除选区中的${viewerDrafts[key]?.trim() || "指定对象"}，自然补全背景，尽量保留框外构图和内容。`;
        if (!validImageEditBounds(instruction, dimensions)) throw new Error("选区无效或超出原图，请重新选择。");
        await submitViewerEdit(viewer, image, instruction);
      }}
      blocker={image.ownerId ? imageEditBlocker : "该图片没有可核对的会话来源，仅可查看。"} needsFile={!!image.search && !file}
      onPrepare={async () => { await ensureViewerFile(viewer, image); }}
      onSubmit={() => submitViewerEdit(viewer, image, viewerDrafts[key] ?? "")}
      job={localJobs[key] ? undefined : queued ? queuedStartingId === queued.id ? { running: true, label: "正在启动图片修改…" } : { queued: true, label: "修改要求已排队" } : message ? {
        label: message.status === "pending" ? "正在修改这张图片…" : message.process?.outcome === "cancelled" ? "修改已取消" : message.status === "failed" ? "修改未完成" : result ? "修改结果已返回会话" : "本次未返回图片",
        running: message.status === "pending", failed: message.status === "failed", error: message.error, hasResult: !!result
      } : undefined}
      onCancel={() => {
        if (queued) {
          if (queuedStartingRef.current === queued.id) {
            abortRef.current?.abort();
            setQueued(queueRef.current.filter(entry => entry.id !== queued.id));
          } else removeQueued(queued.id);
        }
        else if (message?.status === "pending" && activeRequestRef.current?.intent === "image-edit" &&
          activeRequestRef.current.attachments.some(source => source.id === sourceId)) abortRef.current?.abort();
      }}
      onRetry={() => { if (message?.localEdit) void submitLocalImageEdit(viewer, image, message.localEdit.operation, message.localEdit.sourceDigest).catch(error => setNotice(error instanceof Error ? error.message : "本地编辑失败。")); else if (message) retry(message); }}
      retryLabel={message && planHasUnknown(message) ? "重新生成（可能再次计费）" : "重试"}
      onResult={() => { if (!result || !message) return;
        // F1：与 openImagePreview 相同的统一出口——fileRef 附件装载后进入，空集不开查看器。
        const candidates = message.attachments?.length ? message.attachments : [result];
        void Promise.all(candidates.map(async item => ({ item, view: item.dataUrl ? { state: "ready" as const, url: item.dataUrl } : await loadNativeView(item) })))
          .then(settled => {
            const images = settled.filter(({ view }) => view.url).map(({ item, view }) => ({ id: item.id, name: item.name, url: view.url!, ...(view.blob ? { blob: view.blob } : {}), ...(item.fileRef ? { fileRef: item.fileRef } : {}), attachment: item, ownerId: message.id, versionLabel: item.id, sourceLabel: "会话图片结果" }));
            if (images.length === 0) { setNotice("该图片的原件暂不可读，无法打开查看。"); return; }
            const next: ConversationViewer = { sessionId: viewer.sessionId, initialId: result.id, trigger: viewer.trigger, images };
            viewerRef.current = next; setViewer(next); setViewerFiles({});
          });
      }}
      actions={writable ? ([ ["insert-note", "插入已有笔记"], ["new-note", "保存为新笔记"] ] as const).map(([mode, label]) => <button type="button" key={mode} aria-label={label} title={label} onClick={() => {
          const trigger = viewer.trigger;
          viewerRef.current = undefined; setViewer(undefined); setViewerFiles({});
          openWritePicker(mode, writable, trigger);
        }}>{mode === "insert-note" ? <FileInput size={16} aria-hidden /> : <FilePlus2 size={16} aria-hidden />}{mode === "insert-note" ? "插入笔记" : "新建笔记"}</button>) : null}
    />;
  };

  const foldAnchor = useRef<{ element: HTMLElement; top: number; bottom: boolean } | undefined>(undefined);
  const beforeProcessToggle = (details: HTMLDetailsElement) => {
    const stream = streamRef.current;
    if (!stream) return;
    const bounds = stream.getBoundingClientRect();
    if (foldAnchor.current) return;
    const visible = [...stream.querySelectorAll<HTMLElement>("[data-block-id], [data-message-id]")]
      .find(element => !details.contains(element) && !element.contains(details) && element.getBoundingClientRect().bottom > bounds.top && element.getBoundingClientRect().top < bounds.bottom);
    const element = visible ?? details.querySelector<HTMLElement>(":scope > summary");
    if (element) foldAnchor.current = { element, top: element.getBoundingClientRect().top, bottom: nearBottomRef.current };
  };
  const afterProcessToggle = () => {
    const snapshot = foldAnchor.current;
    foldAnchor.current = undefined;
    const stream = streamRef.current;
    if (!snapshot || !stream) return;
    if (snapshot.bottom && !nearBottomRef.current) return;
    nearBottomRef.current = snapshot.bottom;
    if (snapshot.bottom) scrollToBottom();
    else if (snapshot.element.isConnected) setStreamScrollTop(stream, stream.scrollTop + snapshot.element.getBoundingClientRect().top - snapshot.top);
  };

  const markdownAnchor = useRef<{ element?: HTMLElement; block?: HTMLElement; top: number; ratio: number; targetY: number; scrollTop: number; bottom: boolean } | undefined>(undefined);
  const beforeMarkdownChange = () => {
    const stream = streamRef.current;
    if (!stream || markdownAnchor.current) return;
    if (nearBottomRef.current) {
      markdownAnchor.current = { top: 0, ratio: 1, targetY: 0, scrollTop: stream.scrollTop, bottom: true };
      return;
    }
    const bounds = stream.getBoundingClientRect();
    const visible = (item: HTMLElement) => { const rect = item.getBoundingClientRect(); return rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom; };
    const block = [...stream.querySelectorAll<HTMLElement>("[data-block-id]")].find(visible)
      ?? [...stream.querySelectorAll<HTMLElement>("[data-message-id]")].find(visible);
    const element = block ? [...block.querySelectorAll<HTMLElement>(".wb-markdown > *")].find(visible) ?? block : undefined;
    const rect = block?.getBoundingClientRect();
    const targetY = rect ? Math.max(rect.top, bounds.top + 8) : bounds.top;
    markdownAnchor.current = { element, block, top: element?.getBoundingClientRect().top ?? 0,
      ratio: rect?.height ? Math.min(1, Math.max(0, (targetY - rect.top) / rect.height)) : 0,
      targetY, scrollTop: stream.scrollTop, bottom: nearBottomRef.current };
  };
  const afterMarkdownChange = () => {
    const snapshot = markdownAnchor.current;
    markdownAnchor.current = undefined;
    const stream = streamRef.current;
    // A user scroll after the snapshot wins over asynchronous layout restoration.
    if (!snapshot || !stream || Math.abs(stream.scrollTop - snapshot.scrollTop) > 2) return;
    if (snapshot.bottom && nearBottomRef.current) scrollToBottom();
    else if (!snapshot.bottom && snapshot.element?.isConnected)
      setStreamScrollTop(stream, stream.scrollTop + snapshot.element.getBoundingClientRect().top - snapshot.top);
    else if (!snapshot.bottom && snapshot.block?.isConnected) {
      // First raw-text → formatted replacement has no surviving paragraph node. Preserve relative reading depth.
      const rect = snapshot.block.getBoundingClientRect();
      setStreamScrollTop(stream, stream.scrollTop + rect.top + rect.height * snapshot.ratio - snapshot.targetY);
    }
  };

  const messageMedia = (message: WorkbenchMessage, attachmentIds?: string[], resultFallback?: Extract<WorkbenchResult, { kind: "image" }>) => {
    const entries = message.role === "assistant"
      ? imageDisplayEntries(message, displayImageSources) : [];
    let images = message.role === "assistant" ? entries.map(item => item.attachment) : message.attachments ?? [];
    /*
     * 复用与会话内选定的来源只存一次：在**这一轮回答的请求快照**上。
     * 按实际回合关系展示（这条用户消息 + 它后面那条回答的请求），
     * 不再假设「快照 text 等于用户原话」——图片选的执行快照 text 是完整执行要求，不是用户原话。
     */
    if (!images.length && message.role === "user" && session) {
      const index = session.messages.findIndex(item => item.id === message.id);
      const reply = index >= 0 ? session.messages[index + 1] : undefined;
      if (reply?.role === "assistant" && reply.request?.attachments?.length) images = reply.request.attachments;
    }
    if (resultFallback?.dataUrl && !images.some(image => image.id === resultFallback.id)) {
      images = [...images, { id: resultFallback.id, name: resultFallback.title, dataUrl: resultFallback.dataUrl }];
    }
    images = images.filter((image, index) => images.findIndex(item => item.id === image.id) === index);
    const previewGroup = images;
    if (attachmentIds) images = images.filter(image => attachmentIds.includes(image.id));
    if (images.length === 0) return null;
    return <ul className={`wb-message-media${message.role === "assistant" ? " wb-message-media--results" : ""}`}>
      {images.map(attachment => {
        const result = imageResultFor(message, attachment);
        const preview = <button type="button" className="wb-message-image-button" data-attachment-id={attachment.id} aria-label={`放大预览：${attachment.name}`}
          onClick={event => openImagePreview(attachment, event.currentTarget, previewGroup)}>
          {peekNativeView(attachment).url
            ? <img src={peekNativeView(attachment).url} alt={attachment.name} loading="lazy" decoding="async" />
            : <span className="wb-native-view-state" data-state={peekNativeView(attachment).state} role="img" aria-label={`${attachment.name}（${peekNativeView(attachment).state === "loading" ? "读取中" : peekNativeView(attachment).state === "idle" ? "待读取" : "暂不可读"}）`}>
                {peekNativeView(attachment).state === "loading" || peekNativeView(attachment).state === "idle" ? "…" : "!"}
                {(peekNativeView(attachment).state === "missing" || peekNativeView(attachment).state === "error") && typeof window !== "undefined" ? <button type="button" aria-label={`重读原图：${attachment.name}`} onClick={() => void loadNativeView(attachment, { retry: true })}>重读</button> : null}
              </span>}
        </button>;
        return <li key={attachment.id} className={result ? "wb-result-image-unit" : undefined}>
          {result ? <div className="wb-result-image-frame">
            {preview}
          </div> : preview}
        </li>;
      })}
    </ul>;
  };

  const toolCard = (tool: WorkbenchToolBlock, message: WorkbenchMessage) => {
    if (tool.name === "web_search") return <WorkbenchSearchBlock tool={tool} pending={message.status === "pending"}
      workPreview={message.status === "pending" && !message.process?.outcome && message.process?.phase !== "answering" && message.process?.phase !== "waiting"}
      duration={tool.ms === undefined ? undefined : formatDuration(tool.ms)} onPreviewImage={openRemoteImagePreview} />;
    const call = message.calls?.find(item => item.stage === "image" && `image-service-${item.attemptId}` === tool.id);
    return <details className="wb-block wb-block-tool" data-ok={tool.cancelled ? "cancelled" : tool.ok === undefined ? "pending" : String(tool.ok)}>
      <summary>
        <Wrench size={14} aria-hidden /><span className="wb-tool-title">{visibleToolTitle(tool, message)}</span>
        <span className="wb-block-meta">
          {tool.cancelled ? "已取消" : tool.ok === undefined ? "进行中" : tool.ok ? "完成" : "失败"}
          <WorkbenchToolDuration startedAt={tool.startedAt} ms={tool.ms}
            running={tool.ok === undefined && message.status === "pending" && !message.process?.outcome} />
        </span>
        <ChevronDown className="wb-tool-chevron" size={14} aria-hidden />
      </summary>
      <div className="wb-block-body">
        <code className="wb-tool-name">{tool.name}</code>
        {call?.usage ? <p className="wb-tool-summary">输入 {call.usage.inputTokens ?? "?"} / 输出 {call.usage.outputTokens ?? "?"} tokens</p> : null}
        {tool.summary && !(tool.cancelled && tool.summary === "已取消") && !(tool.ok && ["完成", "已完成"].includes(tool.summary.trim()))
          ? <p className="wb-tool-summary">{tool.summary}</p> : null}
        {tool.name === "image-service" && tool.argsDigest ? (
          <details className="wb-tool-summary wb-tool-prompt">
            <summary>提示词</summary>
            <div className="wb-block-body">{tool.argsDigest}</div>
          </details>
        ) : null}
      </div>
    </details>;
  };

  const renderTimeline = (message: WorkbenchMessage) => {
    const blocks = messageTimeline(message).filter(block => block.type !== "trace" ||
      (block.text !== "阶段：整理范围与素材" && !/^本轮上下文约 \d+ token。$/.test(block.text)));
    const working = message.status === "pending" && !message.process?.outcome && message.process?.phase !== "answering" && message.process?.phase !== "waiting";
    const presentation = partitionMessageBlocks(blocks);
    const activeTools = working ? (message.tools ?? []).filter(tool => tool.ok === undefined) : [];
    const latest = blocks.at(-1);
    const activityLabel = latest?.type === "reasoning" ? "正在思考" : latest?.type === "text" ? "正在输出"
      : latest?.type === "trace" && latest.text.startsWith("阶段：") ? visibleTrace(latest.text, message) : "正在处理";
    return <WorkbenchMarkdownDocuments key={`${session?.id}:${message.id}`}
      blocks={blocks.filter(block => block.type === "text" || block.type === "reasoning")}
      onBeforeChange={beforeMarkdownChange} onAfterChange={afterMarkdownChange}>{documents => {
    const media = projectMessageSearchMedia(message, presentation.delivery.filter(block => block.type === "text").map(block => ({
      id: block.id, text: documents.get(block.id)?.text ?? block.text
    })), documents);
    const renderBlocks = (items: typeof blocks, label: string) => <ol className="wb-message-timeline" aria-label={label}>
      {items.map(block => {
        let content: ReactNode;
        if (block.type === "tool") {
          const tool = message.tools?.find(item => item.id === block.toolId);
          content = tool ? toolCard(tool, message) : null;
        } else if (block.type === "reasoning") {
          const active = message.status === "pending" && block.id === blocks.at(-1)?.id && message.process?.phase !== "answering" && message.process?.phase !== "waiting";
          content = <details className="wb-block wb-block-thinking" data-streaming={active}>
            <summary><Brain size={14} aria-hidden /><span>思考过程</span><span className="wb-block-meta">{active ? "思考中 · " : ""}{block.text.length} 字</span><ChevronDown className="wb-thinking-chevron" size={14} aria-hidden /></summary>
            <div className="wb-block-body" aria-label="思考过程正文"><WorkbenchMarkdown text={documents.get(block.id)?.text ?? block.text} display={documents.get(block.id)} images={media.images} onPreviewImage={openRemoteImagePreview} /></div>
          </details>;
        } else if (block.type === "text") {
          content = <div className="wb-answer"><WorkbenchMarkdown text={documents.get(block.id)?.text ?? block.text} display={documents.get(block.id)} images={media.images}
            imageDelivery={media.markdown.get(block.id)} onPreviewImage={openRemoteImagePreview} /></div>;
        } else if (block.type === "images") {
          const latestImages = blocks.findLast(item => item.type === "images");
          content = <>{messageMedia(message, block.attachmentIds)}
            {message.status === "pending" && block.id === latestImages?.id && /^已完成 \d+\/\d+ 张，正在继续修改/.test(message.text)
              ? <p className="wb-timeline-trace">{message.text}</p> : null}</>;
        } else if (block.type === "call") {
          const call = message.calls?.find(item => item.callId === block.callId);
          const ms = call?.endedAt === undefined ? undefined : call.endedAt - call.startedAt;
          content = call ? <p className="wb-timeline-trace">调用 {call.stage} · {ms === undefined ? "进行中" : formatDuration(ms)}
            {call.usage ? ` · 输入 ${call.usage.inputTokens ?? "?"} / 输出 ${call.usage.outputTokens ?? "?"} tokens` : " · 用量未知"}</p> : null;
        } else if (block.type === "result") {
          const result = message.result;
          content = result?.kind === "image" && result.id === block.resultId ? result.dataUrl ? messageMedia(message, [result.id], result) : <div className="wb-result-image-unit">
            <div className="wb-result-image wb-result-image-demo" role="img" aria-label={`演示配图：${result.caption}`}
              style={{ background: `linear-gradient(135deg, ${result.from}, ${result.to})` }} />
            {resultActions(result, true)}
          </div> : null;
        } else {
          content = <p className="wb-timeline-trace">{visibleTrace(block.text, message)}</p>;
        }
        return <li key={block.id} data-block-type={block.type} data-block-id={block.id} data-sequence={block.sequence}>{content}</li>;
      })}
    </ol>;
    return <>
      <WorkbenchProcessDisclosure local={!!message.localEdit} process={message.process} status={message.status} calls={message.calls}
        onBeforeToggle={beforeProcessToggle} onAfterToggle={afterProcessToggle}>
        {presentation.process.length ? renderBlocks(presentation.process, "工作过程时间线") : <p className="wb-process-empty">{message.status === "pending" ? "等待公开过程记录…" : "未保存公开过程记录。"}</p>}
      </WorkbenchProcessDisclosure>
      <div className="wb-delivery" aria-label="本轮交付">
        {presentation.delivery.length ? renderBlocks(presentation.delivery, "交付内容时间线") : null}
        {!working ? <WorkbenchSearchImages images={media.remainingImages} onPreview={openRemoteImagePreview} /> : null}
      </div>
      {working ? <div className="wb-live-activity" aria-label="当前执行状态">
        {activeTools.length ? activeTools.map(tool => <div className="wb-live-tool" key={tool.id}>
          <Wrench size={14} aria-hidden />
          <span role="status">{visibleToolTitle(tool, message)} · 进行中</span>
          <WorkbenchToolDuration startedAt={tool.startedAt} ms={tool.ms} running />
        </div>) : <p role="status">{activityLabel}</p>}
      </div> : null}
    </>;
    }}</WorkbenchMarkdownDocuments>;
  };

  const closeWriteDialog = () => {
    if (writing) return;
    setWrite({});
    writeTriggerRef.current?.focus();
  };
  useDismissableLayer(writeCardRef, Boolean(write.target), closeWriteDialog);

  /** 目标笔记的现有正文：用于确认前的合并预览。 */
  const noteBodyFor = (target: WriteTarget | undefined) =>
    target?.kind === "insert-into-note"
      ? notebooks.flatMap((item) => item.notes).find((note) => note.id === target.noteId)?.body
      : undefined;

  const confirmWrite = async () => {
    if (!write.target || !write.result || writingRef.current) return;
    writingRef.current = true;
    setWriting(true);
    try {
      const receipt = await adapter.writeResult({ result: write.result, target: write.target, noteBody: write.noteBody, baseline: write.baseline });
      setWrite(current => current === write ? { ...current, receipt } : current);
    } catch (error) { setNotice(error instanceof Error ? error.message : "保存失败，请重试。"); }
    finally { writingRef.current = false; setWriting(false); }

  };

  const panelContent = (): ReactNode => {
    if (panel === "capabilities") {
      return (
        <CapabilitiesPanel
          {...(memoryStore ? { store: memoryStore } : {})}
          onMemoryChanged={onMemoryChanged}
          onClose={() => {
            setPanelOpen(false);
            setPane("chat");
          }}
        />
      );
    }
    if (panel === "notes") {
      return (
        <QuickNotesPanel
          {...quickNotes}
          onUseAsMaterial={(items) => {
            setReferences((current) => [...current, ...items.filter((item) => !current.some((ref) => ref.id === item.id))]);
            setPane("chat");
          }}
          onClose={() => {
            setPanelOpen(false);
            setPane("chat");
          }}
        />
      );
    }
    return (
      <section className="wb-panel wb-preview" aria-label="结果预览">
        <header className="wb-panel-head">
          <div>
            <h2>结果预览</h2>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setPanelOpen(false);
              setPane("chat");
            }}
          >
            关闭
          </button>
        </header>

        {!latestPreviewResult ? (
          <p className="wb-empty-note">还没有结果。发一条消息，或用上面的技能引用生成一份。</p>
        ) : (
          <>
            <article className="wb-result" data-kind={latestPreviewResult.kind}>
              <div className="wb-result-head">
                <h3>{latestPreviewResult.title}</h3>
                {latestPreviewResult.demo ? <span className="wb-demo-flag">演示</span> : null}
              </div>
              {latestPreviewResult.kind === "text" ? <WorkbenchMarkdown text={latestPreviewResult.body}
                images={messageSearchImages(session?.messages.find(message => message.result?.id === latestPreviewResult.id))} onPreviewImage={openRemoteImagePreview} /> : null}
              {latestPreviewResult.kind === "image" ? (
                /*
                 * 媒体版本来源链的最小展示（区别于执行重试链）：说明这张结果
                 * 实际编辑的是哪个来源；编号是组内序号，不是版本号。
                 */
                <p className="wb-panel-hint">来源：{latestPreviewResult.sourceName ?? "新生成"}</p>
              ) : null}
              {latestPreviewResult.kind === "handbook-page" ? (
                <div className="wb-result-page">
                  <h4>{latestPreviewResult.title}</h4>
                  <p className="wb-result-subtitle">{latestPreviewResult.subtitle}</p>
                  {latestPreviewResult.blocks.map((block) => (
                    <div key={block.heading}>
                      <h5>{block.heading}</h5>
                      <WorkbenchMarkdown text={block.body}
                        images={messageSearchImages(session?.messages.find(message => message.result?.id === latestPreviewResult.id))} onPreviewImage={openRemoteImagePreview} />
                    </div>
                  ))}
                </div>
              ) : null}
            </article>

            <div className="wb-result-actions">
              <button type="button" className="secondary-button" onClick={() => {
                setIntent("chat");
                setPane("chat"); setNotice("请在输入框说明要修改的内容。");
              }}>继续修改</button>
              <button type="button" className="primary-button" onClick={event => openWritePicker("insert-note", latestPreviewResult, event.currentTarget)}>
                插入笔记
              </button>
              <button type="button" className="secondary-button" onClick={event => openWritePicker("new-note", latestPreviewResult, event.currentTarget)}>
                保存为新笔记
              </button>
              <button type="button" className="secondary-button" onClick={() => download(latestPreviewResult)}>
                <Download size={14} aria-hidden /> 下载
              </button>
            </div>
          </>
        )}
      </section>
    );
  };

  return (
    <div className="wb" style={{ "--wb-sidebar-width": `${sidebarWidth}px` } as CSSProperties} data-pane={pane} data-panel={panelOpen ? "open" : "closed"} data-sidebar={sidebar}>
      <aside ref={sidebarRef} className="wb-sessions" aria-label="会话列表">
        <div className="wb-sessions-head">
          <button type="button" className="secondary-button wb-pane-back" onClick={() => setPane("chat")}>
            返回对话
          </button>
          <h2>会话</h2>
          <button type="button" className="wb-icon-button" aria-label="新建会话" title="新建会话" onClick={() => openSession(currentScope)}>
            <Plus size={18} aria-hidden />
          </button>
        </div>
        {sessions.length === 0 ? (
          <p className="wb-empty-note" title="还没有会话。新建一个就能开始聊天。">还没有会话<span className="ui-secondary-copy">。新建一个就能开始聊天。</span></p>
        ) : (
          <ul className="wb-session-list">
            {sessions.map((item) => (
              <li key={item.id} data-active={item.id === activeId}>
                {confirmDelete === item.id ? (
                  <div className="wb-session-confirm" role="group" aria-label="删除会话确认">
                    <span>删除这个会话？</span>
                    <button
                      type="button"
                      className="secondary-button"
                      data-tone="danger"
                      onClick={() => {
                        void (async () => {
                          if (!sessionApi) return removeSession(item.id);
                          const revision = useWorkbenchStore.getState().revisions[item.id];
                          if (!revision) return removeSession(item.id);
                          try {
                            /*
                             * 删除：先取消执行与检查点、收拢在途保存在拿最新 revision；
                             * 失败可撤销（会话恢复可编辑可保存），只有成功才永久禁写。
                             */
                            if (useWorkbenchStore.getState().activeId === item.id) abortRef.current?.abort();
                            beginSessionDelete(item.id);
                            await settleSession(item.id);
                            const latest = useWorkbenchStore.getState().revisions[item.id] ?? revision;
                            await sessionApi.remove({ id: item.id, baseRevision: latest });
                            markSessionDeleted(item.id);
                            removeSession(item.id);
                            setNotice(undefined);
                          } catch (error) {
                            cancelSessionDelete(item.id);
                            setNotice(error instanceof Error ? error.message : "删除失败，会话已保留。");
                          }
                        })();
                        setConfirmDelete(undefined);
                      }}
                    >
                      删除
                    </button>
                    <button type="button" className="secondary-button" onClick={() => setConfirmDelete(undefined)}>
                      取消
                    </button>
                  </div>
                ) : renaming?.id === item.id ? (
                  <div className="wb-session-confirm" role="group" aria-label="重命名会话">
                    <input
                      value={renaming.title}
                      aria-label="会话名称"
                      onChange={event => setRenaming({ id: item.id, title: event.target.value })}
                    />
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        const title = renaming.title.trim();
                        if (!title) return setRenaming(undefined);
                        renameSession(item.id, title);
                        setRenaming(undefined);
                        // 手动命名立即提交；失败保留草稿并提示。
                        void saveSession(sessionApi!, item.id, { title });
                      }}
                    >
                      保存
                    </button>
                    <button type="button" className="secondary-button" onClick={() => setRenaming(undefined)}>
                      取消
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className="wb-session"
                      onClick={() => {
                        void (async () => {
                          if (!sessionApi) {
                            selectSession(item.id);
                            setSourceResultChoice(undefined);
                            return;
                          }
                          try {
                            const ok = await switchSession(sessionApi, item.id);
                            if (ok) {
                              setSourceResultChoice(undefined);
                              setNotice(undefined);
                            } else setNotice("当前会话还有未保存内容，先保存成功再切换。");
                          } catch (error) {
                            setNotice(`无法打开会话：${error instanceof Error ? error.message : "读取失败，请稍后重试。"}${error instanceof SessionApiError ? `（${error.code}）` : ""}`);
                          }
                        })();
                        setPane("chat");
                      }}
                    >
                      <span className="wb-session-title">{item.title}</span>
                      <small>
                        {item.scope.kind === "free" ? "自由对话" : describeScope(item.scope)} · {formatTime(item.updatedAt)}
                        {/* 保存状态：只表示对应内容已提交给本地存储。 */}
                        {saveStates[item.id] === "saving" ? " · 保存中…" : null}
                        {saveStates[item.id] === "saved" ? " · 已保存" : null}
                        {saveStates[item.id] === "error" ? " · 保存失败" : null}
                        {saveStates[item.id] === "conflict" ? " · 保存冲突，需重新读取" : null}
                      </small>
                    </button>
                    <button
                      type="button"
                      className="wb-icon-button"
                      aria-label={`重命名会话：${item.title}`}
                      onClick={() => setRenaming({ id: item.id, title: item.title })}
                    >
                      <Pencil size={14} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="wb-icon-button"
                      aria-label={`删除会话：${item.title}`}
                      onClick={() => setConfirmDelete(item.id)}
                    >
                      <Trash2 size={14} aria-hidden />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="wb-resize" role="separator" aria-label="调整会话栏宽度" aria-orientation="vertical" aria-valuemin={220} aria-valuemax={360} aria-valuenow={sidebarWidth} tabIndex={0}
          onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId) && sidebarRef.current) resizeSidebar(event.clientX - sidebarRef.current.getBoundingClientRect().left); }}
          onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onPointerCancel={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onKeyDown={event => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); resizeSidebar(event.key === "Home" ? 220 : event.key === "End" ? 360 : sidebarWidth + (event.key === "ArrowRight" ? 10 : -10)); }}
        />
      </aside>

      <main className="wb-chat" aria-label="对话">
        {notice ? <div className="global-notice" role="status" aria-live="polite"><span>{notice}</span></div> : null}
        <header className="wb-chat-head">
          <button
            type="button"
            className="secondary-button wb-pane-toggle"
            aria-expanded={pane === "sessions"}
            onClick={() => setPane("sessions")}
          >
            会话
          </button>
          {/* 桌面：收起/展开左侧会话栏，把主区域让给对话。 */}
          <button
            type="button"
            className="wb-icon-button wb-sidebar-toggle"
            aria-expanded={sidebar === "open"}
            title={sidebar === "open" ? "收起会话栏" : "展开会话栏"}
            aria-label={sidebar === "open" ? "收起会话栏" : "展开会话栏"}
            onClick={() => setSidebar((current) => (current === "open" ? "collapsed" : "open"))}
          >
            <PanelLeft size={18} aria-hidden />
          </button>
          <div className="wb-scope-control">
            <button
              type="button"
              className="wb-scope"
              aria-haspopup="dialog"
              aria-label={`参考笔记：${describeScope(currentScope)}`}
              title={`选择参考笔记：${describeScope(currentScope)}`}
              onClick={() => setPicker("scope")}
            >
              <BookText size={15} aria-hidden />
              <span>
                <span className="ui-secondary-copy">参考笔记：</span><strong>{describeScope(currentScope)}</strong>
              </span>
              <ChevronDown size={14} aria-hidden />
            </button>
            {currentScope.kind !== "free" ? (
              <button
                type="button"
                className="wb-icon-button wb-clear-scope"
                aria-label="取消参考笔记"
                title="取消参考笔记"
                onClick={() => session ? setScope(session.id, { kind: "free" }) : setDraftScope({ kind: "free" })}
              >
                <X size={18} aria-hidden />
              </button>
            ) : null}
          </div>
          {latestPreviewResult ? <button
            type="button"
            className="wb-icon-button"
            aria-label="结果预览" title="结果预览"
            aria-expanded={panelOpen && panel === "preview"}
            onClick={() => {
              const closing = panelOpen && panel === "preview";
              setPanel("preview");
              setPanelOpen(!closing);
              setPane(closing ? "chat" : "panel");
            }}
          >
            <PanelRight size={18} aria-hidden />
          </button> : null}
        <div className="wb-head-tools">
          <button
            type="button"
            className="wb-icon-button"
            aria-label="随记" title={`随记（${quickNotes.messages.length}）`} aria-expanded={panelOpen && panel === "notes"}
            onClick={() => {
              setPanel("notes");
              setPanelOpen(true);
              setPane("panel");
            }}
          >
            <StickyNote size={18} aria-hidden />
          </button>
          <button
            type="button"
            className="wb-icon-button"
            aria-label="设置" title="设置" aria-busy={memoryStatus === "loading"} aria-expanded={panelOpen && panel === "capabilities"}
            onClick={() => {
              if (onOpenSettings) { onOpenSettings(); return; }
              setPanel("capabilities");
              setPanelOpen(true);
              setPane("panel");
            }}
          >
            <ShieldCheck size={18} aria-hidden />
          </button>
        </div>
        </header>

        {restoreNotice ? <p className="wb-restore-notice" role="alert">{restoreNotice}</p> : null}
        {sessionStatus === "error" ? (
          <p className="wb-notice" role="status">
            {sessionError ?? "读取本地会话失败。"}
          </p>
        ) : null}
        {!memoryBypass && memoryStatus === "error" ? (
          <div className="wb-notice" role="status">
            读取本地记忆失败。
            <button type="button" className="secondary-button" onClick={() => onMemoryRetry?.()}>
              重试读取记忆
            </button>
            <button type="button" className="secondary-button" onClick={() => setMemoryBypass(true)}>
              本次不用记忆
            </button>
          </div>
        ) : null}
        {memoryBypass ? (
          <p className="wb-composer-hint">
            本次不使用记忆。
            <button type="button" className="text-button" onClick={() => setMemoryBypass(false)}>
              恢复使用
            </button>
          </p>
        ) : null}

        <div className="wb-stream" ref={streamRef} aria-label="会话记录" tabIndex={0} aria-live="polite" onScroll={event => {
          const stream = event.currentTarget;
          nearBottomRef.current = stream.scrollHeight - stream.clientHeight - stream.scrollTop <= 80;
          setAwayFromBottom(!nearBottomRef.current);
        }} onLoadCapture={() => { if (nearBottomRef.current) scrollToBottom(); }}>
          <div className="wb-stream-content">
          {!session ? (
            <div className="wb-empty">
              <h3 title="写下问题，或选择下方技能引用。">新对话</h3>
              <p className="ui-secondary-copy">写下问题，或选择下方技能引用。</p>
            </div>
          ) : session.messages.length === 0 ? (
            <div className="wb-empty">
              <h3 title={`参考笔记：${describeScope(currentScope)}。写下第一句，或用下面的技能引用。`}>这个会话还没有内容</h3>
              <p className="ui-secondary-copy">参考笔记：{describeScope(currentScope)}。写下第一句，或用下面的技能引用。</p>
            </div>
          ) : (
            session.messages.map((message) => (
              <article key={message.id} className="wb-message" data-role={message.role} data-message-id={message.id} aria-label={message.role === "user" ? "我的消息" : "助手回复"}>
                {message.result?.demo ? <span className="wb-demo-flag">演示</span> : null}
                {message.role === "assistant" ? renderTimeline(message) : null}
                <WorkbenchSkillReferences value={message.skillReferences ?? []} />
                {message.text && message.role === "user"
                  ? <p className="wb-answer">{message.text}</p> : null}
                {message.references && message.references.length > 0 ? (
                  <ul className="wb-message-refs">
                    {message.references.map((reference) => (
                      <li key={reference.id}>{reference.text.slice(0, 40) || "（无文字）"}</li>
                    ))}
                  </ul>
                ) : null}
                {message.role === "user" ? messageMedia(message) : null}
                {message.text && message.role === "assistant" && (message.attachments?.length || message.result?.kind === "image") && message.result?.kind !== "text"
                  ? resultActions(textResultFor(message)) : null}
                {message.result?.kind === "text" ? resultActions(message.result) : null}
                {message.status === "pending" && message.process?.phase === "waiting" && !message.process.outcome ? (
                  <p className="wb-waiting" role="status">{message.process.waitingLabel || "等待处理"}</p>
                ) : null}
                {message.saveFailed ? (
                  <div className="wb-write-actions">
                    <button type="button" className="secondary-button" disabled={saveBusy} onClick={() => retrySave(message)}>
                      {saveBusy ? "保存中…" : "重试保存"}
                    </button>
                  </div>
                ) : null}
                {message.status === "failed" ? (
                  <div className="wb-failed" role="alert">
                    <span>{message.error ?? "生成失败。"}</span>
                    {!message.localEdit && !(message.saveFailed && message.tools?.some(tool => tool.name === "image-edit")) &&
                    !((message.attachments?.length ?? 0) > 0 && (message.tools ?? []).some(tool => tool.name === "image-edit" && tool.ok === false)) &&
                    // R1：有计划且有部分交付的消息，由下方专用补修入口负责（避免重复按钮）。
                    !(message.imagePlan && planHasUnfinished(message) && (message.attachments?.length ?? 0) > 0) ? (
                      <button type="button" className="secondary-button" onClick={() => retry(message)}>
                        {message.imagePlan
                          ? planHasUnknown(message) ? "重新生成（可能再次计费）" : "重试未完成的图片"
                          : message.tools?.some(tool => tool.name === "image-edit") && (message.request?.attachments.length ?? 0) > 0
                            ? "重试未完成的图片" : "重试"}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {/*
                 * 部分成功：已完成图片保留在回复里，这里只提供**重试未完成项**的入口
                 * （重试只补失败/未完成项并沿用原计划；结果未知的项显示「重新生成」，不自动执行）。
                 */}
                {(message.attachments?.length ?? 0) > 0 &&
                ((message.imagePlan ? planHasUnfinished(message) : false) ||
                (message.tools ?? []).some(tool => tool.name === "image-edit" && tool.ok === false)) ? (
                  <div className="wb-write-actions">
                    <button type="button" className="secondary-button" disabled={sending} onClick={() => retry(message)}>
                      {message.imagePlan && planHasUnknown(message) ? "重新生成（可能再次计费）" : "重试未完成的图片"}
                    </button>
                  </div>
                ) : null}
                {message.result?.kind === "handbook-page" ? (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setPreviewId(message.id);
                      setPanel("preview");
                      setPanelOpen(true);
                      setPane("panel");
                    }}
                  >
                    打开预览
                  </button>
                ) : null}
              </article>
            ))
          )}
          </div>
        </div>

        {awayFromBottom ? <div className="wb-scroll-return"><button type="button" className="secondary-button" onClick={() => {
          nearBottomRef.current = true; setAwayFromBottom(false); scrollToBottom();
        }}><ArrowDown size={14} aria-hidden />回到底部</button></div> : null}

        {currentScope.kind === "note" && noteCards.length > 0 ? (
          <StackedImageDeck cards={noteCards} selectedKey={preparingNoteImage} selectedKeys={selectedNoteImages} onSelect={card => { void selectNoteImage(card.key); }}
            title="笔记图片" action="选中" className="wb-note-image-deck" busy={!!preparingNoteImage} />
        ) : null}
        <div className="wb-composer-stack">
          {queue.length > 0 ? (
            <section ref={queuePanelRef} className={`wb-queue${queueMenu ? " has-open-menu" : ""}`} aria-label="待办工作">
              <span className="sr-only" aria-live="polite" aria-atomic="true">{queue.length} 条待发送</span>
              <ol className="wb-queue-list" aria-label="排队中的消息" tabIndex={0}
                onWheel={() => setQueueMenu(undefined)} onTouchMove={() => setQueueMenu(undefined)}
                onKeyDown={event => {
                  if (event.target === event.currentTarget && ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) setQueueMenu(undefined);
                }}>
                {queue.map(entry => {
                  const summary = entry.text || (entry.attachments.length ? `${entry.attachments.length} 张图片` : "引用素材");
                  const editing = queueEdit?.id === entry.id;
                  return <li key={entry.id} data-queue-id={entry.id} data-editing={editing}
                    data-dragging={queueDrop?.id === entry.id} data-drop-target={queueDrop?.targetId === entry.id}>
                    <button type="button" className="wb-queue-order" aria-label={`调整待办顺序：${summary}`}
                      title="拖动调整顺序，或点击选择上移、下移" aria-haspopup="menu"
                      aria-expanded={queueMenu?.kind === "order" && queueMenu.id === entry.id}
                      disabled={queue.length < 2 || Boolean(queueEdit) || queuedStartingId === entry.id}
                      onPointerDown={event => {
                        if (event.button !== 0 || queueDragRef.current) return;
                        event.preventDefault();
                        const handle = event.currentTarget;
                        handle.focus({ preventScroll: true });
                        queueDragRef.current = { id: entry.id, targetId: entry.id, pointerId: event.pointerId,
                          startY: event.clientY, moved: false, wasOpen: queueMenuStateRef.current?.kind === "order" && queueMenuStateRef.current.id === entry.id,
                          sessionId: activeId, handle };
                        setQueueMenu(undefined);
                        handle.setPointerCapture?.(event.pointerId);
                      }}
                      onPointerMove={event => {
                        const drag = queueDragRef.current;
                        if (!drag || drag.pointerId !== event.pointerId || Math.abs(event.clientY - drag.startY) < 4 && !drag.moved) return;
                        drag.moved = true;
                        setQueueMenu(undefined);
                        const list = event.currentTarget.closest("ol");
                        if (!list) return;
                        const bounds = list.getBoundingClientRect();
                        if (event.clientY < bounds.top + 20) list.scrollTop -= 12;
                        else if (event.clientY > bounds.bottom - 20) list.scrollTop += 12;
                        const rows = [...list.querySelectorAll<HTMLElement>(":scope > li")];
                        const nearest = rows.reduce((best, row) => {
                          const distance = (node: HTMLElement) => { const rect = node.getBoundingClientRect(); return Math.abs(event.clientY - (rect.top + rect.bottom) / 2); };
                          return distance(row) < distance(best) ? row : best;
                        });
                        drag.targetId = nearest.dataset.queueId!;
                        setQueueDrop({ id: drag.id, targetId: drag.targetId });
                      }}
                      onPointerUp={event => {
                        if (queueDragRef.current?.pointerId === event.pointerId) finishQueueDrag(true, { x: event.clientX, y: event.clientY });
                      }}
                      onPointerCancel={event => { if (queueDragRef.current?.pointerId === event.pointerId) finishQueueDrag(false); }}
                      onLostPointerCapture={event => { if (queueDragRef.current?.pointerId === event.pointerId) finishQueueDrag(false); }}
                      onKeyDown={event => { if (event.key === "Escape" && queueDragRef.current) { event.preventDefault(); finishQueueDrag(false); } }}
                      onClick={event => { if (event.detail === 0) openQueueMenu(event.currentTarget, entry.id, "order"); }}>
                      <GripVertical size={15} aria-hidden />
                    </button>
                    {entry.attachments[0] ? <span className="wb-queue-thumbnail" aria-hidden
                      style={{ backgroundImage: `url("${entry.attachments[0].dataUrl}")` }} /> : null}
                    <div className="wb-queue-content">
                      {editing ? <>
                        <textarea ref={queueEditorRef} className="wb-queue-editor" aria-label={`编辑待办：${summary}`}
                          value={queueEdit.text} rows={2} onChange={event => setQueueEdit({ id: entry.id, text: event.target.value })}
                          onKeyDown={event => {
                            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelQueueEdit(); }
                            else if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
                              event.preventDefault(); saveQueueEdit();
                            }
                          }} />
                        <div className="wb-queue-edit-actions">
                          <button type="button" onClick={() => saveQueueEdit()}>保存</button>
                          <button type="button" onClick={cancelQueueEdit}>取消编辑</button>
                        </div>
                      </> : <span className="wb-queue-text" title={summary}>{summary}</span>}
                      <WorkbenchSkillReferences value={entry.skillReferences ?? []} />
                    </div>
                    <div className="wb-queue-actions">
                      <button type="button" className="wb-queue-run" aria-label={`立即工作：${summary}`}
                        disabled={Boolean(queueEdit && !editing)} onClick={() => runQueuedNow(entry.id)}>
                        <CornerDownRight size={15} aria-hidden /><span>立即工作</span>
                      </button>
                      <button type="button" className="wb-queue-remove" aria-label={`删除排队消息：${summary}`}
                        onClick={() => removeQueued(entry.id)}><Trash2 size={15} aria-hidden /></button>
                      <button type="button" className="wb-queue-more" aria-label={`待办更多操作：${summary}`}
                        aria-haspopup="menu" aria-expanded={queueMenu?.kind === "actions" && queueMenu.id === entry.id} disabled={Boolean(queueEdit)}
                        onClick={event => openQueueMenu(event.currentTarget, entry.id, "actions")}><MoreHorizontal size={17} aria-hidden /></button>
                    </div>
                  </li>;
                })}
              </ol>
              {queueMenu ? <div ref={queueMenuRef} className="wb-queue-menu" role="menu" aria-label={queueMenu.kind === "order" ? "调整待办顺序" : "待办操作"}
                style={{ top: queueMenu.top, right: queueMenu.right }} onKeyDown={event => {
                  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
                  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                  buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 :
                    (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus({ preventScroll: true });
                }}>
                {queueMenu.kind === "order" ? <>
                  <button type="button" role="menuitem"
                    disabled={!queueOrderUp || queuedStartingId === queueMenu.id || queuedStartingId === queueOrderUp.id}
                    onClick={() => moveQueuedBy(-1)}><ArrowUp size={16} aria-hidden />上移</button>
                  <button type="button" role="menuitem"
                    disabled={!queueOrderDown || queuedStartingId === queueMenu.id || queuedStartingId === queueOrderDown.id}
                    onClick={() => moveQueuedBy(1)}><ArrowDown size={16} aria-hidden />下移</button>
                </> : <button type="button" role="menuitem" onClick={() => {
                  const item = queueRef.current.find(entry => entry.id === queueMenu.id);
                  setQueueMenu(undefined);
                  if (!item) return;
                  if (queuedStartingRef.current === item.id) { setNotice("这条待办正在启动，请稍候。"); return; }
                  setQueueEdit({ id: item.id, text: item.text });
                }}><Pencil size={16} aria-hidden />再次编辑</button>}
              </div> : null}
            </section>
          ) : null}
        <form
          ref={composerRef}
          className={`wb-composer${draggingImage ? " is-dragging-image" : ""}`}
          onDragOver={event => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = sending ? "none" : "copy";
            setDraggingImage(!sending);
          }}
          onDragLeave={event => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingImage(false);
          }}
          onDrop={event => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            setDraggingImage(false);
            void attachImages(event.dataTransfer.files);
          }}
          onSubmit={(event) => {
            event.preventDefault();
            if (sending) enqueueDraft();
            else void send();
          }}
        >
          {draggingImage ? <div className="wb-drop-hint" aria-hidden>松开以添加图片</div> : null}
          {readingImages ? <span className="wb-image-reading" role="status">正在添加图片…</span> : null}
          {references.length > 0 ? (
            <ul className="wb-refs" aria-label="已引用素材">
              {references.map((reference) => (
                <li key={reference.id}>
                  <span>{reference.text.slice(0, 24) || "（无文字）"}</span>
                  <button
                    type="button"
                    className="wb-icon-button"
                    aria-label={`移除引用：${reference.text.slice(0, 16) || "无文字"}`}
                    onClick={() => setReferences((current) => current.filter((item) => item.id !== reference.id))}
                  >
                    <X size={13} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {attachments.length > 0 ? (
            <ul className="wb-atts" aria-label="已附加图片">
              {attachments.map((attachment) => (
                <li key={attachment.id}>
                  {peekNativeView(attachment).url
                    ? <img src={peekNativeView(attachment).url} alt={attachment.name} decoding="async" />
                    : <span className="wb-native-view-state" data-state={peekNativeView(attachment).state}>{peekNativeView(attachment).state === "loading" || peekNativeView(attachment).state === "idle" ? "…" : "!"}</span>}
                  <button
                    type="button"
                    className="wb-icon-button"
                    aria-label={`移除图片：${attachment.name}`}
                    onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                  >
                    <X size={13} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {sourceImageResult?.dataUrl ? (
            <div className="wb-edit-source" role="status">
              <img src={sourceImageResult.dataUrl} alt="" />
              <span>正在修改这张图片</span>
              <button type="button" className="wb-icon-button" aria-label="取消选中的修改图片" onClick={() => {
                setSourceResultChoice(undefined);
                setIntent("chat");
              }}><X size={14} aria-hidden /></button>
            </div>
          ) : null}
          {sourceResult?.kind === "text" ? (
            <div className="wb-edit-source" role="status">
              <span>正在修改这段文字：{sourceResult.title}</span>
              <button type="button" className="wb-icon-button" aria-label="取消选中的修改文字" onClick={() => setSourceResultChoice(undefined)}>
                <X size={14} aria-hidden />
              </button>
            </div>
          ) : null}
          <div className="wb-input-row">
            <label className="sr-only" htmlFor="wb-input">
              对话内容
            </label>
            <WorkbenchSkillReferences value={skillReferences} onRemove={id => setSkillReferences(current => current.filter(ref => ref.id !== id))} />
            <textarea
              id="wb-input"
              ref={inputRef}
              rows={1}
              value={text}
              // 运行中仍可编辑：回车入队，或点「立即发送」打断当前轮先发这条。
              placeholder={sending ? "运行中：回车加入队列，或点「立即发送」…" : "发送消息…"}
              title={sending ? "Enter 加入队列；Shift + Enter 换行" : "Enter 发送；Shift + Enter 换行"}
              aria-controls={commandQuery !== null ? "wb-command-list" : undefined}
              onChange={(event) => {
                const value = event.target.value;
                setText(value);
                const match = /^[$/]([^\s/$]*)$/.exec(value);
                setCommandQuery(match ? match[1] : null);
                setCommandIndex(0);
                if (commandRef.current) commandRef.current.open = !!match;
                if (match) composerRef.current?.querySelectorAll<HTMLDetailsElement>("details[open]").forEach(menu => {
                  if (menu !== commandRef.current) menu.open = false;
                });
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (commandRef.current?.open && commandQuery !== null) {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setCommandIndex(index => (index + (event.key === "ArrowDown" ? 1 : -1) + Math.max(1, commandActions.length)) % Math.max(1, commandActions.length));
                    return;
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    if (commandActions[commandIndex]) chooseSkill(commandActions[commandIndex]);
                    return;
                  }
                  if (event.key === "Escape") { event.preventDefault(); commandRef.current.open = false; setSkillMenuOpen(false); setCommandQuery(null); return; }
                }
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  if (sending) enqueueDraft();
                  else void send();
                }
              }}
            />
            <div className="wb-input-actions">
              <div className="wb-input-left">
                <input ref={fileRef} className="sr-only" tabIndex={-1} type="file" aria-label="附加图片" accept="image/png,image/jpeg,image/webp" multiple onChange={event => void attachImages(event.target.files)} />
                <details ref={commandRef} className="wb-actions-menu" data-dismiss-layer onToggle={event => {
                  setSkillMenuOpen(event.currentTarget.open);
                  if (!event.currentTarget.open) setCommandQuery(null);
                  else void refreshSkills();
                }}>
                  <summary aria-label="添加图片与技能" title="添加图片与技能" onClick={() => setCommandQuery(null)}><Plus size={21} aria-hidden /></summary>
                  {commandQuery !== null ? <span className="sr-only" role="status">{commandActions[commandIndex] ? skillDisplayName(commandActions[commandIndex]) : "没有匹配的技能"}，上下键选择，回车应用，Escape关闭</span> : null}
                  {skillMenuOpen ? <div id="wb-command-list" className="wb-quick" role="group" aria-label="安装的技能">
                    {commandQuery === null ? <button type="button" aria-label="添加图片" disabled={sending || readingImages || attachments.length >= CREATION_VISION_LIMITS.images} onClick={() => {
                      if (commandRef.current) commandRef.current.open = false;
                      if (currentScope.kind === "free") fileRef.current?.click();
                      else setImagePicker(true);
                    }}><ImageIcon size={18} aria-hidden /><span><strong>添加图片</strong><small>{attachments.length >= CREATION_VISION_LIMITS.images ? "已达到 9 张上限" : "可多选图片，也可拖入输入框"}</small></span></button> : null}
                    {skillCatalog.loading ? <p role="status">正在读取技能列表…</p> : skillCatalog.error ? <p role="alert">{skillCatalog.error}<button type="button" onClick={() => void refreshSkills()}>重新读取</button></p> : commandActions.map((entry, index) => (
                      <button key={entry.id} type="button" aria-label={`引用技能：${skillDisplayName(entry)}`} disabled={!entry.enabled || !entry.readable}
                        data-highlighted={commandQuery !== null && commandIndex === index} aria-pressed={skillReferences.some(ref => ref.id === entry.id)} onClick={() => chooseSkill(entry)}>
                        <BookText size={18} aria-hidden /><span><strong>{skillDisplayName(entry)}</strong><small>{!entry.enabled ? "已停用" : !entry.readable ? entry.error ?? "暂时不可读" : entry.description}</small></span>
                      </button>
                    ))}
                    {!skillCatalog.loading && !skillCatalog.error && commandActions.length === 0 ? <p role="status">{commandQuery === null ? "尚未安装技能" : "没有匹配的技能"}</p> : null}
                  </div> : null}
                </details>
                <details ref={imageToolsRef} className="wb-image-tools" data-active={isImageIntent} data-dismiss-layer onKeyDown={closeChipOnEscape}>
                  <summary role="button" aria-label="图像生成工具" title={isImageIntent ? "图像工具已启用，调整图片选项" : "图像生成工具"}
                    aria-disabled={sending}
                    onClick={event => {
                      if (sending) { event.preventDefault(); return; }
                      if (!isImageIntent) {
                        setIntent("chat");
                        setImageToolOpen(true);
                        setSourceResultChoice(undefined);
                      }
                    }}>
                    <ImageIcon size={17} aria-hidden /><span>图像</span><ChevronDown size={14} aria-hidden />
                  </summary>
                  <div className="wb-image-tools-panel" role="group" aria-label="图像工具选项">
                    <header className="wb-image-tools-head">
                      <strong>图像工具</strong>
                      <button type="button" aria-label="取消图像工具" title="本轮不使用图像工具" onClick={event => {
                        closeChip(event);
                        setIntent("chat");
                        setImageToolOpen(false);
                        setSourceResultChoice(undefined);
                      }}><X size={14} aria-hidden /></button>
                    </header>
                    {imageTool ? <>
                      <details className="wb-image-chip" name={imageFieldGroup}>
                        <summary aria-label="制图模型" title={`制图模型：${selectedImageModel ? imageModelName(selectedImageModel) : "未选择"}`}>
                          <span className="wb-image-field-label">模型</span>
                          <span className="wb-image-field-value">{selectedImageModel ? imageModelName(selectedImageModel) : "选择模型"}</span>
                          <ChevronDown size={14} aria-hidden />
                        </summary>
                        <div className="wb-image-chip-panel" role="group" aria-label="选择制图模型">
                          {imageTool.models.map(model => (
                            <button
                              key={model.id}
                              type="button"
                              aria-pressed={model.id === imageTool.modelId}
                              disabled={sending}
                              onClick={(event) => {
                                closeChip(event);
                                imageTool.onModelChange(model.id);
                              }}
                            >
                              <strong title={imageModelName(model)}>{imageModelName(model)}</strong>
                            </button>
                          ))}
                          {imageTool.models.length === 0 ? <p role="status">暂无可用制图模型，请检查模型配置和 AI／图片许可。</p> : null}
                        </div>
                      </details>
                      <details className="wb-image-chip" name={imageFieldGroup}>
                        <summary
                          aria-label="图片比例"
                          title={imageTool.size ? `${sizeRatio(imageTool.size) ?? "自定义"}（${imageTool.size}）` : "比例：自动"}
                        >
                          <span className="wb-image-field-label">比例</span>
                          <span className="wb-image-field-value">{imageTool.size ? sizeRatio(imageTool.size) ?? "自定义" : "自动"}</span>
                          <ChevronDown size={14} aria-hidden />
                        </summary>
                        <div className="wb-image-chip-panel wb-ratio-grid" role="group" aria-label="选择图片比例">
                          <button
                            type="button"
                            aria-pressed={!imageTool.size}
                            disabled={sending || !selectedImageModel}
                            onClick={(event) => {
                              closeChip(event);
                              imageTool.onSizeChange(undefined);
                            }}
                          >
                            <span className="wb-ratio-icon" data-auto="true" aria-hidden><ImageIcon size={15} /></span>
                            <small>自动</small>
                          </button>
                          {/* 只列该模型**声明过**的尺寸派生出的比例：给不出的选项不假装存在。 */}
                          {ratioTiles(selectedImageModel?.imageSizes ?? []).map(tile => (
                            <button
                              key={tile.ratio}
                              type="button"
                              aria-pressed={imageTool.size === tile.size}
                              title={`${tile.ratio}（${tile.size}）`}
                              disabled={sending || !selectedImageModel}
                              onClick={(event) => {
                                closeChip(event);
                                imageTool.onSizeChange(tile.size);
                              }}
                            >
                              {/*
                                形状必须**看得出比例**：容器是固定方框，里面的形状按比例定尺寸。
                                直接给形状设 width + max-height 会把竖版压成方块（9:16 和 1:1 长得一样）。
                               */}
                              <span className="wb-ratio-icon" data-shape={ratioShape(tile.ratio)} aria-hidden>
                                <i style={{ aspectRatio: tile.ratio.replace(":", " / ") }} />
                              </span>
                              <small>{tile.ratio}</small>
                            </button>
                          ))}
                        </div>
                      </details>
                      {availableImageFormats.length > 0 && imageTool.onOutputFormatChange ? (
                        <details className="wb-image-chip wb-image-format" name={imageFieldGroup}>
                          <summary aria-label="图片格式" title={`图片格式：${selectedImageFormat?.toUpperCase()}`}>
                            <span className="wb-image-field-label">格式</span><span className="wb-image-field-value">{selectedImageFormat?.toUpperCase()}</span><ChevronDown size={14} aria-hidden />
                          </summary>
                          <div className="wb-image-chip-panel wb-image-format-panel" role="group" aria-label="选择图片格式">
                            {availableImageFormats.map(format => (
                              <button key={format} type="button" aria-pressed={format === selectedImageFormat} disabled={sending}
                                onClick={event => { closeChip(event); imageTool.onOutputFormatChange!(format); }}>
                                <strong>{format.toUpperCase()}</strong><small>{format === "png" ? "无损格式" : "文件更小"}</small>
                              </button>
                            ))}
                          </div>
                        </details>
                      ) : null}
                      <details className="wb-image-chip" name={imageFieldGroup}>
                        <summary aria-label="图片风格" title={`图片风格：${IMAGE_STYLE_LABELS[imageTool.style]}`}><span className="wb-image-field-label">风格</span><span className="wb-image-field-value">{IMAGE_STYLE_LABELS[imageTool.style]}</span><ChevronDown size={14} aria-hidden /></summary>
                        <div className="wb-image-chip-panel" role="group" aria-label="图片风格选项">
                          {/* 27 个预设风格按两组展示，由外层图像面板统一滚动。 */}
                          <div className="wb-style-groups">
                            <div className="wb-style-group">
                              <p className="wb-image-chip-title">风格</p>
                              <div className="wb-style-list" role="group" aria-label="选择图片风格">
                                <button
                                  type="button"
                                  aria-pressed={imageTool.style === "none"}
                                  disabled={sending}
                                  onClick={(event) => {
                                    closeChip(event);
                                    imageTool.onStyleChange("none");
                                  }}
                                >
                                  {IMAGE_STYLE_LABELS.none}
                                </button>
                              </div>
                            </div>
                            {IMAGE_STYLE_GROUPS.map(group => (
                              <div key={group.title} className="wb-style-group">
                                <p className="wb-image-chip-title">{group.title}</p>
                                <div className="wb-style-list" role="group" aria-label={`选择图片风格：${group.title}`}>
                                  {group.styles.map(style => (
                                    <button
                                      key={style}
                                      type="button"
                                      aria-pressed={style === imageTool.style}
                                      disabled={sending}
                                      onClick={(event) => {
                                        closeChip(event);
                                        imageTool.onStyleChange(style);
                                      }}
                                    >
                                      {IMAGE_STYLE_LABELS[style]}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </details>
                      {imageToolBlocker ? <p className="wb-image-chip-note" role="status">{imageToolBlocker}</p> : null}
                    </> : <p className="wb-image-options-notice" role="status">图像工具配置不可用。</p>}
                  </div>
                </details>
              </div>
              <div className="wb-input-right">
              {controls || modelStatus ? <details className="wb-settings" data-dismiss-layer onKeyDown={event => {
                if (event.key === "Escape") { event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); }
              }}>
                <summary aria-label={controls ? "模型与发送内容" : "本轮信息"} title={controls ? modelLabel : "查看本轮上下文与模型能力"}><SlidersHorizontal size={16} aria-hidden /><span>{controls ? modelLabel : "本轮信息"}</span><ChevronDown size={14} aria-hidden /></summary>
                <div className="wb-composer-tools">
                  {controls}
                  <div className="wb-composer-information">
                    {modelStatus}
                  </div>
                </div>
              </details> : null}
              {/* 立即发送：打断当前轮，把输入框这条插到队首先发（真"插进这一轮"没有实现基础）。 */}
              {sending && (text.trim() || queue.length > 0) ? (
                <button type="button" className="secondary-button wb-send-now" aria-label="立即发送"
                  title="打断当前这一轮，马上发送这条" disabled={Boolean(queueEdit)} onClick={sendQueuedNow}>
                  立即发送
                </button>
              ) : null}
              {/* 运行中同一个位置就是取消：不再在回答里单独放一个取消按钮。 */}
              {sending ? (
                <button type="button" className="primary-button wb-send wb-send--cancel" aria-label="取消" title="取消"
                  onClick={event => { event.preventDefault(); abortRef.current?.abort(); }}>
                  <Square size={16} aria-hidden fill="currentColor" />
                </button>
              ) : (
                <button type="submit" className="primary-button wb-send" aria-label="发送" title="发送" disabled={!!preparingNoteImage || readingImages}>
                  <ArrowUp size={20} aria-hidden />
                </button>
              )}
              </div>
            </div>
          </div>
        </form>
          {!memoryBypass && memoryStatus === "loading" && memoryLoadingSlow ? (
            <div className="wb-composer-hint wb-composer-footer">
              <span role="status">
                正在读取记忆…
                <button type="button" className="text-button" onClick={() => setMemoryBypass(true)}>
                  本次不用记忆
                </button>
              </span>
            </div>
          ) : null}
        </div>
      </main>

      {panelOpen ? <aside ref={panelRef} className="wb-panel-slot">{panelContent()}</aside> : null}

      {viewer && viewer.images.length > 0 ? <PhotoViewer variant="workbench" external={viewer.images.some(image => !!image.search)}
        images={viewer.images.map(image => { const file = viewerFiles[viewerKey(viewer, image)];
          return file && hasInlineData(file.attachment) ? { ...image, url: file.attachment.dataUrl, blob: file.blob, versionLabel: file.attachment.id } : image; })}
        initialId={viewer.initialId} returnFocus={viewer.trigger} renderFooter={renderViewerEditor}
        renderOverlay={(activeImage, size) => {
          const image = viewer.images.find(candidate => candidate.id === activeImage.id);
          if (!image) return null;
          const key = viewerKey(viewer, image), draft = viewerEditDrafts[key];
          if (!draft?.mode || !["crop", "erase", "annotate"].includes(draft.mode) || !image.ownerId || image.search && !viewerFiles[key]) return null;
          return <WorkbenchImageSelection width={size.width} height={size.height} bounds={draft.bounds}
            onChange={bounds => setViewerEditDrafts(previous => ({ ...previous, [key]: { ...previous[key], bounds, sourceWidth: size.width, sourceHeight: size.height } }))} />;
        }}
        onDownload={async image => { const source = viewer.images.find(candidate => candidate.id === image.id);
          if (!source) throw new Error("未找到当前图片。"); downloadWorkbenchImageFile(await ensureViewerFile(viewer, source)); }}
        onShare={nativeImageShare ? async image => {
          const source = viewer.images.find(candidate => candidate.id === image.id);
          if (!source) return;
          // 原字节分享：fileRef 附件经查看器文件通道取原件；blob URL 直接分享同一字节。
          const file = await ensureViewerFile(viewer, source);
          const share = nativeImageShare;
          if (!share) return;
          await share({ title: image.name, text: image.name, url: file.attachment.dataUrl ?? image.url, blob: file.blob, fileName: file.attachment.name });
        } : undefined}
        onClose={() => { viewerRef.current = undefined; setViewer(undefined); setViewerFiles({}); }} /> : null}

      {imagePicker ? <WorkbenchImagePicker key={`${activeId ?? "draft"}:${JSON.stringify(currentScope)}`} scope={currentScope} notebooks={notebooks}
        maxSelection={Math.max(0, CREATION_VISION_LIMITS.images - attachments.length)}
        onClose={() => setImagePicker(false)}
        onSystemFiles={() => { setImagePicker(false); fileRef.current?.click(); }}
        onSelect={images => { setAttachments(current => [...current, ...images.filter(image => !current.some(item => item.id === image.id))]); if (images.length > 0) setSourceResultChoice(undefined); setImagePicker(false); }}
      /> : null}

      {write.target ? (
        <div ref={writeDialogRef} className="wb-modal wb-write-modal" role="dialog" aria-modal="true" aria-label="写入预览"
          onKeyDown={event => {
            if (event.key === "Escape") { event.preventDefault(); closeWriteDialog(); }
            if (event.key !== "Tab") return;
            const buttons = Array.from(writeDialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
            if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
            else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
          }}
          >
          <div ref={writeCardRef} className="wb-modal-card wb-write-modal-card">
            <header className="wb-modal-head">
              <h3>写入预览</h3>
              <button type="button" className="wb-icon-button" aria-label="关闭写入预览" title="关闭写入预览" onClick={closeWriteDialog}><X size={18} aria-hidden /></button>
            </header>
            <p className="wb-panel-hint">目标：{write.target.kind === "insert-into-note"
              ? `《${write.target.notebookTitle}》/《${write.target.noteTitle}》`
              : `《${write.target.notebookTitle}》新建《${write.target.title}》`}</p>
            <pre className="wb-write-preview">{write.receipt?.preview ?? (write.result ? buildWritePreview(write.result, write.noteBody) : "")}</pre>
            {!write.receipt && write.result?.demo ? <p className="wb-panel-hint">演示模式：确认后只显示回执，不会改动真实笔记。</p> : null}
            {write.receipt ? <p className="wb-receipt" role="status">{write.receipt.message}</p> : null}
            <div className="wb-write-actions">
              {write.receipt ? <button type="button" className="primary-button" onClick={closeWriteDialog}>完成</button> : <>
                <button type="button" className="primary-button" disabled={writing} onClick={() => void confirmWrite()}>
                  {writing ? "保存中…" : write.target.kind === "insert-into-note" ? "确认插入" : "确认保存"}
                </button>
                <button type="button" className="secondary-button" disabled={writing} onClick={closeWriteDialog}>取消</button>
              </>}
            </div>
          </div>
        </div>
      ) : null}

      {picker ? (
        <WorkbenchPicker
          mode={picker}
          notebooks={notebooks}
          currentScope={currentScope}
          onClose={() => { setPicker(undefined); setPendingWriteResult(undefined); }}
          onSelect={(value) => {
            if (picker === "scope") {
              // 没有会话时先记在草稿范围上，发送时自动建会话。
              if (session) setScope(session.id, value as WorkbenchScope);
              else setDraftScope(value as WorkbenchScope);
            } else {
              setWrite({ target: value as WriteTarget, result: pendingWriteResult, noteBody: noteBodyFor(value as WriteTarget), baseline: adapter.baselineFor?.(value as WriteTarget) });
              setPendingWriteResult(undefined);
            }
            setPicker(undefined);
          }}
        />
      ) : null}
    </div>
  );
}
