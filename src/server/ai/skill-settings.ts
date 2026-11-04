/**
 * Skill 管理的**服务端**事实来源（登记投影 + 状态读取/写入 + 受控打开目录 + 执行前复核）。
 *
 * 边界：
 * - 单一登记事实由既有 `IMAGE_SKILL_*` 与这里的静态来源映射组合得到，
 *   不维护第二份名字/版本/能力目录；用户开关与备注进同一份加密文档与锁；
 * - 管理范围仅为本应用登记的 Skill：不扫描 `~/.codex/skills`、`~/.agents/skills` 或全盘；
 * - 打开目录只接受固定 ID，服务端从登记表解析目录并做固定根/realpath 校验后，
 *   用 Node 原生进程 API 以**参数数组**调固定系统打开程序（不拼接 shell、不提供通用命令端点）；
 * - 执行前复核在这里做：只有 enabled 放行；读不出状态也不放行（不默认启用）。
 */
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  ImageSkillUnavailableError,
  loadImageSkill
} from "@/features/creation/creation-image-skill";
import {
  IMAGE_SKILL_ADAPTER_VERSION,
  IMAGE_SKILL_ID,
  IMAGE_SKILL_VERSION
} from "@/features/creation/creation-image-rules";
import {
  MANAGED_SKILL_IDS,
  parseSkillStates,
  parseSkillRemarks,
  isLegacySkillId,
  isSkillRemark,
  type ManagedSkillId,
  type ManagedSkillView,
  type SkillState,
  type SkillStateMap
} from "@/features/ai/skill-settings-contract";
import { createImageConfigStore, isImageRouteEnabled } from "./image-config";
import { styleSkillFileList, styleSkillDirectory, styleSkillVerification } from "./style-skill";
import { STYLE_SKILLS, STYLE_SKILL_IDS, type StyleSkillId } from "@/features/creation/style-skill-rules";
import { scanSkillCatalogSync, type SkillCatalogEntry } from "./skill-catalog";
import { configLockPath, createModelConfigStore, isGatewayRouteEnabled, withConfigLock } from "./model-config";
import { currentSettingsRevision } from "./model-settings-manager";
import { readSettingsDocument, resolveSettingsPaths, writeSettingsDocument } from "./model-settings-store";
import { bundledSkillEnv, findSkillLocation, isBundledSkillId, skillRoot } from "./skill-paths";
import { scopedEnvForModelConfig } from "./user-scope.ts";

/** 稳定错误码：请求内容问题与状态不可读分开，便于路由映射 HTTP 状态。 */
export type SkillSettingsErrorCode = "AI_SKILLS_CONFLICT" | "AI_SKILL_STATE_UNREADABLE" | "AI_SKILL_DIR_UNSAFE" | "AI_SKILL_NOT_FOUND";

export class SkillSettingsError extends Error {
  constructor(readonly code: SkillSettingsErrorCode, detail: string) {
    super(detail);
    this.name = "SkillSettingsError";
  }
}

const STYLE_SKILL_USED_BY = ["风格化图像提示设计（接线中）", "设置 → Skill 管理"];

const IMAGE_SKILL_USED_BY = ["design_image_prompt（生图/修图的提示设计）", "工作台生图与修图入口"];

/**
 * 运行时能力：Skill 是否**真的能跑**由服务端能力/依赖决定，与用户开关分开。
 * 只读开关位与图片配置声明，不发起任何请求。
 */
type RuntimeCapabilities = {
  /** 至少一条制图配置**本地可解析**（端点合法且有凭据）。 */
  imageEnabled: boolean;
  /** 至少一条可用的对话模型配置（图像提示设计的文本前置）。 */
  textEnabled: boolean;
  /** 声明了配置但本地前置不满足时的原因（凭据/端点/配置）。 */
  imageDetail: string;
};

/**
 * 本地只读能力判定：**不发起任何请求**，只做与运行时同一套本地校验
 * （开关位、声明、端点合法性、凭据是否存在、对话模型是否可用）。
 * 通过只代表本地前置就绪，不代表连接或模型真的可用。
 */
