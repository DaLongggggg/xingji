"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Brain, Database, Settings2, Plus, Puzzle, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import {
  listAiConfigs,
  saveAiConfigs,
  type AiConfigListResultWithFlags,
  type AiConfigOperation,
  type AiPublicConfig
} from "@/features/ai/ai-gateway-client";
import { CapabilitiesPanel } from "@/features/workbench/workbench-capabilities-panel";
import type { MemoryStore } from "@/features/workbench/workbench-memory";
import { GeneralSettings } from "./general-settings";
import type { UiTheme } from "@/features/app/ui-theme";
import { SkillSettings } from "./skill-settings";
import { ModelSettingsSection } from "./model-settings-pages";
import {
  DEFAULT_ATLAS_MAP_STYLE,
  type AtlasMapStyle
} from "@/features/atlas/map-style";

/** 档案概况：由 App 注入真实值，未就绪时缺省。 */
export type SettingsDataStatus = {
  ready: boolean;
  notebooks: number;
  pages: number;
  media: number;
  trashed: number;
  storageError?: string;
};

export type SettingsPageProps = {
  dataStatus?: SettingsDataStatus;
  memoryStore?: MemoryStore;
  nativeMode?: boolean;
  /** native 清空当前账号本机数据（dataset 轮换 + 原件清理；其他账号不受影响）。 */
  nativeClear?: { clear(): Promise<{ ok: boolean; message: string }> };
  /** native 退出登录（清本机凭证并撤销服务端会话后返回连接页）。 */
  nativeSignOut?: { signOut(): Promise<void> };
  /** T10 备份：导出当前账号（下载 ZIP）；恢复校验并写入空目标（拒绝时返回 code）。 */
  nativeBackup?: {
    export(): Promise<{ ok: boolean; fileName?: string; code?: string }>;
    restore(file: File): Promise<{ ok: boolean; code?: string; message: string }>;
  };
  /** T9：手机本地 Skill 管理（本地权威；bundled 与用户来源区分；R3 补导入/预览/安装）。 */
  nativeSkills?: {
    view(): Promise<{ ok: boolean; revision: string; skills: Array<{ id: string; label: string; summary: string; state: string; source: string; promptFiles: string[]; remark?: string }> }>;
    setState(id: string, state: string, expectedRevision: string): Promise<void>;
    setRemark(id: string, remark: string, expectedRevision: string): Promise<void>;
    removePermanently(input: { ids: string[]; confirmed: boolean; revision: string }): Promise<{ deleted: string[]; failed: Array<{ id: string; detail: string }>; revision: string }>;
    /** R3/P1-6：预览（确认前不落库）。items 携带 packageId（稳定安装目标）与原始 package。
     * url 形态：手机经认证临时下载端点获取 bytes/files 后传入（不在客户端直连外网）。 */
    preview(input: { kind: "markdown" | "paste"; text: string; filename?: string } | { kind: "zip"; bytes: Uint8Array; filename?: string } | { kind: "url"; url: string; downloaded: { bytes: Uint8Array; filename: string } | { files: Array<{ path: string; content: string }> } }): Promise<{ ok: boolean; revision: string; items: Array<{ name: string; packageId: string; description?: string; duplicate?: boolean; canUpdate?: boolean; identical?: boolean; expectedFingerprint: string | null; package: unknown }>; warnings: string[] }>;
    /** T9：受控 URL 下载（认证的临时预览端点；服务端 SSRF 防护）。
     * B5：ZIP/Skill 目录来源返回服务端解包出的真实 files（本地经 prepareSkillFiles 预览），不再要求伪造 ZIP 字节。 */
    downloadUrl(url: string): Promise<{ ok: boolean; kind: "markdown" | "zip"; filename: string; text?: string; bytes?: Uint8Array; files?: Array<{ path: string; content: string }>; error?: string }>;
    /** R3/P1-6：预览确认后的安装（targetId=packageId 稳定 ID；package 原样回传）。 */
    install(input: { revision: string; choices: Array<{ action: "create" | "copy" | "update" | "skip"; targetId: string; expectedFingerprint: string | null; package: unknown; source?: string }> }): Promise<{ ok: boolean; revision: string; skills: Array<{ id: string; label: string; state: string; source: string; promptFiles: string[]; summary: string }> }>;
  };
  /** 设备界面主题；无回调时只读展示。 */
  uiTheme?: UiTheme;
  onUiThemeChange?: (theme: UiTheme) => void;
  /** 当前地图显示风格；无回调时只读展示。 */
  mapStyle?: AtlasMapStyle;
  onMapStyleChange?: (style: AtlasMapStyle) => void;
};

function AppearanceSettings({
  mapStyle,
  onMapStyleChange
}: {
  mapStyle: AtlasMapStyle;
  onMapStyleChange?: (style: AtlasMapStyle) => void;
}) {
  const heading = "地图与背景";
  const appearanceHelp = "选择地图画法与背景材质，保留原有地区与笔记关联。";
  const terrainHelp = "真实地貌与柔和山体晕渲，搭配浅亚麻背景。";
  const paperHelp = "纸纹行政区地图，搭配暖白棉纸背景。";
  return <section className="settings-block" aria-labelledby="appearance-heading" aria-describedby="appearance-description">
    <h2 id="appearance-heading" title={appearanceHelp}>{heading}</h2>
    <p id="appearance-description" className="settings-block-note">{appearanceHelp}</p>
    <fieldset className="settings-map-style-group" disabled={!onMapStyleChange}>
      <legend className="sr-only">{heading}</legend>
      <label className="settings-map-style" data-selected={mapStyle === "terrain"} title={`地貌水彩：${terrainHelp}`}>
        <input
          type="radio"
          name="atlas-map-style"
          value="terrain"
          aria-label={`地貌水彩 ${terrainHelp}`}
          checked={mapStyle === "terrain"}
          onChange={() => onMapStyleChange?.("terrain")}
        />
        <span className="settings-map-style-swatch is-terrain" aria-hidden="true" />
        <span className="settings-map-style-copy">
          <strong>地貌水彩</strong>
          <small className="ui-secondary-copy">{terrainHelp}</small>
        </span>
      </label>
      <label className="settings-map-style" data-selected={mapStyle === "paper"} title={`纸纹行政图：${paperHelp}`}>
        <input
          type="radio"
          name="atlas-map-style"
          value="paper"
          aria-label={`纸纹行政图 ${paperHelp}`}
          checked={mapStyle === "paper"}
          onChange={() => onMapStyleChange?.("paper")}
        />
        <span className="settings-map-style-swatch is-paper" aria-hidden="true" />
        <span className="settings-map-style-copy">
          <strong>纸纹行政图</strong>
          <small className="ui-secondary-copy">{paperHelp}</small>
        </span>
      </label>
    </fieldset>
    {!onMapStyleChange ? <p className="settings-block-note">当前页面只读，地图风格仍保持上次保存的选择。</p> : null}
  </section>;
}

