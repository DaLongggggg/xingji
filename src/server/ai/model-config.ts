import { readSettingsDocument, resolveSettingsPaths } from "./model-settings-store";
import { isBetaScopeActive, scopedEnvForModelConfig } from "./user-scope.ts";
import { isChatApiProtocol, type ChatApiProtocol } from "@/features/ai/model-settings-contract";
import { type NativeSearchMode } from "@/features/ai/native-search-contract";
import { resolveNativeSearchMode } from "./native-search-capability";
/**
 * P1-04：服务端受控模型配置。
 *
 * 边界：
 * - apiKey 只从服务端环境变量读取，不进入客户端响应、日志或 NEXT_PUBLIC 变量；
 * - 客户端只提交配置 ID，**不能**提交任意 baseUrl（否则就是开放代理）；
 * - 默认未启用：没有配置时 Gateway 明确不可用，绝不调用默认外部服务或伪造成功；
 * - 本地端点与远程端点分开声明，服务器上的 localhost 不等于用户电脑的 localhost；
 * - 设置页写入的是**运行时覆盖层**：`XINGJI_AI_CONFIG_FILE` 指向的 JSON 文件存在时覆盖
 *   环境变量配置，文件不存在时环境变量即默认值；密钥仍只以环境变量名引用，服务端不持有密钥值。
 */
import { createHash } from "node:crypto";
import { chatRuntimeConfigs } from "./model-settings-manager";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

export type ModelCapabilities = {
  structuredOutput: boolean;
  stream: boolean;
  vision: boolean;
  tools: boolean;
};

/** 可下发给浏览器的部分（绝不含 apiKey 或密钥所在环境变量名）。 */
export type PublicModelConfig = {
  apiProtocol?: ChatApiProtocol;
  /** 服务端只读派生能力，不接受旧手选声明覆盖。 */
  readonly nativeSearch?: NativeSearchMode;
  id: string;
  provider: "openai-compatible";
  baseUrl: string;
  model: string;
  /** 端点是否被声明为本地（仅提示用途，授权仍以服务端配置为准）。 */
  local: boolean;
  capabilities: ModelCapabilities;
};

type ResponseFormat = "json_schema" | "json_object";

type ModelConfigRecord = {
  apiProtocol?: ChatApiProtocol;
  responseFormat?: ResponseFormat;
  /**
   * 用户在本机设置页填写的密钥（**只存在于服务端解密后的内存记录**，从不进入
   * 公开投影、响应、日志或令牌）。存在时优先于 `apiKeyEnv` 环境引用。
   */
  credential?: { id: string; value: string };
  id: string;
  provider: "openai-compatible";
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  local: boolean;
  capabilities: ModelCapabilities;
};

export type EnvSource = Record<string, string | undefined>;

/**
 * 运行时配置覆盖文件（设置页写接口的落点）；它存在时覆盖 `XINGJI_AI_CONFIGS`。
 * 未声明时**不接受写入**（写接口返回 `AI_CONFIG_READONLY`），因此默认落点不写死在代码里。
 */
export const CONFIG_FILE_ENV = "XINGJI_AI_CONFIG_FILE";

export class ModelConfigError extends Error {
  constructor(
    readonly code:
      | "AI_DISABLED"
      | "AI_CONFIG_UNKNOWN"
      | "AI_CONFIG_UNREADABLE"
      | "AI_CONFIG_INVALID"
      | "AI_CONFIG_READONLY"
      | "AI_CONFIG_BUSY"
      | "AI_CONFIG_CONFLICT"
      | "AI_CONFIG_PRECONDITION_REQUIRED"
      | "AI_CONFIG_TOO_LARGE"
      | "AI_ENDPOINT_INVALID"
      | "AI_KEY_MISSING",
    detail: string
  ) {
    super(`${code}:${detail}`);
    this.name = "ModelConfigError";
  }
}

/**
 * 错误码 → **固定安全文案**。
 *
 * 所有面向浏览器的配置错误出口都只允许从这里取文案：`ModelConfigError.message` 里带有
 * 端点、环境变量名或变量名引用（用于服务端诊断），**绝不能**回给客户端或写入日志。
 * 每种真实失败都保留自己的文案，不合并成“未知错误”。
 */
