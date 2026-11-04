/** One preview/commit path for every source, reusing discovery, settings and its write lock. */
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import manifest from "@/data/skill-market/manifest.json";
import {
  isRecord,
  isSkillPackagePath,
  prepareMarkdown,
  SKILL_LIMITS,
  SkillInstallError,
  utf8Size,
  validateSkillPackages,
  type SkillImport,
  type SkillInstallChoice,
  type SkillPackage,
  type SkillPreview
} from "@/features/skills/skill-package";
import { parseSkillMarket } from "@/features/skills/skill-market";
import {
  isLegacySkillId,
  isSkillId,
  MANAGED_SKILL_IDS,
  parseSkillStates,
  type SkillStateMap
} from "@/features/ai/skill-settings-contract";
import { scanSkillCatalogSync } from "./skill-catalog";
import { findSkillLocation, skillRoot } from "./skill-paths";
import { readSkillSettings } from "./skill-settings";
import { configLockPath, isGatewayRouteEnabled, withConfigLock } from "./model-config";
import { currentSettingsRevision } from "./model-settings-manager";
import { resolveSettingsPaths } from "./model-settings-store";
import { scopedEnvForModelConfig } from "./user-scope.ts";

const INSTALL_RECORD = ".xingji-install.json";
type Options = { rootDir?: string; env?: Record<string, string | undefined> };
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const fileIdentity = (files: SkillPackage["files"]) =>
  digest(
    JSON.stringify([...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))
  );

export function readSkillMarket() {
  return parseSkillMarket(manifest);
}
export function marketSkillImport(id: string): SkillImport {
  const entry = readSkillMarket().find((item) => item.id === id);
  if (!entry) throw new SkillInstallError("SKILL_INVALID", "市场中没有这个技能，请刷新列表。");
  const item = prepareMarkdown(entry.markdown, `${id}.md`, id);
  return {
    // Directory titles describe discovery; the imported document keeps its original metadata.
    packages: [item],
    warnings: []
  };
}

export function assertSkillInstallWritable(): void {
  if (!isGatewayRouteEnabled())
    throw new SkillInstallError("SKILL_UNAVAILABLE", "当前部署不允许安装或更新 Skill。");
}

type Snapshot = {
  exists: boolean;
  fingerprint: string | null;
  canUpdate: boolean;
  files?: SkillPackage["files"];
};

/** No link is followed and no unknown files are removed by an update. */
function snapshot(id: string, options: Options): Snapshot {
  const location = findSkillLocation(id, options.rootDir, options.env);
  if (!location) return { exists: false, fingerprint: null, canUpdate: false };
  const unavailable: Snapshot = { exists: true, fingerprint: null, canUpdate: false };
  if ((MANAGED_SKILL_IDS as readonly string[]).includes(id))
    return unavailable;
  const root = realpathSync(location.root.directory);
  if (
    lstatSync(location.root.directory).isSymbolicLink() ||
    !lstatSync(location.directory).isDirectory() ||
    realpathSync(location.directory) !== path.join(root, id)
  )
    return unavailable;
  return snapshotDirectory(location.directory, id);
}

function snapshotDirectory(directory: string, id: string): Snapshot {
  const unavailable: Snapshot = { exists: true, fingerprint: null, canUpdate: false };
  try { if (!lstatSync(directory).isDirectory()) return unavailable; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { exists: false, fingerprint: null, canUpdate: false };
    throw error;
  }
  const files: SkillPackage["files"] = [];
  let record = "",
    bytes = 0;
  function visit(directory: string, prefix = ""): boolean {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (relative !== "references" || !visit(absolute, "references/")) return false;
        continue;
      }
      if (!entry.isFile() || (relative !== INSTALL_RECORD && !isSkillPackagePath(relative)))
        return false;
      const size = lstatSync(absolute).size;
      if (size > (relative === INSTALL_RECORD ? 8192 : SKILL_LIMITS.textBytes)) return false;
      bytes += size;
      if (bytes > SKILL_LIMITS.totalBytes || files.length >= SKILL_LIMITS.files) return false;
      const content = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(absolute));
      if (relative === INSTALL_RECORD) record = content;
      else files.push({ path: relative, content });
    }
    return true;
  }
  try {
    if (!visit(directory) || !files.some((file) => file.path === "SKILL.md"))
      return unavailable;
    const metadata: unknown = JSON.parse(record);
    if (!isRecord(metadata) || metadata.format !== 1 || metadata.id !== id) return unavailable;
  } catch {
    return unavailable;
  }
  return {
    exists: true,
    canUpdate: true,
    files,
    fingerprint: digest(`${fileIdentity(files)}\n${record}`)
  };
}

