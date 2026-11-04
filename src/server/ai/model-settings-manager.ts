import { isChatApiProtocol } from "@/features/ai/model-settings-contract";
/** Encrypted settings document management: validation, revisions and redacted views.
 * Deployment environment declarations are resolved only by runtime config stores; never adopted here.
 */
import {
  newCredentialId,
  newModelId,
  newProviderId,
  readSettingsDocument,
  resolveSettingsPaths,
  type ChatProviderRecord,
  type ImageProviderRecord,
  type ProviderRecord,
  type SettingsDocument,
  type SettingsPaths
} from "./model-settings-store";
import type {
  ManagedProvider,
  ModelSettingsView,
  ProviderKind,
  ProviderOperation
} from "@/features/ai/model-settings-contract";
import { IMAGE_SIZES } from "@/features/creation/creation-image-limits";
import { ModelConfigError, type EnvSource } from "./model-config";
import { isBetaScopeActive } from "./user-scope.ts";
import { createHash } from "node:crypto";

export const SETTINGS_SCHEMA_VERSION = 1;

/** 校验/迁移用的稳定错误码（与 store 的错误码合并到同一套文案表）。 */
export class SettingsValidationError extends Error {
  constructor(
    readonly code: "AI_SETTINGS_INVALID" | "AI_SETTINGS_READONLY" | "AI_SETTINGS_CONFLICT",
    detail: string
  ) {
    super(`${code}:${detail}`);
    this.name = "SettingsValidationError";
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const CAPABILITY_KEYS = ["structuredOutput", "stream", "vision"] as const;
const IMAGE_CAPABILITY_KEYS = ["generate", "edit"] as const;
const UPSERT_FIELDS = [
  "op",
  "kind",
  "id",
  "name",
  "baseUrl",
  "local",
  "models",
  "credential",
  "responseFormat",
  "apiProtocol",
  "capabilities",
  "imageCapabilities",
  "imageSizes",
  "maxSourceImages",
  "editMode",
  "imagesPath",
  "watermark",
  "omitResponseFormat",
  "imageUrlHosts"
] as const;

/**
 * 输入图张数上限：1..16 的整数；缺省 1（只接受单张）。
 * 上限只放宽不猜——声明多少就是多少，超过由路由与 provider 拒绝。
 */
function parseMaxSourceImages(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 16)
    fail("maxSourceImages 必须是 1..16 的整数。");
  return value;
}

function fail(detail: string): never {
  throw new SettingsValidationError("AI_SETTINGS_INVALID", detail);
}

/**
 * API 地址校验：只允许 http/https；**禁止** URL 内嵌账号密码/令牌，
 * 也禁止 query/fragment 携带凭据（地址本身会下发给管理视图，必须干净）。
 */
export function assertCleanBaseUrl(raw: unknown, local: boolean): string {
  if (typeof raw !== "string" || raw.trim().length === 0) fail("API 地址不能为空。");
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("API 地址不是有效 URL。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") fail("API 地址只允许 http/https。");
  if (url.username || url.password) fail("API 地址不能内嵌账号或密码。");
  if (url.search || url.hash) fail("API 地址不能携带 query 或 fragment。");
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (local && !loopback) fail("声明为本地端点时必须是回环地址。");
  if (!loopback && url.protocol !== "https:") fail("远程地址必须使用 https。");
  return value;
}

function assertName(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) fail("提供方名称不能为空。");
  if (raw.trim().length > 60) fail("提供方名称过长。");
  return raw.trim();
}

function parseImageSizes(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail("允许尺寸必须是数组。");
  const sizes = raw.map((entry) => {
    if (typeof entry !== "string" || !/^\d{2,5}x\d{2,5}$/.test(entry.trim())) fail("尺寸只接受 `宽x高`。");
    return entry.trim();
  });
  return sizes;
}

function parseUrlHosts(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail("下载主机必须是数组。");
  return raw.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) fail("下载主机必须是字符串。");
    const host = entry.trim().toLowerCase();
    const bare = host.startsWith("*.") ? host.slice(2) : host;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(bare)) fail("下载主机只接受主机名或 *.suffix。");
    return host;
  });
}

