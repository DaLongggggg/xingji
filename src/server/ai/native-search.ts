import {
  NATIVE_SEARCH_ARGS, NATIVE_SEARCH_ERRORS, NATIVE_SEARCH_LIMITS, NATIVE_SEARCH_RESULT,
  isSearchSourceUrl, isSearchImageUrl,
  type NativeSearchArgs, type NativeSearchErrorCode, type NativeSearchMode, type NativeSearchResult
} from "@/features/ai/native-search-contract";
import type { ResolvedModelConfig } from "./model-config";
import { resolveNativeSearchMode } from "./native-search-capability";
import { isDecorativeSearchImage, previewSourceImages, SOURCE_PREVIEW_LIMITS } from "./source-preview";

export class NativeSearchError extends Error {
  constructor(readonly code: NativeSearchErrorCode) {
    super(NATIVE_SEARCH_ERRORS[code]);
    this.name = "NativeSearchError";
  }
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** Capability lookup already approved this official origin; search uses its documented independent wire. */
function endpoint(config: ResolvedModelConfig, mode: NativeSearchMode): URL {
  const url = new URL(config.baseUrl);
  if (mode === "gemini") { url.pathname = "/v1beta/interactions"; return url; }
  if (mode === "glm") { url.pathname = "/api/paas/v4/web_search"; return url; }
  if (mode === "kimi") { url.pathname = "/v1/tools/search_pro"; return url; }
  url.pathname = mode === "deepseek" ? "/v1/tools/search" : mode === "anthropic" ? "/v1/messages"
    : mode === "qwen" ? "/compatible-mode/v1/responses" : mode === "doubao" ? "/api/v3/responses" : "/v1/responses";
  return url;
}

function requestBody(config: ResolvedModelConfig, mode: NativeSearchMode, args: NativeSearchArgs): JsonObject {
  if (mode === "gemini") return { model: config.model, input: args.query, tools: [{ type: "google_search" }], store: false };
  if (mode === "glm") return { search_query: args.query, search_engine: "search_std", search_intent: false, count: args.limit ?? NATIVE_SEARCH_LIMITS.sources };
  if (mode === "kimi") return { text_query: args.query, limit: args.limit ?? NATIVE_SEARCH_LIMITS.sources, timeout_seconds: 30 };
  if (mode === "deepseek") return { query: args.query, count: args.limit ?? NATIVE_SEARCH_LIMITS.sources, need_content: false };
  if (mode === "anthropic") return {
    model: config.model, max_tokens: 1024,
    messages: [{ role: "user", content: args.query }],
    // Forced tool_choice is rejected by some current Claude models; no sources still fails below.
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }]
  };
  const body: JsonObject = {
    model: config.model, input: args.query, max_output_tokens: 1024,
    tools: [{ type: "web_search", ...(mode === "doubao" ? { sources: ["doubao"] } : {}) }]
  };
  if (mode === "openai") Object.assign(body, {
    tool_choice: { type: "web_search" }, include: ["web_search_call.action.sources"], store: false, max_tool_calls: 1
  });
  if (mode === "doubao") body.max_tool_calls = 1;
  return body;
}

function httpError(status: number): NativeSearchError {
  return new NativeSearchError(status === 401 || status === 403 ? "authentication"
    : status === 402 || status === 429 ? "quota" : status === 408 || status === 504 ? "timeout" : "unavailable");
}

function providerError(value: unknown): NativeSearchError {
  const error = object(value);
  const code = typeof value === "string" ? value : error?.code ?? error?.error_code ?? error?.type;
  const normalized = typeof code === "string" ? code.toLowerCase() : "";
  return new NativeSearchError(/rate_limit|too_many_requests|quota|balance/.test(normalized) ? "quota"
    : /authentication|invalid_api_key|permission_error/.test(normalized) ? "authentication"
      : /timeout|timed_out/.test(normalized) ? "timeout"
        : /invalid_tool_input|query_too_long/.test(normalized) ? "invalid_request" : "unavailable");
}

/** A successful HTTP envelope can still contain a failed server-side search. */
function assertNoProviderError(value: unknown): void {
  if (Array.isArray(value)) { for (const item of value) assertNoProviderError(item); return; }
  const item = object(value);
  if (!item) return;
  if (item.error !== undefined && item.error !== null && item.error !== false) throw providerError(item.error);
  if (item.status === "failed" || item.status === "incomplete" || item.type === "error"
    || (typeof item.type === "string" && item.type.endsWith("_error"))) throw providerError(item);
  for (const child of Object.values(item)) if (child !== null && typeof child === "object") assertNoProviderError(child);
}

