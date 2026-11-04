import { withCustomInstructions } from "@/features/ai/custom-instructions";
/**
 * P1-04：AI Gateway（服务端受控入口）。
 *
 * 职责（只有这些）：
 * - 校验客户端请求：只接受受控配置 ID 与已声明的任务类型，拒绝任意 baseUrl / 任意模型参数；
 * - 在服务端拼装最终 messages：系统提示由服务端固定定义，客户端内容只作为数据进入 user 消息；
 * - 尺寸与预算：限制输入长度与输出 token；
 * - 超时与取消：转发 AbortSignal，超时明确失败；
 * - 错误映射：把 Provider 错误映射为可诊断的脱敏结果，不泄漏密钥。
 *
 * 不负责：Prompt 业务内容、结果 Schema 校验（调用方负责）、业务写权限（Gateway 没有）。
 */
import {
  AiProviderError,
  createOpenAiCompatibleProvider,
  redactForLog,
  type AiMessage,
  type AiModelProvider
} from "./openai-compatible-provider";
import type { WorkbenchStreamEvent } from "./stream-protocols";
import { NATIVE_SEARCH_ARGS, NATIVE_SEARCH_ERRORS } from "@/features/ai/native-search-contract";
import { NativeSearchError, runNativeSearch } from "./native-search";
import {
  ModelConfigError,
  safeConfigDetail,
  type ModelConfigStore,
  type ResolvedModelConfig
} from "./model-config";

/** 已声明的任务类型；不在列表内一律拒绝。 */
export const GATEWAY_TASK_TYPES = [
  "workbench_chat",
  "workbench_chat_stream",
  "workbench_plan",
  "workbench_web_search",
  "organize_page",
  "organize_captures",
  "analyze_notebook",
  "generate_page_metadata",
  "answer_search",
  /**
   * P8：受限计划的两次请求。工具执行在**浏览器侧**完成，Gateway 只做固定提示 +
   * 结构化输出，不注册任何工具给供应商（配置里 `tools` 仍固定 false）。
   */
  "plan_collection",
  "synthesize_collection",
  /** 图像提示设计由服务端注入 huashu-gpt-image 正文；图片执行走独立端点。 */
  "design_image_prompt"
] as const;
export type GatewayTaskType = (typeof GATEWAY_TASK_TYPES)[number];

export const GATEWAY_LIMITS = {
  /** 单次请求中用户内容的最大字符数。 */
  maxInputChars: 60_000,
  maxOutputTokens: 8_000,
  timeoutMs: 60_000
};

/** 视觉请求里的一张图片：只接受本项目支持的三种类型与受限字节数。 */
export type GatewayImageInput = { mime: string; base64: string };

/** 只有声明支持视觉的任务才可以带图片（其余任务带图片一律拒绝）。 */
export const GATEWAY_VISION_TASKS: readonly GatewayTaskType[] = [
  "workbench_chat", "workbench_plan", "workbench_chat_stream"
];

export const GATEWAY_IMAGE_LIMITS = {
  /** 单张图片字节上限（与 creation-media 的送模型边界一致：512KiB）。 */
  bytesPerImage: 512 * 1024,
  /** 单次请求图片张数上限（与作品图片上限一致：9 张）。 */
  images: 9,
  types: ["image/jpeg", "image/png", "image/webp"] as const
} as const;

export type GatewayRequest = {
  configId: string;
  task: GatewayTaskType;
  /** 任务输入（本地组装好的上下文文本）。它只是数据，不是指令。 */
  input: string;
  /**
   * P9-04：视觉任务随请求携带的**已按边界处理**的图片（解码后的 JPEG、已去元数据）。
   * 服务端只在配置声明 `capabilities.vision` 时接受，且只允许出现在 `GATEWAY_VISION_TASKS` 里。
   */
  images?: GatewayImageInput[];
  /**
   * 增量流式开关：`true` 时路由走 NDJSON 事件分支（逐行事件、恰好一个终止事件）。
   * 它只选择读取方式，不改变出站参数；缺省即一次性 JSON 响应。
   */
  stream?: boolean;
  signal?: AbortSignal;
};