function readRuntimeCapabilities(env: Record<string, string | undefined>): RuntimeCapabilities {
  let imageEnabled = false;
  let imageDetail = "";
  let textEnabled = false;
  try {
    textEnabled = createModelConfigStore(env as NodeJS.ProcessEnv).describe().some(entry => entry.usable);
  } catch {
    // 配置读不出来：按不可用处理（调用时同样会失败），由原因说明。
  }
  if (isImageRouteEnabled(env as NodeJS.ProcessEnv)) {
    try {
      const store = createImageConfigStore(env as NodeJS.ProcessEnv);
      if (store.enabled()) {
        const configs = store.listPublic();
        // resolve() 校验端点与凭据（缺密钥就是 IMAGE_KEY_MISSING），与真实调用同一前置。
        const usable = configs.filter((config) => {
          try {
            store.resolve(config.id);
            return true;
          } catch {
            return false;
          }
        });
        imageEnabled = usable.length > 0;
        if (configs.length > 0 && usable.length === 0) imageDetail = "制图配置缺少可用凭据或端点非法";
      }
    } catch {
      // 图片配置非法/解析失败：按没有可用图片能力处理，与运行时一致。
      imageDetail = "制图配置无法读取";
    }
  }
  return { imageEnabled, textEnabled, imageDetail };
}

/** 缺什么能力就说什么（与执行侧一致：缺一项就跑不了）。 */
function runtimeBlockers(runtime: RuntimeCapabilities): string[] {
  /*
   * 文件资源型服务于 design_image_prompt：提示由**对话模型**写、再由制图模型出图，
   * 所以图片能力与可用对话模型都是它的本地前置（缺任一项都不能运行）。
   */
  const blockers: string[] = [];
  if (!runtime.imageEnabled) blockers.push(runtime.imageDetail || "服务端图片能力未开启或没有可用制图模型");
  if (!runtime.textEnabled) blockers.push("没有可用的对话模型配置");
  return blockers;
}

/** 文件资源型：显示适配版本与真实校验状态（缺失/被改动都不假装健康）。 */
function imageSkillView(state: SkillState, rootDir: string, runtime: RuntimeCapabilities, env: Record<string, string | undefined>): ManagedSkillView {
  // T2a：huashu 是 bundled 只读资源，路径解析用部署级根（不随用户 scope 变化）。
  const root = skillRoot(rootDir, bundledSkillEnv());
  const sourceDir = path.join(root.displayPath, IMAGE_SKILL_ID);
  let verification: ManagedSkillView["verification"];
  try {
    const bundle = loadImageSkill({ rootDir: path.join(root.directory, IMAGE_SKILL_ID) });
    verification = { adapterVersion: bundle.adapterVersion, digest: bundle.digest, status: "ok" };
  } catch (error) {
    verification = {
      adapterVersion: IMAGE_SKILL_ADAPTER_VERSION,
      // 校验不通过时不给摘要（宁可为空，也不显示一个未经核对的哈希）。
      digest: "",
      status: error instanceof ImageSkillUnavailableError && error.code === "IMAGE_SKILL_RESOURCE_CHANGED" ? "changed" : "missing"
    };
  }
  const healthy = verification.status === "ok";
  const runtimeReason = runtimeBlockers(runtime);
  const reason = [
    state === "removed"
      ? "已从本应用移除：提示设计不再注入它的正文"
      : state === "disabled"
        ? "已在设置中停用：图片提示设计流程当前不可用"
        : "",
    healthy ? "" : "资源文件缺失或被改动，加载器拒绝运行",
    ...runtimeReason
  ].filter(Boolean).join("；") || undefined;
  return {
    id: IMAGE_SKILL_ID,
    label: IMAGE_SKILL_ID,
    summary: "",
    kind: "resource",
    version: IMAGE_SKILL_VERSION,
    state,
    available: state === "enabled" && healthy && runtimeReason.length === 0,
    ...(reason ? { reason } : {}),
    requires: ["服务端图片能力"],
    tools: ["design_image_prompt"],
    usedBy: IMAGE_SKILL_USED_BY,
    sourceDir,
    directoryExists: existsSync(path.join(root.directory, IMAGE_SKILL_ID)),
    promptFiles: [
      path.join(sourceDir, "SKILL.md"),
      path.join(sourceDir, "references", "capabilities.md"),
      path.join(sourceDir, "references", "prompt-patterns.md"),
      path.join(sourceDir, "PROVENANCE.md"),
      path.join("src", "server", "ai", "creation-image-prompt.ts")
    ],
    verification
  };
}

