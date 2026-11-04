/**
 * `/api/ai/configs`：模型配置的公开状态（GET）与受控写入（PUT）。
 *
 * 边界：
 * - 公开投影只含 id/显示名/local/能力与**服务端判定的可用性**；**不含** apiKey、
 *   apiKeyEnv、baseUrl、文件路径或原始异常；
 * - 开关判定与 `/api/ai/generate` 完全一致（`XINGJI_AI_ENABLED=1` + 无认证环境），
 *   生产环境同样关闭；P8 随总 AI 许可可用、显式 0 才另行禁用，图片许可默认关闭；
 * - 仅获取配置不构成模型调用：本路由不创建 Provider、不发任何出站请求；
 * - 响应 `no-store`；不引入缓存层。
 *
 * 五态（服务端唯一来源，客户端不做自然语言匹配）：`available` / `unconfigured` /
 * `unavailable` / `disabled` / `error`。网络层失败不属于任何 state。
 *
 * PUT：按 ID 的 upsert/delete 批次 + 完整版本匹配（`baseRevision`），**落到与新管理端点
 * `/api/ai/settings/models` 同一份加密文档、同一把锁、同一套版本令牌**——不出现两份真相。
 * 旧的 `XINGJI_AI_CONFIG_FILE` 只作为首次迁移的读取来源，不再被写入。
 */
import type { ChatApiProtocol } from "@/features/ai/model-settings-contract";
import type { NativeSearchMode } from "@/features/ai/native-search-contract";
import { requireBetaAccess } from "@/server/ai/session-http";
import { currentScopeEnv, scopedEnvForModelConfig } from "@/server/ai/user-scope";
import {
  AI_ENABLED_ENV,
  configLockPath,
  isGatewayRouteEnabled,
  isLightAgentEnabled,
  ModelConfigError,
  parseConfigBatch,
  readAiPermissions,
  safeConfigDetail,
  type ConfigOperation,
  type ConfigStatusEntry,
  type ModelConfigStore,
  createModelConfigStore
} from "@/server/ai/model-config";
import {
  currentSettingsRevision,
  configOperationsToProviders,
  SettingsValidationError
} from "@/server/ai/model-settings-manager";
import {
  resolveSettingsPaths,
  SettingsStoreError,
  writeSettingsDocument
} from "@/server/ai/model-settings-store";
import {
  createImageConfigStore,
  isImageRouteEnabled,
  type PublicImageConfig
} from "@/server/ai/image-config";
import { publicSkillStates } from "@/server/ai/skill-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 公开配置项：GET 与 PUT 共用这一份投影。 */
export type PublicAiConfigEntry = {
  apiProtocol?: ChatApiProtocol;
  nativeSearch?: NativeSearchMode;
  id: string;
  /** 显示名：服务端给出的 model 标识；不含端点或凭据。 */
  label: string;
  local: boolean;
  capabilities: { structuredOutput: boolean; stream: boolean; vision: boolean };
  /** 服务端判定：当前是否真的能用于调用（缺密钥/端点非法时为 false）。 */
  usable: boolean;
  /** 不可用时的稳定错误码（无细节），供调用方区分原因。 */
  unusableReason?: string;
};

export type AiConfigState = "available" | "unconfigured" | "unavailable" | "disabled" | "error";

export type AiConfigsPayload = {
  ok: boolean;
  state: AiConfigState;
  reason: string | null;
  detail?: string;
  enabled: boolean;
  configs: PublicAiConfigEntry[];
  /** 写入所需版本令牌；null = 当前部署不可写（关闭或未声明覆盖文件）。 */
  revision: string | null;
  p8Enabled: boolean;
  imageEnabled: boolean;
  imageConfigs: PublicImageConfig[];
  /** Skill 开关的脱敏投影（只有 ID 与 state）：工作台据此显示不可用原因，服务端另有权威复核。 */
  skills: { id: string; state: string }[];
};

