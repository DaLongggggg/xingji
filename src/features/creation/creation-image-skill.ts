/**
 * 图片 Skill 的**资源加载层**（仅服务端）：读取 vendored 上游 Skill、核对固定哈希、按小节提取。
 *
 * 边界：
 * - 只读本仓库内的固定资源目录，**不执行**上游任何脚本、不启动服务、不请求任何 URL；
 * - 上游资源按**固定 commit** vendor 进来，逐文件核对 PROVENANCE.md 记录的 sha256，
 *   任一文件被改动就拒绝加载（宁可不给上下文，也不喂入未审校内容）；
 * - 只提取白名单小节，其余章节（含上游作者品牌 SOP、codex/ChatGPT/API 执行层）不进入上下文；
 * - 提取后经**项目适配层**清洗：上游作者专属的行（作者品牌、本地路径、平台运营话术）整行丢弃，
 *   其余正文逐字保留；vendored 文件本身不改，sha256 始终可核对。
 *
 * 纯规则（`IMAGE_SKILL_*` 常量、`IMAGE_PROMPT_LIMITS`、`checkImagePromptDraft`）在
 * `creation-image-rules.ts`（可安全进浏览器 bundle），这里重新导出，服务端一处引用即可。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { bundledSkillEnv, skillRoot } from "@/server/ai/skill-paths";
import {
  IMAGE_SKILL_ADAPTER_VERSION,
  IMAGE_SKILL_ID,
  IMAGE_SKILL_VERSION
} from "./creation-image-rules";

export * from "./creation-image-rules";

/** 本项目对上游内容的唯一立场声明，必须逐字出现在 `promptContext` 里。 */
const PROJECT_BOUNDARY =
  "本项目只在服务端用本文件生成/审校图像提示；不执行上游脚本、不启动任何服务、不请求任何 URL；上游关于模型能力的描述仅作上游说明。";

type VendoredFile = { readonly relativePath: string; readonly sha256: string };
type VendoredSection = { readonly source: string; readonly heading: string };

/** vendor 清单：路径 → 上游 commit 下的 sha256（与 PROVENANCE.md 一一对应）。 */
const VENDORED_FILES: readonly VendoredFile[] = [
  {
    relativePath: "SKILL.md",
    sha256: "7c437ec7484c18720839e220de5627b20f7587ccca5fd0b294203765d34b6a8d"
  },
  {
    relativePath: "LICENSE",
    sha256: "97f9cdcf88dc1e4d59db8b93066f5dfa142fddeabef911dbe10909eb1eeeade5"
  },
  {
    relativePath: "references/capabilities.md",
    sha256: "2a7da33815c58889edb01a184369e47a70b66812ed77cf01db6110e6a1b76c43"
  },
  {
    relativePath: "references/prompt-patterns.md",
    sha256: "8ccecb31250cd8611abbbf937c651039415ff0f843513f015303325545b517e6"
  }
];

/** 白名单小节（顺序即 `promptContext` 顺序，固定不变）。 */
const VENDORED_SECTIONS: readonly VendoredSection[] = [
  { source: "SKILL.md", heading: "## ⛔ 写 prompt 之前先看：行为硬约束（不可违反）" },
  {
    source: "SKILL.md",
    heading: "## 🛟 失败模式与 fallback 树（写 prompt 前过一遍，出图后对症查）"
  },
  { source: "SKILL.md", heading: "## GPT-image-2 能力速览（必读）" },
  {
    source: "references/capabilities.md",
    heading: "## 画布比例支持（来自 OpenAI 官方 cookbook）"
  },
  { source: "references/capabilities.md", heading: "## 已知失败模式" },
  {
    source: "references/prompt-patterns.md",
    heading: "## 模板 7：single_illustration（单张插画）"
  },
  { source: "references/prompt-patterns.md", heading: "## 模板填空指南" },
  {
    source: "references/prompt-patterns.md",
    heading: "## 词汇选择心法（2026-04-22 sprite sheet 实测沉淀）"
  }
];

export type ImageSkillExcerpt = { source: string; heading: string; text: string };

export type ImageSkillBundle = {
  id: string;
  version: string;
  adapterVersion: number;
  excerpts: ImageSkillExcerpt[];
  /** 由 excerpts 合成、可重复构建（同版本 => 同字符串）。 */
  promptContext: string;
  /** `promptContext` 的 sha256（十六进制）。 */
  digest: string;
};

export class ImageSkillUnavailableError extends Error {
  constructor(
    readonly code:
      | "IMAGE_SKILL_RESOURCE_MISSING"
      | "IMAGE_SKILL_RESOURCE_CHANGED"
      | "IMAGE_SKILL_SECTION_MISSING",
    detail: string
  ) {
    super(detail);
    this.name = "ImageSkillUnavailableError";
  }
}

/** 去掉小节正文末尾的空行（行内空白与正文一律保留）。 */
function trimTrailingBlankLines(lines: string[]): string {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(0, end).join("\n");
}

/**
 * 项目适配层的丢弃标记：命中任一标记的**整行**不进入上下文。
 *
 * 分三类：上游作者品牌与个人路径（`花叔`、`~/Documents/写作`、`配图/品牌资产`、`配图库`）、
 * 平台运营话术（`公众号`、`小红书`、`B站`）、上游**执行层**（codex/ChatGPT/API 脚本、CLI、
 * 本地桥、私有凭据、图片后处理工具）——本项目的图片执行走自己的服务端协议，提示里不该出现
 * 上游脚本/CLI/桥的调用方式。
 */
