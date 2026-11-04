"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("页面渲染失败", error.digest);
  }, [error.digest]);

  return (
    <main className="root-loading">
      <div className="brand-mark">!</div>
      <h1>页面暂时没有展开</h1>
      <button className="primary-button" onClick={reset}>
        重新加载
      </button>
    </main>
  );
}
