"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { processElapsedMs } from "./workbench-process";
import type { WorkbenchMessage, WorkbenchProcess } from "./workbench-types";

type Props = {
  local?: boolean;
  process?: WorkbenchProcess;
  status?: WorkbenchMessage["status"];
  calls?: WorkbenchMessage["calls"];
  nowMs?: number;
  children: ReactNode;
  onBeforeToggle?: (details: HTMLDetailsElement) => void;
  onAfterToggle?: () => void;
};

export function WorkbenchProcessDisclosure({ local, process, status, calls, nowMs, children, onBeforeToggle, onAfterToggle }: Props) {
  const ended = Boolean(process?.outcome) || status !== "pending";
  // 队列逐轮执行；仅活动入口刷新，不让时钟重排整页、历史 Markdown 或已折叠详情。
  const [clockMs, setClockMs] = useState(() => Date.now());
  const ticking = nowMs === undefined && !ended && process?.activeSince !== undefined;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setClockMs(Date.now()), 200);
    return () => clearInterval(timer);
  }, [ticking]);

  const state = process?.outcome === "cancelled" ? "已取消"
    : process?.outcome === "interrupted" ? "已中断"
      : process?.outcome === "timeout" ? "已超时"
        : process?.outcome === "limit" ? "已达上限"
          : process?.outcome === "error" || status === "failed" ? "失败"
            : ended ? "已完成" : process?.phase === "waiting" ? "等待处理"
              : process?.phase === "answering" ? "回答中" : "工作中";
  const elapsed = process ? Math.floor(processElapsedMs(process, nowMs ?? Math.max(clockMs, process.activeSince ?? 0)) / 1000) : undefined;
  const duration = elapsed === undefined ? "用时未知" : elapsed < 60 ? `${elapsed}秒` : `${Math.floor(elapsed / 60)}分${elapsed % 60}秒`;
  const title = ended || !process ? "工作过程" : process.phase === "answering" ? "正在输出结果" : process.phase === "waiting" ? "等待处理" : "正在工作";
  // 混合回合只列文字模型；独立制图列它实际使用的图像模型，不借下拉选择补猜。
  const textCalls = (calls ?? []).filter(call => call.stage !== "image");
  const models = [...new Set((textCalls.length ? textCalls : calls ?? []).flatMap(call => call.model ? [call.model] : []))];
  const modelText = local ? "本地处理" : models.length ? models.join("、") : ended ? "模型未记录" : "模型待调用";
  const timingText = process ? `总计 ${duration}` : duration;
  return <><details className="wb-process" open={false} data-state={state}
    onClickCapture={event => {
      const target = event.target;
      if (target instanceof Element && target.closest("summary")) {
        const summary = target.closest("summary")!;
        if (summary.parentElement instanceof HTMLDetailsElement) onBeforeToggle?.(summary.parentElement);
      }
    }}
    onToggle={() => onAfterToggle?.()}>
    <summary aria-label={`本轮工作过程：${title}，${timingText}，${modelText}${ended && state !== "已完成" ? `，${state}` : ""}`}>
      <ChevronDown size={14} aria-hidden />
      <span>{title} · {process ? "总计 " : null}<span className="wb-elapsed">{duration}</span></span>
      <span className="wb-process-meta">· {modelText}</span>
      {ended && process && state !== "已完成" ? <span className="wb-process-meta">{state}</span> : null}
    </summary>
    <div className="wb-process-body">{children}</div>
  </details><hr className="wb-process-divider" /></>;
}
