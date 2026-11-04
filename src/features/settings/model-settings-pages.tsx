"use client";

import { useDismissableLayer } from "@/lib/dismissable-layer";

/**
 * 设置内自助模型配置：**对话模型**与**制图模型**两个子页。
 *
 * 设计取舍（实际调用 ui-ux-pro-max 后的结论见实施记录）：
 * - 采用 Minimalism/Swiss 的“白卡 + 清晰分隔 + 单一蓝色强调”，但配色沿用项目既有 sky 变量，
 *   不引入技能输出的 shadcn 调色板与 Google Fonts（会造成新网络请求，且违反 DESIGN 约定）；
 * - 采用技能的 **Focusable Error Summary**：失败时在表单顶部给出可聚焦摘要，逐项链接到字段，
 *   同时保留字段级内联错误（`aria-describedby`）；
 * - **不采用**技能的 Hero/CTA 营销结构与 Server Actions 建议：设置页没有转化目标，
 *   且任务明确要求继续使用既有 API 路由而非 Server Actions。
 *
 * 密钥边界：密钥只在内存草稿里；不写 localStorage/sessionStorage，取消/成功/离开/卸载时清除。
 */
import { IMAGE_LIMITS } from "@/features/creation/creation-image-limits";
import {
  CHAT_API_PROTOCOLS,
  isLoopbackBaseUrl,
  type ChatApiProtocol
} from "@/features/ai/model-settings-contract";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ComponentPropsWithoutRef } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Download,
  Image as ImageIcon,
  MessageSquare,
  Plus,
  Trash2
} from "lucide-react";
import {
  discoverModelSettings,
  readModelSettings,
  saveModelSettings
} from "@/features/ai/ai-gateway-client";
import { CHAT_PRESETS, IMAGE_PRESETS, type ChatPreset, type ImagePreset } from "@/features/ai/model-presets";
import type {
  ManagedProvider,
  ModelSettingsRequest,
  ModelSettingsView,
  ProviderKind,
  ProviderOperation
} from "@/features/ai/model-settings-contract";

type Page = "index" | "chat" | "image";

/** Measure only an inspected name; no observer, timer or duplicate view state. */
function prepareModelNameScroll(box: HTMLElement) {
  const width = box.firstElementChild?.scrollWidth ?? 0;
  box.style.setProperty("--model-scroll-distance", `${Math.min(0, box.clientWidth - width)}px`);
  box.style.setProperty("--model-scroll-time", `${Math.max(5, (width - box.clientWidth) / 35)}s`);
}


/** 拉取到的模型一次最多渲染多少行（端点可能返回上千条，DOM 不该跟着长）。 */
const DISCOVERY_MAX_ROWS = 200;

/** 编辑草稿：只含可编辑字段；密钥**只存新输入值**，绝不回填既有值。 */
/** 应用级输入图上限（与图片路由同一份常量）：配置声明再多也只能用到这一档。 */
const MAX_SOURCE_IMAGES = IMAGE_LIMITS.sourceImages;

type ProviderDraft = {
  kind: ProviderKind;
  /** 服务端 ID；新增时为空（保存时由服务端生成）。 */
  id: string;
  isNew: boolean;
  name: string;
  baseUrl: string;
  models: { id: string; modelId: string; label: string }[];
  /** 新输入的密钥；空 = 保留现有凭据。 */
  apiKey: string;
  advancedOpen: boolean;
  /** 保存前保留密钥获取提示与官方文档入口。 */
  preset?: { keyHint: string; docsUrl: string };
  // 对话模型
  apiProtocol: ChatApiProtocol;
  responseFormat: "json_schema" | "json_object";
  // 制图模型
  generate: boolean;
  edit: boolean;
  imageSizes: string;
  /** 一次实际可用的输入图张数上限（应用最多 9；自定义默认 1）。 */
  maxSourceImages: number;
  editMode: "edits-multipart" | "generations-image";
  imagesPath: string;
  watermark: boolean | undefined;
  /** 制图：是否下发 `response_format`（gpt-image 系列不接受它）。 */
  omitResponseFormat: boolean;
  imageUrlHosts: string;
};

function draftFrom(provider: ManagedProvider): ProviderDraft {
  const chat = provider.kind === "chat";
  return {
    kind: provider.kind,
    id: provider.id,
    isNew: false,
    name: provider.name,
    baseUrl: provider.baseUrl,
    models: provider.models.map(({ id, modelId, label }) => ({ id, modelId, label })),
    apiKey: "",
    advancedOpen: false,
    apiProtocol: provider.apiProtocol ?? "openai-completions",
    responseFormat: provider.responseFormat ?? "json_schema",
    generate: provider.imageCapabilities?.generate ?? true,
    edit: provider.imageCapabilities?.edit ?? true,
    imageSizes: (provider.imageSizes ?? []).join(", "),
    maxSourceImages: Math.min(provider.maxSourceImages ?? 1, MAX_SOURCE_IMAGES),
    editMode: provider.editMode ?? "edits-multipart",
    imagesPath: provider.imagesPath ?? "/v1/images/generations",
    watermark: provider.watermark,
    omitResponseFormat: provider.omitResponseFormat === true,
    imageUrlHosts: (provider.imageUrlHosts ?? []).join(", "),
    ...(chat ? {} : {})
  };
}

function emptyDraft(kind: ProviderKind): ProviderDraft {
  return {
    ...draftFrom({
      id: "",
      kind,
      name: "",
      baseUrl: "",
      local: false,
      credentialConfigured: false,
      credentialSource: "none",
      models: [],
      responseFormat: "json_schema",
      capabilities: { structuredOutput: true, stream: true, vision: true },
      imageCapabilities: { generate: true, edit: true },
      imageSizes: [],
      editMode: "edits-multipart",
      imagesPath: "/v1/images/generations",
      imageUrlHosts: []
    }),
    isNew: true,
    models: [{ id: "", modelId: "", label: "" }],
    advancedOpen: true
  };
}

/**
 * 预设 → 草稿：与自定义草稿**同一条保存路径**，只是初值已按厂家填好。
 * 预填不等于锁定：地址、协议、模型目录在表单里都可改。
 */
