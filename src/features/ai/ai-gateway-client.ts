/**
 * R4：浏览器侧到 Gateway 的**最小请求函数**。
 *
 * 职责只有一件：把受控字段发给 `/api/ai/generate` 并解析明确结果。
 * 这里不导入任何服务端模块：密钥解析、模型配置与供应商调用全部留在服务端。
 * 不建通用 Transport / Factory 框架——需求是一个 POST 加上明确错误。
 */
import { IMAGE_SIZES } from "../creation/creation-image-limits";
import { createNdjsonFramer, type WorkbenchStreamEvent } from "./stream-events";
import { isNativeSearchMode, type NativeSearchMode } from "./native-search-contract";
import { apiFetch } from "@/lib/api-client";
import {
  isChatApiProtocol,
  modelSettingsErrorDetail,
  isModelSettingsView,
  type ChatApiProtocol,
  type ModelSettingsRequest,
  type ModelSettingsView,
  type ProviderKind
} from "./model-settings-contract";

/** 支持的任务类型；与服务端 `GATEWAY_TASK_TYPES` 一致。 */
export type AiGatewayTask =
  | "workbench_chat"
  /** 工作台计划轮与流式回答轮：服务端早已声明，客户端联合此前漏登记（类型漂移，非新任务）。 */
  | "workbench_plan"
  | "workbench_web_search"
  | "workbench_chat_stream"
  | "organize_page"
  | "organize_captures"
  | "analyze_notebook"
  | "generate_page_metadata"
  | "answer_search"
  /** P8：受限计划的两次请求（计划一次、综合一次）。 */
  | "plan_collection"
  | "synthesize_collection"
  /** 图像提示设计（文本任务）。 */
  | "design_image_prompt";

/** P9-04：视觉任务随请求携带的图片（调用方已按边界处理：≤1024px、JPEG、去元数据）。 */
export type AiGatewayImage = { mime: string; base64: string };

export type AiGatewayCallRequest = {
  configId: string;
  task: AiGatewayTask;
  input: string;
  /** 只有声明支持视觉的任务才允许携带；服务端会再校验一次。 */
  images?: AiGatewayImage[];
  signal?: AbortSignal;
};

export type AiGatewayCallResult =
  | {
      ok: true;
      content: string;
      model: string;
      configId: string;
      usage?: { inputTokens?: number; outputTokens?: number };
      resources?: { id: string; version?: string; digest?: string }[];
      estimate?: { textChars?: number; serverTextChars?: number };
    }
  | { ok: false; code: string; detail: string; status: number };

export type AiGatewayCaller = (request: AiGatewayCallRequest) => Promise<AiGatewayCallResult>;

export const AI_GATEWAY_ENDPOINT = "/api/ai/generate";
/** P2-01：公开模型配置列表（只读，不含凭据或端点）。 */
export const AI_CONFIGS_ENDPOINT = "/api/ai/configs";

/** 服务端下发的公开配置项；`label` 由服务端给出，客户端不自行拼端点信息。 */
export type AiPublicConfig = {
  apiProtocol?: ChatApiProtocol;
  nativeSearch?: NativeSearchMode;
  id: string;
  label: string;
  local: boolean;
  capabilities: { structuredOutput: boolean; stream: boolean; vision: boolean };
  /** 服务端判定当前是否真的可用（缺密钥/端点非法时为 false）。 */
  usable?: boolean;
  /** 不可用时的稳定错误码（无细节）。 */
  unusableReason?: string;
};

/**
 * 四态：`available` / `unconfigured` / `unavailable` / `disabled` 由**服务端**下发，
 * `unreachable` 只由客户端在“请求本身失败”时给出——网络错误与无效响应绝不能伪装成“未配置”。
 */
export type AiConfigState =
  | "available"
  | "unconfigured"
  | "unavailable"
  | "disabled"
  | "unreachable";

/**
 * `verified`：响应结构是否**足以确认**这是一次真实的服务端状态。
 * 写接口只允许把 `verified:true` 的结果当作“已确认保存”；非法/空响应不得清空草稿或宣称落盘成功。
 */
export type AiConfigListResult =
  | {
      status: "available";
      configs: AiPublicConfig[];
      /**
       * `state` / `revision` 由 `readConfigStatus` 在运行时始终填好；类型上保持可选，
       * 以便既有测试替身（只给 status/configs）仍能满足契约——运行时校验不看类型。
       */
      state?: AiConfigState;
      revision?: string | null;
      verified?: boolean;
    }
  | {
      status: "unconfigured";
      state: AiConfigState;
      detail: string;
      reason: string;
      revision: string | null;
      verified?: boolean;
    }
  | {
      status: "unavailable";
      state: AiConfigState;
      detail: string;
      reason: string;
      revision: string | null;
      configs: AiPublicConfig[];
      verified?: boolean;
    }
  | { status: "disabled"; state: AiConfigState; reason: string; detail: string; verified?: boolean }
  | { status: "error"; state: "unreachable" | "error"; detail: string; verified?: boolean };

/**
 * P8 整理检索结果与图片能力的服务端开关位（与 P2 配置可用性分开表达）。
 * 为 false 时产品入口明确不可用且零模型请求；不因为 P2 已配置或另一个阶段已启用而变真。
 */