/** 公开投影的唯一实现：字段增减只改这里，GET/PUT 不会分叉。 */
function toPublicEntry(entry: ConfigStatusEntry): PublicAiConfigEntry {
  const { config } = entry;
  return {
    id: config.id,
    label: config.model || config.id,
    local: config.local,
    ...(config.apiProtocol !== undefined ? { apiProtocol: config.apiProtocol } : {}),
    ...(config.nativeSearch !== undefined ? { nativeSearch: config.nativeSearch } : {}),
    capabilities: {
      structuredOutput: config.capabilities.structuredOutput,
      stream: config.capabilities.stream,
      vision: config.capabilities.vision
    },
    usable: entry.usable,
    ...(entry.errorCode ? { unusableReason: entry.errorCode } : {})
  };
}

/**
 * P9-04：图片能力的公开视图。只下发开关位与公开能力，
 * **不含** baseUrl、密钥环境变量名或任何凭据；缺省/解析失败都按关闭处理。
 */
function readPublicImageConfigs(): { imageEnabled: boolean; imageConfigs: PublicImageConfig[] } {
  if (!isImageRouteEnabled()) return { imageEnabled: false, imageConfigs: [] };
  try {
    const store = createImageConfigStore(currentScopeEnv() as NodeJS.ProcessEnv);
    if (!store.enabled()) return { imageEnabled: false, imageConfigs: [] };
    return { imageEnabled: true, imageConfigs: store.listPublic() };
  } catch {
    // 图片配置非法或解析失败：一律按“没有可用图片能力”处理，不回传原始异常。
    return { imageEnabled: false, imageConfigs: [] };
  }
}

/** 开关位每次请求现算：P8 随总许可且显式 0 才禁用；图片仍默认关闭。 */
function readFlags(): Pick<
  AiConfigsPayload,
  "p8Enabled" | "imageEnabled" | "imageConfigs" | "skills"
> {
  const { imageEnabled, imageConfigs } = readPublicImageConfigs();
  return { p8Enabled: isLightAgentEnabled(), imageEnabled, imageConfigs, skills: readPublicSkills() };
}

/** Skill 开关：读不出来就按“没有额外信息”下发（服务端执行时仍会权威复核，不靠这里把关）。 */
function readPublicSkills(): { id: string; state: string }[] {
  try {
    return publicSkillStates();
  } catch {
    return [];
  }
}

/** 当前部署是否**允许**写入：与 GET 同一判定，客户端据此显示“当前不可修改”。 */
function configWritable(): boolean {
  return isGatewayRouteEnabled();
}

function json(
  body: unknown,
  status: number,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers
    }
  });
}

/**
 * 从 store 生成完整状态体（含 state/reason/revision）；GET 与 PUT 共用。
 *
 * 版本令牌取**权威文档**的令牌（`currentSettingsRevision`），而不是 store 自己的
 * 覆盖文件版本：写路径比较的就是文档令牌，两者必须是同一个字符串，否则用户按 GET
 * 拿到的令牌会在 PUT 立刻过期。文档不可用时回退 store 令牌（旧的只读路径）。
 */
function statusPayload(store: ModelConfigStore, state: AiConfigState, reason: string | null): AiConfigsPayload {
  const entries = store.describe();
  const configs = entries.map(toPublicEntry);
  let revision: string | null = null;
  if (configWritable()) {
    try {
      // 版本令牌与写路径同源（当前用户 scope 的文档）；不能读全局路径的令牌。
      revision = currentSettingsRevision(scopedEnvForModelConfig() as NodeJS.ProcessEnv).revision;
    } catch {
      revision = store.version();
    }
  }
  return {
    ok: state === "available",
    state,
    reason,
    enabled: state === "available",
    configs,
    // 允许管理配置时**即使配置为空**也要给出令牌：空库首次保存需要前提条件。
    revision,
    ...readFlags()
  };
}

/** 无可用 store 时的状态体（关闭 / 未配置 / 配置非法）：同样结构，前端一套解析。 */
function staticPayload(
  state: AiConfigState,
  reason: string | null,
  detail?: string
): AiConfigsPayload {
  return {
    ok: state === "available",
    state,
    reason,
    ...(detail ? { detail } : {}),
    enabled: false,
    configs: [],
    revision: null,
    ...readFlags()
  };
}