function draftFromPreset(
  preset: ChatPreset | ImagePreset,
  kind: ProviderKind,
  id: string
): ProviderDraft {
  const common = {
    id: "",
    kind,
    name: preset.vendor,
    baseUrl: preset.baseUrl,
    // 预设都是公网 HTTPS 端点；本机与否仍由地址推导，不让用户回答。
    local: isLoopbackBaseUrl(preset.baseUrl),
    credentialConfigured: false,
    credentialSource: "none" as const,
    models: preset.models.map((model) => ({ id: "", modelId: model.modelId, label: model.label }))
  };
  const managed: ManagedProvider =
    kind === "chat"
      ? {
          ...common,
          apiProtocol: (preset as ChatPreset).apiProtocol,
          responseFormat: (preset as ChatPreset).responseFormat,
          capabilities: { structuredOutput: true, stream: true, vision: true }
        }
      : {
          ...common,
          imageCapabilities: (preset as ImagePreset).capabilities,
          imageSizes: (preset as ImagePreset).imageSizes,
          maxSourceImages: (preset as ImagePreset).maxSourceImages,
          editMode: (preset as ImagePreset).editMode,
          imagesPath: (preset as ImagePreset).imagesPath,
          imageUrlHosts: (preset as ImagePreset).imageUrlHosts,
          ...((preset as ImagePreset).omitResponseFormat !== undefined
            ? { omitResponseFormat: (preset as ImagePreset).omitResponseFormat }
            : {}),
          ...((preset as ImagePreset).watermark !== undefined
            ? { watermark: (preset as ImagePreset).watermark }
            : {})
        };
  return {
    ...draftFrom(managed),
    id,
    isNew: true,
    advancedOpen: false,
    preset: {
      keyHint: preset.keyHint,
      docsUrl: preset.docsUrl
    }
  };
}

type FieldError = { field: string; message: string };

/** 客户端预校验：与服务端同类规则，只为尽早给字段级错误；服务端仍是最终判定。 */
function validateDraft(draft: ProviderDraft, kind: ProviderKind): FieldError[] {
  const errors: FieldError[] = [];
  if (draft.name.trim().length === 0) errors.push({ field: "name", message: "请填写提供方名称。" });
  if (draft.baseUrl.trim().length === 0 || !/^https?:\/\//.test(draft.baseUrl.trim())) {
    errors.push({ field: "base-url", message: "API 地址必须是 http/https 开头的完整地址。" });
  } else {
    try {
      const url = new URL(draft.baseUrl.trim());
      if (url.username || url.password) errors.push({ field: "base-url", message: "API 地址不能内嵌账号或密码。" });
      if (url.search || url.hash) errors.push({ field: "base-url", message: "API 地址不能带 query 或 # 片段。" });
      const loopback = isLoopbackBaseUrl(draft.baseUrl);
      if (!loopback && url.protocol !== "https:") errors.push({ field: "base-url", message: "远程地址必须使用 https。" });
    } catch {
      errors.push({ field: "base-url", message: "API 地址无法解析。" });
    }
  }
  if (draft.models.length === 0) errors.push({ field: "models", message: "至少需要一条模型。" });
  draft.models.forEach((model, index) => {
    if (model.modelId.trim().length === 0) {
      errors.push({ field: `model-${index}`, message: `第 ${index + 1} 行缺少模型 ID。` });
    }
  });
  const duplicated = new Set<string>();
  for (const model of draft.models) {
    const id = model.modelId.trim();
    if (id && duplicated.has(id)) errors.push({ field: "models", message: `模型 ID 重复：${id}。` });
    duplicated.add(id);
  }
  if (kind === "image") {
    if (!Number.isInteger(draft.maxSourceImages) || draft.maxSourceImages < 1 || draft.maxSourceImages > MAX_SOURCE_IMAGES) {
      errors.push({ field: "max-source-images", message: `最多输入图必须为 1–${MAX_SOURCE_IMAGES} 张。` });
    }
    for (const size of splitList(draft.imageSizes)) {
      if (!/^\d{2,5}x\d{2,5}$/.test(size)) {
        errors.push({ field: "image-sizes", message: `尺寸只接受「宽x高」：${size}` });
      }
    }
    if (!draft.imagesPath.trim().startsWith("/")) {
      errors.push({ field: "images-path", message: "请求路径必须以 / 开头。" });
    }
  }
  return errors;
}

function splitList(value: string): string[] {
  return value
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function providerToOperation(draft: ProviderDraft, kind: ProviderKind): ProviderOperation {
  const base = {
    op: "upsert" as const,
    kind,
    ...(draft.isNew ? {} : { id: draft.id }),
    name: draft.name.trim(),
    baseUrl: draft.baseUrl.trim(),
    // 回环与否由地址决定，不再让用户回答一次。
    local: isLoopbackBaseUrl(draft.baseUrl),
    models: draft.models.map((model) => ({
      ...(model.id ? { id: model.id } : {}),
      modelId: model.modelId.trim(),
      label: model.label.trim()
    })),
    // 空串不是替换：只有输入了新密钥才带 credential，否则服务端保留现有值。
    ...(draft.apiKey.trim().length > 0
      ? { credential: { action: "replace" as const, value: draft.apiKey } }
      : {})
  };
  if (kind === "chat") {
    return {
      ...base,
      apiProtocol: draft.apiProtocol,
      responseFormat: draft.responseFormat,
      capabilities: {
        structuredOutput: true,
        stream: true,
        vision: true
      }
    };
  }
  return {
    ...base,
    imageCapabilities: { generate: draft.generate, edit: draft.edit },
    imageSizes: splitList(draft.imageSizes),
    maxSourceImages: draft.maxSourceImages,
    editMode: draft.editMode,
    imagesPath: draft.imagesPath.trim() || "/v1/images/generations",
    ...(draft.watermark !== undefined ? { watermark: draft.watermark } : {}),
    ...(draft.omitResponseFormat ? { omitResponseFormat: true } : {}),
    imageUrlHosts: splitList(draft.imageUrlHosts)
  };
}

/** 凭据状态文案：只用于信号灯的说明，不再直接显示成徽标文字。 */
function describeCredential(provider: ManagedProvider): string {
  if (provider.credentialConfigured) return "已配置密钥，尚未检测连接。";
  if (provider.credentialSource === "environment") return "密钥未就绪（环境引用缺失）。";
  return "未配置密钥。";
}

type ConnectionSignal = { state: "idle" | "testing" | "ok" | "error" | "unsupported"; detail?: string };

function providerKey(provider: ManagedProvider): string {
  return `${provider.kind}:${provider.id}`;
}

function describeConnection(provider: ManagedProvider, signal?: ConnectionSignal) {
  if (!provider.credentialConfigured) return { state: "idle", text: describeCredential(provider), label: "未配置密钥" };
  switch (signal?.state) {
    case "ok": return { state: "ok", text: "连接正常。", label: "连接正常" };
    case "error": return { state: "error", text: `连接失败：${signal.detail ?? "请检查地址与密钥。"}`, label: "连接失败" };
    case "testing": return { state: "testing", text: "正在检测连接…", label: "检测中…" };
    case "unsupported": return { state: "unsupported", text: signal.detail ?? "该端点不提供模型列表，无法自动检测连接。", label: "无法自动检测" };
    default: return { state: "idle", text: describeCredential(provider), label: "尚未检测" };
  }
}

/** 气泡延迟：悬停或聚焦 3 秒后才出现，避免指哪弹哪。 */
const HINT_DELAY_MS = 3000;

/**
 * 短标签 + 3 秒气泡说明的按钮。
 * 可访问名仍是完整说明（`aria-label` 由调用方给出），读屏信息与长标签时期一致；
 * 气泡本身 `aria-hidden`，只服务看得见的人，不重复播报。
 */
function HintedButton({
  hint,
  className = "secondary-button",
  onKeyDown,
  children,
  ...rest
}: ComponentPropsWithoutRef<"button"> & { hint: string }) {
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stop = () => {
    clearTimeout(timer.current);
    setShown(false);
  };
  const start = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setShown(true), HINT_DELAY_MS);
  };
  useEffect(() => stop, []);
  // 禁用后的按钮不再派发指针事件：右击期间变禁用时主动收起，避免气泡残留。
  useEffect(() => {
    if (rest.disabled) stop();
  }, [rest.disabled]);
  return (
    <button
      type="button"
      {...rest}
      className={`settings-hinted ${className}`}
      onPointerEnter={start}
      onPointerLeave={stop}
      onFocus={start}
      onBlur={stop}
      onKeyDown={(event) => {
        if (event.key === "Escape") stop();
        onKeyDown?.(event);
      }}
    >
      {children}
      {shown ? (
        <span className="settings-hint" role="tooltip" aria-hidden="true">
          {hint}
        </span>
      ) : null}
    </button>
  );
}

