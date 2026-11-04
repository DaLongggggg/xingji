/**
 * 按需 Skill 知识的共享契约与同源客户端（阶段B）。
 *
 * - 服务端从统一 `.local/skills/`（或配置根）的直接子目录**发现** Skill（目录名 = 稳定 ID）；
 *   这里只有形状与轻量目录/受控读取的协议，不含任何已安装 Skill 的名字清单；
 * - 目录（catalog）只有元数据：id、frontmatter 的 name/description、启停状态与
 *   SKILL.md 摘要——**不含正文**；正文只能由 read（read_skill 工具）按需读取；
 * - 默认读取全文；显式 offset/limit 才按字符窗口返回覆盖信息（total/nextOffset）；
 * - Skill 内容只是方法资料：不能改变输出契约、模型选择、权限、预算或授权。
 */

/** 轻量目录条目（无正文）。`readable=false`/`error` 表示目录损坏或不可读。 */
export type SkillCatalogEntry = {
  id: string;
  /** SKILL.md frontmatter 的 name（缺省 = 目录 id）。 */
  name: string;
  /** User annotation used by quick invocation; name is always original metadata. */
  remark?: string;
  description: string;
  enabled: boolean;
  /** SKILL.md 存在且可读。 */
  readable: boolean;
  /** SKILL.md 的 sha256（hex 64）；资源身份摘要。 */
  digest?: string;
  /** SKILL.md 全文字符数。 */
  totalChars?: number;
  error?: string;
  /** Same registry, different platform storage roots. */
  source?: "bundled" | "installed";
  sourceDir?: string;
};

/** 受控读取请求：默认读 SKILL.md；也可读 references/ 下的 .md。 */
export type SkillReadRequest = {
  id: string;
  /** 相对 Skill 目录的路径：只接受 `SKILL.md` 与 `references/<name>.md`。 */
  path?: string;
  /** 字符偏移（续读位置）。 */
  offset?: number;
  /** 本次读取的字符数；不提供时读取剩余全文。 */
  limit?: number;
};

/** 设计请求声明的读取窗口（不含正文——正文由服务端按同一窗口重新读取核对）。 */
export type SkillDesignWindow = {
  /** 缺省 = SKILL.md。 */
  path?: string;
  offset: number;
  limit: number;
  /** 该文件读取时的 sha256（服务端复核：不一致 = 资源已变化，明确失败）。 */
  digest: string;
};

/** 设计请求的资源声明：只声明身份与窗口，不携带正文、不自带名字。 */
export type SkillDesignResource = {
  id: string;
  /** SKILL.md 的 sha256（资源身份摘要）。 */
  digest: string;
  windows: SkillDesignWindow[];
};

export type SkillReadFailureCode =
  | "SKILL_NOT_FOUND"
  | "SKILL_DISABLED"
  | "SKILL_PATH_INVALID"
  | "SKILL_UNREADABLE"
  | "SKILL_STATE_UNREADABLE";

export type SkillReadResult =
  | {
      ok: true;
      id: string;
      name: string;
      /** 实际读取的相对路径。 */
      path: string;
      /** **本次读取文件**的 sha256（SKILL.md 的摘要即资源身份摘要）。 */
      digest: string;
      /** 该文件全文字符数。 */
      total: number;
      offset: number;
      text: string;
      nextOffset?: number;
    }
  | { ok: false; code: SkillReadFailureCode; detail: string };

export function isSkillId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
}

/** Advisory UI refresh only; server reads and permissions remain authoritative. */
export const SKILL_CATALOG_CHANGED_EVENT = "xingji:skill-catalog-changed";

export function skillDisplayName(skill: Pick<SkillCatalogEntry, "name" | "remark">): string {
  return skill.remark?.trim() || skill.name;
}

/** references/ 下允许的单段文件名：可读文本名，不允许目录段、点开头或非 .md。 */
import { apiFetch } from "@/lib/api-client";

const REFERENCE_FILE_PATTERN = /^references\/([A-Za-z0-9][A-Za-z0-9._-]{0,80})\.md$/;