async function readJson(response: Response, aborted: Promise<never>, rpcId?: number): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (contentLength > NATIVE_SEARCH_LIMITS.responseBytes) {
    void response.body?.cancel().catch(() => {});
    throw new NativeSearchError("unavailable");
  }
  if (!response.body) throw new NativeSearchError("unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let bytes = 0;
  let complete = false;
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), aborted]);
      if (done) { complete = true; break; }
      bytes += value.byteLength;
      if (bytes > NATIVE_SEARCH_LIMITS.responseBytes) throw new NativeSearchError("unavailable");
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    const text = chunks.join("");
    if (rpcId !== undefined && response.headers.get("content-type")?.includes("text/event-stream")) {
      for (const event of text.replace(/\r\n/g, "\n").split("\n\n")) {
        const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const value: unknown = JSON.parse(data);
        if (object(value)?.id === rpcId) return value;
      }
      throw new NativeSearchError("unavailable");
    }
    return JSON.parse(text);
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Coding Plan search is a separate official service, using the same configured key.
 * Only a definitive 1113 rejection of the ordinary search API enters this path; never retry an unknown outcome. */
async function glmCodingSearch(
  config: ResolvedModelConfig, args: NativeSearchArgs, signal: AbortSignal,
  aborted: Promise<never>, fetchImpl: typeof fetch
): Promise<unknown> {
  const headers: Record<string, string> = {
    "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${config.apiKey}`
  };
  const post = async (body: unknown) => {
    const response = await Promise.race([fetchImpl("https://open.bigmodel.cn/api/mcp/web_search_prime/mcp", {
      method: "POST", headers, body: JSON.stringify(body), redirect: "manual", cache: "no-store", signal
    }), aborted]);
    if (!response.ok || response.redirected || response.type === "opaqueredirect") {
      void response.body?.cancel().catch(() => {});
      throw httpError(response.status);
    }
    return response;
  };
  const rpc = async (body: { id: number; method: string; params: unknown }) => {
    const response = await post({ jsonrpc: "2.0", ...body });
    const value = object(await readJson(response, aborted, body.id));
    if (value?.jsonrpc !== "2.0" || value.id !== body.id || value.error || !object(value.result))
      throw new NativeSearchError("unavailable");
    return { response, result: object(value.result)! };
  };
  const initialized = await rpc({ id: 1, method: "initialize", params: {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "xingji-search", version: "1.0" }
  } });
  const session = initialized.response.headers.get("mcp-session-id");
  if (session) headers["mcp-session-id"] = session;
  const version = initialized.result.protocolVersion;
  if (typeof version !== "string") throw new NativeSearchError("unavailable");
  headers["mcp-protocol-version"] = version;
  const notice = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  void notice.body?.cancel().catch(() => {});
  const called = await rpc({ id: 2, method: "tools/call", params: {
    name: "web_search_prime", arguments: { search_query: args.query, content_size: "medium" }
  } });
  if (called.result.isError === true) throw new NativeSearchError("unavailable");
  const entries: unknown[] = [];
  for (const block of list(called.result.content)) {
    const item = object(block);
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    // The current service wraps its result array in a JSON string inside the text block.
    let value: unknown = item.text;
    for (let depth = 0; depth < 2 && typeof value === "string"; depth++) value = JSON.parse(value);
    if (!Array.isArray(value)) throw new NativeSearchError("unavailable");
    entries.push(...value);
  }
  return { search_result: entries };
}

