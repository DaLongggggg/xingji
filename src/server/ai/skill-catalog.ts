/**
 * 按需 Skill 的服务端发现与受控读取（阶段B）。
 *
 * - 发现：扫描统一 `.local/skills/`（或配置根）的直接子目录；目录名就是
 *   兼容现有设置的稳定 ID。没有任何 TypeScript 常量清单——加入第五个 Skill 不改代码。
 * - frontmatter 的 name/description 供模型目录使用（可与目录名不同）。
 * - 读取只接受 `SKILL.md` 与 `references/<name>.md`：路径穿越、根外符号链接、
 *   脚本与 URL 一律明确拒绝；默认读取全文，显式窗口可续读并带覆盖信息。
 * - 状态以既有设置文档为权威（服务端唯一事实）；停用/移除的 Skill 读取明确报错。
 * - 边界：Skill 内容只是方法资料，不能改变系统规则、权限、预算或授权。
 */
import { readFile, realpath } from "node:fs/promises";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  isAllowedSkillPath,
  isSkillId,
  type SkillCatalogEntry,
  type SkillReadRequest,
  type SkillReadResult
} from "@/features/ai/skill-knowledge";
import { MANAGED_SKILL_IDS, type SkillStateMap, type SkillRemarkMap } from "@/features/ai/skill-settings-contract";
import { readSkillStates, readSkillRemarks, registeredVerificationStatus } from "./skill-settings";
import { readSkillMetadata } from "@/features/skills/skill-package";
import { assertSkillInstallReadable, bundledSkillEnv, findSkillLocation, isBundledSkillId, skillRoot } from "./skill-paths";
import { scopedEnvForModelConfig } from "./user-scope.ts";

export type { SkillCatalogEntry } from "@/features/ai/skill-knowledge";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Standard YAML metadata is shared with the installer. */
export const parseSkillFrontmatter = readSkillMetadata;

/**
 * 扫描目录（轻量，无正文进响应）。states 缺省时读取设置文档；
 * 状态读不出按全部未置处理会违反 fail-closed，因此调用方应捕获并按不可用处理。
 */
export async function scanSkillCatalog(
  rootDir = process.cwd(),
  states?: SkillStateMap,
  env: Record<string, string | undefined> = scopedEnvForModelConfig(),
  remarks?: SkillRemarkMap
): Promise<SkillCatalogEntry[]> {
  return scanSkillCatalogSync(rootDir, states, env, remarks);
}