export function ModelSettingsSection({ active = true }: { active?: boolean }) {
  const [page, setPage] = useState<Page>("index");
  const [view, setView] = useState<ModelSettingsView>();
  const [readError, setReadError] = useState<{ code: string; detail: string; unreachable: boolean }>();
  const [drafts, setDrafts] = useState<ProviderDraft[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | "conflict"; text: string }>();
  const [busy, setBusy] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const [comparison, setComparison] = useState<string[]>([]);
  const draftSequence = useRef(0);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useDismissableLayer(confirmRef, active && Boolean(pendingDelete), () => setPendingDelete(null), { consumeOutside: false });
  const errorSummaryRef = useRef<HTMLDivElement | null>(null);
  const [signals, setSignals] = useState<Record<string, ConnectionSignal>>({});
  const tested = useRef<Set<string>>(new Set());

  const adopt = useCallback((next: ModelSettingsView) => {
    setView(next);
    setErrors([]);
  }, []);

  const load = useCallback(async () => {
    setBusy(true);
    const result = await readModelSettings();
    setBusy(false);
    if (result.status === "error") {
      // 读取失败不清草稿、不谎报成功；保留上一份有效快照供比较。
      setReadError({ code: result.code, detail: result.detail, unreachable: result.unreachable });
      return result;
    }
    setReadError(undefined);
    // 手动刷新状态时重新探测连接，红点不会一直卡在上一次结果。
    tested.current.clear();
    adopt(result.view);
    return result;
  }, [adopt]);

  // 首页和子页共用一份管理视图，切换页面不重复读取或丢失连接结果。
  const entered = useRef(false);
  useEffect(() => {
    if (!active || entered.current) return;
    entered.current = true;
    void load();
  }, [active, load]);

  /*
   * 连接信号灯：复用“拉取模型”出口做一次只读探测（GET /models），不写配置。
   * 无法确认的目录不标为已连通，也不等同于请求失败；检测不执行聊天或制图。
   */
  const testConnection = useCallback(async (provider: ManagedProvider) => {
    const key = providerKey(provider);
    tested.current.add(key);
    setSignals((current) => ({ ...current, [key]: { state: "testing" } }));
    const result = await discoverModelSettings({
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      ...(provider.kind === "chat" && provider.apiProtocol ? { apiProtocol: provider.apiProtocol } : {}),
      ...(provider.kind === "image" && provider.imagesPath ? { imagesPath: provider.imagesPath } : {}),
      providerId: provider.id
    });
    const unsupported = !result.ok && (result.code === "AI_DISCOVERY_UNSUPPORTED" || result.code === "AI_DISCOVERY_UNVERIFIED");
    setSignals((current) => ({
      ...current,
      [key]: result.ok
        ? { state: "ok" }
        : unsupported
          ? { state: "unsupported", ...(result.code === "AI_DISCOVERY_UNVERIFIED" ? { detail: result.detail } : {}) }
          : { state: "error", detail: result.detail }
    }));
  }, []);


  /* 校验失败后把焦点移到错误摘要（技能要求的可聚焦摘要）。 */
  useEffect(() => {
    if (errors.length > 0) errorSummaryRef.current?.focus();
  }, [errors]);

  const kind: ProviderKind = page === "image" ? "image" : "chat";
  const providers = view ? (kind === "chat" ? view.chat : view.image) : [];

  useEffect(() => {
    if (!view) return;
    for (const provider of page === "index" ? [...view.chat, ...view.image] : kind === "chat" ? view.chat : view.image) {
      if (!provider.credentialConfigured) continue;
      if (tested.current.has(providerKey(provider))) continue;
      void testConnection(provider);
    }
  }, [view, page, kind, testConnection]);
  const pageDrafts = drafts.filter(d => d.kind === kind);
  const dirty = pageDrafts.length > 0;
  const writable = view?.writable === true && !readError;

  const changePage = (next: Page) => {
    if (busy && view) return;
    setPendingDelete(null);
    setDrafts(current => current.map(d => ({ ...d, apiKey: "" })));
    setEditing(null); setErrors([]); setNotice(undefined);
    setPage(next);
  };
  const updateDraft = (id: string, patch: Partial<ProviderDraft>) => {
    setDrafts(current => current.map(d => d.id === id && d.kind === kind ? { ...d, ...patch } : d));
  };

  const startEdit = (provider: ManagedProvider) => {
    if (busy) return;
    setDrafts(current => current.some(d => d.id === provider.id && d.kind === provider.kind)
      ? current : [...current, draftFrom(provider)]);
    setEditing(provider.id);
    setErrors([]);
    setNotice(undefined);
  };

  const closeEdit = () => {
    setDrafts(current => current.map(d => d.id === editing ? { ...d, apiKey: "" } : d));
    setEditing(null);
    setErrors([]);
  };

  /** 选了厂家：直接生成一条已预填的草稿，用户只需要补密钥。 */
  const addPreset = (preset: ChatPreset | ImagePreset) => {
    if (busy || !writable) return;
    const draft = draftFromPreset(preset, kind, `draft-${++draftSequence.current}`);
    setDrafts((current) => [...current, draft]);
    setEditing(draft.id);
    setErrors([]);
    setNotice(undefined);
  };

  const addProvider = () => {
    const draft = { ...emptyDraft(kind), id: `draft-${++draftSequence.current}` };
    setDrafts((current) => [...current, draft]);
    setEditing(draft.id);
    setErrors([]);
  };

  const save = async () => {
    if (!view || busy || !writable || conflicted || !pageDrafts.length) return;
    const collected: FieldError[] = [];
    pageDrafts.forEach(draft => collected.push(...validateDraft(draft, draft.kind).map(error => ({ ...error, field: `${draft.id}-${error.field}` }))));
    if (collected.length > 0) {
      // 只设置错误；聚焦交给 effect（摘要此时还没渲染出来）。
      setDrafts(current => current.map(d => d.kind === kind ? { ...d, advancedOpen: true } : d));
      const firstInvalid = pageDrafts.find(d => collected.some(e => e.field.startsWith(`${d.id}-`)));
      setEditing(firstInvalid?.id ?? null);
      setErrors(collected);
      setNotice({ tone: "error", text: "有字段需要修正，未提交保存。" });
      return;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      const request: ModelSettingsRequest = {
        baseRevision: view.revision,
        operations: pageDrafts.map((draft) => providerToOperation(draft, draft.kind))
      };
      const result = await saveModelSettings(request);
      if (!result.ok) {
        if (result.conflict) setConflicted(true);
        setErrors([]);
        setNotice({
          tone: result.conflict ? "conflict" : "error",
          text: result.conflict
            ? "配置已被其他会话修改，本次未保存。你的输入仍在：请先刷新服务端状态比较差异，再决定重新提交或重载。"
            : result.unverified
              ? `保存结果未确认：${result.detail}`
              : `保存失败：${result.detail}`
        });
        return;
      }
      // 保存后重新探测本页提供方：新 ID、地址或密钥都可能已变化。
      for (const key of [...tested.current]) {
        if (key.startsWith(`${kind}:`)) tested.current.delete(key);
      }
      adopt(result.view);
      setDrafts(current => current.filter(d => d.kind !== kind));
      setEditing(null);
      setConflicted(false); setComparison([]);
      setNotice({
        tone: "ok",
        text: "配置已保存，正在检测连接。"
      });
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async (draft: ManagedProvider) => {
    if (!view || busy || !writable || conflicted) return;
    setBusy(true);
    try {
      const result = await saveModelSettings({
        baseRevision: view.revision,
        operations: [{ op: "delete", kind: draft.kind, id: draft.id }]
      });
      if (!result.ok) {
        setNotice({
          tone: result.conflict ? "conflict" : "error",
          text: result.conflict
            ? "配置已被其他会话修改，删除未执行。请先刷新服务端状态。"
            : `删除失败：${result.detail}`
        });
        return;
      }
      adopt(result.view);
      setDrafts(current => current.filter(d => !(d.id === draft.id && d.kind === draft.kind)));
      setNotice({ tone: "ok", text: `已删除「${draft.name}」及其在本页的模型。` });
    } finally {
      setPendingDelete(null);
      setBusy(false);
    }
  };

  const entrySummary = (entryKind: ProviderKind) => {
    if (!view) return <span>{readError ? "配置读取失败" : "正在读取配置…"}</span>;
    if (view[entryKind].length === 0) return <span>尚未配置</span>;
    return view[entryKind].map(provider => {
      const connection = describeConnection(provider, signals[providerKey(provider)]);
      return (
        <span className="settings-model-entry-provider" key={provider.id}>
          <span className="settings-model-entry-models" title={provider.models.map(model => model.modelId).join("、") || provider.name}
            onPointerEnter={event => { if (event.pointerType === "mouse") event.currentTarget.scrollLeft = 0; prepareModelNameScroll(event.currentTarget); }}>
            <span>{provider.models.map(model => model.modelId).join("、") || provider.name}</span>
          </span>
          <span className="settings-model-entry-connection" title={connection.text}>
            <span className="settings-provider-signal" data-state={connection.state} aria-hidden="true" />
            <span>{connection.label}</span>
          </span>
        </span>
      );
    });
  };

  const index = (
    <div className="settings-model-entries">
      <button
        type="button"
        className="settings-model-entry"
        onFocus={event => event.currentTarget.querySelectorAll<HTMLElement>(".settings-model-entry-models").forEach(prepareModelNameScroll)}
        onClick={() => {
          changePage("chat");
        }}
      >
        <MessageSquare size={18} aria-hidden />
        <span className="settings-model-entry-body">
          <strong>对话模型</strong>
          {entrySummary("chat")}
        </span>
        <span className="settings-model-entry-meta">
          <ChevronRight size={16} aria-hidden />
        </span>
      </button>
      <button
        type="button"
        className="settings-model-entry"
        onFocus={event => event.currentTarget.querySelectorAll<HTMLElement>(".settings-model-entry-models").forEach(prepareModelNameScroll)}
        onClick={() => {
          changePage("image");
        }}
      >
        <ImageIcon size={18} aria-hidden />
        <span className="settings-model-entry-body">
          <strong>制图模型</strong>
          {entrySummary("image")}
        </span>
        <span className="settings-model-entry-meta">
          <ChevronRight size={16} aria-hidden />
        </span>
      </button>
    </div>
  );

  const editor = (
    <div className="settings-provider-list">
      {errors.length > 0 ? (
        <div
          className="settings-error-summary"
          role="alert"
          tabIndex={-1}
          ref={errorSummaryRef}
          aria-labelledby="settings-error-title"
        >
          <h4 id="settings-error-title">有 {errors.length} 处需要修正</h4>
          <ul>
            {errors.map((error, index) => (
              <li key={`${error.field}-${index}`}>
                <a href={`#settings-field-${error.field}`}>{error.message}</a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {providers.map((provider) => {
        const connection = describeConnection(provider, signals[providerKey(provider)]);
        const open = editing === provider.id;
        const confirmingDelete = pendingDelete === providerKey(provider);
        return (
          <article className="settings-provider-card" key={provider.id}>
            <header className="settings-provider-head">
              <div className="settings-provider-title">
                <strong>{provider.name}</strong>
                <span
                  className="settings-provider-signal"
                  data-state={connection.state}
                  title={connection.text}
                  aria-hidden="true"
                />
                <span className="sr-only">{connection.text}</span>
                <span className="settings-provider-count">{provider.models.length} 个模型</span>
              </div>
              <div className="settings-provider-actions">
                <button
                  type="button"
                  className="secondary-button"
                  aria-expanded={open}
                  disabled={busy}
                  onClick={() => (open ? closeEdit() : startEdit(provider))}
                >
                  {open ? "收起" : "编辑"}
                </button>
                <button
                  ref={confirmingDelete ? confirmRef : undefined}
                  type="button"
                  className="secondary-button settings-provider-delete"
                  data-confirming={confirmingDelete}
                  aria-label={confirmingDelete ? "确认删除" : "删除提供方"}
                  title={confirmingDelete ? `再次点击删除「${provider.name}」及其 ${provider.models.length} 个模型；按 Esc 取消。` : `删除提供方「${provider.name}」`}
                  disabled={!writable || busy || conflicted}
                  onBlur={() => { if (!busy) setPendingDelete(null); }}
                  onClick={() => confirmingDelete ? void confirmDelete(provider) : setPendingDelete(providerKey(provider))}
                >
                  <Trash2 size={13} aria-hidden /> {confirmingDelete ? busy ? "删除中…" : "确认删除" : "删除"}
                </button>
                {confirmingDelete ? <span className="sr-only" role="status">再次点击将删除「{provider.name}」及其 {provider.models.length} 个模型；按 Esc 取消。</span> : null}
              </div>
            </header>
            {open ? (
              <ProviderForm
                kind={kind}
                draft={draftFrom(provider)}
                disabled={busy || !writable}
                onChange={(patch) =>
                  setDrafts((current) =>
                    current.map((draft) => (draft.id === provider.id ? { ...draft, ...patch } : draft))
                  )
                }
                draftValue={drafts.find((draft) => draft.id === provider.id) ?? draftFrom(provider)}
                fieldPrefix={`${provider.id}-`}
                errors={errors}
              />
            ) : (
              <p className="settings-block-note">
                {provider.models.map((model) => model.label || model.modelId).join("、")}
              </p>
            )}
          </article>
        );
      })}

      {pageDrafts.filter(d => d.isNew).map((draft) => (
        <article className="settings-provider-card" key={draft.id}>
          <header className="settings-provider-head">
            <div className="settings-provider-title">
              <strong>{draft.name.trim() || "新提供方"}</strong>
              <span className="settings-provider-state" data-tone="muted">
                尚未保存
              </span>
            </div>
          </header>
          <ProviderForm
            kind={kind}
            draft={draft}
            disabled={busy || !writable}
            draftValue={draft}
            fieldPrefix={`${draft.id}-`}
            errors={errors}
            onChange={(patch) => updateDraft(draft.id, patch)}
            onRemove={() => {
              setDrafts((current) => current.filter(d => d.id !== draft.id));
              setEditing(null);
            }}
          />
        </article>
      ))}

      {/*
        * 厂家入口是一行下拉：**选完就进入这张卡的配置**，此时不再显示厂家列表，
        * 收起/移除草稿后它自己回来（不需要额外的"返回"按钮）。
        */}
      {writable && !editing ? (
        <section className="settings-presets" aria-labelledby={`settings-presets-${kind}`}>
          <h4 id={`settings-presets-${kind}`} className="ui-secondary-heading">
            {kind === "chat" ? "按厂家添加对话模型" : "按厂家添加制图模型"}
          </h4>
          <label className="settings-field" htmlFor={`settings-preset-${kind}`} title={kind === "chat" ? "按厂家添加对话模型" : "按厂家添加制图模型"}>
            <span>选择厂家</span>
            <select
              id={`settings-preset-${kind}`}
              value=""
              disabled={busy}
              onChange={(event) => {
                const choice = event.target.value;
                if (!choice) return;
                if (choice === "custom") {
                  addProvider();
                  return;
                }
                const preset = (kind === "chat" ? CHAT_PRESETS : IMAGE_PRESETS).find((item) => item.id === choice);
                if (preset) addPreset(preset);
              }}
            >
              <option value="">选择厂家…</option>
              {(kind === "chat" ? CHAT_PRESETS : IMAGE_PRESETS).map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.vendor}
                </option>
              ))}
              <option value="custom">自定义（自己填地址、协议与模型 ID）</option>
            </select>
          </label>
        </section>
      ) : null}

      <div className="settings-editor-actions">
        <div className="settings-editor-sync">
          <HintedButton
            disabled={busy}
            aria-label="刷新服务端状态"
            hint="重新读取服务端配置并与当前输入比较；你的输入不会被改动。"
            onClick={() => {
              void (async () => {
                const previous = view;
                const result = await load();
                if (result.status === "ok") {
                  const before = previous?.[kind] ?? [];
                  const after = result.view[kind];
                  const changes = after.filter(p => JSON.stringify(p) !== JSON.stringify(before.find(old => old.id === p.id)))
                    .map(p => `${p.name}：服务端地址 ${p.baseUrl}；模型 ${p.models.map(m => m.label ? `${m.label} (${m.modelId})` : m.modelId).join("、")}；能力 ${JSON.stringify(p.capabilities ?? p.imageCapabilities)}。本地输入保留在表单中。`);
                  for (const old of before) if (!after.some(p => p.id === old.id)) changes.push(`${old.name}：服务端已删除。`);
                  setComparison(changes.length ? changes : ["可见声明未变化；密钥不回显，不能在此比较密钥值。"]);
                  setConflicted(false);
                  setNotice({ tone: "ok", text: "已刷新服务端状态，输入已保留。确认差异后可保存，或明确重载服务端配置。" });
                }

              })();
            }}
          >
            刷新状态
          </HintedButton>
          <HintedButton
            data-tone="danger"
            disabled={busy || !view}
            aria-label="重载服务端配置（丢弃本页输入）"
            hint="丢弃本页未保存的输入，重新从服务端读取配置。"
            onClick={() => { setDrafts(current => current.filter(d => d.kind !== kind)); setEditing(null); setErrors([]); setComparison([]); setNotice(undefined); }}
          >
            重载配置
          </HintedButton>
        </div>
        <div className="settings-editor-primary">
          <button
            type="button"
            className="primary-button"
            disabled={busy || !writable || !dirty || conflicted}
            onClick={() => void save()}
          >
            {busy ? "正在保存…" : "保存"}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => {
              // 取消：丢弃草稿并清除内存里的密钥输入。
              setDrafts(current => current.filter(d => d.kind !== kind));
              setEditing(null);
              setErrors([]);
              setNotice(undefined);
            }}
          >
            取消
          </button>
        </div>
      </div>

      {comparison.length > 0 ? <ul className="settings-block-note" aria-label="服务端差异">{comparison.map(item => <li key={item}>{item}</li>)}</ul> : null}
      {notice ? (
        <p
          className={notice.tone === "ok" ? "settings-block-note" : "notebook-error"}
          /*
           * 校验失败的提示与错误摘要同属一次失败：摘要已承担 role="alert"，
           * 这里用 status 避免两个 alert；保存失败/冲突没有摘要，用 alert 让屏幕阅读器播报。
           */
          role={notice.tone === "ok" || errors.length > 0 ? "status" : "alert"}
        >
          {notice.text}
        </p>
      ) : null}
    </div>
  );

  return (
    <section className="settings-block" aria-labelledby="model-settings-heading">
      <h2 id="model-settings-heading" className={page === "index" ? undefined : "ui-secondary-heading"}>
        <MessageSquare size={16} /> 模型配置
      </h2>

      {page === "index" ? (
        <>
          {readError ? (
            <p className="notebook-error" role="alert">
              读取模型配置失败：{readError.detail}
              {readError.unreachable ? "（本次请求未成功，可重试。）" : "（请检查服务端本机配置存储。）"}
              <button type="button" className="secondary-button" disabled={busy} onClick={() => void load()}>重试</button>
            </p>
          ) : null}
          {index}
        </>
      ) : (
        <>
          <div className="settings-subpage-head">
            <button type="button" className="secondary-button" aria-label="返回设置" disabled={busy} onClick={() => changePage("index")}>
              <ArrowLeft size={14} aria-hidden /> 返回
            </button>
            <div>
              <h3 title="模型配置">{page === "chat" ? "对话模型" : "制图模型"}</h3>
            </div>
          </div>

          {readError ? (
            <p className="notebook-error" role="alert">
              {readError.unreachable ? "无法连接服务端，请确认服务已启动后重试。" : `读取模型配置失败：${readError.detail}`}
            </p>
          ) : view?.writable === false ? (
            <p className="settings-block-note" role="status">当前部署不允许在此修改模型配置。</p>
          ) : null}

          {editor}
        </>
      )}
    </section>
  );
}

/** 提供方表单：新增与编辑共用同一组件，按协议保留必要差异。 */
function ProviderForm({
  kind,
  draft,
  draftValue,
  fieldPrefix,
  disabled,
  onChange,
  onRemove,
  errors
}: {
  kind: ProviderKind;
  draft: ProviderDraft;
  draftValue: ProviderDraft;
  fieldPrefix: string;
  disabled: boolean;
  onChange: (patch: Partial<ProviderDraft>) => void;
  onRemove?: () => void;
  errors: FieldError[];
}) {
  const value = draftValue ?? draft;
  const id = (field: string) => `settings-field-${fieldPrefix}${field}`;

  /*
   * 拉取可用模型：只影响**这张卡片的内存草稿**。
   * 结果不落库、不缓存，勾选后才进模型目录；拉取本身不改任何服务端配置。
   */
  const [fetched, setFetched] = useState<{ models: { modelId: string; label: string }[]; truncated: boolean }>();
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string>();
  const [discoveryQuery, setDiscoveryQuery] = useState("");

  const selectedModels = fetched ? fetched.models.filter((model) => picked[model.modelId] === true) : [];
  const visibleModels = fetched
    ? fetched.models
        .filter((model) => {
          const needle = discoveryQuery.trim().toLowerCase();
          if (!needle) return true;
          return `${model.label} ${model.modelId}`.toLowerCase().includes(needle);
        })
        .slice(0, DISCOVERY_MAX_ROWS)
    : [];

  const runDiscovery = async () => {
    setDiscovering(true);
    setDiscoveryError(undefined);
    setFetched(undefined);
    const result = await discoverModelSettings({
      kind,
      baseUrl: value.baseUrl.trim(),
      ...(kind === "chat" ? { apiProtocol: value.apiProtocol } : { imagesPath: value.imagesPath.trim() }),
      ...(value.isNew ? {} : { providerId: value.id }),
      ...(value.apiKey.trim().length > 0 ? { apiKey: value.apiKey.trim() } : {})
    });
    setDiscovering(false);
    if (!result.ok) {
      setDiscoveryError(result.detail);
      return;
    }
    setFetched({ models: result.models, truncated: result.truncated });
    // 已在模型目录里的先勾上：这里是"以勾选为准"，不是"追加"。
    const existing = new Set(value.models.map((model) => model.modelId.trim()).filter(Boolean));
    setPicked(Object.fromEntries(result.models.map((model) => [model.modelId, existing.has(model.modelId)])));
    setDiscoveryQuery("");
  };

  const applyDiscovery = () => {
    // 已有行保留原 ID 与显示名，只补新勾的，避免把服务端模型身份改掉。
    const existing = new Map(
      value.models.filter((model) => model.modelId.trim().length > 0).map((model) => [model.modelId.trim(), model])
    );
    onChange({
      models: selectedModels.map(
        (model) => existing.get(model.modelId) ?? { id: "", modelId: model.modelId, label: model.label }
      )
    });
    setFetched(undefined);
    setPicked({});
    setDiscoveryError(undefined);
  };
  const errorFor = (field: string) => errors.find(e => e.field === `${fieldPrefix}${field}`);
  const errorProps = (field: string) => ({
    "aria-invalid": !!errorFor(field),
    "aria-describedby": errorFor(field) ? `${id(field)}-error` : undefined
  });
  const errorText = (field: string) => errorFor(field)
    ? <small id={`${id(field)}-error`} className="notebook-error">{errorFor(field)!.message}</small> : null;
  return (
    <div className="settings-provider-form">
      {value.preset?.docsUrl ? (
        <p className="settings-block-note">
          <a href={value.preset.docsUrl} target="_blank" rel="noreferrer">官方文档</a>
        </p>
      ) : null}
      <label className="settings-field" htmlFor={id("name")}>
        <span>提供方名称</span>
        <input
          id={id("name")}
                {...errorProps("name")}
          value={value.name}
          disabled={disabled}
          aria-label="提供方名称"
          onChange={(event) => onChange({ name: event.target.value })}
        />
              {errorText("name")}
      </label>

      {kind === "chat" ? (
        <label className="settings-field" htmlFor={id("api-protocol")}>
          <span>API 协议</span>
          <select id={id("api-protocol")} value={value.apiProtocol} disabled={disabled}
            onChange={(event) => onChange({ apiProtocol: event.target.value as ChatApiProtocol })}>
            {CHAT_API_PROTOCOLS.map(protocol => <option key={protocol} value={protocol}>{protocol}</option>)}
          </select>
        </label>
      ) : null}

      <label className="settings-field" htmlFor={id("api-key")}>
        <span>API 密钥</span>
        <input
          id={id("api-key")}
          type="password"
          autoComplete="off"
          value={value.apiKey}
          disabled={disabled}
          aria-label="API 密钥"
          placeholder={
            value.isNew ? (value.preset?.keyHint ?? "粘贴 API 密钥") : "已配置，输入新值可替换"
          }
          onChange={(event) => onChange({ apiKey: event.target.value })}
        />
      </label>

      <div className="settings-advanced">
        <HintedButton
          aria-expanded={value.advancedOpen}
          hint="API 地址与输出设置。"
          onClick={() => onChange({ advancedOpen: !value.advancedOpen })}
        >
          <ChevronDown size={14} aria-hidden className={value.advancedOpen ? "is-open" : ""} />
          自定义设置
        </HintedButton>
        {value.advancedOpen ? (
          <div className="settings-advanced-body">
            <label className="settings-field" htmlFor={id("base-url")}>
              <span>API 地址</span>
              <input
                id={id("base-url")}
                {...errorProps("base-url")}
                value={value.baseUrl}
                disabled={disabled}
                aria-label="API 地址"
                placeholder="https://api.example.com/v1"
                onChange={(event) => onChange({ baseUrl: event.target.value })}
              />
              {errorText("base-url")}
                  </label>
            {kind === "chat" ? (
              <>
                <label className="settings-field" htmlFor={id("response-format")}>
                  <span>结构化输出方式</span>
                  <select
                    id={id("response-format")}
                    value={value.responseFormat}
                    disabled={disabled}
                    onChange={(event) =>
                      onChange({ responseFormat: event.target.value as ProviderDraft["responseFormat"] })
                    }
                  >
                    <option value="json_schema">json_schema（较严格）</option>
                    <option value="json_object">json_object（兼容性更好）</option>
                  </select>
                          </label>

              </>
            ) : (
              <>
                <fieldset className="settings-field-group" disabled={disabled}>
                  <legend>该提供方的能力（由你声明）</legend>
                  <span className="settings-field-inline">
                    <input
                      id={id("generate")}
                      type="checkbox"
                      checked={value.generate}
                      onChange={(event) => onChange({ generate: event.target.checked })}
                    />
                    <label htmlFor={id("generate")}>支持生成图片</label>
                  </span>
                  <span className="settings-field-inline">
                    <input
                      id={id("edit-image")}
                      type="checkbox"
                      checked={value.edit}
                      onChange={(event) => onChange({ edit: event.target.checked })}
                    />
                    <label htmlFor={id("edit-image")}>支持编辑图片</label>
                  </span>
                </fieldset>
                <label className="settings-field" htmlFor={id("image-sizes")}>
                  <span>允许的尺寸（可选）</span>
                  <input
                    id={id("image-sizes")}
                {...errorProps("image-sizes")}
                    value={value.imageSizes}
                    disabled={disabled}
                    aria-label="允许的尺寸"
                    placeholder="1024x1024, 1536x1024"
                    onChange={(event) => onChange({ imageSizes: event.target.value })}
                  />
              {errorText("image-sizes")}
                          </label>
                <label className="settings-field" htmlFor={id("max-source-images")}>
                  {/* 应用级上限就是 MAX_SOURCE_IMAGES（9）：填更大也没有意义，所以这里直接封顶。 */}
                  <span>最多输入图（1–{MAX_SOURCE_IMAGES}）</span>
                  <input
                    id={id("max-source-images")}
                    type="number"
                    min={1}
                    max={MAX_SOURCE_IMAGES}
                    value={value.maxSourceImages}
                    disabled={disabled}
                    aria-label="最多输入图张数"
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      onChange({ maxSourceImages: Number.isInteger(next)
                        ? Math.min(MAX_SOURCE_IMAGES, Math.max(1, next))
                        : 1 });
                    }}
                  />
                </label>
                <label className="settings-field" htmlFor={id("edit-mode")}>
                  <span>编辑协议</span>
                  <select
                    id={id("edit-mode")}
                    value={value.editMode}
                    disabled={disabled}
                    onChange={(event) =>
                      onChange({ editMode: event.target.value as ProviderDraft["editMode"] })
                    }
                  >
                    <option value="edits-multipart">edits-multipart（OpenAI 风格）</option>
                    <option value="generations-image">generations-image（顶层 image 字段）</option>
                  </select>
                          </label>
                <label className="settings-field" htmlFor={id("images-path")}>
                  <span>请求路径</span>
                  <input
                    id={id("images-path")}
                {...errorProps("images-path")}
                    value={value.imagesPath}
                    disabled={disabled}
                    aria-label="请求路径"
                    onChange={(event) => onChange({ imagesPath: event.target.value })}
                  />
              {errorText("images-path")}
                          </label>
                <label className="settings-field" htmlFor={id("omit-response-format")}>
                  <span>返回格式</span>
                  <select
                    id={id("omit-response-format")}
                    value={value.omitResponseFormat ? "omit" : "b64_json"}
                    disabled={disabled}
                    onChange={(event) => onChange({ omitResponseFormat: event.target.value === "omit" })}
                  >
                    <option value="b64_json">要求内联 base64（下发 response_format）</option>
                    <option value="omit">不下发该字段（OpenAI gpt-image 系列）</option>
                  </select>
                </label>
                <label className="settings-field" htmlFor={id("watermark")}>
                  <span>供应商水印</span>
                  <select id={id("watermark")} disabled={disabled}
                    value={value.watermark === undefined ? "default" : value.watermark ? "on" : "off"}
                    onChange={event => onChange({ watermark: event.target.value === "default" ? undefined : event.target.value === "on" })}>
                    <option value="default">保持供应商默认</option><option value="off">明确关闭</option><option value="on">明确开启</option>
                  </select>
                </label>
                <label className="settings-field" htmlFor={id("image-hosts")}>
                  <span>额外图片下载主机（可选）</span>
                  <input
                    id={id("image-hosts")}
                    value={value.imageUrlHosts}
                    disabled={disabled}
                    aria-label="额外图片下载主机"
                    placeholder="*.example.com"
                    onChange={(event) => onChange({ imageUrlHosts: event.target.value })}
                  />
                          </label>
              </>
            )}
          </div>
        ) : null}
      </div>

      <fieldset className="settings-field-group" disabled={disabled}>
        <legend id={id("models")} tabIndex={-1}>模型目录（至少一条）</legend>
        {errorText("models")}
        {value.models.length === 0 ? (
          <p className="settings-block-note">还没有模型；保存前必须至少添加一条。</p>
        ) : null}
        <ul className="settings-model-list">
          {value.models.map((model, index) => (
            <li key={`${fieldPrefix}model-${index}`} className="settings-model-row">
              <label className="settings-field" htmlFor={id(`model-${index}`)}>
                <span>模型 ID（必填）</span>
                <input
                  id={id(`model-${index}`)} {...errorProps(`model-${index}`)}
                  value={model.modelId}
                  disabled={disabled}
                  aria-label={`模型 ID ${index + 1}`}
                  placeholder="模型 ID"
                  onChange={(event) =>
                    onChange({
                      models: value.models.map((item, i) =>
                        i === index ? { ...item, modelId: event.target.value } : item
                      )
                    })
                  }
                />
              {errorText(`model-${index}`)}
              </label>
              <label className="settings-field" htmlFor={id(`label-${index}`)}>
                <span>显示名称（选填）</span>
                <input
                  id={id(`label-${index}`)}
                  value={model.label}
                  disabled={disabled}
                  aria-label={`显示名称 ${index + 1}`}
                  placeholder="留空则显示模型 ID"
                  onChange={(event) =>
                    onChange({
                      models: value.models.map((item, i) =>
                        i === index ? { ...item, label: event.target.value } : item
                      )
                    })
                  }
                />
              </label>
              <button
                type="button"
                className="secondary-button"
                disabled={disabled}
                aria-label={`移除模型 ${index + 1}`}
                onClick={() =>
                  onChange({ models: value.models.filter((_, i) => i !== index) })
                }
              >
                <Trash2 size={13} aria-hidden /> 移除
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="secondary-button"
          disabled={disabled}
          onClick={() =>
            onChange({ models: [...value.models, { id: "", modelId: "", label: "" }] })
          }
        >
          <Plus size={14} aria-hidden /> 添加模型
        </button>

        <div className="settings-discovery">
          <HintedButton
            disabled={disabled || discovering || value.baseUrl.trim().length === 0}
            aria-label="拉取该端点可用的模型列表"
            hint="用下面的 API 地址与密钥向端点查询可用模型。只读取列表，不保存任何改动。"
            onClick={() => void runDiscovery()}
          >
            <Download size={14} aria-hidden /> {discovering ? "正在拉取…" : "拉取可用模型"}
          </HintedButton>
          {discoveryError ? (
            <p className="notebook-error" role="status">
              {discoveryError}
            </p>
          ) : null}
          {fetched ? (
            <div className="settings-discovery-panel" role="group" aria-label="拉取到的模型">
              <label className="settings-field" htmlFor={id("discovery-query")}>
                <span>筛选（共 {fetched.models.length} 个）</span>
                <input
                  id={id("discovery-query")}
                  value={discoveryQuery}
                  disabled={disabled}
                  aria-label="筛选拉取到的模型"
                  placeholder="输入名称或模型 ID"
                  onChange={(event) => setDiscoveryQuery(event.target.value)}
                />
              </label>
              <ul className="settings-discovery-list">
                {visibleModels.map((model) => (
                  <li key={model.modelId}>
                    <label>
                      <input
                        type="checkbox"
                        checked={picked[model.modelId] === true}
                        disabled={disabled}
                        aria-label={`选择模型 ${model.modelId}`}
                        onChange={(event) =>
                          setPicked((current) => ({ ...current, [model.modelId]: event.target.checked }))
                        }
                      />
                      <span className="settings-discovery-label">{model.label}</span>
                      <code className="settings-discovery-id">{model.modelId}</code>
                    </label>
                  </li>
                ))}
                {visibleModels.length === 0 ? <li className="settings-block-note">没有匹配的模型。</li> : null}
              </ul>
              {fetched.models.length > DISCOVERY_MAX_ROWS ? (
                <p className="settings-block-note">
                  模型较多，只列出前 {DISCOVERY_MAX_ROWS} 个；用筛选缩小范围。
                </p>
              ) : null}
              {fetched.truncated ? <p className="settings-block-note">端点返回的模型超过上限，已截断。</p> : null}
              <div className="settings-editor-actions">
                <button
                  type="button"
                  className="primary-button"
                  disabled={disabled || selectedModels.length === 0}
                  onClick={applyDiscovery}
                >
                  应用到模型目录（{selectedModels.length}）
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={disabled}
                  onClick={() => {
                    setFetched(undefined);
                    setPicked({});
                    setDiscoveryError(undefined);
                  }}
                >
                  取消
                </button>
              </div>
              <p className="settings-block-note">
                以勾选结果为准：未勾选的会从模型目录移除；已有模型保留原显示名。
              </p>
            </div>
          ) : null}
        </div>
      </fieldset>

      {onRemove ? (
        <HintedButton
          disabled={disabled}
          aria-label="移除此未保存的提供方"
          hint="不保存这条新提供方，已填内容会被丢弃。"
          onClick={onRemove}
        >
          移除
        </HintedButton>
      ) : null}
    </div>
  );
}
