import { createHash } from "node:crypto";
import { createModelConfigStore, isGatewayRouteEnabled } from "./model-config";
import { readLimitedJson } from "@/features/ai/embedding-client";
import { SEARCH_LIMITS, validateVectors } from "@/features/ai/search-chunks";

/** Explicit single embedding configuration. Existing chat configuration never opts in implicitly. */
export function embeddingConfig(env: NodeJS.ProcessEnv = process.env) {
  if (!isGatewayRouteEnabled() || !env.XINGJI_EMBEDDING_CONFIG) return null;
  const store = createModelConfigStore({ ...env, XINGJI_AI_CONFIGS: env.XINGJI_EMBEDDING_CONFIG });
  const configs = store.listPublic();
  if (configs.length !== 1) throw new Error("EMBEDDING_CONFIG_INVALID");
  const resolved = store.resolve(configs[0].id);
  const version = env.XINGJI_EMBEDDING_VERSION;
  if (!version) throw new Error("EMBEDDING_VERSION_REQUIRED");
  const space = createHash("sha256")
    .update(JSON.stringify([resolved.baseUrl, resolved.model, version]))
    .digest("hex");
  return { resolved, public: { id: resolved.id, label: resolved.model, space } };
}
export async function embeddingResponse(
  request: Request,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "cache-control": "no-store" } });
  let config;
  try {
    config = embeddingConfig();
  } catch {
    return json({ enabled: false, error: "检索模型配置无效。" }, 503);
  }
  if (request.method === "GET")
    return json(config ? { enabled: true, config: config.public } : { enabled: false });
  if (!config) return json({ error: "未配置检索模型；关键词检索仍可用。" }, 503);
  try {
    const body = (await readLimitedJson(new Response(request.body), 128 * 1024)) as {
      configId?: unknown;
      space?: unknown;
      texts?: unknown;
    };
    if (
      !body ||
      Object.keys(body).some((k) => !["configId", "space", "texts"].includes(k)) ||
      body.configId !== config.public.id ||
      body.space !== config.public.space ||
      !Array.isArray(body.texts) ||
      body.texts.length < 1 ||
      body.texts.length > SEARCH_LIMITS.chunksPerPage ||
      body.texts.some((t) => typeof t !== "string" || !t.length) ||
      body.texts.reduce((n, t) => n + t.length, 0) > SEARCH_LIMITS.inputChars
    )
      return json({ error: "向量请求无效或超过预算。" }, 400);
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 30000);
    try {
      if (request.signal.aborted) controller.abort();
      const url = config.resolved.baseUrl.replace(/\/$/, "") + "/embeddings";
      const response = await fetchImpl(url, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.resolved.apiKey}`
        },
        body: JSON.stringify({
          model: config.resolved.model,
          input: body.texts,
          encoding_format: "float"
        })
      });
      if (!response.ok) {
        await response.body?.cancel();
        return json({ error: "检索模型拒绝请求，请稍后重试。" }, 502);
      }
      const data = (await readLimitedJson(response)) as {
        data?: { index: number; embedding: unknown }[];
      };
      if (controller.signal.aborted) throw new Error("cancelled");
      if (!Array.isArray(data?.data) || data.data.length !== body.texts.length)
        throw new Error("invalid");
      const entries = data.data.slice().sort((a, b) => a.index - b.index);
      if (entries.some((e, i) => e.index !== i)) throw new Error("invalid");
      const vectors = validateVectors(
        entries.map((e) => e.embedding),
        body.texts.length
      );
      return json({ space: config.public.space, vectors });
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
    }
  } catch {
    return json({ error: "向量请求取消、超时或响应无效。" }, 502);
  }
}