/** 同步版目录扫描（设置页登记视图用：同一发现逻辑，复用本机小文件读取）。 */
export function scanSkillCatalogSync(
  rootDir = process.cwd(),
  states?: SkillStateMap,
  env: Record<string, string | undefined> = scopedEnvForModelConfig(),
  remarks?: SkillRemarkMap
): SkillCatalogEntry[] {
  assertSkillInstallReadable(rootDir, env);
  const resolvedStates = states ?? readSkillStates(env);
  const resolvedRemarks = remarks ?? readSkillRemarks(env);
  const entries: SkillCatalogEntry[] = [];
  const location = skillRoot(rootDir, env);
  const root = location.directory;
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // A missing root permits first installation; an existing broken link is an error.
      try {
        lstatSync(root);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") return [];
      }
    }
    throw new Error("Skill 目录无法读取。");
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    throw new Error("Skill 目录无法解析。");
  }
  for (const dirent of dirents) {
    // 只看真实子目录（符号链接目录不跟随）；目录名即稳定 ID。
    if (!dirent.isDirectory() || !isSkillId(dirent.name)) continue;
    const id = dirent.name;
    const state = resolvedStates[id];
    const entry: SkillCatalogEntry = {
      id,
      name: id,
      ...(resolvedRemarks[id] ? { remark: resolvedRemarks[id] } : {}),
      description: "",
      enabled: state === undefined || state === "enabled",
      readable: false,
      source: (MANAGED_SKILL_IDS as readonly string[]).includes(id) ? "bundled" : "installed",
      sourceDir: `${location.displayPath}/${id}`
    };
    const skillDir = path.join(root, id);
    const realDir = (() => {
      try {
        return realpathSync(skillDir);
      } catch {
        return null;
      }
    })();
    if (realDir === null || realDir !== path.join(realRoot, id)) {
      entry.error = "Skill 目录是符号链接，已拒绝扫描";
      entries.push(entry);
      continue;
    }
    const skillFile = path.join(skillDir, "SKILL.md");
    const expectedFile = path.join(realRoot, id, "SKILL.md");
    const realFile = (() => {
      try {
        return realpathSync(skillFile);
      } catch {
        return null;
      }
    })();
    if (realFile === null) {
      entry.error = "SKILL.md 不可读";
      entries.push(entry);
      continue;
    }
    if (realFile !== expectedFile) {
      entry.error = "SKILL.md 是符号链接，已拒绝扫描";
      entries.push(entry);
      continue;
    }
    try {
      const content = readFileSync(realFile, "utf8");
      const frontmatter = parseSkillFrontmatter(content);
      entry.name = frontmatter.name ?? id;
      entry.description = frontmatter.description ?? "";
      entry.digest = sha256(content);
      entry.totalChars = content.length;
      const verification = registeredVerificationStatus(id, rootDir, env);
      if (verification === "ok" || verification === "unverified") {
        entry.readable = true;
      } else {
        entry.error =
          verification === "changed"
            ? "资源未通过原有完整性校验（已被改动）"
            : "资源未通过原有完整性校验（文件缺失）";
      }
    } catch (error) {
      entry.error =
        error instanceof Error
          ? `SKILL.md 不可读（${error.message.slice(0, 80)}）`
          : "SKILL.md 不可读";
    }
    entries.push(entry);
  }
  return entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * 受控读取一个 Skill 文件；默认全文，显式 offset/limit 才分窗。失败码见 SkillReadResult：
 * 未登记/缺失 → SKILL_NOT_FOUND；停用 → SKILL_DISABLED；路径不合法 → SKILL_PATH_INVALID；
 * 符号链接越界/读不了 → SKILL_UNREADABLE；设置状态读不出 → SKILL_STATE_UNREADABLE（fail closed）。
 */
