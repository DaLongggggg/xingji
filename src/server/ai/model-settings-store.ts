import { CUSTOM_INSTRUCTIONS_LIMIT } from "@/features/ai/custom-instructions";
import type { ChatApiProtocol } from "@/features/ai/model-settings-contract";
import { parseSkillStates, parseSkillRemarks } from "@/features/ai/skill-settings-contract";
import { currentScopeEnv } from "./user-scope.ts";
/**
 * 本机自助模型配置：单份加密权威文档（对话 + 制图）。
 *
 * 边界（与任务书 §5 一致）：
 * - 密钥可由用户在浏览器输入并经同源管理请求提交；除此之外不进入浏览器持久存储、
 *   公开列表、响应、异常、日志、URL 或备份；
 * - 文档用 Node 内置 AES-256-GCM 加密（随机 nonce + 认证 tag），本机主密钥单独 0600 文件，
 *   首次显式保存时 `wx` 独占创建，**禁止覆盖**已有主密钥；
 * - 文档存在但主密钥缺失/解密失败 → 明确失败且零覆盖（不重建密钥、不回退空配置）；
 * - 运行时目录不进 Git/备份/导出：`.local/ai-settings/`，目录 0700、文件 0600。
 *
 * 不宣称能抵御已控制本机账户的攻击者；这是防“意外明文散落”，不是密钥管理平台。
 */
import {
  closeSync,
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import path from "node:path";

/** 运行时私有目录（相对项目根；`pnpm dev/start` 时即项目根）。 */
export const SETTINGS_DIR_ENV = "XINGJI_AI_SETTINGS_DIR";
// T2a：默认 env 经 currentScopeEnv 注入请求级用户路径。
export const DEFAULT_SETTINGS_DIR = path.join(".local", "ai-settings");

export const SETTINGS_DOCUMENT_FILE = "models.json";
export const SETTINGS_KEY_FILE = "master.key";

export type SettingsStoreErrorCode =
  | "AI_SETTINGS_DOC_UNREADABLE"
  | "AI_SETTINGS_DOC_CORRUPT"
  | "AI_SETTINGS_KEY_MISSING"
  | "AI_SETTINGS_DECRYPT_FAILED"
  | "AI_SETTINGS_READONLY"
  | "AI_SETTINGS_FORBIDDEN"
  | "AI_SETTINGS_INVALID";

export class SettingsStoreError extends Error {
  constructor(
    readonly code: SettingsStoreErrorCode,
    detail: string
  ) {
    super(`${code}:${detail}`);
    this.name = "SettingsStoreError";
  }
}

/** 固定安全文案：不输出路径、变量名或原始异常。 */
export const SETTINGS_ERROR_DETAIL: Record<SettingsStoreErrorCode, string> = {
  AI_SETTINGS_DOC_UNREADABLE: "本机模型配置暂时无法读取。",
  AI_SETTINGS_DOC_CORRUPT: "本机模型配置已损坏，未做任何改动。",
  AI_SETTINGS_KEY_MISSING: "本机主密钥缺失，无法解密已有配置；不会重建密钥或覆盖。",
  AI_SETTINGS_DECRYPT_FAILED: "本机模型配置无法解密，未做任何改动。",
  AI_SETTINGS_READONLY: "当前部署不允许在此修改模型配置。",
  AI_SETTINGS_INVALID: "提交的模型配置无效，请检查字段后重试。",
  /** 守卫拒绝（Host 非回环 / 跨源）：管理端点只允许电脑本机访问，手机经局域网读设置页会看到它。 */
  AI_SETTINGS_FORBIDDEN: "该管理接口只允许本机同源访问。"
};

export function settingsErrorDetail(code: string): string {
  return SETTINGS_ERROR_DETAIL[code as SettingsStoreErrorCode] ?? "本机模型配置操作失败。";
}

/** 文档里的凭据：只存值本身，且整体只在加密文档内。 */
export type StoredCredential = {
  /** 随机 ID；运行时不需要它，保留用于诊断与将来引用。 */
  id: string;
  value: string;
};

/** 对话模型提供方（一份提供方可声明多条模型）。 */
export type ChatProviderRecord = {
  kind: "chat";
  id: string;
  name: string;
  baseUrl: string;
  local: boolean;
  apiProtocol?: ChatApiProtocol;
  responseFormat: "json_schema" | "json_object";
  capabilities: { structuredOutput: boolean; stream: boolean; vision: boolean };
  /** 环境变量凭据引用（旧配置迁移而来）；用户在本机替换密钥后为 undefined。 */
  apiKeyEnv?: string;
  credential?: StoredCredential;
  models: {
    id: string; modelId: string; label: string; responseFormat?: "json_schema" | "json_object";
  }[];
};

/** 制图模型提供方（`apiKind` 目前只有 openai-images）。 */
export type ImageProviderRecord = {
  kind: "image";
  id: string;
  name: string;
  baseUrl: string;
  local: boolean;
  capabilities: { generate: boolean; edit: boolean };
  imageUrlHosts: string[];
  imageSizes: string[];
  /** 一次能接受的输入图张数上限；缺省 1（旧记录没有这个字段时按 1 处理）。 */
  maxSourceImages?: number;
  editMode: "edits-multipart" | "generations-image";
  imagesPath: string;
  watermark?: boolean;
  /** 见 `ImageConfigRecord.omitResponseFormat`：不下发 response_format（gpt-image 系列）。 */
  omitResponseFormat?: boolean;
  apiKeyEnv?: string;
  credential?: StoredCredential;
  models: { id: string; modelId: string; label: string }[];
};

export type ProviderRecord = ChatProviderRecord | ImageProviderRecord;

/** 加密文档载荷：revision + 两类提供方声明 + 可选权限与 Skill 开关。 */
export type SettingsDocument = {
  schema: 1;
  revision: number;
  providers: ProviderRecord[];
  /** Account-wide preferences for subsequent workbench requests; empty by default. */
  customInstructions?: string;
  permissions?: { ai: boolean; images: boolean };
  /**
   * 用户对 Skill 的开关（可选字段：旧文档缺省即既有默认启用）。
   * 业务含义与白名单见 `features/ai/skill-settings-contract`。
   */
  skillStates?: import("@/features/ai/skill-settings-contract").SkillStateMap;
  /** Optional UI annotation, compatible with existing schema-1 documents. */
  skillRemarks?: import("@/features/ai/skill-settings-contract").SkillRemarkMap;
};

export type SettingsPaths = {
  dir: string;
  document: string;
  key: string;
  lock: string;
};

/** 解析运行时目录：显式环境变量优先，便于测试注入 /tmp 隔离目录。 */
export function resolveSettingsPaths(env: Record<string, string | undefined> = currentScopeEnv()): SettingsPaths {
  const dir = env[SETTINGS_DIR_ENV] && env[SETTINGS_DIR_ENV]!.trim().length > 0
    ? env[SETTINGS_DIR_ENV]!
    : DEFAULT_SETTINGS_DIR;
  return {
    dir,
    document: path.join(dir, SETTINGS_DOCUMENT_FILE),
    key: path.join(dir, SETTINGS_KEY_FILE),
    lock: path.join(dir, `${SETTINGS_DOCUMENT_FILE}.lock`)
  };
}

function readDocumentText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    // 只有 ENOENT 表示“尚未创建文档”；其余读取错误明确失败，不回退空配置。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SettingsStoreError("AI_SETTINGS_DOC_UNREADABLE", "文档无法读取。");
  }
}