/**
 * Gateway 依赖：只有受控配置、服务端固定的提示与 Schema，以及（测试用）fetch 注入。
 * Provider 由 Gateway 依据配置在服务端创建——不接受调用方传入任意 Provider/端点。
 */
export type GatewayDependencies = {
  configs: ModelConfigStore;
  /** Server-read account preferences, captured once for this request/task. */
  customInstructions?: string;
  /** 服务端固定的系统提示 + 输入封装；客户端无法覆盖。 */
  buildMessages: (
    task: GatewayTaskType,
    input: string,
    images?: readonly GatewayImageInput[]
  ) => AiMessage[];
  /** 结构化输出 Schema（服务端固定）。 */
  responseSchema?: { name: string; schema: unknown };
  timeoutMs?: number;
  /** 仅用于进程内受控 mock；生产使用全局 fetch。 */
  fetchImpl?: typeof fetch;
};

export type GatewaySuccess = {
  ok: true;
  content: string;
  model: string;
  configId: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  finishReason?: string;
};

export type GatewayFailure = {
  ok: false;
  code: string;
  /** 已脱敏、可直接返回客户端或写日志的说明。 */
  detail: string;
  status: number;
};

export type GatewayResult = GatewaySuccess | GatewayFailure;

function failure(code: string, detail: string, status: number): GatewayFailure {
  return { ok: false, code, detail, status };
}

function isTaskType(value: unknown): value is GatewayTaskType {
  return typeof value === "string" && (GATEWAY_TASK_TYPES as readonly string[]).includes(value);
}

/** 校验客户端请求形状；未知字段一律拒绝（不静默忽略）。 */
export function parseGatewayRequest(payload: unknown): GatewayRequest | GatewayFailure {
  if (!payload || typeof payload !== "object") {
    return failure("AI_REQUEST_INVALID", "请求体必须是 JSON 对象。", 400);
  }
  const candidate = payload as Partial<GatewayRequest> & Record<string, unknown>;
  const extraKeys = Object.keys(candidate).filter(
    (key) => !["configId", "task", "input", "images", "stream"].includes(key)
  );
  if (extraKeys.length > 0) {
    // 例如 baseUrl / model / apiKey：不接受客户端提供的出站参数。
    return failure("AI_REQUEST_INVALID", `不接受的请求字段：${extraKeys.join(",")}`, 400);
  }
  if (candidate.stream !== undefined && typeof candidate.stream !== "boolean") {
    return failure("AI_REQUEST_INVALID", "stream 必须是布尔值。", 400);
  }
  if (typeof candidate.configId !== "string" || candidate.configId.length === 0) {
    return failure("AI_REQUEST_INVALID", "缺少 configId。", 400);
  }
  if (!isTaskType(candidate.task)) {
    return failure("AI_TASK_UNSUPPORTED", `未启用的任务类型：${String(candidate.task)}。`, 400);
  }
  if (typeof candidate.input !== "string" || candidate.input.trim().length === 0) {
    return failure("AI_REQUEST_INVALID", "缺少任务输入。", 400);
  }
  if (candidate.input.length > GATEWAY_LIMITS.maxInputChars) {
    return failure(
      "AI_INPUT_TOO_LARGE",
      `输入超过 ${GATEWAY_LIMITS.maxInputChars} 字符上限。`,
      413
    );
  }
  if (candidate.task === "workbench_web_search") {
    try {
      if (candidate.stream || !NATIVE_SEARCH_ARGS.safeParse(JSON.parse(candidate.input)).success)
        return failure("AI_SEARCH_INVALID_REQUEST", NATIVE_SEARCH_ERRORS.invalid_request, 400);
    } catch {
      return failure("AI_SEARCH_INVALID_REQUEST", NATIVE_SEARCH_ERRORS.invalid_request, 400);
    }
  }
  let images: GatewayImageInput[] | undefined;
  if (candidate.images !== undefined) {
    if (!GATEWAY_VISION_TASKS.includes(candidate.task))
      return failure("AI_TASK_UNSUPPORTED", `任务 ${candidate.task} 不接受图片输入。`, 400);
    if (!Array.isArray(candidate.images) || candidate.images.length === 0)
      return failure("AI_REQUEST_INVALID", "images 必须是非空数组。", 400);
    if (candidate.images.length > GATEWAY_IMAGE_LIMITS.images)
      return failure(
        "AI_REQUEST_INVALID",
        `images 最多 ${GATEWAY_IMAGE_LIMITS.images} 张。`,
        400
      );
    const checked: GatewayImageInput[] = [];
    for (const [index, entry] of candidate.images.entries()) {
      const image = entry as Partial<GatewayImageInput> | null;
      const extraImageKeys = image
        ? Object.keys(image).filter((key) => !["mime", "base64"].includes(key))
        : [];
      if (!image || extraImageKeys.length > 0)
        return failure("AI_REQUEST_INVALID", `images[${index}] 形状不合法。`, 400);
      if (
        typeof image.mime !== "string" ||
        !(GATEWAY_IMAGE_LIMITS.types as readonly string[]).includes(image.mime)
      )
        return failure("AI_REQUEST_INVALID", `images[${index}].mime 不受支持。`, 400);
      if (typeof image.base64 !== "string" || image.base64.length === 0)
        return failure("AI_REQUEST_INVALID", `images[${index}].base64 必须是字符串。`, 400);
      // base64 长度上限 → 解码后字节上限（3 字节 ≈ 4 字符）。
      if (image.base64.length > Math.ceil((GATEWAY_IMAGE_LIMITS.bytesPerImage / 3) * 4))
        return failure("AI_INPUT_TOO_LARGE", `images[${index}] 超过单图字节上限。`, 413);
      checked.push({ mime: image.mime, base64: image.base64 });
    }
    images = checked;
  }
  return {
    configId: candidate.configId,
    task: candidate.task,
    input: candidate.input,
    ...(images ? { images } : {}),
    // 只透传开关本身；路由据此选择读取方式。
    ...(candidate.stream === true ? { stream: true } : {})
  };
}