export async function readSkillDoc(
  request: SkillReadRequest,
  options: {
    rootDir?: string;
    states?: SkillStateMap;
    env?: Record<string, string | undefined>;
  } = {}
): Promise<SkillReadResult> {
  if (!isSkillId(request.id)) {
    return {
      ok: false,
      code: "SKILL_NOT_FOUND",
      detail: `没有这个 Skill：${String(request.id).slice(0, 60)}`
    };
  }
  const relPath = request.path ?? "SKILL.md";
  if (typeof relPath !== "string" || !isAllowedSkillPath(relPath)) {
    return {
      ok: false,
      code: "SKILL_PATH_INVALID",
      detail: "只能读取 SKILL.md 或 references/ 下的 .md 文件。"
    };
  }
  let states: SkillStateMap;
  try {
    assertSkillInstallReadable(options.rootDir, options.env);
    states = options.states ?? readSkillStates(options.env);
  } catch {
    return {
      ok: false,
      code: "SKILL_STATE_UNREADABLE",
      detail: "无法确认本机 Skill 状态，已停止读取；请在设置中检查。"
    };
  }
  const state = states[request.id];
  if (state === "disabled" || state === "removed") {
    return {
      ok: false,
      code: "SKILL_DISABLED",
      detail: `Skill ${request.id} 已停用或移除；启用后再试。`
    };
  }
  // 已登记资源未通过原有完整性校验（被改动/缺失）：拒绝读取，不因可计算摘要而放行。
  // T2a：bundled 资源按部署级根核对与定位；用户安装的 Skill 按 scope 根。
  const pathEnv = isBundledSkillId(request.id) ? bundledSkillEnv() : options.env;
  const verification = registeredVerificationStatus(request.id, options.rootDir ?? process.cwd(), pathEnv);
  if (verification === "changed" || verification === "missing") {
    return {
      ok: false,
      code: "SKILL_UNREADABLE",
      detail: `Skill ${request.id} 未通过原有完整性校验（${verification === "changed" ? "文件被改动" : "文件缺失"}）；请在设置中检查后再试。`
    };
  }

  let location: ReturnType<typeof findSkillLocation>;
  try {
    location = findSkillLocation(request.id, options.rootDir, pathEnv);
  } catch {
    return {
      ok: false,
      code: "SKILL_PATH_INVALID",
      detail: "Skill 目录不可读，请在设置中检查。"
    };
  }
  if (!location)
    return { ok: false, code: "SKILL_NOT_FOUND", detail: `没有这个 Skill：${request.id}` };
  const rootDir = location.root.directory;
  const dir = location.directory;
  let realRoot: string;
  let realDir: string;
  try {
    // 根外符号链接（<技能根>/<id> 指向别处）在这里被拒：解析结果必须仍在配置根内。
    realRoot = await realpath(rootDir);
    realDir = await realpath(dir);
  } catch {
    return { ok: false, code: "SKILL_NOT_FOUND", detail: `没有这个 Skill：${request.id}` };
  }
  if (
    realDir !== path.join(realRoot, request.id) ||
    !realDir.startsWith(`${realRoot}${path.sep}`)
  ) {
    return {
      ok: false,
      code: "SKILL_PATH_INVALID",
      detail: "Skill 目录不是本应用技能根下的固定目录，已拒绝读取。"
    };
  }

  const file = path.join(realDir, relPath);
  let content: string;
  try {
    /*
     * 文件级 realpath 复核：解析结果必须**就是声明的路径**——文件是符号链接时
     * realpath 会指向别处（目录外的脚本、目录内被伪装的 PROVENANCE.md 等），
     * 一律拒绝；白名单形状（SKILL.md / references/*.md）只在真实文件上生效。
     */
    const realFile = await realpath(file);
    // 期望路径用 realDir 归一：realDir 是 realpath 结果，跨 /var 前缀一致。
    if (realFile !== path.join(realDir, relPath)) {
      return { ok: false, code: "SKILL_PATH_INVALID", detail: "目标文件是符号链接，已拒绝读取。" };
    }
    if (!realFile.startsWith(`${realDir}${path.sep}`) || !realFile.endsWith(".md")) {
      return {
        ok: false,
        code: "SKILL_PATH_INVALID",
        detail: "目标文件不是该 Skill 目录内的 .md 文本文件，已拒绝读取。"
      };
    }
    content = await readFile(realFile, "utf8");
  } catch {
    return {
      ok: false,
      code: relPath === "SKILL.md" ? "SKILL_NOT_FOUND" : "SKILL_UNREADABLE",
      detail:
        relPath === "SKILL.md"
          ? `Skill ${request.id} 缺少 SKILL.md，无法读取。`
          : `references 文件不可读：${relPath}`
    };
  }

  const total = content.length;
  if (
    (request.offset !== undefined &&
      (!Number.isSafeInteger(request.offset) || request.offset < 0)) ||
    (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 1))
  ) {
    return {
      ok: false,
      code: "SKILL_PATH_INVALID",
      detail: "offset/limit 必须是有效的非负偏移与正整数字数。"
    };
  }
  const offset = Math.max(0, Math.trunc(request.offset ?? 0) || 0);
  const limit = request.limit ?? total - offset;
  if (offset >= total) {
    return {
      ok: false,
      code: "SKILL_PATH_INVALID",
      detail: `offset 超出全文长度（${total} 字）；请从 0 开始读取。`
    };
  }
  const text = content.slice(offset, offset + limit);
  const nextOffset = offset + limit < total ? offset + limit : undefined;
  const name = parseSkillFrontmatter(content).name ?? request.id;
  return {
    ok: true,
    id: request.id,
    name,
    path: relPath,
    digest: sha256(content),
    total,
    offset,
    text,
    ...(nextOffset !== undefined ? { nextOffset } : {})
  };
}