/** P9-04：图片能力的公开配置（绝不含 baseUrl 内联凭据或密钥环境变量名）。 */
export type AiPublicImageConfig = {
  id: string;
  label: string;
  model: string;
  apiKind: "openai-images";
  local: boolean;
  capabilities: { generate: boolean; edit: boolean };
  /** 该配置实际允许的 size（未声明时为内置三个）；用于约束图像提示只产出可执行尺寸。 */
  imageSizes: string[];
  /**
   * 非凭据配置指纹（R1）：由服务端核定并随列表下发；任务计划在首个外部执行前固定它，
   * 出站时服务端重新计算并比较——配置变化拒绝执行（`IMAGE_CONFIG_CHANGED`）。
   */
  configDigest?: string;
};

export type AiConfigListResultWithFlags = AiConfigListResult & {
  p8Enabled: boolean;
  /** P9-04 图片能力独立开关位（默认关闭；缺省按关闭）。 */
  imageEnabled?: boolean;
  /** 可用的图片配置（只含公开字段）。缺省视为没有可用图片能力。 */
  imageConfigs?: AiPublicImageConfig[];
  /**
   * 脱敏的 Skill 开关投影（只有 ID 与 state，没有路径与正文）。
   * 缺省视为“没有额外停用信息”：服务端仍会做权威复核，不靠这里把关。
   */
  skills?: { id: string; state: string }[];
};

/**
 * 读取服务端配置状态。仅获取配置**不构成模型调用**：本函数只做一次 GET，
 * 不创建 Provider、不发模型请求。
 *
 * 分类只依据服务端下发的 `state` 与 HTTP/fetch 结果，**不做自然语言匹配**：
 * - 请求抛错或响应不是合法 JSON → `unreachable`（请求本身失败），绝不伪装成“未配置”；
 * - 服务端明确报错（非 2xx 或 `ok:false`）→ `error`（配置不可用），提示检查配置而不是反复重试；
 * - `state` 缺失的旧响应按字段回退（`enabled`/`configs`），保持既有调用方兼容。
 */
/**
 * 写入结果只可能落在三种状态：`available`（仍有可用配置）、`unconfigured`（删空了）、
 * `unavailable`（配置在但当前不可用）。`error`/`disabled` 不能证明写成功——即使 HTTP 200。
 */
const WRITE_RESULT_STATES = new Set(["available", "unconfigured", "unavailable"]);

/** 服务端契约里允许的状态取值；其它字符串一律视为不可确认的响应。 */
const KNOWN_CONFIG_STATES = new Set([
  "available",
  "unconfigured",
  "unavailable",
  "disabled",
  "error"
]);

/** 公开配置项的形状校验：字段类型必须齐全，能力必须是布尔。 */
function isCompletePublicConfig(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || entry.id.length === 0) return false;
  if (typeof entry.label !== "string") return false;
  if (typeof entry.local !== "boolean") return false;
  if (typeof entry.usable !== "boolean") return false;
  const capabilities = entry.capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return false;
  const caps = capabilities as Record<string, unknown>;
  for (const key of ["structuredOutput", "stream", "vision"] as const) {
    if (typeof caps[key] !== "boolean") return false;
  }
  return true;
}

/**
 * 回读是否**可确认**（写成功的证据门槛，不接受任何默认值/过滤/状态修正）：
 * - 必须是普通对象（JSON 原始类型/null/数组都不算）；
 * - `state` 必须是契约内的取值；
 * - 每一项配置的公开字段与能力布尔必须齐全；
 * - 状态与列表必须自洽：`available` 至少一条 `usable`；`unavailable` 有声明但**没有**可用项；
 *   `unconfigured` 列表必须为空（空列表却自称 available，或非空却自称 unconfigured，都不算证据）；
 * - `revision` 是 `null`，或非空字符串（`""` 不算版本）。
 *
 * 该判据只在**保存确认**边界使用；公开 GET 的兼容读取仍可对旧响应做缺省与过滤。
 */
function isVerifiedConfigPayload(payload: Record<string, unknown>): boolean {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  if (typeof payload.state !== "string" || !KNOWN_CONFIG_STATES.has(payload.state)) return false;
  if (!Array.isArray(payload.configs)) return false;
  if (!payload.configs.every(isCompletePublicConfig)) return false;
  const usableCount = (payload.configs as { usable: boolean }[]).filter((entry) => entry.usable).length;

  if (payload.state === "available" && usableCount === 0) return false;
  if (payload.state === "unavailable" && (usableCount > 0 || payload.configs.length === 0)) return false;
  if (payload.state === "unconfigured" && payload.configs.length > 0) return false;

  if (!("revision" in payload)) return false;
  const revision = payload.revision;
  return revision === null || (typeof revision === "string" && revision.length > 0);
}

function unreachable(detail: string): AiConfigListResultWithFlags {
  return {
    status: "error",
    state: "unreachable",
    // 非法/无法解析的响应：不能作为“已确认”的服务端状态使用。
    verified: false,
    p8Enabled: false,
    imageEnabled: false,
    imageConfigs: [],
    detail
  };
}

