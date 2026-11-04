/**
 * 第三方风格 Skill 的**资源加载层**（仅服务端）：读取 vendored 目录、逐文件核对 sha256。
 *
 * 边界（与 `creation-image-skill.ts` 同一套纪律）：
 * - 只读本仓库内的固定目录；**不执行**上游任何脚本、不下载素材、不请求任何 URL；
 * - 文件按 vendor 时的 sha256 固定：任一文件被改动或缺失就拒绝加载（宁可不给上下文，
 *   也不喂入未审校内容）；
 * - 本模块现在只负责**核对与摘要**（设置页要显示真实校验状态）；
 *   把哪些小节注入到哪个任务是下一步的事，届时同样走白名单，不整篇塞进去。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { STYLE_SKILLS, type StyleSkillId } from "@/features/creation/style-skill-rules";
import { skillRoot } from "./skill-paths";
import { scopedEnvForModelConfig } from "./user-scope.ts";

export type StyleSkillUnavailableCode = "STYLE_SKILL_MISSING" | "STYLE_SKILL_CHANGED";

export class StyleSkillUnavailableError extends Error {
  constructor(readonly code: StyleSkillUnavailableCode, detail: string) {
    super(`${code}:${detail}`);
    this.name = "StyleSkillUnavailableError";
  }
}

/** 适配层版本：本节目的注入/清洗逻辑改一次就 +1（设置页会显示）。 */
export const STYLE_SKILL_ADAPTER_VERSION = 1;

type VendoredFile = { readonly relativePath: string; readonly sha256: string };

/** vendor 清单（与各目录 PROVENANCE.md 一一对应；改动上游文件必须同时改这里）。 */
const VENDORED: Record<StyleSkillId, readonly VendoredFile[]> = {
  "gc-minimal-zine-poster": [
    { relativePath: "SKILL.md", sha256: "89c7dc90c9aa80ba020c55e54b7de2fa2b49b49d20c240b150cd79ebea59775d" },
    { relativePath: "LICENSE", sha256: "d15c81ae8fa9a0b4b1db46c66e4490cc92e4898fb1f55e030559fbd2a2e2a232" },
    { relativePath: "references/prompt-compiler.md", sha256: "dbb79043c183051740735f6a604e7db18bf9974a79ea7b9846f638c73fd81784" },
    { relativePath: "references/quality-gate.md", sha256: "642952c568cddb7cecad13d1783d179494b4c839ef3d31e1e5e55bf9d8cedc5e" },
    { relativePath: "references/reference-analysis.md", sha256: "e555d645efed396ec61d8a89d588a014473787becf555645c29c48eea382ad61" },
    { relativePath: "references/style-system.md", sha256: "904890bd4a08c3883ae2d2c7c00c04816eaaba3022891f6cf1d181dc1b401504" },
    { relativePath: "references/variation-engine.md", sha256: "f48d3e0cdf803ed9d931d4bfb278ccf842da29255333c1d0573e98e404d99735" }
  ],
  "gathered-scenes-zine": [
    { relativePath: "SKILL.md", sha256: "7cd307d0a272f71840ffa6146817c5793913d7886340d883c7950f1ac044d028" },
    { relativePath: "LICENSE", sha256: "2fed409745b33e60c3b68f15b12fde872c05496c4f224c0e39adc8979fe0ac3b" }
  ],
  "photo-abstract-editorial": [
    { relativePath: "SKILL.md", sha256: "83818269e300ec307e79eb23ea273646200b181cc638c70a28fdfcb554235f14" },
    { relativePath: "LICENSE.md", sha256: "9b4c0f3e94ceecf22c7a632d794d0e4e4219b89e0c80769568cdac2a16a7d91c" },
    { relativePath: "references/photo-abstract-editorial-prompt.en.md", sha256: "3c1160c2d4491be946c4a4ecb1c3430f68374e096252411008868b0607f3bf49" },
    { relativePath: "references/photo-abstract-editorial-prompt.zh-CN.md", sha256: "a9652d46202e1153490387dc222b0a9b1918aa88706d5d7dd45cb16d599ad051" }
  ]
};

export function styleSkillDirectory(id: StyleSkillId, rootDir = process.cwd(), env: Record<string, string | undefined> = scopedEnvForModelConfig()): string {
  return path.join(skillRoot(rootDir, env).displayPath, STYLE_SKILLS[id].folder);
}

export function styleSkillFileList(id: StyleSkillId, rootDir = process.cwd(), env: Record<string, string | undefined> = scopedEnvForModelConfig()): string[] {
  return VENDORED[id].map((file) => path.join(styleSkillDirectory(id, rootDir, env), file.relativePath));
}

export type LoadedStyleSkill = {
  id: StyleSkillId;
  label: string;
  version: string;
  upstream: string;
  license: string;
  adapterVersion: number;
  /** 核对通过的所有文件内容的合并摘要（改动任一个文件都会变）。 */
  digest: string;
  files: { relativePath: string; text: string }[];
};

/**
 * 读取并核对一个风格 Skill。
 * 文件缺失 → `STYLE_SKILL_MISSING`；内容与登记不一致 → `STYLE_SKILL_CHANGED`。
 */
export function loadStyleSkill(id: StyleSkillId, rootDir = process.cwd(), env: Record<string, string | undefined> = scopedEnvForModelConfig()): LoadedStyleSkill {
  const meta = STYLE_SKILLS[id];
  const root = path.join(skillRoot(rootDir, env).directory, meta.folder);
  const hash = createHash("sha256");
  const files: { relativePath: string; text: string }[] = [];
  for (const file of VENDORED[id]) {
    let raw: Buffer;
    try {
      raw = readFileSync(path.join(root, file.relativePath));
    } catch {
      throw new StyleSkillUnavailableError("STYLE_SKILL_MISSING", `${id} 的 ${file.relativePath} 无法读取。`);
    }
    const actual = createHash("sha256").update(raw).digest("hex");
    if (actual !== file.sha256) {
      throw new StyleSkillUnavailableError("STYLE_SKILL_CHANGED", `${id} 的 ${file.relativePath} 与登记内容不一致。`);
    }
    hash.update(file.relativePath).update(raw);
    files.push({ relativePath: file.relativePath, text: raw.toString("utf8") });
  }
  return {
    id,
    label: meta.label,
    version: meta.version,
    upstream: meta.upstream,
    license: meta.license,
    adapterVersion: STYLE_SKILL_ADAPTER_VERSION,
    digest: hash.digest("hex").slice(0, 16),
    files
  };
}

/** 设置页要显示的校验状态：不通过时不编摘要。 */
export function styleSkillVerification(id: StyleSkillId, rootDir = process.cwd(), env: Record<string, string | undefined> = scopedEnvForModelConfig()):
  { adapterVersion: number; digest: string; status: "ok" | "missing" | "changed" } {
  try {
    const bundle = loadStyleSkill(id, rootDir, env);
    return { adapterVersion: bundle.adapterVersion, digest: bundle.digest, status: "ok" };
  } catch (error) {
    return {
      adapterVersion: STYLE_SKILL_ADAPTER_VERSION,
      digest: "",
      status: error instanceof StyleSkillUnavailableError && error.code === "STYLE_SKILL_CHANGED" ? "changed" : "missing"
    };
  }
}