export const CONFIG_ERROR_DETAIL: Record<string, string> = {
  AI_DISABLED: "服务端未启用该 AI 能力。",
  AI_CONFIG_UNKNOWN: "服务端模型配置无效，请检查服务端配置。",
  AI_CONFIG_UNREADABLE: "服务端配置文件当前无法读取，配置未生效。",
  AI_CONFIG_INVALID: "提交的配置无效，请检查字段后重试。",
  AI_CONFIG_READONLY: "当前部署不允许在此修改配置。",
  AI_CONFIG_BUSY: "配置正在被其他写入占用，请稍后重试。",
  AI_CONFIG_CONFLICT: "配置已被其他会话修改，请刷新后重试。",
  AI_CONFIG_PRECONDITION_REQUIRED: "缺少配置版本，请先读取当前配置。",
  AI_CONFIG_TOO_LARGE: "配置内容过大。",
  AI_ENDPOINT_INVALID: "模型端点无效或不被允许。",
  AI_KEY_MISSING: "该配置的凭据未在服务端设置。",
  IMAGE_DISABLED: "服务端未启用图片能力。",
  IMAGE_CONFIG_UNKNOWN: "服务端图片配置无效，请检查服务端配置。",
  IMAGE_KEY_MISSING: "该图片配置的凭据未在服务端设置。",
  IMAGE_ENDPOINT_INVALID: "图片端点无效或不被允许。",
  IMAGE_API_KIND_UNSUPPORTED: "该图片配置的协议不受支持。"
};

/** 取稳定安全文案；未知 code 也**不**回显异常文本。 */
export function safeConfigDetail(code: string): string {
  return CONFIG_ERROR_DETAIL[code] ?? "服务端配置错误。";
}

/** 客户端提交的批次非法：4xx（用户改字段就能解决）。 */
const apiConfigFail: (detail: string) => never = (detail) => {
  throw new ModelConfigError("AI_CONFIG_INVALID", detail);
};

/** 服务端文件/环境变量的配置非法：503（要改的是服务端配置，不是用户输入）。 */
const serverConfigFail: (detail: string) => never = (detail) => {
  throw new ModelConfigError("AI_CONFIG_UNKNOWN", detail);
};

/** 可下发给浏览器的配置状态：`usable` 由服务端判定，客户端不做自然语言推断。 */
export type ConfigStatusEntry = {
  config: PublicModelConfig;
  usable: boolean;
  /** 不可用时的稳定错误码（无细节）；可用时不带。 */
  errorCode?: string;
};


