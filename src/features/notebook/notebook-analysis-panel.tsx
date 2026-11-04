"use client";

/**
 * P4：编辑区上方的**本册只读分析面板**（纯展示，不含任何 AI 调用）。
 *
 * 边界：
 * - 只读：没有“接受/应用/合并/删除”动作，结果不会被写回正文；
 * - 全部内容按纯文本渲染（文本节点），不注入模型返回的 HTML；
 * - 每条结论都带来源篇按钮：点击经既有保存协调后跳转（由 hook 负责）；
 * - 未知日期显示“日期未知”，缺口一律标注为“建议”，不伪装事实。
 */
import { ChevronRight, Sparkles, X } from "lucide-react";
import type { NotebookAnalysisResult } from "@/features/ai/ai-notebook-result-schema";
import type { AnalyzeNotebookCoverage } from "@/features/ai/ai-notebook-runner";
import type {
  NotebookAnalysisRecovered,
  NotebookAnalysisStatus,
  NotebookAnalysisViewState
} from "./use-notebook-analysis";

export type NotebookAnalysisPanelProps = {
  /** 当前本标题；空串时不显示面板。 */
  notebookTitle: string;
  status: NotebookAnalysisStatus;
  message?: string;
  result?: NotebookAnalysisResult;
  viewState?: NotebookAnalysisViewState;
  coverage?: AnalyzeNotebookCoverage;
  recovered: NotebookAnalysisRecovered[];
  runInfo?: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onGenerate: () => void;
  onCancel: () => void;
  onReloadConfig: () => void;
  onDismiss: () => void;
  onResume: (proposalId: string) => void;
  onOpenSource: (pageId: string) => void;
  /** 把 pageId 显示为当前标题（找不到时原样显示 id）。 */
  pageTitle: (pageId: string) => string;
};

const STATUS_LABEL: Record<NotebookAnalysisViewState["status"], string> = {
  fresh: "与当前内容一致",
  stale: "已过期",
  unavailable: "来源不可用"
};