/** 相对路径是否受控（只允许 SKILL.md 与 references/*.md；拒绝穿越、脚本、URL）。 */
export function isAllowedSkillPath(value: string): boolean {
  if (value === "SKILL.md") return true;
  return REFERENCE_FILE_PATTERN.test(value) && !value.split("/").some(segment => segment === "." || segment === "..");
}

/**
 * 同源目录读取：GET /api/ai/skills。
 * 「成功取得空目录」与「目录请求失败」是不同结果：网络错误、非 2xx、响应形状
 * 不合法都**抛出**，由调用方决定 fail-closed（点名资源无法核实就必须停止出站），
 * 不得把失败伪装成空目录继续。
 */
export async function fetchSkillCatalog(endpoint = "/api/ai/skills"): Promise<SkillCatalogEntry[]> {
  // T2a：经受控认证入口读取（同源凭证 + 401 广播）。
  const response = await apiFetch(endpoint, { headers: { "cache-control": "no-store" } });
  if (!response.ok) throw new Error(`Skill 目录请求失败（HTTP ${response.status}）。`);
  const payload = (await response.json().catch(() => null)) as { ok?: unknown; skills?: unknown } | null;
  if (!payload || payload.ok !== true || !Array.isArray(payload.skills)) {
    throw new Error("Skill 目录响应不完整。");
  }
  const entries: SkillCatalogEntry[] = [];
  for (const [index, raw] of payload.skills.entries()) {
    // 无效条目明确失败（复审四）：静默跳过会让点名资源失配后仍按基础方法出站。
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`Skill 目录响应第 ${index + 1} 项不是对象。`);
    }
    const item = raw as Record<string, unknown>;
    if (!isSkillId(item.id) || typeof item.name !== "string" || typeof item.description !== "string"
      || typeof item.enabled !== "boolean" || typeof item.readable !== "boolean") {
      throw new Error(`Skill 目录响应第 ${index + 1} 项形状无效。`);
    }
    entries.push({
      id: item.id, name: item.name, description: item.description, enabled: item.enabled, readable: item.readable,
      ...(typeof item.remark === "string" ? { remark: item.remark } : {}),
      ...(typeof item.digest === "string" ? { digest: item.digest } : {}),
      ...(typeof item.totalChars === "number" ? { totalChars: item.totalChars } : {}),
      ...(typeof item.error === "string" ? { error: item.error } : {}),
      ...(item.source === "bundled" || item.source === "installed" ? { source: item.source } : {}),
      ...(typeof item.sourceDir === "string" ? { sourceDir: item.sourceDir } : {})
    });
  }
  return entries;
}

/** 同源受控读取：GET /api/ai/skills/content。网络失败按 SKILL_UNREADABLE 明确报错。 */
export async function fetchSkillContent(
  request: SkillReadRequest,
  endpoint = "/api/ai/skills/content"
): Promise<SkillReadResult> {
  const params = new URLSearchParams({ id: request.id });
  if (request.path) params.set("path", request.path);
  if (request.offset !== undefined) params.set("offset", String(request.offset));
  if (request.limit !== undefined) params.set("limit", String(request.limit));
  try {
    const response = await apiFetch(`${endpoint}?${params.toString()}`, { headers: { "cache-control": "no-store" } });
    const payload = (await response.json().catch(() => null)) as Partial<SkillReadResult> | null;
    if (!payload || typeof payload.ok !== "boolean") {
      return { ok: false, code: "SKILL_UNREADABLE", detail: "Skill 内容服务当前不可用，请稍后重试。" };
    }
    if (!payload.ok) {
      const failure = payload as { ok: false; code?: unknown; detail?: unknown };
      return {
        ok: false,
        code: typeof failure.code === "string" ? failure.code as SkillReadFailureCode : "SKILL_UNREADABLE",
        detail: typeof failure.detail === "string" ? failure.detail : "Skill 内容不可读。"
      };
    }
    const data = payload as Extract<SkillReadResult, { ok: true }>;
    if (typeof data.text !== "string" || typeof data.total !== "number" || typeof data.digest !== "string") {
      return { ok: false, code: "SKILL_UNREADABLE", detail: "Skill 内容响应不完整，请重试。" };
    }
    return data;
  } catch {
    return { ok: false, code: "SKILL_UNREADABLE", detail: "Skill 内容服务请求失败，请稍后重试。" };
  }
}
