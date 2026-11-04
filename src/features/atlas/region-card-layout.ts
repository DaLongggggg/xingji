/** 图钉记忆墙的纯展示规则：容量、共享篇、剩余叠卡与固定卡位。 */
import { atlasFitZoom } from "./atlas-zoom";

export type MemoryNote = {
  pageId: string;
  title: string;
  capturedAt: string;
  notebookTitle: string;
  excerpt?: string;
  photoMediaIds?: string[];
  coverUrl?: string | null;
  /** 已确认照片 GPS 经既有坐标转换后的展示点；不持久化县级归属。 */
  points?: { lng: number; lat: number }[];
};
export type MemoryRegion = { regionId: string; name: string; pages: MemoryNote[] };
export type WallCard = {
  id: string;
  kind: "note" | "stack";
  regionIds: string[];
  pages: MemoryNote[];
};
export type WallPoint = { x: number; y: number };
export type WallRect = WallPoint & { width: number; height: number };
export type WallSlot = WallPoint & { pin: WallPoint; side: "top" | "bottom" | "left" | "right" };

/** 完整行政视图与港澳联合居中；projectedExtent 为 Leaflet 0 级像素尺寸，卡位不随笔记集合变化。 */
export function memoryWallFrame(
  width: number,
  height: number,
  aspect = 1.4,
  hasHarbor = false,
  projectedExtent?: { width: number; height: number },
  options?: { app?: boolean; band?: boolean; web?: boolean }
) {
  // App 变体（v2 移动适配）：卡片 116px、地图按真实投影比例在舞台内等比居中，
  // 底部保留 52px 钻层/分页独立触控行；band（窄短屏）时卡片全部进照片带，
  // 槽位为空；普通竖屏在舞台两角放两个平面卡位（设计百分比位的等价实现）。
  if (options?.app) {
    const cardWidth = 116;
    const cardHeight = 104;
    const gap = 14;
    const margin = 14;
    const footerHeight = 52;
    const cardArea = {
      x: margin,
      y: 4,
      width: Math.max(24, width - margin * 2),
      height: Math.max(24, height - 4 - footerHeight - 6)
    };
    const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1.4;
    const mapWidth = Math.min(cardArea.width, cardArea.height * ratio);
    const map = {
      x: cardArea.x + (cardArea.width - mapWidth) / 2,
      y: cardArea.y + (cardArea.height - mapWidth / ratio) / 2,
      width: mapWidth,
      height: mapWidth / ratio
    };
    // band：卡片全部进地图下方的照片带，平面上不留卡位（图钉与选中标记仍在）。
    const slots: WallSlot[] = [];
    if (!options.band) {
      // 普通竖屏：两角卡位压在舞台边缘（不遮面包屑与底部钻层），连线端点在卡顶中点。
      const leftX = cardArea.x + 6;
      const rightX = cardArea.x + cardArea.width - cardWidth - 6;
      const topY = cardArea.y + Math.max(6, (cardArea.height - cardHeight) * 0.18);
      const bottomY = cardArea.y + (cardArea.height - cardHeight) * 0.66;
      const makeSlot = (x: number, y: number, side: "left" | "right"): WallSlot => ({
        x,
        y,
        side,
        pin: { x: x + cardWidth / 2, y }
      });
      slots.push(makeSlot(leftX, topY, "left"));
      slots.push(makeSlot(rightX, bottomY, "right"));
    }
    return {
      width,
      height,
      webPresentation: options?.web === true,
      cardWidth,
      cardHeight,
      map,
      slots,
      harbor: null,
      cardArea,
      footer: {
        x: 14,
        y: height - footerHeight,
        width: Math.max(24, width - 28),
        height: footerHeight
      }
    };
  }
  // 极小窗口沿用旧规格作为兜底：避免 96px 卡片刚好挤进 320px 高度，
  // 反而拿掉“完整列表”入口并压缩地图。
  const tightCard = width < 360 || height < 600;
  // Web 相纸卡需要可读的照片/标题/日期，尺寸与卡位共同计算；原生旧路径不变。
  const webPresentation = options?.web === true;
  const cardWidth = webPresentation ? (width >= 1000 ? 160 : 144) : tightCard ? 96 : 84,
    // 高度完整包含照片、两行标题与元信息，不通过CSS单独放大占用尺寸。
    cardHeight = webPresentation ? (width >= 1000 ? 192 : 180) : tightCard ? 128 : 116;
  const gap = 18,
    margin = 20;
  const header = width < 620 ? 80 : 72;
  const footerHeight = width < 620 && height >= 460 ? 112 : 56;
  const cardArea = {
    x: margin,
    y: header + 8,
    width: Math.max(24, width - margin * 2),
    height: Math.max(24, height - header - footerHeight - 16)
  };
  const mapArea = { ...cardArea };
  const sideSpace = cardWidth + gap,
    rowSpace = cardHeight + gap;
  let harborSide: "right" | "bottom" = "right";
  if (width >= 620 && cardArea.width >= sideSpace * 2 + 100 && cardArea.height >= cardHeight) {
    mapArea.x += sideSpace;
    mapArea.width -= sideSpace + (hasHarbor ? 148 + gap : sideSpace);
  } else if (cardArea.height >= rowSpace * 2 + 120) {
    mapArea.y += rowSpace;
    mapArea.height -= rowSpace * 2;
    harborSide = "bottom";
  } else if (cardArea.height >= rowSpace + 120) {
    // 中等高度的窄屏只留一条外围卡带，优先保住地图宽度。
    mapArea.height -= rowSpace;
    if (!hasHarbor) mapArea.y += rowSpace;
    harborSide = "bottom";
  } else if (hasHarbor && cardArea.width >= 148 + gap + 60) {
    mapArea.width -= 148 + gap;
  } else if (cardArea.height >= cardHeight && cardArea.width >= sideSpace + 80) {
    mapArea.x += sideSpace;
    mapArea.width -= sideSpace;
  }
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1.4;
  const mapWidth = Math.min(mapArea.width, mapArea.height * ratio);
  const map = {
    x: mapArea.x + (mapArea.width - mapWidth) / 2,
    y: mapArea.y + (mapArea.height - mapWidth / ratio) / 2,
    width: mapWidth,
    height: mapWidth / ratio
  };
  const inlineHarbor = width >= 620 && map.width >= 600 && map.height >= 400;
  // 桌面局部图略放大，右缘锚定、底边按钮不动，只向左上生长，避免挤压卡位。
  const inlineHarborWidth = 172;
  const inlineHarborHeight = 190;
  // Web紧凑图的选项在镜片下方，frame必须包含84px镜片和44px操作行。
  const compactHarborHeight = webPresentation ? 132 : 104;
  const harborHeight = Math.min(cardArea.height, inlineHarbor ? inlineHarborHeight : compactHarborHeight);
  const harbor = hasHarbor
    ? {
        // 全国轮廓右下的海域空白；固定行政比例，不依据笔记或选区挪动。
        x: inlineHarbor
          ? map.x + map.width * 0.8 - (inlineHarborWidth - 148)
          : harborSide === "right" ? map.x + map.width + gap : cardArea.x + cardArea.width - 148,
        y: inlineHarbor
          ? map.y + map.height - harborHeight
          : harborSide === "right"
            ? cardArea.y + cardArea.height - harborHeight
            : map.y + map.height + gap,
        width: inlineHarbor ? inlineHarborWidth : 148,
        height: harborHeight
      }
    : null;
  if (harbor) {
    // 联合完整轮廓与小图居中；不把 Leaflet 适配留白、笔记卡或工具栏当作地图内容。
    const contentBounds = () => {
      const scale = projectedExtent
        ? 2 ** atlasFitZoom(
            projectedExtent.width, projectedExtent.height, Math.round(map.width), Math.round(map.height)
          )
        : 1;
      const width = projectedExtent ? projectedExtent.width * scale : map.width;
      const height = projectedExtent ? projectedExtent.height * scale : map.height;
      return {
        x: map.x + (Math.round(map.width) - width) / 2,
        y: map.y + (Math.round(map.height) - height) / 2,
        width,
        height
      };
    };
    let content = contentBounds();
    let left = Math.min(content.x, harbor.x);
    let right = Math.max(content.x + content.width, harbor.x + harbor.width);
    const bottomMapHeight = height - footerHeight * 2 - compactHarborHeight - gap;
    if (
      width >= 620 && bottomMapHeight >= 120 &&
      map.x + width / 2 - (left + right) / 2 < cardArea.x + sideSpace
    ) {
      // 工作区缩窄时，右置小图的联合平移会挤掉整列左卡位；改为下置紧凑图。
      // 先留足垂直空间，沿实际轮廓右端错开同一间距，避免宽侧带拉偏地图。
      map.height = Math.min(map.height, bottomMapHeight);
      map.width = map.height * ratio;
      content = contentBounds();
      harbor.height = compactHarborHeight;
      harbor.x = content.x + Math.max(0, content.width - harbor.width) + gap;
      harbor.y = content.y + content.height + gap;
      left = Math.min(content.x, harbor.x);
      right = Math.max(content.x + content.width, harbor.x + harbor.width);
    }
    if (webPresentation && width >= 620 && content.width >= 500 && content.height >= 180) {
      // 轮廓足够大时收进东南海域；小图保留分离位置，避免圆镜遮住台湾。
      // 实际占用仍参与联合居中和卡位排除。
      harbor.x = Math.min(harbor.x, content.x + content.width - harbor.width) + 12;
      harbor.y = Math.min(harbor.y, content.y + content.height - harbor.height / 2);
      left = Math.min(content.x, harbor.x);
      right = Math.max(content.x + content.width, harbor.x + harbor.width);
    }
    const top = Math.min(content.y, harbor.y);
    const bottom = Math.max(content.y + content.height, harbor.y + harbor.height);
    const dx = width / 2 - (left + right) / 2;
    const dy = height / 2 - (top + bottom) / 2;
    map.x += dx;
    map.y += dy;
    harbor.x += dx;
    harbor.y += dy;
  }
  const slots: WallSlot[] = [];
  const addRow = (y: number, side: "top" | "bottom") => {
    const row = width < 620 ? cardArea : map;
    const rowWidth = side === "bottom" && harbor ? harbor.x - gap - row.x : row.width;
    const count = Math.floor((rowWidth + gap) / (cardWidth + gap));
    const start = row.x + (rowWidth - count * cardWidth - (count - 1) * gap) / 2;
    for (let i = 0; i < count; i++) {
      const x = start + i * (cardWidth + gap);
      slots.push({
        x,
        y,
        side,
        pin: { x: x + cardWidth / 2, y: side === "top" ? y + cardHeight : y }
      });
    }
  };
  if (map.y - cardArea.y >= rowSpace - 0.01) addRow(map.y - rowSpace, "top");
  if (cardArea.y + cardArea.height - map.y - map.height >= rowSpace - 0.01)
    addRow(map.y + map.height + gap, "bottom");
  for (const side of ["left", "right"] as const) {
    const preferredX = side === "left" ? map.x - sideSpace : map.x + map.width + gap;
    // 联合港澳居中可能只剩小于18px的间距。Web相纸能完整放下就保留这一列，
    // 仍不允许进入地图矩形；原生继续使用原有外围间距与过滤规则。
    const x = webPresentation
      ? side === "left" ? Math.max(cardArea.x, preferredX) : Math.min(cardArea.x + cardArea.width - cardWidth, preferredX)
      : preferredX;
    if (webPresentation && (side === "left" ? x + cardWidth > map.x : x < map.x + map.width)) continue;
    if (x < cardArea.x - 0.01 || x + cardWidth > cardArea.x + cardArea.width + 0.01) continue;
    const count = Math.floor((cardArea.height + gap) / (cardHeight + gap));
    const start = cardArea.y + (cardArea.height - count * cardHeight - (count - 1) * gap) / 2;
    for (let i = 0; i < count; i++) {
      const y = start + i * (cardHeight + gap);
      slots.push({
        x,
        y,
        side,
        pin: { x: side === "left" ? x + cardWidth : x, y: y + cardHeight / 2 }
      });
    }
  }
  return {
    width,
    height,
    webPresentation,
    cardWidth,
    cardHeight,
    map,
    slots: harbor
      ? slots.filter(
          (slot) =>
            slot.x + cardWidth + gap <= harbor.x ||
            slot.x >= harbor.x + harbor.width + gap ||
            slot.y + cardHeight + gap <= harbor.y ||
            slot.y >= harbor.y + harbor.height + gap
        )
      : slots,
    harbor,
    cardArea,
    footer: {
      x: 14,
      y: height - footerHeight + 4,
      width: Math.max(24, width - 28),
      height: footerHeight - 8
    }
  };
}
export type WallFrame = ReturnType<typeof memoryWallFrame>;

