/** Platform-free text packages. No filesystem, Next.js, network or model calls. */
import { Document, parseDocument } from "yaml";
import { isAllowedSkillPath, isSkillId } from "@/features/ai/skill-knowledge";
import { isLegacySkillId } from "@/features/ai/skill-settings-contract";

export const SKILL_LIMITS = {
  textBytes: 256 * 1024,
  uploadBytes: 4 * 1024 * 1024,
  totalBytes: 2 * 1024 * 1024,
  skills: 20,
  entries: 200,
  files: 64,
  name: 100,
  description: 200
} as const;

export class SkillInstallError extends Error {
  constructor(
    readonly code:
      "SKILL_INVALID" | "SKILL_LIMIT" | "SKILL_CONFLICT" | "SKILL_UNAVAILABLE" | "SKILL_DOWNLOAD",
    message: string
  ) {
    super(message);
    this.name = "SkillInstallError";
  }
}

export type SkillTextFile = { path: string; content: string };
export type SkillPackage = {
  id: string;
  name: string;
  description: string;
  files: SkillTextFile[];
};
export type SkillImport = { packages: SkillPackage[]; warnings: string[] };
export type SkillConflict = {
  fingerprint: string | null;
  canUpdate: boolean;
  identical: boolean;
  state: "enabled" | "disabled" | "removed";
  removedFiles?: string[];
};
export type SkillPreviewItem = {
  package: SkillPackage;
  source: string;
  conflict?: SkillConflict;
  duplicates: { id: string; name: string }[];
  copyId: string;
};
export type SkillPreview = {
  ok: true;
  revision: string;
  items: SkillPreviewItem[];
  warnings: string[];
};
export type SkillInstallChoice = {
  package: SkillPackage;
  action: "create" | "copy" | "update" | "skip";
  targetId: string;
  expectedFingerprint: string | null;
  source: string;
};

export const utf8Size = (text: string) => new TextEncoder().encode(text).byteLength;
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function assertImportPath(value: string): void {
  if (
    !value ||
    value.length > 512 ||
    value.startsWith("/") ||
    /[\\:\x00-\x1f\x7f]/.test(value) ||
    value
      .replace(/\/$/, "")
      .split("/")
      .some((part) => !part || part === "." || part === "..")
  ) {
    throw new SkillInstallError(
      "SKILL_INVALID",
      "文件路径无效：不能包含绝对路径、路径穿越或特殊控制字符。"
    );
  }
}

/** Licenses are preserved as text, but are not Agent-readable tools or references. */
export function isSkillPackagePath(value: string): boolean {
  return (
    isAllowedSkillPath(value) ||
    /^(?:LICENSE|LICENCE)(?:\.md|\.txt)?$/.test(value) ||
    value === "PROVENANCE.md"
  );
}

export function decodeSkillText(bytes: Uint8Array): string {
  if (bytes.byteLength > SKILL_LIMITS.textBytes)
    throw new SkillInstallError("SKILL_LIMIT", "单个文本文件不能超过 256 KiB。");
  try {
    return checkText(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof SkillInstallError) throw error;
    throw new SkillInstallError("SKILL_INVALID", "文件不是有效的 UTF-8 文本，请转换编码后再导入。");
  }
}

function checkText(value: unknown): string {
  if (typeof value !== "string" || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))
    throw new SkillInstallError("SKILL_INVALID", "文件包含非文本内容或无效控制字符。");
  if (utf8Size(value) > SKILL_LIMITS.textBytes)
    throw new SkillInstallError("SKILL_LIMIT", "单个文本文件不能超过 256 KiB。");
  return value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function frontmatter(content: string): { document: Document; body: string } {
  if (!content.startsWith("---\n")) return { document: new Document({}), body: content };
  const end = /^(?:---|\.\.\.)\s*$/m.exec(content.slice(4));
  if (!end || end.index > 32 * 1024)
    throw new SkillInstallError("SKILL_INVALID", "Skill 元数据缺少结束分隔线，或头部超过 32 KiB。");
  const document = parseDocument(content.slice(4, 4 + end.index), {
    strict: true,
    uniqueKeys: true,
    stringKeys: true
  });
  try {
    if (document.errors.length || document.warnings.length) throw new Error("invalid YAML");
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (!isRecord(value)) throw new Error("not a map");
    for (const field of ["name", "description"] as const) {
      if (value[field] !== undefined && typeof value[field] !== "string")
        throw new Error("not text");
    }
  } catch {
    throw new SkillInstallError(
      "SKILL_INVALID",
      "Skill 元数据不是有效的 YAML：名称和描述须为文本，不支持重复字段、自定义标签或别名。"
    );
  }
  return { document, body: content.slice(4 + end.index + end[0].length).replace(/^\n/, "") };
}