/** 响应体 → 四态结果。GET 与 PUT 的回读共用这一份解析，避免两套判定分叉。 */
function readConfigStatus(
  response: Response,
  payload: Record<string, unknown> | null
): AiConfigListResultWithFlags {
  if (!payload) {
    // 非法响应不是“未配置”：明确归类为请求失败。
    return unreachable(`配置接口返回了无效响应（${response.status}）。`);
  }

  /*
   * 结构验证：只认“字段存在”不足以确认回读——未知/错误状态、空版本、非法配置条目
   * 都会让一次失败的写入看起来像成功。这里校验**允许的状态取值、版本形状与配置项结构**。
   */
  const verified = isVerifiedConfigPayload(payload);

  /** 缺失一律按关闭处理：旧响应或测试替身不会意外开放 P8/图片。 */
  const p8Enabled = payload.p8Enabled === true;
  const imageEnabled = payload.imageEnabled === true;
  const imageConfigs = Array.isArray(payload.imageConfigs)
    ? payload.imageConfigs.flatMap((entry) => {
        const candidate = entry as Partial<AiPublicImageConfig>;
        if (typeof candidate?.id !== "string" || candidate.id.length === 0) return [];
        return [
          {
            id: candidate.id,
            label: typeof candidate.label === "string" && candidate.label ? candidate.label : candidate.id,
            model: typeof candidate.model === "string" && candidate.model ? candidate.model : "",
            apiKind: "openai-images" as const,
            local: candidate.local === true,
            capabilities: {
              generate: candidate.capabilities?.generate !== false,
              edit: candidate.capabilities?.edit === true
            },
            // 缺省按内置三个处理（与 provider/route 的缺省一致）。
            imageSizes:
              Array.isArray(candidate.imageSizes) &&
              candidate.imageSizes.every((size) => typeof size === "string")
                ? candidate.imageSizes
                : [...IMAGE_SIZES],
            ...(typeof candidate.configDigest === "string" && candidate.configDigest.length > 0
              ? { configDigest: candidate.configDigest }
              : {})
          }
        ];
      })
    : [];
  const flags = { p8Enabled, imageEnabled, imageConfigs };
  const revision = typeof payload.revision === "string" && payload.revision ? payload.revision : null;
  const detail = typeof payload.detail === "string" ? payload.detail : undefined;
  const reason = typeof payload.reason === "string" ? payload.reason : "unknown";
  const configs = Array.isArray(payload.configs)
    ? payload.configs.flatMap((entry) => {
        const candidate = entry as Partial<AiPublicConfig>;
        if (typeof candidate?.id !== "string" || candidate.id.length === 0) return [];
        return [
          {
            id: candidate.id,
            label: typeof candidate.label === "string" && candidate.label ? candidate.label : candidate.id,
            local: candidate.local === true,
            ...(isChatApiProtocol(candidate.apiProtocol) ? { apiProtocol: candidate.apiProtocol } : {}),
            ...(isNativeSearchMode(candidate.nativeSearch) ? { nativeSearch: candidate.nativeSearch } : {}),
            capabilities: {
              structuredOutput: candidate.capabilities?.structuredOutput !== false,
              stream: candidate.capabilities?.stream === true,
              vision: candidate.capabilities?.vision === true
            },
            // 旧响应没有 usable：缺省视为可用（与“字段缺失不改变既有判定”一致）。
            usable: candidate.usable !== false,
            ...(typeof candidate.unusableReason === "string"
              ? { unusableReason: candidate.unusableReason }
              : {})
          }
        ];
      })
    : [];

  const state = typeof payload.state === "string" ? payload.state : undefined;
  /*
   * 顺序很重要：`unconfigured` / `unavailable` 的 `ok` 也是 false（它们确实不能调用模型），
   * 但它们**不是**“请求失败”。先按服务端 state 分类，再处理真正的错误态。
   */
  if (state === "unconfigured") {
    return {
      status: "unconfigured",
      state,
      reason,
      revision,
      verified,
      ...flags,
      detail: detail ?? "尚未配置任何模型。"
    };
  }
  if (state === "unavailable") {
    // 带上逐条配置：设置页要显示“哪条不可用、为什么（稳定 code）”，而不是一句笼统提示。
    return {
      status: "unavailable",
      state,
      reason,
      revision,
      verified,
      ...flags,
      configs,
      detail: detail ?? "已有配置当前不可用。"
    };
  }
  if (state === "disabled") {
    return {
      status: "disabled",
      state,
      reason,
      verified,
      detail: detail ?? "服务端未启用 AI 能力。",
      ...flags
    };
  }
  if (state === "error") {
    return {
      status: "error",
      // 服务端明确报错：是“服务端配置不可用”，而不是“这次没连上”。
      state: "error",
      verified,
      ...flags,
      detail: detail ?? "服务端模型配置无效，请检查服务端配置。"
    };
  }
  if (state === "available" && response.ok && payload.ok === true) {
    return configs.length > 0
      ? { status: "available", state, revision, verified, ...flags, configs }
      : {
          status: "unconfigured",
          state: "unconfigured",
          reason: "no-configs",
          revision,
          verified,
          ...flags,
          detail: "尚未配置任何模型。"
        };
  }
  // 旧响应（没有 state）：按 enabled/reason 回退，语义与之前一致。
  if (state === undefined && response.ok && payload.ok === true) {
    if (payload.enabled !== true) {
      return reason === "no-configs"
        ? {
            status: "unconfigured",
            state: "unconfigured",
            reason,
            revision: null,
            verified,
            ...flags,
            detail: "尚未配置任何模型。"
          }
        : {
            status: "disabled",
            state: "disabled",
            reason,
            verified,
            detail: detail ?? "服务端未启用 AI 能力。",
            ...flags
          };
    }
    return configs.length > 0
      ? { status: "available", state: "available", revision: null, verified, ...flags, configs }
      : {
          status: "unconfigured",
          state: "unconfigured",
          reason: "no-configs",
          revision: null,
          verified,
          ...flags,
          detail: "尚未配置任何模型。"
        };
  }
  return {
    status: "error",
    state: state === "unreachable" ? "unreachable" : "error",
    verified,
    ...flags,
    detail: detail ?? (typeof payload.code === "string" ? payload.code : `配置接口返回 ${response.status}。`)
  };
}