/** 共享普通卡计入所有相关图钉；每个叠卡只包含尚未展开的篇 ID。 */
export function planMemoryWall(input: MemoryRegion[], capacity: number, requestedPage = 0) {
  const regions = input
    .map((region) => ({
      ...region,
      pages: [...new Map(region.pages.map((page) => [page.pageId, page])).values()]
    }))
    .filter((region) => region.pages.length);
  const size = Math.max(1, Math.floor(capacity));
  const pageCount = Math.max(1, Math.ceil(regions.length / size));
  const page = Math.max(0, Math.min(pageCount - 1, requestedPage));
  const active = regions.slice(page * size, (page + 1) * size);
  // 全墙容量负责缩容；每地区只保留最高五位置的硬边界，避免共享卡释放的空间闲置。
  const budgets = new Map(
    active.map((region) => [region.regionId, Math.min(5, region.pages.length)])
  );
  const selected = new Map<string, MemoryNote>();
  const memberships = new Map<string, string[]>();
  for (const region of regions)
    for (const note of region.pages) {
      memberships.set(note.pageId, [...(memberships.get(note.pageId) ?? []), region.regionId]);
    }
  const canAdd = (note: MemoryNote) => {
    if (selected.has(note.pageId)) return false;
    const expanded = new Set([...selected.keys(), note.pageId]);
    let stacks = 0;
    for (const region of regions) {
      const count = region.pages.filter((item) => expanded.has(item.pageId)).length;
      const remaining = region.pages.length > count;
      if (budgets.has(region.regionId)) {
        if (count + Number(remaining) > budgets.get(region.regionId)!) return false;
        if (remaining) stacks++;
      } else if (count > 5) return false;
    }
    return expanded.size + stacks <= size;
  };
  // ponytail: 当前层至多行政区数量×5个卡位，固定轮询已足够；不引入力导向或优化库。
  for (let round = 0; capacity > 0 && round < 5; round++)
    for (const region of active) {
      const next = region.pages.find(canAdd);
      if (next) selected.set(next.pageId, next);
    }
  const cards: WallCard[] = [...selected.values()].map((note) => ({
    id: `note:${note.pageId}`,
    kind: "note",
    regionIds: memberships.get(note.pageId)!,
    pages: [note]
  }));
  const remainingByRegion = new Map<string, MemoryNote[]>();
  const expandedByRegion = new Map<string, number>();
  for (const region of regions) {
    const remaining = region.pages.filter((note) => !selected.has(note.pageId));
    remainingByRegion.set(region.regionId, remaining);
    expandedByRegion.set(region.regionId, region.pages.length - remaining.length);
    if (budgets.has(region.regionId) && remaining.length) {
      cards.push({
        id: `stack:${region.regionId}`,
        kind: "stack",
        regionIds: [region.regionId],
        pages: remaining
      });
    }
  }
  return {
    cards: capacity > 0 ? cards : [],
    page,
    pageCount,
    regions,
    active,
    expandedByRegion,
    remainingByRegion,
    budgets
  };
}