/* ------------------------------------------------------------------ *
 * 设计轮的可信资源解析：请求只声明「读过什么」，正文一律由服务端重读核对
 * ------------------------------------------------------------------ */

export type DesignSkillContent = {
  id: string;
  name: string;
  digest: string;
  /** 服务端按声明窗口重新读取并核对后的正文（带窗口跨度标注）。 */
  text: string;
};

export type DesignResourceResolution =
  | { ok: true; contents: DesignSkillContent[]; resources: { id: string; digest: string }[] }
  | {
      ok: false;
      code:
        | "IMAGE_REQUEST_INVALID"
        | "AI_SKILL_RESOURCE_UNAVAILABLE"
        | "AI_SKILL_RESOURCE_CHANGED"
        | "AI_SKILL_STATE_UNREADABLE";
      detail: string;
    };

const MAX_DESIGN_RESOURCES = 9;

type RawDesignResource = {
  id?: unknown;
  digest?: unknown;
  windows?: unknown;
};

/**
 * 从设计请求输入解析 `skillResources`，并**在服务端重新读取**每个声明窗口：
 * - 请求只允许携带 {id, digest, windows:[{path?, offset, limit, digest}]}——
 *   正文、名字都不可由请求方声明（防伪造内容冒充已读 Skill）；
 * - id 必须是技能根下真实存在、当前启用且可读的目录（可信来源核对）；
 * - 每个窗口的服务端摘要必须与声明一致——不一致 = 资源已变化，明确失败，
 *   绝不静默换用新内容。
 */