/** 保存结果：成功时携带**服务端回读**后的状态与最新版本；失败保留稳定 code。 */
export type AiConfigSaveResult =
  | { ok: true; status: AiConfigListResultWithFlags; revision: string | null }
  | {
      ok: false;
      code: string;
      detail: string;
      status: number;
      conflict: boolean;
      /** 写入结果未确认（回读非法/无法判定）：与“服务端明确拒绝”区分，提示先核对再重试。 */
      unverified?: boolean;
    };

export type AiConfigOperation =
  | {
      op: "upsert";
      id: string;
      model?: string;
      baseUrl?: string;
      local?: boolean;
      capabilities?: Partial<{ structuredOutput: boolean; stream: boolean; vision: boolean }>;
      /** 只有新增或用户明确更换引用时才提交；服务端从不回显。 */
      apiKeyEnv?: string;
    }
  | { op: "delete"; id: string };

/**
 * 读取服务端配置状态。仅获取配置**不构成模型调用**：只做一次 GET，不创建 Provider、不发模型请求。
 */
export async function listAiConfigs(
  options: { endpoint?: string; fetchImpl?: typeof fetch } = {}
): Promise<AiConfigListResultWithFlags> {
  const endpoint = options.endpoint ?? AI_CONFIGS_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? apiFetch;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store"
    });
  } catch (error) {
    return unreachable(error instanceof Error ? error.message : "配置接口不可达。");
  }
  let payload: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await response.json();
    payload = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    payload = null;
  }
  return readConfigStatus(response, payload);
}

/**
 * 保存配置批次。`baseRevision` 必须是 `listAiConfigs` 刚返回的版本，**前端不得自己拼造**。
 * 冲突（409）不自动重试、不自动覆盖：交给调用方保留草稿并提示刷新。
 */
export async function saveAiConfigs(
  request: { baseRevision: string; operations: AiConfigOperation[] },
  options: { endpoint?: string; fetchImpl?: typeof fetch } = {}
): Promise<AiConfigSaveResult> {
  const endpoint = options.endpoint ?? AI_CONFIGS_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? apiFetch;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "PUT",
      headers: { "content-type": "application/json", accept: "application/json" },
      cache: "no-store",
      body: JSON.stringify(request)
    });
  } catch (error) {
    return {
      ok: false,
      code: "AI_CONFIG_UNREACHABLE",
      detail: error instanceof Error ? error.message : "无法连接服务端。",
      status: 0,
      conflict: false
    };
  }
  let payload: Record<string, unknown> | null = null;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    payload = null;
  }
  const code = typeof payload?.code === "string" ? payload.code : "AI_CONFIG_INVALID";
  if (!payload) {
    // 响应体不是 JSON 对象：写入结果**未确认**（既不能说成功，也不能说服务端拒绝）。
    return {
      ok: false,
      code: "AI_CONFIG_UNVERIFIED",
      detail: "服务端响应无法解析，本次保存结果未确认。请先刷新服务端状态核对配置，再决定是否重试。",
      status: response.status,
      conflict: false,
      unverified: true
    };
  }
  /*
   * 判定写入是否成功只看 HTTP 与业务错误码，**不能**看 `payload.ok`：
   * `ok` 表达的是“配置现在可用吗”，删掉最后一条后它是 false（state=unconfigured、HTTP 200），
   * 但那次写入本身是成功的。把两者混在一起会把成功的删除报成“保存失败（200）”。
   */
  if (!response.ok) {
    return {
      ok: false,
      code,
      detail: typeof payload?.detail === "string" ? payload.detail : `保存失败（${response.status}）。`,
      status: response.status,
      conflict: response.status === 409 || code === "AI_CONFIG_CONFLICT"
    };
  }
  /*
   * 成功以服务端**回读**的状态为准：PUT 的响应体就是写后重新读盘生成的状态，
   * 因此这里解析它，而不是把请求体当作已保存结果，也不再多发一次 GET。
   */
  const status = readConfigStatus(response, payload);
  const revision = typeof payload.revision === "string" && payload.revision.length > 0 ? payload.revision : null;
  /*
   * 确认条件（不涉及 payload.ok）：状态在契约内、配置项结构合法、版本令牌是非空字符串。
   * 只读部署的 `revision: null` 出现在写响应里说明这次写入没有拿到新版本，同样算未确认。
   */
  const resultState = status.state;
  if (
    status.verified !== true ||
    revision === null ||
    typeof resultState !== "string" ||
    !WRITE_RESULT_STATES.has(resultState)
  ) {
    /*
     * HTTP 200 不等于“已确认保存”：必须能读出服务端状态结构与版本令牌。
     * 这类结果既不是服务端明确拒绝，也不是成功——按“未确认”处理，保留输入并让用户先核对服务端。
     */
    return {
      ok: false,
      code: "AI_CONFIG_UNVERIFIED",
      detail: "服务端返回的回读结果无法确认（缺少状态或版本），本次保存结果未确认。请先刷新服务端状态核对配置，再决定是否重试。",
      status: response.status,
      conflict: false,
      unverified: true
    };
  }
  return { ok: true, status, revision };
}