/** 按完整行政视图的方位选择外围卡位，再交换减少长线；不含悬停/选中状态。 */
export function placeWallCards(
  cards: WallCard[],
  frame: WallFrame,
  pins: ReadonlyMap<string, WallPoint>
) {
  const points = [...pins.values()];
  const center = {
    x: points.reduce((sum, p) => sum + p.x, 0) / Math.max(1, points.length),
    y: points.reduce((sum, p) => sum + p.y, 0) / Math.max(1, points.length)
  };
  const anchor = (card: WallCard) => {
    const linked = card.regionIds.flatMap((id) => (pins.has(id) ? [pins.get(id)!] : []));
    return {
      x: linked.reduce((sum, p) => sum + p.x, 0) / Math.max(1, linked.length),
      y: linked.reduce((sum, p) => sum + p.y, 0) / Math.max(1, linked.length)
    };
  };
  const distance = (card: WallCard, slot: WallSlot) => {
    const point = anchor(card),
      dx = point.x - center.x,
      dy = point.y - center.y;
    const alignment =
      slot.side === "left"
        ? -dx / frame.map.width
        : slot.side === "right"
          ? dx / frame.map.width
          : slot.side === "top"
            ? -dy / frame.map.height
            : dy / frame.map.height;
    return (
      Math.hypot(point.x - slot.pin.x, point.y - slot.pin.y) +
      (alignment < -0.025 ? Math.min(frame.map.width, frame.map.height) * 0.65 : 0)
    );
  };
  // Web双篇留出两侧的呼吸空间；只挑已有外围卡位，不改地图视角或原生分配。
  const pairColumns = frame.webPresentation && cards.length === 2 && cards.every(card => card.kind === "note")
    ? [frame.slots.filter(slot => slot.side === "left"), frame.slots.filter(slot => slot.side === "right")]
    : null;
  const pair = pairColumns?.every(column => column.length) ? (() => {
    const nearest = (card: WallCard, slots: WallSlot[]) =>
      [...slots].sort((a, b) => distance(card, a) - distance(card, b))[0];
    const candidates = [[0, 1], [1, 0]].map(([left, right]) => {
      const leftSlot = nearest(cards[left], pairColumns[0]);
      const rightSlot = nearest(cards[right], pairColumns[1]);
      return {
        cost: distance(cards[left], leftSlot) + distance(cards[right], rightSlot),
        slots: left === 0 ? [leftSlot, rightSlot] : [rightSlot, leftSlot]
      };
    });
    return candidates.sort((a, b) => a.cost - b.cost)[0].slots;
  })() : null;
  const free = new Set(frame.slots.map((_, index) => index));
  const placed = pair ? cards.map((card, index) => ({ card, slot: pair[index] })) : cards
    .map((card) => {
      const index = [...free].sort(
        (a, b) => distance(card, frame.slots[a]) - distance(card, frame.slots[b]) || a - b
      )[0];
      free.delete(index);
      return { card, slot: frame.slots[index] };
    })
    .filter((item) => item.slot);
  // ponytail: 行政层和屏幕卡位都有上限，三轮固定交换足够，不引入布局求解器。
  for (let pass = 0; pass < 3; pass++)
    for (let a = 0; a < placed.length; a++)
      for (let b = a + 1; b < placed.length; b++) {
        const left = placed[a],
          right = placed[b];
        if (
          distance(left.card, right.slot) + distance(right.card, left.slot) + 1 <
          distance(left.card, left.slot) + distance(right.card, right.slot)
        )
          [left.slot, right.slot] = [right.slot, left.slot];
      }
  return placed;
}
