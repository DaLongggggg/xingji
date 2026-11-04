import { SEARCH_LIMITS, validateVectors } from "./search-chunks";
import { apiFetch } from "@/lib/api-client";
export type EmbeddingConfig = { id: string; label: string; space: string };
export type Embed = (
  texts: string[],
  signal: AbortSignal
) => Promise<{ space: string; vectors: number[][] }>;
export async function readLimitedJson(
  response: Response,
  limit = SEARCH_LIMITS.responseBytes
): Promise<unknown> {
  if (!response.body) throw new Error("响应为空。");
  const reader = response.body.getReader();
  let bytes = 0;
  let text = "";
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > limit) {
        await reader.cancel();
        throw new Error("响应超出大小上限。");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    reader.releaseLock();
  }
}
export async function listEmbeddingConfig(signal?: AbortSignal): Promise<EmbeddingConfig | null> {
  // T2a：私有 API 默认经受控认证入口（P7 暂停时同样只发同源请求）。
  const response = await apiFetch("/api/ai/embeddings", { cache: "no-store", signal });
  const data = (await readLimitedJson(response, 4096)) as {
    enabled?: boolean;
    config?: EmbeddingConfig;
  };
  if (!response.ok || !data.enabled) return null;
  const c = data.config;
  if (!c || ![c.id, c.label, c.space].every((v) => typeof v === "string" && v.length > 0))
    throw new Error("检索模型配置无效。");
  return c;
}
export function createEmbed(config: EmbeddingConfig): Embed {
  return async (texts, signal) => {
    const response = await apiFetch("/api/ai/embeddings", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ configId: config.id, space: config.space, texts })
    });
    const data = (await readLimitedJson(response)) as {
      space?: string;
      vectors?: unknown;
      error?: string;
    };
    if (!response.ok) throw new Error(data.error || "向量生成失败。");
    if (data.space !== config.space) throw new Error("检索模型已改变，请重新读取配置。");
    return { space: config.space, vectors: validateVectors(data.vectors, texts.length) };
  };
}
