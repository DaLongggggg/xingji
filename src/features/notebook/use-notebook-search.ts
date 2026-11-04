"use client";

/**
 * P5：跨笔记本检索的**唯一协调入口**。
 *
 * 边界（Ponytail）：
 * - 不建搜索服务、索引库、缓存层或队列：一次 `searchWithReport` + 一次 metadata 读取；
 * - 关键词/结构/时间检索**不依赖 AI 库**；只有主题过滤需要 metadata，读取失败时
 *   明确说明“主题能力受限”，而不是把“没有主题数据”显示成“不相关”；
 * - 元数据只由用户在结果上**显式触发**生成（单篇），没有后台整库调用；
 * - 结果点击复用既有保存协调与打开篇路径；
 * - 异步回调按「目标页身份 + 会话序号 + 操作次序号」判定有效性。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createAiContextProvider } from "@/features/ai/ai-context";
import {
  createAiGatewayCaller,
  listAiConfigs,
  type AiGatewayCaller,
  type AiPublicConfig
} from "@/features/ai/ai-gateway-client";
import {
  AiQueryMetadataUnavailableError,
  AiQueryTopicsError,
  SEARCH_DEFAULT_LIMIT,
  createSearchProvider,
  listAvailableTopics,
  type AvailableTopic,
  type SearchMetadataCoverage,
  type SearchResult
} from "@/features/ai/search-provider";
import type { AiPageMetadata, AiRepository } from "@/features/ai/ai-repository";
import {
  PAGE_METADATA_BUDGETS,
  runGeneratePageMetadataTask
} from "@/features/ai/ai-metadata-runner";
import type { AiTask } from "@/features/ai/ai-task";
import { PAGE_METADATA_PROMPT } from "@/features/ai/prompts/page-metadata";
import type { NotebookMedia } from "@/features/notebook/notebook-model";
import type { ArchiveCore } from "@/features/notebook/notebook-repository";
import { isSessionIdentityCurrent } from "./use-page-organize";

export type NotebookSearchStatus = "idle" | "searching" | "failed";

export type NotebookSearchFilters = {
  query: string;
  /** 空串 = 全部可见本。 */
  notebookId: string;
  /** 空串 = 不限地区；否则是省或市 regionId（含城市隐含父省语义）。 */
  regionId: string;
  /** P6：按旅行筛选；空串 = 不限。只看仍有效的关系（目标已删除/永久删除不参与）。 */
  tripId: string;
  /** P6：按地点筛选；空串 = 不限。 */
  placeId: string;
  /** 当地日历日期 `YYYY-MM-DD`；空串 = 不限。from 含、to 不含（沿用查询契约）。 */
  from: string;
  to: string;
  /** 已规范化的主题；空数组 = 不按主题过滤。 */
  topics: string[];
  limit: number;
};

export const DEFAULT_NOTEBOOK_SEARCH_FILTERS: NotebookSearchFilters = {
  query: "",
  notebookId: "",
  regionId: "",
  tripId: "",
  placeId: "",
  from: "",
  to: "",
  topics: [],
  limit: SEARCH_DEFAULT_LIMIT
};

export type NotebookSearchApi = {
  status: NotebookSearchStatus;
  message?: string;
  /** 主题能力说明（不可用/受限时非空），与普通错误分开。 */
  topicCapabilityNotice?: string;
  results: SearchResult[];
  report?: SearchMetadataCoverage;
  /** 过滤后、limit 之前的候选总数；与 results.length 一起如实展示截断。 */
  totalMatches: number;
  truncated: boolean;
  limit: number;
  availableTopics: AvailableTopic[];
  /** AI metadata 是否可读；false 时主题过滤不可用，关键词检索仍可用。 */
  metadataAvailable: boolean;
  filters: NotebookSearchFilters;
  updateFilters: (patch: Partial<NotebookSearchFilters>) => void;
  toggleTopic: (topic: string) => void;
  clearFilters: () => void;
  run: () => Promise<void>;
  configs: AiPublicConfig[];
  selectedConfigId: string;
  selectConfig: (configId: string) => void;
  /** 显式单篇元数据生成（主题标签）。未同意时先请求同意。 */
  metadataAgreed: boolean;
  pendingMetadataPageId?: string;
  requestMetadata: (pageId: string) => void;
  cancelMetadataRequest: () => void;
  confirmMetadata: () => Promise<void>;
  metadataMessage?: string;
  metadataBusyPageId?: string;
  /** 打开来源篇：先经既有保存协调，失败留在原会话并提示。 */
  openSource: (pageId: string) => Promise<void>;
};

