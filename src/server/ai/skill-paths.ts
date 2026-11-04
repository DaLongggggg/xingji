/** One Skill root for discovery, installation, verification and folder access. */
import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { isSkillId } from "@/features/ai/skill-knowledge";
import { currentScopeEnv } from "./user-scope.ts";
import { IMAGE_SKILL_ID } from "@/features/creation/creation-image-rules";
import { STYLE_SKILL_IDS } from "@/features/creation/style-skill-rules";

/**
 * 该 id 是否是部署级 bundled 只读资源（图片提示资源与 vendored 风格资源）。
 * T2a：bundled 与用户安装的 Skill 不混为同一来源——bundled 的路径解析始终用
 * 部署级进程环境，不吸收用户 scope 的 XINGJI_SKILLS_DIR。
 */
export function isBundledSkillId(id: string): boolean {
  return id === IMAGE_SKILL_ID || (STYLE_SKILL_IDS as readonly string[]).includes(id);
}

/** bundled 资源的路径解析 env：部署级进程环境（测试经 vi.stubEnv 注入同一处）。 */
export function bundledSkillEnv(): Record<string, string | undefined> {
  return process.env;
}

export type SkillRoot = { directory: string; displayPath: string };

/** A crashed batch must be recovered in the local manager before any partial methods are used. */
export function assertSkillInstallReadable(rootDir = process.cwd(), env: Record<string, string | undefined> = currentScopeEnv()) {
  let entries: string[];
  try {
    entries = readdirSync(skillRoot(rootDir, env).directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Skill 目录无法读取。");
  }
  if (entries.some((name) => name.startsWith(".install-")))
    throw new Error("Skill 安装尚待恢复，请在本机重新打开技能管理。");
}

export function skillRoot(
  rootDir = process.cwd(),
  env: Record<string, string | undefined> = currentScopeEnv()
): SkillRoot {
  const directory = path.resolve(env.XINGJI_SKILLS_DIR || path.join(rootDir, ".local", "skills"));
  const relative = path.relative(rootDir, directory);
  return {
    directory,
    displayPath: relative.startsWith("..") || path.isAbsolute(relative)
      ? "技能目录"
      : relative.split(path.sep).join("/") || "."
  };
}

export function findSkillLocation(
  id: string,
  rootDir = process.cwd(),
  env: Record<string, string | undefined> = currentScopeEnv()
): { root: SkillRoot; directory: string } | undefined {
  if (!isSkillId(id)) return undefined;
  const root = skillRoot(rootDir, env);
  const directory = path.join(root.directory, id);
  try {
    lstatSync(directory);
    return { root, directory };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