function parseModels(raw: unknown): { id?: string; modelId: string; label: string }[] {
  if (!Array.isArray(raw) || raw.length === 0) fail("一个提供方至少需要一条模型。");
  const seen = new Set<string>();
  return raw.map((entry) => {
    const candidate = entry as { id?: unknown; modelId?: unknown; label?: unknown } | null;
    if (!candidate || typeof candidate !== "object") fail("模型条目必须是对象。");
    if (typeof candidate.modelId !== "string" || candidate.modelId.trim().length === 0) {
      fail("模型 ID 不能为空。");
    }
    const modelId = candidate.modelId.trim();
    if (seen.has(modelId)) fail(`同一提供方内模型 ID 重复：${modelId}。`);
    seen.add(modelId);
    if (candidate.id !== undefined && (typeof candidate.id !== "string" || candidate.id.length === 0)) {
      fail("模型内部 ID 无效。");
    }
    if (candidate.label !== undefined && typeof candidate.label !== "string") fail("显示名称必须是字符串。");
    if (Object.keys(candidate).some(key => !["id", "modelId", "label"].includes(key))) fail("模型条目含未知字段。");
    return {
      ...(typeof candidate.id === "string" && candidate.id ? { id: candidate.id } : {}),
      modelId,
      label: typeof candidate.label === "string" ? candidate.label.trim() : ""
    };
  });
}

