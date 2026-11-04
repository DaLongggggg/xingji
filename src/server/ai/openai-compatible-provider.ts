/**
 * 对话 Provider：Vercel AI SDK（ai@7）驱动的三协议出口。
 *
 * 自写协议代码（请求拼装、SSE 分帧、三家 payload 解析）已由 SDK 取代：
 * - openai-completions → @ai-sdk/openai-compatible（含 reasoning_content 转发、includeUsage）；
 * - openai-responses   → @ai-sdk/openai.responses（结构化输出走 SDK Output，wire 上仍是 text.format）；
 * - anthropic-messages → @ai-sdk/anthropic（baseURL 统一补 /v1，与旧行为一致）。
 *
 * 本文件保留的**安全与业务薄层**（SDK 不提供，属本项目的受控出站边界）：
 * - 不跟随重定向（redirect: manual，3xx 直接拒绝）；
 * - 响应正文按字节上限流式读取，超限立即停止消费上游；
 * - 密钥脱敏与长度截断（redactForLog）；
 * - json_object 配置时把 Schema 作为系统指令下发（wire 上的 JSON 模式约束经
 *   中间件注入；SDK 的 Output.json 也能表达该形态，选中间件是为了与 completions
 *   透传一致的原始文本返回语义）；
 * - completions 协议经 providerOptions 自定义字段透传 response_format（SDK 文档化行为），
 *   保持**原始文本**返回——调用方的一次格式修复回路不因 SDK 预解析而失效；
 * - 重试一律关闭（maxRetries/streamRetries = 0）：上游调用次数由调用方账目记录，
 *   SDK 自动重试会与"每次出站一个 attempt"的语义叠加重复计费。
 */
import { generateText, streamText, Output, jsonSchema, APICallError, InvalidResponseDataError, TypeValidationError, wrapLanguageModel, type ModelMessage, type OutputInterface } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { ResolvedModelConfig } from "./model-config";
import type { WorkbenchStreamEvent } from "./stream-protocols";

export type AiMessageRole = "system" | "user" | "assistant";

/**
 * 多模态消息内容：纯文本，或 OpenAI 兼容的 content parts 数组
 * （本项目只用 `text` 与 `image_url` 两种 part；图片只允许 data URL）。
 */
export type AiTextPart = { type: "text"; text: string };
export type AiImagePart = { type: "image_url"; image_url: { url: string } };
export type AiContentPart = AiTextPart | AiImagePart;

export type AiMessage = { role: AiMessageRole; content: string | AiContentPart[] };

export type AiGenerateRequest = {
  messages: AiMessage[];
  /** 期望的结构化输出（JSON Schema）；供应商不支持时显式失败。 */
  responseSchema?: { name: string; schema: unknown };
  maxOutputTokens: number;
  temperature?: number;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type AiGenerateUsage = { inputTokens?: number; outputTokens?: number };

export type AiGenerateResponse = {
  /** 模型返回的文本内容（结构化模式为 JSON 字符串）。 */
  content: string;
  model: string;
  usage?: AiGenerateUsage;
  /** 用于诊断，不含密钥与完整正文。 */
  finishReason?: string;
};

export interface AiModelProvider {
  readonly id: string;
  generate(request: AiGenerateRequest): Promise<AiGenerateResponse>;
  /** 增量流式：事件形状见 `features/ai/stream-events`（NDJSON 传输）。 */
  generateStream?(request: AiGenerateRequest): AsyncGenerator<WorkbenchStreamEvent>;
}

export class AiProviderError extends Error {
  constructor(
    readonly code:
      | "AI_TIMEOUT"
      | "AI_CANCELLED"
      | "AI_UPSTREAM_ERROR"
      | "AI_RATE_LIMITED"
      | "AI_MALFORMED_RESPONSE"
      | "AI_RESPONSE_TOO_LARGE"
      | "AI_UNSUPPORTED_CAPABILITY"
      | "AI_NETWORK_ERROR",
    detail: string,
    readonly status?: number
  ) {
    super(`${code}:${detail}`);
    this.name = "AiProviderError";
  }
}

/** 脱敏：去掉可能的密钥片段，并截断长度。 */
export function redactForLog(value: string, apiKey?: string): string {
  let text = value;
  if (apiKey && apiKey.length > 0) text = text.split(apiKey).join("[REDACTED]");
  // 常见 Bearer 形式也一并脱敏。
  text = text.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]");
  text = text.replace(/sk-[A-Za-z0-9._\-]{8,}/g, "[REDACTED]");
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

export type OpenAiCompatibleOptions = {
  /** 注入 fetch 以便进程内受控 mock；生产默认用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 结构化输出模式：json_schema 为默认，供应商不支持时显式失败。 */
  structuredOutput?: boolean;
};

/**
 * R6：响应正文按**实际字节**限额，超限立即停止读取。
 * wire 上限分两档：非流式 JSON 512KiB（与有效内容上限同值），流式 SSE 16MiB
 * （大量小增量不能被非流式正文上限误拒）。有效内容（正文/思考）另有 512KiB 上限，
 * 在事件映射层判定。
 */
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_STREAM_WIRE_BYTES = 16 * 1024 * 1024;

/** 预先取消的请求不发送。 */
function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new AiProviderError("AI_CANCELLED", "请求在发送前已被取消。");
  }
}

