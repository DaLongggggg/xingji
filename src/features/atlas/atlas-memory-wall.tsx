"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Map as LeafletMap } from "leaflet";
import { ArrowRight, BookOpen, ChevronLeft, ChevronRight, Images, MapPin, X } from "lucide-react";
import type { BoundaryDataset } from "./boundary-contract";
import { labelAnchor, shortRegionName } from "./region-label-layout";
import {
  placeWallCards,
  planMemoryWall,
  type MemoryNote,
  type MemoryRegion,
  type WallPoint,
  type WallSlot,
  type WallFrame
} from "./region-card-layout";

/** 卡片日期只取本地保存的日期部分；无效/未知日期不伪造时间。 */
function formatMemoryDate(value: string): string {
  const date = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.replaceAll("-", ".") : "未标日期";
}

/** 叠卡用月份范围，避免在 104px 读文宽里重复完整年份。 */
function formatStackDate(pages: MemoryNote[]): string {
  const months = pages
    .map((page) => page.capturedAt.slice(0, 7))
    .filter((month) => /^\d{4}-\d{2}$/.test(month));
  if (!months.length) return "未标日期";
  const newest = months[0];
  const oldest = months[months.length - 1];
  if (newest === oldest) return newest.replace("-", ".");
  const [oldYear, oldMonth] = oldest.split("-");
  const [newYear, newMonth] = newest.split("-");
  return oldYear === newYear
    ? `${oldYear}.${oldMonth}–${newMonth}`
    : `${oldYear}.${oldMonth}–${newYear}.${newMonth}`;
}

/** 连线与图钉共用连接点：Web相纸顶中，原生沿用右上角。 */
function cardConnectionPoint(slot: WallSlot, cardWidth: number, centered = false): WallPoint {
  if (centered) return { x: slot.x + cardWidth / 2, y: slot.y + 5 };
  const inset = Math.max(4, Math.min(6, Math.round(cardWidth * 0.055)));
  return { x: slot.x + cardWidth - inset, y: slot.y + inset };
}

/** 图片失败只降级本卡；新封面 URL 可重试，不影响卡位与原始媒体。 */
function MemoryCardVisual({ pages, stack }: { pages: MemoryNote[]; stack: boolean }) {
  const first = pages[0];
  /** 地区封面跟随 selectRegionCover 语义：第一个带照片的页，而不是排序首页。 */
  const coverNote = pages.find(note => (note.photoMediaIds?.length ?? 0) > 0) ?? first;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const hasPhoto = Boolean(coverNote.coverUrl) && coverNote.coverUrl !== failedUrl;
  return (
    <span className={`memory-card-visual${hasPhoto ? "" : " is-paper"}`}>
      {stack ? (
        <span className="memory-stack-sheets" aria-hidden="true">
          {pages.slice(1, 3).map((note) => (
            <span key={note.pageId}>
              {note.coverUrl ? (
                <img
                  src={note.coverUrl}
                  alt=""
                  draggable="false"
                  onError={(event) => {
                    event.currentTarget.style.visibility = "hidden";
                  }}
                />
              ) : null}
            </span>
          ))}
        </span>
      ) : null}
      {hasPhoto ? (
        <img
          src={coverNote.coverUrl ?? undefined}
          alt=""
          decoding="async"
          draggable="false"
          onError={() => setFailedUrl(coverNote.coverUrl ?? null)}
        />
      ) : (
        <span className="memory-text-excerpt">{first.excerpt || "记下这一程的风景与心情。"}</span>
      )}
      {stack ? (
        <span className="memory-stack-count">
          <Images size={12} aria-hidden="true" />
          {pages.length} 篇
        </span>
      ) : (first.photoMediaIds?.length ?? 0) > 1 ? (
        <span className="memory-photo-count">{first.photoMediaIds!.length} 张</span>
      ) : null}
    </span>
  );
}