function mapProviderError(error: unknown, apiKey: string): GatewayFailure {
  if (error instanceof ModelConfigError) {
    const status = error.code === "AI_KEY_MISSING" ? 503 : error.code === "AI_DISABLED" ? 503 : 400;
    /*
     * 只回稳定码 + 固定安全文案：`error.message` 里带端点与环境变量名（服务端诊断用），
     * 一旦回给浏览器就是内网拓扑与凭据位置的泄漏。真实失败仍然可区分——每个码都有自己的文案。
     */
    return failure(error.code, safeConfigDetail(error.code), status);
  }
  if (error instanceof AiProviderError) {
    const status =
      error.code === "AI_TIMEOUT"
        ? 504
        : error.code === "AI_CANCELLED"
          ? 499
          : error.code === "AI_RATE_LIMITED"
            ? 429
            : error.code === "AI_RESPONSE_TOO_LARGE"
              ? 502
              : error.code === "AI_UNSUPPORTED_CAPABILITY"
                ? 400
                : 502;
    return failure(error.code, error.message, status);
  }
  return failure(
    "AI_INTERNAL_ERROR",
    redactForLog(error instanceof Error ? error.message : String(error), apiKey),
    500
  );
}

/**
 * 执行一次受控模型调用。任何失败都返回明确结果，绝不返回假成功。
 */
/**
 * 流式网关：与 `runGateway` 共用同一套开关、任务白名单与配置解析，只是把结果变成事件流。
 * 任何失败都以 `error` + `done` 收束，调用方不会停在半个流上。
 */