export async function resolveDesignSkillContents(
  input: string,
  options: { rootDir?: string } = {}
): Promise<DesignResourceResolution> {
  let parsed: { skillResources?: unknown } | undefined;
  try {
    parsed = JSON.parse(input) as { skillResources?: unknown };
  } catch {
    return { ok: false, code: "IMAGE_REQUEST_INVALID", detail: "设计请求输入不是有效 JSON。" };
  }
  const raw = parsed?.skillResources;
  if (raw === undefined) return { ok: true, contents: [], resources: [] };
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, code: "IMAGE_REQUEST_INVALID", detail: "skillResources 必须是非空数组。" };
  }
  if (raw.length > MAX_DESIGN_RESOURCES) {
    return {
      ok: false,
      code: "IMAGE_REQUEST_INVALID",
      detail: `skillResources 一次最多 ${MAX_DESIGN_RESOURCES} 条。`
    };
  }

  const contents: DesignSkillContent[] = [];
  const resources: { id: string; digest: string }[] = [];
  for (const [index, item] of raw.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return {
        ok: false,
        code: "IMAGE_REQUEST_INVALID",
        detail: `skillResources[${index}] 必须是对象。`
      };
    }
    const entry = item as RawDesignResource;
    const unknownKeys = Object.keys(entry).filter(
      (key) => key !== "id" && key !== "digest" && key !== "windows"
    );
    if (unknownKeys.length > 0) {
      return {
        ok: false,
        code: "IMAGE_REQUEST_INVALID",
        detail: `skillResources[${index}] 只接受 id/digest/windows；未支持字段：${unknownKeys.join("、")}。`
      };
    }
    if (!isSkillId(entry.id)) {
      return {
        ok: false,
        code: "IMAGE_REQUEST_INVALID",
        detail: `skillResources[${index}].id 必须是技能目录名（小写字母/数字/点/横线/下划线）。`
      };
    }
    if (typeof entry.digest !== "string" || !/^[0-9a-f]{64}$/.test(entry.digest)) {
      return {
        ok: false,
        code: "IMAGE_REQUEST_INVALID",
        detail: `skillResources[${index}].digest 必须是 64 位十六进制摘要。`
      };
    }
    if (!Array.isArray(entry.windows) || entry.windows.length === 0) {
      return {
        ok: false,
        code: "IMAGE_REQUEST_INVALID",
        detail: `skillResources[${index}].windows 必须是非空窗口数组。`
      };
    }

    // 主文件（SKILL.md）身份核对：服务端现读，摘要不一致 = 资源已变化。
    const main = await readSkillDoc({ id: entry.id }, options);
    if (!main.ok) {
      if (main.code === "SKILL_STATE_UNREADABLE") {
        return { ok: false, code: "AI_SKILL_STATE_UNREADABLE", detail: main.detail };
      }
      const unavailable = main.code === "SKILL_DISABLED";
      return {
        ok: false,
        code: unavailable ? "AI_SKILL_RESOURCE_UNAVAILABLE" : "IMAGE_REQUEST_INVALID",
        detail: unavailable ? main.detail : `资源 ${entry.id} 不可读：${main.detail}`
      };
    }
    if (main.digest !== entry.digest) {
      return {
        ok: false,
        code: "AI_SKILL_RESOURCE_CHANGED",
        detail: `资源 ${entry.id} 已更新（当前摘要与已读不一致）；请重新读取后再试。`
      };
    }

    // 窗口正文：服务端按同一 (path, offset, limit) 重读并核对文件摘要。
    const sections: string[] = [];
    for (const [wIndex, window] of entry.windows.entries()) {
      if (typeof window !== "object" || window === null || Array.isArray(window)) {
        return {
          ok: false,
          code: "IMAGE_REQUEST_INVALID",
          detail: `skillResources[${index}].windows[${wIndex}] 必须是对象。`
        };
      }
      const w = window as Record<string, unknown>;
      const unknownWindowKeys = Object.keys(w).filter(
        (key) => key !== "path" && key !== "offset" && key !== "limit" && key !== "digest"
      );
      if (unknownWindowKeys.length > 0) {
        return {
          ok: false,
          code: "IMAGE_REQUEST_INVALID",
          detail: `skillResources[${index}].windows[${wIndex}] 只接受 path/offset/limit/digest；未支持字段：${unknownWindowKeys.join("、")}。`
        };
      }
      if (
        typeof w.offset !== "number" ||
        !Number.isInteger(w.offset) ||
        w.offset < 0 ||
        typeof w.limit !== "number" ||
        !Number.isSafeInteger(w.limit) ||
        w.limit < 1
      ) {
        return {
          ok: false,
          code: "IMAGE_REQUEST_INVALID",
          detail: `skillResources[${index}].windows[${wIndex}] 的 offset/limit 非法。`
        };
      }
      if (typeof w.digest !== "string" || !/^[0-9a-f]{64}$/.test(w.digest)) {
        return {
          ok: false,
          code: "IMAGE_REQUEST_INVALID",
          detail: `skillResources[${index}].windows[${wIndex}].digest 必须是 64 位十六进制摘要。`
        };
      }
      const read = await readSkillDoc(
        {
          id: entry.id,
          ...(typeof w.path === "string" ? { path: w.path } : {}),
          offset: w.offset,
          limit: w.limit
        },
        options
      );
      if (!read.ok) {
        if (read.code === "SKILL_STATE_UNREADABLE") {
          return { ok: false, code: "AI_SKILL_STATE_UNREADABLE", detail: read.detail };
        }
        const unavailable = read.code === "SKILL_DISABLED";
        return {
          ok: false,
          code: unavailable ? "AI_SKILL_RESOURCE_UNAVAILABLE" : "IMAGE_REQUEST_INVALID",
          detail: unavailable ? read.detail : `资源 ${entry.id} 的窗口读取失败：${read.detail}`
        };
      }
      if (read.digest !== w.digest) {
        return {
          ok: false,
          code: "AI_SKILL_RESOURCE_CHANGED",
          detail: `资源 ${entry.id} 的 ${read.path} 已更新；请重新读取后再试。`
        };
      }
      sections.push(
        `［${read.path} 第 ${read.offset + 1}-${read.offset + read.text.length}/${read.total} 字］\n${read.text}`
      );
    }

    contents.push({
      id: entry.id,
      name: main.name,
      digest: main.digest,
      text: sections.join("\n\n")
    });
    resources.push({ id: entry.id, digest: main.digest });
  }
  return { ok: true, contents, resources };
}