function normalize(value: unknown, mode: NativeSearchMode, args: NativeSearchArgs): NativeSearchResult {
  const root = object(value);
  if (!root) throw new NativeSearchError("unavailable");
  assertNoProviderError(root);
  const sources: NativeSearchResult["sources"] = [];
  const images: NonNullable<NativeSearchResult["images"]> = [];
  const summaries: string[] = [];
  const seen = new Set<string>();
  const decorative = new Set<string>();
  let truncated = false;
  let grounding: NativeSearchResult["grounding"];
  const addSource = (candidate: unknown) => {
    const source = object(candidate);
    if (!source || typeof source.url !== "string" || !isSearchSourceUrl(source.url)) { truncated = true; return; }
    for (const icon of [source.site_icon, source.logo_url, source.icon_url, source.icon]) if (typeof icon === "string") decorative.add(icon);
    if (seen.has(source.url)) return;
    seen.add(source.url);
    if (sources.length >= (args.limit ?? NATIVE_SEARCH_LIMITS.sources)) { truncated = true; return; }
    const title = typeof source.title === "string" ? source.title.trim() : new URL(source.url).hostname;
    if (title.length > NATIVE_SEARCH_LIMITS.titleChars) truncated = true;
    sources.push({ title: title.slice(0, NATIVE_SEARCH_LIMITS.titleChars), url: source.url });
  };
  const addText = (text: unknown) => { if (typeof text === "string" && text.trim()) summaries.push(text.trim()); };
  const addImage = (url: unknown, title: unknown, sourceUrl: unknown, thumbnailUrl?: unknown, explicitContent = false) => {
    if (args.includeImages !== true || typeof url !== "string" || !isSearchImageUrl(url) || typeof sourceUrl !== "string"
      || decorative.has(url) || (!explicitContent && isDecorativeSearchImage(url))) return;
    if (images.some(image => image.url === url && image.sourceUrl === sourceUrl)) return;
    const label = typeof title === "string" && title.trim() ? title.trim() : sources.find(source => source.url === sourceUrl)?.title ?? "搜索图片";
    images.push({ url, sourceUrl, title: label.slice(0, NATIVE_SEARCH_LIMITS.titleChars),
      ...(typeof thumbnailUrl === "string" && isSearchImageUrl(thumbnailUrl) && !decorative.has(thumbnailUrl)
        && !isDecorativeSearchImage(thumbnailUrl) ? { thumbnailUrl } : {}) });
  };
  if (mode === "gemini") {
    const html: string[] = [], text: string[] = [];
    for (const value of list(root.steps)) {
      const step = object(value);
      if (step?.type === "google_search_result") for (const value of list(step.result)) {
        const widget = object(value)?.search_suggestions;
        if (typeof widget === "string" && widget.trim()) html.push(widget);
      }
      if (step?.type === "model_output") for (const value of list(step.content)) {
        const block = object(value);
        if (block?.type !== "text") continue;
        if (typeof block.text === "string") { text.push(block.text); addText(block.text); }
        for (const value of list(block.annotations)) if (object(value)?.type === "url_citation") addSource(value);
      }
    }
    // Never silently discard or truncate required attribution.
    if (!html.length || html.join("").length > 16_384 || text.join("\n").length > 12_000) throw new NativeSearchError("unavailable");
    grounding = { provider: "google", html: html.join(""), text: text.join("\n") };
  } else if (mode === "glm" || mode === "kimi") {
    for (const value of list(mode === "glm" ? root.search_result : root.search_results)) {
      const item = object(value);
      if (!item) continue;
      addSource({ ...item, url: mode === "glm" ? item.link : item.url });
      addText(item.content ?? item.snippet);
    }
  } else if (mode === "deepseek") {
    // Official /v1/tools/search returns root.results, not a data envelope.
    for (const result of list(root.results)) {
      addSource(result);
      const entry = object(result);
      addText(entry?.summary || entry?.snippet);
    }
  } else if (mode === "anthropic") {
    for (const content of list(root.content)) {
      const block = object(content);
      if (block?.type === "web_search_tool_result") for (const source of list(block.content)) {
        if (object(source)?.type === "web_search_result") addSource(source);
      }
      if (block?.type === "text") {
        addText(block.text);
        for (const citation of list(block.citations)) if (object(citation)?.type === "web_search_result_location") addSource(citation);
      }
    }
  } else {
    for (const output of list(root.output)) {
      const item = object(output);
      if (item?.type === "web_search_call") {
        for (const source of list(object(item.action)?.sources)) addSource(source);
        if (mode === "openai") for (const result of list(item.results)) {
          const image = object(result);
          // The provider explicitly returned content imagery; filenames/titles alone cannot override that type.
          if (image?.type === "image_result") addImage(image.image_url, image.caption, image.source_website_url, image.thumbnail_url, true);
        }
      }
      if (item?.type === "message") for (const content of list(item.content)) {
        const block = object(content);
        if (block?.type !== "output_text") continue;
        addText(block.text);
        for (const citation of list(block.annotations)) {
          const source = object(citation);
          if (source?.type !== "url_citation") continue;
          addSource(source);
          if (mode === "doubao") addImage(object(source.cover_image)?.url, source.title, source.url);
        }
      }
    }
  }
  if (!sources.length) throw new NativeSearchError("no_sources");
  const text = summaries.join("\n\n");
  if (text.length > NATIVE_SEARCH_LIMITS.summaryChars) truncated = true;
  const result: NativeSearchResult = {
    ...(grounding ? { grounding } : {}),
    query: args.query, summary: text.slice(0, NATIVE_SEARCH_LIMITS.summaryChars), sources,
    ...(images.length ? { images: images.filter(image => !decorative.has(image.url) && sources.some(source => source.url === image.sourceUrl))
      .map(image => {
        if (image.thumbnailUrl && decorative.has(image.thumbnailUrl)) delete image.thumbnailUrl;
        return image;
      }).slice(0, NATIVE_SEARCH_LIMITS.images) } : {}),
    ...(truncated ? { truncated: true } : {})
  };
  return fitResult(result);
}