const DEFAULT_CAPABILITIES: ModelCapabilities = {
  structuredOutput: true,
  stream: false,
  vision: false,
  // Phase 1 不启用工具调用：模型没有业务写权限，也不注册工具。
  tools: false
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function parseEndpoint(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ModelConfigError("AI_ENDPOINT_INVALID", `无法解析 baseUrl：${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ModelConfigError("AI_ENDPOINT_INVALID", `只允许 http/https，收到 ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new ModelConfigError("AI_ENDPOINT_INVALID", "baseUrl 不能内联凭据。");
  }
  return url;
}

export function isLoopbackEndpoint(baseUrl: string): boolean {
  const url = parseEndpoint(baseUrl);
  return LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * 受控出站校验：只允许配置里声明的端点。
 * - 远程端点必须 https；
 * - 声明为 local 的端点必须是回环地址（防止把内网/公网地址伪装成本地模型）。
 */
function assertControlledEndpoint(record: ModelConfigRecord, allowInsecureRemote: boolean): URL {
  const url = parseEndpoint(record.baseUrl);
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (record.local && !loopback) {
    throw new ModelConfigError(
      "AI_ENDPOINT_INVALID",
      `配置 ${record.id} 声明为本地，但 ${url.hostname} 不是回环地址。`
    );
  }
  if (!loopback && url.protocol !== "https:" && !allowInsecureRemote) {
    throw new ModelConfigError("AI_ENDPOINT_INVALID", `远程端点必须使用 https：${record.baseUrl}`);
  }
  return url;
}

/**
 * 严格解析配置数组（**写接口与环境变量共用这一份**，避免两套校验）。
 *
 * - 只接受下列字段；出现未知字段（含明文 `apiKey` 之类的误传）**整份拒绝**，不静默忽略；
 * - `id` 非空且唯一；`baseUrl`/`model` 非空字符串；`local` 必须是布尔；
 * - `capabilities` 只接受四个布尔字段，其余字段拒收；`tools` 只允许 false（本阶段关闭工具调用）；
 * - 值为 `undefined` 的键按“未声明”处理（`JSON.stringify` 也会丢掉它们）。
 */
export function parseModelConfigRecords(
  input: unknown,
  readFailure?: (detail: string) => never
): ModelConfigRecord[] {
  /**
   * 显式标注 `never`：TypeScript 5.9+ 起箭头函数不再自动获得该推断，否则下面的收窄全失效。
   * 缺省（客户端提交的批次）→ `AI_CONFIG_INVALID`（4xx，用户改字段就能解决）；
   * 读侧传入 `serverConfigFail` → `AI_CONFIG_UNKNOWN`（503，要改的是服务端配置）。
   */
  const fail: (detail: string) => never = readFailure ?? apiConfigFail;
  const rejectUnknown = (
    candidate: Record<string, unknown>,
    allowed: readonly string[],
    where: string
  ): void => {
    for (const key of Object.keys(candidate)) {
      if (candidate[key] === undefined) continue;
      if (!allowed.includes(key)) fail(`${where}包含不接受的字段：${key}。`);
    }
  };
  const parseCapabilities = (value: unknown, where: string): ModelCapabilities => {
    if (value === undefined) return { ...DEFAULT_CAPABILITIES };
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail(`${where}的 capabilities 必须是对象。`);
    }
    const candidate = value as Record<string, unknown>;
    rejectUnknown(candidate, ["structuredOutput", "stream", "vision", "tools"], `${where}的 capabilities `);
    const parsed: ModelCapabilities = { ...DEFAULT_CAPABILITIES };
    for (const key of ["structuredOutput", "stream", "vision", "tools"] as const) {
      const field = candidate[key];
      if (field === undefined) continue;
      if (typeof field !== "boolean") fail(`${where}的 capabilities.${key} 必须是布尔值。`);
      parsed[key] = field;
    }
    // 工具调用在本阶段一律关闭：配置不能开启它。
    if (parsed.tools) fail(`${where}不能开启 tools：本阶段不注册工具。`);
    parsed.tools = false;
    return parsed;
  };

  if (!Array.isArray(input)) fail("配置必须是数组。");
  const records: ModelConfigRecord[] = [];
  const seen = new Set<string>();
  for (const [index, item] of input.entries()) {
    const where = `第 ${index} 条配置`;
    if (!item || typeof item !== "object" || Array.isArray(item)) fail(`${where}必须是对象。`);
    const candidate = item as Record<string, unknown>;
    rejectUnknown(
      candidate,
      ["apiProtocol", "responseFormat", "id", "provider", "baseUrl", "model", "apiKeyEnv", "local", "capabilities"],
      where
    );
    const { id, baseUrl, model, apiKeyEnv } = candidate;
    const responseFormat = candidate.responseFormat;
    if (candidate.apiProtocol !== undefined && !isChatApiProtocol(candidate.apiProtocol)) fail("API 协议无效。");
    if (typeof id !== "string" || id.trim().length === 0) fail(`${where}的 id 必须是非空字符串。`);
    if (seen.has(id)) fail(`配置 id 重复：${id}。`);
    seen.add(id);
    if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
      fail(`${where}的 baseUrl 必须是非空字符串。`);
    }
    if (typeof model !== "string" || model.trim().length === 0) {
      fail(`${where}的 model 必须是非空字符串。`);
    }
    /*
     * 密钥只以**环境变量名**引用：除形状外再收一次字符集，避免把密钥值本身
     * （带空格、符号或粘贴进来的 sk-… 片段）伪装成变量名写进配置文件。
     */
    if (typeof apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
      fail(`${where}的 apiKeyEnv 必须是环境变量名（不含密钥值）。`);
    }
    if (candidate.provider !== undefined && candidate.provider !== "openai-compatible") {
      fail(`${where}的 provider 只允许 openai-compatible。`);
    }
    if (candidate.local !== undefined && typeof candidate.local !== "boolean") {
      fail(`${where}的 local 必须是布尔值。`);
    }
    if (
      responseFormat !== undefined &&
      responseFormat !== "json_schema" &&
      responseFormat !== "json_object"
    ) {
      fail(`${where}的 responseFormat 无效。`);
    }
    records.push({
      ...(candidate.apiProtocol !== undefined ? { apiProtocol: candidate.apiProtocol as ChatApiProtocol } : {}),
      responseFormat: responseFormat ?? "json_schema",
      id,
      provider: "openai-compatible",
      baseUrl,
      model,
      apiKeyEnv,
      local: candidate.local === true,
      capabilities: parseCapabilities(candidate.capabilities, where)
    });
  }
  return records;
}

