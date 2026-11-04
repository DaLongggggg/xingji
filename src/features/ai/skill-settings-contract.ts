/**
 * Skill 管理的共享契约（客户端与服务端同一份）。
 *
 * 用户开关与备注进持久化文档；可用性由能力/依赖/资源健康派生，
 * 因此这里既有状态白名单，也有管理视图（脱敏）的形状与校验。
 */
/**
 * 登记范围：图片提示资源 + 三个**第三方风格资源**
 * （提示词文本已 vendor 进 `.local/skills/`，见各目录 `PROVENANCE.md`）。
 * 阶段B：这份清单只服务设置页的登记视图；Agent 的 Skill 发现来自
 * `.local/skills/` 文件系统扫描（无代码清单），启停按形状合法的目录名 id 走同一机制。
 */
export const MANAGED_SKILL_IDS = [
  "huashu-gpt-image",
  "gc-minimal-zine-poster",
  "gathered-scenes-zine",
  "photo-abstract-editorial"
] as const;
export type ManagedSkillId = (typeof MANAGED_SKILL_IDS)[number];

/** 形状合法的 Skill id（技能目录名）。阶段B 起启停机制按形状接受发现的任意 Skill。 */
export { isSkillId } from "./skill-knowledge";

export const SKILL_STATES = ["enabled", "disabled", "removed"] as const;
export type SkillState = (typeof SKILL_STATES)[number];

/** 已退役的三个状态键仅用于读取旧加密文档；不进入管理视图，写接口也不再接受（防复活）。 */
const LEGACY_SKILL_IDS = ["moments", "photo_edit", "journal_design"] as const;
export function isLegacySkillId(value: unknown): value is LegacySkillId {
  return typeof value === "string" && (LEGACY_SKILL_IDS as readonly string[]).includes(value);
}
type LegacySkillId = (typeof LEGACY_SKILL_IDS)[number];

/**
 * 加密文档里的可选字段：旧键原样保留，避免普通设置写入破坏用户配置。
 * 阶段B：键放宽为形状合法的目录名 id——发现的第五个 Skill 走同一启停机制；
 * 形状校验在 parseSkillStates 里做，这里只是存储形状。
 */
export type SkillStateMap = Record<string, SkillState>;

export const SKILL_DELETE_MAX_ITEMS = 100;
export type SkillDeleteRequest = { revision: string; ids: string[]; confirmed: true };
export type SkillDeleteResult = {
  deleted: string[];
  failed: { id: string; detail: string }[];
  /** Files are gone, but their settings could not yet be cleared. Retry from the trash. */
  cleanupPending?: true;
};

export const SKILL_REMARK_MAX_LENGTH = 100;
export type SkillRemarkMap = Record<string, string>;

/** Empty input clears a remark; remarks never alter the original name or ID. */
export function isSkillRemark(value: unknown): value is string {
  return typeof value === "string" && value.length <= SKILL_REMARK_MAX_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function parseSkillRemarks(value: unknown): SkillRemarkMap | undefined {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const parsed: SkillRemarkMap = {};
  for (const [id, remark] of Object.entries(value)) {
    if (!isSkillId(id) || isLegacySkillId(id) || !isSkillRemark(remark) || !remark.trim()) return undefined;
    parsed[id] = remark.trim();
  }
  return parsed;
}

export function isManagedSkillId(value: unknown): value is ManagedSkillId {
  return typeof value === "string" && (MANAGED_SKILL_IDS as readonly string[]).includes(value);
}



import { isSkillId } from "./skill-knowledge";

export function isSkillState(value: unknown): value is SkillState {
  return typeof value === "string" && (SKILL_STATES as readonly string[]).includes(value);
}

/**
 * 严格校验持久化字段：未知 ID 或非法值一律返回 undefined（调用方按损坏处理，
 * **不**静默当成“已启用”，也不覆盖文件）。
 */
export function parseSkillStates(value: unknown): SkillStateMap | undefined {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  const parsed: SkillStateMap = {};
  for (const [key, state] of entries) {
    // 阶段B：除登记/旧键外，接受形状合法的目录名 id（发现的第五个 Skill 也走同一机制）。
    const knownOrShaped = isManagedSkillId(key) || (LEGACY_SKILL_IDS as readonly string[]).includes(key) || isSkillId(key);
    if (!knownOrShaped || !isSkillState(state)) return undefined;
    parsed[key as ManagedSkillId | LegacySkillId] = state;
  }
  return parsed;
}

/** 管理视图条目（脱敏：只有分类/版本/相对来源目录与状态，不含任何本机绝对路径或密钥）。
 *  阶段B：id 是 技能目录名——发现的任意 Skill（含第五个）都出现在登记视图。 */
export type ManagedSkillView = {
  id: string;
  label: string;
  /** User annotation; label remains the original SKILL.md name. */
  remark?: string;
  summary: string;
  kind: "resource";
  version: string;
  state: SkillState;
  /** 用户开关之外的能力/依赖/资源健康判定。 */
  available: boolean;
  reason?: string;
  requires: string[];
  tools: string[];
  usedBy: string[];
  /** 相对项目根的来源目录（详情展示用）。 */
  sourceDir: string;
  /** 该目录当前是否存在（真实检查，不做假设）。 */
  directoryExists: boolean;
  /** Absent in older responses; those remain compatible. */
  source?: "bundled" | "installed";
  /** 相关提示/资源文件（相对路径）。 */
  promptFiles: string[];
  /** 每个文件的 sha256（B6：任务快照声明 references 窗口用；旧响应缺省兼容）。 */
  fileDigests?: Record<string, string>;
  /** 文件资源型才有的适配版本与校验状态。 */
  verification?: { adapterVersion: number; digest: string; status: "ok" | "missing" | "changed" };
};

export type SkillSettingsView = {
  ok: true;
  /** 当前配置文档版本令牌；不可写时为 null。 */
  revision: string | null;
  /** 是否允许在本机修改（服务端判定）。 */
  writable: boolean;
  skills: ManagedSkillView[];
  /**
   * 复审六/七：写入成功而写后回读失败时，服务端返回已保存状态与原因
   * （skills 为空数组 = 暂不可读，不是「没有 Skill」）；常规响应缺省。
   */
  savedState?: { id: string; state: SkillState };
  savedRemark?: { id: string; remark: string };
  deletion?: SkillDeleteResult;
  detail?: string;
};

export const SKILL_STATE_LABEL: Record<SkillState, string> = {
  enabled: "已启用",
  disabled: "已停用",
  removed: "在垃圾箱"
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSkillDeleteRequest(value: unknown): SkillDeleteRequest | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 3 || value.confirmed !== true
    || typeof value.revision !== "string" || !value.revision.trim() || value.revision.length > 512
    || !Array.isArray(value.ids) || !value.ids.length || value.ids.length > SKILL_DELETE_MAX_ITEMS
    || !value.ids.every(id => isSkillId(id) && !isLegacySkillId(id))
    || new Set(value.ids).size !== value.ids.length) return undefined;
  return { revision: value.revision.trim(), ids: value.ids as string[], confirmed: true };
}