function fitResult(result: NativeSearchResult): NativeSearchResult {
  const budget = result.grounding ? NATIVE_SEARCH_LIMITS.groundingResultChars : NATIVE_SEARCH_LIMITS.resultChars;
  while (JSON.stringify(result).length > budget && result.summary) {
    result.truncated = true;
    const excess = JSON.stringify(result).length - budget;
    result.summary = result.summary.slice(0, Math.max(0, result.summary.length - excess));
  }
  while (result.images?.length && JSON.stringify(result).length > budget) {
    result.images.pop(); result.truncated = true;
  }
  if (!result.images?.length) delete result.images;
  if (JSON.stringify(result).length > budget) {
    result.summary = "";
    result.truncated = true;
    while (result.sources.length && JSON.stringify(result).length > budget) result.sources.pop();
  }
  if (!result.sources.length) throw new NativeSearchError("no_sources");
  const checked = NATIVE_SEARCH_RESULT.safeParse(result);
  if (!checked.success) throw new NativeSearchError("unavailable");
  return checked.data;
}

/** This task sends only the explicit public query, never the surrounding chat or archive. */
export async function runNativeSearch(
  config: ResolvedModelConfig, args: NativeSearchArgs, signal?: AbortSignal, fetchImpl: typeof fetch = globalThis.fetch,
  // A custom provider transport must explicitly opt into secondary page reads; it never bypasses a transport stub.
  preview: typeof previewSourceImages | false = fetchImpl === globalThis.fetch ? previewSourceImages : false
): Promise<NativeSearchResult> {
  const mode = resolveNativeSearchMode(config);
  if (mode === "off") throw new NativeSearchError("unsupported");
  const checked = NATIVE_SEARCH_ARGS.safeParse(args);
  if (!checked.success) throw new NativeSearchError("invalid_request");
  if (signal?.aborted) throw new NativeSearchError("cancelled");
  const url = endpoint(config, mode);
  const controller = new AbortController();
  // Optional metadata must not consume the last budget and discard already successful webpage results.
  const previewDeadline = Date.now() + NATIVE_SEARCH_LIMITS.timeoutMs - SOURCE_PREVIEW_LIMITS.totalMs - 100;
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new NativeSearchError(timedOut ? "timeout" : "cancelled"));
  });
  controller.signal.addEventListener("abort", rejectAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, NATIVE_SEARCH_LIMITS.timeoutMs);
  try {
    const headers = { "content-type": "application/json", ...(mode === "anthropic"
      ? { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" }
      : mode === "gemini" ? { "x-goog-api-key": config.apiKey } : { authorization: `Bearer ${config.apiKey}` }) };
    const response = await Promise.race([fetchImpl(url.toString(), {
      method: "POST", headers, body: JSON.stringify(requestBody(config, mode, checked.data)),
      redirect: "manual", cache: "no-store", signal: controller.signal
    }), aborted]);
    let value: unknown;
    if (mode === "glm" && response.status === 429 && !response.redirected) {
      const rejected = object(await readJson(response, aborted));
      if (String(object(rejected?.error)?.code) !== "1113") throw httpError(response.status);
      value = await glmCodingSearch(config, checked.data, controller.signal, aborted, fetchImpl);
    } else {
      if (response.redirected || response.type === "opaqueredirect" || !response.ok) {
        void response.body?.cancel().catch(() => {});
        throw httpError(response.status);
      }
      value = await readJson(response, aborted);
    }
    if (controller.signal.aborted) throw new NativeSearchError(timedOut ? "timeout" : "cancelled");
    const result = normalize(value, mode, checked.data);
    if (mode !== "gemini" && checked.data.includeImages === true && !result.images?.length && preview && Date.now() < previewDeadline) {
      try {
        const images = await Promise.race([preview(result.sources, controller.signal), aborted]);
        if (images.length) result.images = images;
      } catch {
        // Metadata is optional. The parent timeout/cancellation still wins below.
      }
    }
    if (controller.signal.aborted) throw new NativeSearchError(timedOut ? "timeout" : "cancelled");
    return fitResult(result);
  } catch (error) {
    if (controller.signal.aborted) throw new NativeSearchError(timedOut ? "timeout" : "cancelled");
    if (error instanceof NativeSearchError) throw error;
    // Do not attach the upstream exception: it may contain credentials, URLs or response bodies.
    throw new NativeSearchError(error instanceof SyntaxError ? "unavailable" : "network");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
    controller.signal.removeEventListener("abort", rejectAbort);
  }
}
