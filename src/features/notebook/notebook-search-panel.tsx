"use client";

/**
 * P5：跨笔记本搜索面板（纯展示，不含任何 AI 调用）。
 *
 * 边界：
 * - 展示命中理由（matchedBy）、来源、覆盖与截断；没有 metadata 的篇只说明
 *   “未参与主题判定”，不写成“不相关”；
 * - 主题只由用户点选**有效**标签（来自 fresh metadata），不提供模糊/语义输入；
 * - 单篇“生成主题标签”是显式动作，且只发生在该结果的某一篇上（无整库批量）；
 * - 结果点击经既有保存协调后打开来源篇。
 */
import { ChevronRight, Search, Sparkles, X } from "lucide-react";
import { useId } from "react";
import { findRegion, listCities, listProvinces } from "@/features/regions/region-catalog";
import type { NotebookSearchApi } from "./use-notebook-search";

const MATCH_LABEL: Record<string, string> = {
  keyword: "关键词",
  structured: "条件",
  metadata: "主题",
  semantic: "语义"
};
const SEARCH_GUIDANCE = "关键词与时间/地区/本过滤不需要 AI；主题过滤只使用有效标签。";

export type NotebookSearchPanelProps = {
  search: NotebookSearchApi;
  semantic?: import("react").ReactNode;
  /** P8：搜索区域内独立的「整理搜索结果」入口（只读分组）。 */
  agent?: import("react").ReactNode;
  /** 可见笔记本（用于筛选下拉）。 */
  notebooks: { id: string; title: string }[];
  /** P6：可筛选的旅行（仅仍有效的）与地点（仅未删除的）。 */
  tripOptions: { id: string; title: string }[];
  placeOptions: { id: string; name: string }[];
  /** 把 notebookId 显示为本名。 */
  notebookTitle: (notebookId: string) => string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onDismiss: () => void;
};