/**
 * 设置页：展示**真实**状态与**已有**操作。
 *
 * 硬约束：
 * - 模型配置页允许输入新密钥，已有密钥不回显，不写入浏览器持久存储；
 * - P8/P9/图片开关来自服务端环境变量，**不能**在这里做成可点的开关（那是假开关）；
 * - 只有服务端下发了版本令牌（可写部署）时才提供保存；否则明确写“当前不可修改”；
 * - 不显示内部端点（已有的除外：编辑端点需要 baseUrl，属用户自己填写的部署参数）、
 *   密钥值或原始异常；服务端下发的文案是固定的安全文案。
 * - “保存成功”只表示配置已落盘并回读成功，**不代表模型已连通**。
 */
export function SettingsPage({
  dataStatus,
  memoryStore,
  nativeMode = false,
  nativeClear,
  nativeSignOut,
  nativeSkills,
  nativeBackup,
  mapStyle = DEFAULT_ATLAS_MAP_STYLE,
  onMapStyleChange,
  uiTheme = "light",
  onUiThemeChange
}: SettingsPageProps) {
  const [section, setSection] = useState("general");
  const contentRef = useRef<HTMLDivElement>(null);
  const sections = [
    { id: "general", label: "通用", icon: Settings2 },
    { id: "memory", label: "记忆", icon: Brain },
    { id: "models", label: "模型", icon: Sparkles },
    { id: "skills", label: "Skill 管理", icon: Puzzle },
    { id: "data", label: "本地数据", icon: Database }
  ];
  return <section className="settings-page settings-layout" aria-label="设置内容">
    <nav className="settings-categories" aria-label="设置分类">
      {sections.map(({ id, label, icon: Icon }) => <button key={id} type="button" className={section === id ? "is-selected" : ""} aria-current={section === id ? "true" : undefined} aria-label={label} title={label} aria-controls={`settings-category-${id}`} onClick={() => { setSection(id); if (contentRef.current) contentRef.current.scrollTop = 0; }}><Icon size={18} aria-hidden /><span>{id === "skills" ? <>Skill<span className="settings-category-suffix"> 管理</span></> : label}</span></button>)}
    </nav>
    <div ref={contentRef} className="settings-content">
      <div id="settings-category-memory" hidden={section !== "memory"}>
        <section className="settings-block settings-memory" aria-labelledby="memory-heading">
          <h2 id="memory-heading"><Brain size={18} aria-hidden />本地记忆</h2>
          <p className="settings-block-note">只使用你允许的偏好，不会自动读取你的笔记或聊天记录。</p>
          <details className="settings-help"><summary>记忆如何使用</summary>
          <ul className="settings-memory-points">
            <li>记忆按当前账号保存。</li>
            <li>新增条目默认不发送，勾选「允许用于对话」后才会带上。</li>
            <li>关闭总开关后，既不读取也不发送。</li>
          </ul>
          </details>
          <CapabilitiesPanel embedded store={memoryStore} onClose={() => {}} />
        </section>
      </div>
      <div id="settings-category-general" hidden={section !== "general"}>
        <GeneralSettings theme={uiTheme} onThemeChange={onUiThemeChange}><AppearanceSettings mapStyle={mapStyle} onMapStyleChange={onMapStyleChange} /></GeneralSettings>
      </div>
      <div id="settings-category-models" hidden={section !== "models"}><ModelSettingsSection active={section === "models"} /></div>
      <div id="settings-category-skills" hidden={section !== "skills"}>{nativeMode ? <NativeSkillSettings store={nativeSkills} /> : <SkillSettings />}</div>
      <div id="settings-category-data" hidden={section !== "data"}><DataSection dataStatus={dataStatus} nativeClear={nativeClear} nativeSignOut={nativeSignOut} nativeBackup={nativeBackup} /></div>
    </div>
  </section>;
}

/** 配置草稿：只含可编辑字段；受保护字段（凭据引用）默认“保持现有”。 */
type ConfigDraft = {
  /** 已有配置的 id 不可改（它是版本与操作的主键）。 */
  id: string;
  isNew: boolean;
  model: string;
  baseUrl: string;
  local: boolean;
  structuredOutput: boolean;
  stream: boolean;
  vision: boolean;
  /** 显式更换或新增时填写的**环境变量名**；留空表示保持现有引用。 */
  apiKeyEnv: string;
  removed: boolean;
};

function toDraft(config: AiPublicConfig): ConfigDraft {
  return {
    id: config.id,
    isNew: false,
    model: config.label,
    // baseUrl 不在公开投影里：编辑已有配置时留空表示“保持现有端点”。
    baseUrl: "",
    local: config.local,
    structuredOutput: config.capabilities.structuredOutput,
    stream: config.capabilities.stream,
    vision: config.capabilities.vision,
    apiKeyEnv: "",
    removed: false
  };
}

function emptyDraft(): ConfigDraft {
  return {
    id: "",
    isNew: true,
    model: "",
    baseUrl: "",
    local: false,
    structuredOutput: true,
    stream: false,
    vision: false,
    apiKeyEnv: "",
    removed: false
  };
}

/** 草稿 → 服务端操作：**只提交变了的字段**，未提供的受保护字段由服务端保留。 */
function toOperation(draft: ConfigDraft, original: ConfigDraft | undefined): AiConfigOperation | null {
  if (draft.removed) return { op: "delete", id: draft.id };
  if (draft.isNew) {
    return {
      op: "upsert",
      id: draft.id.trim(),
      model: draft.model.trim(),
      baseUrl: draft.baseUrl.trim(),
      local: draft.local,
      capabilities: {
        structuredOutput: draft.structuredOutput,
        stream: draft.stream,
        vision: draft.vision
      },
      ...(draft.apiKeyEnv.trim() ? { apiKeyEnv: draft.apiKeyEnv.trim() } : {})
    };
  }
  const operation: Extract<AiConfigOperation, { op: "upsert" }> = { op: "upsert", id: draft.id };
  let changed = false;
  if (!original || draft.model !== original.model) {
    operation.model = draft.model.trim();
    changed = true;
  }
  if (draft.baseUrl.trim().length > 0) {
    operation.baseUrl = draft.baseUrl.trim();
    changed = true;
  }
  if (!original || draft.local !== original.local) {
    operation.local = draft.local;
    changed = true;
  }
  const capabilityChange: Partial<{ structuredOutput: boolean; stream: boolean; vision: boolean }> = {};
  if (!original || draft.structuredOutput !== original.structuredOutput) {
    capabilityChange.structuredOutput = draft.structuredOutput;
  }
  if (!original || draft.stream !== original.stream) capabilityChange.stream = draft.stream;
  if (!original || draft.vision !== original.vision) capabilityChange.vision = draft.vision;
  if (Object.keys(capabilityChange).length > 0) {
    operation.capabilities = capabilityChange;
    changed = true;
  }
  if (draft.apiKeyEnv.trim().length > 0) {
    operation.apiKeyEnv = draft.apiKeyEnv.trim();
    changed = true;
  }
  return changed ? operation : null;
}