/** 操作批次形状校验（**只做形状**，跨记录语义在 applyOperations 里整批判定）。 */
export function parseProviderOperations(payload: unknown): ProviderOperation[] {
  const body = payload as { baseRevision?: unknown; operations?: unknown } | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("请求体必须是对象。");
  for (const key of Object.keys(body)) {
    if (key !== "operations" && key !== "baseRevision" && (body as Record<string, unknown>)[key] !== undefined) {
      fail(`不接受的字段：${key}。`);
    }
  }
  if (!Array.isArray(body.operations) || body.operations.length === 0) fail("operations 必须是非空数组。");
  if (body.operations.length > 50) fail("一次最多 50 条操作。");

  return body.operations.map((entry, index) => {
    const where = `第 ${index} 条操作`;
    const raw = entry as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${where}必须是对象。`);
    if (raw.kind !== "chat" && raw.kind !== "image") fail(`${where}的 kind 只能是 chat 或 image。`);
    const kind: ProviderKind = raw.kind;

    if (raw.op === "delete") {
      for (const key of Object.keys(raw)) {
        if (raw[key] === undefined) continue;
        if (key !== "op" && key !== "kind" && key !== "id") fail(`${where}的 delete 不接受字段：${key}。`);
      }
      if (typeof raw.id !== "string" || raw.id.length === 0) fail(`${where}缺少 id。`);
      return { op: "delete", kind, id: raw.id };
    }
    if (raw.op !== "upsert") fail(`${where}的 op 只能是 upsert 或 delete。`);
    for (const key of Object.keys(raw)) {
      if (raw[key] === undefined) continue;
      if (!(UPSERT_FIELDS as readonly string[]).includes(key)) fail(`${where}不接受字段：${key}。`);
    }
    if (raw.id !== undefined && (typeof raw.id !== "string" || !raw.id.trim())) fail("提供方身份无效。");
    if (typeof raw.local !== "boolean") fail("local必须是布尔值。");
    const name = assertName(raw.name);
    const local = raw.local === true;
    const baseUrl = assertCleanBaseUrl(raw.baseUrl, local);
    const models = parseModels(raw.models);

    let credential: { action: "replace"; value: string } | { action: "clear" } | undefined;
    if (raw.credential !== undefined) {
      const candidate = raw.credential as { action?: unknown; value?: unknown } | null;
      if (!candidate || typeof candidate !== "object") fail(`${where}的 credential 必须是对象。`);
      if (candidate.action === "clear") {
        credential = { action: "clear" };
      } else if (candidate.action === "replace") {
        // 空串与星号都不算“替换新的密钥”：避免用占位符覆盖既有凭据。
        if (typeof candidate.value !== "string" || candidate.value.trim().length === 0) {
          fail(`${where}的替换密钥不能为空。`);
        }
        if (/^\*+$/.test(candidate.value.trim())) fail(`${where}的替换密钥不能是星号占位符。`);
        credential = { action: "replace", value: candidate.value };
      } else {
        fail(`${where}的 credential.action 只能是 replace 或 clear。`);
      }
    }

    if (kind === "chat") {
      if (raw.apiProtocol !== undefined && !isChatApiProtocol(raw.apiProtocol)) fail("API 协议无效。");
      const capabilities = raw.capabilities as Record<string, unknown> | undefined;
      if (capabilities !== undefined) {
        if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
          fail(`${where}的 capabilities 必须是对象。`);
        }
        for (const key of Object.keys(capabilities)) {
          if (capabilities[key] === undefined) continue;
          if (!(CAPABILITY_KEYS as readonly string[]).includes(key)) {
            fail(`${where}的 capabilities 不接受字段：${key}。`);
          }
          if (typeof capabilities[key] !== "boolean") fail(`${where}的 capabilities.${key} 必须是布尔值。`);
        }
      }
      if (
        raw.responseFormat !== undefined &&
        raw.responseFormat !== "json_schema" &&
        raw.responseFormat !== "json_object"
      ) {
        fail(`${where}的 responseFormat 无效。`);
      }
      if (
        raw.imageCapabilities !== undefined ||
        raw.imageSizes !== undefined ||
        raw.editMode !== undefined ||
        raw.omitResponseFormat !== undefined
      ) {
        fail(`${where}把制图专用字段提交到了对话模型。`);
      }
      return {
        op: "upsert",
        kind,
        ...(typeof raw.id === "string" && raw.id ? { id: raw.id } : {}),
        name,
        baseUrl,
        local,
        models,
        ...(credential ? { credential } : {}),
        ...(isChatApiProtocol(raw.apiProtocol) ? { apiProtocol: raw.apiProtocol } : {}),
        ...(raw.responseFormat !== undefined
          ? { responseFormat: raw.responseFormat as "json_schema" | "json_object" }
          : {}),
        ...(capabilities
          ? {
              capabilities: {
                ...(typeof capabilities.structuredOutput === "boolean"
                  ? { structuredOutput: capabilities.structuredOutput }
                  : {}),
                ...(typeof capabilities.stream === "boolean" ? { stream: capabilities.stream } : {}),
                ...(typeof capabilities.vision === "boolean" ? { vision: capabilities.vision } : {})
              }
            }
          : {})
      };
    }

    if (raw.apiProtocol !== undefined || raw.capabilities !== undefined || raw.responseFormat !== undefined) {
      fail(`${where}把对话专用字段提交到了制图模型。`);
    }
    const imageCapabilities = raw.imageCapabilities as Record<string, unknown> | undefined;
    if (imageCapabilities !== undefined) {
      if (!imageCapabilities || typeof imageCapabilities !== "object" || Array.isArray(imageCapabilities)) {
        fail(`${where}的 imageCapabilities 必须是对象。`);
      }
      for (const key of Object.keys(imageCapabilities)) {
        if (imageCapabilities[key] === undefined) continue;
        if (!(IMAGE_CAPABILITY_KEYS as readonly string[]).includes(key)) {
          fail(`${where}的 imageCapabilities 不接受字段：${key}。`);
        }
        if (typeof imageCapabilities[key] !== "boolean") fail(`${where}的 imageCapabilities.${key} 必须是布尔值。`);
      }
    }
    if (raw.omitResponseFormat !== undefined && typeof raw.omitResponseFormat !== "boolean") {
      fail(`${where}的 omitResponseFormat 必须是布尔值。`);
    }
    if (
      raw.editMode !== undefined &&
      raw.editMode !== "edits-multipart" &&
      raw.editMode !== "generations-image"
    ) {
      fail(`${where}的 editMode 无效。`);
    }
    if (raw.imagesPath !== undefined && (typeof raw.imagesPath !== "string" || !raw.imagesPath.startsWith("/"))) {
      fail(`${where}的 imagesPath 必须以 / 开头。`);
    }
    return {
      op: "upsert",
      kind,
      ...(typeof raw.id === "string" && raw.id ? { id: raw.id } : {}),
      name,
      baseUrl,
      local,
      models,
      ...(credential ? { credential } : {}),
      ...(imageCapabilities
        ? {
            imageCapabilities: {
              ...(typeof imageCapabilities.generate === "boolean"
                ? { generate: imageCapabilities.generate }
                : {}),
              ...(typeof imageCapabilities.edit === "boolean" ? { edit: imageCapabilities.edit } : {})
            }
          }
        : {}),
      ...(raw.imageSizes !== undefined ? { imageSizes: parseImageSizes(raw.imageSizes) } : {}),
      ...(raw.maxSourceImages !== undefined
        ? { maxSourceImages: parseMaxSourceImages(raw.maxSourceImages) }
        : {}),
      ...(raw.editMode !== undefined
        ? { editMode: raw.editMode as "edits-multipart" | "generations-image" }
        : {}),
      ...(raw.imagesPath !== undefined ? { imagesPath: raw.imagesPath as string } : {}),
      ...(raw.watermark !== undefined ? { watermark: raw.watermark === true } : {}),
      ...(raw.omitResponseFormat !== undefined
        ? { omitResponseFormat: raw.omitResponseFormat === true }
        : {}),
      ...(raw.imageUrlHosts !== undefined ? { imageUrlHosts: parseUrlHosts(raw.imageUrlHosts) } : {})
    };
  });
}

/** Missing development documents start empty; no historical declaration adoption. */
export function loadEffectiveDocument(env: EnvSource, paths: SettingsPaths = resolveSettingsPaths(env)): { document: SettingsDocument } {
  return { document: readSettingsDocument(paths) ?? { schema: SETTINGS_SCHEMA_VERSION, revision: 0, providers: [] } };
}

/** 凭据是否可用：环境引用看环境变量是否存在；本机凭据看是否存了非空值。 */
function credentialState(provider: ProviderRecord, env: EnvSource) {
  if (provider.credential && provider.credential.value.length > 0) {
    return { configured: true, source: "local" as const };
  }
  /*
   * T2a：beta 用户不继承全局环境凭据——env 引用一律按「未配置」呈现，
   * 管理视图不能因为部署进程带着同名变量就显示凭据可用。
   */
  if (
    provider.apiKeyEnv &&
    !isBetaScopeActive() &&
    typeof env[provider.apiKeyEnv] === "string" &&
    env[provider.apiKeyEnv]!.length > 0
  ) {
    return { configured: true, source: "environment" as const };
  }
  if (provider.apiKeyEnv) return { configured: false, source: "environment" as const };
  return { configured: false, source: "none" as const };
}

/** 文档 → 管理视图里的提供方（**不含**密钥值与环境变量名）。 */
export function toManagedProvider(provider: ProviderRecord, env: EnvSource): ManagedProvider {
  const credential = credentialState(provider, env);
  const base: ManagedProvider = {
    id: provider.id,
    kind: provider.kind,
    name: provider.name,
    baseUrl: provider.baseUrl,
    local: provider.local,
    credentialConfigured: credential.configured,
    credentialSource: credential.source,
    models: provider.models.map((model) => ({
      id: model.id,
      modelId: model.modelId,
      label: model.label
    }))
  };
  if (provider.kind === "chat") {
    return {
      ...base,
      apiProtocol: provider.apiProtocol ?? "openai-completions",
      responseFormat: provider.responseFormat,
      capabilities: { ...provider.capabilities }
    };
  }
  return {
    ...base,
    imageCapabilities: { ...provider.capabilities },
    imageSizes: provider.imageSizes.length > 0 ? [...provider.imageSizes] : [...IMAGE_SIZES],
    maxSourceImages: provider.maxSourceImages ?? 1,
    editMode: provider.editMode,
    imagesPath: provider.imagesPath,
    ...(provider.watermark !== undefined ? { watermark: provider.watermark } : {}),
    ...(provider.omitResponseFormat !== undefined
      ? { omitResponseFormat: provider.omitResponseFormat }
      : {}),
    imageUrlHosts: [...provider.imageUrlHosts]
  };
}

/** Current encrypted document revision; GET and writes use the same declaration digest. */
export function currentSettingsRevision(
  env: EnvSource,
  paths: SettingsPaths = resolveSettingsPaths(env)
): { document: SettingsDocument; revision: string } {
  const loaded = loadEffectiveDocument(env, paths);
  return { document: loaded.document, revision: settingsRevisionToken(loaded.document) };
}

/** 版本令牌：revision + **声明**摘要（不含密钥值，也不含可用性派生位）。 */
export function settingsRevisionToken(document: SettingsDocument): string {
  const declaration = document.providers.map((provider) => ({
    kind: provider.kind,
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    local: provider.local,
    apiKeyEnv: provider.apiKeyEnv,
    // 密钥变化通过随机凭据 ID 体现，而不是把密钥值或可离线猜解的散列写进令牌。
    credentialId: provider.credential?.id,
    models: provider.models.map((model) => ({ id: model.id, modelId: model.modelId, label: model.label })),
    ...(provider.kind === "chat"
      ? {
          apiProtocol: provider.apiProtocol ?? "openai-completions",
          responseFormat: provider.responseFormat,
          capabilities: provider.capabilities
        }
      : {
          capabilities: provider.capabilities,
          imageSizes: provider.imageSizes,
          maxSourceImages: provider.maxSourceImages ?? 1,
          editMode: provider.editMode,
          imagesPath: provider.imagesPath,
          watermark: provider.watermark,
          omitResponseFormat: provider.omitResponseFormat,
          imageUrlHosts: provider.imageUrlHosts
        })
  }));
  // Skill 开关也进版本令牌：同一 revision 下改过 Skill 状态必须算出不同令牌。
  const digest = createTokenDigest(JSON.stringify({
    revision: document.revision,
    providers: declaration,
    permissions: document.permissions,
    skillStates: document.skillStates ?? {},
    skillRemarks: document.skillRemarks ?? {},
    customInstructions: document.customInstructions ?? ""
  }));
  return `W/"srev-${document.revision}-${digest}"`;
}

/** 与既有配置令牌同一实现（sha256 前 16 位），不引入新依赖。 */
function createTokenDigest(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/** 管理 GET 视图。 */
export function buildSettingsView(
  document: SettingsDocument,
  env: EnvSource,
  options: { writable: boolean; readOnlyReason?: string }
): ModelSettingsView {
  return {
    ok: true,
    revision: settingsRevisionToken(document),
    writable: options.writable,
    ...(options.readOnlyReason ? { readOnlyReason: options.readOnlyReason } : {}),
    chat: document.providers.filter((p) => p.kind === "chat").map((p) => toManagedProvider(p, env)),
    image: document.providers.filter((p) => p.kind === "image").map((p) => toManagedProvider(p, env))
  };
}

/** configs 写入口按模型配置 ID 做局部更新，保留未涉及的模型和凭据。 */
export function configOperationsToProviders(
  document: SettingsDocument,
  operations: { op: "upsert" | "delete"; id: string; baseUrl?: string; model?: string; apiKeyEnv?: string; local?: boolean; responseFormat?: "json_schema" | "json_object"; capabilities?: Partial<{ structuredOutput: boolean; stream: boolean; vision: boolean }> }[]
): ChatProviderRecord[] {
  const next = document.providers.filter((p): p is ChatProviderRecord => p.kind === "chat")
    .map(p => ({ ...p, capabilities: { ...p.capabilities }, models: p.models.map(m => ({ ...m })) }));
  for (const op of operations) {
    const index = next.findIndex(p => p.models.some(m => m.id === op.id));
    const existing = next[index];
    const model = existing?.models.find(m => m.id === op.id);
    if (op.op === "delete") {
      if (!existing) fail("要删除的模型不存在。");
      existing.models = existing.models.filter(m => m.id !== op.id);
      if (!existing.models.length) next.splice(index, 1);
      continue;
    }
    if (op.baseUrl !== undefined && !op.baseUrl.trim()) fail("端点不能为空。");
    if (!existing && !op.apiKeyEnv) fail("新增配置必须提供凭据引用。");
    if (op.apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(op.apiKeyEnv)) fail("凭据引用无效。");
    const modelId = op.model ?? model?.modelId ?? "";
    if (!modelId.trim()) fail("模型不能为空。");
    const base: ChatProviderRecord = {
      kind: "chat",
      // 单模型接口改共享字段时拆出目标模型，不能顺带修改兄弟模型。
      id: existing?.models.length === 1 ? existing.id : newProviderId("chat"),
      name: op.model ?? existing?.name ?? op.id,
      baseUrl: op.baseUrl ?? existing?.baseUrl ?? "",
      local: op.local ?? existing?.local ?? false,
      apiProtocol: existing?.apiProtocol ?? "openai-completions",
      responseFormat: op.responseFormat ?? model?.responseFormat ?? existing?.responseFormat ?? "json_schema",
      capabilities: {
        structuredOutput: op.capabilities?.structuredOutput ?? existing?.capabilities.structuredOutput ?? true,
        stream: op.capabilities?.stream ?? existing?.capabilities.stream ?? false,
        vision: op.capabilities?.vision ?? existing?.capabilities.vision ?? false
      },
      ...(op.apiKeyEnv !== undefined ? { apiKeyEnv: op.apiKeyEnv }
        : { ...(existing?.apiKeyEnv ? { apiKeyEnv: existing.apiKeyEnv } : {}),
            ...(existing?.credential ? { credential: existing.credential } : {}) }),
      models: [{ id: op.id, modelId, label: op.model ?? model?.label ?? modelId }]
    };
    try { assertCleanBaseUrl(base.baseUrl, base.local); }
    catch { throw new ModelConfigError("AI_ENDPOINT_INVALID", "模型端点无效。"); }
    if (existing?.models.length === 1) next[index] = base;
    else {
      if (existing) existing.models = existing.models.filter(m => m.id !== op.id);
      next.push(base);
    }
  }
  return next;
}

/**
 * 应用操作批次：**整批校验后**返回新文档；调用方负责在锁内落盘。
 * 未提供的字段沿用现有提供方；凭据缺省 = 保留（空串/星号在解析阶段已拒绝）。
 */
export function applyProviderOperations(
  document: SettingsDocument,
  operations: ProviderOperation[],
  /**
   * `allowExplicitNewIds`：**仅服务端桥接**使用。
   * `/api/ai/configs` 的现行写契约由调用方给出配置 ID，文档操作沿用该 ID；
   * 管理接口（客户端提交）不传这个开关，未知 ID 因此仍然整批拒绝——
   * 客户端不能凭空指定服务端身份。
   */
  options: { allowExplicitNewIds?: boolean } = {}
): SettingsDocument {
  const providers: ProviderRecord[] = document.providers.map((provider) => ({
    ...provider,
    models: provider.models.map(model => ({ ...model })),
    capabilities: { ...provider.capabilities },
    ...(provider.kind === "image"
      ? { imageSizes: [...provider.imageSizes], imageUrlHosts: [...provider.imageUrlHosts] }
      : {})
  })) as ProviderRecord[];

  for (const operation of operations) {
    if (operation.op === "delete") {
      const index = providers.findIndex((p) => p.id === operation.id && p.kind === operation.kind);
      if (index < 0) fail(`要删除的提供方不存在：${operation.id}。`);
      if (providers[index].kind !== operation.kind) fail(`提供方类别不匹配：${operation.id}。`);
      providers.splice(index, 1);
      continue;
    }

    /*
     * `id` 的含义：命中现有提供方就是更新；没命中就是**新增并采用该 ID 作为稳定身份**
     * （`/api/ai/configs` 写契约由调用方给出配置 ID，内部仍须保持一致）。
     * 没带 `id` 的新增由服务端生成 ID——同名不意味着同一提供方。
     */
    const existingIndex = operation.id ? providers.findIndex((p) => p.id === operation.id && p.kind === operation.kind) : -1;
    if (operation.id && existingIndex < 0 && options.allowExplicitNewIds !== true) {
      fail(`要编辑的提供方不存在：${operation.id}。`);
    }
    const existing = existingIndex >= 0 ? providers[existingIndex] : undefined;
    if (existing && existing.kind !== operation.kind) fail(`提供方类别不匹配：${operation.id}。`);

    const providerId = operation.id ?? newProviderId(operation.kind);
    const seenModels = new Set<string>();
    const models = operation.models.map((model) => {
      if (model.id && !existing?.models.some(item => item.id === model.id)) {
        fail("模型不属于该提供方。");
      }
      const id = model.id ?? newModelId(operation.kind);
      if (seenModels.has(id)) fail("模型身份重复。");
      seenModels.add(id);
      return { id, modelId: model.modelId, label: model.label ?? "" };
    });

    const credential =
      operation.credential === undefined
        ? existing?.credential
        : operation.credential.action === "clear"
          ? undefined
          : { id: newCredentialId(), value: operation.credential.value };

    if (operation.kind === "chat") {
      const base: ChatProviderRecord = {
        kind: "chat",
        id: existing?.id ?? providerId,
        name: operation.name,
        baseUrl: operation.baseUrl,
        local: operation.local,
        apiProtocol: operation.apiProtocol ?? (existing as ChatProviderRecord | undefined)?.apiProtocol ?? "openai-completions",
        responseFormat: operation.responseFormat ?? (existing as ChatProviderRecord | undefined)?.responseFormat ?? "json_schema",
        capabilities: {
          structuredOutput: operation.capabilities?.structuredOutput ?? (existing as ChatProviderRecord | undefined)?.capabilities.structuredOutput ?? true,
          stream: operation.capabilities?.stream ?? (existing as ChatProviderRecord | undefined)?.capabilities.stream ?? false,
          vision: operation.capabilities?.vision ?? (existing as ChatProviderRecord | undefined)?.capabilities.vision ?? false
        },
        // 替换或清除凭据时同时解除旧环境引用，不能在清除后恢复旧密钥。
        ...(operation.credential === undefined && (operation.apiKeyEnv ?? existing?.apiKeyEnv)
          ? { apiKeyEnv: operation.apiKeyEnv ?? existing?.apiKeyEnv } : {}),
        ...(credential ? { credential } : {}),
        models
      };
      if (existingIndex >= 0) providers[existingIndex] = base;
      else providers.push(base);
      continue;
    }

    const previous = existing as ImageProviderRecord | undefined;
    const imageBase: ImageProviderRecord = {
      kind: "image",
      id: previous?.id ?? providerId,
      name: operation.name,
      baseUrl: operation.baseUrl,
      local: operation.local,
      capabilities: {
        generate: operation.imageCapabilities?.generate ?? previous?.capabilities.generate ?? true,
        edit: operation.imageCapabilities?.edit ?? previous?.capabilities.edit ?? true
      },
      imageUrlHosts: operation.imageUrlHosts ?? previous?.imageUrlHosts ?? [],
      imageSizes: operation.imageSizes ?? previous?.imageSizes ?? [],
      maxSourceImages: operation.maxSourceImages ?? previous?.maxSourceImages ?? 1,
      editMode: operation.editMode ?? previous?.editMode ?? "edits-multipart",
      imagesPath: operation.imagesPath ?? previous?.imagesPath ?? "/v1/images/generations",
      ...(operation.watermark !== undefined
        ? { watermark: operation.watermark }
        : previous?.watermark !== undefined
          ? { watermark: previous.watermark }
          : {}),
      ...(operation.omitResponseFormat !== undefined
        ? { omitResponseFormat: operation.omitResponseFormat }
        : previous?.omitResponseFormat !== undefined
          ? { omitResponseFormat: previous.omitResponseFormat }
          : {}),
      ...(operation.credential === undefined && previous?.apiKeyEnv ? { apiKeyEnv: previous.apiKeyEnv } : {}),
      ...(credential ? { credential } : {}),
      models
    };
    if (existingIndex >= 0) providers[existingIndex] = imageBase;
    else providers.push(imageBase);
  }

  return { ...document, revision: document.revision + 1, providers };
}

/** 文档 → 运行时文本配置记录（含凭据解析回调）。 */
export function chatRuntimeConfigs(document: SettingsDocument) {
  return document.providers
    .filter((provider): provider is ChatProviderRecord => provider.kind === "chat")
    .flatMap((provider) =>
      provider.models.map((model) => ({
        apiProtocol: provider.apiProtocol ?? "openai-completions",
        responseFormat: model.responseFormat ?? provider.responseFormat,
        id: model.id,
        provider: "openai-compatible" as const,
        baseUrl: provider.baseUrl,
        model: model.modelId,
        apiKeyEnv: provider.apiKeyEnv ?? "",
        local: provider.local,
        capabilities: {
          structuredOutput: provider.capabilities.structuredOutput,
          stream: provider.capabilities.stream,
          vision: provider.capabilities.vision,
          // 本阶段不注册工具：配置不能开启。
          tools: false
        },
        credential: provider.credential
      }))
    );
}

/** 文档 → 运行时图片配置记录（含凭据解析回调）。 */
export function imageRuntimeConfigs(document: SettingsDocument) {
  return document.providers
    .filter((provider): provider is ImageProviderRecord => provider.kind === "image")
    .flatMap((provider) =>
      provider.models.map((model) => ({
        id: model.id,
        baseUrl: provider.baseUrl,
        model: model.modelId,
        apiKeyEnv: provider.apiKeyEnv ?? "",
        apiKind: "openai-images" as const,
        local: provider.local,
        capabilities: { ...provider.capabilities },
        imageUrlHosts: [...provider.imageUrlHosts],
        imageSizes: [...provider.imageSizes],
        maxSourceImages: provider.maxSourceImages ?? 1,
        editMode: provider.editMode,
        imagesPath: provider.imagesPath,
        ...(provider.watermark !== undefined ? { watermark: provider.watermark } : {}),
        ...(provider.omitResponseFormat !== undefined
          ? { omitResponseFormat: provider.omitResponseFormat }
          : {}),
        credential: provider.credential
      }))
    );
}
