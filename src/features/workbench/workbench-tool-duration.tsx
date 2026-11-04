"use client";

import { useEffect, useState } from "react";
import { formatDuration } from "./workbench-types";

/** 只刷新调用旁的时间，不让时钟重排会话正文或重挂折叠内容。 */
export function WorkbenchToolDuration({ startedAt, ms, running }: {
  startedAt?: number;
  ms?: number;
  running: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  const ticking = running && ms === undefined && startedAt !== undefined;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking, startedAt]);
  if (ms !== undefined) return <span className="wb-elapsed"> · {formatDuration(ms)}</span>;
  if (!ticking) return null;
  const seconds = Math.floor(Math.max(0, now - startedAt!) / 1000);
  return <span className="wb-elapsed" aria-live="off"> · {seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`}</span>;
}
