"use client";

import { useDismissableLayer } from "@/lib/dismissable-layer";

import { ArrowUpRight, CalendarDays, X } from "lucide-react";
import { useRef, useState } from "react";
import { PhotoViewer } from "@/features/photos/photo-viewer";
import type { NotebookPage } from "./notebook-model";

export type PageDetailPanelProps = {
  page: NotebookPage;
  notebookTitle: string;
  /** 媒体 URL 由调用方按需提供；缺失时明确提示，不显示空白。 */
  mediaUrls: Record<string, string>;
  /** 打开这页所属笔记本并定位到当前篇；缺省时不显示入口。 */
  onOpenNote?: () => void;
  onClose: () => void;
};

/**
 * 014-C：只读笔记详情（首页内面板）。
 *
 * 只读展示具体篇，不修改任何存储；面板是同一个首页的一部分，
 * 因此打开/关闭都不会卸载记录输入、勾选或“存入”目标。
 */
export function PageDetailPanel({ page, notebookTitle, mediaUrls, onOpenNote, onClose }: PageDetailPanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  useDismissableLayer(panelRef, true, onClose);
  const [viewing, setViewing] = useState<{ id: string; trigger: HTMLButtonElement }>();
  const images = page.blocks.flatMap(block => block.type === "photo" && mediaUrls[block.mediaId]
    ? [{ id: block.id, name: block.caption || "笔记图片", url: mediaUrls[block.mediaId] }] : []);
  return (
    <aside ref={panelRef} className="page-detail" aria-label={`笔记详情 ${page.title}`}>
      <header className="page-detail-head">
        <div>
          <p className="page-detail-notebook">{notebookTitle}</p>
          <h3>{page.title}</h3>
          <p className="page-detail-meta">
            <CalendarDays size={14} aria-hidden="true" />
            <time dateTime={page.capturedAt}>{page.capturedAt.slice(0, 10)}</time>
          </p>
        </div>
        <div className="page-detail-head-actions">
          {onOpenNote ? (
            <button
              type="button"
              className="page-detail-open-note"
              onClick={onOpenNote}
              aria-label="跳转到笔记"
              title="跳转到笔记"
            >
              <ArrowUpRight size={16} aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            aria-label="关闭笔记详情"
          >
            <X size={15} /> 关闭
          </button>
        </div>
      </header>
      <div className="page-detail-body">
        {page.blocks.map((block) => {
          if (block.type === "text") return <p key={block.id}>{block.text}</p>;
          if (block.type === "unsupported-image") {
            return (
              <p key={block.id} className="notebook-unsupported-image">
                未支持的图片源（原样保留，不下载）：{block.markdown}
              </p>
            );
          }
          return (
            <figure key={block.id}>
              {mediaUrls[block.mediaId] ? (
                // 本地媒体 URL（objectURL），next/image 不适用（与既有笔记本渲染一致）。
                <button type="button" className="page-detail-view-photo" aria-label={`查看原图：${block.caption || block.mediaId}`}
                  onClick={event => setViewing({ id: block.id, trigger: event.currentTarget })}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={mediaUrls[block.mediaId]} alt={block.caption} />
                </button>
              ) : (
                <span className="notebook-missing-photo">媒体 {block.mediaId} 暂不可用</span>
              )}
              {block.caption ? <figcaption>{block.caption}</figcaption> : null}
            </figure>
          );
        })}
      </div>
      {viewing && images.length ? <PhotoViewer images={images} initialId={viewing.id}
        returnFocus={viewing.trigger} onClose={() => setViewing(undefined)} /> : null}
    </aside>
  );
}
