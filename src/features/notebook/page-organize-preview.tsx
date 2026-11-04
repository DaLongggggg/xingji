"use client";

/**
 * P2-02/P2-03：编辑区上方的内联整理面板（纯展示，不含任何 AI 调用）。
 *
 * 边界：
 * - 正文按**纯文本**呈现（文本节点），不注入模型返回的 HTML，不引入 diff 依赖；
 * - 前后全文完整、可滚动，保留块顺序；无差异时明确提示，不提供“接受”；
 * - 忙碌/冲突/失败都有可见文案，不遮挡编辑动作（面板在编辑区上方，可展开/收起）；
 * - 可用动作由**持久化状态**决定（`runActionsFor`），不把按钮做成点击后静默无效：
 *   draft=接受/拒绝，accepted=继续提交/撤回，accepting=继续提交（不可撤回），applied=只读。
 */
import { useMemo } from "react";
import { ChevronRight, Sparkles, X } from "lucide-react";
import type { PageOrganizeStatus, PageOrganizeRecovered, PageOrganizeRunAction } from "./use-page-organize";
import type { OrganizeTextView } from "./page-organize-diff";

export type PageOrganizePanelProps = {
  status: PageOrganizeStatus;
  message?: string;
  /** 可整理的目标名（篇标题）；无目标时不显示面板。 */
  pageTitle?: string;
  /** 当前展示建议的持久化状态（决定可用动作）。 */
  proposalStatus?: "draft" | "accepted" | "accepting" | "rejected" | "applied" | "conflicted";
  /** 与当前建议成对的任务状态（用于“提交中/已完成”文案）。 */
  taskStatus?: string;
  diff?: OrganizeTextView;
  /** 可用动作（由持久化状态计算，见 runActionsFor）。 */
  actions: PageOrganizeRunAction[];
  /** 正在应用：此窗口内冻结编辑器输入，避免“最终保存→AI提交→刷新”间丢字。 */
  busy: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onApply: () => void;
  onReject: () => void;
  onWithdraw: () => void;
  onRegenerate: () => void;
  onCancel: () => void;
  onDismiss: () => void;
  /** 未配置/读取配置失败时：只重新读取服务端公开配置，不发模型请求。 */
  onReloadConfig: () => void;
  /** 刷新后可恢复的建议（连同关联任务状态；显式恢复，不自动应用）。 */
  pending: PageOrganizeRecovered[];
  onResume: (proposalId: string) => void;
  /** 本页存在归属不明的 running 任务：只读说明，无操作入口。 */
  runInfo?: string;
};

const STATUS_LABEL: Record<string, string> = {
  draft: "待确认",
  accepted: "已授权，未提交",
  accepting: "提交占用中",
  applied: "已应用",
  conflicted: "冲突",
  rejected: "已拒绝"
};

const TASK_LABEL: Record<string, string> = {
  queued: "排队",
  running: "运行中",
  waiting_user: "待你决定",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消"
};