export function createAiGatewayCaller(
  options: {
    endpoint?: string;
    fetchImpl?: typeof fetch;
  } = {}
): AiGatewayCaller {
  const endpoint = options.endpoint ?? AI_GATEWAY_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? apiFetch;

  return async function callGateway(request) {
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          configId: request.configId,
          task: request.task,
          input: request.input,
          ...(request.images && request.images.length > 0 ? { images: request.images } : {})
        }),
        ...(request.signal ? { signal: request.signal } : {})
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: unknown;
        content?: unknown;
        model?: unknown;
        configId?: unknown;
        usage?: { inputTokens?: number; outputTokens?: number };
        /** R4：design_image_prompt 回显实际采用的资源版本。 */
        resources?: { id: string; version?: string; digest?: string }[];
        estimate?: { textChars?: number };
        code?: unknown;
        detail?: unknown;
      } | null;
      if (!response.ok || payload?.ok !== true) {
        return {
          ok: false,
          code: typeof payload?.code === "string" ? payload.code : "AI_GATEWAY_ERROR",
          detail:
            typeof payload?.detail === "string"
              ? payload.detail
              : `Gateway 返回 ${response.status}。`,
          status: response.status
        };
      }
      if (typeof payload.content !== "string") {
        // 路由契约要求 content 是字符串；这里不猜测其它形状。
        return {
          ok: false,
          code: "AI_GATEWAY_MALFORMED",
          detail: "Gateway 响应缺少 content。",
          status: 502
        };
      }
      return {
        ok: true,
        content: payload.content,
        model: typeof payload.model === "string" ? payload.model : "",
        configId: typeof payload.configId === "string" ? payload.configId : request.configId,
        ...(payload.usage ? { usage: payload.usage } : {}),
        ...(Array.isArray(payload.resources) ? { resources: payload.resources } : {}),
        ...(payload.estimate && typeof payload.estimate.textChars === "number" ? { estimate: payload.estimate } : {})
      };
    } catch (error) {
      // 取消要通过 signal 语义向外表达，不伪装成普通失败。
      if (request.signal?.aborted) throw error;
      return {
        ok: false,
        code: "AI_GATEWAY_UNREACHABLE",
        detail: error instanceof Error ? error.message : "Gateway 请求失败。",
        status: 0
      };
    }
  };
}

/**
 * 流式调用：同一个网关端点 + `stream: true`，按 NDJSON 逐行消费事件。
 *
 * 契约（对应增量任务书 §2）：
 * - 每个事件立刻回调，UI 可以增量渲染；
 * - **恰好一个终止事件**；上游/网关异常都会以 `error` + `done` 收束；
 * - 取消时抛出 AbortError（沿用 signal 语义，不当成普通失败）；
 * - 非 2xx（未授权、未启用、输入过大等）按既有 JSON 失败结构返回，不进入流式解析。
 */
export type AiGatewayStreamRequest = AiGatewayCallRequest & { stream: true };

export async function streamAiGateway(
  request: AiGatewayCallRequest,
  onEvent: (event: WorkbenchStreamEvent) => void,
  options: { endpoint?: string; fetchImpl?: typeof fetch } = {}
): Promise<
  | { ok: true; reason: "stop" | "cancelled" | "limit" | "timeout" | "error" }
  | { ok: false; code: string; detail: string; status: number }