/** 文档里的开关（缺省 = 既有默认启用）；文档不可读/字段非法一律抛出，不静默当启用。 */
export function readSkillStates(env: Record<string, string | undefined> = scopedEnvForModelConfig()): SkillStateMap {
  const document = readSettingsDocument(resolveSettingsPaths(env));
  if (!document) return {};
  const parsed = parseSkillStates(document.skillStates);
  if (!parsed) throw new SkillSettingsError("AI_SKILL_STATE_UNREADABLE", "本机配置里的 Skill 状态无效，已停止读取。");
  return parsed;
}

export function stateOf(states: SkillStateMap, id: string): SkillState {
  return states[id] ?? "enabled";
}

export function readSkillRemarks(env: Record<string, string | undefined> = scopedEnvForModelConfig()) {
  const document = readSettingsDocument(resolveSettingsPaths(env));
  const remarks = parseSkillRemarks(document?.skillRemarks);
  if (!remarks) throw new SkillSettingsError("AI_SKILL_STATE_UNREADABLE", "本机配置里的 Skill 备注无效，已停止读取。");
  return remarks;
}

/** 管理视图：登记投影 + 状态 + 来源信息 + 版本令牌（不含任何本机绝对路径）。 */
export function readSkillSettings(env: Record<string, string | undefined> = scopedEnvForModelConfig(), rootDir = process.cwd()): {
  revision: string | null;
  writable: boolean;
  skills: ManagedSkillView[];
} {
  const paths = resolveSettingsPaths(env);
  const contract = managedSkills(env, rootDir);
  if (!isGatewayRouteEnabled()) return { revision: null, writable: false, skills: contract };
  return { revision: currentSettingsRevision(env, paths).revision, writable: true, skills: contract };
}

/** 第三方风格资源的登记投影：与图片提示资源同一套前置（要对话模型 + 图片能力）。 */
function styleSkillView(id: StyleSkillId, state: SkillState, rootDir: string, runtime: RuntimeCapabilities, env: Record<string, string | undefined>): ManagedSkillView {
  const meta = STYLE_SKILLS[id];
  // T2a：vendored 风格资源是 bundled 只读资源，路径解析用部署级根。
  const deploymentEnv = bundledSkillEnv();
  const verification = styleSkillVerification(id, rootDir, deploymentEnv);
  const healthy = verification.status === "ok";
  const sourceDir = styleSkillDirectory(id, rootDir, deploymentEnv);
  const reason = [
    state === "removed" ? "已从本应用移除" : state === "disabled" ? "已在设置中停用" : "",
    healthy ? "" : "资源文件缺失或被改动，加载器拒绝加载",
    ...runtimeBlockers(runtime)
  ].filter(Boolean).join("；") || undefined;
  return {
    id,
    label: id,
    summary: "",
    kind: "resource",
    version: `${meta.version}（${meta.license}）`,
    state,
    available: state === "enabled" && healthy && runtimeBlockers(runtime).length === 0,
    ...(reason ? { reason } : {}),
    requires: ["对话模型", "图片能力"],
    tools: [],
    usedBy: [...STYLE_SKILL_USED_BY],
    sourceDir,
    directoryExists: existsSync(path.join(skillRoot(rootDir, deploymentEnv).directory, meta.folder)),
    promptFiles: styleSkillFileList(id, rootDir, deploymentEnv),
    verification
  };
}

/**
 * 登记投影：发现驱动（阶段B）。已登记四项保留富投影（哈希校验/适配版本/依赖原因）；
 * 统一目录里发现的其余 Skill 以泛化投影进入同一视图，无需修改管理名单。
 */