export function PageOrganizePanel({
  status,
  message,
  pageTitle,
  proposalStatus,
  taskStatus,
  diff,
  actions,
  busy,
  collapsed,
  onToggleCollapsed,
  onApply,
  onReject,
  onWithdraw,
  onRegenerate,
  onCancel,
  onDismiss,
  onReloadConfig,
  pending,
  onResume,
  runInfo
}: PageOrganizePanelProps) {
  const generating = status === "generating";
  const applying = status === "applying";
  const showDiff = diff !== undefined && status !== "generating";
  const blocks = useMemo(() => diff?.blocks ?? [], [diff]);
  const can = (action: PageOrganizeRunAction) => actions.includes(action);

  if (!pageTitle) return null;

  return (
    <section className="nb-organize" data-status={status} aria-label="AI 整理本篇">
      <header className="nb-organize-head">
        <button
          type="button"
          className="nb-organize-toggle"
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        >
          <Sparkles size={15} aria-hidden />
          <span>整理本篇</span>
          <span className="nb-organize-headline">{headline(status, diff, proposalStatus, taskStatus)}</span>
          <ChevronRight
            size={15}
            aria-hidden
            className={collapsed ? "nb-organize-chevron" : "nb-organize-chevron is-open"}
          />
        </button>
        {status !== "idle" && status !== "config-missing" ? (
          <button
            type="button"
            className="nb-icon-button"
            aria-label="关闭整理面板"
            title="关闭"
            onClick={onDismiss}
          >
            <X size={15} />
          </button>
        ) : null}
      </header>

      {collapsed ? null : (
        <div className="nb-organize-body">
          {message ? (
            <p className="nb-organize-message" role="status" aria-live="polite">
              {message}
            </p>
          ) : null}

          {/*
            Q1：归属不明的运行中任务只做只读说明，**不提供批量“标记中断”入口**；
            现有 API 无法区分“本会话崩溃遗留”与“另一标签正在执行”。
          */}
          {runInfo ? (
            <p className="nb-organize-note" role="note" data-testid="organize-run-info">
              {runInfo}
            </p>
          ) : null}

          {pending.length > 0 && status === "idle" ? (
            <div className="nb-organize-recover">
              <span>发现 {pending.length} 条刷新前的建议（不会自动应用或请求）。</span>
              {pending.map((entry) => (
                <button
                  key={entry.proposal.id}
                  type="button"
                  onClick={() => onResume(entry.proposal.id)}
                >
                  查看（{STATUS_LABEL[entry.proposal.status] ?? entry.proposal.status}）
                </button>
              ))}
            </div>
          ) : null}

          {showDiff ? (
            <div className="nb-organize-diff" data-testid="organize-diff">
              {blocks.map((block, index) => (
                <article key={block.blockId} className="nb-organize-block" data-changed={block.changed}>
                  <header>
                    <span className="nb-organize-block-index">第 {index + 1} 段</span>
                    <span className="nb-organize-block-flag">{block.changed ? "有改动" : "未改动"}</span>
                  </header>
                  <div className="nb-organize-pair">
                    <div>
                      <h4>原文</h4>
                      <p className="nb-organize-text">{block.before || "（空）"}</p>
                    </div>
                    <div>
                      <h4>整理后</h4>
                      <p className="nb-organize-text">{block.after || "（空）"}</p>
                    </div>
                  </div>
                </article>
              ))}
              {diff?.unchanged ? (
                <p className="nb-organize-note" role="status">
                  正文没有差异，无需应用。
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="nb-organize-actions">
            {generating ? (
              <>
                <span className="nb-organize-busy" role="status">
                  正在整理…（可继续编辑，结果只基于已保存的版本）
                </span>
                <button type="button" className="secondary-button" onClick={onCancel}>
                  取消生成
                </button>
              </>
            ) : applying ? (
              <>
                <span className="nb-organize-busy" role="status">
                  {proposalStatus === "accepting" ? "正在确认提交结果…" : "正在保存并应用…"}
                  （此期间编辑区暂时只读，避免丢字）
                </span>
                <button type="button" className="secondary-button" onClick={onCancel}>
                  停止等待
                </button>
              </>
            ) : (
              <>
                {can("apply") ? (
                  <button type="button" className="primary-button" disabled={busy} onClick={onApply}>
                    接受并应用
                  </button>
                ) : null}
                {can("submit") ? (
                  <button type="button" className="primary-button" disabled={busy} onClick={onApply}>
                    {proposalStatus === "accepting" ? "继续提交（确认结果）" : "继续提交"}
                  </button>
                ) : null}
                {can("reject") ? (
                  <button type="button" className="secondary-button" disabled={busy} onClick={onReject}>
                    拒绝
                  </button>
                ) : null}
                {can("withdraw") ? (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={onWithdraw}
                  >
                    撤回
                  </button>
                ) : null}
                {can("regenerate") ? (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={onRegenerate}
                  >
                    重新生成
                  </button>
                ) : null}
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
  status: PageOrganizeStatus,
  diff: OrganizeTextView | undefined,
  proposalStatus?: string,
  taskStatus?: string
): string {
  switch (status) {
    case "loading-config":
      return "正在读取模型配置…";
    case "config-missing":
      return "尚未配置";
    case "generating":
      return "整理中…";
    case "preview":
      return diff
        ? `${diff.changedCount} 段有改动，${
            proposalStatus ? STATUS_LABEL[proposalStatus] ?? "" : "待确认"
          }${taskStatus ? `（任务${TASK_LABEL[taskStatus] ?? taskStatus}）` : ""}`
        : "待确认";
    case "applying":
      return proposalStatus === "accepting" ? "正在确认提交结果…" : "正在应用…";
    case "applied":
      return "已应用";
    case "conflict":
      return "存在冲突，需你决定";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    default:
      return "空闲";
  }
}