/** 超时/取消统一作用域：一个 controller 同时挂调用方 signal 与计时器，清理走同一出口。 */
function abortScope(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const isCancelled = () => signal?.aborted === true;
  return {
    signal: controller.signal,
    /** 立即中止上游（本地判定超限/失败时不再继续消费供应商流）。 */
    abort: () => controller.abort(),
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
    /** 中止归类：调用方取消优先于超时（与旧实现一致）。 */
    classifyAbort: () => (isCancelled() ? "AI_CANCELLED" : "AI_TIMEOUT")
  };
}

/** 在错误（含 SDK 包装的 cause 链）里找回本层抛出的 AiProviderError。 */
function findAiProviderError(error: unknown): AiProviderError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (current instanceof AiProviderError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** SDK/网络错误 → 统一错误码（脱敏后）。 */
function mapError(error: unknown, apiKey: string, abortKind: () => "AI_CANCELLED" | "AI_TIMEOUT"): AiProviderError {
  const own = findAiProviderError(error);
  if (own) return own;
  if (isAbortError(error)) {
    const code = abortKind();
    return new AiProviderError(code, code === "AI_TIMEOUT" ? "请求超时。" : "请求已取消。");
  }
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 429) return new AiProviderError("AI_RATE_LIMITED", "上游限流。", 429);
    /*
     * SDK 的 createJsonResponseHandler 把「响应体不符合协议 schema」包成
     * APICallError('Invalid JSON response', statusCode=200, cause=校验错误)；
     * Responses 侧的 no-output 是合成 500。两者都是**响应内容性**失败，不是上游 HTTP 错误。
     * 正文读取期间被超时/取消打断 → cause 链里有 AbortError，按中止语义归类。
     */
    if (findAbortCause(error)) {
      const code = abortKind();
      return new AiProviderError(code, code === "AI_TIMEOUT" ? "请求超时。" : "请求已取消。");
    }
    if (error.statusCode === 200 || /returned no output/i.test(error.message)) {
      return new AiProviderError("AI_MALFORMED_RESPONSE", "上游响应缺少完整文本结果。");
    }
    if (error.statusCode === undefined && findValidationCause(error)) {
      return new AiProviderError("AI_MALFORMED_RESPONSE", redactForLog(error.message, apiKey));
    }
    if (error.statusCode === undefined) {
      return new AiProviderError("AI_NETWORK_ERROR", redactForLog(error.message, apiKey));
    }
    return new AiProviderError(
      "AI_UPSTREAM_ERROR",
      redactForLog(error.message || `上游返回 ${error.statusCode}。`, apiKey),
      error.statusCode
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  // SDK 对响应形状的校验失败（choices 缺失/类型不符/结构化输出不可解析）按畸形响应归类。
  if (error instanceof InvalidResponseDataError || error instanceof TypeValidationError) {
    return new AiProviderError("AI_MALFORMED_RESPONSE", redactForLog(message, apiKey));
  }
  if (/JSON|parse|schema/i.test(error?.constructor?.name ?? "")) {
    return new AiProviderError("AI_MALFORMED_RESPONSE", redactForLog(message, apiKey));
  }
  return new AiProviderError("AI_NETWORK_ERROR", redactForLog(message, apiKey));
}

/** 沿 cause 链找 SDK 的响应校验错误（8 层内）。 */
function findValidationCause(error: unknown): boolean {
  let current: unknown = (error as { cause?: unknown })?.cause;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (current instanceof InvalidResponseDataError || current instanceof TypeValidationError) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** 沿 cause 链找中止错误（正文读取被打断时 SDK 可能包装）。 */
function findAbortCause(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (isAbortError(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * 受控 fetch 薄层：拒绝重定向 + 响应正文按字节上限流式读取（超限立即停止）。
 * SDK 的鉴权头/请求体原样通过；这里只加出站边界。
 */
function createGuardedFetch(apiKey: string, fetchImpl: typeof fetch, wireBytes: number): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetchImpl(input, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      throw new AiProviderError("AI_UPSTREAM_ERROR", "上游返回重定向，已拒绝跟随。", response.status);
    }
    if (!response.body || [204, 205, 304].includes(response.status)) return response;
    let total = 0;
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > wireBytes) {
          throw new AiProviderError(
            "AI_RESPONSE_TOO_LARGE",
            `响应超过 ${wireBytes} 字节（含错误响应）。`
          );
        }
        controller.enqueue(chunk);
      }
    });
    /*
     * 显式 pipeTo 并接住 promise：中止信号触发或转换抛错时管道 promise 会拒绝，
     * 拒绝在此处理，读侧仍收到错误；中止会取消源流。SDK 读侧提前退出的
     * 连续转换取消问题由 generateStream 的中止、读完与释放处理。
     */
    void response.body.pipeTo(transform.writable, { signal: init?.signal ?? undefined })
      .catch(() => undefined);
    return new Response(transform.readable, response);
  };
}

