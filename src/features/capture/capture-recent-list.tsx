"use client";

import type { CaptureMessage } from "./capture-model";

type CaptureRecentListProps = {
  messages: CaptureMessage[];
  mediaUrls: Record<string, string>;
  limit?: number;
  onViewAll: () => void;
};

function formatTime(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

/**
 * 最近记录摘要（只读展示）。
 * 不复制编辑与选择状态：这里没有勾选、删除、整理操作，那些只在完整记录流里。
 */
export function CaptureRecentList({
  messages,
  mediaUrls,
  limit = 3,
  onViewAll
}: CaptureRecentListProps) {
  const recent = messages.slice(0, limit);

  return (
    <section className="capture-recent" aria-labelledby="recent-heading">
      <div className="capture-recent-head">
        <h2 id="recent-heading">最近记录</h2>
        {messages.length > 0 ? (
          <button type="button" className="capture-link" onClick={onViewAll}>
            查看全部记录（{messages.length}）
          </button>
        ) : null}
      </div>
      {recent.length === 0 ? (
        <p className="capture-empty">还没有记录，从上面写下第一条就好。</p>
      ) : (
        <ul className="capture-recent-list">
          {recent.map((message) => (
            <li key={message.id}>
              <time dateTime={message.capturedAt}>{formatTime(message.capturedAt)}</time>
              {message.text ? <p>{message.text}</p> : null}
              {message.mediaIds.length > 0 ? (
                <span className="capture-recent-media">
                  {message.mediaIds.length} 张图片
                  {mediaUrls[message.mediaIds[0]] ? (
                    <img src={mediaUrls[message.mediaIds[0]]} alt="" aria-hidden="true" />
                  ) : null}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
