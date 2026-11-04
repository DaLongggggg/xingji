"use client";

/**
 * P8：搜索区域内的「整理搜索结果」面板（纯展示，不含任何 AI 调用）。
 *
 * 边界：
 * - 只读：没有「接受 / 应用到笔记本 / 合并 / 删除」动作，分组只是建议；
 * - 全部内容按纯文本渲染（文本节点），不注入模型返回的 HTML；
 * - 明确说明本阶段只用**关键词与结构过滤**：无法保证召回「没有明确出现关键词、
 *   但语义相关」的内容；
 * - 展示实际使用的范围（来自搜索区的结构筛选），关键词框不参与整理；
 * - 每条来源都带按钮：点击经既有保存协调与权威可见性复核后跳转（由 hook 负责）；
 * - 来源不可用时**不渲染**任何复述来源的派生正文。
 */
import { ChevronRight, ListTree, Sparkles, X } from "lucide-react";
import { findRegion } from "@/features/regions/region-catalog";
import type { CollectionScope } from "@/features/ai/ai-task";
import { MAX_COLLECTION_GOAL_CHARS } from "@/features/ai/ai-task";
import type { LightAgentTraceStep } from "@/features/ai/ai-light-agent-runner";
import type { AiProposal } from "@/features/ai/ai-proposal";
import type { LightAgentApi, LightAgentStatus, LightAgentViewState } from "./use-light-agent";

export type ScopeLabels = {
  notebook: (notebookId: string) => string;
  trip: (tripId: string) => string;
  place: (placeId: string) => string;
};

/**
 * 范围摘要（**实际发送字段的口径**）：面板与告知弹窗共用同一份文本，
 * 避免「告知写一套、执行用另一套」。
 */
export function formatScopeSummary(scope: CollectionScope, labels: ScopeLabels): string[] {
  const names = (ids: readonly string[] | null, label: (id: string) => string) =>
    ids === null ? "不限" : ids.map(label).join("、");
  const regionName = (regionId: string) =>
    findRegion(regionId)?.name ?? regionId;
  return [
    `笔记本：${names(scope.notebookIds, labels.notebook)}`,
    `地区：${names(scope.regionIds, regionName)}`,
    `旅行：${names(scope.tripIds, labels.trip)}`,
    `地点：${names(scope.placeIds, labels.place)}`,
    `时间：${
      scope.from === null && scope.to === null
        ? "不限"
        : `${scope.from ?? "最早"} 至 ${scope.to ?? "最新"}（结束日不含）`
    }`
  ];
}

export type LightAgentPanelProps = {
  agent: LightAgentApi;
  /** 把 notebookId / tripId / placeId 显示为名称。 */
  labels: ScopeLabels;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onDismiss: () => void;
  /** 把 pageId 显示为当前标题（找不到时原样显示 id）。 */
  pageTitle: (pageId: string) => string;
  onOpenSource: (pageId: string) => void;
  onDiscard: (proposalId: string) => void;
  onResume: (proposalId: string) => void;
};

const STATUS_LABEL: Record<LightAgentViewState["status"], string> = {
  fresh: "与当前内容一致",
  stale: "已过期",
  unavailable: "来源不可用"
};

const STEP_LABEL: Record<LightAgentTraceStep["kind"], string> = {
  plan: "计划",
  search: "搜索",
  read: "读取",
  synthesize: "分组"
};