const DATA_URL_IMAGE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/;

/**
 * AiMessage → SDK 提示。v7 起 system 角色不允许出现在 messages 里：这里把 system
 * 消息抽成 `system` 选项（各 provider 会放到自己的 wire 位置：completions 仍是
 * 首条 system 消息、responses 是 instructions、anthropic 是 system 块）。
 * 图片 part 仅允许出现在用户消息（与旧协议层一致）。
 */
function toPrompt(messages: AiMessage[]): { system: string[]; messages: ModelMessage[] } {
  const system: string[] = [];
  const mapped: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      if (typeof message.content !== "string" && !message.content.every(part => part.type === "text")) {
        throw new AiProviderError("AI_UNSUPPORTED_CAPABILITY", "系统消息只支持文本。");
      }
      const text = typeof message.content === "string"
        ? message.content
        : message.content.map(part => (part as { text: string }).text).join("\n");
      if (text.trim().length > 0) system.push(text);
      continue;
    }
    if (typeof message.content === "string") {
      mapped.push({ role: message.role, content: message.content } as ModelMessage);
      continue;
    }
    const content = message.content.map(part => {
      if (part.type === "text") return { type: "text" as const, text: part.text };
      if (message.role !== "user") {
        throw new AiProviderError("AI_UNSUPPORTED_CAPABILITY", "图片只能出现在用户消息中。");
      }
      const match = DATA_URL_IMAGE.exec(part.image_url.url);
      if (!match) throw new AiProviderError("AI_UNSUPPORTED_CAPABILITY", "图片格式不受支持。");
      return { type: "file" as const, data: match[2], mediaType: match[1] };
    });
    mapped.push({ role: message.role, content } as ModelMessage);
  }
  return { system, messages: mapped };
}