export function NotebookAnalysisPanel({
  notebookTitle,
  status,
  message,
  result,
  viewState,
  coverage,
  recovered,
  runInfo,
  collapsed,
  onToggleCollapsed,
  onGenerate,
  onCancel,
  onReloadConfig,
  onDismiss,
  onResume,
  onOpenSource,
  pageTitle
}: NotebookAnalysisPanelProps) {
  if (!notebookTitle) return null;
  const generating = status === "generating";
  const sources = (pageIds: string[]) => (
    <span className="nb-analysis-sources">
      {pageIds.map((pageId) => (
        <button
          key={pageId}
          type="button"
          className="nb-analysis-source"
          onClick={() => onOpenSource(pageId)}
        >
          {pageTitle(pageId)}
        </button>
      ))}
    </span>
  );

  return (
    <section className="nb-analysis" data-status={status} aria-label="本册智能整理（只读）">
      <header className="nb-analysis-head">
        <button
          type="button"
          className="nb-analysis-toggle"
          aria-expanded={!collapsed}
          data-testid="analysis-toggle"
          onClick={onToggleCollapsed}
        >
          <Sparkles size={15} aria-hidden />
          <span>总结整本</span>
          <span className="nb-analysis-headline">
            《{notebookTitle}》 · {headline(status, viewState, result)}
          </span>
          <ChevronRight
            size={15}
            aria-hidden
            className={collapsed ? "nb-analysis-chevron" : "nb-analysis-chevron is-open"}
          />
        </button>
        <button
          type="button"
          className="nb-icon-button"
          aria-label="关闭总结整本弹窗"
          title="关闭"
          onClick={onDismiss}
        >
          <X size={15} />
        </button>
      </header>

      {collapsed ? null : (
        <div className="nb-analysis-body">
          {message ? (
            <p className="nb-analysis-message" role="status" aria-live="polite">
              {message}
            </p>
          ) : null}
          {runInfo ? (
            <p className="nb-analysis-note" role="note" data-testid="analysis-run-info">
              {runInfo}
            </p>
          ) : null}

          {recovered.length > 0 && status !== "ready" ? (
            <div className="nb-analysis-recover">
              <span>发现 {recovered.length} 条之前的分析（不会自动请求）。</span>
              {recovered.map((entry) => (
                <button
                  key={entry.proposal.id}
                  type="button"
                  onClick={() => onResume(entry.proposal.id)}
                >
                  查看（{entry.view.status === "fresh" ? "有效" : STATUS_LABEL[entry.view.status]}）
                </button>
              ))}
            </div>
          ) : null}

          {/*
            R3：覆盖/来源状态与“内容是否还能展示”是两件事。
            状态行始终可见（含不可用原因），但**派生正文**只在来源可用时渲染；
            stale 仍展示内容（并标注过期），unavailable 一律不渲染任何复述来源的文本。
          */}
          {viewState ? (
            <>
              <p
                className="nb-analysis-status"
                data-state={viewState.status}
                data-testid="analysis-status"
              >
                覆盖：本次分析基于 {viewState.frozenCount} 篇；本册现有 {viewState.currentCount} 篇。
                {coverage && coverage.missing.length > 0
                  ? `其中 ${coverage.missing.length} 篇来源已不可用。`
                  : ""}
                {" "}
                来源状态：{STATUS_LABEL[viewState.status]}。
              </p>
              {viewState.status === "unavailable" ? (
                <p className="nb-analysis-warn" role="status" data-testid="analysis-unavailable">
                  {viewState.reason ??
                    "来源已删除或不可读：本次分析的派生内容不再展示（不会复述已不可用的来源）。"}
                  可重新生成，或先恢复来源。
                </p>
              ) : null}
            </>
          ) : null}

          {result && viewState && viewState.status !== "unavailable" ? (
            <div className="nb-analysis-result" data-testid="analysis-result">
              {viewState.reason ? (
                <p className="nb-analysis-warn" role="status">
                  {viewState.reason}
                </p>
              ) : null}

              <section className="nb-analysis-section">
                <h4>总结</h4>
                <p className="nb-analysis-text">{result.summary}</p>
              </section>

              {result.timeline.length > 0 ? (
                <section className="nb-analysis-section">
                  <h4>时间线</h4>
                  <ul className="nb-analysis-timeline">
                    {result.timeline.map((entry, index) => (
                      <li key={`timeline-${index}`}>
                        <span className="nb-analysis-date">{entry.date ?? "日期未知"}</span>
                        <span className="nb-analysis-text">{entry.title}</span>
                        {sources(entry.pageIds)}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {result.themes.length > 0 ? (
                <section className="nb-analysis-section">
                  <h4>主题</h4>
                  <ul className="nb-analysis-list">
                    {result.themes.map((entry, index) => (
                      <li key={`theme-${index}`}>
                        <strong>{entry.name}</strong>
                        <span className="nb-analysis-text">依据：{entry.basis}</span>
                        {sources(entry.pageIds)}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {result.structure.length > 0 ? (
                <section className="nb-analysis-section">
                  <h4>结构建议</h4>
                  <ul className="nb-analysis-list">
                    {result.structure.map((entry, index) => (
                      <li key={`structure-${index}`}>
                        <span className="nb-analysis-tag">建议</span>
                        <span className="nb-analysis-text">{entry.suggestion}</span>
                        {sources(entry.pageIds)}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {result.related.length > 0 ? (
                <section className="nb-analysis-section">
                  <h4>相关篇</h4>
                  <ul className="nb-analysis-list">
                    {result.related.map((entry, index) => (
                      <li key={`related-${index}`}>
                        {sources([entry.pageId])}
                        <span className="nb-analysis-text">↔ {pageTitle(entry.relatedPageId)}</span>
                        <span className="nb-analysis-text">依据：{entry.reason}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {result.duplicates.length > 0 ? (
                <section className="nb-analysis-section">
                  <h4>疑似重复篇</h4>
                  <ul className="nb-analysis-list">
                    {result.duplicates.map((entry, index) => (
                      <li key={`duplicate-${index}`}>
                        {sources(entry.pageIds)}
                        <span className="nb-analysis-text">依据：{entry.reason}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {result.gaps.length > 0 ? (
                <section className="nb-analysis-section">
                  <h4>内容缺口</h4>
                  <ul className="nb-analysis-list">
                    {result.gaps.map((entry, index) => (
                      <li key={`gap-${index}`}>
                        <span className="nb-analysis-tag">建议</span>
                        <span className="nb-analysis-text">{entry.suggestion}</span>
                        <span className="nb-analysis-text">依据：{entry.basis}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          ) : null}

          <div className="nb-analysis-actions">
            {generating ? (
              <>
                <span className="nb-analysis-busy" role="status">
                  正在分析这一本…（可继续编辑，结果只基于已保存的版本）
                </span>
                <button type="button" className="secondary-button" onClick={onCancel}>
                  取消分析
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="primary-button"
                  disabled={status === "loading-config"}
                  onClick={onGenerate}
                >
                  {result ? "重新生成分析" : "分析这一本"}
                </button>
                {status === "config-missing" ? (
                  <button type="button" className="secondary-button" onClick={onReloadConfig}>
                    重新读取配置
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function headline(
  status: NotebookAnalysisStatus,
  viewState?: NotebookAnalysisViewState,
  result?: NotebookAnalysisResult
): string {
  if (status === "generating") return "分析中…";
  if (status === "config-missing") return "尚未配置模型";
  if (status === "loading-config") return "正在读取模型配置…";
  if (!result || !viewState) {
    return status === "failed" ? "失败" : status === "cancelled" ? "已取消" : "未生成";
  }
  const counts = `时间线 ${result.timeline.length} · 主题 ${result.themes.length} · 缺口 ${result.gaps.length}`;
  return viewState.status === "fresh" ? counts : `${counts}（${STATUS_LABEL[viewState.status]}）`;
}