const ADAPTATION_DROP_MARKERS = [
  "花叔",
  "~/Documents/写作",
  // `配图/` 覆盖上游作者个人配图目录下的全部路径（品牌资产、封面方法论…），
  // 只写具体文件名会漏掉后续新增的路径（实测漏过 `配图/封面方法论.md`）。
  "配图/",
  "配图库",
  "公众号",
  "小红书",
  "B站",
  "gen_via_codex",
  "gen_via_chatgpt_web",
  "image_gen.py",
  "extract_grid",
  "chroma_key",
  "contact_sheet",
  "chatgpt-web-bridge",
  "~/.codex",
  "codex exec",
  "Lovart",
  "OPENAI_API_KEY",
  "--ref",
  "sips",
  "magick"
] as const;

/** 发生丢弃时追加的固定说明（同时是「本小节被适配过」的可见凭据）。 */
function adaptationNote(droppedLines: number): string {
  return `（项目适配说明：本节省略了 ${droppedLines} 行上游作者专属的品牌素材与本地路径说明，方法论部分保留。）`;
}

/**
 * 项目适配层清洗（纯函数）：把上游作者专属的整行丢弃，其余行**逐字**保留
 * （不改写、不重排、不翻译）；丢弃 n>0 行时在末尾追加固定说明，n 写进说明里可见。
 *
 * 这是**读取后的适配**，不动 vendored 文件本身：`SKILL.md` 等的 sha256 仍与 PROVENANCE.md 一致。
 */
function sanitizeExcerpt(text: string): string {
  const keptLines: string[] = [];
  let droppedLines = 0;

  for (const line of text.split("\n")) {
    if (ADAPTATION_DROP_MARKERS.some((marker) => line.includes(marker))) {
      droppedLines += 1;
      continue;
    }
    keptLines.push(line);
  }

  if (droppedLines === 0) return keptLines.join("\n");
  return [keptLines.join("\n"), adaptationNote(droppedLines)].filter(Boolean).join("\n");
}

/**
 * 按 `## ` 标题行切片：一个小节从标题行到下一个 `## ` 或 EOF；
 * `###` / `####` 是正文的一部分，不切分。
 */
function splitSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  let heading: string | null = null;
  let body: string[] = [];

  const flush = () => {
    if (heading !== null) sections.set(heading, trimTrailingBlankLines(body));
  };

  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      flush();
      heading = line.trimEnd();
      body = [];
      continue;
    }
    if (heading !== null) body.push(line);
  }
  flush();
  return sections;
}

/**
 * 同步、只读磁盘；逐文件核对 PROVENANCE 记录的 sha256；按小节提取。
 *
 * @throws ImageSkillUnavailableError 资源缺失 / 被改动 / 小节缺失。
 */
export function loadImageSkill(options: { rootDir?: string; env?: Record<string, string | undefined> } = {}): ImageSkillBundle {
  // T2a：bundled 只读资源按部署级根解析（用户 scope 的 skills 目录不影响它）。
  const rootDir = options.rootDir ?? path.join(skillRoot(process.cwd(), options.env ?? bundledSkillEnv()).directory, IMAGE_SKILL_ID);

  const sectionsBySource = new Map<string, Map<string, string>>();
  for (const file of VENDORED_FILES) {
    let content: Buffer;
    try {
      content = readFileSync(path.join(rootDir, file.relativePath));
    } catch {
      throw new ImageSkillUnavailableError(
        "IMAGE_SKILL_RESOURCE_MISSING",
        `vendored 资源缺失：${file.relativePath}。`
      );
    }

    const actual = createHash("sha256").update(content).digest("hex");
    if (actual !== file.sha256) {
      throw new ImageSkillUnavailableError(
        "IMAGE_SKILL_RESOURCE_CHANGED",
        `vendored 资源已被修改：${file.relativePath} 的 sha256 是 ${actual}，PROVENANCE.md 记录的是 ${file.sha256}；加载器拒绝运行。`
      );
    }

    sectionsBySource.set(file.relativePath, splitSections(content.toString("utf8")));
  }

  const excerpts: ImageSkillExcerpt[] = VENDORED_SECTIONS.map((section) => {
    const text = sectionsBySource.get(section.source)?.get(section.heading);
    if (text === undefined) {
      throw new ImageSkillUnavailableError(
        "IMAGE_SKILL_SECTION_MISSING",
        `vendored 资源缺少小节：${section.source} → ${section.heading}。`
      );
    }
    return { source: section.source, heading: section.heading, text: sanitizeExcerpt(text) };
  });

  const blocks = excerpts.map(
    (excerpt) => `来源: ${excerpt.source} · 小节: ${excerpt.heading}\n${excerpt.text}`
  );
  const promptContext = `${blocks.join("\n\n")}\n\n${PROJECT_BOUNDARY}`;

  return {
    id: IMAGE_SKILL_ID,
    version: IMAGE_SKILL_VERSION,
    adapterVersion: IMAGE_SKILL_ADAPTER_VERSION,
    excerpts,
    promptContext,
    digest: createHash("sha256").update(promptContext, "utf8").digest("hex")
  };
}

let cachedBundle: { directory: string; bundle: ImageSkillBundle } | undefined;

/** 进程内记忆化；技能根变化时重新加载，不能跨根沿用缓存。 */
export function getImageSkill(): ImageSkillBundle {
  // bundled 资源按部署级根解析，不随请求级用户 scope 变化。
  const directory = path.join(skillRoot(process.cwd(), bundledSkillEnv()).directory, IMAGE_SKILL_ID);
  if (cachedBundle?.directory !== directory)
    cachedBundle = { directory, bundle: loadImageSkill({ rootDir: directory }) };
  return cachedBundle.bundle;
}