/**
 * 把“草稿 vs 服务端现状”的差异说清楚：冲突后用户要能比较再决定，而不是被静默替换。
 * 覆盖公开可编辑字段（显示名、本地标记、能力）；端点与凭据引用在服务端不下发，
 * 只能说明“本地将修改、服务端值不可见”，**不谎称一致**。
 */
function compareSummary(
  drafts: ConfigDraft[],
  pending: AiConfigOperation[],
  snapshot: AiConfigListResultWithFlags | undefined
): string {
  if (!snapshot) return "尚未取得服务端状态：请先点击“刷新服务端状态”。";
  const serverConfigs =
    snapshot.status === "available" || snapshot.status === "unavailable"
      ? snapshot.configs
      : [];
  const serverById = new Map(serverConfigs.map((config) => [config.id, config]));
  const lines: string[] = [];

  const describeCapabilities = (value: { structuredOutput: boolean; stream: boolean; vision: boolean }) =>
    [
      value.structuredOutput ? "结构化" : "",
      value.stream ? "流式" : "",
      value.vision ? "看图" : ""
    ]
      .filter(Boolean)
      .join("/") || "无";

  for (const operation of pending) {
    if (operation.op === "delete") {
      lines.push(
        serverById.has(operation.id)
          ? `本地待删除：${operation.id}（服务端仍有这条）`
          : `本地待删除：${operation.id}（服务端已不存在）`
      );
      continue;
    }
    const server = serverById.get(operation.id);
    const draft = drafts.find((item) => item.id === operation.id && !item.removed);
    if (!server) {
      lines.push(`本地新增：${operation.id}（服务端没有）`);
      continue;
    }
    if (draft && draft.model !== server.label) {
      lines.push(`显示名：本地“${draft.model}”↔ 服务端“${server.label}”`);
    }
    if (draft && draft.local !== server.local) {
      lines.push(`本地端点标记：本地“${draft.local ? "是" : "否"}”↔ 服务端“${server.local ? "是" : "否"}”`);
    }
    if (draft) {
      const localCapabilities = {
        structuredOutput: draft.structuredOutput,
        stream: draft.stream,
        vision: draft.vision
      };
      if (describeCapabilities(localCapabilities) !== describeCapabilities(server.capabilities)) {
        lines.push(
          `能力：本地“${describeCapabilities(localCapabilities)}”↔ 服务端“${describeCapabilities(server.capabilities)}”`
        );
      }
    }
    // 受保护字段：服务端不下发，只能说明本地会改，不能声称与服务端一致。
    const touchesProtected =
      operation.baseUrl !== undefined || operation.apiKeyEnv !== undefined;
    if (touchesProtected) {
      lines.push(`${operation.id}：本地将修改端点/凭据引用（服务端当前值不可见，保存时按最新版本提交）`);
    }
  }

  const serverOnly = serverConfigs
    .filter((config) => !drafts.some((draft) => draft.id === config.id))
    .map((config) => `服务端新增：${config.id}（本地没有）`);

  lines.push(...serverOnly);
  if (lines.length === 0) return "本地草稿与服务端当前状态在可见字段上没有差异。";
  return `差异：${lines.join("；")}`;
}

/**
 * 读取结果是否可作为**比较/重载/允许重新提交**的依据。
 *
 * 只有三种“服务端确实给了当前配置状态”的结果算数：已确认（`verified`）、状态属于
 * available/unconfigured/unavailable、且可写部署下拿到了版本令牌。
 * `error`（含 503 read-failed / config-invalid）、`unreachable`、`disabled` 一律不算——
 * 它们既不能显示“已刷新成功”，也不能当成最新快照，更不能据此放开重新提交。
 */
function isUsableConfigRead(
  read: AiConfigListResultWithFlags
): read is Extract<AiConfigListResultWithFlags, { revision: string | null }> {
  if (read.verified !== true) return false;
  if (read.status !== "available" && read.status !== "unconfigured" && read.status !== "unavailable") {
    return false;
  }
  return typeof read.revision === "string" && read.revision.length > 0;
}