type InstallJournal = {
  format: 1;
  committed: boolean;
  entries: { id: string; before: string | null; after: string }[];
};
const JOURNAL = "transaction.json";

function writeJournal(stage: string, journal: InstallJournal) {
  const temporary = path.join(stage, `${JOURNAL}.tmp`);
  writeFileSync(temporary, JSON.stringify(journal), { mode: 0o600, flush: true });
  renameSync(temporary, path.join(stage, JOURNAL));
}

function pendingInstalls(root: string): string[] {
  try { return readdirSync(root).filter((name) => name.startsWith(".install-")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Under the existing settings lock: validate the whole batch before touching any target. */
function recoverInstallStage(root: string, stage: string) {
  const fail = () => new SkillInstallError("SKILL_UNAVAILABLE", "安装恢复无法核对文件，已保留原件与 .install- 恢复目录；请检查后重试。");
  if (lstatSync(stage).isSymbolicLink() || realpathSync(stage) !== stage) throw fail();
  const journalPath = path.join(stage, JOURNAL);
  const stat = lstatSync(journalPath);
  if (!stat.isFile() || stat.size > 16_384) throw fail();
  const value: unknown = JSON.parse(readFileSync(journalPath, "utf8"));
  const fingerprint = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  if (!isRecord(value) || value.format !== 1 || typeof value.committed !== "boolean" ||
    !Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > SKILL_LIMITS.skills ||
    !value.entries.every((entry) => isRecord(entry) && isSkillId(entry.id) && !isLegacySkillId(entry.id) &&
      !(MANAGED_SKILL_IDS as readonly string[]).includes(entry.id) &&
      (entry.before === null || fingerprint(entry.before)) && fingerprint(entry.after))) throw fail();
  const journal = value as InstallJournal;
  if (new Set(journal.entries.map((entry) => entry.id)).size !== journal.entries.length) throw fail();
  const allowed = new Set([JOURNAL, `${JOURNAL}.tmp`, ...journal.entries.flatMap((_, i) => [`next-${i}`, `previous-${i}`])]);
  if (readdirSync(stage).some((name) => !allowed.has(name))) throw fail();
  const plan = journal.entries.map((entry, index) => {
    const target = path.join(root, entry.id);
    const previous = path.join(stage, `previous-${index}`);
    const current = snapshotDirectory(target, entry.id);
    const old = snapshotDirectory(previous, entry.id);
    if (old.exists && (entry.before === null || old.fingerprint !== entry.before)) throw fail();
    if (journal.committed) {
      if (current.fingerprint !== entry.after) throw fail();
    } else if (entry.before === null) {
      if (current.exists && current.fingerprint !== entry.after) throw fail();
    } else if (old.exists) {
      if (current.exists && current.fingerprint !== entry.after) throw fail();
    } else if (current.fingerprint !== entry.before) throw fail();
    return { target, previous, current, old, entry };
  });
  if (!journal.committed) {
    for (const item of plan.reverse()) {
      if (item.current.exists && (item.old.exists || item.entry.before === null))
        rmSync(item.target, { recursive: true });
      if (item.old.exists) renameSync(item.previous, item.target);
    }
  }
  rmSync(stage, { recursive: true });
}

function recoverPendingInstalls(root: string) {
  const stages = pendingInstalls(root);
  if (!stages.length) return;
  if (lstatSync(root).isSymbolicLink() || stages.length > 100)
    throw new SkillInstallError("SKILL_UNAVAILABLE", "安装恢复目录异常，已停止改动。");
  const realRoot = realpathSync(root);
  for (const name of stages) {
    try { recoverInstallStage(realRoot, path.join(realRoot, name)); }
    catch {
      throw new SkillInstallError("SKILL_UNAVAILABLE", "安装恢复未完成，已保留原件与 .install- 恢复目录；请检查后重试。");
    }
  }
}

/** Recovery is local and bounded; a clean read never creates a directory or settings file. */
export async function recoverSkillInstallations(options: Options = {}) {
  const env = options.env ?? scopedEnvForModelConfig();
  const root = skillRoot(options.rootDir, env).directory;
  if (!pendingInstalls(root).length || !isGatewayRouteEnabled()) return;
  const paths = resolveSettingsPaths(env);
  await withConfigLock(configLockPath(paths.document), async () => recoverPendingInstalls(root));
}

export function previewSkillImport(
  imported: SkillImport,
  source: string,
  options: Options = {}
): SkillPreview {
  assertSkillInstallWritable();
  const env = options.env ?? scopedEnvForModelConfig();
  const rootDir = options.rootDir ?? process.cwd();
  const view = readSkillSettings(env, rootDir);
  if (!view.writable || !view.revision)
    throw new SkillInstallError("SKILL_UNAVAILABLE", "Skill 设置不可写，请重新读取设置。");
  const states = parseSkillStates(currentSettingsRevision(env).document.skillStates);
  if (!states) throw new SkillInstallError("SKILL_UNAVAILABLE", "Skill 状态无法确认，未开始安装。");
  const packages = validateSkillPackages(imported.packages);
  const catalog = scanSkillCatalogSync(rootDir, states, env);
  const occupied = new Set([
    ...catalog.map((entry) => entry.id),
    ...Object.keys(states),
    ...packages.map((item) => item.id),
    ...MANAGED_SKILL_IDS
  ]);
  try {
    for (const entry of readdirSync(skillRoot(rootDir, env).directory)) occupied.add(entry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    ok: true,
    revision: view.revision,
    warnings: imported.warnings,
    items: packages.map((item) => {
      const current = snapshot(item.id, { rootDir, env });
      let copyId = `${item.id.slice(0, 59)}-2`;
      for (let suffix = 3; occupied.has(copyId); suffix++)
        copyId = `${item.id.slice(0, 59)}-${suffix}`;
      occupied.add(copyId);
      const mainDigest = digest(item.files.find((file) => file.path === "SKILL.md")!.content);
      return {
        package: item,
        source,
        copyId,
        ...(current.exists ||
        Object.hasOwn(states, item.id) ||
        (MANAGED_SKILL_IDS as readonly string[]).includes(item.id)
          ? {
              conflict: {
                fingerprint: current.fingerprint,
                canUpdate: current.canUpdate,
                identical: current.files
                  ? fileIdentity(current.files) === fileIdentity(item.files)
                  : catalog.find((entry) => entry.id === item.id)?.digest === mainDigest,
                state: states[item.id] ?? "enabled",
                removedFiles:
                  current.files
                    ?.filter((file) => !item.files.some((next) => next.path === file.path))
                    .map((file) => file.path) ?? []
              }
            }
          : {}),
        duplicates: catalog
          .filter(
            (entry) =>
              entry.id !== item.id && (entry.name === item.name || entry.digest === mainDigest)
          )
          .map((entry) => ({ id: entry.id, name: entry.name }))
      };
    })
  };
}

function parseChoices(value: unknown): { revision: string; choices: SkillInstallChoice[] } {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "revision" && key !== "choices") ||
    typeof value.revision !== "string" ||
    !value.revision.trim() ||
    value.revision.length > 256 ||
    !Array.isArray(value.choices)
  )
    throw new SkillInstallError("SKILL_INVALID", "安装请求无效，请重新预览。");
  const packages = validateSkillPackages(
    value.choices.map((choice: unknown) => (isRecord(choice) ? choice.package : null))
  );
  const choices = value.choices.map((raw: unknown, index): SkillInstallChoice => {
    if (
      !isRecord(raw) ||
      !["create", "copy", "update", "skip"].includes(String(raw.action)) ||
      !isSkillId(raw.targetId) ||
      isLegacySkillId(raw.targetId) ||
      (raw.expectedFingerprint !== null &&
        (typeof raw.expectedFingerprint !== "string" ||
          !/^[0-9a-f]{64}$/.test(raw.expectedFingerprint))) ||
      typeof raw.source !== "string" ||
      !raw.source.trim() ||
      /[\x00-\x1f\x7f]/.test(raw.source) ||
      utf8Size(raw.source) > 2048
    )
      throw new SkillInstallError("SKILL_INVALID", "安装动作或目标标识无效，请重新预览。");
    return {
      package: packages[index],
      action: raw.action as SkillInstallChoice["action"],
      targetId: raw.targetId,
      expectedFingerprint: raw.expectedFingerprint as string | null,
      source: raw.source
    };
  });
  return { revision: value.revision, choices };
}

export async function installSkillChoices(
  value: unknown,
  options: Options & { rename?: typeof renameSync } = {}
) {
  assertSkillInstallWritable();
  const { revision, choices } = parseChoices(value);
  const env = options.env ?? scopedEnvForModelConfig(),
    rootDir = options.rootDir ?? process.cwd();
  const paths = resolveSettingsPaths(env);
  const installed = skillRoot(rootDir, env);
  const rename = options.rename ?? renameSync;
  const results = await withConfigLock(configLockPath(paths.document), async () => {
    recoverPendingInstalls(installed.directory);
    const current = currentSettingsRevision(env, paths);
    if (current.revision !== revision)
      throw new SkillInstallError("SKILL_CONFLICT", "设置已在别处修改，请重新读取并预览后再安装。");
    const states: SkillStateMap | undefined = parseSkillStates(current.document.skillStates);
    if (!states) throw new SkillInstallError("SKILL_UNAVAILABLE", "Skill 状态无效，未做改动。");
    const targets = new Set<string>();
    const plan = choices.filter((choice) => choice.action !== "skip");
    // All conflicts are checked before creating any staged files or changing existing ones.
    for (const choice of plan) {
      if (targets.has(choice.targetId))
        throw new SkillInstallError("SKILL_CONFLICT", "同一批次不能安装到重复标识，请另存副本。");
      targets.add(choice.targetId);
      const existing = snapshot(choice.targetId, { rootDir, env });
      if (choice.action === "update") {
        if (
          choice.targetId !== choice.package.id ||
          !existing.canUpdate ||
          !existing.fingerprint ||
          existing.fingerprint !== choice.expectedFingerprint
        )
          throw new SkillInstallError(
            "SKILL_CONFLICT",
            "原技能已变化或不能覆盖，请重新预览或另存副本。"
          );
      } else if (
        existing.exists ||
        choice.expectedFingerprint !== null ||
        (MANAGED_SKILL_IDS as readonly string[]).includes(choice.targetId) ||
        (choice.action === "create" && choice.targetId !== choice.package.id) ||
        (choice.action === "copy" && choice.targetId === choice.package.id)
      ) {
        throw new SkillInstallError(
          "SKILL_CONFLICT",
          "目标标识已存在或预览已失效，请重新预览或另存副本。"
        );
      }
    }
    if (plan.length) {
      mkdirSync(installed.directory, { recursive: true, mode: 0o700 });
      if (lstatSync(installed.directory).isSymbolicLink())
        throw new SkillInstallError("SKILL_UNAVAILABLE", "安装目录不能是符号链接。");
      const realRoot = realpathSync(installed.directory);
      const stage = mkdtempSync(path.join(realRoot, ".install-"));
      const journal: InstallJournal = { format: 1, committed: false, entries: plan.map((choice) => ({
        id: choice.targetId,
        before: choice.action === "update" ? choice.expectedFingerprint : null,
        after: digest(`${fileIdentity(choice.package.files)}\n${JSON.stringify({ format: 1, id: choice.targetId, source: choice.source })}`)
      })) };
      let preserveRecovery = false;
      try {
        writeJournal(stage, journal);
        for (const [index, choice] of plan.entries()) {
          const next = path.join(stage, `next-${index}`);
          mkdirSync(next, { mode: 0o700 });
          for (const file of choice.package.files) {
            const target = path.join(next, file.path);
            mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
            writeFileSync(target, file.content, { flag: "wx", mode: 0o600 });
          }
          writeFileSync(
            path.join(next, INSTALL_RECORD),
            JSON.stringify({ format: 1, id: choice.targetId, source: choice.source }),
            { flag: "wx", mode: 0o600 }
          );
        }
        // Keep swaps synchronous so the shared synchronous catalog never scans a partial batch in this process.
        for (const choice of plan) {
          const latest = snapshot(choice.targetId, { rootDir, env });
          if (
            choice.action === "update"
              ? latest.fingerprint !== choice.expectedFingerprint
              : latest.exists
          )
            throw new SkillInstallError(
              "SKILL_CONFLICT",
              "原技能在准备期间发生变化，未覆盖；请重新预览。"
            );
        }
        for (const [index, choice] of plan.entries()) {
          const target = path.join(realRoot, choice.targetId);
          if (choice.action === "update") {
            rename(target, path.join(stage, `previous-${index}`));
          }
          rename(path.join(stage, `next-${index}`), target);
          const saved = snapshot(choice.targetId, { rootDir, env });
          if (!saved.files || fileIdentity(saved.files) !== fileIdentity(choice.package.files))
            throw new Error("save verification failed");
        }
        writeJournal(stage, { ...journal, committed: true });
      } catch (error) {
        try { recoverInstallStage(realRoot, stage); }
        catch { preserveRecovery = true; }
        if (preserveRecovery)
          throw new SkillInstallError(
            "SKILL_UNAVAILABLE",
            "安装失败，原文件保留在安装目录的 .install- 暂存区；请先检查恢复文件，再重新安装。"
          );
        if (error instanceof SkillInstallError) throw error;
        throw new SkillInstallError(
          "SKILL_UNAVAILABLE",
          "安装未完成，已回退本批改动；请检查安装目录是否可写并重新预览。"
        );
      } finally {
        // Never remove an old copy if rollback itself failed.
        if (!preserveRecovery) {
          try {
            rmSync(stage, { recursive: true });
          } catch {
            /* Hidden staging is ignored by discovery. */
          }
        }
      }
    }
    return choices.map((choice) => ({
      id: choice.targetId,
      action:
        choice.action === "skip" ? "skipped" : choice.action === "update" ? "updated" : "installed",
      state: states[choice.targetId] ?? "enabled"
    }));
  });
  try {
    return {
      ok: true as const,
      results,
      view: { ok: true as const, ...readSkillSettings(env, rootDir) }
    };
  } catch {
    return {
      ok: true as const,
      results,
      detail: "已安装；列表暂时无法读取，请重新打开技能中心查看。"
    };
  }
}

export const skillInstallJson = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
export function skillInstallFailure(error: unknown): Response {
  if (error instanceof SkillInstallError) {
    const status = {
      SKILL_INVALID: 400,
      SKILL_LIMIT: 413,
      SKILL_CONFLICT: 409,
      SKILL_UNAVAILABLE: 503,
      SKILL_DOWNLOAD: 502
    }[error.code];
    return skillInstallJson({ ok: false, code: error.code, detail: error.message }, status);
  }
  return skillInstallJson(
    {
      ok: false,
      code: "SKILL_UNAVAILABLE",
      detail: "Skill 服务暂时不可用，请检查设置或安装目录后重试。"
    },
    503
  );
}

export async function readSkillUpload(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > SKILL_LIMITS.uploadBytes)
    throw new SkillInstallError("SKILL_LIMIT", "上传文件不能超过 4 MiB。");
  const reader = request.body?.getReader();
  if (!reader) throw new SkillInstallError("SKILL_INVALID", "上传文件为空。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > SKILL_LIMITS.uploadBytes) {
        void reader.cancel().catch(() => undefined);
        throw new SkillInstallError("SKILL_LIMIT", "上传文件不能超过 4 MiB。");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let cursor = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, cursor);
    cursor += chunk.length;
  }
  return bytes;
}