/**
 * 读取受控配置：**存在**的运行时覆盖文件优先，否则用环境变量 `XINGJI_AI_CONFIGS`。
 * 文件不存在不是错误（尚未保存过），仍要回到环境变量默认值；文件存在但非法 → 明确失败，
 * 不猜测、不静默回退。
 */
export function loadModelConfigs(
  env: EnvSource,
  readFailure: (detail: string) => never = serverConfigFail
): ModelConfigRecord[] {
  // beta scope（T2a）：凭据/旧声明类环境回退零继承——用户文档是唯一权威，
  // 缺文档即空配置，不读 CONFIG_FILE/XINGJI_AI_CONFIGS，也不回退全局 apiKeyEnv。
  if (isBetaScopeActive()) return [];
  const filePath = env[CONFIG_FILE_ENV];
  if (filePath) {
    const override = readOverrideLayer(filePath);
    if (override !== undefined) return parseModelConfigRecords(override, readFailure);
  }

  const raw = env.XINGJI_AI_CONFIGS;
  if (!raw || raw.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ModelConfigError("AI_CONFIG_UNKNOWN", "XINGJI_AI_CONFIGS 不是有效 JSON。");
  }
  return parseModelConfigRecords(parsed, readFailure);
}

type ConfigFile = { revision: number; configs: ModelConfigRecord[] };

/**
 * 读覆盖文件原始文本。**只有 ENOENT** 返回 `undefined`（“尚未建立覆盖层”）。
 *
 * 其它读取错误（EACCES/EPERM/EISDIR/EIO…）必须**明确失败**：静默回退环境变量会把
 * “覆盖层读不出来”伪装成“用的是环境默认配置”，让 GET/Gateway 用另一份端点与模型声明继续跑。
 * 错误只带稳定码与固定文案，不带路径、变量名或原始异常。
 */
function readOverrideText(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ModelConfigError("AI_CONFIG_UNREADABLE", "运行时配置文件无法读取。");
  }
}

/** 解析覆盖文件内容；损坏的 JSON 明确失败，不当成空配置。 */
function parseOverrideText(raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ModelConfigError("AI_CONFIG_UNKNOWN", "运行时配置文件不是有效 JSON。");
  }
  return parsed;
}

/** 读覆盖层配置数组；文件不存在返回 `undefined`（表示“没有覆盖层”，不是“空配置”）。 */
function readOverrideLayer(filePath: string): unknown | undefined {
  const raw = readOverrideText(filePath);
  if (raw === undefined) return undefined;
  const parsed = parseOverrideText(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) && "revision" in parsed
    ? (parsed as ConfigFile).configs
    : parsed;
}

/** 覆盖文件是否存在：决定 `layer().source` 与 ETag 的版本来源。 */
function overrideExists(filePath: string | undefined): boolean {
  return filePath !== undefined && existsSync(filePath);
}

/**
 * 读取覆盖层版本号。
 * - ENOENT → 0（尚未建立覆盖层）；
 * - 其它读取错误或损坏内容 → 明确失败，**不**无条件当 0（否则坏文件会得到一个“像没事”的版本）。
 */
function readConfigRevision(filePath: string): number {
  const raw = readOverrideText(filePath);
  if (raw === undefined) return 0;
  const parsed = parseOverrideText(raw) as { revision?: unknown };
  if (typeof parsed?.revision !== "number" || !Number.isInteger(parsed.revision)) {
    throw new ModelConfigError("AI_CONFIG_UNKNOWN", "运行时配置文件的 revision 无效。");
  }
  return parsed.revision;
}