/** 能力状态：可用 / 未配置 / 配置不可用 / 服务端关闭 / 请求失败——五种都如实说。 */
export function LegacyAiCapabilitySection() {
  const [state, setState] = useState<AiConfigListResultWithFlags>();
  const [drafts, setDrafts] = useState<ConfigDraft[]>([]);
  const [originals, setOriginals] = useState<Record<string, ConfigDraft>>({});
  const [reading, setReading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | "conflict"; text: string }>();
  /**
   * 比较得到的服务端现状快照（含版本）。
   * 只保存**已确认**的读取结果：错误响应不能当成“已刷新成功”或可重载快照。
   */

  /** 409 后的差异说明：与“是否允许重新提交”分开，刷新成功后仍持续展示给用户。 */
  const [conflictSummary, setConflictSummary] = useState<string>();
  const [revisionConfirmed, setRevisionConfirmed] = useState(true);
  const inFlight = useRef(false);
  /* 最新值镜像：保存回调里生成差异说明时必须读到**当前**草稿与快照，而不是闭包里的旧值。 */
  const draftsRef = useRef<ConfigDraft[]>([]);
  const pendingRef = useRef<AiConfigOperation[]>([]);
  const serverSnapshotRef = useRef<AiConfigListResultWithFlags | undefined>(undefined);

  /**
   * 服务端状态 → 草稿。**只有首次读取、保存成功回读、以及用户明确“丢弃草稿重载”**才调用；
   * 冲突后的普通刷新绝不调用它（那会销毁用户输入）。
   */
  const adopt = useCallback((next: AiConfigListResultWithFlags) => {
    setState(next);
    serverSnapshotRef.current = next;
    setRevisionConfirmed(true);
    const configs = next.status === "available" || next.status === "unavailable" ? next.configs : [];
    const nextDrafts = configs.map(toDraft);
    setDrafts(nextDrafts);
    setOriginals(Object.fromEntries(nextDrafts.map((draft) => [draft.id, { ...draft }])));
  }, []);

  /**
   * 取服务端现状用于比较：更新状态与版本，但**不碰草稿与原基线**。
   * 失败也不清空输入，只提示失败。
   */
  const compare = useCallback(async () => {
    setReading(true);
    try {
      const next = await listAiConfigs();
      if (!isUsableConfigRead(next)) {
        /*
         * 失败/不可用的读取：保留草稿与**上一份有效快照**，不更新状态、不放开重新提交、
         * 不生成差异文案（错误响应里没有配置列表，拿它比较会把现有草稿误说成“服务端没有”）。
         * 给出去重后的原因文案，并说明下方比较仍是上一次的有效结果。
         */
        const detail = "detail" in next && typeof next.detail === "string" ? next.detail : "服务端未返回可用状态。";
        setNotice({
          tone: "error",
          text: `读取服务端状态失败：${detail} 你的输入仍在，可重试；下方比较仍是上一次成功读取的结果。`
        });
        return next;
      }
      setState(next);
      // 读过最新状态才允许用新版本重新提交；差异面板由 conflictSummary 单独驱动，不会因此消失。
      serverSnapshotRef.current = next;
      setRevisionConfirmed(true);
      return next;
    } finally {
      setReading(false);
    }
  }, []);

  /* 首次读取：不在 effect 体内同步 setState，只在 promise 完成后写入。 */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await listAiConfigs();
      if (cancelled) return;
      adopt(next);
      setReading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [adopt]);

  const revision = state?.status === "available" || state?.status === "unconfigured" || state?.status === "unavailable"
    ? state.revision
    : null;
  const writable = revision !== null && revision !== undefined;

  const pending = useMemo(
    () =>
      drafts
        .map((draft) => toOperation(draft, draft.isNew ? undefined : originals[draft.id]))
        .filter((operation): operation is AiConfigOperation => operation !== null),
    [drafts, originals]
  );

  /** 保存与读取期间冻结一切会改草稿的操作：禁止“保存中继续编辑”与“刷新/保存交错”。 */
  const frozen = saving || reading;

  /* 镜像最新值供保存回调生成差异说明；在 effect 里同步，不在渲染期间写 ref。 */
  useEffect(() => {
    draftsRef.current = drafts;
    pendingRef.current = pending;
  }, [drafts, pending]);

  const update = (index: number, patch: Partial<ConfigDraft>) => {
    if (frozen) return;
    setDrafts((current) => current.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));
  };

  const save = useCallback(async () => {
    if (!writable || frozen || pending.length === 0 || inFlight.current) return;
    if (!revisionConfirmed) {
      setNotice({
        tone: "conflict",
        text: "配置已被其他会话修改。请先“刷新服务端状态”核对差异，再决定重新提交或重载。"
      });
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setNotice(undefined);
    try {
      const result = await saveAiConfigs({ baseRevision: revision as string, operations: pending });
      if (!result.ok) {
        if (result.conflict) {
          /*
           * 冲突：保留草稿与原基线，并要求先比较；**不**自动换版本重试旧操作。
           * 差异面板此时先用手上最近的有效快照（可能是冲突前的），刷新后会被最新快照替换。
           */
          setRevisionConfirmed(false);
          setConflictSummary(compareSummary(draftsRef.current, pendingRef.current, serverSnapshotRef.current));
          setNotice({
            tone: "conflict",
            text: "配置已被其他标签页或会话修改，本次未保存。你的输入仍在：请先“刷新服务端状态”核对差异，再选择重新提交或重载。"
          });
          return;
        }
        setNotice({
          tone: "error",
          text: result.unverified
            ? `保存结果未确认：${result.detail}`
            : `保存失败：${result.detail}`
        });
        return;
      }
      /*
       * 成功 = 服务端已落盘且回读结构被确认（saveAiConfigs 已校验 state/configs/revision）。
       * 回读结果替换状态；仍然明确不宣称模型可用。
       */
      adopt(result.status);
      setConflictSummary(undefined);
      setNotice({ tone: "ok", text: "配置已保存，连接尚未验证。" });
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }, [adopt, frozen, pending, revision, revisionConfirmed, writable]);

  const textReady = state?.status === "available";
  const visionReady =
    state?.status === "available" && state.configs.some((config) => config.usable && config.capabilities.vision);
  const imageConfigs = state?.imageConfigs ?? [];
  const imageGenerate = state?.imageEnabled === true && imageConfigs.some((c) => c.capabilities.generate);
  const imageEdit = state?.imageEnabled === true && imageConfigs.some((c) => c.capabilities.edit);

  return (
    <section className="settings-block" aria-labelledby="capability-heading">
      <h2 id="capability-heading">
        <Sparkles size={16} /> AI 能力
      </h2>
      <p className="settings-block-note">{describeServerState(reading, state)}</p>

      <ul className="settings-capabilities">
        <CapabilityRow label="文字整理" ready={textReady} note={textReady ? describeConfigs(state) : undefined} />
        <CapabilityRow
          label="看图"
          ready={visionReady}
          note={visionReady ? "可用于整理记录与工作台看图。" : undefined}
        />
        <CapabilityRow
          label="生成图片"
          ready={imageGenerate}
          note={imageGenerate ? describeImageConfigs(imageConfigs, "generate") : undefined}
        />
        <CapabilityRow
          label="修改图片"
          ready={imageEdit}
          note={imageEdit ? describeImageConfigs(imageConfigs, "edit") : "未配置支持改图的图片端点。"}
        />
      </ul>

      <dl className="settings-model">
        <div>
          <dt>整理检索结果</dt>
          <dd>{state?.p8Enabled === true ? "已开启" : "未开启"}</dd>
        </div>
        <div>
          <dt>密钥</dt>
          <dd>通过模型配置页输入新值；已有值不回显，由服务端保管。</dd>
        </div>
      </dl>

      <ConfigEditor
        drafts={drafts}
        writable={writable}
        saving={saving}
        pendingCount={pending.length}
        notice={notice}
        frozen={frozen}
        revisionConfirmed={revisionConfirmed}
        conflict={conflictSummary}
        reading={reading}
        state={state}
        onUpdate={update}
        onAdd={() => {
          if (frozen) return;
          setDrafts((current) => [...current, emptyDraft()]);
        }}
        onCompare={async () => {
          if (frozen) return;
          setNotice(undefined);
          const next = await compare();
          // compare() 已按同一判据决定成败：只有可用读取才更新快照与提示，这里不再单独判错误码。
          if (!isUsableConfigRead(next)) return;
          setConflictSummary(compareSummary(draftsRef.current, pendingRef.current, next));
          setNotice({
            tone: "ok",
            text: "已刷新服务端状态用于比较（差异见上）。你的输入未被改动：可再次保存重新提交，或“重载服务端配置”丢弃草稿。"
          });
        }}
        onReload={() => {
          const snapshot = serverSnapshotRef.current;
          if (!snapshot) {
            setNotice({ tone: "error", text: "还没有可用的服务端状态，请先刷新服务端状态。" });
            return;
          }
          adopt(snapshot);
          setConflictSummary(undefined);
          setNotice({ tone: "ok", text: "已丢弃本次修改并按服务端现状重载。" });
        }}
        onSave={save}
      />


    </section>
  );
}

/** 文本模型配置编辑区：仅当服务端下发版本令牌（可写部署）时才提供保存。 */
function ConfigEditor({
  drafts,
  writable,
  saving,
  pendingCount,
  notice,
  frozen,
  revisionConfirmed,
  conflict,
  reading,
  state,
  onUpdate,
  onAdd,
  onCompare,
  onReload,
  onSave
}: {
  drafts: ConfigDraft[];
  writable: boolean;
  saving: boolean;
  pendingCount: number;
  notice?: { tone: "ok" | "error" | "conflict"; text: string };
  /** 保存/读取期间冻结会改草稿的控件，避免旧的保存响应覆盖新输入。 */
  frozen: boolean;
  /** 冲突后是否已经用服务端最新版本核对过：false 时不允许再次提交（避免换版本自动重放）。 */
  revisionConfirmed: boolean;
  /** 有待确认的冲突时给出差异说明，供用户选择重新提交或重载。 */
  conflict?: string;
  reading: boolean;
  state?: AiConfigListResultWithFlags;
  onUpdate: (index: number, patch: Partial<ConfigDraft>) => void;
  onAdd: () => void;
  onCompare: () => Promise<void>;
  onReload: () => void;
  onSave: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  /** 冻结 = 保存中或读取中：此时任何改草稿的控件都不可用。 */
  const locked = frozen || !writable;

  return (
    <div className="settings-editor">
      <h3 className="settings-editor-heading">文本模型配置</h3>
      <p className="settings-block-note">
        这里只改服务端配置的非敏感字段。凭据只以环境变量名引用，本页不收集、不显示密钥值；
        已有配置的凭据引用默认保持现有，只有你明确选择更换时才提交新的变量名。
      </p>

      {!writable && !reading ? (
        <p className="settings-block-note" role="status">
          当前无法修改配置，请联系管理员。
        </p>
      ) : null}

      {frozen ? (
        <p className="settings-block-note" role="status">
          {saving ? "正在保存，暂不能修改草稿或刷新；保存完成后可继续。" : "正在读取服务端状态，暂不能修改草稿。"}
        </p>
      ) : null}

      {conflict ? (
        <div className="settings-conflict" role="status">
          <p className="settings-conflict-text">{conflict}</p>
          {pendingCount > 0 ? (
            <p className="settings-conflict-text">
              可以按下方“保存配置”用当前版本重新提交你的草稿，或“重载服务端配置”丢弃草稿。
            </p>
          ) : null}
        </div>
      ) : null}

      <ul className="settings-config-list">
        {drafts.length === 0 ? (
          <li className="settings-config-row" data-empty="true">
            还没有任何文本模型配置。
          </li>
        ) : null}
        {drafts.map((draft, index) => {
          const key = draft.isNew ? `new-${index}` : draft.id;
          const open = expanded === key;
          const unusable =
            !draft.isNew && state?.status === "unavailable"
              ? state.configs.find((config) => config.id === draft.id)
              : undefined;
          return (
            <li className="settings-config-row" key={key} data-removed={draft.removed ? "true" : "false"}>
              <div className="settings-config-summary">
                <span className="settings-config-title">
                  {draft.isNew ? "新配置" : draft.id}
                  {draft.model ? ` · ${draft.model}` : ""}
                </span>
                {unusable?.usable === false ? (
                  <span className="settings-config-flag">
                    {unusable.unusableReason === "AI_KEY_MISSING" ? "凭据未设置" : "配置不可用"}
                  </span>
                ) : null}
                {draft.removed ? <span className="settings-config-flag">待删除</span> : null}
                <button
                  type="button"
                  className="secondary-button"
                  aria-expanded={open}
                  onClick={() => setExpanded(open ? null : key)}
                >
                  {open ? "收起" : "编辑"}
                </button>
                {draft.removed ? (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={locked}
                    onClick={() => onUpdate(index, { removed: false })}
                  >
                    撤销删除
                  </button>
                ) : (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={locked}
                    onClick={() => onUpdate(index, { removed: true })}
                  >
                    <Trash2 size={13} aria-hidden /> 删除
                  </button>
                )}
              </div>

              {open ? (
                <div className="settings-config-fields">
                  <label className="settings-field">
                    <span>配置 ID</span>
                    <input
                      value={draft.id}
                      disabled={locked || !draft.isNew}
                      aria-label="配置 ID"
                      onChange={(event) => onUpdate(index, { id: event.target.value })}
                    />
                    <small>用于调用时选择配置；已有配置的 ID 不可修改。</small>
                  </label>
                  <label className="settings-field">
                    <span>显示名 / 模型标识</span>
                    <input
                      value={draft.model}
                      disabled={locked}
                      aria-label="显示名 / 模型标识"
                      onChange={(event) => onUpdate(index, { model: event.target.value })}
                    />
                    <small>例如 deepseek-flash；仅用于展示与上游 model 字段。</small>
                  </label>
                  <label className="settings-field">
                    <span>端点 baseUrl</span>
                    <input
                      value={draft.baseUrl}
                      disabled={locked}
                      aria-label="端点 baseUrl"
                      placeholder={draft.isNew ? "https://…/v1" : "留空 = 保持现有端点"}
                      onChange={(event) => onUpdate(index, { baseUrl: event.target.value })}
                    />
                    <small>远程端点必须 https；本机端点填 http://127.0.0.1:… 并勾选“本地端点”。</small>
                  </label>
                  <label className="settings-field settings-field-inline">
                    <input
                      type="checkbox"
                      checked={draft.local}
                      disabled={locked}
                      onChange={(event) => onUpdate(index, { local: event.target.checked })}
                    />
                    <span>本地端点（回环地址）</span>
                  </label>
                  <fieldset className="settings-field-group" disabled={locked}>
                    <legend>能力声明</legend>
                    <label className="settings-field settings-field-inline">
                      <input
                        type="checkbox"
                        checked={draft.structuredOutput}
                        onChange={(event) => onUpdate(index, { structuredOutput: event.target.checked })}
                      />
                      <span>结构化输出</span>
                    </label>
                    <label className="settings-field settings-field-inline">
                      <input
                        type="checkbox"
                        checked={draft.stream}
                        onChange={(event) => onUpdate(index, { stream: event.target.checked })}
                      />
                      <span>流式输出</span>
                    </label>
                    <label className="settings-field settings-field-inline">
                      <input
                        type="checkbox"
                        checked={draft.vision}
                        onChange={(event) => onUpdate(index, { vision: event.target.checked })}
                      />
                      <span>看图（vision）</span>
                    </label>
                  </fieldset>
                  <label className="settings-field">
                    <span>凭据环境变量名</span>
                    <input
                      value={draft.apiKeyEnv}
                      disabled={locked}
                      aria-label="凭据环境变量名"
                      placeholder={draft.isNew ? "例如 DEEPSEEK_API_KEY" : "留空 = 保持现有配置"}
                      onChange={(event) => onUpdate(index, { apiKeyEnv: event.target.value })}
                    />
                    <small>
                      只填变量名，不要粘贴密钥值。已有配置留空即保持现有引用；更换引用时才填写。
                    </small>
                  </label>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="settings-editor-actions">
        <button type="button" className="secondary-button" onClick={onAdd} disabled={locked}>
          <Plus size={14} aria-hidden /> 新增配置
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={() => void onSave()}
          // 冻结（保存/读取中）与“尚未核对新版本”都不可保存，避免旧操作被自动重放。
          disabled={locked || pendingCount === 0 || !revisionConfirmed}
        >
          {saving ? "正在保存…" : "保存配置"}
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => void onCompare()}
          disabled={frozen}
        >
          <RefreshCw size={14} aria-hidden /> {reading ? "正在读取…" : "刷新服务端状态"}
        </button>
        <button type="button" className="secondary-button" onClick={onReload} disabled={locked}>
          重载服务端配置
        </button>
      </div>

      {notice ? (
        <p
          className={notice.tone === "ok" ? "settings-block-note" : "notebook-error"}
          role={notice.tone === "ok" ? "status" : "alert"}
        >
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}

function CapabilityRow({
  label,
  ready,
  note
}: {
  label: string;
  ready: boolean;
  note?: string;
}) {
  return (
    <li className="settings-capability" data-ready={ready ? "true" : "false"}>
      <span className="settings-capability-label">{label}</span>
      <span className="settings-capability-state">{ready ? "可用" : "不可用"}</span>
      {note ? <span className="settings-capability-note">{note}</span> : null}
    </li>
  );
}

/** 服务端状态用人话说明；五种状态各自不同，不打印内部 code、端点或原始异常。 */
function describeServerState(
  reading: boolean,
  state: AiConfigListResultWithFlags | undefined
): string {
  if (reading && !state) return "正在读取服务端配置状态…";
  if (!state) return "尚未读取到配置状态。";
  switch (state.status) {
    case "available":
      return "AI 已开启，模型可用。";
    case "unconfigured":
      return "尚未配置模型，请在模型配置页添加。";
    case "unavailable":
      return "模型配置不可用，请检查密钥和 API 地址。";
    case "disabled":
      return "AI 未开启。";
    default:
      // 配置本身有问题与请求失败是两回事：前者要改配置，后者可以重试。
      return state.state === "unreachable"
        ? "无法读取配置状态：这次请求没有成功（服务未响应或响应无效）。可以重试。"
        : "服务端配置状态异常：请检查服务端配置，而不是反复重试。";
  }
}

function describeConfigs(state: AiConfigListResultWithFlags | undefined): string | undefined {
  if (state?.status !== "available") return undefined;
  const names = state.configs.filter((config) => config.usable).map((config) => config.label).filter(Boolean);
  return names.length > 0 ? `当前配置：${names.join("、")}` : undefined;
}

function describeImageConfigs(
  configs: NonNullable<AiConfigListResultWithFlags["imageConfigs"]>,
  kind: "generate" | "edit"
): string | undefined {
  const names = configs.filter((c) => c.capabilities[kind]).map((c) => c.label);
  return names.length > 0 ? `当前配置：${names.join("、")}` : undefined;
}

/** T9：手机本地 Skill 管理（列表/启停/垃圾箱/彻底删除/导入预览安装；本地权威）。 */
function NativeSkillSettings({ store }: { store?: SettingsPageProps["nativeSkills"] }) {
  const [view, setView] = useState<{ ok: boolean; revision: string; skills: Array<{ id: string; label: string; summary: string; state: string; source: string; promptFiles: string[]; remark?: string }> } | null>(null);
  const [notice, setNotice] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string[]>([]);
  const [remarkEdit, setRemarkEdit] = useState<{ id?: string; value?: string }>({});
  const [urlText, setUrlText] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [preview, setPreview] = useState<{ revision: string; items: Array<{ name: string; packageId: string; duplicate?: boolean; canUpdate?: boolean; identical?: boolean; expectedFingerprint: string | null; package: unknown }>; warnings: string[] } | null>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const mdInputRef = useRef<HTMLInputElement>(null);
  const reload = () => { if (store) void store.view().then(setView).catch(() => setView(null)); };
  useEffect(reload, [store]);
  if (!store) return <p role="status">Skill 管理尚未就绪，现有本机资料保持不变。</p>;
  if (!view || !view.ok) return <p role="status">Skill 目录暂不可读。</p>;
  const renderSkill = (skill: NonNullable<typeof view>["skills"][number]) => <li key={skill.id}>
        <div className="settings-native-skill-head"><strong>{skill.label}</strong><span>{skill.state === "enabled" ? "已启用" : skill.state === "removed" ? "已移除" : "已停用"} · {skill.source === "bundled" ? "内置" : "本机安装"}</span></div>
        <p className="settings-block-note">{skill.summary}</p>
        {skill.remark ? <span> 备注：{skill.remark}</span> : null}
        <div className="settings-native-skill-actions">
          {skill.state !== "removed" ? <>
          <button type="button" onClick={() => void store.setState(skill.id, skill.state === "enabled" ? "disabled" : "enabled", view.revision)
            .then(() => { setNotice(`已${skill.state === "enabled" ? "停用" : "启用"} ${skill.label}。`); reload(); })
            .catch(() => setNotice("状态更新失败，请重试。"))}>{skill.state === "enabled" ? "停用" : "启用"}</button>
          <button type="button" aria-label={`编辑备注：${skill.label}`} onClick={() => setRemarkEdit(current => current.id === skill.id ? {} : { id: skill.id, value: skill.remark ?? "" })}>编辑备注</button>
          {remarkEdit.id === skill.id ? <span role="group" aria-label={`备注编辑：${skill.label}`}>
            <input aria-label={`备注内容：${skill.label}`} value={remarkEdit.value ?? ""} onChange={event => setRemarkEdit({ id: skill.id, value: event.target.value })} />
            <button type="button" onClick={() => void store.setRemark(skill.id, remarkEdit.value ?? "", view.revision)
              .then(() => { setNotice("备注已保存。"); setRemarkEdit({}); reload(); })
              .catch(() => setNotice("备注保存失败，请重试。"))}>保存备注</button>
            <button type="button" onClick={() => setRemarkEdit({})}>取消</button>
          </span> : null}
          </> : null}
          {skill.source === "installed" ? <button type="button" onClick={() => void store.setState(skill.id, skill.state === "removed" ? "disabled" : "removed", view.revision)
            .then(() => { setNotice(skill.state === "removed" ? "已从垃圾箱恢复。" : "已移入垃圾箱。"); reload(); })
            .catch(() => setNotice("操作失败，请重试。"))}>{skill.state === "removed" ? "恢复" : "移入垃圾箱"}</button> : null}
          {skill.source === "installed" && skill.state === "removed" ? <button type="button" onClick={() => setConfirmDelete(current => current.includes(skill.id) ? current.filter(id => id !== skill.id) : [...current, skill.id])}>
            {confirmDelete.includes(skill.id) ? "取消删除" : "彻底删除"}
          </button> : null}
          {confirmDelete.includes(skill.id) ? <button type="button" onClick={() => void store.removePermanently({ ids: [skill.id], confirmed: true, revision: view.revision })
            .then(result => { setNotice(result.deleted.length ? `已彻底删除 ${skill.label}。` : `删除被拒绝：${result.failed[0]?.detail ?? "未知"}`); setConfirmDelete([]); reload(); })
            .catch(() => setNotice("删除失败，请重试。"))}>确认彻底删除（不可撤销）</button> : null}
        </div>
      </li>;
  const removed = view.skills.filter(skill => skill.state === "removed");
  return <section className="settings-block settings-native-skills" aria-labelledby="native-skills-heading">
    <h2 id="native-skills-heading"><Puzzle size={18} aria-hidden />本机 Skill（当前账号）</h2>
    <p className="settings-block-note">手机上的 Skill 保存在本机当前账号资料中，不自动跨设备同步。</p>
    {notice ? <p role="status">{notice}</p> : null}
    {!importOpen ? <button type="button" className="secondary-button" onClick={() => setImportOpen(true)} title="导入本机 Skill：Markdown、粘贴或 ZIP" aria-label="导入本机 Skill（Markdown / 粘贴 / ZIP）">导入 Skill</button> : <div className="settings-native-import" role="group" aria-label="导入 Skill">
      <textarea aria-label="粘贴 Skill Markdown" value={pasteText} onChange={event => setPasteText(event.target.value)} placeholder="粘贴 SKILL.md 内容后点预览" rows={4} />
      <button type="button" className="secondary-button" disabled={!pasteText.trim()} onClick={() => void store.preview({ kind: "paste", text: pasteText })
        .then(result => setPreview({ revision: result.revision, items: result.items, warnings: result.warnings }))
        .catch(() => setNotice("预览失败，请检查内容后重试。"))}>预览粘贴内容</button>
      <button type="button" className="secondary-button" onClick={() => mdInputRef.current?.click()}>从 Markdown 文件导入</button>
      <input ref={mdInputRef} className="sr-only" type="file" accept=".md,.markdown,text/markdown" onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        void file.text().then(text => store.preview({ kind: "markdown", text, filename: file.name }))
          .then(result => setPreview({ revision: result.revision, items: result.items, warnings: result.warnings }))
          .catch(() => setNotice("Markdown 预览失败。"));
      }} />
      <button type="button" className="secondary-button" onClick={() => zipInputRef.current?.click()}>从 ZIP 预览</button>
      <div role="group" aria-label="受控 URL 导入">
        <input aria-label="Skill URL" value={urlText} onChange={event => setUrlText(event.target.value)} placeholder="https://…/SKILL.md 或 .zip" />
        <button type="button" className="secondary-button" disabled={!urlText.trim()} onClick={() => void store.downloadUrl(urlText.trim())
          .then(downloaded => {
            if (!downloaded.ok || downloaded.kind === "markdown") {
              if (!downloaded.ok) { setNotice(`URL 下载失败：${downloaded.error ?? "未知"}`); return; }
              return store.preview({ kind: "markdown", text: downloaded.text ?? "", filename: downloaded.filename })
                .then(result => setPreview({ revision: result.revision, items: result.items, warnings: result.warnings }));
            }
            return store.preview({ kind: "url", url: urlText.trim(), downloaded: downloaded.files
              ? { files: downloaded.files }
              : { bytes: downloaded.bytes!, filename: downloaded.filename } })
              .then(result => setPreview({ revision: result.revision, items: result.items, warnings: result.warnings }));
          })
          .catch(() => setNotice("URL 预览失败。"))}>从 URL 导入</button>
      </div>
      <input ref={zipInputRef} className="sr-only" type="file" accept=".zip,application/zip" onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        void file.arrayBuffer().then(buffer => store.preview({ kind: "zip", bytes: new Uint8Array(buffer), filename: file.name }))
          .then(result => setPreview({ revision: result.revision, items: result.items, warnings: result.warnings }))
          .catch(() => setNotice("ZIP 预览失败。"));
      }} />
      {preview ? <div role="group" aria-label="预览确认">
        {preview.warnings.map((warning, index) => <p key={index} role="status">{warning}</p>)}
        {preview.items.map((item, index) => <p key={index}>{item.name}{item.duplicate ? "（与已有重复）" : ""}{item.canUpdate ? "（可更新）" : ""}</p>)}
        <button type="button" className="primary-button" onClick={() => void store.install({ revision: preview.revision, choices: preview.items.map(item => ({ action: (item.canUpdate ? "update" : "create") as "update" | "create", targetId: item.packageId, expectedFingerprint: item.expectedFingerprint, package: item.package, source: "本机导入" })) })
          .then(result => { setNotice(result.ok ? "已安装所选 Skill。" : "安装失败，请重试。"); setPreview(null); setPasteText(""); setImportOpen(false); reload(); })
          .catch(() => setNotice("安装失败，请重试。"))}>确认安装</button>
        <button type="button" onClick={() => setPreview(null)}>取消预览</button>
      </div> : null}
      <button type="button" onClick={() => { setImportOpen(false); setPreview(null); }}>关闭导入</button>
    </div>}
    <ul className="settings-native-skill-list">
      {view.skills.filter(skill => skill.state !== "removed").map(renderSkill)}
    </ul>
    {removed.length > 0 ? <details className="settings-skill-removed"><summary>垃圾箱（{removed.length}）</summary><ul className="settings-native-skill-list">{removed.map(renderSkill)}</ul></details> : null}
  </section>;
}

/** F8：登出本地清除失败时的可见反馈（不静默、不冒充成功）。 */
function SignOutFailureNotice() {
  const [message, setMessage] = useState("");
  useEffect(() => {
    const onFailed = (event: Event) => setMessage((event as CustomEvent<string>).detail || "退出未完成，请重试。");
    window.addEventListener("xingji:native-signout-failed", onFailed);
    return () => window.removeEventListener("xingji:native-signout-failed", onFailed);
  }, []);
  if (!message) return null;
  return <p role="alert">{message}</p>;
}

/** 数据概况：只显示真实计数；未就绪时明说未就绪，不用 0 冒充。 */
function DataSection({ dataStatus, nativeClear, nativeSignOut, nativeBackup }: { dataStatus?: SettingsDataStatus; nativeClear?: { clear(): Promise<{ ok: boolean; message: string }> }; nativeSignOut?: { signOut(): Promise<void> }; nativeBackup?: { export(): Promise<{ ok: boolean; fileName?: string; code?: string }>; restore(file: File): Promise<{ ok: boolean; code?: string; message: string }> } }) {
  const backupFileRef = useRef<HTMLInputElement>(null);
  const [backupMessage, setBackupMessage] = useState("");
  const onRestoreFile = (file: File | undefined) => {
    if (!file || !nativeBackup) return;
    void nativeBackup.restore(file).then(result => setBackupMessage(result.message));
  };
  const [clearState, setClearState] = useState<"idle" | "confirm" | "running">("idle");
  const [clearMessage, setClearMessage] = useState("");
  const overview = (dataStatus ? (
        <dl className="settings-model">
          <div>
            <dt>笔记本</dt>
            <dd>{dataStatus.ready ? `${dataStatus.notebooks} 本` : "读取中…"}</dd>
          </div>
          <div>
            <dt>笔记</dt>
            <dd>{dataStatus.ready ? `${dataStatus.pages} 篇` : "读取中…"}</dd>
          </div>
          <div>
            <dt>本机图片</dt>
            <dd>{dataStatus.ready ? `${dataStatus.media} 个` : "读取中…"}</dd>
          </div>
          <div>
            <dt>垃圾桶</dt>
            <dd>
              {dataStatus.ready
                ? dataStatus.trashed > 0
                  ? `${dataStatus.trashed} 条待处理（可恢复或永久删除）`
                  : "空"
                : "读取中…"}
            </dd>
          </div>
        </dl>
      ) : null);
  if (nativeClear || nativeSignOut || nativeBackup) return <section className="settings-block settings-local-data" aria-labelledby="native-data-heading">
    <h2 id="native-data-heading"><Database size={18} aria-hidden />本机数据</h2>
    {dataStatus?.storageError ? <p className="notebook-error" role="alert">读取本机数据时出错：{dataStatus.storageError}。下面的计数可能不完整。</p> : null}
    {overview}
    {nativeBackup ? <section className="settings-data-group"><h3>备份与恢复</h3><p className="settings-block-note">恢复仅适用于同账号的空资料。</p><div className="settings-actions">
      <button type="button" className="secondary-button" aria-label="导出本机备份" onClick={() => void nativeBackup.export().then(result => {
        setBackupMessage(result.ok ? `备份文件已准备：${result.fileName ?? ""}`
          : result.code === "BACKUP_EXPORT_CANCELLED" ? "已取消导出备份。"
          : `导出失败（${result.code ?? "未知"}），请重试。`);
      })}>导出本机备份</button>
      <button type="button" className="secondary-button" aria-label="从备份恢复（仅限同账号空资料）" onClick={() => backupFileRef.current?.click()}>恢复备份</button>
      <input ref={backupFileRef} className="sr-only" type="file" accept=".zip,application/zip" onChange={event => { onRestoreFile(event.target.files?.[0]); event.target.value = ""; }} />
    </div></section> : null}
    {backupMessage ? <p role="status">{backupMessage}</p> : null}
    {nativeSignOut ? <section className="settings-data-group"><h3>账户</h3>
    <button type="button" className="secondary-button" onClick={() => void nativeSignOut.signOut().catch(() => undefined)}>退出登录</button>
    <SignOutFailureNotice />
    </section> : null}
    {nativeClear ? <section className="settings-data-group settings-data-danger"><h3>清空本机资料</h3>
    <p className="settings-block-note">清空会删除当前账号在本机的全部业务数据（笔记、随记、聊天、媒体原件）并轮换本机资料标识；服务器与浏览器端数据不受影响，其他账号的本机数据保持不变。</p>
    {clearState === "idle" ? <button type="button" className="secondary-button settings-danger-button" onClick={() => setClearState("confirm")}>清空当前账号本机数据</button> : null}
    {clearState === "confirm" ? <div role="group" aria-label="确认清空">
      <p role="status">确定清空？此操作不可撤销，只影响当前账号的本机资料。</p>
      <button type="button" className="secondary-button" onClick={() => { setClearState("running"); void nativeClear!.clear().then((result) => {
        setClearMessage(result.message);
        setClearState("idle");
      }); }}>确认清空（不可撤销）</button>
      <button type="button" className="secondary-button" onClick={() => setClearState("idle")}>取消</button>
    </div> : null}
    {clearState === "running" ? <p role="status">正在清空…</p> : null}
    {clearMessage ? <p role="alert">{clearMessage}</p> : null}
    </section> : null}
  </section>;
  return (
    <section className="settings-block" aria-labelledby="data-heading">
      <h2 id="data-heading">
        <Database size={16} /> 本机数据
      </h2>
      {!dataStatus ? (
        <p className="settings-block-note">尚未读取到本机数据概况。</p>
      ) : dataStatus.storageError ? (
        <p className="notebook-error" role="alert">
          读取本机数据时出错：{dataStatus.storageError}。下面的计数可能不完整。
        </p>
      ) : null}
      {overview}

    </section>
  );
}