> {
  const endpoint = options.endpoint ?? AI_GATEWAY_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? apiFetch;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      configId: request.configId,
      task: request.task,
      input: request.input,
      stream: true,
      ...(request.images && request.images.length > 0 ? { images: request.images } : {})
    }),
    ...(request.signal ? { signal: request.signal } : {})
  });

  if (!response.ok || !response.body) {
    const payload = (await response.json().catch(() => null)) as { code?: unknown; detail?: unknown } | null;
    return {
      ok: false,
      code: typeof payload?.code === "string" ? payload.code : "AI_GATEWAY_ERROR",
      detail:
        typeof payload?.detail === "string" ? payload.detail : `Gateway 返回 ${response.status}。`,
      status: response.status
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const framer = createNdjsonFramer();
  let reason: "stop" | "cancelled" | "limit" | "timeout" | "error" | undefined;
  const handle = (events: WorkbenchStreamEvent[]) => {
    for (const event of events) {
      if (reason !== undefined) break;
      if (event.type === "done") reason = event.reason;
      onEvent(event);
    }
  };

  try {
    while (reason === undefined) {
      const { value, done } = await reader.read();
      if (done) break;
      handle(framer.push(decoder.decode(value, { stream: true })));
    }
    if (reason === undefined) { handle(framer.push(decoder.decode())); handle(framer.flush()); }
  } catch (error) {
    // 取消向上抛（signal 语义）；其它异常按“流中断”收束，绝不留半个流。
    if (request.signal?.aborted) throw error;
    onEvent({
      type: "error",
      code: "AI_STREAM_INTERRUPTED",
      message: error instanceof Error ? error.message : "流式连接中断。",
      retryable: true
    });
    onEvent({ type: "done", reason: "error" });
    return { ok: true, reason: "error" };
  }

  if (reason === undefined) {
    // 服务端没有给出终止事件（连接被切断）：补一个终止并如实标注为失败。
    onEvent({ type: "error", code: "AI_STREAM_INTERRUPTED", message: "流式连接提前结束。", retryable: true });
    onEvent({ type: "done", reason: "error" });
    reason = "error";
  }
  return { ok: true, reason };
}

/** P9-04：受控图片路由（同源 POST，只发提示与输入图，不携带任何 key）。 */
export const AI_IMAGE_ENDPOINT = "/api/ai/image";
/** R1：尝试查询端点——恢复、重复点击和重试先走查询，不触发任何模型或图片请求。 */
export const AI_IMAGE_ATTEMPT_ENDPOINT = "/api/ai/image/attempts";

/** 服务端随图片响应回传的尝试状态（权威执行事实的投影）。 */
export type ImageAttemptOutcome = {
  attemptId: string;
  status: "prepared" | "dispatched" | "succeeded" | "failed" | "outcome_unknown";
  itemId?: string;
  errorCode?: string;
  artifactId?: string;
  artifactDigest?: string;
  deadlineAt?: string;
  expired?: boolean;
};

export type AiImageCallRequest = {
  configId: string;
  mode: "generate" | "edit";
  prompt: string;
  size: string;
  quality: "low" | "medium" | "high";
  outputFormat?: "png" | "jpeg";
  /** 与服务端 `/api/ai/image` 的字段名一致（`generate` 模式不得携带）。 */
  sourceImage?: { mime: string; base64: string };
  /** R1：输入图数组（生成可带 0..N 张参考图；编辑恰好一张）。 */
  sourceImages?: { mime: string; base64: string }[];
  /** R1 身份信封：新工作台执行必带；服务端据此登记尝试与容量。 */
  identity?: import("./image-execution-contract").ImageAttemptIdentity;
};

export type AiImageCallResult =
  | {
      ok: true;
      configId: string;
      model: string;
      mime: string;
      imageBase64: string;
      /** 相同 attemptId 的重复请求命中了已保存结果：零新的供应商调用。 */
      reused?: true;
      /** 产物已落库但会话转存未核对成功：客户端停止后续项，保留供下载。 */
      pendingSave?: true;
      attempt?: ImageAttemptOutcome;
    }
  | {
      ok: true;
      /** 产物已转存进会话（临时副本已清理）：按引用处理，刷新会话取回。 */
      transferred: true;
      mime?: string;
      attempt?: ImageAttemptOutcome;
    }
  | {
      ok: false;
      code: string;
      detail: string;
      status: number;
      attempt?: ImageAttemptOutcome;
      /** true = 服务端确认本次请求已进入供应商调用阶段；缺省/false = 未出站或回放。 */
      providerCalled?: true;
    };

export type AiImageCaller = (request: AiImageCallRequest, signal?: AbortSignal) => Promise<AiImageCallResult>;

function readAttempt(value: unknown): ImageAttemptOutcome | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.attemptId !== "string" || typeof record.status !== "string") return undefined;
  return {
    attemptId: record.attemptId,
    status: record.status as ImageAttemptOutcome["status"],
    ...(typeof record.itemId === "string" ? { itemId: record.itemId } : {}),
    ...(typeof record.errorCode === "string" ? { errorCode: record.errorCode } : {}),
    ...(typeof record.artifactId === "string" ? { artifactId: record.artifactId } : {}),
    ...(typeof record.artifactDigest === "string" ? { artifactDigest: record.artifactDigest } : {}),
    ...(typeof record.deadlineAt === "string" ? { deadlineAt: record.deadlineAt } : {}),
    ...(record.expired === true ? { expired: true } : {})
  };
}

export function createAiImageCaller(
  options: { endpoint?: string; fetchImpl?: typeof fetch } = {}
): AiImageCaller {
  const endpoint = options.endpoint ?? AI_IMAGE_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? apiFetch;
  return async function callImage(request, signal) {
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          configId: request.configId,
          mode: request.mode,
          prompt: request.prompt,
          size: request.size,
          quality: request.quality,
          ...(request.outputFormat !== undefined ? { outputFormat: request.outputFormat } : {}),
          ...(request.sourceImages?.length ? { sourceImages: request.sourceImages } : {}),
          ...(request.identity ? { identity: request.identity } : {})
        }),
        ...(signal ? { signal } : {})
      });
      const payload = (await response.json().catch(() => null)) as {
        ok?: unknown;
        configId?: unknown;
        model?: unknown;
        mime?: unknown;
        imageBase64?: unknown;
        reused?: unknown;
        pendingSave?: unknown;
        transferred?: unknown;
        attempt?: unknown;
        /** true = 本次请求已进入供应商调用阶段。 */
        providerCalled?: unknown;
        code?: unknown;
        detail?: unknown;
      } | null;
      const attempt = readAttempt(payload?.attempt);
      const providerCalled = payload?.providerCalled === true;
      if (!response.ok || payload?.ok !== true) {
        return {
          ok: false,
          code: typeof payload?.code === "string" ? payload.code : "IMAGE_GATEWAY_ERROR",
          detail:
            typeof payload?.detail === "string" ? payload.detail : `图片接口返回 ${response.status}。`,
          status: response.status,
          ...(attempt ? { attempt } : {}),
          ...(providerCalled ? { providerCalled: true as const } : {})
        };
      }
      if (payload.transferred === true) {
        return {
          ok: true,
          transferred: true,
          ...(typeof payload.mime === "string" ? { mime: payload.mime } : {}),
          ...(attempt ? { attempt } : {})
        };
      }
      if (typeof payload.imageBase64 !== "string" || typeof payload.mime !== "string") {
        return { ok: false, code: "IMAGE_GATEWAY_MALFORMED", detail: "图片接口响应缺少图片内容。", status: 502 };
      }
      return {
        ok: true,
        configId: typeof payload.configId === "string" ? payload.configId : request.configId,
        model: typeof payload.model === "string" ? payload.model : "",
        mime: payload.mime,
        imageBase64: payload.imageBase64,
        ...(payload.reused === true ? { reused: true as const } : {}),
        ...(payload.pendingSave === true ? { pendingSave: true as const } : {}),
        ...(attempt ? { attempt } : {}),
        ...(providerCalled ? { providerCalled: true as const } : {})
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        ok: false,
        code: "IMAGE_GATEWAY_UNREACHABLE",
        detail: error instanceof Error ? error.message : "图片接口请求失败。",
        status: 0
      };
    }
  };
}