/**
 * 读侧失败原因：**读不出来**（权限/IO/坏 revision）归 read-failed，
 * 配置内容非法归 config-invalid。两者对用户的下一步不同。
 */
function readFailureReason(code: string): string {
  if (code === "AI_INTERNAL_ERROR" || code === "AI_CONFIG_UNREADABLE" || code === "AI_SETTINGS_DOC_UNREADABLE")
    return "read-failed";
  return "config-invalid";
}

export async function GET(request: Request): Promise<Response> {
  const gated = requireBetaAccess(request);
  if (gated) return gated;
  /*
   * 许可、配置与版本读取在同一个错误边界内。文档损坏时执行仍关闭，
   * 但公开状态必须明确报错，不能伪装成用户主动停用了 AI。
   */
  try {
    const routeEnabled = isGatewayRouteEnabled();
    if (!routeEnabled || !readAiPermissions().ai) {
      const reason = routeEnabled ? "permission-required" : process.env[AI_ENABLED_ENV] === "1" ? "development-only" : "disabled";
      const payload = staticPayload("disabled", reason, routeEnabled ? "尚未开启 AI 使用许可，请确认 AI 与图片许可。" : safeConfigDetail("AI_DISABLED"));
      return json({ ...payload, imageEnabled: false, imageConfigs: [] }, 200);
    }
    const store = createModelConfigStore(currentScopeEnv() as NodeJS.ProcessEnv);
    const entries = store.describe();
    const state: AiConfigState =
      entries.length === 0 ? "unconfigured" : entries.some((entry) => entry.usable) ? "available" : "unavailable";
    const payload = statusPayload(
      store,
      state,
      state === "unconfigured" ? "no-configs" : state === "unavailable" ? "not-usable" : null
    );
    return json(payload, 200, payload.revision ? { etag: payload.revision } : {});
  } catch (error) {
    // 不回传原始异常（可能含配置片段或路径），只给稳定错误码 + 固定文案。
    const code =
      error instanceof ModelConfigError || error instanceof SettingsStoreError
        ? error.code
        : "AI_INTERNAL_ERROR";
    const payload = staticPayload("error", readFailureReason(code), safeConfigDetail(code));
    return json({ ...payload, code }, code === "AI_INTERNAL_ERROR" ? 500 : 503);
  }
}

/**
 * 进程内串行化写：两个请求同时到达时，后者必须在**读取当前版本之后**再判定，
 * 否则两次读到的版本相同、两次都写成功，就成了静默覆盖。
 */
let writeQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => undefined);
  return run;
}

/** 请求体上限（字节）：配置数组是声明，不该有正文级体量。 */
const MAX_CONFIG_BODY_BYTES = 128 * 1024;

/** 配置错误 → HTTP 状态：请求内容问题归 4xx，服务端不可写/不可用归 503。 */
const WRITE_ERROR_STATUS: Record<string, number> = {
  AI_CONFIG_INVALID: 400,
  AI_CONFIG_TOO_LARGE: 413,
  // 服务端文件/环境变量的配置非法或读不出来：不是用户改一下字段就能解决的事。
  AI_CONFIG_UNKNOWN: 503,
  AI_CONFIG_UNREADABLE: 503,
  AI_SETTINGS_DOC_UNREADABLE: 503,
  AI_SETTINGS_DOC_CORRUPT: 503,
  AI_SETTINGS_KEY_MISSING: 503,
  AI_SETTINGS_DECRYPT_FAILED: 503,
  AI_ENDPOINT_INVALID: 400,
  AI_CONFIG_PRECONDITION_REQUIRED: 428,
  AI_CONFIG_CONFLICT: 409,
  AI_CONFIG_BUSY: 409,
  AI_CONFIG_READONLY: 503,
  AI_DISABLED: 503
};

function writeFailure(code: string): Response {
  return json({ ok: false, code, detail: safeConfigDetail(code) }, WRITE_ERROR_STATUS[code] ?? 503);
}