export function managedSkills(env: Record<string, string | undefined> = scopedEnvForModelConfig(), rootDir = process.cwd()): ManagedSkillView[] {
  const states = readSkillStates(env);
  const remarks = readSkillRemarks(env);
  const runtime = readRuntimeCapabilities(env);
  const known = new Set<string>([IMAGE_SKILL_ID, ...STYLE_SKILL_IDS]);
  const rich = [
    imageSkillView(stateOf(states, IMAGE_SKILL_ID), rootDir, runtime, env),
    ...STYLE_SKILL_IDS.map(id => styleSkillView(id, stateOf(states, id), rootDir, runtime, env))
  ];
  const catalog = scanSkillCatalogSync(rootDir, states, env, remarks);
  for (const view of rich) {
    const entry = catalog.find(item => item.id === view.id);
    view.label = entry?.name ?? view.id;
    view.summary = entry?.description ?? "";
    if (entry?.remark || remarks[view.id]) view.remark = entry?.remark ?? remarks[view.id];
    if (entry?.error && !entry.readable) { view.available = false; view.reason = entry.error; }
  }
  const discovered = catalog
    .filter(entry => !known.has(entry.id))
    .map(entry => discoveredSkillView(entry, states, runtime));
  const root = skillRoot(rootDir, env);
  const orphaned: ManagedSkillView[] = Object.entries(states)
    .filter(([id, state]) => state === "removed" && !known.has(id) && !isLegacySkillId(id) && !catalog.some(entry => entry.id === id))
    .map(([id]) => ({
      id, label: id, ...(remarks[id] ? { remark: remarks[id] } : {}),
      summary: "目录未被发现，可彻底删除残留设置；如果目录仍在，请检查路径或权限。",
      kind: "resource", version: "", state: "removed", available: false,
      requires: [], tools: [], usedBy: [], source: "installed",
      sourceDir: path.join(root.displayPath, id), directoryExists: false, promptFiles: []
    }));
  return [...rich.filter(view => view.state !== "removed" || view.directoryExists || !!view.remark), ...discovered, ...orphaned];
}

/** 泛化投影：文件系统发现的未登记 Skill（只有知识文本能力，无适配版本/脚本）。 */
function discoveredSkillView(entry: SkillCatalogEntry, states: SkillStateMap, runtime: RuntimeCapabilities): ManagedSkillView {
  const state = stateOf(states, entry.id);
  const runtimeReason = runtime.textEnabled ? [] : ["没有可用的对话模型配置"];
  const reason = [
    state === "removed" ? "已从本应用移除" : state === "disabled" ? "已在设置中停用" : "",
    entry.readable ? "" : entry.error ?? "SKILL.md 缺失或不可读，无法作为知识资源使用",
    ...runtimeReason
  ].filter(Boolean).join("；") || undefined;
  return {
    id: entry.id,
    label: entry.name,
    ...(entry.remark ? { remark: entry.remark } : {}),
    summary: entry.description,
    kind: "resource",
    version: "",
    state,
    available: state === "enabled" && entry.readable && runtime.textEnabled,
    ...(reason ? { reason } : {}),
    requires: ["对话模型"],
    tools: [],
    usedBy: ["工作台 read_skill（按需知识）"],
    source: entry.source,
    sourceDir: entry.sourceDir!,
    directoryExists: true,
    promptFiles: [`${entry.sourceDir}/SKILL.md`]
  };
}

/**
 * 已登记资源的**原有完整性校验**状态（阶段B 复审）：Agent 目录与受控读取必须
 * 以它为门——被改动的 vendored Skill 不得因「重新计算摘要一致」而被当成可信资源。
 * 未登记的发现型知识资源返回 unverified（无既有校验，仅普通文本读取）。
 */
export function registeredVerificationStatus(id: string, rootDir = process.cwd(), env: Record<string, string | undefined> = scopedEnvForModelConfig()): "ok" | "unverified" | "changed" | "missing" {
  // bundled 资源按部署级根核对，与用户 scope 的 skills 目录无关。
  const pathEnv = isBundledSkillId(id) ? bundledSkillEnv() : env;
  if (id === IMAGE_SKILL_ID) {
    try {
      // 校验的根必须与后续读取的根一致（复审三）：loadImageSkill 的 rootDir 是
      // Skill 目录本身；隔离目录里的副本在它自己的目录上核对。
      loadImageSkill({ rootDir: path.join(skillRoot(rootDir, pathEnv).directory, IMAGE_SKILL_ID) });
      return "ok";
    } catch (error) {
      return error instanceof ImageSkillUnavailableError && error.code === "IMAGE_SKILL_RESOURCE_CHANGED" ? "changed" : "missing";
    }
  }
  if ((STYLE_SKILL_IDS as readonly string[]).includes(id)) {
    return styleSkillVerification(id as StyleSkillId, rootDir, pathEnv).status;
  }
  return "unverified";
}

/** 公开（脱敏）投影：给工作台/能力查询用的不可用状态，只有 ID 与开关，没有路径与正文。 */
export function publicSkillStates(env: Record<string, string | undefined> = scopedEnvForModelConfig()): { id: ManagedSkillId; state: SkillState }[] {
  const states = readSkillStates(env);
  return MANAGED_SKILL_IDS.map(id => ({ id, state: stateOf(states, id) }));
}