const CONFIG_MISSING_MESSAGE = "尚未配置可用模型，请前往设置添加。";

export type NotebookSearchOptions = {
  ai: AiRepository;
  archive: ArchiveCore;
  media: (Omit<NotebookMedia, "blob"> & { blob?: Blob })[];
  loadArchive: () => Promise<ArchiveCore>;
  enabled: boolean;
  onFlush: () => Promise<boolean>;
  onOpenPage?: (pageId: string) => Promise<boolean> | boolean;
  onNotice?: (message: string) => void;
  callGateway?: AiGatewayCaller;
  listConfigs?: typeof listAiConfigs;
  now?: () => Date;
  createId?: () => string;
};

/** `YYYY-MM-DD` 的合法日历日期；空串表示不限。 */
export function isValidDateFilter(value: string): boolean {
  if (value === "") return true;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(Number(match[1]), month, 0)).getUTCDate();
}

export function useNotebookSearch(options: NotebookSearchOptions): NotebookSearchApi {
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const currentNow = () => optionsRef.current.now ?? (() => new Date());
  const callGateway = useMemo(
    () => options.callGateway ?? createAiGatewayCaller(),
    [options.callGateway]
  );
  const listConfigs = options.listConfigs ?? listAiConfigs;

  const [status, setStatus] = useState<NotebookSearchStatus>("idle");
  const [message, setMessage] = useState<string>();
  const [topicCapabilityNotice, setTopicCapabilityNotice] = useState<string>();
  const [results, setResults] = useState<SearchResult[]>([]);
  const [report, setReport] = useState<SearchMetadataCoverage>();
  const [totalMatches, setTotalMatches] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [limit, setLimit] = useState(SEARCH_DEFAULT_LIMIT);
  const [availableTopics, setAvailableTopics] = useState<AvailableTopic[]>([]);
  const [metadataAvailable, setMetadataAvailable] = useState(true);
  const [filters, setFilters] = useState<NotebookSearchFilters>(DEFAULT_NOTEBOOK_SEARCH_FILTERS);
  const [configs, setConfigs] = useState<AiPublicConfig[]>([]);
  const [selectedConfigId, setSelectedConfigId] = useState("");
  const [metadataAgreed, setMetadataAgreed] = useState(false);
  const [pendingMetadataPageId, setPendingMetadataPageId] = useState<string>();
  const [metadataMessage, setMetadataMessage] = useState<string>();
  const [metadataBusyPageId, setMetadataBusyPageId] = useState<string>();

  const filtersRef = useRef(filters);
  useEffect(() => {
    filtersRef.current = filters;
  });
  /*
   * R4：检索与单篇元数据生成是**两类互不相关**的操作，各自独立身份。
   *
   * 共用一个序号会让“生成期间点检索”把生成回调作废（生成完成时提前 return，
   * busy 永远不清）。因此：
   * - `searchOpRef`：只作废上一次检索；
   * - `metadataOpRef`：只作废上一次元数据生成（另一个目标篇/重复点击）；
   * - `sessionIdRef`：卸载或会话变化时同时作废两者。
   */
  const searchOpRef = useRef(0);
  const metadataOpRef = useRef(0);
  const sessionIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * 回调有效性：本 hook 实例的会话号 + 操作次序号。
   *
   * 页身份由**动作自己的闭包 pageId** 冻结，并在执行前用权威档案复核它仍存在；
   * 因此不存在“读着读着目标页悄悄换了”的漂移：要么还是那一篇，要么明确失败。
   * 切换筛选条件不会作废正在进行的单篇生成（它与筛选无关）。
   */
  const isCurrentFor = useCallback((currentOpId: number, opId: number, sessionId: number) =>
    isSessionIdentityCurrent({
      opId,
      currentOpId,
      sessionPageId: "",
      currentPageId: "",
      sessionId,
      currentSessionId: sessionIdRef.current
    }), []);
  /** 元数据生成的身份判定（只受同类操作与卸载影响）。 */
  const isMetadataCurrent = useCallback(
    (opId: number, sessionId: number) => isCurrentFor(metadataOpRef.current, opId, sessionId),
    [isCurrentFor]
  );
  /** 检索的身份判定（只受同类操作与卸载影响）。 */
  const isSearchCurrent = useCallback(
    (opId: number) => isCurrentFor(searchOpRef.current, opId, sessionIdRef.current),
    [isCurrentFor]
  );

  /**
   * 读取 metadata 快照；失败返回 undefined（关键词检索仍然可用）。
   * 不做重试、不建缓存层：每次检索前读一次，保证刚生成的主题立即可用。
   */
  const readMetadata = useCallback(async (): Promise<AiPageMetadata[] | undefined> => {
    try {
      return await optionsRef.current.ai.listPageMetadata();
    } catch {
      return undefined;
    }
  }, []);

  const loadConfigs = useCallback(async () => {
    /*
     * 迟到的配置加载不得在**卸载/会话已换**之后写状态或覆盖更新的消息。
     * 用会话号快照判定，而不是“已卸载”一次性标志：React StrictMode 会
     * mount → cleanup → mount，一次性标志会让重挂载后的加载永远提前返回。
     */
    const session = sessionIdRef.current;
    const result = await listConfigs();
    if (sessionIdRef.current !== session) return result;
    if (result.status === "available") {
      setConfigs(result.configs);
      setSelectedConfigId((currentId) =>
        currentId || (result.configs.length === 1 ? result.configs[0].id : "")
      );
      return result;
    }
    setConfigs([]);
    setMetadataMessage(
      result.status === "disabled" ? CONFIG_MISSING_MESSAGE : `读取模型配置失败：${result.detail}`
    );
    return result;
  }, [listConfigs]);

  // 打开（启用）时只读取公开配置与 metadata：不发模型请求。
  useEffect(() => {
    if (!options.enabled) return;
    let cancelled = false;
    void (async () => {
      await loadConfigs();
      if (cancelled) return;
      const metadata = await readMetadata();
      if (cancelled) return;
      setMetadataAvailable(metadata !== undefined);
      setAvailableTopics(
        listAvailableTopics(optionsRef.current.archive, metadata ? { pageMetadata: metadata } : {})
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [options.enabled, loadConfigs, readMetadata]);

  // 卸载：作废在途回调（检索与生成都作废）并中止请求（不改写任何持久化记录）。
  useEffect(
    () => () => {
      searchOpRef.current += 1;
      metadataOpRef.current += 1;
      sessionIdRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    },
    []
  );

  const updateFilters = useCallback((patch: Partial<NotebookSearchFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
  }, []);

  const toggleTopic = useCallback((topic: string) => {
    setFilters((current) => ({
      ...current,
      topics: current.topics.includes(topic)
        ? current.topics.filter((item) => item !== topic)
        : [...current.topics, topic]
    }));
  }, []);

  const clearFilters = useCallback(() => {
    // 只作废在途**检索**：清筛选不应影响与筛选无关的单篇生成。
    searchOpRef.current += 1;
    setFilters({ ...DEFAULT_NOTEBOOK_SEARCH_FILTERS });
    setResults([]);
    setReport(undefined);
    setTotalMatches(0);
    setTruncated(false);
    setMessage(undefined);
    setTopicCapabilityNotice(undefined);
    setStatus("idle");
  }, []);

  /** 执行一次检索：关键词/结构/时间不依赖 AI 库；主题过滤需要有效 metadata。 */
  const run = useCallback(async () => {
    const opId = (searchOpRef.current += 1);
    const current = optionsRef.current;
    const active = filtersRef.current;
    setStatus("searching");
    setMessage(undefined);
    setTopicCapabilityNotice(undefined);

    if (!isValidDateFilter(active.from) || !isValidDateFilter(active.to)) {
      if (!isSearchCurrent(opId)) return;
      setStatus("failed");
      setMessage("时间筛选需要 YYYY-MM-DD 格式（或留空表示不限）。");
      return;
    }

    const metadata = await readMetadata();
    if (!isSearchCurrent(opId)) return;
    const topicsRequested = active.topics.length > 0;
    setMetadataAvailable(metadata !== undefined);
    setAvailableTopics(
      listAvailableTopics(current.archive, metadata ? { pageMetadata: metadata } : {})
    );

    const provider = createSearchProvider({
      archive: current.archive,
      ...(metadata !== undefined ? { pageMetadata: metadata } : {})
    });
    const baseQuery = {
      query: active.query,
      ...(active.notebookId ? { notebookIds: [active.notebookId] } : {}),
      ...(active.regionId ? { regionIds: [active.regionId] } : {}),
      ...(active.tripId ? { tripIds: [active.tripId] } : {}),
      ...(active.placeId ? { placeIds: [active.placeId] } : {}),
      ...(active.from ? { from: active.from } : {}),
      ...(active.to ? { to: active.to } : {}),
      limit: active.limit
    };

    let response;
    try {
      response = await provider.searchWithReport(
        topicsRequested ? { ...baseQuery, topics: active.topics } : baseQuery
      );
    } catch (error) {
      if (!isSearchCurrent(opId)) return;
      if (error instanceof AiQueryMetadataUnavailableError) {
        // AI 库不可读：主题过滤未生效，但关键词/结构检索照常工作（明确告知，不静默）。
        try {
          response = await provider.searchWithReport(baseQuery);
        } catch (fallbackError) {
          if (!isSearchCurrent(opId)) return;
          setStatus("failed");
          setMessage(`检索失败：${describe(fallbackError)}`);
          return;
        }
        if (!isSearchCurrent(opId)) return;
        setTopicCapabilityNotice(
          "主题筛选未生效：AI 主题库当前不可读（可能已删除）。已按关键词/时间/地区检索；" +
            "主题能力恢复前不会把“没有主题数据”当作“与主题不相关”。"
        );
      } else if (error instanceof AiQueryTopicsError) {
        setStatus("failed");
        setMessage("主题筛选为空：请选择至少一个有效主题（空字符串不算主题）。");
        return;
      } else {
        setStatus("failed");
        setMessage(`检索失败：${describe(error)}`);
        return;
      }
    }
    if (!isSearchCurrent(opId)) return;

    setResults(response.results);
    setReport(response.metadata);
    setTotalMatches(response.totalMatches);
    setTruncated(response.truncated);
    setLimit(response.limit);
    setStatus("idle");
  }, [isSearchCurrent, readMetadata]);

  /** 生成单篇主题标签前的一次“读取权威档案 + 冻结来源”步骤。 */
  const generateMetadata = useCallback(
    async (pageId: string): Promise<void> => {
      const opId = (metadataOpRef.current += 1);
      const sessionId = sessionIdRef.current;
      const current = optionsRef.current;
      const configId = selectedConfigId;
      if (!configId) {
        setMetadataMessage(CONFIG_MISSING_MESSAGE);
        return;
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setMetadataBusyPageId(pageId);
      setMetadataMessage("正在生成主题标签…");

      let flushed: boolean;
      try {
        flushed = await current.onFlush();
      } catch {
        flushed = false;
      }
      if (!isMetadataCurrent(opId, sessionId)) return;
      if (!flushed) {
        setMetadataBusyPageId(undefined);
        setMetadataMessage("保存未完成，已停止生成主题标签；草稿保留。");
        return;
      }

      let archive: ArchiveCore;
      try {
        archive = await current.loadArchive();
      } catch (error) {
        if (!isMetadataCurrent(opId, sessionId)) return;
        setMetadataBusyPageId(undefined);
        setMetadataMessage(`读取已保存笔记本失败：${describe(error)}`);
        return;
      }
      if (!isMetadataCurrent(opId, sessionId)) return;
      const page = archive.pages.find((item) => item.id === pageId);
      if (!page || (typeof page.deletedAt === "string" && page.deletedAt.length > 0)) {
        setMetadataBusyPageId(undefined);
        setMetadataMessage("目标篇已不可用（可能已删除）。");
        return;
      }
      const contextOptions = { archive, media: current.media };
      const context = await createAiContextProvider(contextOptions).getPage(pageId);
      if (!isMetadataCurrent(opId, sessionId)) return;
      if (!context) {
        setMetadataBusyPageId(undefined);
        setMetadataMessage("目标篇当前不可读。");
        return;
      }

      const timestamp = currentNow()().toISOString();
      const task: AiTask = {
        id: (current.createId ?? defaultMetadataTaskId)(),
        type: "generate_page_metadata",
        status: "queued",
        input: {
          pageId,
          sourceDigest: context.sourceDigest,
          maxOutputChars: PAGE_METADATA_BUDGETS.maxOutputChars,
          mode: "page_metadata"
        },
        promptId: PAGE_METADATA_PROMPT.id,
        promptVersion: PAGE_METADATA_PROMPT.version,
        revision: 0,
        createdAt: timestamp,
        updatedAt: timestamp
      };

      const outcome = await runGeneratePageMetadataTask(
        {
          context: contextOptions,
          ai: current.ai,
          callGateway,
          selectConfig: () => configId,
          now: currentNow(),
          signal: controller.signal,
          /*
           * R6：把**权威仓库回读**交给 runner。写入前它会用最新档案重建 Context 再核对
           * 可见性与摘要，因此“请求期间源被删除/改写”不会写入旧 metadata。
           */
          loadArchive: () => optionsRef.current.loadArchive()
        },
        task
      );
      if (!isMetadataCurrent(opId, sessionId)) return;
      setMetadataBusyPageId(undefined);
      if (outcome.status === "completed") {
        const topics = outcome.metadata.topics ?? [];
        setMetadataMessage(
          topics.length > 0
            ? `已生成 ${topics.length} 个主题标签：${topics.join("、")}`
            : "已生成摘要，但这一篇没有可用的主题标签（模型未给出主题）。"
        );
        // 用最新 metadata 刷新可点选主题，并按当前筛选重跑一次（让新主题立即可用）。
        await run();
        return;
      }
      if (outcome.status === "cancelled") {
        setMetadataMessage("已取消生成主题标签。");
        return;
      }
      if (outcome.status === "failed") {
        setMetadataMessage(`生成主题标签失败（${outcome.code}）：${outcome.detail}`);
        return;
      }
      setMetadataMessage("任务状态未变化，未生成主题标签。");
    },
    [callGateway, isMetadataCurrent, run, selectedConfigId]
  );

  const requestMetadata = useCallback(
    (pageId: string) => {
      if (metadataAgreed) {
        void generateMetadata(pageId);
        return;
      }
      setPendingMetadataPageId(pageId);
    },
    [generateMetadata, metadataAgreed]
  );

  const cancelMetadataRequest = useCallback(() => setPendingMetadataPageId(undefined), []);

  const confirmMetadata = useCallback(async () => {
    const pageId = pendingMetadataPageId;
    setMetadataAgreed(true);
    setPendingMetadataPageId(undefined);
    if (pageId) await generateMetadata(pageId);
  }, [generateMetadata, pendingMetadataPageId]);

  /** 打开来源篇：先走既有保存协调；保存失败留在原会话并明确提示。 */
  const openSource = useCallback(async (pageId: string) => {
    const current = optionsRef.current;
    let flushed: boolean;
    try {
      flushed = await current.onFlush();
    } catch {
      flushed = false;
    }
    if (!flushed) {
      setMessage("保存未完成，未跳转来源；草稿保留。");
      return;
    }
    if (!current.onOpenPage) return;
    const opened = await current.onOpenPage(pageId);
    if (opened === false) setMessage("目标篇当前不可打开（可能已删除）。");
  }, []);

  return {
    status,
    message,
    topicCapabilityNotice,
    results,
    report,
    totalMatches,
    truncated,
    limit,
    availableTopics,
    metadataAvailable,
    filters,
    updateFilters,
    toggleTopic,
    clearFilters,
    run,
    configs,
    selectedConfigId,
    selectConfig: setSelectedConfigId,
    metadataAgreed,
    pendingMetadataPageId,
    requestMetadata,
    cancelMetadataRequest,
    confirmMetadata,
    metadataMessage,
    metadataBusyPageId,
    openSource
  };
}

let metadataTaskSequence = 0;
function defaultMetadataTaskId(): string {
  metadataTaskSequence += 1;
  return `meta-task-${Date.now().toString(36)}-${metadataTaskSequence.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
