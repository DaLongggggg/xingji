/**
 * 列出某个端点可用模型的**受控**请求（与 DSH 的 `discoverModels` 同一取舍）：
 * - 只在用户点了「拉取可用模型」时发一次 `GET .../models`；结果只回给这一次请求，
 *   不缓存、不落库、不改任何配置（写不写进配置由用户在前端自己勾）；
 * - 凭据只进请求头：既不写进 URL，也不出现在错误文案或返回值里；
 * - 时间、字节、条数都有上限，拒绝跟随重定向；正文不是可解析的模型列表就明确失败；
 * - 按协议决定列模型的路径与头（Anthropic 与 OpenAI 兼容端点不同），不按域名猜。
 */
import { isLoopbackBaseUrl, type ChatApiProtocol } from "@/features/ai/model-settings-contract";
import { assertCleanBaseUrl } from "./model-settings-manager";
import { redactForLog } from "./openai-compatible-provider";

export const DISCOVERY_LIMITS = {
  /** 列模型是元数据请求，不该比一次生成还久。 */
  timeoutMs: 20_000,
  /** 正文上限：模型列表会很长，但不需要无限。 */
  maxBytes: 512 * 1024,
  /** 单次最多回传的模型条数（超出部分截断并如实标注）。 */
  maxModels: 2_000,
  /** 凭据输入上限：只接受可打印 ASCII，避免把 `KEY=value` 或引号整段粘进来。 */
  apiKeyMaxChars: 4_096
} as const;

/** 制图与对话共用同一套 `/models`，因此这里多一个制图取值。 */
export type DiscoveryProtocol = ChatApiProtocol | "openai-images";

export type DiscoveredModel = { modelId: string; label: string };

export type DiscoveryFailureCode =
  | "AI_DISCOVERY_INVALID"
  | "AI_DISCOVERY_UNSUPPORTED"
  | "AI_DISCOVERY_UNAUTHORIZED"
  | "AI_DISCOVERY_TIMEOUT"
  | "AI_DISCOVERY_FAILED";

export class ModelDiscoveryError extends Error {
  constructor(readonly code: DiscoveryFailureCode, detail: string) {
    super(`${code}:${detail}`);
    this.name = "ModelDiscoveryError";
  }
}

/** 稳定文案：端点、状态码与上游正文都不回给浏览器之外的日志。 */
export const DISCOVERY_ERROR_DETAIL: Record<DiscoveryFailureCode, string> = {
  AI_DISCOVERY_INVALID: "请求或端点不合法，无法拉取模型列表。",
  AI_DISCOVERY_UNSUPPORTED: "该协议不支持列出模型。",
  AI_DISCOVERY_UNAUTHORIZED: "端点拒绝了凭据：先填入该提供方的 API 密钥再拉取。",
  AI_DISCOVERY_TIMEOUT: "拉取模型列表超时。",
  AI_DISCOVERY_FAILED: "无法从该端点拉取模型列表。"
};

/**
 * 端点校验复用配置写入时的同一套规则（https、无内联凭据、无 query/hash、回环例外），
 * 失败时换成发现流程自己的稳定码。
 */
export function assertDiscoverableBaseUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ModelDiscoveryError("AI_DISCOVERY_INVALID", "缺少 API 地址。");
  }
  const value = raw.trim();
  try {
    return assertCleanBaseUrl(value, isLoopbackBaseUrl(value));
  } catch {
    throw new ModelDiscoveryError("AI_DISCOVERY_INVALID", "API 地址不符合受控端点规则。");
  }
}

/**
 * 合法密钥字符集：可打印 ASCII（不含空格）。
 * 这也是**传输不变量**——头里放不进别的字符，本地明确拒绝好过上游给一个看不懂的 401。
 * 与 DSH 的 `normalizeApiKey` 同一规则；另外两种形状只在这里判：
 * 粘贴成 `NAME=value` 环境变量行、以及整体被引号包住——两者都是"再粘一次"就能修好的输入问题。
 */
const LEGAL_API_KEY = /^[\x21-\x7e]+$/;
/** 名字必须全大写（`sk-` 在连字符处就断了），`=` 后不能紧跟另一个 `=`（base64 补齐不算赋值）。 */
const ENV_LINE = /^[A-Z][A-Z0-9_]*=[^=]/;

function isQuoted(value: string): boolean {
  const first = value[0];
  if (first !== '"' && first !== "'" && first !== "`") return false;
  return value.length > 1 && value.endsWith(first);
}

export function assertDiscoveryApiKey(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new ModelDiscoveryError("AI_DISCOVERY_INVALID", "API 密钥必须是字符串。");
  const value = raw.trim();
  if (value.length === 0) return undefined;
  if (value.length > DISCOVERY_LIMITS.apiKeyMaxChars) {
    throw new ModelDiscoveryError("AI_DISCOVERY_INVALID", "API 密钥过长。");
  }
  if (ENV_LINE.test(value) || isQuoted(value) || !LEGAL_API_KEY.test(value)) {
    throw new ModelDiscoveryError("AI_DISCOVERY_INVALID", "API 密钥含有不可打印字符。");
  }
  return value;
}

/**
 * 列模型的请求形状。
 * - `anthropic-messages`：`{root}/v1/models?limit=1000`，`x-api-key` + `anthropic-version`；
 * - 其余（含制图的 OpenAI images）：`{base}/models`，Bearer。
 * `baseUrl` 已带版本段时不再重复拼接（与对话请求同一规则）。
 *
 * 制图的 `imagesPath` 可能自带版本段（如千问的 `/compatible-mode/v1/images/generations`），
 * 这时模型列表就在**同一前缀**下：去掉结尾的 `/images/generations` 再拼 `/models`。
 * 不按域名猜，只看用户声明的路径。
 */