/** json_object 模式的系统指令（Schema 全文由本层下发，运行时校验兜底）。 */
function jsonInstruction(schema: unknown): string {
  return `Return only a JSON object matching this schema: ${JSON.stringify(schema)}`;
}

type Protocol = NonNullable<ResolvedModelConfig["apiProtocol"]>;

/** callOptions 的显式形状：SDK 调用参数的可选子集（结构化输出只在非流式带 output）。 */
type SdkProviderOptions = NonNullable<Parameters<typeof generateText>[0]["providerOptions"]>;
/** providerOptions 的值类型（JSON）：服务端固定的 JSON Schema 属于合法 JSON，收窄一次。 */
type SdkProviderOptionValue = NonNullable<SdkProviderOptions[keyof SdkProviderOptions]>;
/** wrapLanguageModel 接受的具体模型规格（ai 包对外是版本联合，这里取中间件侧的窄类型）。 */
type SdkMiddlewareModel = NonNullable<Parameters<typeof wrapLanguageModel>[0]["model"]>;
/** 中间件本体（声明可为数组，统一收敛为单个取 transformParams）。 */
type SdkMiddleware = Exclude<NonNullable<Parameters<typeof wrapLanguageModel>[0]["middleware"]>, unknown[]>;
/** 中间件 transformParams 的入参形状。 */
type SdkTransformParams = Parameters<NonNullable<SdkMiddleware["transformParams"]>>[0]["params"];
/** 流式注入用的 responseFormat 形状（与 LanguageModelCallOptions 同一字段）。 */
type StreamResponseFormat = SdkTransformParams["responseFormat"];

/** 中间件注入 responseFormat：wire 上表达 json（无 schema = json_object）/ json_schema。 */
function withResponseFormat(model: SdkMiddlewareModel, responseFormat: StreamResponseFormat): SdkMiddlewareModel {
  return wrapLanguageModel({
    model,
    middleware: {
      transformParams: async ({ params }) => ({ ...params, responseFormat })
    }
  });
}
type SdkCallOptions = {
  system?: string;
  messages: ModelMessage[];
  maxOutputTokens: number;
  temperature?: number;
  maxRetries: number;
  providerOptions?: SdkProviderOptions;
  output?: OutputInterface;
};

