import type { NotebookPage } from "../notebook/notebook-model";

// 用户决定暂缓 P7：保留实现，产品入口与 HTTP 接口统一停用。
export function isSemanticSearchEnabled(): boolean {
  return false;
}

export const SEARCH_LIMITS = {
  pages: 100,
  chunksPerPage: 64,
  chunkChars: 1200,
  inputChars: 24000,
  queryChars: 1000,
  dimensions: 4096,
  indexBytes: 8 * 1024 * 1024,
  responseBytes: 2 * 1024 * 1024
} as const;
export const CHUNK_VERSION = 1;
export type SearchChunk = { blockId: string | null; start: number; end: number; text: string };
/** UTF-16 offsets into original text; never split a surrogate pair or lose trailing text. */
export function chunkPage(page: NotebookPage): SearchChunk[] {
  const chunks: SearchChunk[] = [];
  for (const source of [
    { blockId: null, text: page.title },
    ...page.blocks.flatMap((b) => (b.type === "text" ? [{ blockId: b.id, text: b.text }] : []))
  ]) {
    let start = 0;
    while (start < source.text.length) {
      let end = Math.min(start + SEARCH_LIMITS.chunkChars, source.text.length);
      if (end < source.text.length) {
        const paragraph = source.text.lastIndexOf("\n", end - 1);
        if (paragraph > start + SEARCH_LIMITS.chunkChars / 2) end = paragraph + 1;
        else if (/[\uD800-\uDBFF]/.test(source.text[end - 1])) end--;
      }
      chunks.push({ blockId: source.blockId, start, end, text: source.text.slice(start, end) });
      start = end;
    }
  }
  if (
    chunks.length > SEARCH_LIMITS.chunksPerPage ||
    chunks.reduce((n, c) => n + c.text.length, 0) > SEARCH_LIMITS.inputChars
  )
    throw new Error("这一篇超出索引预算，请缩小内容后重试。");
  return chunks;
}
export function validateVectors(value: unknown, count: number, dimension?: number): number[][] {
  if (!Array.isArray(value) || value.length !== count || count === 0)
    throw new Error("向量响应数量不匹配。");
  let size = dimension;
  for (const vector of value) {
    if (
      !Array.isArray(vector) ||
      !vector.length ||
      vector.length > SEARCH_LIMITS.dimensions ||
      vector.some((n) => typeof n !== "number" || !Number.isFinite(n)) ||
      !Number.isFinite(Math.hypot(...vector)) ||
      Math.hypot(...vector) === 0
    )
      throw new Error("向量响应无效。");
    size ??= vector.length;
    if (vector.length !== size) throw new Error("向量维度不匹配。");
  }
  return value;
}
export function cosine(a: number[], b: number[]): number {
  validateVectors([a, b], 2, a.length);
  const an = Math.hypot(...a),
    bn = Math.hypot(...b);
  return a.reduce((sum, n, i) => sum + (n / an) * (b[i] / bn), 0);
}