/** Shared with the existing catalog; malformed legacy headers remain metadata-less. */
export function readSkillMetadata(content: string): { name?: string; description?: string } {
  try {
    const { document } = frontmatter(content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"));
    const name: unknown = document.get("name");
    const description: unknown = document.get("description");
    return {
      ...(typeof name === "string" && name.trim() ? { name: name.trim().slice(0, 200) } : {}),
      ...(typeof description === "string" && description.trim()
        ? { description: description.trim().replace(/\s+/g, " ").slice(0, 200) }
        : {})
    };
  } catch {
    return {};
  }
}

function field(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /[\x00-\x1f\x7f]/.test(value) ||
    value.trim().length > max
  )
    throw new SkillInstallError("SKILL_INVALID", `${label}须为 1–${max} 个字符的单行文本。`);
  return value.trim();
}

function plainText(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A deterministic identifier, not a semantic classifier or a security hash. */
export function suggestedSkillId(value: string): string {
  const ascii = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[-._]+$/g, "")
    .slice(0, 64);
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619);
  const id = ascii || `skill-${(hash >>> 0).toString(16).padStart(8, "0")}`;
  return isLegacySkillId(id) ? `${id}-skill` : id;
}

/** Reused for initial imports, client metadata edits, and server commit validation. */
export function normalizeSkillPackage(value: unknown): SkillPackage {
  if (!isRecord(value) || !isSkillId(value.id) || isLegacySkillId(value.id))
    throw new SkillInstallError(
      "SKILL_INVALID",
      "安装标识无效，请使用小写字母、数字、点、横线或下划线（最多 64 字符）。"
    );
  const name = field(value.name, "技能名称", SKILL_LIMITS.name);
  const description = field(value.description, "技能描述", SKILL_LIMITS.description);
  if (!Array.isArray(value.files) || !value.files.length || value.files.length > SKILL_LIMITS.files)
    throw new SkillInstallError("SKILL_INVALID", "Skill 文件列表无效或过多。");
  const paths = new Set<string>();
  const files = value.files.map((raw: unknown): SkillTextFile => {
    if (!isRecord(raw) || typeof raw.path !== "string" || !isSkillPackagePath(raw.path))
      throw new SkillInstallError(
        "SKILL_INVALID",
        "只安装 SKILL.md、references 下的 Markdown 和许可证文本。"
      );
    if (paths.has(raw.path.toLowerCase()))
      throw new SkillInstallError("SKILL_INVALID", "Skill 包含重复文件路径。");
    paths.add(raw.path.toLowerCase());
    return { path: raw.path, content: checkText(raw.content) };
  });
  const main = files.find((file) => file.path === "SKILL.md");
  if (!main) throw new SkillInstallError("SKILL_INVALID", "Skill 缺少主文件 SKILL.md。");
  const { document, body } = frontmatter(main.content);
  if (!body.trim() || /^\s*(?:<!doctype\s+html|<html\b)/i.test(body))
    throw new SkillInstallError("SKILL_INVALID", "Markdown 正文为空，或下载结果是 HTML 页面。");
  document.set("name", name);
  document.set("description", description);
  main.content = `---\n${document.toString({ lineWidth: 0, directives: false, blockQuote: false })}---\n\n${body.trim()}\n`;
  if (utf8Size(main.content) > SKILL_LIMITS.textBytes)
    throw new SkillInstallError("SKILL_LIMIT", "补充元数据后文件超过 256 KiB，请缩短正文。");
  return {
    id: value.id,
    name,
    description,
    files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  };
}

export function validateSkillPackages(values: unknown[]): SkillPackage[] {
  if (!values.length || values.length > SKILL_LIMITS.skills)
    throw new SkillInstallError("SKILL_LIMIT", "一次导入须有 1–20 个技能。");
  const packages = values.map(normalizeSkillPackage);
  if (
    packages.reduce((sum, item) => sum + item.files.length, 0) > SKILL_LIMITS.files ||
    packages.reduce(
      (sum, item) => sum + item.files.reduce((size, file) => size + utf8Size(file.content), 0),
      0
    ) > SKILL_LIMITS.totalBytes
  )
    throw new SkillInstallError(
      "SKILL_LIMIT",
      "一次导入最多 64 个文本文件，正文合计不能超过 2 MiB。"
    );
  return packages;
}