/**
 * 写入单个 Skill 状态或备注：保留原导出名供既有开关调用；
 * 与模型/隐私同一份文档、同一把锁、同一套版本令牌。
 * 版本不匹配 → 冲突（不自动用旧版本重放）；其余字段原样保留。
 */
export async function applySkillState(
  input: { id: string; revision: string } & ({ state: SkillState; remark?: never } | { remark: string; state?: never }),
  env: Record<string, string | undefined> = scopedEnvForModelConfig()
): Promise<SkillStateMap> {
  if (!isGatewayRouteEnabled()) throw new SkillSettingsError("AI_SKILL_STATE_UNREADABLE", "当前部署不允许修改本机设置。");
  const paths = resolveSettingsPaths(env);
  return withConfigLock(configLockPath(paths.document), async () => {
    const current = currentSettingsRevision(env, paths);
    if (current.revision !== input.revision)
      throw new SkillSettingsError("AI_SKILLS_CONFLICT", "设置已在别处修改，请重新读取后再试。");
    const states = parseSkillStates(current.document.skillStates);
    if (!states) throw new SkillSettingsError("AI_SKILL_STATE_UNREADABLE", "本机配置里的 Skill 状态无效，未做改动。");
    if (input.remark !== undefined) {
      const remarks = parseSkillRemarks(current.document.skillRemarks);
      if (!remarks || !isSkillRemark(input.remark))
        throw new SkillSettingsError("AI_SKILL_STATE_UNREADABLE", "Skill 备注无效，未做改动。");
      const catalog = scanSkillCatalogSync(process.cwd(), states, env, remarks);
      if (!catalog.some(entry => entry.id === input.id))
        throw new SkillSettingsError("AI_SKILL_NOT_FOUND", "没有找到这个 Skill，请重新读取列表。");
      const next = { ...remarks };
      const remark = input.remark.trim();
      if (remark) next[input.id] = remark;
      else delete next[input.id];
      writeSettingsDocument({ ...current.document, revision: current.document.revision + 1, skillRemarks: next }, paths);
      return states;
    }
    const next: SkillStateMap = { ...states, [input.id]: input.state };
    writeSettingsDocument({ ...current.document, revision: current.document.revision + 1, skillStates: next }, paths);
    return next;
  });
}

/* ------------------------------------------------------------------ *
 * 管理端点的请求体：**读取过程中**限制字节数（超限立即停止读取）
 * ------------------------------------------------------------------ */

export type LimitedBody = { ok: true; value: unknown } | { ok: false; code: "AI_SKILL_BODY_TOO_LARGE" | "AI_SKILL_BODY_INVALID" };

/** 与既有小请求管理端点同一做法：边读边计数，超过上限立刻取消，不先读完整。 */
export async function readJsonBodyWithinLimit(request: Request, limitBytes: number): Promise<LimitedBody> {
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, code: "AI_SKILL_BODY_INVALID" };
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value?.byteLength ?? 0;
      if (bytes > limitBytes) {
        // 已经超限：取消读取失败不影响结论（结论只看字节数）。
        try { await reader.cancel(); } catch { /* 忽略取消失败 */ }
        return { ok: false, code: "AI_SKILL_BODY_TOO_LARGE" };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return { ok: false, code: "AI_SKILL_BODY_INVALID" };
  } finally {
    try { reader.releaseLock?.(); } catch { /* 流已经结束或已取消 */ }
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, code: "AI_SKILL_BODY_INVALID" };
  }
}

/* ------------------------------------------------------------------ *
 * 打开来源目录（仅用户点击触发，只接受固定 ID）
 * ------------------------------------------------------------------ */

export type OpenFolderResult = { ok: true; path: string; command: string } | { ok: false; code: string; detail: string };
export type LaunchResult = { ok: true } | { ok: false; detail: string };
export type SkillFolderDeps = {
  /** 注入替身：测试不真的打开任何目录。 */
  launch?: (command: string, args: string[]) => LaunchResult | Promise<LaunchResult>;
  platform?: NodeJS.Platform;
  rootDir?: string;
};

