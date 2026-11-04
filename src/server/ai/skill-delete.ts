/** Permanent deletion shares the settings lock and only accepts removed Skill IDs. */
import { lstatSync, realpathSync, rmSync, type Stats } from "node:fs";
import path from "node:path";
import {
  isManagedSkillId, parseSkillDeleteRequest, parseSkillRemarks, parseSkillStates,
  type SkillDeleteRequest, type SkillDeleteResult
} from "@/features/ai/skill-settings-contract";
import { configLockPath, isGatewayRouteEnabled, withConfigLock } from "./model-config";
import { currentSettingsRevision } from "./model-settings-manager";
import { resolveSettingsPaths, writeSettingsDocument } from "./model-settings-store";
import { skillRoot } from "./skill-paths";
import { SkillSettingsError } from "./skill-settings";
import { scopedEnvForModelConfig } from "./user-scope.ts";

type Directory = { path: string; real: string; stat: Stats };
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const sameDirectory = (a: Directory, b: Directory) => a.real === b.real && a.stat.dev === b.stat.dev && a.stat.ino === b.stat.ino;

function inspectDirectory(directory: string, parent?: Directory): Directory | undefined {
  let stat: Stats;
  try { stat = lstatSync(directory); } catch (error) {
    if (missing(error)) return undefined;
    throw new SkillSettingsError("AI_SKILL_DIR_UNSAFE", "技能目录无法检查，未删除文件。请检查目录权限后重试。");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new SkillSettingsError("AI_SKILL_DIR_UNSAFE", "技能根或目标必须是真实目录，不能是文件或符号链接。");
  let real: string;
  try { real = realpathSync(directory); } catch {
    throw new SkillSettingsError("AI_SKILL_DIR_UNSAFE", "技能目录无法解析，未删除文件。");
  }
  if (parent && (path.dirname(real) !== parent.real || path.basename(real) !== path.basename(directory)))
    throw new SkillSettingsError("AI_SKILL_DIR_UNSAFE", "目标目录不在统一技能目录内，未删除文件。");
  return { path: directory, real, stat };
}

type DeleteOptions = {
  rootDir?: string;
  env?: Record<string, string | undefined>;
  /** Narrow test seams for irreversible I/O failures; normal calls use the real filesystem. */
  remove?: (directory: string) => void;
  saveSettings?: typeof writeSettingsDocument;
};

export async function deleteSkills(input: SkillDeleteRequest, options: DeleteOptions = {}): Promise<SkillDeleteResult> {
  const request = parseSkillDeleteRequest(input);
  if (!request) throw new SkillSettingsError("AI_SKILL_NOT_FOUND", "删除请求无效，请重新选择并确认。");
  const env = (options.env ?? scopedEnvForModelConfig()) as NodeJS.ProcessEnv;
  if (!isGatewayRouteEnabled(env))
    throw new SkillSettingsError("AI_SKILL_STATE_UNREADABLE", "当前部署不允许修改本机设置。");
  const paths = resolveSettingsPaths(env);
  const rootPath = skillRoot(options.rootDir, env).directory;
  const save = options.saveSettings ?? writeSettingsDocument;
  const remove = options.remove ?? (directory => rmSync(directory, { recursive: true }));

  return withConfigLock(configLockPath(paths.document), async () => {
    const current = currentSettingsRevision(env, paths);
    if (current.revision !== request.revision)
      throw new SkillSettingsError("AI_SKILLS_CONFLICT", "设置已在别处修改，请重新读取后再试。");
    const states = parseSkillStates(current.document.skillStates);
    const remarks = parseSkillRemarks(current.document.skillRemarks);
    if (!states || !remarks)
      throw new SkillSettingsError("AI_SKILL_STATE_UNREADABLE", "Skill 状态或备注无法读取，未删除文件。");
    if (request.ids.some(id => states[id] !== "removed"))
      throw new SkillSettingsError("AI_SKILL_NOT_FOUND", "只能彻底删除垃圾箱中的 Skill，请重新读取列表。");

    // Validate the whole batch before writing or deleting anything. Missing directories permit orphan cleanup.
    const root = inspectDirectory(rootPath);
    const targets = request.ids.map(id => ({ id, directory: inspectDirectory(path.join(rootPath, id), root) }));
    const barrier = { ...current.document, revision: current.document.revision + 1 };
    save(barrier, paths); // If this fails, no file is deleted; stale restore/install requests cannot reuse the old revision.

    const result: SkillDeleteResult = { deleted: [], failed: [] };
    for (const target of targets) {
      try {
        const nextRoot = inspectDirectory(rootPath);
        if (nextRoot && (!root || !sameDirectory(root, nextRoot)))
          throw new SkillSettingsError("AI_SKILL_DIR_UNSAFE", "技能根已改变，请重新读取后重试。");
        const next = inspectDirectory(path.join(rootPath, target.id), nextRoot);
        if (next) {
          if (!target.directory || !sameDirectory(target.directory, next))
            throw new SkillSettingsError("AI_SKILL_DIR_UNSAFE", "目标目录已改变，请重新读取后重试。");
          // rm unlinks nested symlinks; it never follows them into another Skill or an external directory.
          remove(next.path);
        }
        result.deleted.push(target.id);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        result.failed.push({ id: target.id, detail: error instanceof SkillSettingsError ? error.message
          : code === "EACCES" || code === "EPERM" ? "没有删除权限，部分文件可能仍在目录内。请检查权限后重试。"
          : "未能完成目录删除，部分文件可能已删除。请重新读取后重试。" });
      }
    }

    if (result.deleted.length) {
      const needsCleanup = result.deleted.some(id => !isManagedSkillId(id) || remarks[id] !== undefined);
      for (const id of result.deleted) {
        // Registered resources default to enabled without a state: preserve their runtime tombstone.
        if (!isManagedSkillId(id)) delete states[id];
        delete remarks[id];
      }
      try {
        if (needsCleanup) {
          save({ ...barrier, revision: barrier.revision + 1, skillStates: states, skillRemarks: remarks }, paths);
        }
      } catch {
        // Irreversible disk success cannot be reported as "nothing was deleted". Orphan entries allow a retry.
        result.cleanupPending = true;
      }
    }
    return result;
  });
}