export async function* runGatewayStream(
  deps: GatewayDependencies,
  request: GatewayRequest
): AsyncGenerator<WorkbenchStreamEvent> {
  if (request.task === "workbench_web_search") {
    yield { type: "error", code: "AI_SEARCH_INVALID_REQUEST", message: NATIVE_SEARCH_ERRORS.invalid_request, retryable: false };
    yield { type: "done", reason: "error" };
    return;
  }
  if (!deps.configs.enabled()) {
    yield { type: "error", code: "AI_DISABLED", message: "未配置任何模型，AI 能力不可用。", retryable: false };
    yield { type: "done", reason: "error" };
    return;
  }
  let config: ResolvedModelConfig;
  try {
    config = deps.configs.resolve(request.configId);
  } catch (error) {
    const mapped = mapProviderError(error, "");
    yield { type: "error", code: mapped.code, message: mapped.detail, retryable: false };
    yield { type: "done", reason: "error" };
    return;
  }
  if (request.images && request.images.length > 0 && !config.capabilities.vision) {
    yield {
      type: "error",
      code: "AI_UNSUPPORTED_CAPABILITY",
      message: `配置 ${config.id} 未声明视觉能力，拒绝发送图片。`,
      retryable: false
    };
    yield { type: "done", reason: "error" };
    return;
  }
  const provider = createOpenAiCompatibleProvider(config, {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
  });
  if (!provider.generateStream) {
    yield { type: "error", code: "AI_UNSUPPORTED_CAPABILITY", message: "该配置不支持流式输出。", retryable: false };
    yield { type: "done", reason: "error" };
    return;
  }
  try {
    const messages = withCustomInstructions(request.task, deps.buildMessages(request.task, request.input, request.images), deps.customInstructions);
    yield { type: "model_meta", model: config.model };
    for await (const event of provider.generateStream({
      messages,
      maxOutputTokens: GATEWAY_LIMITS.maxOutputTokens,
      timeoutMs: deps.timeoutMs ?? GATEWAY_LIMITS.timeoutMs,
      signal: request.signal,
      ...(deps.responseSchema ? { responseSchema: deps.responseSchema } : {})
    })) {
      yield event;
    }
  } catch (error) {
    const mapped = mapProviderError(error, config.apiKey);
    yield { type: "error", code: mapped.code, message: mapped.detail, retryable: true };
    yield { type: "done", reason: "error" };
  }
}

export async function runGateway(
  deps: GatewayDependencies,
  request: GatewayRequest
): Promise<GatewayResult> {
  if (!deps.configs.enabled()) {
    return failure("AI_DISABLED", "未配置任何模型，AI 能力不可用。", 503);
  }

  let config: ResolvedModelConfig;
  try {
    config = deps.configs.resolve(request.configId);
  } catch (error) {
    return mapProviderError(error, "");
  }

  if (request.task === "workbench_web_search") {
    try {
      const args = NATIVE_SEARCH_ARGS.parse(JSON.parse(request.input));
      if (request.stream || request.images?.length)
        return failure("AI_SEARCH_INVALID_REQUEST", NATIVE_SEARCH_ERRORS.invalid_request, 400);
      const result = await runNativeSearch(config, args, request.signal, deps.fetchImpl);
      return { ok: true, content: JSON.stringify(result), model: config.model, configId: config.id };
    } catch (error) {
      const code = error instanceof NativeSearchError ? error.code : "invalid_request";
      const status = code === "invalid_request" || code === "unsupported" ? 400 : code === "cancelled" ? 499 : 502;
      return failure(`AI_SEARCH_${code.toUpperCase()}`, NATIVE_SEARCH_ERRORS[code], status);
    }
  }

  /*
   * P9-04：图片只在**配置明确声明 vision** 时上行——不看模型名字，也不靠"文本能用"推断。
   */
  if (request.images && request.images.length > 0 && !config.capabilities.vision)
    return failure(
      "AI_UNSUPPORTED_CAPABILITY",
      `配置 ${config.id} 未声明视觉能力，拒绝发送图片。`,
      400
    );
  const provider: AiModelProvider = createOpenAiCompatibleProvider(config, {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
  });
  try {
    const messages = withCustomInstructions(request.task, deps.buildMessages(request.task, request.input, request.images), deps.customInstructions);
    const response = await provider.generate({
      messages,
      maxOutputTokens: GATEWAY_LIMITS.maxOutputTokens,
      timeoutMs: deps.timeoutMs ?? GATEWAY_LIMITS.timeoutMs,
      signal: request.signal,
      ...(deps.responseSchema ? { responseSchema: deps.responseSchema } : {})
    });
    return {
      ok: true,
      content: response.content,
      model: response.model || config.model,
      configId: config.id,
      usage: response.usage,
      finishReason: response.finishReason
    };
  } catch (error) {
    return mapProviderError(error, config.apiKey);
  }
}