/** 读取并校验主密钥。缺失 → KEY_MISSING（**不**自动创建）。 */
function readMasterKey(file: string): Buffer {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SettingsStoreError("AI_SETTINGS_KEY_MISSING", "主密钥不存在。");
    }
    throw new SettingsStoreError("AI_SETTINGS_DOC_UNREADABLE", "主密钥无法读取。");
  }
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) throw new SettingsStoreError("AI_SETTINGS_DECRYPT_FAILED", "主密钥长度无效。");
  return key;
}

/** 首次显式保存时独占创建主密钥；已存在则原样复用，绝不覆盖。 */
function ensureMasterKey(file: string): Buffer {
  try {
    return readMasterKey(file);
  } catch (error) {
    if (!(error instanceof SettingsStoreError) || error.code !== "AI_SETTINGS_KEY_MISSING") throw error;
  }
  const key = randomBytes(32);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let handle: number | null = null;
  try {
    handle = openSync(file, "wx", 0o600);
    writeFileSync(handle, `${key.toString("base64")}\n`, { encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // 并发首次保存：另一个写入方已创建主密钥，复用它的（不覆盖）。
      if (handle !== null) closeSync(handle);
      return readMasterKey(file);
    }
    if (handle !== null) closeSync(handle);
    throw new SettingsStoreError("AI_SETTINGS_READONLY", "主密钥无法创建。");
  }
  closeSync(handle);
  return key;
}

function decryptPayload(raw: string, key: Buffer): unknown {
  let envelope: { v?: unknown; nonce?: unknown; tag?: unknown; data?: unknown };
  try {
    envelope = JSON.parse(raw) as typeof envelope;
  } catch {
    throw new SettingsStoreError("AI_SETTINGS_DOC_CORRUPT", "文档不是有效 JSON。");
  }
  if (
    !envelope ||
    envelope.v !== 1 ||
    typeof envelope.nonce !== "string" ||
    typeof envelope.tag !== "string" ||
    typeof envelope.data !== "string"
  ) {
    throw new SettingsStoreError("AI_SETTINGS_DOC_CORRUPT", "文档信封字段无效。");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64")),
      decipher.final()
    ]);
    return JSON.parse(plain.toString("utf8"));
  } catch {
    // 认证失败与明文损坏都归到这里：绝不回退旧配置，也不重建密钥。
    throw new SettingsStoreError("AI_SETTINGS_DECRYPT_FAILED", "解密或认证失败。");
  }
}