export function prepareMarkdown(
  content: string,
  filename = "粘贴内容.md",
  hintId?: string
): SkillPackage {
  const text = checkText(content);
  const { document, body } = frontmatter(text);
  const metadata = readSkillMetadata(text);
  const heading = /^#{1,6}\s+(.+)$/m.exec(body)?.[1];
  const basename = filename.split("/").at(-1)?.replace(/\.md$/i, "") ?? "新技能";
  const genericFilename = filename === "粘贴内容.md" || basename.toUpperCase() === "SKILL";
  const firstParagraph = body
    .split(/\n\s*\n/)
    .find((part) => part.trim() && !/^\s*(?:#|```|~~~|---|\|)/.test(part));
  const name = (
    metadata.name ||
    (heading && plainText(heading)) ||
    (genericFilename && firstParagraph && plainText(firstParagraph)) ||
    (basename.toUpperCase() === "SKILL" ? "新技能" : basename)
  ).slice(0, SKILL_LIMITS.name);
  const description = (
    metadata.description ||
    (firstParagraph && plainText(firstParagraph)) ||
    "从 Markdown 导入的知识与提示词。"
  ).slice(0, SKILL_LIMITS.description);
  // Keep unknown YAML fields as inert text; they never register tools or permission.
  document.set("name", name);
  document.set("description", description);
  return normalizeSkillPackage({
    id: hintId ?? suggestedSkillId(metadata.name || (genericFilename ? name : basename)),
    name,
    description,
    files: [
      {
        path: "SKILL.md",
        content: `---\n${document.toString({ lineWidth: 0, directives: false })}---\n${body}`
      }
    ]
  });
}

/** ZIP and repository downloads feed the same set of text files into this function. */
export function prepareSkillFiles(files: SkillTextFile[]): SkillImport {
  if (!files.length) throw new SkillInstallError("SKILL_INVALID", "没有找到 Markdown 技能文件。");
  if (files.length > SKILL_LIMITS.entries)
    throw new SkillInstallError("SKILL_LIMIT", "文件条目过多。");
  const seen = new Set<string>();
  for (const file of files) {
    assertImportPath(file.path);
    const key = file.path.normalize("NFC").toLowerCase();
    if (seen.has(key)) throw new SkillInstallError("SKILL_INVALID", "导入内容包含重复文件路径。");
    seen.add(key);
  }
  const mains = files.filter((file) => /(?:^|\/)skill\.md$/i.test(file.path));
  const warnings: string[] = [];
  const used = new Set<string>();
  const packages = (
    mains.length
      ? mains
      : files.filter(
          (file) =>
            /\.md$/i.test(file.path) &&
            !/(?:^|\/)(?:LICENSE|LICENCE|PROVENANCE)\.md$/i.test(file.path)
        )
  ).map((main) => {
    const prefix = main.path.includes("/")
      ? main.path.slice(0, main.path.lastIndexOf("/") + 1)
      : "";
    const directory = prefix.split("/").filter(Boolean).at(-1);
    const item = prepareMarkdown(
      main.content,
      main.path,
      mains.length && directory ? suggestedSkillId(directory) : undefined
    );
    if (mains.length) {
      for (const file of files) {
        if (file === main || !file.path.startsWith(prefix)) continue;
        const relative = file.path.slice(prefix.length);
        if (relative !== "SKILL.md" && isSkillPackagePath(relative)) {
          item.files.push({ path: relative, content: file.content });
          used.add(file.path);
        }
      }
    }
    used.add(main.path);
    return normalizeSkillPackage(item);
  });
  const ids = new Set<string>();
  for (const item of packages) {
    const original = item.id;
    for (let suffix = 2; ids.has(item.id); suffix++) item.id = `${original.slice(0, 59)}-${suffix}`;
    if (item.id !== original) warnings.push(`多个技能使用相同标识，已建议另存为 ${item.id}。`);
    ids.add(item.id);
  }
  const ignored = files.filter((file) => !used.has(file.path));
  if (ignored.length)
    warnings.push(
      `未安装 ${ignored.length} 个附件（只支持主文件、平面 references Markdown 和许可证）；例如：${ignored
        .slice(0, 3)
        .map((file) => file.path)
        .join("、")}。`
    );
  return { packages: validateSkillPackages(packages), warnings };
}

export function parseSkillPreview(value: unknown): SkillPreview {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    typeof value.revision !== "string" ||
    !value.revision ||
    !Array.isArray(value.items) ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every((warning) => typeof warning === "string")
  )
    throw new SkillInstallError("SKILL_UNAVAILABLE", "预览响应不完整，请重试。");
  const packages = validateSkillPackages(
    value.items.map((item: unknown) => (isRecord(item) ? item.package : null))
  );
  const items = value.items.map((raw: unknown, index): SkillPreviewItem => {
    if (
      !isRecord(raw) ||
      typeof raw.source !== "string" ||
      !isSkillId(raw.copyId) ||
      !Array.isArray(raw.duplicates) ||
      !raw.duplicates.every(
        (item) => isRecord(item) && isSkillId(item.id) && typeof item.name === "string"
      )
    )
      throw new SkillInstallError("SKILL_UNAVAILABLE", "预览条目无效，请重试。");
    const conflict = raw.conflict;
    if (
      conflict !== undefined &&
      (!isRecord(conflict) ||
        typeof conflict.canUpdate !== "boolean" ||
        typeof conflict.identical !== "boolean" ||
        !["enabled", "disabled", "removed"].includes(String(conflict.state)) ||
        (conflict.fingerprint !== null &&
          (typeof conflict.fingerprint !== "string" ||
            !/^[0-9a-f]{64}$/.test(conflict.fingerprint))) ||
        (conflict.removedFiles !== undefined &&
          (!Array.isArray(conflict.removedFiles) ||
            !conflict.removedFiles.every((file) => typeof file === "string"))))
    )
      throw new SkillInstallError("SKILL_UNAVAILABLE", "冲突信息无效，请重试。");
    return {
      package: packages[index],
      source: raw.source,
      copyId: raw.copyId,
      duplicates: raw.duplicates as SkillPreviewItem["duplicates"],
      ...(conflict ? { conflict: conflict as SkillConflict } : {})
    };
  });
  return { ok: true, revision: value.revision, items, warnings: value.warnings as string[] };
}

/** B5：URL 导入下载结果（files 为服务端预览解包出的真实文件，ZIP 来源不再伪造字节）。 */
export type SkillUrlDownload = {
  ok: boolean;
  kind: "markdown" | "zip";
  filename: string;
  text?: string;
  bytes?: Uint8Array;
  files?: SkillTextFile[];
  error?: string;
};

/**
 * B5/G6：把 skills/preview 端点（请求体 `{ kind: "url", url }`）的真实响应装配成
 * 本地预览输入。响应形状是 `{ ok, items: [{ package: { files } }] }`——文件在
 * items[].package.files，不在顶层 files；单文件 SKILL.md 走 markdown 形态。
 * 多包（ZIP/仓库含多个 Skill）保留各包身份与目录边界：每个包的文件以其
 * package.id 作目录前缀（prepareSkillFiles 按前缀重组出各包，避免平铺出多个
 * 同名 SKILL.md 后解析失败；前缀即建议 ID，包身份稳定）。失败透传 detail。
 */
export async function skillDownloadFromPreviewResponse(response: Response): Promise<SkillUrlDownload> {
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: string } | null;
    return { ok: false, kind: "markdown", filename: "", error: body?.detail ?? `下载失败（HTTP ${response.status}）` };
  }
  const payload = await response.json().catch(() => null) as
    | { ok?: boolean; detail?: string; items?: Array<{ package?: { id?: unknown; files?: Array<{ path?: unknown; content?: unknown }> } }> }
    | null;
  if (!payload || payload.ok !== true || !Array.isArray(payload.items) || payload.items.length === 0) {
    return { ok: false, kind: "markdown", filename: "", error: payload?.detail ?? "下载内容为空或格式无效。" };
  }
  const packages = payload.items
    .map(item => ({
      id: typeof item.package?.id === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(item.package.id) ? item.package.id : "",
      files: (item.package?.files ?? []).filter((file): file is SkillTextFile =>
        typeof file?.path === "string" && typeof file?.content === "string" && file.path.length > 0)
    }))
    .filter(item => item.files.length > 0);
  if (packages.length === 0) {
    return { ok: false, kind: "markdown", filename: "", error: "下载内容没有可导入的文件。" };
  }
  const singlePackage = packages.length === 1;
  const files = packages.flatMap(item =>
    item.files.map(file => ({ path: singlePackage ? file.path : `${item.id || "skill"}/${file.path}`, content: file.content })));
  const markdownFile = singlePackage ? files.find(file => /(^|\/)SKILL\.md$/i.test(file.path) && file.path === "SKILL.md") : undefined;
  if (markdownFile && files.length === 1) {
    return { ok: true, kind: "markdown", filename: markdownFile.path.split("/").pop() ?? "SKILL.md", text: markdownFile.content };
  }
  return { ok: true, kind: "zip", filename: "skill-package", files };
}
