import type { ArchiveCore } from "../notebook/notebook-repository";
import {
  createSearchProvider,
  type AiPageQuery,
  type SearchProviderOptions,
  type SearchResult
} from "./search-provider";
import { CHUNK_VERSION, chunkPage, cosine, SEARCH_LIMITS, validateVectors } from "./search-chunks";
import type { Embed } from "./embedding-client";
import type { SearchIndexRepository } from "./search-index-repository";
export type SemanticHit = SearchResult & {
  chunk: ReturnType<typeof chunkPage>[number];
  score: number;
};
export type SearchInputs = {
  loadArchive: () => Promise<ArchiveCore>;
  index: SearchIndexRepository;
  embed: Embed;
  space: string;
  signal: AbortSignal;
  query: AiPageQuery;
  scope?: SearchProviderOptions["scope"];
  pageMetadata?: SearchProviderOptions["pageMetadata"];
};
function cancelled(signal: AbortSignal) {
  if (signal.aborted) throw new Error("操作已取消。");
}
async function candidates(input: SearchInputs) {
  cancelled(input.signal);
  const archive = await input.loadArchive();
  const results = await createSearchProvider({
    archive,
    scope: input.scope,
    pageMetadata: input.pageMetadata
  }).eligiblePages(input.query);
  cancelled(input.signal);
  if (results.length > SEARCH_LIMITS.pages)
    throw new Error("当前范围超过100篇，请用条件缩小范围。");
  return { archive, results };
}
export async function buildSearchIndex(
  input: SearchInputs,
  progress: (done: number, total: number) => void
) {
  const { archive, results } = await candidates(input),
    snapshot = await input.index.snapshot();
  let completed = 0;
  for (const result of results) {
    cancelled(input.signal);
    const page = archive.pages.find((p) => p.id === result.pageId)!;
    const chunks = chunkPage(page);
    if (chunks.length) {
      const response = await input.embed(
        chunks.map((c) => c.text),
        input.signal
      );
      cancelled(input.signal);
      if (response.space !== input.space) throw new Error("检索模型空间不匹配。");
      validateVectors(response.vectors, chunks.length);
      const latest = (await candidates(input)).results.find((r) => r.pageId === result.pageId);
      if (!latest || latest.sourceDigest !== result.sourceDigest)
        throw new Error("来源已改变，未保存这篇索引。");
      await input.index.put(
        {
          pageId: result.pageId,
          sourceDigest: result.sourceDigest,
          space: input.space,
          chunkVersion: CHUNK_VERSION,
          chunks,
          vectors: response.vectors
        },
        snapshot.epoch,
        input.signal
      );
    }
    progress(++completed, results.length);
  }
  return completed;
}
export async function semanticSearch(
  input: SearchInputs,
  hybrid: boolean
): Promise<{
  hits: SemanticHit[];
  eligible: number;
  indexed: number;
  total: number;
  epoch: number;
}> {
  const text = (input.query.query ?? "").trim();
  if (!text || text.length > SEARCH_LIMITS.queryChars)
    throw new Error("请输入1～1000字的检索问题。");
  const initial = await candidates(input),
    snapshot = await input.index.snapshot();
  const fresh = snapshot.pages.filter(
    (row) =>
      row.space === input.space &&
      initial.results.some((r) => r.pageId === row.pageId && r.sourceDigest === row.sourceDigest) &&
      JSON.stringify(row.chunks) ===
        JSON.stringify(chunkPage(initial.archive.pages.find((p) => p.id === row.pageId)!))
  );
  if (!fresh.length && !hybrid)
    return {
      hits: [],
      eligible: initial.results.length,
      indexed: 0,
      total: 0,
      epoch: snapshot.epoch
    };
  const response = fresh.length ? await input.embed([text], input.signal) : undefined;
  if (response) {
    if (response.space !== input.space) throw new Error("检索模型空间不匹配。");
    validateVectors(response.vectors, 1);
  }
  const latest = await candidates(input);
  const after = await input.index.snapshot();
  cancelled(input.signal);
  if (after.epoch !== snapshot.epoch) throw new Error("索引已清除，请重新检索。");
  const scored: SemanticHit[] = [];
  let indexed = 0;
  for (const row of fresh) {
    const result = latest.results.find(
      (r) => r.pageId === row.pageId && r.sourceDigest === row.sourceDigest
    );
    if (!result) continue;
    indexed++;
    const ranked = row.chunks
      .map((chunk, i) => ({ chunk, score: cosine(response!.vectors[0], row.vectors[i]) }))
      .sort((a, b) => b.score - a.score);
    scored.push({
      ...result,
      ...ranked[0],
      blockIds: ranked[0].chunk.blockId ? [ranked[0].chunk.blockId] : [],
      matchedBy: [...result.matchedBy, "semantic"]
    });
  }
  scored.sort((a, b) => b.score - a.score || a.pageId.localeCompare(b.pageId));
  if (hybrid) {
    const keyword = latest.results.filter((r) => {
      const p = latest.archive.pages.find((p) => p.id === r.pageId)!;
      return [p.title, ...p.blocks.flatMap((b) => (b.type === "text" ? [b.text] : []))].some((t) =>
        t.toLowerCase().includes(text.toLowerCase())
      );
    });
    const scores = new Map(scored.map((r, i) => [r.pageId, 1 / (60 + i + 1)]));
    keyword.forEach((r, i) => {
      scores.set(r.pageId, (scores.get(r.pageId) ?? 0) + 1 / (60 + i + 1));
      const hit = scored.find((h) => h.pageId === r.pageId);
      if (hit) hit.matchedBy.push("keyword");
      else {
        const p = latest.archive.pages.find((p) => p.id === r.pageId)!;
        const chunks = chunkPage(p);
        const chunk =
          chunks.find((c) => c.text.toLowerCase().includes(text.toLowerCase())) ?? chunks[0];
        if (chunk) scored.push({ ...r, chunk, score: 0, matchedBy: [...r.matchedBy, "keyword"] });
      }
    });
    scored.sort(
      (a, b) =>
        (scores.get(b.pageId) ?? 0) - (scores.get(a.pageId) ?? 0) ||
        a.pageId.localeCompare(b.pageId)
    );
  }
  return {
    hits: scored.slice(0, Math.max(1, Math.min(input.query.limit ?? 20, 100))),
    eligible: latest.results.length,
    indexed,
    total: scored.length,
    epoch: snapshot.epoch
  };
}