export function AtlasMemoryWall({
  map,
  dataset,
  frame,
  regions,
  selectedRegionId,
  page,
  showCards,
  unassigned,
  unassignedLabel,
  onPageChange,
  onSelectRegion,
  onOpenPage,
  onOpenStack,
  onDrillRegion,
  onCoverPageIdsChange,
  onDisplayedCoverIdsChange,
  onHoverRegions,
  hoveredMapRegionId = null,
  memoriesReady = true,
  memoriesError,
  appMode = false,
  plan: planProp,
  viewVersion = 0
}: {
  map: LeafletMap | null;
  dataset: BoundaryDataset;
  frame: WallFrame;
  regions: MemoryRegion[];
  selectedRegionId: string | null;
  page: number;
  showCards: boolean;
  unassigned: MemoryNote[];
  unassignedLabel: string;
  onPageChange: (page: number) => void;
  onSelectRegion: (id: string) => void;
  onOpenPage?: (id: string) => void;
  onOpenStack: (id: string, trigger: HTMLElement) => void;
  onDrillRegion?: (id: string) => void;
  onCoverPageIdsChange?: (ids: string[]) => void;
  /** App 模式：墙上实际展示卡（placed）的封面 id，交适配器合并上报。 */
  onDisplayedCoverIdsChange?: (ids: string[]) => void;
  onHoverRegions: (ids: string[]) => void;
  hoveredMapRegionId?: string | null;
  memoriesReady?: boolean;
  memoriesError?: string;
  /** v2 App 适配：点卡片先选中地点（详情进下方面板），不直接打开笔记或浮层。 */
  appMode?: boolean;
  /** 适配器已算好的墙计划；传入时面板与墙共用同一分页，避免两份状态。 */
  plan?: ReturnType<typeof planMemoryWall>;
  /** 适配器视图适配完成后递增；墙据此用就绪投影重算图钉/连线。 */
  viewVersion?: number;
}) {
  const { width, height } = frame;
  const computedPlan = useMemo(
    () => planMemoryWall(regions, frame.slots.length, page),
    [regions, frame, page]
  );
  const plan = planProp ?? computedPlan;
  const anchors = useMemo(
    () =>
      new Map(
        dataset.features.flatMap((feature) => {
          const anchor = labelAnchor(feature.geometry);
          return anchor ? [[feature.regionId, anchor] as const] : [];
        })
      ),
    [dataset]
  );
  const [pins, setPins] = useState<Map<string, WallPoint>>(new Map());
  const [hovered, setHovered] = useState<string[]>([]);
  const regionById = useMemo(
    () => new Map(regions.map((region) => [region.regionId, region])),
    [regions]
  );
  useEffect(() => {
    if (!map) return;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const next = new Map<string, WallPoint>();
        for (const [id, anchor] of anchors) {
          const point = map.latLngToContainerPoint([anchor[1], anchor[0]]);
          if (Number.isFinite(point.x) && Number.isFinite(point.y))
            next.set(id, { x: frame.map.x + point.x, y: frame.map.y + point.y });
        }
        setPins(next);
      });
    };
    update();
    map.on("move zoom resize", update);
    // App 版式下容器随 flex/grid 布局滞后成形，Leaflet 不一定发 resize 事件
    // （内部尺寸未变时 invalidateSize 是无操作）——直接观察容器尺寸，杜绝
    // 用过期投影计算图钉/连线（复核：390×844 下 p-65 图钉曾因过期尺寸被裁掉）。
    const container = map.getContainer();
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => update()) : null;
    if (observer) observer.observe(container);
    return () => {
      cancelAnimationFrame(raf);
      map.off("move zoom resize", update);
      observer?.disconnect();
    };
  }, [map, anchors, frame, viewVersion]);
  const placed = useMemo(() => placeWallCards(plan.cards, frame, pins), [plan, frame, pins]);
  const notes = new Set(regions.flatMap((region) => region.pages.map((note) => note.pageId)));
  unassigned.forEach((note) => notes.add(note.pageId));
  /** 只有两篇真实笔记时给照片更多呼吸感；仍用原卡位与锚点，只做视觉放大。 */
  const largeCards = showCards && (notes.size === 2 || (frame.webPresentation && notes.size === 1)) && width >= 620;
  const largeCardScale = (slot: WallSlot) => {
    if (!largeCards) return 1;
    const room =
      slot.side === "left"
        ? slot.x
        : slot.side === "right"
          ? width - slot.x - frame.cardWidth
          : slot.side === "top"
            ? slot.y
            : height - slot.y - frame.cardHeight;
    const base = slot.side === "left" || slot.side === "right" ? frame.cardWidth : frame.cardHeight;
    return Math.min(1.18, Math.max(1, 1 + Math.max(0, room - 6) / base));
  };
  const displayedPlacements = useMemo(() => {
    if (!largeCards) return placed;
    const next = placed.map((item) => ({
      ...item,
      slot: { ...item.slot, pin: { ...item.slot.pin } }
    }));
    const groups = new Map<"left" | "right", (typeof next)[number][]>();
    for (const item of next) {
      if (item.slot.side !== "left" && item.slot.side !== "right") continue;
      const group = groups.get(item.slot.side) ?? [];
      group.push(item);
      groups.set(item.slot.side, group);
    }
    for (const group of groups.values()) {
      if (group.length !== 2) continue;
      group.sort((a, b) => a.slot.y - b.slot.y);
      const [a, b] = group;
      const aScale = largeCardScale(a.slot);
      const bScale = largeCardScale(b.slot);
      // Web以顶中钉子为缩放原点；原生保留原来的中心估算，避免改变既有App布局。
      const visualTop = (slot: WallSlot, scale: number) => frame.webPresentation
        ? slot.y + 5 * (1 - scale)
        : slot.y + frame.cardHeight / 2 - (scale * frame.cardHeight) / 2;
      const visualGap = visualTop(b.slot, bScale) - visualTop(a.slot, aScale) - aScale * frame.cardHeight;
      // 放大后的卡片仍按完整卡高保留一段独立呼吸区，避免日期贴住下一张照片。
      const minGap = frame.webPresentation ? 32 : frame.cardHeight + 32;
      if (visualGap >= minGap) continue;
      const delta = (minGap - visualGap) / 2;
      a.slot.y -= delta;
      a.slot.pin.y -= delta;
      b.slot.y += delta;
      b.slot.pin.y += delta;
      const top = Math.min(
        visualTop(a.slot, aScale),
        visualTop(b.slot, bScale)
      );
      const bottom = Math.max(
        visualTop(a.slot, aScale) + aScale * frame.cardHeight,
        visualTop(b.slot, bScale) + bScale * frame.cardHeight
      );
      const minTop = frame.cardArea.y + 6;
      const maxBottom = frame.cardArea.y + frame.cardArea.height - 6;
      const shift = top < minTop ? minTop - top : bottom > maxBottom ? maxBottom - bottom : 0;
      if (shift) {
        a.slot.y += shift;
        a.slot.pin.y += shift;
        b.slot.y += shift;
        b.slot.pin.y += shift;
      }
    }
    return next;
  }, [largeCards, placed, frame, width, height]);
  const coverIds = useMemo(
    () =>
      showCards
        ? [
            ...new Set(
              displayedPlacements.flatMap(({ card }) => {
                // 封面需求 = 展示中的前几篇 ∪ 卡片封面候选（第一个带照片的页）：
                // 首页无照片时仍能为地区封面按需生成缩略图。
                const coverNote = card.pages.find(note => (note.photoMediaIds?.length ?? 0) > 0);
                const shown = card.pages.slice(0, card.kind === "stack" ? 3 : 1);
                return coverNote ? [...shown, coverNote].map((note) => note.pageId) : shown.map((note) => note.pageId);
              })
            )
          ]
        : [],
    [displayedPlacements, showCards]
  );
  /**
   * 桌面：封面需求经 onCoverPageIdsChange 直接上报（原口径）。
   * App 模式（R1 返修）：墙上实际展示卡经 onDisplayedCoverIdsChange 交给
   * 适配器，与照片带可见卡、详情行合并后由适配器单一出口上报。
   */
  useEffect(() => {
    if (appMode) onDisplayedCoverIdsChange?.(coverIds);
    else onCoverPageIdsChange?.(coverIds);
  }, [appMode, coverIds, onCoverPageIdsChange, onDisplayedCoverIdsChange]);
  useEffect(() => {
    onHoverRegions(hovered);
  }, [hovered, onHoverRegions]);
  useEffect(() => () => onHoverRegions([]), [onHoverRegions]);
  const focusIds = hovered.length
    ? hovered
    : hoveredMapRegionId
      ? [hoveredMapRegionId]
      : selectedRegionId
        ? [selectedRegionId]
        : [];
  const related = (ids: string[]) => !focusIds.length || ids.some((id) => focusIds.includes(id));
  const selected = selectedRegionId
    ? dataset.regions.find((region) => region.regionId === selectedRegionId)
    : null;
  const selectedNoteCount = selected ? regionById.get(selected.regionId)?.pages.length ?? 0 : 0;
  const visiblePin = (p: WallPoint) =>
    p.x >= frame.map.x &&
    p.x <= frame.map.x + frame.map.width &&
    p.y >= frame.map.y &&
    p.y <= frame.map.y + frame.map.height;
  const pinLabels = useMemo(() => {
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const positions = new Map<string, { x: number; y: number; name: string; compact: boolean }>();
    const sorted = [...regions]
      .filter((region) => region.pages.length)
      .sort(
        (a, b) => Number(b.regionId === selectedRegionId) - Number(a.regionId === selectedRegionId)
      );
    for (const region of sorted) {
      const point = pins.get(region.regionId);
      if (!point) continue;
      const name = shortRegionName(region.name);
      // 暖纸签有左右内边距和 1px 边；宽度比旧纯文字多预留 10px，避免碰撞漏判。
      const w = name.length * 10 + 34;
      const offsets = [
        [12, -10],
        [-w - 8, -10],
        [-w / 2, 12],
        [-w / 2, -30],
        [12, 26],
        [-w - 8, 26],
        [12, -46]
      ];
      const offset = offsets.find(([x, y]) => {
        const box = { x: point.x + x, y: point.y + y, w, h: 19 };
        if (
          box.x < frame.map.x ||
          box.x + w > frame.map.x + frame.map.width ||
          box.y < frame.map.y ||
          box.y + box.h > frame.map.y + frame.map.height
        )
          return false;
        if (
          placed.some(
            (other) =>
              box.x < other.x + other.w + 3 &&
              box.x + box.w + 3 > other.x &&
              box.y < other.y + other.h + 3 &&
              box.y + box.h + 3 > other.y
          )
        )
          return false;
        placed.push(box);
        return true;
      });
      positions.set(region.regionId, {
        x: (offset?.[0] ?? 10) + 14,
        y: (offset?.[1] ?? 0) + 14,
        name,
        compact: !offset
      });
    }
    return positions;
  }, [regions, pins, selectedRegionId, frame]);
  const hoverProps = (ids: string[]) => ({
    onPointerEnter: () => setHovered(ids),
    onPointerLeave: () => setHovered([]),
    onFocus: () => setHovered(ids),
    onBlur: () => setHovered([])
  });

  return (
    <div
      className="atlas-memory-wall"
      data-large-cards={largeCards ? "true" : undefined}
      aria-label="图钉连线记忆地图"
      style={
        {
          "--wall-card-width": `${frame.cardWidth}px`,
          "--wall-card-height": `${frame.cardHeight}px`
        } as CSSProperties
      }
    >
      <svg className="memory-wall-threads" width={width} height={height} aria-hidden="true">
        {showCards
          ? displayedPlacements.flatMap(({ card, slot }) =>
              card.regionIds.map((id) => {
                const start = pins.get(id);
                if (!start || !visiblePin(start)) return null;
                const end = cardConnectionPoint(slot, frame.cardWidth, frame.webPresentation);
                const bend = Math.min(16, Math.hypot(end.x - start.x, end.y - start.y) * 0.06);
                return (
                  <path
                    key={`${card.id}:${id}`}
                    data-thread-card={card.id}
                    data-thread-region={id}
                    d={`M ${start.x} ${start.y} Q ${(start.x + end.x) / 2 + bend} ${(start.y + end.y) / 2 + bend} ${end.x} ${end.y}`}
                    className={`${related([id]) && related(card.regionIds) ? "is-related" : "is-muted"}${focusIds.includes(id) ? " is-emphasized" : ""}`}
                  />
                );
              })
            )
          : null}
      </svg>
      {showCards
        ? displayedPlacements.map(({ card, slot }, index) => {
            const first = card.pages[0];
            const names = card.regionIds
              .map((id) => regionById.get(id)?.name)
              .filter(Boolean)
              .join(" · ");
            const shortNames = card.regionIds
              .map((id) => regionById.get(id)?.name)
              .filter((name): name is string => Boolean(name))
              .map(shortRegionName)
              .join(" · ");
            const stack = card.kind === "stack";
            const selected = Boolean(selectedRegionId && card.regionIds.includes(selectedRegionId));
            const connection = cardConnectionPoint(slot, frame.cardWidth, frame.webPresentation);
            return (
              <button
                key={card.id}
                type="button"
                data-memory-card
                data-card-id={card.id}
                data-region-id={card.regionIds[0]}
                data-page-id={stack ? undefined : first.pageId}
                data-remaining-count={stack ? card.pages.length : undefined}
                className={`memory-wall-card atlas-memory-card${stack ? " is-stack" : ""}${selected ? " is-selected" : ""}`}
                style={
                  {
                    left: slot.x,
                    top: slot.y,
                    transformOrigin: `${connection.x - slot.x}px ${connection.y - slot.y}px`,
                    "--wall-tilt": frame.webPresentation ? "0deg" : `${(((index * 7) % 5) - 2) * 0.55}deg`,
                    "--pin-x": `${connection.x - slot.x}px`,
                    "--pin-y": `${connection.y - slot.y}px`,
                    "--wall-card-scale": largeCardScale(slot),
                    "--wall-pin-scale": 1 / largeCardScale(slot)
                  } as CSSProperties
                }
                aria-label={
                  stack
                    ? `${names}，剩余 ${card.pages.length} 篇，查看全部 ${regionById.get(card.regionIds[0])?.pages.length ?? card.pages.length} 篇笔记`
                    : `打开笔记：${first.title}`
                }
                aria-haspopup={stack && !appMode ? "dialog" : undefined}
                aria-expanded={stack && !appMode ? false : undefined}
                onClick={(event) => {
                  // v2 App 流程：点照片卡先选中地点，底部面板列出该地点笔记，再选阅读。
                  if (appMode) {
                    onSelectRegion(card.regionIds[0]);
                    return;
                  }
                  if (stack) onOpenStack(card.regionIds[0], event.currentTarget);
                  else onOpenPage?.(first.pageId);
                }}
                {...hoverProps(card.regionIds)}
              >
                <span className="memory-card-pin" aria-hidden="true" />
                <span className="memory-card-frame">
                  <span className="memory-card-stamp">
                    <MemoryCardVisual pages={card.pages} stack={stack} />
                    <strong className="memory-card-title">
                      {stack ? `${shortNames || names}的记忆` : first.title || "未命名笔记"}
                    </strong>
                    <span className="memory-card-caption">
                      {stack ? (
                        <>
                          <span className="memory-card-date">{formatStackDate(card.pages)}</span>
                          <span className="memory-card-place">{card.pages.length} 篇</span>
                        </>
                      ) : (
                        <>
                          <time className="memory-card-date" dateTime={first.capturedAt}>
                            {formatMemoryDate(first.capturedAt)}
                          </time>
                          <span className="memory-card-place">{shortNames}</span>
                        </>
                      )}
                    </span>
                  </span>
                </span>
              </button>
            );
          })
        : null}
      {regions
        .filter((region) => region.pages.length)
        .map((region) => {
          const point = pins.get(region.regionId);
          if (!point || !visiblePin(point)) return null;
          return (
            <button
              type="button"
              key={region.regionId}
              data-region-pin={region.regionId}
              data-note-count={region.pages.length}
              data-expanded-count={plan.expandedByRegion.get(region.regionId) ?? 0}
              className={`memory-region-pin${selectedRegionId === region.regionId ? " is-selected" : ""}${hovered.includes(region.regionId) || hoveredMapRegionId === region.regionId ? " is-hovered" : ""}${related([region.regionId]) ? "" : " is-muted"}`}
              style={{ left: point.x, top: point.y }}
              aria-label={`选择${region.name}，${region.pages.length} 篇笔记`}
              aria-pressed={selectedRegionId === region.regionId}
              onClick={() => onSelectRegion(region.regionId)}
              {...hoverProps([region.regionId])}
            >
              <span className="memory-pin-head" aria-hidden="true" />
              <span
                className={`memory-pin-label${pinLabels.get(region.regionId)?.compact ? " is-compact" : ""}`}
                style={{
                  left: pinLabels.get(region.regionId)?.x,
                  top: pinLabels.get(region.regionId)?.y
                }}
                title={region.name}
              >
                <span>{pinLabels.get(region.regionId)?.name ?? region.name}</span>
                <b>{region.pages.length}</b>
              </span>
            </button>
          );
        })}
      {/* v2 App 适配：桌面对接（地区操作/全部/未定位/分页）由下方 AtlasAppPanel 承接。 */}
      {appMode ? null : (
      <div
        className="memory-wall-dock"
        style={{
          left: frame.footer.x,
          top: frame.footer.y,
          width: frame.footer.width,
          height: frame.footer.height
        }}
      >
        {selected ? (
          <div
            className="memory-region-actions"
            role="group"
            aria-label={`${selected.name}的地区操作`}
            style={{ maxWidth: Math.min(frame.footer.width, 380) }}
          >
            <span className="memory-region-name" title={selected.name}>
              <MapPin size={14} aria-hidden="true" />
              <strong>{selected.name}</strong>
            </span>
            <button
              type="button"
              className="memory-region-notes"
              aria-label={`查看笔记 ${selectedNoteCount}`}
              title={selectedNoteCount ? `查看${selected.name}的笔记` : `${selected.name}暂无关联笔记`}
              onClick={(event) => onOpenStack(selected.regionId, event.currentTarget)}
              data-region-id={selected.regionId}
              data-card-id={`action:${selected.regionId}`}
              disabled={!selectedNoteCount}
            >
              <BookOpen size={14} aria-hidden="true" />
              <span>笔记</span>
              <b className="memory-region-count">{selectedNoteCount}</b>
            </button>
            {dataset.level !== "city" && onDrillRegion ? (
              <button
                type="button"
                className="memory-region-enter"
                onClick={() => onDrillRegion(selected.regionId)}
                aria-label={`进入${selected.name}`}
                title={`进入${selected.name}`}
              >
                进入该地区
                <ArrowRight size={14} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="memory-wall-footer">
          {memoriesError ? <span role="alert">{memoriesError}</span> : !memoriesReady ? <span>正在读取笔记…</span> : null}
          {memoriesReady && notes.size > 0 && !frame.slots.length ? (
            <button
              type="button"
              onClick={(event) => onOpenStack("all", event.currentTarget)}
              data-card-id="all"
              data-region-id="all"
            >
              查看全部笔记 {notes.size}
            </button>
          ) : null}
          {unassigned.length ? (
            <button
              type="button"
              onClick={(event) => onOpenStack("unassigned", event.currentTarget)}
              data-card-id="unassigned"
              data-region-id="unassigned"
            >
              {unassignedLabel} {unassigned.length}
            </button>
          ) : null}
          {showCards && frame.slots.length > 0 && plan.pageCount > 1 ? (
            <nav className="memory-wall-pagination" aria-label="记忆墙地区分页">
              <button
                type="button"
                aria-label="上一组地区"
                disabled={plan.page === 0}
                onClick={() => onPageChange(plan.page - 1)}
              >
                <ChevronLeft size={16} />
              </button>
              <span aria-live="polite">
                {plan.page + 1} / {plan.pageCount} 组 · {plan.active.length} 地区
              </span>
              <button
                type="button"
                aria-label="下一组地区"
                disabled={plan.page + 1 >= plan.pageCount}
                onClick={() => onPageChange(plan.page + 1)}
              >
                <ChevronRight size={16} />
              </button>
            </nav>
          ) : null}
        </div>
      </div>
      )}
    </div>
  );
}

/**
 * v2 App 适配面板：地图下方的照片带（窄短屏）+ 选中地点详情区。
 * 选中来自 selectedRegionId（地图/照片卡共同驱动）；收起只收本面板，
 * 不改变地图尺寸；同层选择/收起不引起地图跳动。全部/未定位/分页也在这里承接。
 */
export function AtlasAppPanel({
  band,
  level,
  regions,
  bandRegions,
  unassigned,
  unassignedLabel,
  selectedRegionId,
  selectionSignal,
  plan,
  memoriesReady,
  memoriesError,
  onSelectRegion,
  onDrillRegion,
  onOpenPage,
  onPageChange,
  onVisibleNoteIdsChange
}: {
  band: boolean;
  level: BoundaryDataset["level"];
  regions: MemoryRegion[];
  /** R1：照片带当前分页的地区切片——带卡封面需求只覆盖这一页。 */
  bandRegions: MemoryRegion[];
  unassigned: MemoryNote[];
  unassignedLabel: string;
  selectedRegionId: string | null;
  /** R3：每次选择递增的选择信号——同一地区收起后再次选择也能重新展开详情。 */
  selectionSignal: { regionId: string; seq: number };
  plan: ReturnType<typeof planMemoryWall>;
  memoriesReady: boolean;
  memoriesError?: string;
  onSelectRegion: (id: string) => void;
  onDrillRegion?: (id: string) => void;
  onOpenPage?: (id: string) => void;
  onPageChange?: (page: number) => void;
  /** R1：当前可见（band 可见卡 + 详情列出行）的笔记 id 上报，收起/滚出即释放。 */
  onVisibleNoteIdsChange?: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(true);
  /**
   * R2 返修：面板随 App↔desktop 断点切换会卸载重挂——重挂时恢复当前有效选中
   * 地区（跨断点选中保留），而不是回到概览。
   */
  const [detailId, setDetailId] = useState<string | null>(selectedRegionId);
  // R3：响应「地区 ID＋选择序号」——同一地区收起后再次选择（序号递增）也重新展开。
  const lastSignalSeqRef = useRef(selectionSignal.seq);
  // 地区变化（地图定位/选中另一地区）跟随展开；同一地区的重复选择由上方信号负责。
  useEffect(() => {
    if (!selectedRegionId) return;
    setDetailId(selectedRegionId);
    setOpen(true);
  }, [selectedRegionId]);
  useEffect(() => {
    if (selectionSignal.seq === lastSignalSeqRef.current) return;
    lastSignalSeqRef.current = selectionSignal.seq;
    if (!selectionSignal.regionId) return;
    setDetailId(selectionSignal.regionId);
    setOpen(true);
  }, [selectionSignal]);
  const regionById = useMemo(
    () => new Map(regions.map((region) => [region.regionId, region])),
    [regions]
  );
  const allPages = useMemo(
    () => [
      ...new Map(
        [...regions.flatMap((region) => region.pages), ...unassigned].map((page) => [
          page.pageId,
          page
        ])
      ).values()
    ],
    [regions, unassigned]
  );
  const detailRegion = detailId ? regionById.get(detailId) : undefined;
  const detailPages =
    detailId === "all"
      ? allPages
      : detailId === "unassigned"
        ? unassigned
        : detailRegion
          ? detailRegion.pages
          : [];
  const detailName =
    detailId === "all"
      ? "本视图全部笔记"
      : detailId === "unassigned"
        ? unassignedLabel
        : (detailRegion?.name ?? null);
  const handleSelect = (id: string) => {
    // 选中语义走既有 onSelectRegion（父层映射）；信号由包装器统一递增。
    onSelectRegion(id);
  };
  /**
   * R1：可见封面需求 = 照片带可见卡（首图）+ 详情当前列出且可见的笔记行；
   * 收起/滚出/概览（glyph 行无图）即释放，不预读全部地区或全部笔记。
   *
   * R1 返修二轮：按 **DOM 元素** 记录可见归属（同页两实例——照片带卡与详情行
   * ——任一实例滚出不再清掉整页需求），派生去重后的 pageId 集合；回调按元素
   * 更新、Set/Map 幂等，重复进入/离开与批量回调顺序无关。观察器重绑（依赖
   * 变化）与组件销毁分离：重绑只断开，销毁时若本实例仍有需求则向父级释放；
   * 已排队的旧代数回调与卸载后迟到的回调一律丢弃，不清新实例需求。
   */
  const visibleRef = useRef<Map<Element, string>>(new Map());
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const bandBoxRef = useRef<HTMLDivElement | null>(null);
  const listBoxRef = useRef<HTMLDivElement | null>(null);
  const lastReportSignatureRef = useRef("");
  /** 本实例存活守卫：卸载置否，迟到的旧回调（含事件队列残留）一律丢弃。 */
  const aliveRef = useRef(true);
  /** 观察器代数：重绑后旧代数回调不再生效。 */
  const observerGenerationRef = useRef(0);
  /** 释放出口经 ref 读取：卸载 effect 空依赖，prop 引用漂移不会反复触发释放。 */
  const releaseTargetRef = useRef(onVisibleNoteIdsChange);
  releaseTargetRef.current = onVisibleNoteIdsChange;
  useEffect(() => {
    // StrictMode 的 mount→cleanup→remount 复用同一实例 ref：重挂必须复活守卫，
    // 否则后续所有观察者回调都被当迟到丢弃。
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      // 从非空需求卸载：释放本实例拥有的需求来源（重绑的 cleanup 不走这里）。
      lastReportSignatureRef.current = "";
      releaseTargetRef.current?.([]);
    };
  }, []);
  useEffect(() => {
    // 详情切换/收起：旧列表的行卸载，可见记录重置（band 卡由 IO 重绑后的
    // 初始回调恢复；stub 宿主由上报效应按 rendered 集过滤兜底）。
    visibleRef.current.clear();
    setVisibleIds([]);
  }, [detailId, open]);
  useEffect(() => {
    const generation = ++observerGenerationRef.current;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        // 重绑后旧代数回调、卸载后迟到的回调：一律丢弃，不清当前可见记录。
        if (!aliveRef.current || generation !== observerGenerationRef.current) return;
        let changed = false;
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.coverPage;
          if (!id) continue;
          if (entry.isIntersecting) {
            if (visibleRef.current.get(entry.target) !== id) {
              visibleRef.current.set(entry.target, id);
              changed = true;
            }
          } else if (visibleRef.current.get(entry.target) === id) {
            visibleRef.current.delete(entry.target);
            changed = true;
          }
        }
        if (changed) setVisibleIds([...new Set(visibleRef.current.values())]);
      },
      { threshold: 0.35 }
    );
    const targets = new Set<Element>();
    for (const root of [bandBoxRef.current, listBoxRef.current]) {
      if (!root) continue;
      for (const element of root.querySelectorAll<HTMLElement>("[data-cover-page]")) {
        targets.add(element);
        observer.observe(element);
      }
    }
    // 重绑（布局切换/分页/详情变化）会换掉一批 DOM：不在本轮观察目标里的
    // 旧元素已不可见，必须从可见记录剔除，否则已移除的 DOM 仍持有需求。
    let staleReleased = false;
    for (const element of [...visibleRef.current.keys()]) {
      if (!targets.has(element)) {
        visibleRef.current.delete(element);
        staleReleased = true;
      }
    }
    if (staleReleased) setVisibleIds([...new Set(visibleRef.current.values())]);
    return () => observer.disconnect();
  }, [band, bandRegions, open, detailId, detailPages]);
  useEffect(() => {
    if (!onVisibleNoteIdsChange) return;
    // 只上报当前真实渲染的行（可见集合里可能残留已卸载行的 id）；
    // 签名去重——集合未变化不再触发回调，避免不稳定数组依赖造成上报循环。
    const rendered = new Set<string>();
    if (band) for (const region of bandRegions) {
      const coverNote = region.pages.find(note => (note.photoMediaIds?.length ?? 0) > 0) ?? region.pages[0];
      if (coverNote) rendered.add(coverNote.pageId);
    }
    if (open && detailId) for (const page of detailPages) rendered.add(page.pageId);
    const ids = visibleIds.filter((id) => rendered.has(id)).sort();
    const signature = ids.join("|");
    if (signature === lastReportSignatureRef.current) return;
    lastReportSignatureRef.current = signature;
    onVisibleNoteIdsChange(ids);
  }, [visibleIds, band, bandRegions, open, detailId, detailPages, onVisibleNoteIdsChange]);
  return (
    <div className="atlas-app-panel" data-app-band={band ? "true" : undefined}>
      {band && bandRegions.length > 0 ? (
        <div className="atlas-app-band" aria-label="地点照片卡带" ref={bandBoxRef}>
          {bandRegions.map((region) => {
            const first = region.pages[0];
            /** 照片带封面同地区卡语义：第一个带照片的页（需求与显示一致）。 */
            const coverNote = region.pages.find(note => (note.photoMediaIds?.length ?? 0) > 0) ?? first;
            const selected = selectedRegionId === region.regionId;
            return (
              <button
                key={region.regionId}
                type="button"
                data-cover-page={coverNote.pageId}
                className={`atlas-app-band-card${selected ? " is-selected" : ""}`}
                aria-pressed={selected}
                aria-label={`选择${region.name}，${region.pages.length} 篇笔记`}
                onClick={() => handleSelect(region.regionId)}
              >
                  <span className="atlas-app-band-photo">
                    {coverNote.coverUrl ? (
                      <img src={coverNote.coverUrl} alt="" loading="lazy" draggable={false} />
                    ) : (
                      <span className="atlas-app-band-fallback" aria-hidden="true" />
                    )}
                  </span>
                  <span className="atlas-app-band-copy">
                    <strong title={region.name}>{region.name}</strong>
                    <small>{region.pages.length} 篇</small>
                    <time>{formatMemoryDate(first.capturedAt)}</time>
                  </span>
                </button>
              );
            })}
        </div>
      ) : null}
      <section
        className={`atlas-app-details${open && detailId ? " has-selection" : ""}`}
        aria-label={open && detailName ? `${detailName}的笔记` : "地点概览"}
      >
        <header className="atlas-app-details-head">
          {open && detailName ? (
            <>
              <span className="atlas-app-place">
                <strong title={detailName}>{detailName}</strong>
                <small>{detailPages.length} 篇</small>
              </span>
              <button
                type="button"
                className="atlas-app-collapse"
                onClick={() => setOpen(false)}
                aria-label="收起地点笔记"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </>
          ) : (
            <span className="atlas-app-place">
              <strong>旅途足迹</strong>
              <small>先选地点，再读笔记</small>
            </span>
          )}
        </header>
        {memoriesError ? (
          <p className="atlas-app-notice" role="alert">
            {memoriesError}
          </p>
        ) : !memoriesReady ? (
          <p className="atlas-app-notice">正在读取笔记…</p>
        ) : null}
        <div
          className="atlas-app-list"
          role="region"
          aria-label={open && detailName ? `${detailName}的笔记列表` : "旅途地点列表"}
          tabIndex={0}
          ref={listBoxRef}
        >
          {open && detailName ? (
            detailPages.map((note) => (
              <button
                key={note.pageId}
                type="button"
                data-cover-page={note.pageId}
                className="atlas-app-note-row"
                onClick={() => onOpenPage?.(note.pageId)}
                aria-label={`阅读：${note.title}`}
              >
                <span className="atlas-app-note-thumb">
                  {note.coverUrl ? (
                    <img src={note.coverUrl} alt="" loading="lazy" draggable={false} />
                  ) : (
                    <span className="atlas-app-band-fallback" aria-hidden="true" />
                  )}
                </span>
                <span className="atlas-app-note-copy">
                  <strong title={note.title}>{note.title || "未命名笔记"}</strong>
                  <small>
                    <span className="atlas-app-note-place" title={note.notebookTitle}>
                      {note.notebookTitle}
                    </span>
                    <time>{formatMemoryDate(note.capturedAt)}</time>
                  </small>
                </span>
                <ArrowRight size={15} aria-hidden="true" />
              </button>
            ))
          ) : (
            <>
              {allPages.length > 0 ? (
                <button
                  type="button"
                  className="atlas-app-note-row"
                  aria-label={`全部笔记 ${allPages.length}`}
                  onClick={() => {
                    setDetailId("all");
                    setOpen(true);
                  }}
                >
                  <span className="atlas-app-note-thumb is-glyph" aria-hidden="true">
                    <Images size={15} />
                  </span>
                  <span className="atlas-app-note-copy">
                    <strong>全部笔记</strong>
                    <small>{allPages.length} 篇</small>
                  </span>
                  <ArrowRight size={15} aria-hidden="true" />
                </button>
              ) : null}
              {regions
                .filter((region) => region.pages.length)
                .map((region) => (
                  <button
                    key={region.regionId}
                    type="button"
                    className="atlas-app-note-row"
                    onClick={() => handleSelect(region.regionId)}
                    aria-pressed={selectedRegionId === region.regionId}
                  >
                    <span className="atlas-app-note-thumb is-glyph" aria-hidden="true">
                      <MapPin size={15} />
                    </span>
                    <span className="atlas-app-note-copy">
                      <strong title={region.name}>{region.name}</strong>
                      <small>{region.pages.length} 篇</small>
                    </span>
                    <ArrowRight size={15} aria-hidden="true" />
                  </button>
                ))}
              {unassigned.length ? (
                <button
                  type="button"
                  className="atlas-app-note-row"
                  onClick={() => {
                    setDetailId("unassigned");
                    setOpen(true);
                  }}
                >
                  <span className="atlas-app-note-thumb is-glyph" aria-hidden="true">
                    <BookOpen size={15} />
                  </span>
                  <span className="atlas-app-note-copy">
                    <strong>{unassignedLabel}</strong>
                    <small>{unassigned.length} 篇</small>
                  </span>
                  <ArrowRight size={15} aria-hidden="true" />
                </button>
              ) : null}
              {level !== "city" && selectedRegionId && onDrillRegion ? (
                <button
                  type="button"
                  className="atlas-app-note-row"
                  onClick={() => onDrillRegion(selectedRegionId)}
                >
                  <span className="atlas-app-note-thumb is-glyph" aria-hidden="true">
                    <ArrowRight size={15} />
                  </span>
                  <span className="atlas-app-note-copy">
                    <strong>
                      进入
                      {regionById.get(selectedRegionId)?.name ?? "该地区"}
                    </strong>
                    <small>查看下一级概览</small>
                  </span>
                  <ArrowRight size={15} aria-hidden="true" />
                </button>
              ) : null}
              {!allPages.length ? (
                <p className="atlas-app-notice">这个视图还没有关联笔记。</p>
              ) : null}
            </>
          )}
        </div>
        {plan.pageCount > 1 ? (
          <nav className="atlas-app-pagination" aria-label="记忆墙地区分页">
            <button
              type="button"
              aria-label="上一组地区"
              disabled={plan.page === 0}
              onClick={() => {
                setDetailId(null);
                setOpen(true);
                onPageChange?.(plan.page - 1);
              }}
            >
              <ChevronLeft size={15} />
            </button>
            <span aria-live="polite">
              {plan.page + 1} / {plan.pageCount} 组
            </span>
            <button
              type="button"
              aria-label="下一组地区"
              disabled={plan.page + 1 >= plan.pageCount}
              onClick={() => {
                setDetailId(null);
                setOpen(true);
                onPageChange?.(plan.page + 1);
              }}
            >
              <ChevronRight size={15} />
            </button>
          </nav>
        ) : null}
      </section>
    </div>
  );
}