/** 原子写入：同目录临时文件 + rename，避免读到写了一半的配置。 */
function writeConfigFile(filePath: string, file: ConfigFile): void {
  const temp = `${filePath}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    // 配置里含端点与环境变量名（不含密钥值），默认权限收紧到仅本用户可读。
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, filePath);
  } catch {
    rmSync(temp, { force: true });
    throw new ModelConfigError("AI_CONFIG_READONLY", "配置无法写入运行时配置文件。");
  }
}

/** 当前生效的配置层（供 ETag 与状态展示；不含任何凭据）。 */
export type ModelConfigLayer = {
  source: "file" | "env" | "none";
  enabled: boolean;
  /** 覆盖层版本号：每次保存 +1；没有覆盖层时为 0。 */
  revision: number;
};

/**
 * 写入用的独占锁文件（与被写文件同目录）。
 *
 * 进程内队列只覆盖单个进程，因此受保护范围再加一把文件锁：
 * `wx` 打开失败即视为占用；陈旧（>10s，进程被杀留下的）锁回收后重试。
 * **部署约束：本实现只支持单个服务进程**——文件锁不是分布式锁，第二份服务进程不受支持。
 */
export const CONFIG_LOCK_STALE_MS = 10_000;

export function configLockPath(filePath: string): string {
  return `${filePath}.lock`;
}

export async function withConfigLock<T>(
  filePath: string,
  task: () => Promise<T>
): Promise<T> {
  const lockPath = configLockPath(filePath);
  const deadline = Date.now() + 2_000;
  let handle: number | null = null;
  while (handle === null) {
    try {
      mkdirSync(path.dirname(lockPath), { recursive: true });
      handle = openSync(lockPath, "wx");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw new ModelConfigError("AI_CONFIG_READONLY", "无法创建配置写锁。");
      }
      let stale = false;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > CONFIG_LOCK_STALE_MS;
      } catch {
        stale = false;
      }
      if (stale) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new ModelConfigError("AI_CONFIG_BUSY", "配置写锁被占用。");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await task();
  } finally {
    closeSync(handle);
    rmSync(lockPath, { force: true });
  }
}


/** 服务端启用开关的环境变量名；`/api/ai/generate` 与 `/api/ai/configs` 共用同一判定。 */
export const AI_ENABLED_ENV = "XINGJI_AI_ENABLED";

/**
 * 无认证的模型代理是否允许在当前部署开放（F6）。
 *
 * 本阶段契约：无认证的**生产环境一律关闭**。没有例外开关——
 * 设置任何环境变量都不能在生产开放这个代理；开发/测试环境保留受控验证能力。
 */
export function isUnauthenticatedGatewayAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production";
}

/** 两个 AI 路由共用的开关判定，避免两处各写一套“是否开启”。 */
export function isGatewayRouteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env[AI_ENABLED_ENV] !== "1") return false;
  /*
   * T2a/T4 复核五：**已认证 + scope 就绪**的执行路径与旧免认证代理分离——
   * start:lan 正常运行 production，beta 会话内（requireBetaAccess 已进入 scope）
   * 必须可用；无 scope（旧桌面免认证语义）仍按非生产限制，F6 不复活。
   */
  if (isBetaScopeActive()) return true;
  return isUnauthenticatedGatewayAllowed(env);
}

/** 用户许可读取失败时停止请求；管理接口不受此开关影响，仍能修正设置。 */
export function readAiPermissions(env: NodeJS.ProcessEnv = scopedEnvForModelConfig() as NodeJS.ProcessEnv): { ai: boolean; images: boolean } {
  const saved = readSettingsDocument(resolveSettingsPaths(env))?.permissions;
  return saved ?? { ai: env[AI_ENABLED_ENV] === "1", images: env.XINGJI_AI_IMAGE_ENABLED === "1" };
}

export function isAiExecutionEnabled(env: NodeJS.ProcessEnv = scopedEnvForModelConfig() as NodeJS.ProcessEnv): boolean {
  if (!isGatewayRouteEnabled(env)) return false;
  try { return readAiPermissions(env).ai; } catch { return false; }
}

/** P8（整理检索结果）的独立启用开关；与 `XINGJI_AI_ENABLED` 相互独立。 */
export const LIGHT_AGENT_ENABLED_ENV = "XINGJI_AI_P8_ENABLED";

/** 整理检索结果随 AI 许可可用，部署显式 0 时禁用。 */
export function isLightAgentEnabled(env: NodeJS.ProcessEnv = scopedEnvForModelConfig() as NodeJS.ProcessEnv): boolean {
  return env[LIGHT_AGENT_ENABLED_ENV] !== "0" && isAiExecutionEnabled(env);
}

export type ResolvedModelConfig = PublicModelConfig & {
  apiKey: string;
  apiKeyEnv: string;
  apiProtocol?: ChatApiProtocol;
  responseFormat?: ResponseFormat;
};

/** 写接口的一条操作：按 ID 的 upsert / 显式 delete。 */
export type ConfigOperation =
  | ({ op: "upsert"; id: string } & Partial<
      Pick<ModelConfigRecord, "baseUrl" | "model" | "local" | "apiKeyEnv" | "responseFormat">
    > & {
      capabilities?: Partial<Omit<ModelCapabilities, "tools">>;
    })
  | { op: "delete"; id: string };

const UPSERT_FIELDS = [
  "op",
  "id",
  "baseUrl",
  "model",
  "local",
  "apiKeyEnv",
  "responseFormat",
  "capabilities"
] as const;
const CAPABILITY_FIELDS = ["structuredOutput", "stream", "vision"] as const;

/** 只做形状校验并记账；**不在这里做跨记录合并**，合并后统一走 `parseModelConfigRecords`。 */
export function parseConfigBatch(payload: unknown): ConfigOperation[] {
  const fail: (detail: string) => never = (detail) => {
    throw new ModelConfigError("AI_CONFIG_INVALID", detail);
  };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("请求体必须是对象。");
  }
  const body = payload as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) continue;
    // `baseRevision` 由路由自己校验（版本前提），这里只做字段白名单。
    if (key !== "operations" && key !== "baseRevision") fail(`不接受的字段：${key}。`);
  }
  const operations = body.operations;
  if (!Array.isArray(operations) || operations.length === 0) fail("operations 必须是非空数组。");
  if (operations.length > 50) fail("operations 一次最多 50 条。");

  return operations.map((entry, index) => {
    const where = `第 ${index} 条操作`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`${where}必须是对象。`);
    const raw = entry as Record<string, unknown>;
    if (raw.op === "delete") {
      for (const key of Object.keys(raw)) {
        if (raw[key] === undefined) continue;
        if (key !== "op" && key !== "id") fail(`${where}的 delete 不接受字段：${key}。`);
      }
      if (typeof raw.id !== "string" || raw.id.trim().length === 0) fail(`${where}缺少 id。`);
      return { op: "delete", id: raw.id };
    }
    if (raw.op !== "upsert") fail(`${where}的 op 只能是 upsert 或 delete。`);
    for (const key of Object.keys(raw)) {
      if (raw[key] === undefined) continue;
      if (!(UPSERT_FIELDS as readonly string[]).includes(key)) fail(`${where}不接受字段：${key}。`);
    }
    if (typeof raw.id !== "string" || raw.id.trim().length === 0) fail(`${where}缺少 id。`);
    /*
     * 形状在**这一层**校验：合并到现有记录之后才发现类型错误的话，
     * 报出来的是“配置无效”而不是“你提交的字段类型不对”。两者对用户是不同的问题。
     */
    for (const key of ["baseUrl", "model", "apiKeyEnv"] as const) {
      if (raw[key] !== undefined && typeof raw[key] !== "string") fail(`${where}的 ${key} 必须是字符串。`);
    }
    if (raw.local !== undefined && typeof raw.local !== "boolean") fail(`${where}的 local 必须是布尔值。`);
    if (
      raw.responseFormat !== undefined &&
      raw.responseFormat !== "json_schema" &&
      raw.responseFormat !== "json_object"
    ) {
      fail(`${where}的 responseFormat 只能是 json_schema / json_object。`);
    }
    let capabilities: Partial<Omit<ModelCapabilities, "tools">> | undefined;
    if (raw.capabilities !== undefined) {
      if (
        typeof raw.capabilities !== "object" ||
        raw.capabilities === null ||
        Array.isArray(raw.capabilities)
      ) {
        fail(`${where}的 capabilities 必须是对象。`);
      }
      const candidate = raw.capabilities as Record<string, unknown>;
      capabilities = {};
      for (const key of Object.keys(candidate)) {
        if (candidate[key] === undefined) continue;
        if (!(CAPABILITY_FIELDS as readonly string[]).includes(key)) {
          fail(`${where}的 capabilities 不接受字段：${key}。`);
        }
        if (typeof candidate[key] !== "boolean") {
          fail(`${where}的 capabilities.${key} 必须是布尔值。`);
        }
        capabilities[key as (typeof CAPABILITY_FIELDS)[number]] = candidate[key] as boolean;
      }
    }
    return {
      op: "upsert",
      id: raw.id,
      ...(raw.baseUrl !== undefined ? { baseUrl: raw.baseUrl as string } : {}),
      ...(raw.model !== undefined ? { model: raw.model as string } : {}),
      ...(raw.local !== undefined ? { local: raw.local as boolean } : {}),
      ...(raw.apiKeyEnv !== undefined ? { apiKeyEnv: raw.apiKeyEnv as string } : {}),
      ...(raw.responseFormat !== undefined
        ? { responseFormat: raw.responseFormat as ResponseFormat }
        : {}),
      ...(capabilities !== undefined ? { capabilities } : {})
    };
  });
}

/**
 * 应用操作批次：**未提供的受保护字段沿用该 id 现有记录**（不用空串或占位符覆盖）。
 * 结果整体走同一份严格解析与端点校验——写接口不维护第二套规则。
 */
function applyConfigOperations(
  records: ModelConfigRecord[],
  operations: ConfigOperation[]
): ModelConfigRecord[] {
  const fail: (detail: string) => never = (detail) => {
    throw new ModelConfigError("AI_CONFIG_INVALID", detail);
  };
  const next = new Map(records.map((record) => {
    const config = { ...record };
    return [record.id, config] as const;
  }));
  for (const operation of operations) {
    if (operation.op === "delete") {
      if (!next.delete(operation.id)) fail(`要删除的配置不存在：${operation.id}。`);
      continue;
    }
    const existing = next.get(operation.id);
    const { capabilities } = operation;
    next.set(operation.id, {
      ...(existing ?? ({} as ModelConfigRecord)),
      ...(operation.baseUrl !== undefined ? { baseUrl: operation.baseUrl } : {}),
      ...(operation.model !== undefined ? { model: operation.model } : {}),
      ...(operation.local !== undefined ? { local: operation.local } : {}),
      ...(operation.apiKeyEnv !== undefined ? { apiKeyEnv: operation.apiKeyEnv } : {}),
      ...(operation.responseFormat !== undefined
        ? { responseFormat: operation.responseFormat }
        : {}),
      ...(capabilities !== undefined
        ? {
            capabilities: {
              ...(existing?.capabilities ?? DEFAULT_CAPABILITIES),
              ...capabilities,
              // 工具调用本阶段关闭；经解析校验时统一落回 false。
              tools: false
            }
          }
        : {}),
      id: operation.id,
      provider: "openai-compatible"
    });
  }
  // 同一份校验：缺 apiKeyEnv（新增未提供）、非法端点、id 重复都在这里整批失败。
  const parsed = parseModelConfigRecords([...next.values()], apiConfigFail);
  for (const record of parsed) assertControlledEndpoint(record, false);
  return parsed;
}

export type ModelConfigStore = {
  /** 可公开的配置列表（不含密钥）。 */
  listPublic(): PublicModelConfig[];
  /** 公开列表 + 服务端判定的可用性（客户端据此区分“未配置/不可用”）。 */
  describe(): ConfigStatusEntry[];
  /** 按 ID 解析出完整配置；未知 ID、缺密钥、非法端点都明确失败。 */
  resolve(id: string): ResolvedModelConfig;
  /** 整体是否可用；未配置任何模型时为 false。 */
  enabled(): boolean;
  /** 当前配置层（来源 + 覆盖层版本号）；供 ETag 与“配置来自哪里”的如实展示。 */
  layer(): ModelConfigLayer;
  /** 写入版本令牌（revision + 内容摘要）；摘要必须参与比较，不能只比 revision。 */
  version(): string;
  /**
   * 保存一条**已校验形状**的操作批次：整批校验、整批落盘、不部分写入；
   * 没有声明覆盖文件时明确失败（`AI_CONFIG_READONLY`），不做内存态假保存。
   */
  saveOperations(operations: ConfigOperation[]): ModelConfigLayer;
};

function createConfigStore(
  env: EnvSource,
  records: ModelConfigRecord[],
  filePath: string | undefined,
  options: { allowInsecureRemote?: boolean }
): ModelConfigStore {
  function publicView(record: ModelConfigRecord): PublicModelConfig {
    return {
      id: record.id,
      provider: record.provider,
      baseUrl: record.baseUrl,
      model: record.model,
      local: record.local,
      ...(record.apiProtocol !== undefined ? { apiProtocol: record.apiProtocol } : {}),
      nativeSearch: resolveNativeSearchMode(record),
      capabilities: record.capabilities
    };
  }

  function layer(): ModelConfigLayer {
    const fromFile = overrideExists(filePath);
    return {
      source: fromFile ? "file" : records.length > 0 ? "env" : "none",
      enabled: records.length > 0,
      revision: fromFile && filePath ? readConfigRevision(filePath) : 0
    };
  }

  /** 按 ID 解析：读侧与 `describe` 共用同一份判定，不复制一套规则。 */
  function resolve(id: string): ResolvedModelConfig {
    const record = records.find((item) => item.id === id);
    if (!record) {
      throw new ModelConfigError("AI_CONFIG_UNKNOWN", `未知的模型配置 ID：${id}`);
    }
    assertControlledEndpoint(record, options.allowInsecureRemote === true);
    if (record.apiProtocol !== undefined && !isChatApiProtocol(record.apiProtocol)) throw new ModelConfigError("AI_CONFIG_UNKNOWN", "API 协议无效。");
    // beta scope 下零继承：env[apiKeyEnv] 回退仅用于非 beta（桌面单用户）路径。
    const apiKey = managedCredential(record) ?? (isBetaScopeActive() ? undefined : env[record.apiKeyEnv]);
    if (!apiKey || apiKey.length === 0) {
      // 缺密钥时明确不可用，不伪造调用成功。
      throw new ModelConfigError(
        "AI_KEY_MISSING",
        `配置 ${id} 的凭据环境变量 ${record.apiKeyEnv} 未设置。`
      );
    }
    return {
      ...publicView(record),
      apiKey,
      apiKeyEnv: record.apiKeyEnv,
      apiProtocol: record.apiProtocol ?? "openai-completions",
      responseFormat: record.responseFormat
    };
  }

  /** 可用性判定复用 `resolve`，只把失败收敛成稳定错误码（不带细节）。 */
  function describe(): ConfigStatusEntry[] {
    return records.map((record) => {
      try {
        resolve(record.id);
        return { config: publicView(record), usable: true };
      } catch (error) {
        return {
          config: publicView(record),
          usable: false,
          errorCode: error instanceof ModelConfigError ? error.code : "AI_CONFIG_UNKNOWN"
        };
      }
    });
  }

  /**
   * 配置版本令牌 = revision + **完整配置声明**摘要。
   *
   * 摘要覆盖规范化后的声明字段：`id/provider/baseUrl/model/apiKeyEnv/local/responseFormat/
   * capabilities`。**排除**真实密钥值（服务端从不持有密钥值，只有变量名）与派生的 `usable`
   * （可用性是运行态判定，不是配置声明；它变化不该让另一个标签页的保存变成冲突）。
   * 只哈希 HTTP 脱敏投影会漏掉端点、凭据引用与响应格式的变更，旧令牌就能覆盖外部更新。
   */
  function declarationDigest(revision: number): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          revision,
          configs: records.map((record) => ({
            id: record.id,
            provider: record.provider,
            baseUrl: record.baseUrl,
            model: record.model,
            apiKeyEnv: record.apiKeyEnv,
            local: record.local,
            apiProtocol: record.apiProtocol ?? "openai-completions",
            responseFormat: record.responseFormat,
            capabilities: record.capabilities
          }))
        })
      )
      .digest("hex")
      .slice(0, 16);
  }

  function version(): string {
    const revision = layer().revision;
    return `W/"rev-${revision}-${declarationDigest(revision)}"`;
  }

  return {
    listPublic() {
      return records.map(publicView);
    },
    describe,
    enabled() {
      return records.length > 0;
    },
    layer,
    version,
    saveOperations(operations) {
      if (!filePath) {
        // 只有环境变量配置时必须显式声明 `XINGJI_AI_CONFIG_FILE` 才允许自助修改。
        throw new ModelConfigError(
          "AI_CONFIG_READONLY",
          `未声明 ${CONFIG_FILE_ENV}，本进程不接受配置写入。`
        );
      }
      const merged = applyConfigOperations(records, operations);
      writeConfigFile(filePath, { revision: readConfigRevision(filePath) + 1, configs: merged });
      return { source: "file", enabled: merged.length > 0, revision: readConfigRevision(filePath) };
    },
    resolve
  };
}

/**
 * 记录里是否带本机密钥。`createConfigStore` 的解析、可用性判定与令牌摘要共用这一份判定。
 */
function managedCredential(record: ModelConfigRecord): string | undefined {
  const value = record.credential?.value;
  return value && value.length > 0 ? value : undefined;
}

export function createModelConfigStore(
  env: EnvSource,
  options: { allowInsecureRemote?: boolean } = {}
): ModelConfigStore {
  return createConfigStore(env, loadManagedModelConfigs(env), env[CONFIG_FILE_ENV], options);
}

/** Encrypted user document is authoritative; non-account deployments may use explicit environment declarations. */
export function loadManagedModelConfigs(env: EnvSource): ModelConfigRecord[] {
  const document = readSettingsDocument(resolveSettingsPaths(env));
  if (document) return chatRuntimeConfigs(document) as ModelConfigRecord[];
  return isBetaScopeActive() ? [] : loadModelConfigs(env);
}

/** 生产环境默认不开放：只有显式配置了模型时才可用。 */
export function isGatewayEnabled(store: ModelConfigStore): boolean {
  return store.enabled();
}