export function NotebookSearchPanel({
  search,
  semantic,
  agent,
  notebooks,
  notebookTitle,
  collapsed,
  onToggleCollapsed,
  onDismiss
}: NotebookSearchPanelProps) {
  const searchGuidanceId = useId();
  const provinces = listProvinces();
  const selectedRegion = search.filters.regionId ? findRegion(search.filters.regionId) : undefined;
  const provinceId =
    selectedRegion?.level === "province"
      ? selectedRegion.regionId
      : (selectedRegion?.parentRegionId ?? "");
  const cityValue = selectedRegion?.level === "city" ? selectedRegion.regionId : "";
  const cities = provinceId ? listCities(provinceId) : [];

  return (
    <section className="nb-search" data-status={search.status} aria-label="搜索笔记">
      <header className="nb-search-head">
        <button
          type="button"
          className="nb-search-toggle"
          aria-expanded={!collapsed}
          data-testid="search-toggle"
          onClick={onToggleCollapsed}
        >
          <Search size={15} aria-hidden />
          <span>搜索笔记</span>
          <span className="nb-search-headline">{headline(search)}</span>
          <ChevronRight
            size={15}
            aria-hidden
            className={collapsed ? "nb-search-chevron" : "nb-search-chevron is-open"}
          />
        </button>
        {collapsed ? null : (
          <button
            type="button"
            className="nb-icon-button"
            aria-label="关闭搜索面板"
            title="关闭"
            onClick={onDismiss}
          >
            <X size={15} />
          </button>
        )}
      </header>

      {collapsed ? null : (
        <div className="nb-search-body">
          <div className="nb-search-filters">
            <label className="nb-search-field">
              <span>关键词（标题或完整正文）</span>
              <input
                type="search"
                aria-label="搜索关键词"
                value={search.filters.query}
                placeholder="例如：赛里木湖"
                onChange={(event) => search.updateFilters({ query: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void search.run();
                }}
              />
            </label>
            <label className="nb-search-field">
              <span>笔记本</span>
              <select
                aria-label="搜索范围（笔记本）"
                value={search.filters.notebookId}
                onChange={(event) => search.updateFilters({ notebookId: event.target.value })}
              >
                <option value="">全部可见笔记本</option>
                {notebooks.map((notebook) => (
                  <option key={notebook.id} value={notebook.id}>
                    {notebook.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="nb-search-field">
              <span>地区（省）</span>
              <select
                aria-label="搜索地区（省）"
                value={provinceId}
                onChange={(event) => search.updateFilters({ regionId: event.target.value })}
              >
                <option value="">不限</option>
                {provinces.map((province) => (
                  <option key={province.regionId} value={province.regionId}>
                    {province.name}
                  </option>
                ))}
              </select>
            </label>
            {cities.length > 0 ? (
              <label className="nb-search-field">
                <span>城市</span>
                <select
                  aria-label="搜索地区（城市）"
                  value={cityValue}
                  onChange={(event) =>
                    search.updateFilters({ regionId: event.target.value || provinceId })
                  }
                >
                  <option value="">全省</option>
                  {cities.map((city) => (
                    <option key={city.regionId} value={city.regionId}>
                      {city.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="nb-search-field">
              <span>起始（含当天）</span>
              <input
                type="date"
                aria-label="搜索起始日期"
                value={search.filters.from}
                onChange={(event) => search.updateFilters({ from: event.target.value })}
              />
            </label>
            <label className="nb-search-field">
              <span>结束（不含当天）</span>
              <input
                type="date"
                aria-label="搜索结束日期"
                value={search.filters.to}
                onChange={(event) => search.updateFilters({ to: event.target.value })}
              />
            </label>
          </div>

          <div className="nb-search-topics" data-testid="search-topics">
            <span>有效主题（只来自与当前内容一致的标签）：</span>
            {!search.metadataAvailable ? (
              <span className="nb-search-note">主题库当前不可读，主题筛选不可用。</span>
            ) : search.availableTopics.length === 0 ? (
              <span className="nb-search-note">
                还没有任何有效主题标签；可在结果上对单篇显式生成。
              </span>
            ) : (
              search.availableTopics.map((entry) => (
                <button
                  key={entry.topic}
                  type="button"
                  className={
                    search.filters.topics.includes(entry.topic)
                      ? "nb-search-chip is-active"
                      : "nb-search-chip"
                  }
                  aria-pressed={search.filters.topics.includes(entry.topic)}
                  onClick={() => search.toggleTopic(entry.topic)}
                >
                  {entry.topic}（{entry.pages}）
                </button>
              ))
            )}
          </div>

          <div className="nb-search-actions">
            <button
              type="button"
              className="primary-button"
              title={`搜索笔记。${SEARCH_GUIDANCE}`}
              aria-describedby={searchGuidanceId}
              disabled={search.status === "searching"}
              onClick={() => void search.run()}
            >
              {search.status === "searching" ? "搜索中…" : "搜索"}
            </button>
            <button type="button" className="secondary-button" onClick={search.clearFilters}>
              清除条件
            </button>
            <span className="nb-search-note ui-secondary-copy" id={searchGuidanceId}>
              {SEARCH_GUIDANCE}
            </span>
          </div>

          {semantic}

          {search.message ? (
            <p className="nb-search-message" role="status" aria-live="polite">
              {search.message}
            </p>
          ) : null}
          {search.topicCapabilityNotice ? (
            <p className="nb-search-warn" role="status" data-testid="search-topic-notice">
              {search.topicCapabilityNotice}
            </p>
          ) : null}
          {search.metadataMessage ? (
            <p className="nb-search-note" role="status" data-testid="search-metadata-message">
              {search.metadataMessage}
            </p>
          ) : null}

          {search.report ? (
            <p className="nb-search-coverage" data-testid="search-coverage">
              共 {search.totalMatches} 条候选，显示 {search.results.length} 条
              {search.truncated ? "（已按上限截断，不是全部匹配）" : ""}；参与判定的范围{" "}
              {search.report.candidates} 篇：有效主题 {search.report.fresh}、过期{" "}
              {search.report.stale}、无标签 {search.report.unavailable}
              {search.report.withoutFreshMetadata > 0
                ? `（其中 ${search.report.withoutFreshMetadata} 篇没有有效主题标签，未参与主题判定，不代表与主题无关）`
                : ""}
              。
            </p>
          ) : null}

          {search.results.length > 0 ? (
            <ul className="nb-search-results" data-testid="search-results">
              {search.results.map((result) => (
                <li key={result.pageId} className="nb-search-result">
                  <button
                    type="button"
                    className="nb-search-open"
                    onClick={() => void search.openSource(result.pageId)}
                  >
                    <strong>{result.title || "(无标题)"}</strong>
                    <span className="nb-search-note">《{notebookTitle(result.notebookId)}》</span>
                  </button>
                  <span className="nb-search-snippet">{result.snippet}</span>
                  <span className="nb-search-matched">
                    命中理由：
                    {result.matchedBy.length > 0
                      ? result.matchedBy.map((kind) => MATCH_LABEL[kind] ?? kind).join(" + ")
                      : "（条件过滤）"}
                  </span>
                  <button
                    type="button"
                    className="secondary-button"
                    aria-label={`生成主题标签：${result.title || result.pageId}`}
                    disabled={search.metadataBusyPageId === result.pageId}
                    onClick={() => search.requestMetadata(result.pageId)}
                  >
                    <Sparkles size={14} aria-hidden />
                    {search.metadataBusyPageId === result.pageId ? "生成中…" : "生成主题标签"}
                  </button>
                </li>
              ))}
            </ul>
          ) : search.report ? (
            <p className="nb-search-note" data-testid="search-empty">
              {search.report.requestedTopics
                ? "没有命中。注意：没有有效主题标签的篇未参与主题判定，可改用关键词再试。"
                : "没有命中匹配的篇。"}
            </p>
          ) : null}

          {agent}
        </div>
      )}
    </section>
  );
}

function headline(search: NotebookSearchApi): string {
  if (search.status === "searching") return "搜索中…";
  if (!search.report) return "未搜索";
  return `${search.totalMatches} 条候选`;
}