function parseSkillDeleteResult(value: unknown): SkillDeleteResult | undefined {
  if (!isRecord(value) || !Array.isArray(value.deleted) || !Array.isArray(value.failed)
    || !value.deleted.every(id => isSkillId(id) && !isLegacySkillId(id))
    || !value.failed.every(item => isRecord(item) && isSkillId(item.id) && !isLegacySkillId(item.id) && typeof item.detail === "string")
    || (value.cleanupPending !== undefined && value.cleanupPending !== true)) return undefined;
  const failed = value.failed as SkillDeleteResult["failed"];
  const ids = [...value.deleted, ...failed.map(item => item.id)];
  if (!ids.length || ids.length > SKILL_DELETE_MAX_ITEMS || new Set(ids).size !== ids.length) return undefined;
  return { deleted: value.deleted as string[], failed, ...(value.cleanupPending ? { cleanupPending: true } : {}) };
}

/** 客户端解析：服务端返回不符合形状就明确失败，不拿半个对象当设置。 */
export function parseManagedSkillView(value: unknown): ManagedSkillView | undefined {
  if (!isRecord(value)) return undefined;
  if (!isSkillId(value.id) || !isSkillState(value.state)) return undefined;
  if (typeof value.label !== "string" || typeof value.summary !== "string") return undefined;
  if (value.remark !== undefined && !isSkillRemark(value.remark)) return undefined;
  if (value.kind !== "resource") return undefined;
  if (typeof value.version !== "string" || typeof value.available !== "boolean") return undefined;
  if (typeof value.sourceDir !== "string" || typeof value.directoryExists !== "boolean") return undefined;
  if (!Array.isArray(value.requires) || !Array.isArray(value.tools) || !Array.isArray(value.usedBy) || !Array.isArray(value.promptFiles))
    return undefined;
  const strings = (input: unknown[]): input is string[] => input.every(item => typeof item === "string");
  if (!strings(value.requires) || !strings(value.tools) || !strings(value.usedBy) || !strings(value.promptFiles)) return undefined;
  const verification = value.verification;
  if (verification !== undefined) {
    if (!isRecord(verification) || typeof verification.adapterVersion !== "number" || typeof verification.digest !== "string") return undefined;
    if (verification.status !== "ok" && verification.status !== "missing" && verification.status !== "changed") return undefined;
  }
  return value as ManagedSkillView;
}

export function parseSkillSettingsView(value: unknown): SkillSettingsView | undefined {
  if (!isRecord(value) || value.ok !== true) return undefined;
  if (value.revision !== null && typeof value.revision !== "string") return undefined;
  if (typeof value.writable !== "boolean" || !Array.isArray(value.skills)) return undefined;
  const skills = value.skills.map(parseManagedSkillView);
  if (skills.some(skill => skill === undefined)) return undefined;
  const deletion = value.deletion === undefined ? undefined : parseSkillDeleteResult(value.deletion);
  if (value.deletion !== undefined && !deletion) return undefined;
  return {
    ok: true, revision: value.revision, writable: value.writable,
    skills: skills as ManagedSkillView[],
    ...(deletion ? { deletion } : {}),
    // 复审七：保留「已保存、列表暂不可读」的原因与状态（常规响应缺省）。
    ...(isRecord(value.savedState) && isSkillId(value.savedState.id) && isSkillState(value.savedState.state)
      ? { savedState: { id: value.savedState.id, state: value.savedState.state } } : {}),
    ...(isRecord(value.savedRemark) && isSkillId(value.savedRemark.id) && isSkillRemark(value.savedRemark.remark)
      ? { savedRemark: { id: value.savedRemark.id, remark: value.savedRemark.remark } } : {}),
    ...(typeof value.detail === "string" ? { detail: value.detail } : {})
  };
}