/** R1：按 attemptId 查询原尝试（只查询，不触发模型或图片请求）。 */
export type ImageAttemptQueryResult =
  | { ok: true; attempt: ImageAttemptOutcome & { result?: { mime: string; imageBase64: string; bytes: number } } }
  | { ok: false; code: string; detail: string };

export async function queryImageAttempt(
  attemptId: string,
  options: { endpoint?: string; fetchImpl?: typeof fetch } = {}
): Promise<ImageAttemptQueryResult> {
  const fetchImpl = options.fetchImpl ?? apiFetch;
  const base = options.endpoint ?? AI_IMAGE_ATTEMPT_ENDPOINT;
  let response: Response;
  try {
    response = await fetchImpl(`${base}/${encodeURIComponent(attemptId)}`, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store"
    });
  } catch (error) {
    return {
      ok: false,
      code: "IMAGE_ATTEMPT_QUERY_FAILED",
      detail: error instanceof Error ? error.message : "尝试查询请求失败。"
    };
  }
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || payload?.ok !== true) {
    return {
      ok: false,
      code: typeof payload?.code === "string" ? payload.code : "IMAGE_ATTEMPT_QUERY_FAILED",
      detail: typeof payload?.detail === "string" ? payload.detail : `尝试查询返回 ${response.status}。`
    };
  }
  const attempt = readAttempt(payload.attempt);
  if (!attempt) {
    return { ok: false, code: "IMAGE_ATTEMPT_QUERY_MALFORMED", detail: "尝试查询响应缺少有效状态。" };
  }
  const rawResult = (payload.attempt as Record<string, unknown>).result as Record<string, unknown> | undefined;
  const result = rawResult && typeof rawResult.imageBase64 === "string" && typeof rawResult.mime === "string"
    ? { mime: rawResult.mime, imageBase64: rawResult.imageBase64, bytes: Number(rawResult.bytes ?? 0) }
    : undefined;
  return { ok: true, attempt: { ...attempt, ...(result ? { result } : {}) } };
}

/** 设置内自助模型配置（本机管理端点）。 */
export const AI_MODEL_SETTINGS_ENDPOINT = "/api/ai/settings/models";

export type ModelSettingsReadResult =
  | { status: "ok"; view: ModelSettingsView }
  | { status: "error"; code: string; detail: string; unreachable: boolean };

/**
 * 读取管理视图（含用户可编辑的模型 ID 与 API 地址）。
 * 只有**已确认结构**的响应才算成功：非法回读不能拿来做编辑基线。
 */
export async function readModelSettings(
  options: { endpoint?: string; fetchImpl?: typeof fetch } = {}
): Promise<ModelSettingsReadResult> {
  const endpoint = options.endpoint ?? AI_MODEL_SETTINGS_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? apiFetch;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store"
    });
  } catch {
    return {
      status: "error",
      code: "AI_SETTINGS_UNREACHABLE",
      detail: "无法连接服务端，请确认服务已启动后重试。",
      unreachable: true
    };
  }
  let payload: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await response.json();
    payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    payload = null;
  }
  if (!response.ok || !payload || payload.ok !== true) {
    return {
      status: "error",
      code: typeof payload?.code === "string" ? payload.code : "AI_SETTINGS_INVALID",
      detail:
        typeof payload?.detail === "string"
          ? payload.detail
          : modelSettingsErrorDetail(typeof payload?.code === "string" ? payload.code : "AI_SETTINGS_INVALID"),
      unreachable: false
    };
  }
  const revision = typeof payload.revision === "string" ? payload.revision : "";
  if (!isModelSettingsView(payload)) {
    // 结构不确认：不能当成可编辑的服务端状态。
    return {
      status: "error",
      code: "AI_SETTINGS_UNVERIFIED",
      detail: "服务端未返回可确认的模型配置状态。",
      unreachable: false
    };
  }
  return {
    status: "ok",
    view: {
      ok: true,
      revision,
      writable: payload.writable === true,
      ...(typeof payload.executionEnabled === "boolean" ? { executionEnabled: payload.executionEnabled } : {}),
      ...(typeof payload.readOnlyReason === "string" ? { readOnlyReason: payload.readOnlyReason } : {}),
      chat: payload.chat as ModelSettingsView["chat"],
      image: payload.image as ModelSettingsView["image"]
    }
  };
}