export async function PUT(request: Request): Promise<Response> {
  const gated = requireBetaAccess(request);
  if (gated) return gated;
  const flags = readFlags();
  if (!isGatewayRouteEnabled()) {
    // 与 GET 同源的启用判定：生产/无认证环境默认关闭，写接口不能成为例外。
    return json(
      { ok: false, code: "AI_DISABLED", detail: safeConfigDetail("AI_DISABLED"), ...flags, imageEnabled: false, imageConfigs: [] },
      503
    );
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_CONFIG_BODY_BYTES) {
    return writeFailure("AI_CONFIG_TOO_LARGE");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return writeFailure("AI_CONFIG_INVALID");
  }
  const baseRevision =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as { baseRevision?: unknown }).baseRevision
      : undefined;
  let operations: ConfigOperation[];
  try {
    operations = parseConfigBatch(payload);
  } catch (error) {
    // 整批形状非法：零写入。
    return writeFailure(error instanceof ModelConfigError ? error.code : "AI_CONFIG_INVALID");
  }

  // T2a：读、写、锁全部按当前用户 scope 的文档路径派生——不能落到全局设置目录。
  const paths = resolveSettingsPaths(scopedEnvForModelConfig() as NodeJS.ProcessEnv);

  const run = await serialize(async (): Promise<Response> => {
    /*
     * 单一权威：本入口不再维护另一份真相。整份配置数组被映射成提供方声明，
     * 落到与新管理端点**同一份加密文档**、同一把锁、同一套版本令牌。
     */
    const commit = async (): Promise<Response> => {
      try {
        const current = currentSettingsRevision(scopedEnvForModelConfig() as NodeJS.ProcessEnv, paths);
        if (typeof baseRevision !== "string" || baseRevision.trim().length === 0) {
          return writeFailure("AI_CONFIG_PRECONDITION_REQUIRED");
        }
        // 完整版本匹配（revision + 内容摘要）：只比 revision 会漏掉“内容被外部改过”。
        if (baseRevision.trim() !== current.revision) {
          return writeFailure("AI_CONFIG_CONFLICT");
        }

        const chatProviders = configOperationsToProviders(current.document, operations);
        const next = {
          ...current.document,
          revision: current.document.revision + 1,
          providers: [...current.document.providers.filter(p => p.kind !== "chat"), ...chatProviders]
        };

        writeSettingsDocument({ ...next, schema: 1 }, paths);

        // 写后重新读盘回读：响应是“服务端现在的状态”，不是把请求体回显当成功。
        const saved = createModelConfigStore(currentScopeEnv() as NodeJS.ProcessEnv);
        const entries = saved.describe();
        const state: AiConfigState =
          entries.length === 0
            ? "unconfigured"
            : entries.some((entry) => entry.usable)
              ? "available"
              : "unavailable";
        const response = statusPayload(
          saved,
          state,
          state === "unconfigured" ? "no-configs" : state === "unavailable" ? "not-usable" : null
        );
        return json(response, 200, response.revision ? { etag: response.revision } : {});
      } catch (error) {
        if (error instanceof ModelConfigError) return writeFailure(error.code);
        if (error instanceof SettingsStoreError) return writeFailure(error.code);
        if (error instanceof SettingsValidationError) return writeFailure("AI_CONFIG_INVALID");
        return writeFailure("AI_CONFIG_INVALID");
      }
    };

    try {
      // 同一条受保护范围：版本校验 + 读取 + 写入都在锁内。
      return await withLegacyLock(paths.document, commit);
    } catch (error) {
      if (error instanceof ModelConfigError) return writeFailure(error.code);
      return writeFailure("AI_CONFIG_READONLY");
    }
  });
  return run;
}

/** 复用既有配置锁实现（同一把锁语义，不另造队列）。 */
async function withLegacyLock<T>(documentPath: string, task: () => Promise<T>): Promise<T> {
  const { withConfigLock } = await import("@/server/ai/model-config");
  return withConfigLock(configLockPath(documentPath), task);
}
