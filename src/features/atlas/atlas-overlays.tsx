"use client";

import { useDismissableLayer } from "@/lib/dismissable-layer";

import { useCallback, useId, useLayoutEffect, useRef } from "react";
import { ArrowUpRight, BookOpen, MapPin, X } from "lucide-react";
import type { MemoryNote } from "./region-card-layout";

/**
 * 记忆地图的返回路径与照片卡原位记录预览。
 * 只消费展示数据与 DOM 锚点，不读存储、不碰 Leaflet。
 *
 * 路径在地图上方正常排版，照片预览仍是覆盖层。
 * 本地滚动/拖动/键盘事件在各自容器内截停，不触发地图交互。
 */

const stopPropagationProps = {
  onWheel: (event: React.WheelEvent) => event.stopPropagation(),
  onPointerDown: (event: React.PointerEvent) => event.stopPropagation(),
  onDoubleClick: (event: React.MouseEvent) => event.stopPropagation(),
  onKeyDown: (event: React.KeyboardEvent) => event.stopPropagation()
} as const;

/**
 * 地图上方：当前层级面包屑，长路径滚动到当前地区。
 * 已经过的层级可点击返回（恢复对应层级与可用视角）；当前层级不可点。
 */
export function AtlasBreadcrumb({
  items,
  onLevelClick
}: {
  items: string[];
  onLevelClick?: (levelIndex: number) => void;
}) {
  const pathRef = useRef<HTMLElement>(null);
  const pathKey = items.join("\0");
  useLayoutEffect(() => {
    const path = pathRef.current;
    if (path) path.scrollLeft = path.scrollWidth;
  }, [pathKey]);
  if (items.length === 0) return null;
  const lastIndex = items.length - 1;
  return (
    <div className="atlas-overlay atlas-breadcrumb" {...stopPropagationProps}>
      {items.length > 0 ? (
        <nav ref={pathRef} aria-label="地图路径">
          <ol className="atlas-breadcrumb-path">
            {items.map((item, index) => (
              <li key={`${item}-${index}`}>
                {onLevelClick && index < lastIndex ? (
                  <button
                    type="button"
                    className="atlas-breadcrumb-link"
                    onClick={() => onLevelClick(index)}
                    aria-label={`返回${item}`}
                    title={item}
                  >
                    {item}
                  </button>
                ) : (
                  <span title={item} aria-current={index === lastIndex ? "location" : undefined}>{item}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
    </div>
  );
}

/**
 * 原位记录预览：覆盖触发卡片，按地图可用空间避让边缘。
 * 非模态列表可关闭（图标/Esc/点击外部），打开原笔记走既有详情面板。
 */
export function AtlasMemoryPreview({
  regionName,
  pages,
  trigger,
  motionReduced,
  nightMode,
  onOpenPage,
  onClose
}: {
  regionName: string;
  pages: MemoryNote[];
  trigger: HTMLElement;
  motionReduced: boolean;
  nightMode: boolean;
  onOpenPage: (pageId: string) => void;
  onClose: () => void;
}) {
  const dialogId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const anchorRef = useRef(trigger);
  const collapseTransformRef = useRef("none");
  const animationRef = useRef<Animation | null>(null);
  const closingRef = useRef(false);
  const disposedRef = useRef(false);

  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    const dialog = dialogRef.current;
    if (motionReduced || !dialog || typeof dialog.animate !== "function") {
      onClose();
      return;
    }
    // 在入场中途关闭也从当前画面收起，不跳回完全展开态。
    const current = getComputedStyle(dialog);
    const from = { transform: current.transform, opacity: current.opacity };
    animationRef.current?.cancel();
    const animation = dialog.animate(
      [from, { transform: collapseTransformRef.current, opacity: 0 }],
      { duration: 180, easing: "cubic-bezier(.4, 0, .2, 1)", fill: "forwards" }
    );
    animationRef.current = animation;
    void animation.finished
      .then(() => {
        if (!disposedRef.current) onClose();
      })
      .catch(() => {
        /* 换卡或卸载取消动画，不关闭新的预览。 */
      });
  }, [motionReduced, onClose]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const mapWrap = trigger.closest<HTMLElement>(".atlas-map-wrap");
    const pane = mapWrap;
    const parent = dialog?.offsetParent;
    if (!dialog || !mapWrap || !pane || !(parent instanceof HTMLElement)) {
      onClose();
      return;
    }
    disposedRef.current = false;
    closingRef.current = false;
    const sourceRegionId = trigger.dataset.regionId;
    const sourceCardId = trigger.dataset.cardId;

    const position = () => {
      // Leaflet 可能把徽记改为完整卡或更新封面，按地区重新找同一入口。
      const anchor = Array.from(pane.querySelectorAll<HTMLElement>("[data-card-id]")).find(
        (element) =>
          sourceCardId
            ? element.dataset.cardId === sourceCardId
            : element.dataset.regionId === sourceRegionId
      );
      if (!anchor) {
        onClose();
        return;
      }
      anchorRef.current = anchor;
      const source = anchor.getBoundingClientRect();
      const bounds = mapWrap.getBoundingClientRect();
      const origin = parent.getBoundingClientRect();
      dialog.style.width = `${Math.min(280, Math.max(0, bounds.width - 24))}px`;
      dialog.style.maxHeight = `${Math.min(320, Math.max(0, bounds.height - 24))}px`;
      const width = dialog.offsetWidth;
      const height = dialog.offsetHeight;
      const left = Math.max(
        bounds.left + 12,
        Math.min(source.left + (source.width - width) / 2, bounds.right - width - 12)
      );
      const top = Math.max(bounds.top + 12, Math.min(source.top, bounds.bottom - height - 12));
      dialog.style.left = `${left - origin.left}px`;
      dialog.style.top = `${top - origin.top}px`;
      collapseTransformRef.current = `translate(${source.left - left}px, ${source.top - top}px) scale(${source.width / width}, ${source.height / height})`;
      if (!anchor.classList.contains("is-preview-open")) anchor.classList.add("is-preview-open");
      anchor.inert = true;
      anchor.setAttribute("aria-expanded", "true");
      anchor.setAttribute("aria-controls", dialogId);
    };
    position();
    if (!motionReduced && typeof dialog.animate === "function") {
      animationRef.current = dialog.animate(
        [
          { transform: collapseTransformRef.current, opacity: 0.6 },
          { transform: "none", opacity: 1 }
        ],
        { duration: 260, easing: "cubic-bezier(.2, .8, .2, 1)" }
      );
    }
    closeRef.current?.focus({ preventScroll: true });
    const observer = new MutationObserver(position);
    observer.observe(pane, { childList: true, subtree: true });
    const resize = new ResizeObserver(position);
    resize.observe(mapWrap);
    resize.observe(dialog);
    return () => {
      disposedRef.current = true;
      animationRef.current?.cancel();
      observer.disconnect();
      resize.disconnect();
      const anchor = anchorRef.current;
      anchor.classList.remove("is-preview-open");
      anchor.inert = false;
      anchor.setAttribute("aria-expanded", "false");
      anchor.removeAttribute("aria-controls");
      if (anchor.isConnected && dialog.contains(document.activeElement)) {
        anchor.focus({ preventScroll: true });
      }
    };
  }, [dialogId, trigger, motionReduced, onClose]);

  useDismissableLayer(dialogRef, true, close);
  return (
    <div
      ref={dialogRef}
      id={dialogId}
      className={`atlas-overlay atlas-memory-preview${nightMode ? " is-night" : ""}`}
      role="dialog"
      aria-label={`${regionName} 的关联记录`}
      {...stopPropagationProps}
      onKeyDown={(event) => {
        stopPropagationProps.onKeyDown(event);
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      }}
    >
      <header className="atlas-memory-preview-head">
        <span className="atlas-memory-preview-mark" aria-hidden="true"><MapPin size={16} /></span>
        <h3>{regionName}</h3>
        <span className="atlas-memory-preview-count">{pages.length} 篇</span>
        <button
          ref={closeRef}
          type="button"
          className="atlas-memory-preview-action"
          onClick={close}
          aria-label="关闭记录预览"
          title="关闭"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <ul className="atlas-memory-preview-list">
        {pages.map((page) => (
          <li key={page.pageId}>
            <button
              type="button"
              className="atlas-memory-preview-entry"
              onClick={() => onOpenPage(page.pageId)}
              aria-label={`打开笔记：${page.title}`}
              title={`打开「${page.title}」`}
            >
              <span className="atlas-memory-preview-note-icon" aria-hidden="true"><BookOpen size={17} /></span>
              <span className="atlas-memory-preview-copy">
                <strong title={page.title}>{page.title}</strong>
                <small title={`${page.notebookTitle} · ${page.capturedAt.slice(0, 10)}`}>
                  {page.notebookTitle} · {page.capturedAt.slice(0, 10)}
                </small>
              </span>
              <ArrowUpRight className="atlas-memory-preview-arrow" size={16} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
