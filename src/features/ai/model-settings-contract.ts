/**
 * 自助模型配置的**共享类型契约**（客户端与服务端共用，只有类型，没有实现）。
 *
 * 这里刻意不放任何密钥读写逻辑：客户端只能通过同源管理接口提交/读取管理视图，
 * 真正的解密、主密钥与文档写入只存在于 `src/server/ai/model-settings-store.ts`。
 */

export const CHAT_API_PROTOCOLS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type ChatApiProtocol = (typeof CHAT_API_PROTOCOLS)[number];
export function isChatApiProtocol(value: unknown): value is ChatApiProtocol {
  return typeof value === "string" && (CHAT_API_PROTOCOLS as readonly string[]).includes(value);
}

export type ProviderKind = "chat" | "image";

/** 回环主机名：`local` 是**地址的推论**，不是用户要回答的问题。 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * 从地址推导 `local`。
 * 服务端的受控出站规则只关心两件事：声明 local 就必须是回环；非回环必须 https。
 * 因此回环地址报 true、其余报 false，与服务端判定等价，用户不必再回答一次。
 */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(baseUrl.trim()).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** 管理视图里的模型行：稳定 ID 由服务端生成，编辑显示名时保留。 */
export type ManagedModel = {
  id: string;
  /** 上游模型标识（如 deepseek-flash / qwen-image）。 */
  modelId: string;
  /** 显示名称（可空 = 用 modelId 展示）。 */
  label: string;
};

export type ManagedChatCapabilities = {
  structuredOutput: boolean;
  stream: boolean;
  vision: boolean;
};

export type ManagedImageCapabilities = {
  generate: boolean;
  edit: boolean;
};

/** 管理视图里的提供方（**绝不含密钥值或密钥环境变量名**）。 */
export type ManagedProvider = {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  local: boolean;
  /** 是否已配置可用凭据（环境引用或用户填写的本机密钥）。 */
  credentialConfigured: boolean;
  /** 凭据来源：环境引用（旧配置）或本机（用户在本页填写）。 */
  credentialSource: "environment" | "local" | "none";
  models: ManagedModel[];
  /** 对话模型专用。 */
  apiProtocol?: ChatApiProtocol;
  responseFormat?: "json_schema" | "json_object";
  capabilities?: ManagedChatCapabilities;
  /** 制图模型专用。 */
  imageCapabilities?: ManagedImageCapabilities;
  imageSizes?: string[];
  /** 一次能接受的输入图张数上限；缺省 1（旧记录按 1 处理）。 */
  maxSourceImages?: number;
  editMode?: "edits-multipart" | "generations-image";
  imagesPath?: string;
  watermark?: boolean;
  /** 声明不下发 `response_format`（OpenAI gpt-image 系列不接受该参数）。 */
  omitResponseFormat?: boolean;
  imageUrlHosts?: string[];
};

/** 管理 GET 视图。 */
/** 输入图张数上限：缺省 1；给了就必须是 1..16 的整数。 */
function maxSourceImages(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 16);
}

export type ModelSettingsView = {
  ok: true;
  /** 写入所需版本令牌；前端不得自己拼造。 */
  revision: string;
  writable: boolean;
  executionEnabled?: boolean;
  /** 服务端拒绝写入时的稳定原因（只读/损坏）。 */
  readOnlyReason?: string;
  chat: ManagedProvider[];
  image: ManagedProvider[];
};

export type CredentialOperation =
  | { action: "replace"; value: string }
  /** 显式清除凭据：必须单独确认，不能靠清空输入框隐式触发。 */
  | { action: "clear" };

/** 一条提供方操作：按 ID upsert / delete 整张提供方卡片。 */
export type ProviderOperation =
  | {
      op: "upsert";
      kind: ProviderKind;
      /** 缺省 = 新增（服务端生成稳定 ID）。 */
      id?: string;
      name: string;
      baseUrl: string;
      local: boolean;
      models: { id?: string; modelId: string; label?: string }[];
      /** 缺省 = 保留现有凭据；空串或星号都不算替换。 */
      credential?: CredentialOperation;
      apiProtocol?: ChatApiProtocol;
      responseFormat?: "json_schema" | "json_object";
      capabilities?: Partial<ManagedChatCapabilities>;
      /**
       * **仅服务端**桥接字段：旧 `/api/ai/configs` 写入口沿用它提交“凭据环境变量名”。
       * 管理接口不接受客户端提交它（未知字段一律整批拒绝）。
       */
      apiKeyEnv?: string;
      imageCapabilities?: Partial<ManagedImageCapabilities>;
      imageSizes?: string[];
      maxSourceImages?: number;
      editMode?: "edits-multipart" | "generations-image";
      imagesPath?: string;
      watermark?: boolean;
      /** 仅制图：声明不下发 `response_format`（gpt-image 系列）。 */
      omitResponseFormat?: boolean;
      imageUrlHosts?: string[];
    }
  | { op: "delete"; kind: ProviderKind; id: string };

