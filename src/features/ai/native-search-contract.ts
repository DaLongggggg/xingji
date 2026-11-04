import { z } from "zod";

export const NATIVE_SEARCH_MODES = ["off", "openai", "anthropic", "deepseek", "qwen", "doubao", "gemini", "glm", "kimi"] as const;
export type NativeSearchMode = typeof NATIVE_SEARCH_MODES[number];
export const isNativeSearchMode = (value: unknown): value is NativeSearchMode =>
  typeof value === "string" && (NATIVE_SEARCH_MODES as readonly string[]).includes(value);

/** mode 是服务端派生的只读能力；搜索接口与普通聊天协议相互独立。 */
export function nativeSearchAvailability(mode: unknown): { available: boolean; detail: string } {
  if (!isNativeSearchMode(mode) || mode === "off") return { available: false, detail: "当前模型的联网搜索暂不可用，可继续普通聊天。" };
  return { available: true, detail: "联网搜索由当前模型服务执行，实际结果会显示在消息中。" };
}

export const NATIVE_SEARCH_LIMITS = { queryChars: 128, sources: 5, urlChars: 1200, titleChars: 160,
  summaryChars: 1600, resultChars: 8000, groundingResultChars: 32_768, responseBytes: 512 * 1024, timeoutMs: 45_000, images: 5 } as const;
export const NATIVE_SEARCH_ARGS = z.strictObject({
  query: z.string().min(1).max(NATIVE_SEARCH_LIMITS.queryChars).refine(value => !!value.trim()),
  limit: z.int().min(1).max(NATIVE_SEARCH_LIMITS.sources).optional(),
  includeImages: z.boolean().optional()
});
export type NativeSearchArgs = z.infer<typeof NATIVE_SEARCH_ARGS>;
export function isSearchSourceUrl(value: string): boolean {
  if (value.length > NATIVE_SEARCH_LIMITS.urlChars || !/^https?:\/\//i.test(value) || /[\s\u0000-\u001f\u007f]/.test(value)) return false;
  try { const url = new URL(value); return !!url.host && !url.username && !url.password; } catch { return false; }
}
/** External previews accept public DNS names only; actual page reads also check and pin DNS server-side. */
export function isSearchImageUrl(value: string): boolean {
  if (!isSearchSourceUrl(value)) return false;
  try {
    const url = new URL(value), host = url.hostname.toLowerCase();
    return url.protocol === "https:" && !url.port && !url.hash && host.includes(".") && !host.endsWith(".")
      && !host.includes(":") && !/^[\d.]+$/.test(host)
      && !/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example|onion)$/.test(host);
  } catch { return false; }
}
const SEARCH_IMAGE = z.strictObject({
  url: z.string().refine(isSearchImageUrl), title: z.string().max(NATIVE_SEARCH_LIMITS.titleChars),
  sourceUrl: z.string().refine(isSearchSourceUrl), thumbnailUrl: z.string().refine(isSearchImageUrl).optional()
});
export const NATIVE_SEARCH_RESULT = z.strictObject({
  query: z.string().max(NATIVE_SEARCH_LIMITS.queryChars), summary: z.string().max(NATIVE_SEARCH_LIMITS.summaryChars),
  sources: z.array(z.strictObject({ title: z.string().max(NATIVE_SEARCH_LIMITS.titleChars), url: z.string().refine(isSearchSourceUrl) }))
    .max(NATIVE_SEARCH_LIMITS.sources), images: z.array(SEARCH_IMAGE).max(NATIVE_SEARCH_LIMITS.images).optional(),
  grounding: z.strictObject({ provider: z.literal("google"), html: z.string().min(1).max(16_384), text: z.string().max(12_000) }).optional(),
  truncated: z.literal(true).optional()
}).refine(value => JSON.stringify(value).length <= (value.grounding ? NATIVE_SEARCH_LIMITS.groundingResultChars : NATIVE_SEARCH_LIMITS.resultChars))
  .refine(value => !value.images?.some(image => !value.sources.some(source => source.url === image.sourceUrl)));
export type NativeSearchResult = z.infer<typeof NATIVE_SEARCH_RESULT>;
export const NATIVE_SEARCH_ERRORS = {
  unsupported: "当前模型的联网搜索暂不可用，可继续普通聊天或切换模型。",
  invalid_request: "搜索参数无效，请缩短公开搜索词后重试。",
  authentication: "搜索服务未接受当前模型凭据，请检查模型设置。",
  quota: "搜索服务余额不足或请求受限，请检查额度后重试。",
  unavailable: "当前端点或模型未能执行内置搜索，请检查供应商的搜索支持与开通状态。",
  no_sources: "搜索未返回可核验的网页来源，本轮不能据此确认实时信息。",
  timeout: "联网搜索超时，请稍后重试。", cancelled: "联网搜索已取消。",
  network: "联网搜索连接失败，请检查网络后重试。"
} as const;
export type NativeSearchErrorCode = keyof typeof NATIVE_SEARCH_ERRORS;

/** Agent 预算优先移除完整图片，再移除完整来源，不切断 URL。 */
export function clipNativeSearchContent(content: string, maxChars: number): string {
  // Attribution is a display artifact, never prompt material.
  try { const value = JSON.parse(content); if (value.grounding) { delete value.grounding; content = JSON.stringify(value); } } catch { /* ordinary tool data */ }
  if (content.length <= maxChars) return content;
  try {
    const parsed = NATIVE_SEARCH_RESULT.safeParse(JSON.parse(content));
    if (parsed.success) {
      const result = { ...parsed.data, sources: [...parsed.data.sources],
        ...(parsed.data.images ? { images: [...parsed.data.images] } : {}), truncated: true as const };
      while (result.images?.length && JSON.stringify(result).length > maxChars) result.images.pop();
      if (!result.images?.length) delete result.images;
      while (result.sources.length && JSON.stringify(result).length > maxChars) result.sources.pop();
      if (JSON.stringify(result).length <= maxChars) return JSON.stringify(result);
    }
  } catch { /* 来源无法完整保留时整体省略。 */ }
  return "搜索来源已因上下文预算省略。".slice(0, Math.max(0, maxChars));
}
