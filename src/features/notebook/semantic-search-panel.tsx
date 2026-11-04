"use client";
import { useEffect, useRef, useState } from "react";
import type { ArchiveCore } from "./notebook-repository";
import type { AiRepository } from "../ai/ai-repository";
import { createSearchIndexRepository } from "../ai/search-index-repository";
import { createEmbed, listEmbeddingConfig, type EmbeddingConfig } from "../ai/embedding-client";
import {
  buildSearchIndex,
  semanticSearch,
  type SearchInputs,
  type SemanticHit
} from "../ai/semantic-search";
import { createAiGatewayCaller, listAiConfigs, type AiPublicConfig } from "../ai/ai-gateway-client";
import { parseRagAnswer, ragInput, type RagClaim } from "../ai/rag-answer";
import { createSearchProvider, type AiPageQuery } from "../ai/search-provider";
import { isValidDateFilter, type NotebookSearchFilters } from "./use-notebook-search";

type Props = {
  archive: ArchiveCore;
  filters: NotebookSearchFilters;
  ai: AiRepository;
  loadArchive: () => Promise<ArchiveCore>;
  onFlush: () => Promise<boolean>;
  openSource: (id: string) => Promise<void>;
};
export function SemanticSearchPanel(props: Props) {
  const [index] = useState(() => createSearchIndexRepository());
  const [config, setConfig] = useState<EmbeddingConfig | null>(null);
  const [chats, setChats] = useState<AiPublicConfig[]>([]);
  const [chat, setChat] = useState("");
  const [agreed, setAgreed] = useState(false),
    [answerAgreed, setAnswerAgreed] = useState(false);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("正在读取检索模型配置…");
  const [result, setResult] = useState<{
    archive: ArchiveCore;
    filters: string;
    hits: SemanticHit[];
    epoch: number;
    claims?: RagClaim[];
  }>();
  const operation = useRef(0),
    controller = useRef<AbortController | null>(null),
    latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const filterKey = JSON.stringify(props.filters);
  const [renderedFilters, setRenderedFilters] = useState(filterKey);
  if (renderedFilters !== filterKey) {
    setRenderedFilters(filterKey);
    setBusy(false);
  }
  useEffect(() => {
    operation.current++;
    controller.current?.abort();
  }, [filterKey]);
  useEffect(() => {
    const abort = new AbortController();
    const op = operation;
    let alive = true;
    void Promise.all([listEmbeddingConfig(abort.signal), listAiConfigs()])
      .then(([c, models]) => {
        if (!alive) return;
        setConfig(c);
        setMessage(c ? "请先确认外发范围，再建立索引。" : "未配置检索模型，关键词检索仍可用。");
        if (models.status === "available") {
          setChats(models.configs);
          setChat(models.configs[0]?.id ?? "");
        }
      })
      .catch(() => {
        if (alive) setMessage("检索配置读取失败，关键词检索仍可用。");
      });
    return () => {
      alive = false;
      abort.abort();
      op.current++;
      controller.current?.abort();
    };
  }, [index]);
  const visible =
    result?.archive === props.archive && result.filters === filterKey ? result : undefined;
  function cancel() {
    operation.current++;
    controller.current?.abort();
    setBusy(false);
    setMessage("已取消；已成功建立的篇索引保留。");
  }
  async function run(kind: "build" | "semantic" | "hybrid" | "answer") {
    if (!config || !agreed) return;
    if (kind === "answer" && (!answerAgreed || !chat || !visible?.hits.length)) return;
    const id = ++operation.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const valid = () => id === operation.current && !abort.signal.aborted;
    setBusy(true);
    setMessage("");
    try {
      if (!(await latest.current.onFlush())) throw new Error("请先处理当前篇保存失败。");
      if (!valid()) return;
      const current = latest.current,
        f = current.filters;
      if (!isValidDateFilter(f.from) || !isValidDateFilter(f.to)) throw new Error("日期筛选无效。");
      const query: AiPageQuery = {
        query: f.query,
        limit: f.limit,
        ...(f.notebookId ? { notebookIds: [f.notebookId] } : {}),
        ...(f.regionId ? { regionIds: [f.regionId] } : {}),
        ...(f.tripId ? { tripIds: [f.tripId] } : {}),
        ...(f.placeId ? { placeIds: [f.placeId] } : {}),
        ...(f.from ? { from: f.from } : {}),
        ...(f.to ? { to: f.to } : {}),
        ...(f.topics.length ? { topics: f.topics } : {})
      };
      const metadata = await current.ai.listPageMetadata().catch(() => undefined);
      if (!valid()) return;
      const input: SearchInputs = {
        index,
        loadArchive: current.loadArchive,
        embed: createEmbed(config),
        space: config.space,
        signal: abort.signal,
        query,
        pageMetadata: metadata
      };
      if (kind === "build") {
        setResult(undefined);
        const n = await buildSearchIndex(input, (done, total) => {
          if (valid()) setMessage(`已建立 ${done}/${total} 篇索引。`);
        });
        if (valid()) setMessage(`索引建立完成：${n} 篇。范围只使用上方筛选条件，不按关键词缩小。`);
      } else if (kind === "answer") {
        const hits = visible!.hits.slice(0, 8);
        const recheck = async () => {
          const archive = await current.loadArchive();
          const eligible = await createSearchProvider({
            archive,
            pageMetadata: metadata
          }).eligiblePages(query);
          if (
            hits.some(
              (h) =>
                !eligible.some((r) => r.pageId === h.pageId && r.sourceDigest === h.sourceDigest)
            ) ||
            (await index.snapshot()).epoch !== visible!.epoch
          )
            throw new Error("引用来源或索引已改变，请重新检索。");
          return archive;
        };
        await recheck();
        if (!valid()) return;
        const reply = await createAiGatewayCaller()({
          configId: chat,
          task: "answer_search",
          input: ragInput(f.query, hits),
          signal: abort.signal
        });
        if (!reply.ok) throw new Error(reply.detail);
        const claims = parseRagAnswer(reply.content, hits.length);
        await recheck();
        if (valid()) {
          setResult({ ...visible!, claims });
          setMessage(claims.length ? "回答仅基于以下引用，请核对原文。" : "现有证据不足以回答。");
        }
      } else {
        setResult(undefined);
        const found = await semanticSearch(input, kind === "hybrid");
        if (!valid()) return;
        // Render only against the exact UI snapshot; later archive changes hide stale content immediately.
        setResult({
          archive: current.archive,
          filters: JSON.stringify(f),
          hits: found.hits,
          epoch: found.epoch
        });
        setMessage(
          `当前范围 ${found.eligible} 篇，有效索引 ${found.indexed} 篇；返回 ${found.hits.length}/${found.total} 条候选。未索引或过期不代表不相关。`
        );
      }
    } catch (e) {
      if (valid()) setMessage(e instanceof Error ? e.message : "检索失败。");
    } finally {
      if (valid()) setBusy(false);
    }
  }
  async function clear() {
    cancel();
    const id = ++operation.current;
    setBusy(true);
    setResult(undefined);
    try {
      await index.clear();
      if (id === operation.current) setMessage("已清除派生索引，笔记本和关键词检索不受影响。");
    } catch {
      if (id === operation.current) setMessage("清除索引失败，请重试。");
    } finally {
      if (id === operation.current) setBusy(false);
    }
  }
  async function openHit(hit: SemanticHit) {
    const id = operation.current;
    try {
      const archive = await latest.current.loadArchive();
      const rows = await createSearchProvider({ archive }).eligiblePages({});
      if (!rows.some((r) => r.pageId === hit.pageId && r.sourceDigest === hit.sourceDigest))
        throw new Error("引用已改变或不可用，请重新检索。");
      if (id === operation.current) await latest.current.openSource(hit.pageId);
    } catch (e) {
      if (id === operation.current) setMessage(e instanceof Error ? e.message : "来源不可用。");
    }
  }
  return (
    <section aria-label="语义检索" className="nb-semantic">
      <h3>按意思检索与引用回答</h3>
      <p>{config ? `检索模型：${config.label}` : "尚未配置检索模型"}</p>
      <label>
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => {
            setAgreed(e.target.checked);
            if (!e.target.checked) cancel();
          }}
        />
        允许将筛选范围内笔记本标题、完整文字块及检索问题发送给已配置的检索模型；不发送图片、图注。建立索引逐篇调用，可取消。
      </label>
      <div className="nb-search-actions">
        <button
          type="button"
          disabled={!config || !agreed || busy}
          onClick={() => void run("build")}
        >
          建立或重建索引
        </button>
        <button
          type="button"
          disabled={!config || !agreed || busy}
          onClick={() => void run("semantic")}
        >
          按意思检索
        </button>
        <button
          type="button"
          disabled={!config || !agreed || busy}
          onClick={() => void run("hybrid")}
        >
          混合检索
        </button>
        <button type="button" disabled={!busy} onClick={cancel}>
          取消检索操作
        </button>
        <button type="button" disabled={busy} onClick={() => void clear()}>
          清除派生索引
        </button>
      </div>
      <p role="status">{message}</p>
      {visible && (
        <>
          <ul>
            {visible.hits.map((h, i) => (
              <li key={h.pageId}>
                <button type="button" onClick={() => void openHit(h)}>
                  [{i + 1}] {h.title || "无标题"}
                </button>
                <p>{h.chunk.text}</p>
                <small>
                  {h.matchedBy.includes("keyword") ? "关键词 / " : ""}来源块：
                  {h.chunk.blockId ?? "标题"}，范围 {h.chunk.start}–{h.chunk.end}
                </small>
              </li>
            ))}
          </ul>
          <label className="nb-search-field">
            回答模型
            <select
              value={chat}
              onChange={(e) => {
                cancel();
                setChat(e.target.value);
              }}
            >
              {chats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={answerAgreed}
              onChange={(e) => {
                setAnswerAgreed(e.target.checked);
                if (!e.target.checked) cancel();
              }}
            />
            允许将问题及前8条引用的标题、文字片段、篇/块编号、范围和来源摘要发送给回答模型；回答只读。
          </label>
          <button
            type="button"
            disabled={busy || !chat || !agreed || !answerAgreed || !visible.hits.length}
            onClick={() => void run("answer")}
          >
            根据引用回答
          </button>
          {visible.claims?.map((c, i) => (
            <p key={i}>
              {c.text}{" "}
              {c.sources.map((n) => (
                <button type="button" key={n} onClick={() => void openHit(visible.hits[n - 1])}>
                  [{n}]
                </button>
              ))}
            </p>
          ))}
        </>
      )}
    </section>
  );
}