export function LightAgentPanel({
  agent,
  labels,
  collapsed,
  onToggleCollapsed,
  onDismiss,
  pageTitle,
  onOpenSource,
  onDiscard,
  onResume
}: LightAgentPanelProps) {
  const scopeLines = formatScopeSummary(agent.scope, labels);
  const running = agent.status === "running";
  const groups =
    agent.result && agent.viewState && agent.viewState.status !== "unavailable"
      ? agent.result.groups
      : [];

  const sources = (pageIds: string[]) => (
    <span className="nb-agent-sources">
      {pageIds.map((pageId) => (
        <button
          key={pageId}
          type="button"
          className="nb-agent-source"
          onClick={() => onOpenSource(pageId)}
        >
          {pageTitle(pageId)}
        </button>
      ))}
    </span>
  );

  return (
    <section
      className="nb-agent"
      data-status={agent.status}
      aria-label="整理搜索结果（只读分组）"
    >
      <header className="nb-agent-head">
        <button
          type="button"
          className="nb-agent-toggle"
          aria-expanded={!collapsed}
          data-testid="light-agent-toggle"
          onClick={onToggleCollapsed}
        >
          <ListTree size={15} aria-hidden />
          <span className="nb-agent-label">整理搜索结果</span>
          <span className="nb-agent-headline">{headline(agent)}</span>
          <ChevronRight
            size={15}
            aria-hidden
            className={collapsed ? "nb-agent-chevron" : "nb-agent-chevron is-open"}
          />
        </button>
        {collapsed ? null : (
          <button
            type="button"
            className="nb-icon-button"
            aria-label="关闭整理面板"
            title="关闭"
            onClick={onDismiss}
          >
            <X size={15} />
          </button>
        )}
      </header>

      {collapsed ? null : (
        <div className="nb-agent-body">
          <div className="nb-agent-scope" data-testid="light-agent-scope">
            <span className="nb-agent-scope-title">本次范围（来自上方筛选，关键词框不参与整理）：</span>
            <ul>
              {scopeLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>

          <label className="nb-agent-field">
            <span>整理目标（会转成搜索关键词）</span>
            <textarea
              aria-label="整理目标"
              data-testid="light-agent-goal"
              rows={2}
              maxLength={MAX_COLLECTION_GOAL_CHARS}
              value={agent.goal}
              disabled={running}
              placeholder="例如：整理过去半年明确提到咖啡的篇，按主题分组"
              onChange={(event) => agent.setGoal(event.target.value)}
            />
          </label>

          <div className="nb-agent-actions">
            {running ? (
              <>
                <span className="nb-agent-busy" role="status">
                  正在按计划搜索、读取并分组…（可取消）
                </span>
                <button
                  type="button"
                  className="secondary-button"
                  data-testid="light-agent-cancel"
                  onClick={() => void agent.cancel()}
                >
                  取消整理
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="primary-button"
                  data-testid="light-agent-start"
                  disabled={agent.status === "loading-config" || agent.goal.trim().length === 0}
                  onClick={agent.requestStart}
                >
                  <Sparkles size={14} aria-hidden />
                  {agent.proposal ? "重新整理" : "整理搜索结果"}
                </button>
                {agent.status === "config-missing" || agent.status === "disabled" ? (
                  <button
                    type="button"
                    className="secondary-button"
                    data-testid="light-agent-reload"
                    onClick={() => void agent.reloadConfig()}
                  >
                    重新读取配置
                  </button>
                ) : null}
              </>
            )}
          </div>

          {agent.status === "disabled" ? (
            <p className="nb-agent-warn" role="status" data-testid="light-agent-disabled">
              {agent.message ?? "整理搜索结果功能当前未启用。"}
            </p>
          ) : agent.message ? (
            <p className="nb-agent-message" role="status" aria-live="polite" data-testid="light-agent-message">
              {agent.message}
            </p>
          ) : null}

          {agent.runInfo ? (
            <p className="nb-agent-note" role="note" data-testid="light-agent-run-info">
              {agent.runInfo}
            </p>
          ) : null}

          {/* R5：恢复扫描读取失败必须可见，不能伪装成「没有历史结果」。 */}
          {agent.recoveredMessage ? (
            <p className="nb-agent-warn" role="status" data-testid="light-agent-recovered-message">
              {agent.recoveredMessage}
            </p>
          ) : null}

          {agent.recovered.length > 0 && agent.status !== "ready" ? (
            <div className="nb-agent-recover">
              <span>发现 {agent.recovered.length} 条本范围的既有整理（不会自动请求）。</span>
              {agent.recovered.map((entry) => (
                <button
                  key={entry.proposal.id}
                  type="button"
                  data-testid="light-agent-recover"
                  onClick={() => onResume(entry.proposal.id)}
                >
                  查看（{entry.view.status === "fresh" ? "有效" : STATUS_LABEL[entry.view.status]}）
                </button>
              ))}
            </div>
          ) : null}

          {agent.trace.length > 0 ? (
            <ol className="nb-agent-steps" data-testid="light-agent-steps">
              {agent.trace.map((step, index) => (
                <li key={`${step.kind}-${index}`} data-state={step.status}>
                  {STEP_LABEL[step.kind]}：{traceDetail(step)}
                </li>
              ))}
            </ol>
          ) : null}

          {agent.viewState ? (
            <p className="nb-agent-status" data-state={agent.viewState.status} data-testid="light-agent-status">
              来源状态：{STATUS_LABEL[agent.viewState.status]}（共 {agent.viewState.sources.length} 篇来源）。
            </p>
          ) : null}

          {agent.viewState?.status === "unavailable" ? (
            <p className="nb-agent-warn" role="status" data-testid="light-agent-unavailable">
              {agent.viewState.reason ??
                "来源已删除或不可读：本次分组不再展示（不会复述已不可用的来源）。"}
              可重新整理，或先恢复来源。
            </p>
          ) : null}

          {agent.result && agent.viewState && agent.viewState.status !== "unavailable" ? (
            <div className="nb-agent-result" data-testid="light-agent-result">
              {agent.viewState.reason ? (
                <p className="nb-agent-warn" role="status">
                  {agent.viewState.reason}
                </p>
              ) : null}
              <h4 className="nb-agent-title">{agent.result.title}</h4>
              {groups.length > 0 ? (
                <ul className="nb-agent-groups">
                  {groups.map((group, index) => (
                    <li key={`group-${index}`}>
                      <strong>{group.name}</strong>
                      <span className="nb-agent-text">理由：{group.reason}</span>
                      {sources(group.pageIds)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="nb-agent-note">这次没有形成任何主题分组，全部归入未归组。</p>
              )}
              {agent.result.ungroupedPageIds.length > 0 ? (
                <div className="nb-agent-ungrouped">
                  <span>
                    未归组 {agent.result.ungroupedPageIds.length} 篇
                    {agent.result.coverageNote ? `：${agent.result.coverageNote}` : ""}
                  </span>
                  {sources(agent.result.ungroupedPageIds)}
                </div>
              ) : null}
              <div className="nb-agent-result-actions">
                <button
                  type="button"
                  className="secondary-button"
                  data-testid="light-agent-discard"
                  onClick={() => onDiscard(agent.proposal?.id ?? "")}
                >
                  丢弃这份建议
                </button>
              </div>
            </div>
          ) : null}

          {agent.status === "empty" ? (
            <p className="nb-agent-note" data-testid="light-agent-empty">
              没有找到匹配的篇。可以换关键词或放宽范围后再试。
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** 轨迹只展示类型、计数与耗时（不含模型输出、思考或上游请求）。 */
function traceDetail(step: LightAgentTraceStep): string {
  const parts: string[] = [];
  const counts = step.counts ?? {};
  if (counts.step !== undefined) parts.push(`第 ${counts.step} 次调用`);
  if (counts.matches !== undefined) parts.push(`命中 ${counts.matches} 条`);
  if (counts.truncated === 1) parts.push("已截断");
  if (counts.pages !== undefined) parts.push(`读取 ${counts.pages} 篇`);
  if (counts.readPages !== undefined) parts.push(`累计 ${counts.readPages} 篇`);
  if (counts.readChars !== undefined) parts.push(`累计 ${counts.readChars} 字`);
  if (counts.groups !== undefined) parts.push(`分组 ${counts.groups} 组`);
  if (counts.ungrouped !== undefined) parts.push(`未归组 ${counts.ungrouped} 篇`);
  if (step.errorCode) parts.push(`错误 ${step.errorCode}`);
  parts.push(`${step.durationMs}ms`);
  return parts.join(" · ");
}

function headline(agent: LightAgentApi): string {
  if (agent.status === "running") return "整理中…";
  if (agent.status === "loading-config") return "正在读取模型配置…";
  if (agent.status === "config-missing") return "尚未配置模型";
  if (agent.status === "disabled") return "未启用";
  if (agent.status === "empty") return "无结果";
  const proposal: AiProposal | undefined = agent.proposal;
  if (!proposal || !agent.result) return agent.status === "idle" ? "未整理" : statusWord(agent.status);
  const grouped = agent.result.groups.reduce((sum, group) => sum + group.pageIds.length, 0);
  const counts = `${agent.result.groups.length} 组 · ${grouped} 篇已归组`;
  return agent.viewState && agent.viewState.status !== "fresh"
    ? `${counts}（${STATUS_LABEL[agent.viewState.status]}）`
    : counts;
}

function statusWord(status: LightAgentStatus): string {
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已取消";
  if (status === "ready") return "已生成";
  return "未整理";
}