export type ModelSettingsRequest = {
  baseRevision: string;
  operations: ProviderOperation[];
};

/** 稳定错误码（服务端返回，客户端不解析自然语言）。 */
export const MODEL_SETTINGS_ERROR_DETAIL: Record<string, string> = {
  AI_SETTINGS_PRECONDITION_REQUIRED: "缺少配置版本，请先刷新当前配置。",
  AI_SETTINGS_CONFLICT: "配置已被其他会话修改，请先比较服务端状态。",
  AI_SETTINGS_BUSY: "配置正在被其他写入占用，请稍后重试。",
  AI_SETTINGS_INVALID: "提交的模型配置无效，请检查字段后重试。",
  AI_SETTINGS_FORBIDDEN: "该管理接口只允许本机同源访问。",
  AI_SETTINGS_READONLY: "当前部署不允许在此修改模型配置。",
  AI_SETTINGS_DOC_UNREADABLE: "本机模型配置暂时无法读取。",
  AI_SETTINGS_DOC_CORRUPT: "本机模型配置已损坏，未做任何改动。",
  AI_SETTINGS_KEY_MISSING: "本机主密钥缺失，无法解密已有配置；不会重建密钥或覆盖。",
  AI_SETTINGS_DECRYPT_FAILED: "本机模型配置无法解密，未做任何改动。",
  AI_SETTINGS_TOO_LARGE: "配置内容过大。",
  AI_SETTINGS_UNREACHABLE: "无法连接服务端。"
};

export function modelSettingsErrorDetail(code: string): string {
  return MODEL_SETTINGS_ERROR_DETAIL[code] ?? "模型配置操作失败。";
}

/** 管理读取与保存回读共用完整校验，类型断言不能代替可信边界。 */
export function isModelSettingsView(value: unknown): value is ModelSettingsView {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const text = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  const strings = (v: unknown) => Array.isArray(v) && v.every(text);
  const bools = (v: unknown, keys: string[]) => object(v) && keys.every(k => typeof v[k] === "boolean");
  if (!object(value) || value.ok !== true || !text(value.revision) || typeof value.writable !== "boolean") return false;
  if (value.executionEnabled !== undefined && typeof value.executionEnabled !== "boolean") return false;
  if (value.readOnlyReason !== undefined && typeof value.readOnlyReason !== "string") return false;
  for (const kind of ["chat", "image"] as const) {
    const providers = value[kind];
    if (!Array.isArray(providers)) return false;
    const providerIds = new Set<string>();
    const modelIds = new Set<string>();
    for (const p of providers) {
      if (!object(p) || p.kind !== kind || !text(p.id) || !text(p.name) || !text(p.baseUrl)
        || typeof p.local !== "boolean" || typeof p.credentialConfigured !== "boolean"
        || !["none", "environment", "local"].includes(String(p.credentialSource))
        || !Array.isArray(p.models) || !p.models.length) return false;
      if (p.credentialConfigured && p.credentialSource === "none") return false;
      if ("credential" in p || "apiKey" in p || "apiKeyEnv" in p) return false;
      try {
        const url = new URL(p.baseUrl as string);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return false;
      } catch { return false; }
      if (providerIds.has(p.id as string)) return false;
      providerIds.add(p.id as string);
      const upstreamIds = new Set<string>();
      for (const m of p.models) {
        if (!object(m) || !text(m.id) || !text(m.modelId) || typeof m.label !== "string") return false;
        if (modelIds.has(m.id as string) || upstreamIds.has(m.modelId as string)) return false;
        modelIds.add(m.id as string); upstreamIds.add(m.modelId as string);
      }
      if (kind === "chat") {
        if (p.apiProtocol !== undefined && !isChatApiProtocol(p.apiProtocol)) return false;
        if (!["json_schema", "json_object"].includes(String(p.responseFormat))
          || !bools(p.capabilities, ["structuredOutput", "stream", "vision"])) return false;
      } else if (!bools(p.imageCapabilities, ["generate", "edit"]) || !strings(p.imageSizes)
        || !strings(p.imageUrlHosts) || !["edits-multipart", "generations-image"].includes(String(p.editMode))
        || !text(p.imagesPath) || (p.watermark !== undefined && typeof p.watermark !== "boolean")
        || !maxSourceImages(p.maxSourceImages)
        || (p.omitResponseFormat !== undefined && typeof p.omitResponseFormat !== "boolean")) return false;
    }
  }
  return true;
}