export function listingRequest(
  baseUrl: string,
  protocol: DiscoveryProtocol,
  apiKey: string,
  imagesPath?: string
): { url: string; headers: Record<string, string> } {
  const base = baseUrl.replace(/\/+$/, "");
  if (protocol === "anthropic-messages") {
    const root = base.endsWith("/v1") ? base.slice(0, -3) : base;
    return {
      url: `${root}/v1/models?limit=1000`,
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
    };
  }
  const prefix =
    protocol === "openai-images" && typeof imagesPath === "string"
      ? imagesPath.trim().replace(/\/images\/generations$/, "").replace(/\/+$/, "")
      : "";
  return {
    url: `${base}${prefix.startsWith("/") ? prefix : prefix ? `/${prefix}` : ""}/models`,
    headers: { authorization: `Bearer ${apiKey}` }
  };
}

type RawModel = { id?: unknown; name?: unknown; display_name?: unknown };

/**
 * 解析两种真实形态：OpenAI 兼容 `{data:[{id,name?}]}` 与 Anthropic `{data:[{id,display_name?}]}`。
 * 两者都以 `data[].id` 为准，因此共用一个解析器；结构不符明确失败，不做正则抢救。
 */
export function parseDiscoveredModels(payload: unknown): { models: DiscoveredModel[]; truncated: boolean } {
  const list = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) {
    throw new ModelDiscoveryError("AI_DISCOVERY_INVALID", "响应缺少 data 数组。");
  }
  const models: DiscoveredModel[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const entry of list) {
    const raw = entry as RawModel | null;
    if (!raw || typeof raw !== "object") continue;
    if (typeof raw.id !== "string" || raw.id.trim().length === 0) continue;
    const modelId = raw.id.trim();
    if (seen.has(modelId)) continue;
    if (models.length >= DISCOVERY_LIMITS.maxModels) {
      truncated = true;
      break;
    }
    seen.add(modelId);
    const label =
      typeof raw.display_name === "string" && raw.display_name.trim().length > 0
        ? raw.display_name.trim()
        : typeof raw.name === "string" && raw.name.trim().length > 0
          ? raw.name.trim()
          : modelId;
    models.push({ modelId, label });
  }
  if (models.length === 0) {
    throw new ModelDiscoveryError("AI_DISCOVERY_INVALID", "响应里没有可用的模型条目。");
  }
  return { models, truncated };
}

/** 带字节上限的正文读取：超限立即停止消费上游。 */
async function readCapped(response: Response): Promise<string | null> {
  const body = response.body;
  if (!body) {
    const text = await response.text();
    return new TextEncoder().encode(text).byteLength > DISCOVERY_LIMITS.maxBytes ? null : text;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value?.byteLength ?? 0;
      if (bytes > DISCOVERY_LIMITS.maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock?.();
  }
}

export type DiscoverInput = {
  baseUrl: string;
  protocol: DiscoveryProtocol;
  apiKey: string;
  /** 仅制图：该配置声明的生成路径，用来定位同一前缀下的 `/models`。 */
  imagesPath?: string;
  signal?: AbortSignal;
};

/**
 * 发一次受控的列模型请求。任何失败都以 `ModelDiscoveryError` 明确返回，
 * 不返回半份列表，也不把上游正文原文回给调用方。
 */
export async function discoverModels(
  input: DiscoverInput,
  deps: { fetchImpl?: typeof fetch } = {}
): Promise<{ models: DiscoveredModel[]; truncated: boolean }> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const baseUrl = assertDiscoverableBaseUrl(input.baseUrl);
  const wire = listingRequest(baseUrl, input.protocol, input.apiKey, input.imagesPath);

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), DISCOVERY_LIMITS.timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetchImpl(wire.url, {
        method: "GET",
        headers: { accept: "application/json", ...wire.headers },
        redirect: "manual",
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ModelDiscoveryError(
          input.signal?.aborted ? "AI_DISCOVERY_FAILED" : "AI_DISCOVERY_TIMEOUT",
          input.signal?.aborted ? "请求已取消。" : `超过 ${DISCOVERY_LIMITS.timeoutMs}ms。`
        );
      }
      throw new ModelDiscoveryError(
        "AI_DISCOVERY_FAILED",
        redactForLog(error instanceof Error ? error.message : String(error), input.apiKey)
      );
    }

    if (response.status >= 300 && response.status < 400) {
      throw new ModelDiscoveryError("AI_DISCOVERY_FAILED", "端点返回重定向，已拒绝跟随。");
    }
    if (response.status === 401 || response.status === 403) {
      throw new ModelDiscoveryError("AI_DISCOVERY_UNAUTHORIZED", `上游返回 ${response.status}。`);
    }
    if (response.status === 404 || response.status === 405) {
      // 端点可达，只是不提供 /models：不能据此判定连不通。
      throw new ModelDiscoveryError("AI_DISCOVERY_UNSUPPORTED", `上游返回 ${response.status}。`);
    }
    const raw = await readCapped(response);
    if (raw === null) {
      throw new ModelDiscoveryError("AI_DISCOVERY_FAILED", `响应超过 ${DISCOVERY_LIMITS.maxBytes} 字节。`);
    }
    if (!response.ok) {
      // 上游正文只用于服务端诊断，且先脱敏；返回给调用方的是固定文案。
      throw new ModelDiscoveryError(
        "AI_DISCOVERY_FAILED",
        redactForLog(raw.slice(0, 200) || `上游返回 ${response.status}。`, input.apiKey)
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new ModelDiscoveryError("AI_DISCOVERY_INVALID", "响应不是有效 JSON。");
    }
    return parseDiscoveredModels(payload);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}
