import type { WorkbenchStreamEvent } from "@/features/ai/stream-events";
import type { WorkbenchProcess } from "./workbench-types";

/** 活动墙钟只算一个区间，不叠加并发工具/模型的时长。 */
export function processElapsedMs(process: WorkbenchProcess, now = Date.now()): number {
  return process.elapsedMs + (process.activeSince === undefined ? 0 : Math.max(0, now - process.activeSince));
}

/** 保存快照冻结到本次检查点，读取历史不会把离线时间算作工作。 */
export function snapshotProcess(process: WorkbenchProcess, now = Date.now()): WorkbenchProcess {
  return {
    startedAt: process.startedAt,
    phase: process.phase,
    elapsedMs: processElapsedMs(process, now),
    ...(process.endedAt === undefined ? {} : { endedAt: process.endedAt }),
    ...(process.outcome === undefined ? {} : { outcome: process.outcome }),
    ...(process.waitingLabel === undefined ? {} : { waitingLabel: process.waitingLabel })
  };
}

export function startProcess(previous?: WorkbenchProcess, now = Date.now()): WorkbenchProcess {
  return { startedAt: previous?.startedAt ?? now, phase: "working", elapsedMs: previous ? processElapsedMs(previous, now) : 0, activeSince: now };
}

export function stageProcess(process: WorkbenchProcess, event: Extract<WorkbenchStreamEvent, { type: "stage" }>, now = Date.now()): WorkbenchProcess {
  if (process.outcome) return process;
  if (event.stage === "waiting") {
    return { ...snapshotProcess(process, now), phase: "waiting", waitingLabel: event.label,
      resumePhase: process.phase === "waiting" ? process.resumePhase : process.phase };
  }
  const active = { ...process };
  delete active.waitingLabel;
  delete active.resumePhase;
  // answering 是业务明确的交付边界，供应商 preparing/thinking 不把它倒退成工作。
  const answering = event.stage === "answering" || process.phase === "answering" || process.resumePhase === "answering";
  return { ...active, phase: answering ? "answering" : "working", activeSince: process.activeSince ?? now };
}

export function finishProcess(process: WorkbenchProcess, outcome: NonNullable<WorkbenchProcess["outcome"]>, now = Date.now()): WorkbenchProcess {
  const finished = snapshotProcess(process, now);
  delete finished.waitingLabel;
  return { ...finished, outcome, ...(process.outcome ? {} : { endedAt: Math.max(process.startedAt, now) }) };
}