export function createOpenAiCompatibleProvider(
  config: ResolvedModelConfig,
  options: OpenAiCompatibleOptions = {}
): AiModelProvider {
  const structuredOutput = options.structuredOutput ?? config.capabilities.structuredOutput;
  const protocol = (config.apiProtocol ?? "openai-completions") as Protocol;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const base = config.baseUrl.replace(/\/+$/, "");

  /** 每档 wire 上限各建一套模型实例（fetch 薄层按档定界）。 */
  const modelFor = (wireBytes: number): SdkMiddlewareModel => {
    const fetch = createGuardedFetch(config.apiKey, fetchImpl, wireBytes);
    if (protocol === "openai-completions") {
      return createOpenAICompatible({
        name: "xingji",
        baseURL: base,
        apiKey: config.apiKey,
        includeUsage: true,
        supportsStructuredOutputs: config.responseFormat === "json_schema",
        fetch
      }).chatModel(config.model);
    }
    if (protocol === "openai-responses") {
      return createOpenAI({ baseURL: base, apiKey: config.apiKey, fetch }).responses(config.model);
    }
    // anthropic-messages：SDK 的 baseURL 是「前缀 + /messages」，统一补 /v1（与旧实现一致）。
    return createAnthropic({
      baseURL: base.endsWith("/v1") ? base : `${base}/v1`,
      apiKey: config.apiKey,
      fetch
    })(config.model);
  };

  /**
   * 出站参数组装：completions 协议经 providerOptions 自定义字段透传 response_format
   * （保持原始文本返回）；responses/anthropic 的 json_schema 走 SDK Output（wire 上是
   * text.format / 原生 output_format）。json_object 配置统一注入系统指令，且
   * responses 侧经 `withResponseFormat` 在 wire 上声明 `text.format {type:"json_object"}`
   * （SDK 另有 Output.json 可表达同一 wire 形态，这里选中间件是为了与 completions
   * 透传保持同一"原始文本返回"语义；anthropic 侧旧实现本来就不发 wire 格式字段）。
   */
  function callOptions(request: AiGenerateRequest, prompt: { system: string[]; messages: ModelMessage[] }): SdkCallOptions {
    const schema = request.responseSchema;
    const jsonObject = config.responseFormat === "json_object";
    const system = schema && jsonObject ? [jsonInstruction(schema.schema), ...prompt.system] : prompt.system;
    const base = {
      ...(system.length > 0 ? { system: system.join("\n\n") } : {}),
      messages: prompt.messages,
      maxOutputTokens: request.maxOutputTokens,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      // 重试归调用方（attempt 账目）：SDK 层一律不自动重试。
      maxRetries: 0
    };
    if (!schema) {
      return {
        ...base,
        ...(protocol === "openai-responses" ? { providerOptions: { openai: { store: false } } } : {})
      };
    }
    if (protocol === "openai-completions") {
      return {
        ...base,
        providerOptions: {
          xingji: {
            response_format: (jsonObject
              ? { type: "json_object" }
              : { type: "json_schema", json_schema: { name: schema.name, schema: schema.schema, strict: true } }
            ) as SdkProviderOptionValue
          } as SdkProviderOptions
        }
      };
    }
    if (protocol === "openai-responses") {
      return {
        ...base,
        providerOptions: { openai: { store: false } },
        ...(jsonObject
          ? {}
          : { output: Output.object({ schema: jsonSchema(schema.schema as Record<string, unknown>), name: schema.name }) })
      };
    }
    // anthropic：json_object → 只发系统指令（wire 无格式字段，与旧实现一致）；
    // json_schema → SDK 原生结构化输出（output_format），取代旧实现里未被官方接受的 output_config 字段。
    return jsonObject
      ? base
      : {
          ...base,
          providerOptions: { anthropic: { structuredOutputMode: "outputFormat" } },
          output: Output.object({ schema: jsonSchema(schema.schema as Record<string, unknown>), name: schema.name })
        };
  }

  function assertSchemaAllowed(request: AiGenerateRequest): void {
    if (request.responseSchema && !structuredOutput) {
      throw new AiProviderError("AI_UNSUPPORTED_CAPABILITY", `配置 ${config.id} 未声明结构化输出能力。`);
    }
  }

  /**
   * 非流式：SDK generateText。有效内容超上限、截断（finishReason=length）与空文本
   * 都按畸形响应拒绝——与非流式旧实现"缺少完整文本结果"的语义一致。
   */
  async function generate(request: AiGenerateRequest): Promise<AiGenerateResponse> {
    assertSchemaAllowed(request);
    assertNotAborted(request.signal);
    const scope = abortScope(request.signal, request.timeoutMs);
    try {
      let model = modelFor(MAX_RESPONSE_BYTES);
      const options = callOptions(request, toPrompt(request.messages));
      /*
       * responses + json_object：SDK 有 Output.json（无 schema 的 JSON 输出，
       * wire 即 text.format json_object），但它的失败会包成 NoObjectGeneratedError
       * 且结果走 output 对象；这里与 completions 透传保持同一语义——wire 约束 +
       * 原始文本返回，调用方的解析与一次纠正不受影响。经中间件注入
       * responseFormat {type:"json"} 达到同一 wire 形态。
       */
      if (request.responseSchema && protocol === "openai-responses" && config.responseFormat === "json_object") {
        model = withResponseFormat(model, { type: "json" });
      }
      const result = await generateText({
        model,
        abortSignal: scope.signal,
        ...options
      });
      const output = (result as { output?: unknown }).output;
      const content = result.text || (output !== undefined ? JSON.stringify(output) : "");
      if (new TextEncoder().encode(content).byteLength > MAX_RESPONSE_BYTES) {
        throw new AiProviderError("AI_RESPONSE_TOO_LARGE", `响应超过 ${MAX_RESPONSE_BYTES} 字节。`);
      }
      if (content.trim().length === 0) {
        throw new AiProviderError("AI_MALFORMED_RESPONSE", "上游响应缺少完整文本结果。");
      }
      if (result.finishReason === "length") {
        throw new AiProviderError("AI_MALFORMED_RESPONSE", "上游响应在完整结束前被截断。");
      }
      return {
        content,
        model: result.response?.modelId ?? "",
        usage: {
          ...(result.usage.inputTokens !== undefined ? { inputTokens: result.usage.inputTokens } : {}),
          ...(result.usage.outputTokens !== undefined ? { outputTokens: result.usage.outputTokens } : {})
        },
        finishReason: result.finishReason
      };
    } catch (error) {
      throw mapError(error, config.apiKey, scope.classifyAbort);
    } finally {
      scope.done();
    }
  }

  /**
   * 增量流式：SDK streamText + fullStream 事件映射。
   *
   * 终止语义（与增量任务书 §2 一致）：**恰好一个终止事件**；上游提前断开
   * （无 finish 或 finishReason 未知）补 error + done，不伪成功。
   * 结构化输出契约：completions 经 providerOptions 透传 response_format；
   * responses/anthropic 用**中间件注入 responseFormat**（wire 上分别是
   * text.format json_schema/json_object 与原生 output_config）——SDK 的
   * streamText+Output 是对象装配流（中间态解析噪声、无纯文本增量），而调用方
   * （planStep 等）需要**原始文本增量** + 自行解析与一次纠正，因此流式不使用
   * SDK Output，约束只落在 wire 上（与非流式的语义一致）。
   */
  async function* generateStream(request: AiGenerateRequest): AsyncGenerator<WorkbenchStreamEvent> {
    assertSchemaAllowed(request);
    assertNotAborted(request.signal);
    const scope = abortScope(request.signal, request.timeoutMs);
    const jsonObject = config.responseFormat === "json_object";
    const prompt = toPrompt(request.messages);
    let streamModel = modelFor(MAX_STREAM_WIRE_BYTES);
    if (request.responseSchema && protocol !== "openai-completions") {
      if (jsonObject) {
        // json_object：Schema 以系统指令下发（运行时校验兜底）；responses 另声明 JSON 模式。
        prompt.system = [jsonInstruction(request.responseSchema.schema), ...prompt.system];
      }
      if (protocol === "openai-responses" || !jsonObject) {
        const schema = request.responseSchema;
        streamModel = withResponseFormat(streamModel, jsonObject
          ? { type: "json" }
          : { type: "json", schema: schema.schema as Record<string, unknown>, name: schema.name });
      }
    }
    const encoder = new TextEncoder();
    let contentBytes = 0;
    let reasoningBytes = 0;
    let releaseStream: (() => Promise<void>) | undefined;
    const stats = () => `正文 ${contentBytes} 字节，思考 ${reasoningBytes} 字节`;
    const fail = (error: unknown): AsyncGenerator<WorkbenchStreamEvent> => (async function* () {
      /*
       * 本地已判定失败（超限/畸形/上游错误）时先中止上游连接，再产出错误与
       * 唯一终止事件——持续开放的供应商流不会因为我们停止消费而继续传输。
       */
      scope.abort();
      const mapped = mapError(error, config.apiKey, scope.classifyAbort);
      yield {
        type: "error",
        code: mapped.code,
        message: mapped.message,
        retryable: mapped.code !== "AI_CANCELLED" && mapped.code !== "AI_TIMEOUT"
      };
      yield { type: "done", reason: mapped.code === "AI_CANCELLED" ? "cancelled" : mapped.code === "AI_TIMEOUT" ? "timeout" : "error" };
    })();
    try {
      const streamOptions = callOptions(
        protocol === "openai-completions" ? request : { ...request, responseSchema: undefined },
        prompt
      );
      if (request.responseSchema && protocol === "anthropic-messages" && !jsonObject) {
        // anthropic + json_schema 的流式同样显式声明原生结构化输出（与非流式同一模式）。
        streamOptions.providerOptions = {
          ...(streamOptions.providerOptions ?? {}),
          anthropic: { structuredOutputMode: "outputFormat" }
        } as SdkProviderOptions;
      }
      const stream = streamText({
        model: streamModel,
        abortSignal: scope.signal,
        // 显式文本输出：内核按纯文本流处理（不进对象装配）；wire 上的结构化约束
        // 由上方中间件覆写 responseFormat 表达，与非流式的约束语义一致。
        output: Output.text(),
        streamRetries: 0,
        ...streamOptions
      });
      let finishReason: string | undefined;
      let usage: { inputTokens?: number; outputTokens?: number } | undefined;
      const reader = stream.fullStream.getReader();
      releaseStream = async () => {
        // Abort owns upstream cancellation. Drain its terminal event before releasing the reader;
        // cancelling the SDK's chained transforms during a pending write leaks a Node 26 rejection.
        try { while (!(await reader.read()).done) { /* bounded by the aborted upstream */ } }
        catch { /* the primary failure/cancellation has already been delivered */ }
        finally { reader.releaseLock(); }
      };
      for (;;) {
        const { value: part, done } = await reader.read();
        if (done) break;
        if (part.type === "text-delta") {
          contentBytes += encoder.encode(part.text).byteLength;
          if (contentBytes > MAX_RESPONSE_BYTES) {
            return yield* fail(new AiProviderError("AI_RESPONSE_TOO_LARGE", `流式有效内容超过 ${MAX_RESPONSE_BYTES} 字节（${stats()}）。`));
          }
          yield { type: "text", delta: part.text };
        } else if (part.type === "reasoning-delta") {
          reasoningBytes += encoder.encode(part.text).byteLength;
          if (reasoningBytes > MAX_RESPONSE_BYTES) {
            return yield* fail(new AiProviderError("AI_RESPONSE_TOO_LARGE", `流式有效内容超过 ${MAX_RESPONSE_BYTES} 字节（${stats()}）。`));
          }
          yield { type: "reasoning", delta: part.text, source: "provider" };
        } else if (part.type === "finish-step") {
          // SDK 的供应商响应元信息，不能用本机配置 ID 或显示名替代。
          const model = part.response.modelId?.trim();
          if (model && model.length <= 512) yield { type: "model_meta", model };
        } else if (part.type === "finish") {
          finishReason = part.finishReason;
          const total = part.totalUsage;
          if (total && (total.inputTokens !== undefined || total.outputTokens !== undefined)) {
            usage = {
              ...(total.inputTokens !== undefined ? { inputTokens: total.inputTokens } : {}),
              ...(total.outputTokens !== undefined ? { outputTokens: total.outputTokens } : {})
            };
          }
        } else if (part.type === "abort") {
          const code = scope.classifyAbort();
          yield { type: "error", code, message: code === "AI_TIMEOUT" ? "请求超时。" : "请求已取消。", retryable: false };
          yield { type: "done", reason: code === "AI_TIMEOUT" ? "timeout" : "cancelled" };
          return;
        } else if (part.type === "error") {
          return yield* fail(part.error);
        }
      }
      if (!finishReason || finishReason === "unknown" || finishReason === "error") {
        return yield* fail(new AiProviderError("AI_MALFORMED_RESPONSE", "流式响应在正常结束事件之前断开，本次结果未完成。"));
      }
      if (usage) yield { type: "usage", ...usage };
      yield { type: "done", reason: finishReason === "length" ? "limit" : "stop" };
    } catch (error) {
      return yield* fail(error);
    } finally {
      scope.abort();
      await releaseStream?.();
      scope.done();
    }
  }

  return { id: `openai-compatible:${config.id}`, generate, generateStream };
}
