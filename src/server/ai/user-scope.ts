/**
 * T2a 请求局部 UserScope（连续实施任务书 §6）：
 * 有效会话 → 按 serverId/userId 派生的运行资料路径集合，经 AsyncLocalStorage
 * 注入请求执行流；各 Store 的默认 env 参数改读该 scope，不修改 process.env，
 * 不靠 UI 过滤。跨账号引用因路径命名空间天然隔离。
 *
 * 派生目录（相对 beta 根）：users/<userId>/runtime.sqlite、users/<userId>/ai-settings/、
 * users/<userId>/skills/。Key 仍只在服务端按用户加密文档中（唯一长期服务端例外）。
 */
import { AsyncLocalStorage } from "node:async_hooks";
export {};
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathInsideRoot } from "./beta-data.ts";

export type BetaScopeEnv = Record<string, string>;

const scopeStorage = new AsyncLocalStorage<BetaScopeEnv>();

/** 在给定 scope 内执行（HTTP 层用 enterWith；测试与 CLI 可用本函数包裹）。 */
export function runInBetaScope<T>(scope: BetaScopeEnv, fn: () => T): T {
  return scopeStorage.run(scope, fn);
}

/** HTTP 门闸在认证通过后调用：当前执行流后续都在该 scope 内。 */
export function enterBetaScope(scope: BetaScopeEnv): void {
  scopeStorage.enterWith(scope);
}

export function currentBetaScope(): BetaScopeEnv | undefined {
  return scopeStorage.getStore();
}

/**
 * 当前请求生效的 env：存在 beta scope 时返回 scope（含派生路径，不含任何
 * 供应商 Key/apiKeyEnv/CONFIG_FILE），否则回落到真实 process.env（桌面非 beta 路径
 * 与既有测试语义不变）。
 */
export function currentScopeEnv(fallback: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  return scopeStorage.getStore() ?? fallback;
}

/** beta scope 是否生效（生效时凭据/旧声明类环境回退必须被忽略）。 */
export function isBetaScopeActive(): boolean {
  return scopeStorage.getStore() !== undefined;
}

/**
 * beta scope 下的 env：用户派生路径覆盖 + 继承部署级功能开关，但显式剔除
 * 凭据与旧声明类变量（零继承：apiKeyEnv 回退、CONFIG_FILE、XINGJI_AI_CONFIGS）。
 */
export function scopedEnvForModelConfig(): Record<string, string | undefined> {
  const scope = scopeStorage.getStore();
  if (!scope) return process.env;
  const merged: Record<string, string | undefined> = { ...process.env, ...scope };
  delete merged.XINGJI_AI_CONFIG_FILE;
  delete merged.XINGJI_AI_CONFIGS;
  delete merged.XINGJI_AI_IMAGE_CONFIGS;
  return merged;
}

export type UserScopePaths = {
  userDir: string;
  runtimeDbPath: string;
  settingsDir: string;
  skillsDir: string;
};

/** 由 serverId/userId/beta 根派生用户路径集；目录链 symlink 即拒绝；不存在时惰性创建。 */
export function deriveUserPaths(serverId: string, userId: string, betaRoot: string): UserScopePaths {
  const usersDir = pathInsideRoot(betaRoot, "users");
  const userDir = pathInsideRoot(usersDir, userId);
  if (!/^[a-zA-Z0-9_-]{3,64}$/.test(userId)) throw new Error("userId 形状不合法，拒绝派生用户路径");
  if (existsSync(userDir) && realpathSync(userDir) !== userDir) throw new Error("用户目录包含符号链接，拒绝");
  if (!existsSync(userDir)) mkdirSync(userDir, { recursive: true, mode: 0o700 });
  void serverId;
  return {
    userDir,
    runtimeDbPath: pathInsideRoot(userDir, "runtime.sqlite"),
    settingsDir: pathInsideRoot(userDir, "ai-settings"),
    skillsDir: pathInsideRoot(userDir, "skills")
  };
}

/** 构造请求级 scope env：仅包含三个派生路径覆盖，不继承任何凭据类变量。 */
export function buildScopeEnv(paths: UserScopePaths): BetaScopeEnv {
  return {
    XINGJI_MEMORY_DB_PATH: paths.runtimeDbPath,
    XINGJI_AI_SETTINGS_DIR: paths.settingsDir,
    XINGJI_SKILLS_DIR: paths.skillsDir
  };
}