function encryptPayload(payload: SettingsDocument, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const data = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
    cipher.final()
  ]);
  return JSON.stringify({
    v: 1,
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64")
  });
}

function assertDocumentShape(value: unknown): SettingsDocument {
  const doc = value as Partial<SettingsDocument> | null;
  if (
    !doc ||
    typeof doc !== "object" ||
    doc.schema !== 1 ||
    typeof doc.revision !== "number" ||
    !Number.isInteger(doc.revision) ||
    !Array.isArray(doc.providers) ||
    (doc.customInstructions !== undefined && (typeof doc.customInstructions !== "string" || doc.customInstructions.length > CUSTOM_INSTRUCTIONS_LIMIT)) ||
    (doc.permissions !== undefined && (!doc.permissions || typeof doc.permissions.ai !== "boolean" || typeof doc.permissions.images !== "boolean"))
  ) {
    throw new SettingsStoreError("AI_SETTINGS_DOC_CORRUPT", "文档结构无效。");
  }
  for (const provider of doc.providers) {
    if (!provider || !Array.isArray(provider.models)) continue;
    if (provider.models.some(model => model && typeof model === "object" && "nativeSearch" in model)) {
      throw new SettingsStoreError("AI_SETTINGS_DOC_CORRUPT", "文档里的内置搜索模式无效。");
    }
  }
  /*
   * Skill 开关：未知 ID 或非法值一律判为损坏（返回 undefined）。
   * 这里**不**做“清洗后接受”，也不会因此把条目当成默认启用。
   */
  if (parseSkillStates(doc.skillStates) === undefined) {
    throw new SettingsStoreError("AI_SETTINGS_DOC_CORRUPT", "文档里的 Skill 状态无效。");
  }
  if (parseSkillRemarks(doc.skillRemarks) === undefined) {
    throw new SettingsStoreError("AI_SETTINGS_DOC_CORRUPT", "文档里的 Skill 备注无效。");
  }
  return doc as SettingsDocument;
}

/** 文档是否存在（决定“首次创建”路径与 GET 的 writable 语义）。 */
export function settingsDocumentExists(paths: SettingsPaths): boolean {
  return existsSync(paths.document);
}

/**
 * 读取文档。
 * - 不存在 → `undefined`（调用方据此回退旧的覆盖层/环境声明）；
 * - 存在但读不动/损坏/解不开 → 抛出稳定码，**不**回退、**不**覆盖。
 */
export function readSettingsDocument(
  paths: SettingsPaths = resolveSettingsPaths()
): SettingsDocument | undefined {
  const raw = readDocumentText(paths.document);
  if (raw === undefined) return undefined;
  const key = readMasterKey(paths.key);
  return assertDocumentShape(decryptPayload(raw, key));
}

/**
 * 写入文档：需要主密钥（首次自动独占创建）、同目录临时文件 + rename 原子替换。
 * 与既有的配置覆盖层同一套“原子写 + 单进程锁”思路，不另造队列。
 */
export function writeSettingsDocument(
  document: SettingsDocument,
  paths: SettingsPaths = resolveSettingsPaths()
): void {
  /*
   * 文档已存在却没有主密钥：**必须失败且零覆盖**。
   * 若在这里新建主密钥，旧文档会被新密钥下的新内容替换，等于悄悄丢掉原有配置——
   * 这正是任务书禁止的“重建密钥 / 回退成空配置”路径。
   */
  if (settingsDocumentExists(paths) && !existsSync(paths.key)) {
    throw new SettingsStoreError("AI_SETTINGS_KEY_MISSING", "文档存在但主密钥缺失。");
  }
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  chmodSync(paths.dir, 0o700);
  const key = ensureMasterKey(paths.key);
  const temp = `${paths.document}.${process.pid}.tmp`;
  try {
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    writeFileSync(temp, `${encryptPayload(document, key)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, paths.document);
  } catch (error) {
    rmSync(temp, { force: true });
    if (error instanceof SettingsStoreError) throw error;
    throw new SettingsStoreError("AI_SETTINGS_READONLY", "文档无法写入。");
  }
}

/** 生成稳定 ID（服务端生成，客户端不改）。 */
export function newProviderId(kind: ProviderRecord["kind"]): string {
  return `${kind}-${randomBytes(6).toString("hex")}`;
}

export function newModelId(kind: ProviderRecord["kind"]): string {
  return `m-${kind}-${randomBytes(6).toString("hex")}`;
}

export function newCredentialId(): string {
  return `cred-${randomBytes(6).toString("hex")}`;
}

/** Read only the current account document; damaged storage fails instead of pretending preferences are empty. */
export function readCustomInstructions(env: Record<string, string | undefined> = currentScopeEnv()): string {
  return readSettingsDocument(resolveSettingsPaths(env))?.customInstructions ?? "";
}