/** 打开程序失败（无桌面环境、程序不存在、非零退出）时的统一文案。 */
const OPEN_FAILURE_DETAIL = "请在运行应用的电脑上打开此目录（系统打开程序未能打开它）。";

const OPEN_COMMANDS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "open",
  win32: "explorer",
  linux: "xdg-open"
};

/**
 * 打开动作的注入点：隔离测试注入替身，**不会**真的弹出文件管理器。
 * 放在服务端模块（而不是路由文件）里：路由只允许导出约定的处理函数。
 */
let folderDeps: SkillFolderDeps = {};
export function setSkillFolderDeps(deps: SkillFolderDeps): void {
  folderDeps = deps;
}

/**
 * 参数数组直传，不经过 shell；等一小段确认窗口再回报：
 * - `error`（打不开/没有桌面环境）→ 明确失败；
 * - 窗口内非零退出 → 明确失败；
 * - 进程正常启动并在窗口后仍在运行 → 只报「已请求打开」，不声称验证了窗口。
 */
const LAUNCH_GRACE_MS = 1_000;

function defaultLaunch(command: string, args: string[]): Promise<LaunchResult> {
  return new Promise<LaunchResult>((resolve) => {
    // 用可变持有者而不是裸 let：spawn 在定时器建立前就可能失败，不能引用未初始化的变量。
    const state: { settled: boolean; timer?: ReturnType<typeof setTimeout> } = { settled: false };
    const finish = (result: LaunchResult) => {
      if (state.settled) return;
      state.settled = true;
      if (state.timer) clearTimeout(state.timer);
      resolve(result);
    };
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio: "ignore" });
    } catch {
      finish({ ok: false, detail: OPEN_FAILURE_DETAIL });
      return;
    }
    state.timer = setTimeout(() => finish({ ok: true }), LAUNCH_GRACE_MS);
    state.timer.unref?.();
    child.on("error", () => finish({ ok: false, detail: OPEN_FAILURE_DETAIL }));
    child.on("exit", (code) => {
      if (code === 0) finish({ ok: true });
      else finish({ ok: false, detail: OPEN_FAILURE_DETAIL });
    });
    child.unref();
  });
}

/** 目录必须是登记表里的固定目录：存在、realpath 未越界、也不是被替换的符号链接。 */
export async function openSkillFolder(id: string, deps: SkillFolderDeps = folderDeps): Promise<OpenFolderResult> {
  const rootDir = deps.rootDir ?? process.cwd();
  let location: ReturnType<typeof findSkillLocation>;
  // bundled 资源按部署级根解析；用户安装的 Skill 按当前 scope 根解析。
  try { location = findSkillLocation(id, rootDir, isBundledSkillId(id) ? bundledSkillEnv() : undefined); }
  catch { return { ok: false, code: "SKILL_DIR_UNSAFE", detail: "Skill 目录不可读，未执行打开。" }; }
  if (!location) return { ok: false, code: "SKILL_DIR_MISSING", detail: "来源目录不存在，未执行打开。" };
  const platform = deps.platform ?? process.platform;
  const command = OPEN_COMMANDS[platform];
  if (!command) return { ok: false, code: "SKILL_OPEN_UNSUPPORTED", detail: "请在运行应用的电脑上打开此目录。" };

  const absolute = location.directory;
  if (!existsSync(absolute)) return { ok: false, code: "SKILL_DIR_MISSING", detail: "来源目录不存在，未执行打开。" };
  let real: string;
  let rootReal: string;
  try {
    real = realpathSync(absolute);
    rootReal = realpathSync(location.root.directory);
  } catch {
    return { ok: false, code: "SKILL_DIR_MISSING", detail: "来源目录无法解析，未执行打开。" };
  }
  const expected = path.join(rootReal, id);
  if (real !== expected || !real.startsWith(`${rootReal}${path.sep}`))
    return { ok: false, code: "SKILL_DIR_UNSAFE", detail: "来源目录不是本应用登记的固定目录，已拒绝打开。" };

  try {
    const launched = await (deps.launch ?? defaultLaunch)(command, [real]);
    if (!launched.ok) return { ok: false, code: "SKILL_OPEN_FAILED", detail: launched.detail };
  } catch {
    return { ok: false, code: "SKILL_OPEN_FAILED", detail: OPEN_FAILURE_DETAIL };
  }
  // 只报告“已请求打开”：不声称验证了文件管理器窗口。
  return { ok: true, path: real, command };
}