export type ModelSettingsSaveResult =
  | { ok: true; view: ModelSettingsView }
  | { ok: false; code: string; detail: string; conflict: boolean; unverified: boolean };

/**
 * 保存提供方操作批次。成功必须以**服务端回读**（同结构视图）确认；
 * 409 不自动重试、不自动覆盖，交给调用方保留草稿并比较。
 */
export async function saveModelSettings(
  request: ModelSettingsRequest,
  options: { endpoint?: string; fetchImpl?: typeof fetch } = {}
): Promise<ModelSettingsSaveResult> {
  const endpoint = options.endpoint ?? AI_MODEL_SETTINGS_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? apiFetch;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "PUT",
      headers: { "content-type": "application/json", accept: "application/json" },
      cache: "no-store",
      body: JSON.stringify(request)
    });
  } catch (error) {
    return {
      ok: false,
      code: "AI_SETTINGS_UNREACHABLE",
      detail: error instanceof Error ? error.message : "无法连接服务端。",
      conflict: false,
      unverified: false
    };
  }
  let payload: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await response.json();
    payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    payload = null;
  }
  const code = typeof payload?.code === "string" ? payload.code : "AI_SETTINGS_INVALID";
  if (!response.ok) {
    return {
      ok: false,
      code,
      detail: typeof payload?.detail === "string" ? payload.detail : modelSettingsErrorDetail(code),
      conflict: response.status === 409 || code === "AI_SETTINGS_CONFLICT",
      unverified: false
    };
  }
  // HTTP 200 不等于已确认：必须能读出结构完整的回读视图。
  const revision = typeof payload?.revision === "string" ? payload.revision : "";
  if (!isModelSettingsView(payload)) {
    return {
      ok: false,
      code: "AI_SETTINGS_UNVERIFIED",
      detail: "服务端返回的回读结果无法确认，本次保存结果未确认。请先刷新服务端状态核对，再决定是否重试。",
      conflict: false,
      unverified: true
    };
  }
  return {
    ok: true,
    view: {
      ok: true,
      revision,
      writable: payload.writable === true,
      ...(typeof payload.executionEnabled === "boolean" ? { executionEnabled: payload.executionEnabled } : {}),
      ...(typeof payload.readOnlyReason === "string" ? { readOnlyReason: payload.readOnlyReason } : {}),
      chat: payload.chat as ModelSettingsView["chat"],
      image: payload.image as ModelSettingsView["image"]
    }
  };
}

/** 拉取端点可用模型（本机管理端点；只读端点，不写任何配置）。 */
export const AI_MODEL_DISCOVERY_ENDPOINT = "/api/ai/settings/models/discover";

export type ModelDiscoveryRequest = {
  kind: ProviderKind;
  baseUrl: string;
  /** 对话必填（决定列模型的路径与请求头）；制图不用传。 */
  apiProtocol?: ChatApiProtocol;
  /** 制图：该配置的生成路径，用来定位同一前缀下的 `/models`。 */
  imagesPath?: string;
  /** 已保存的提供方 ID：用它的已存凭据去列模型。 */
  providerId?: string;
  /** 本次在表单里输入的密钥（尚未保存的新提供方）。 */
  apiKey?: string;
};

export type ModelDiscoveryResult =
  | { ok: true; models: { modelId: string; label: string }[]; truncated: boolean }
  | { ok: false; code: string; detail: string };

/**
 * 列模型：成功必须以**可确认的结构**返回（非空模型数组）。
 * 这里不缓存结果、不写草稿：拉到的清单由调用方决定要不要用。
 */
export async function discoverModelSettings(
  request: ModelDiscoveryRequest,
  options: { endpoint?: string; fetchImpl?: typeof fetch } = {}
): Promise<ModelDiscoveryResult> {
  const endpoint = options.endpoint ?? AI_MODEL_DISCOVERY_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? apiFetch;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      cache: "no-store",
      body: JSON.stringify(request)
    });
  } catch {
    return { ok: false, code: "AI_DISCOVERY_UNREACHABLE", detail: "无法连接服务端，请确认服务已启动后重试。" };
  }
  let payload: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await response.json();
    payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    payload = null;
  }
  if (!response.ok || payload?.ok !== true) {
    const code = typeof payload?.code === "string" ? payload.code : "AI_DISCOVERY_FAILED";
    return {
      ok: false,
      code,
      detail: typeof payload?.detail === "string" ? payload.detail : modelSettingsErrorDetail(code)
    };
  }
  const models = Array.isArray(payload.models)
    ? payload.models.flatMap((entry) => {
        const candidate = entry as { modelId?: unknown; label?: unknown } | null;
        if (!candidate || typeof candidate.modelId !== "string" || candidate.modelId.length === 0) return [];
        return [{ modelId: candidate.modelId, label: typeof candidate.label === "string" ? candidate.label : candidate.modelId }];
      })
    : [];
  if (models.length === 0) {
    return { ok: false, code: "AI_DISCOVERY_UNVERIFIED", detail: "服务端没有返回可确认的模型列表。" };
  }
  return { ok: true, models, truncated: payload.truncated === true };
}
