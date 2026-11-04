"use client";

import { atlasBoundaryExtent, atlasFitZoom } from "./atlas-zoom";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GeoJSON as LeafletGeoJSON, ImageOverlay, Map as LeafletMap, Path } from "leaflet";
import type { BoundaryDataset, BoundaryFeature, BoundaryRegionSummary } from "./boundary-contract";
import { labelAnchor, placeRegionLabels } from "./region-label-layout";
import { ArrowRight } from "lucide-react";
import { memoryWallFrame, planMemoryWall, type MemoryRegion, type MemoryNote } from "./region-card-layout";
import { AtlasAppPanel, AtlasMemoryWall } from "./atlas-memory-wall";
import { buildHarborMagnifier, HarborMagnifier } from "./harbor-magnifier";
import { resolveRegionIdentity, type RegionPalette, type RegionPattern } from "./region-identity";
import { regionEmblemHtml, regionEmblemSize } from "./region-emblem";
import { renderTerrainImage } from "./terrain-layer";
import {
  readTerrainCache,
  shareTerrainRender,
  terrainCacheKey,
  writeTerrainCache
} from "./terrain-cache";
import { DEFAULT_ATLAS_MAP_STYLE, type AtlasMapStyle } from "./map-style";

type LeafletApi = typeof import("leaflet");

/** 稳定空数组：默认参数若每次渲染新建数组，会把下游 memo/effect 的依赖打穿。 */
const EMPTY_MEMORY_PAGES: MemoryNote[] = [];

export type LeafletRegionAdapterProps = {
  dataset: BoundaryDataset;
  selectedRegionId: string | null;
  /** 只读摘要（可为未知篇数）；适配器不改数据。 */
  summaries?: Record<string, BoundaryRegionSummary>;
  /**
   * 有笔记本关联的**来源** regionId 集合（014-C）。适配器只按它区分明暗，
   * 0 篇保持暗色；选中/悬停只改描边，不覆盖填充（016）。
   */
  highlightedRegionIds?: string[];
  /**
   * 应用 RegionId → 已关联篇数（真实 0 为 0，缺省表示未知）。
   * 只有 `> 0` 才用“有笔记本”的亮色填充；0 与未知都保持暗色，不用假高亮。
   */
  pageCountByRegionId?: ReadonlyMap<string, number>;
  /** 省份视图：该省 RegionId 的省级关联也让省份本身按“有笔记本”着色。 */
  provinceRegionId?: string | null;
  /** 地区名称（016）：仅在悬停对应面时显示，避免地图常驻文字拥挤。 */
  labels?: { regionId: string; name: string }[];
  onSelectRegion: (regionId: string) => void;
  /** 请求进入该地区；主墙由明确按钮触发。 */
  onDrillRegion?: (regionId: string) => void;
  /**
   * 019：双击地图**空白区域**逐级返回（省内→全国；区县→上一级）。
   * 只有真正落在地图容器/画布上的双击才算空白，地区面、标签与抽屉都不会触发。
   */
  onBackRequest?: () => void;
  /** 单击地图空白（未命中地区面/卡片）：用于关闭临时预览，不改变选择。 */
  onBlankClick?: () => void;
  memoryRegions?: MemoryRegion[];
  wallPage?: number;
  onWallPageChange?: (page: number) => void;
  showMemoryCards?: boolean;
  memoriesReady?: boolean;
  memoriesError?: string;
  unassignedPages?: MemoryNote[];
  unassignedLabel?: string;
  onOpenPage?: (pageId: string) => void;
  onOpenStack?: (regionId: string, trigger: HTMLElement) => void;
  onCoverPageIdsChange?: (ids: string[]) => void;
  /**
   * 一次性「新增记忆」显色（边界来源 regionId 集合）。
   * 只在用户明确操作成功后的数据更新时由上层给出；初始加载为空。
   */
  flashRegionIds?: string[];
  /** 应用内「减少动态效果」叠加系统偏好：关闭脉冲、入场动画等装饰动效。 */
  motionReduced?: boolean;
  /** M3 夜光展示（用户主动进入；样式变体，不改任何业务事实）。 */
  nightMode?: boolean;
  /** 用户选择的地图显示风格：真实地貌或纸纹行政图。 */
  mapStyle?: AtlasMapStyle;
  onReady?: () => void;
  onError?: (message: string) => void;
};

function resolveLeafletApi(module: LeafletApi) {
  const candidate = module as LeafletApi & { default?: LeafletApi };
  if ("default" in candidate) {
    const defaultApi = candidate.default;
    if (defaultApi && typeof defaultApi.map === "function") return defaultApi;
  }
  return module;
}

/**
 * 地图页白瓷亮面色系：每块行政区是一块独立的纸白/浅彩“纸片”，
 * 用地区身份底色 + 静态纹样 + 中央本地符号徽章区分省、市、县，
 * 而不是整张纯色贴纸。这里只改视觉，不改变 GeoJSON、投影、命中区域
 * 或填充所表达的篇数语义；有记录地区仅略微转暖并加暖金边。
 */
const REGION_COLOR = "#4f6757";
const REGION_JOURNAL_BORDER = "#9b7e4e";

const SVG_NS = "http://www.w3.org/2000/svg";
const REGION_ART_TILE = 64;
const REGION_ART_PREFIX = "atlas-region-art";

/** FNV-1a 稳定哈希：同一地区每次加载得到同一纹样角度。 */
function regionHash(regionId: string) {
  let hash = 2166136261;
  for (let index = 0; index < regionId.length; index += 1) {
    hash ^= regionId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function regionPatternId(regionId: string, hasJournal: boolean, plainPaper = false) {
  const safeId = regionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${REGION_ART_PREFIX}-${safeId}-${hasJournal ? "j" : "p"}${plainPaper ? "-paper" : ""}`;
}

/** 所有地区都有的极淡纸纤维，避免纹样之外仍是塑料平面。 */
function paperFibres(tone: RegionPalette) {
  return `
    <path d="M-4 17 C16 8 30 24 50 15 S78 11 68 20" fill="none" stroke="${tone.ink}" stroke-opacity=".13" stroke-width=".65"/>
    <path d="M-6 47 C14 38 31 53 48 45 S76 39 70 50" fill="none" stroke="${tone.ink}" stroke-opacity=".10" stroke-width=".55"/>
    <ellipse cx="15" cy="34" rx="2.4" ry=".7" fill="${tone.ink}" fill-opacity=".20"/>
    <ellipse cx="46" cy="9" rx="1.8" ry=".55" fill="${tone.ink}" fill-opacity=".16"/>
  `;
}

/** 八种纹样母题：木纹、窗棂、人字拼、山脊、水波、编织、花窗、梯田。 */
function grainMotif(tone: RegionPalette) {
  return `
    <path d="M-8 12 C10 4 24 20 40 11 S66 7 72 15" fill="none" stroke="${tone.ink}" stroke-opacity=".32" stroke-width="1"/>
    <path d="M-8 36 C12 27 28 43 44 34 S70 30 72 40" fill="none" stroke="${tone.ink}" stroke-opacity=".24" stroke-width=".8"/>
    <ellipse cx="26" cy="47" rx="4" ry="1" fill="${tone.ink}" fill-opacity=".26"/>
    <ellipse cx="54" cy="24" rx="3" ry=".8" fill="${tone.accent}" fill-opacity=".26"/>
  `;
}

function latticeMotif(tone: RegionPalette) {
  return `
    <path d="M-16 32 L32 -16 L80 32 L32 80 Z" fill="none" stroke="${tone.ink}" stroke-opacity=".30" stroke-width=".85"/>
    <path d="M0 0 H64 V64 H0 Z" fill="none" stroke="${tone.ink}" stroke-opacity=".18" stroke-width=".6"/>
    <circle cx="32" cy="32" r="2.4" fill="${tone.accent}" fill-opacity=".40"/>
    <circle cx="0" cy="0" r="1.5" fill="${tone.ink}" fill-opacity=".20"/>
  `;
}

function herringboneMotif(tone: RegionPalette) {
  return `
    <path d="M-12 18 L12 42 L36 18 L60 42 L84 18" fill="none" stroke="${tone.ink}" stroke-opacity=".32" stroke-width=".95"/>
    <path d="M-12 42 L12 66 L36 42 L60 66 L84 42" fill="none" stroke="${tone.ink}" stroke-opacity=".20" stroke-width=".75"/>
    <path d="M-12 66 L12 90 M60 -6 L84 18" fill="none" stroke="${tone.accent}" stroke-opacity=".22" stroke-width=".7"/>
  `;
}

function ridgeMotif(tone: RegionPalette) {
  return `
    <path d="M-8 48 L8 28 L18 38 L30 18 L42 40 L54 30 L72 48" fill="none" stroke="${tone.ink}" stroke-opacity=".34" stroke-width=".9"/>
    <path d="M-8 58 L6 42 L16 50 L28 34 L40 52 L52 44 L72 58" fill="none" stroke="${tone.ink}" stroke-opacity=".20" stroke-width=".7"/>
    <path d="M0 60 H64" fill="none" stroke="${tone.accent}" stroke-opacity=".18" stroke-width=".6"/>
  `;
}

function waveMotif(tone: RegionPalette) {
  return `
    <path d="M-8 20 Q8 4 24 20 T56 20 T88 20" fill="none" stroke="${tone.ink}" stroke-opacity=".23" stroke-width=".9"/>
    <path d="M-8 44 Q8 28 24 44 T56 44 T88 44" fill="none" stroke="${tone.ink}" stroke-opacity=".21" stroke-width=".7"/>
    <circle cx="20" cy="53" r="2" fill="${tone.accent}" fill-opacity=".34"/>
    <circle cx="52" cy="9" r="1.4" fill="${tone.ink}" fill-opacity=".15"/>
  `;
}

function weaveMotif(tone: RegionPalette) {
  return `
    <path d="M-16 16 L16 -16 M0 32 L32 0 M16 48 L48 16 M32 64 L64 32 M48 80 L80 48" fill="none" stroke="${tone.ink}" stroke-opacity=".28" stroke-width=".8"/>
    <path d="M-16 48 L16 80 M0 32 L32 64 M16 16 L48 48 M32 0 L64 32 M48 -16 L80 16" fill="none" stroke="${tone.accent}" stroke-opacity=".20" stroke-width=".7"/>
  `;
}

function blossomMotif(tone: RegionPalette) {
  return `
    <g transform="translate(32 32)">
      <path d="M0 -13 C8 -5 8 5 0 13 C-8 5 -8 -5 0 -13Z" fill="${tone.accent}" fill-opacity=".16" stroke="${tone.ink}" stroke-opacity=".18" stroke-width=".6"/>
      <path d="M-13 0 C-5 -8 5 -8 13 0 C5 8 -5 8 -13 0Z" fill="${tone.accent}" fill-opacity=".16" stroke="${tone.ink}" stroke-opacity=".18" stroke-width=".6"/>
      <circle r="2.6" fill="${tone.ink}" fill-opacity=".28"/>
    </g>
    <circle cx="10" cy="14" r="1.2" fill="${tone.ink}" fill-opacity=".22"/>
    <circle cx="54" cy="50" r="1.5" fill="${tone.accent}" fill-opacity=".28"/>
  `;
}

function terraceMotif(tone: RegionPalette) {
  return `
    <path d="M-8 15 H16 V25 H36 V35 H72" fill="none" stroke="${tone.ink}" stroke-opacity=".32" stroke-width=".9"/>
    <path d="M-8 46 H12 V56 H32 V66 H72" fill="none" stroke="${tone.ink}" stroke-opacity=".20" stroke-width=".7"/>
    <path d="M-8 30 H26 V40 H52 V50 H72" fill="none" stroke="${tone.accent}" stroke-opacity=".18" stroke-width=".6"/>
  `;
}

const REGION_ART_MOTIFS: Record<RegionPattern, (tone: RegionPalette) => string> = {
  grain: grainMotif,
  lattice: latticeMotif,
  herringbone: herringboneMotif,
  ridge: ridgeMotif,
  wave: waveMotif,
  weave: weaveMotif,
  blossom: blossomMotif,
  terrace: terraceMotif
};

function regionPatternMarkup(
  regionId: string,
  hasJournal: boolean,
  identity: ReturnType<typeof resolveRegionIdentity>,
  plainPaper = false
) {
  const hash = regionHash(regionId);
  const tone = identity.palette;
  const motif = REGION_ART_MOTIFS[identity.pattern] ?? grainMotif;
  const rotation = ((hash >>> 9) % 4) * 90 + ((hash >>> 13) % 3) * 8 - 8;
  const id = regionPatternId(regionId, hasJournal, plainPaper);
  return `<pattern id="${id}" width="${REGION_ART_TILE}" height="${REGION_ART_TILE}" patternUnits="userSpaceOnUse" patternTransform="rotate(${rotation} 32 32)">
    <rect width="${REGION_ART_TILE}" height="${REGION_ART_TILE}" fill="${hasJournal ? tone.journal : tone.paper}"/>
    ${plainPaper ? `<rect width="${REGION_ART_TILE}" height="${REGION_ART_TILE}" fill="${tone.accent}" opacity=".095"/>` : ""}
    ${paperFibres(tone)}
    ${plainPaper ? `<g opacity=".14">${motif(tone)}</g>` : motif(tone)}
  </pattern>`;
}

/**
 * 同一地图实例只挂一个纹样 defs；每个地区同时准备有/无记录两套，
 * 篇数变化时直接切换，不给每次选中重建纹理。
 */
function ensureRegionPatterns(
  map: LeafletMap | null,
  dataset: BoundaryDataset,
  plainPaper = false
) {
  if (!map) return false;
  const svg = map.getPanes().overlayPane.querySelector("svg");
  if (!svg) return false;
  let defs = svg.querySelector<SVGDefsElement>("[data-atlas-region-art]");
  if (!defs) {
    defs = document.createElementNS(SVG_NS, "defs") as SVGDefsElement;
    defs.setAttribute("data-atlas-region-art", "true");
    svg.prepend(defs);
  }
  const ready = new Set(Array.from(defs.querySelectorAll("pattern"), (item) => item.id));
  const missing: string[] = [];
  for (const region of dataset.regions) {
    const identity = resolveRegionIdentity(region.name, region.regionId);
    for (const hasJournal of [false, true]) {
      if (!ready.has(regionPatternId(region.regionId, hasJournal, plainPaper))) {
        missing.push(regionPatternMarkup(region.regionId, hasJournal, identity, plainPaper));
      }
    }
  }
  if (!missing.length) return true;
  const parsed = new DOMParser().parseFromString(
    `<svg xmlns="${SVG_NS}">${missing.join("")}</svg>`,
    "image/svg+xml"
  );
  parsed.querySelectorAll("pattern").forEach((pattern) => {
    defs?.appendChild(document.importNode(pattern, true));
  });
  return true;
}

/** 把行政区的纯色填充换成该地区自己的纹样。 */
function applyRegionPattern(
  layer: Path,
  regionId: string,
  hasJournal: boolean,
  plainPaper = false
) {
  const element = layer.getElement();
  if (!(element instanceof SVGElement)) return;
  element.style.fill = `url(#${regionPatternId(regionId, hasJournal, plainPaper)})`;
}

/**
 * 基础填充：有记录地区用暖纸色，其余用纸白；实际每块还会由
 * resolveRegionIdentity 覆写成稳定身份色。选中与悬停只改描边，
 * 不覆盖地区填充（见 buildRegionStyle）。
 */
export const REGION_NO_JOURNAL_STYLE = {
  color: REGION_COLOR,
  weight: 1.2,
  fillColor: "#fcfbf7",
  fillOpacity: 0.99
};

export const REGION_HAS_JOURNAL_STYLE = {
  color: REGION_JOURNAL_BORDER,
  weight: 1.45,
  fillColor: "#fbf0de",
  fillOpacity: 0.99
};

/** 选中/悬停：只加粗描边，**完全不带 fill\* 字段**，因此不会覆盖地区填充。 */
export const REGION_EMPHASIS_STYLE = { color: "#2f4f3f", weight: 2.8 };

/** 一次性「新增记忆」显色的描边强调（不修改填充语义，超时后由调用方还原）。 */
export const REGION_FLASH_STYLE = { color: "#a78852", weight: 3.2 };

export type RegionStyleState = {
  hasJournal: boolean;
  selected: boolean;
};

/** 纯函数：给定状态返回 Leaflet path 样式；选中态不返回任何 fill 字段。 */
export function buildRegionStyle(state: RegionStyleState): Record<string, unknown> {
  const base = state.hasJournal ? REGION_HAS_JOURNAL_STYLE : REGION_NO_JOURNAL_STYLE;
  if (!state.selected) return { ...base };
  return { ...base, ...REGION_EMPHASIS_STYLE };
}

/** 递归确认几何里没有非有限坐标；只要有一处 NaN/Infinity 就不画这个面。 */
function hasCompleteCoordinates(
  geometry: { type?: string; coordinates?: unknown } | null
): boolean {
  if (!geometry) return false;
  const walk = (value: unknown): boolean => {
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) {
      if (value.length === 0) return false;
      return value.every(walk);
    }
    return false;
  };
  return walk(geometry.coordinates);
}

/**
 * 标签度量必须**等于真实渲染尺寸**，否则碰撞判定形同虚设。
 * 桌面实测：`.atlas-region-label` 为 12px/行高 18px + 内边距，最长省名
 * “新疆维吾尔自治区”宽 109px、高 20px。预留 96×22 对宽度是**少留**的，
 * 桌面靠“允许轻微重叠”的负 gap 兜住，尚可读；窄屏则叠成一团（见下）。
 */
const LABEL_WIDTH = 96;
const LABEL_HEIGHT = 22;
/**
 * 窄屏（手机）标签度量，与 `src/styles/atlas.css` 中 `@media (max-width: 620px)`
 * 下 `.leaflet-tooltip.atlas-region-label` 的字号**同源**。断点用视口宽度而非
 * 容器宽度：字号是视图尺度的事，媒体查询也按视口判定，两者同源才不会出现
 * “预留变小、字号没变”的错配。
 */
const LABEL_COMPACT_MAX_WIDTH = 620;
/** 10px 字号 + 1px/5px 内边距：最长省名 90×18，预留 92×20 略有余量。 */
const LABEL_COMPACT_WIDTH = 92;
const LABEL_COMPACT_HEIGHT = 20;
/** 窄屏下标签必须真正分开（桌面默认是允许重叠的负 gap）。 */
const LABEL_COMPACT_GAP = 2;

function isCompactLabelViewport(): boolean {
  return typeof window !== "undefined" && window.innerWidth <= LABEL_COMPACT_MAX_WIDTH;
}

/** 单次最多展示的标签数；悬停时通常只有一个，因此不做面积过滤。 */
const LABEL_MAX = 80;

/**
 * 行政区边界绘制与交互适配器（013 / D2a / 016）。
 *
 * 只接收数据与选择回调：**不读写任何 Repository、不创建 tileLayer、不请求 OSM 瓦片**。
 * 按完整边界固定适配；悬停标签用 Leaflet permanent tooltip 临时承载，
 * 排布由 `region-label-layout` 的纯函数决定，本模块不自己算锚点。
 */
export function LeafletRegionAdapter({
  dataset,
  selectedRegionId,
  highlightedRegionIds,
  pageCountByRegionId,
  provinceRegionId = null,
  labels,
  onSelectRegion,
  onDrillRegion,
  onBackRequest,
  onBlankClick,
  memoryRegions = [],
  wallPage = 0,
  onWallPageChange,
  showMemoryCards = true,
  memoriesReady = true,
  memoriesError,
  unassignedPages = EMPTY_MEMORY_PAGES,
  unassignedLabel = "尚未细分",
  onOpenPage,
  onOpenStack,
  onCoverPageIdsChange,
  flashRegionIds,
  motionReduced = false,
  nightMode = false,
  mapStyle = DEFAULT_ATLAS_MAP_STYLE,
  onReady,
  onError
}: LeafletRegionAdapterProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const harborConnectorRef = useRef<SVGLineElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const layerRef = useRef<LeafletGeoJSON | null>(null);
  const terrainOverlayRef = useRef<ImageOverlay | null>(null);
  const terrainUrlRef = useRef<string | null>(null);
  const terrainRunRef = useRef(0);
  /** 同一数据集窗口变化时先保留上一帧地貌，避免回到空白后再等待。 */
  const terrainDatasetRef = useRef<BoundaryDataset | null>(null);
  const regionLayersRef = useRef<Map<string, Path>>(new Map());
  /** 地区徽章（Leaflet marker）；只随数据集/篇数重建，不影响矢量层。 */
  const emblemMarkersRef = useRef<import("leaflet").Marker[]>([]);
  /** 当前已绑定悬浮标签的地区：只增删差异，不重建整层。 */
  const labelLayersRef = useRef<Set<string>>(new Set());
  /** 悬浮标签排布的重入保护（tooltip 操作会触发 moveend 回调自身）。 */
  const labelSchedulingRef = useRef(false);
  /** 上一次真正写入 Leaflet 的标签签名；相同就别再动，避免 moveend 自激。 */
  const lastLabelSignatureRef = useRef<string | null>(null);
  /** 视野监听器（排布标签时必须临时摘掉，避免写入 tooltip 触发 moveend 自激）。 */
  const zoomMoveHandlerRef = useRef<() => void>(() => {});
  /**
   * 效果与事件里要读到最新 dataset/回调，但写入放在提交后（渲染期不碰 ref）。
   * `scheduleLabels` 只会在效果或事件里调用，因此读到的始终是已提交的值。
   */
  const datasetRef = useRef(dataset);
  const labelsRef = useRef(labels);
  /** 选中回调也用 ref：回调 identity 变化不应重建矢量层（017 缩放不回弹）。 */
  const onSelectRegionRef = useRef(onSelectRegion);
  const onBackRequestRef = useRef(onBackRequest);
  const onDrillRegionRef = useRef(onDrillRegion);
  const onBlankClickRef = useRef(onBlankClick);
  const motionReducedRef = useRef(motionReduced);
  const flashIdsRef = useRef<Set<string>>(new Set(flashRegionIds ?? []));
  const hoveredIdsRef = useRef<Set<string>>(new Set());
  const [hoveredMapRegionId, setHoveredMapRegionId] = useState<string | null>(null);
  const [mapInstance, setMapInstance] = useState<LeafletMap | null>(null);
  const [terrainReady, setTerrainReady] = useState(false);
  const [wallSize, setWallSize] = useState({ width: 0, height: 0 });
  /** 视图适配完成计数：记忆墙据此用就绪投影重算图钉/连线（防过期尺寸）。 */
  const [viewSettledCount, setViewSettledCount] = useState(0);
  /**
   * R3：App 详情面板的「选择信号」——地图面、图钉、普通卡、照片带每一次选择
   * 都递增序号；同一地区收起后再次选择（ID 未变）也能重新展开详情。
   * 语义不变：地区选中仍走既有 onSelectRegion（父层映射/状态），序号只是通知。
   */
  const [appSelection, setAppSelection] = useState<{ regionId: string; seq: number }>({
    regionId: "",
    seq: 0
  });
  const handleSelectWithSignal = useCallback((regionId: string) => {
    onSelectRegionRef.current(regionId);
    setAppSelection((previous) => ({ regionId, seq: previous.seq + 1 }));
  }, []);
  const selectWithSignalRef = useRef(handleSelectWithSignal);
  /**
   * R1：App 模式合并封面需求——墙上实际卡片 + 照片带当前可见卡 + 详情面板
   * 当前列出的笔记行，去重后经同一个 onCoverPageIdsChange 出口上报（墙在
   * App 模式不再自报，避免覆盖）。桌面模式由墙自报（原口径不变）。
   */
  const [panelNoteDemand, setPanelNoteDemand] = useState<string[]>([]);
  const handlePanelNoteDemand = useCallback((ids: string[]) => setPanelNoteDemand(ids), []);
  const harborMagnifier = useMemo(() => buildHarborMagnifier(dataset), [dataset]);
  const extent = useMemo(() => atlasBoundaryExtent(dataset.features), [dataset.features]);
  const projectedExtent = useMemo(() => {
    if (!mapInstance || !extent) return undefined;
    const nw = mapInstance.project([extent.north, extent.west], 0);
    const se = mapInstance.project([extent.south, extent.east], 0);
    return { width: se.x - nw.x, height: se.y - nw.y };
  }, [mapInstance, extent]);
  const aspect = projectedExtent ? projectedExtent.width / projectedExtent.height : 1.4;
  /**
   * v2 App 适配的视口模式：窄（≤520px）或矮（≤620px）进入 App 版式；
   * 更窄/更矮（≤350px 宽或 ≤760px 高）照片卡改走地图下方照片带；
   * 矮且横屏时地图在左、照片带与笔记在右。桌面工作区不受影响。
   */
  // Web与App共用相纸展示；手机仍由实际视口选择照片带/横屏布局。
  const [appMode, setAppMode] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 520px), (max-height: 620px)").matches
  );
  const [appBand, setAppBand] = useState(
    () =>
      typeof window !== "undefined" &&
      (window.matchMedia("(max-width: 350px), (max-height: 760px)").matches ||
        window.matchMedia("(max-width: 520px), (max-height: 620px)").matches)
  );
  const [appLandscape, setAppLandscape] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-height: 620px) and (orientation: landscape)").matches
  );
  useEffect(() => {
    const app = window.matchMedia("(max-width: 520px), (max-height: 620px)");
    const band = window.matchMedia("(max-width: 350px), (max-height: 760px)");
    const landscape = window.matchMedia("(max-height: 620px) and (orientation: landscape)");
    const sync = () => {
      setAppMode(app.matches);
      setAppBand(band.matches || app.matches);
      setAppLandscape(landscape.matches);
    };
    sync();
    for (const query of [app, band, landscape]) query.addEventListener("change", sync);
    return () => {
      for (const query of [app, band, landscape]) query.removeEventListener("change", sync);
    };
  }, []);
  const wallFrame = useMemo(
    () =>
      memoryWallFrame(
        wallSize.width,
        wallSize.height,
        aspect,
        Boolean(harborMagnifier),
        projectedExtent,
        { app: appMode, band: appMode && appBand, web: true }
      ),
    [wallSize, aspect, harborMagnifier, projectedExtent, appMode, appBand]
  );
  /**
   * R2 返修：band 模式下墙计划与照片带共用同一容量（6/页）与同一页状态——
   * 旧实现墙计划按零卡位折算为每页 1 地区而照片带每页 6 地区，页数与末组
   * 内容互相矛盾。
   */
  const BAND_PAGE_CAPACITY = 6;
  const planCapacity =
    appMode && appBand ? BAND_PAGE_CAPACITY : wallFrame.slots.length;
  /** App 面板与墙共用同一份墙计划：分页状态只有一份（wallPage）。 */
  const wallPlan = useMemo(
    () => planMemoryWall(memoryRegions, planCapacity, wallPage),
    [memoryRegions, planCapacity, wallPage]
  );
  /** 照片带当前分页的地区切片（容量与页数同 wallPlan，末组不再跨页重复）。 */
  const bandRegions = useMemo(() => {
    const withPages = memoryRegions.filter((region) => region.pages.length);
    return withPages.slice(
      wallPlan.page * BAND_PAGE_CAPACITY,
      (wallPlan.page + 1) * BAND_PAGE_CAPACITY
    );
  }, [memoryRegions, wallPlan]);
  /**
   * R1 返修：封面需求使用**真实可见集合**——墙上实际展示的卡（appMode 下经
   * onDisplayedCoverIdsChange 上报）∪ 面板当前可见（band 可见卡首图 + 详情
   * 列出行，IntersectionObserver 收敛，滚出/收起即释放）。不再无条件请求
   * 本页全部首图；IO 不支持的宿主由面板全量上报当前渲染行兜底。
   */
  const [wallDisplayedIds, setWallDisplayedIds] = useState<string[]>([]);
  const handleWallDisplayedIds = useCallback(
    (ids: string[]) => setWallDisplayedIds(ids),
    []
  );
  const coverPageIds = useMemo(() => {
    if (!appMode) return [];
    const ids = new Set<string>();
    for (const id of wallDisplayedIds) ids.add(id);
    for (const id of panelNoteDemand) ids.add(id);
    return [...ids];
  }, [appMode, wallDisplayedIds, panelNoteDemand]);
  useEffect(() => {
    if (!appMode) return;
    onCoverPageIdsChange?.(coverPageIds);
  }, [appMode, coverPageIds, onCoverPageIdsChange]);
  /** 卸载释放经 ref 直调出口：整树卸载时 setState 已无效，同步调用才可达父级。 */
  const coverExitRef = useRef(onCoverPageIdsChange);
  coverExitRef.current = onCoverPageIdsChange;
  useEffect(() => () => coverExitRef.current?.([]), []);
  /** 层级身份只用于墙的临时交互；固定概览不保存自由视角。 */
  const datasetIdentity = `${dataset.sourceId}|${dataset.sourceVersion}|${dataset.level}|${dataset.parentRegionId ?? ""}`;
  const viewportUpdateRef = useRef<() => void>(() => {});
  /** 样式更新要读到最新状态，但不进几何加载的依赖。 */
  const styleStateRef = useRef({
    selectedRegionId,
    pageCountByRegionId,
    provinceRegionId,
    highlightedRegionIds,
    mapStyle
  });
  useEffect(() => {
    datasetRef.current = dataset;
    labelsRef.current = labels;
    onSelectRegionRef.current = onSelectRegion;
    selectWithSignalRef.current = handleSelectWithSignal;
    onBackRequestRef.current = onBackRequest;
    onDrillRegionRef.current = onDrillRegion;
    onBlankClickRef.current = onBlankClick;
    motionReducedRef.current = motionReduced;
    styleStateRef.current = {
      selectedRegionId,
      pageCountByRegionId,
      provinceRegionId,
      highlightedRegionIds,
      mapStyle
    };
  }, [
    dataset,
    labels,
    onSelectRegion,
    onDrillRegion,
    onBackRequest,
    onBlankClick,
    motionReduced,
    selectedRegionId,
    pageCountByRegionId,
    provinceRegionId,
    highlightedRegionIds,
    mapStyle
  ]);
  const [failed, setFailed] = useState(false);
  // 地图实例就绪后才绘制数据；否则首帧竞态会导致矢量永不渲染。
  const [mapReady, setMapReady] = useState(false);

  /**
   * 样式更新：只对已存在的面 `setStyle`，**不重建层、不触碰视野**。
   * 由“数据集加载后”“选中/篇数变化后”两条路径调用（017 几何/样式/标签分离）。
   */
  const styleRegionLayers = useCallback(() => {
    const {
      selectedRegionId: selected,
      pageCountByRegionId: counts,
      provinceRegionId: province,
      highlightedRegionIds: highlighted,
      mapStyle: activeMapStyle
    } = styleStateRef.current;
    const linked = new Set(highlighted ?? []);
    const currentDataset = datasetRef.current;
    const nameByRegion = new Map(
      currentDataset.regions.map((region) => [region.regionId, region.name] as const)
    );
    const plainPaper = activeMapStyle === "paper";
    const patternsReady = ensureRegionPatterns(mapRef.current, currentDataset, plainPaper);
    for (const [regionId, layer] of regionLayersRef.current) {
      const hasJournal = counts
        ? (counts.get(regionId) ?? 0) > 0 ||
          (Boolean(province) && regionId === province && (counts.get(regionId) ?? 0) > 0)
        : linked.has(regionId);
      const flash = flashIdsRef.current.has(regionId) ? REGION_FLASH_STYLE : null;
      const identity = resolveRegionIdentity(nameByRegion.get(regionId) ?? regionId, regionId);
      layer.setStyle({
        ...buildRegionStyle({
          hasJournal,
          selected: regionId === selected || hoveredIdsRef.current.has(regionId)
        }),
        // 纯色只是 pattern 不可用时的兜底；选中/悬停仍只改描边。
        fillColor: hasJournal ? identity.palette.journal : identity.palette.paper,
        ...(flash ?? {})
      });
      if (patternsReady) {
        applyRegionPattern(layer, regionId, hasJournal, plainPaper);
      } else {
        const element = layer.getElement();
        if (element instanceof SVGElement) element.style.removeProperty("fill");
      }
    }
  }, []);

  const handleHoverRegions = useCallback(
    (ids: string[]) => {
      hoveredIdsRef.current = new Set(ids);
      styleRegionLayers();
    },
    [styleRegionLayers]
  );

  /** 悬浮标签：只给当前指针所在地区排版，不常驻名称。 */
  const scheduleLabelsInner = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const current = datasetRef.current;
    const labelCandidates = labelsRef.current;
    /**
     * 名称只在悬停时出现：常驻省名/市名会盖住边界和卡片，用户已明确要求收起。
     * 悬停标签仍走同一套锚点避让和项目投影，保证线端、图钉与文字不冲突。
     */
    const compact = isCompactLabelViewport();
    const candidates = (labelCandidates ?? current.regions).filter((item) =>
      hoveredIdsRef.current.has(item.regionId)
    );
    const zoom = map.getZoom();
    const size = map.getSize();
    // 记录页会把地图容器 hidden（display:none），此时尺寸为 0、视口左上角是 NaN；
    // 这一帧没有可排的标签，直接返回，避免把 NaN 交给 Leaflet（Invalid LatLng）。
    if (!(size.x > 0) || !(size.y > 0)) return;
    // 256px 瓦片下每度像素数 = 2^zoom * 256 / 360：用于把地理面积阈值换算成像素面积。
    const pixelsPerDegree = (2 ** zoom * 256) / 360;
    // project() 返回的是投影坐标（0,0 = 投影原点），必须减去当前视口左上角才是屏幕像素，
    // 否则“是否出界”的判定会整体偏移。
    const northWest = map.getBounds().getNorthWest();
    if (!Number.isFinite(northWest.lat) || !Number.isFinite(northWest.lng)) return;
    const topLeft = map.project(northWest, zoom);
    /**
     * 窄屏用更小的标签度量并强制互不重叠：390px 宽的地图上，桌面字号
     * （最长省名 109px）占掉近三成宽度，多处标签必然叠在一起无法辨认。
     * 放不下的地区照旧交给既有标签栏列出，不新增界面。
     */
    const labelWidth = compact ? LABEL_COMPACT_WIDTH : LABEL_WIDTH;
    const labelHeight = compact ? LABEL_COMPACT_HEIGHT : LABEL_HEIGHT;
    const geometryByRegion = new Map(
      current.features.map((feature) => [feature.regionId, feature.geometry] as const)
    );
    /** 锚点 [经度,纬度] → 视口像素；标签排布与记忆卡避让共用同一投影。 */
    const projectAnchor = (anchor: [number, number]): [number, number] => {
      // 锚点是 [经度, 纬度]，Leaflet 的 latLng 顺序相反。
      const point = map.project([anchor[1], anchor[0]], zoom);
      return [point.x - topLeft.x, point.y - topLeft.y];
    };
    const result = placeRegionLabels(
      candidates.map((candidate) => ({
        regionId: candidate.regionId,
        name: candidate.name,
        geometry: geometryByRegion.get(candidate.regionId) ?? null
      })),
      {
        project: projectAnchor,
        viewportWidth: size.x,
        viewportHeight: size.y,
        labelWidth,
        labelHeight,
        gap: LABEL_COMPACT_GAP,
        // 标签只在悬停时出现，不再用地理面积过滤小地区；
        // 澳门堂区面积仅约 0.0005°，旧阈值会把悬停名称直接丢掉。
        minArea: 0,
        pixelsPerDegree,
        maxLabels: LABEL_MAX
      }
    );

    /**
     * 关键短路：绑定/解绑 permanent tooltip 会触发地图 moveend，而 moveend 又调用
     * 本函数——如果没有这层判断就是无限互推（实测把页面拖死）。
     * 只有"该显示哪些标签、锚点在哪"真的变化时才动 Leaflet。
     */
    const signature = `${zoom}|${compact ? "compact" : "wide"}|${result.placed
      .map(
        (item) =>
          `${item.regionId}@${Math.round(item.anchor[0] * 1000)},${Math.round(item.anchor[1] * 1000)}`
      )
      .sort()
      .join(";")}`;
    if (signature === lastLabelSignatureRef.current) return;
    lastLabelSignatureRef.current = signature;

    const wanted = new Map(result.placed.map((item) => [item.regionId, item]));
    for (const regionId of [...labelLayersRef.current]) {
      if (wanted.has(regionId)) continue;
      regionLayersRef.current.get(regionId)?.unbindTooltip();
      labelLayersRef.current.delete(regionId);
    }
    for (const item of result.placed) {
      const layer = regionLayersRef.current.get(item.regionId);
      if (!layer) continue;
      const name =
        candidates.find((candidate) => candidate.regionId === item.regionId)?.name ?? item.regionId;
      if (!labelLayersRef.current.has(item.regionId)) {
        layer.bindTooltip(name, {
          permanent: true,
          direction: "center",
          // 地名签上移，避开同一锚点的黄铜图钉头；图钉纸签在面悬浮时隐藏。
          offset: [0, -20],
          className: "atlas-region-label",
          interactive: false,
          opacity: 1
        });
        labelLayersRef.current.add(item.regionId);
      }
      const [lng, lat] = item.anchor;
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      layer.getTooltip()?.setLatLng([lat, lng]);
    }
  }, []);

  /**
   * 排布悬浮标签（带重入保护）。
   * 绑定/解绑 permanent tooltip 会触发地图的 moveend，而 moveend 又调用本函数：
   * 没有保护就会无限互推，实测会把页面拖死。重入直接跳过本次，
   * 由外层调用完成后按最新视野收敛。
   */
  const scheduleLabels = useCallback(() => {
    if (labelSchedulingRef.current) return;
    labelSchedulingRef.current = true;
    try {
      // 先摘掉视野监听：绑定/解绑 tooltip、改锚点都会触发 moveend，
      // 监听器若在写入过程中被调用就会自激（实测页面被拖死）。
      const map = mapRef.current;
      if (map) map.off("zoomend moveend", zoomMoveHandlerRef.current);
      scheduleLabelsInner();
    } finally {
      const map = mapRef.current;
      if (map) map.on("zoomend moveend", zoomMoveHandlerRef.current);
      labelSchedulingRef.current = false;
    }
  }, [scheduleLabelsInner]);

  /** 地图事件闭包只读取最新排布函数，避免把悬停逻辑塞进几何初始化依赖。 */
  const scheduleLabelsRef = useRef<() => void>(() => {});
  useEffect(() => {
    scheduleLabelsRef.current = scheduleLabels;
  }, [scheduleLabels]);

  // 初始化一次地图；卸载时清理实例与事件。
  useEffect(() => {
    let disposed = false;
    if (!containerRef.current) return;
    (async () => {
      try {
        const leafletModule = await import("leaflet");
        const leaflet = resolveLeafletApi(leafletModule);
        if (disposed || !containerRef.current || mapRef.current) return;
        if (typeof leaflet.map !== "function") throw new Error("Leaflet 不可用");
        const map = leaflet.map(containerRef.current, {
          // 记忆墙固定概览：只关闭本实例的自由手势，不拦截页面滚动和浏览器缩放。
          zoomControl: false,
          doubleClickZoom: false,
          scrollWheelZoom: false,
          touchZoom: false,
          dragging: false,
          boxZoom: false,
          tapHold: false,
          zoomSnap: 0.05,
          keyboard: false,
          trackResize: false,
          // Dataset switches and changing zoom bounds must not race a prior zoom transition.
          zoomAnimation: false,
          // permanent tooltip 重排会重新绑定。Leaflet 淡出延迟 200ms 删除旧 DOM，
          // 快速返回/缩放时同名新旧标签并存；矢量地图无需瓦片/标签淡出。
          fadeAnimation: false,
          minZoom: 1,
          maxZoom: 18,
          attributionControl: false,
          // 单层行政区数量有界，使用 Leaflet 默认 SVG。
          // Canvas 同步重绘会丢失旧帧句柄，卸载后旧帧仍可能访问已销毁的画布。
          preferCanvas: false
        });
        /**
         * 验证用只读视图句柄：`e2e/atlas-county.spec.ts` 用它读取缩放上下限与
         * 双击后的视野（这是入库的验收用例，不是临时探针）。只在开发态挂载，
         * 生产不暴露；除读取 zoom/center 外不提供任何写入能力。
         */
        if (process.env.NODE_ENV === "development") {
          (window as unknown as { __atlasMap?: LeafletMap }).__atlasMap = map;
        }
        map.setView([34.5, 108], 3);
        mapRef.current = map;
        setMapInstance(map);
        setMapReady(true);
        onReady?.();
      } catch (error) {
        setFailed(true);
        onError?.(error instanceof Error ? error.message : "地图初始化失败");
      }
    })();
    return () => {
      disposed = true;
      const map = mapRef.current;
      mapRef.current = null;
      if (!map) {
        layerRef.current = null;
        regionLayersRef.current.clear();
        labelLayersRef.current.clear();
        setMapReady(false);
        return;
      }
      // 顺序很重要：先停动画与事件，再移层，最后销毁 map。
      try {
        map.stop();
      } catch {
        // 已销毁的实例 stop 可能抛错；这里只表示“无需再停动画”。
      }
      // 缩放动画已在初始化关闭，SVG 无需接管 Leaflet 私有计时器/重绘句柄。
      map.off();
      layerRef.current?.remove();
      layerRef.current = null;
      regionLayersRef.current.clear();
      labelLayersRef.current.clear();
      terrainOverlayRef.current?.remove();
      terrainOverlayRef.current = null;
      terrainDatasetRef.current = null;
      setTerrainReady(false);
      if (terrainUrlRef.current) {
        URL.revokeObjectURL(terrainUrlRef.current);
        terrainUrlRef.current = null;
      }
      try {
        map.remove();
      } catch {
        // 容器可能已被 React 移除；销毁失败不影响后续挂载新的实例。
      }
      setMapReady(false);
    };
  }, [onError, onReady]);

  /**
   * 几何加载（只在**数据集变化**时重建矢量层）。
   *
   * 017：这里刻意不依赖 selectedRegionId / pageCountByRegionId / highlightedRegionIds，
   * 也不依赖回调 identity。否则选中地区、篇数变化或侧栏开关都会重建整层并重新
   * 适配，导致内容或普通选中改变本应稳定的固定概览。
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    let cancelled = false;
    (async () => {
      const leafletModule = await import("leaflet");
      const leaflet = resolveLeafletApi(leafletModule);
      if (cancelled || !mapRef.current) return;
      // 先解绑悬浮标签再移层：tooltip DOM 挂在独立 pane 上，只 remove 层
      // 会留下游离的旧标签 div（占位不消失，还会污染卡片禁区收集）。
      for (const [, layer] of regionLayersRef.current) layer.unbindTooltip();
      layerRef.current?.remove();
      regionLayersRef.current.clear();
      labelLayersRef.current.clear();
      lastLabelSignatureRef.current = null;
      // 阶段四A：清理 tooltip pane 上遗留的孤儿 .atlas-region-label
      // （unbindTooltip 依赖 Leaflet 内部状态，快速下钻时部分 tooltip
      // DOM 可能未被移除，与新标签并存约 1s）。此处主动扫描并删除。
      const map = mapRef.current;
      const tooltipPane = map.getPane("tooltip");
      if (tooltipPane) {
        tooltipPane
          .querySelectorAll<HTMLElement>(".atlas-region-label")
          .forEach((element) => element.remove());
      }
      hoveredIdsRef.current = new Set();
      setHoveredMapRegionId(null);
      const collection: GeoJSON.FeatureCollection = {
        type: "FeatureCollection",
        features: dataset.features.map((feature: BoundaryFeature) => ({
          type: "Feature",
          properties: { regionId: feature.regionId },
          geometry: feature.geometry
        }))
      };
      const layer = leaflet.geoJSON(collection, {
        // 样式由 styleRegionLayers 统一更新（选中/篇数只改样式，不重建层）。
        style: { ...REGION_NO_JOURNAL_STYLE },
        // 只有坐标完整的要素才画：NaN 会让点选（isPointInPath）抛
        // “Invalid LatLng object: (NaN, NaN)”，并让该地区永远选不中。
        filter: (feature) => hasCompleteCoordinates(feature.geometry),
        onEachFeature: (feature, featureLayer) => {
          const regionId = feature.properties?.regionId as string | undefined;
          if (!regionId) return;
          const path = featureLayer as Path;
          regionLayersRef.current.set(regionId, path);
          path.on("mouseover", () => {
            hoveredIdsRef.current = new Set([regionId]);
            setHoveredMapRegionId(regionId);
            styleRegionLayers();
            scheduleLabelsRef.current();
          });
          path.on("mouseout", () => {
            hoveredIdsRef.current = new Set();
            setHoveredMapRegionId(null);
            styleRegionLayers();
            scheduleLabelsRef.current();
          });
          path.on("click", () => {
            // 延后到下一帧再改状态：Leaflet 的 click 是在真实 mouseup 的处理链里
            // 触发的，同步 setState 会在同一事件里重绘全部面与标签，实测会让
            // 渲染进程卡死（页面无响应）。
            const selected = regionId;
            requestAnimationFrame(() => selectWithSignalRef.current(selected));
          });
          path.on("dblclick", (event) => {
            // 面上的双击直接下钻；不要让事件继续冒泡到空白双击的逐级返回。
            event.originalEvent?.stopPropagation();
            if (datasetRef.current.level === "city") return;
            const selected = regionId;
            // 与单击相同：把状态变更移出 Leaflet 的 mouseup 处理链。
            requestAnimationFrame(() => onDrillRegionRef.current?.(selected));
          });
        }
      });
      layer.addTo(map);
      layerRef.current = layer;
      const bounds = layer.getBounds();
      viewportUpdateRef.current = () => {
        const container = containerRef.current;
        if (
          cancelled ||
          mapRef.current !== map ||
          !container ||
          container.clientWidth <= 0 ||
          container.clientHeight <= 0 ||
          !bounds.isValid()
        )
          return;
        map.stop();
        map.invalidateSize({ animate: false, pan: false });
        map.setMinZoom(-8);
        map.setMaxZoom(18);
        const projected = leaflet.bounds(
          map.project(bounds.getNorthWest(), 0),
          map.project(bounds.getSouthEast(), 0)
        );
        const size = projected.getSize();
        const fit = atlasFitZoom(size.x, size.y, container.clientWidth, container.clientHeight);
        map.setMinZoom(fit);
        map.setMaxZoom(fit);
        // 跳过 Leaflet 对旧视角的平移取整路径；完整适配始终重建同一像素原点。
        const fitOptions = { animate: false, reset: true };
        map.setView(map.unproject(projected.getCenter(), 0), fit, fitOptions);
      };
      viewportUpdateRef.current();
      // 新层还没有样式与标签，立即按当前选择/篇数补一次。
      styleRegionLayers();
      scheduleLabels();
      // 几何就绪后的真实适配是最后一次 invalidateSize（App 版式布局链更长，
      // Leaflet 初始化量到的容器尺寸可能是样式应用前的中间态）：同样递增
      // 版本号，让记忆墙用就绪投影重算图钉/连线（确定性，不依赖 resize 事件）。
      setViewSettledCount((count) => count + 1);
    })();
    return () => {
      cancelled = true;
      viewportUpdateRef.current = () => {};
    };
    // 依赖只保留数据集与地图就绪：其余状态的更新走样式/标签两条独立路径。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset, datasetIdentity, mapReady]);

  /**
   * 019：双击**空白**逐级返回。
   * - 只有事件目标就是地图容器或它的画布/瓦片层时才处理：地区面在路径 handler 里
   *   已经 `stopPropagation`，标签、侧栏、抽屉都在容器之外，不会被当成空白。
   * - 全国视图不响应（单击/双击都无操作）。
   */
  useEffect(() => {
    const map = mapRef.current;
    const container = containerRef.current;
    if (!map || !container || !mapReady) return;
    /**
     * 空白判定：Leaflet 的 Canvas 渲染器在指针命中可交互图层时会给画布加上
     * `leaflet-interactive` 类（公开约定），空白处没有这个类。
     * 因此“命中地区面”与“落在空白”可以用同一个 DOM 事件区分开，
     * 不必依赖事件是否冒泡，也不会把标签/侧栏/抽屉算成空白。
     */
    const isBlankTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      if (target === container) return true;
      if (target.closest("[data-memory-card]")) return false;
      if (target.classList.contains("leaflet-interactive")) return false;
      return (
        target.classList.contains("leaflet-container") ||
        target.classList.contains("leaflet-pane") ||
        target.tagName === "CANVAS"
      );
    };
    const handleDoubleClick = (event: MouseEvent) => {
      if (datasetRef.current.level === "national") return;
      if (!isBlankTarget(event.target)) return;
      onBackRequestRef.current?.();
    };
    /** 单击空白只关闭临时预览，不改变选择。 */
    const handleClick = (event: MouseEvent) => {
      if (!isBlankTarget(event.target)) return;
      onBlankClickRef.current?.();
    };
    container.addEventListener("dblclick", handleDoubleClick);
    container.addEventListener("click", handleClick);
    return () => {
      container.removeEventListener("dblclick", handleDoubleClick);
      container.removeEventListener("click", handleClick);
    };
  }, [mapReady]);

  /**
   * 样式更新（选中 / 篇数 / 省份关联）：只对已存在的面 setStyle，
   * 不重建层、不触碰视野。
   */
  useEffect(() => {
    if (!mapReady) return;
    styleRegionLayers();
    scheduleLabels();
    // styleRegionLayers 是稳定引用（见上）；依赖是驱动它重算的状态。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRegionId, pageCountByRegionId, provinceRegionId, highlightedRegionIds, mapStyle, mapReady]);

  /**
   * 地区徽章：每个行政区有一个本地符号小印章。
   * 用 Leaflet marker + 独立 pane，而不是给每个 path 叠 DOM：标记随地图
   * 投影移动，pane 与 marker 都不接收指针，地区点击仍然交给下面的 path。
   * 徽章只表达身份，不承担计数/选择；有记录时只给印章加一圈暖金边。
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    let disposed = false;
    const markers: import("leaflet").Marker[] = [];
    void import("leaflet").then((module) => {
      if (disposed || mapRef.current !== map) return;
      const leaflet = resolveLeafletApi(module);
      const paneName = "atlasEmblemPane";
      if (!map.getPane(paneName)) {
        const pane = map.createPane(paneName);
        pane.style.zIndex = "430";
        pane.style.pointerEvents = "none";
      }
      const size = regionEmblemSize(dataset.level, isCompactLabelViewport());
      const nameByRegion = new Map(
        dataset.regions.map((region) => [region.regionId, region.name] as const)
      );
      const counts = pageCountByRegionId;
      for (const feature of dataset.features) {
        const anchor = labelAnchor(feature.geometry);
        if (!anchor) continue;
        const regionId = feature.regionId;
        const identity = resolveRegionIdentity(nameByRegion.get(regionId) ?? regionId, regionId);
        const hasJournal = (counts?.get(regionId) ?? 0) > 0;
        const marker = leaflet
          .marker([anchor[1], anchor[0]], {
            pane: paneName,
            interactive: false,
            keyboard: false,
            icon: leaflet.divIcon({
              className: "atlas-region-emblem",
              html: regionEmblemHtml(identity, { size, hasJournal }),
              iconSize: [size, size],
              iconAnchor: [size / 2, size / 2]
            })
          })
          .addTo(map);
        markers.push(marker);
      }
      emblemMarkersRef.current = markers;
    });
    return () => {
      disposed = true;
      for (const marker of markers) marker.remove();
      emblemMarkersRef.current = emblemMarkersRef.current.filter(
        (marker) => !markers.includes(marker)
      );
    };
  }, [dataset, mapReady, pageCountByRegionId]);

  /** 主地图的细圈标出放大镜对应的真实位置；不拦截地图点选。 */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !harborMagnifier) return;
    let disposed = false;
    let marker: import("leaflet").CircleMarker | undefined;
    void import("leaflet").then((module) => {
      if (disposed || mapRef.current !== map) return;
      const leaflet = resolveLeafletApi(module);
      marker = leaflet
        .circleMarker([harborMagnifier.center[1], harborMagnifier.center[0]], {
          radius: 11,
          color: "#b4935f",
          weight: 1.4,
          opacity: 0.92,
          fillColor: "#b4935f",
          fillOpacity: 0.12,
          interactive: false
        })
        .addTo(map);
    });
    return () => {
      disposed = true;
      marker?.remove();
    };
  }, [harborMagnifier, mapReady]);

  /** 连线随地图视野更新，让局部图始终指向真实位置。 */
  useEffect(() => {
    const map = mapRef.current;
    const container = containerRef.current;
    const line = harborConnectorRef.current;
    if (!map || !mapReady || !harborMagnifier || !container || !line) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const wrapEl = container.closest(".atlas-map-wrap");
        const lens = wrapEl?.querySelector<HTMLElement>(".atlas-harbor-lens");
        if (!lens || !wrapEl) return;
        const mapBox = container.getBoundingClientRect();
        const wallBox = wrapEl.getBoundingClientRect();
        const lensBox = lens.getBoundingClientRect();
        const point = map.latLngToContainerPoint([
          harborMagnifier.center[1],
          harborMagnifier.center[0]
        ]);
        const visible =
          point.x >= 0 && point.x <= mapBox.width && point.y >= 0 && point.y <= mapBox.height;
        line.style.opacity = visible ? "1" : "0";
        if (!visible) return;
        const screenX = mapBox.left + point.x;
        const screenY = mapBox.top + point.y;
        const targetX = Math.max(lensBox.left + 8, Math.min(screenX, lensBox.right - 8));
        const targetY = Math.max(lensBox.top + 8, Math.min(screenY, lensBox.bottom - 8));
        line.setAttribute("x1", String(screenX - wallBox.left));
        line.setAttribute("y1", String(screenY - wallBox.top));
        line.setAttribute("x2", String(targetX - wallBox.left));
        line.setAttribute("y2", String(targetY - wallBox.top));
      });
    };
    update();
    map.on("move zoom resize", update);
    return () => {
      cancelAnimationFrame(frame);
      map.off("move zoom resize", update);
    };
  }, [harborMagnifier, mapReady, wallFrame]);

  /** 一次性定位反馈：独立标记跟随地图移动，不重建面或改变缩放。 */
  useEffect(() => {
    const map = mapRef.current;
    if (
      !map ||
      !mapReady ||
      !selectedRegionId ||
      motionReducedRef.current ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const feature = dataset.features.find((item) => item.regionId === selectedRegionId);
    const anchor = feature ? labelAnchor(feature.geometry) : null;
    if (!anchor) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let marker: import("leaflet").Marker | undefined;
    void import("leaflet").then((module) => {
      if (disposed || mapRef.current !== map) return;
      const leaflet = resolveLeafletApi(module);
      marker = leaflet
        .marker([anchor[1], anchor[0]], {
          icon: leaflet.divIcon({
            className: "atlas-selection-pulse-marker",
            html: '<span class="atlas-selection-pulse" aria-hidden="true"></span>',
            iconSize: [32, 32],
            iconAnchor: [16, 16]
          }),
          interactive: false,
          keyboard: false
        })
        .addTo(map);
      timer = setTimeout(() => marker?.remove(), 600);
    });
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      marker?.remove();
    };
  }, [dataset, selectedRegionId, mapReady]);

  // 完整视图重适配后同步标签。
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const handle = () => {
      scheduleLabels();
    };
    zoomMoveHandlerRef.current = handle;
    map.on("zoomend moveend", handle);
    return () => {
      map.off("zoomend moveend", handle);
    };
  }, [mapReady, scheduleLabels]);

  /** 一次性「新增记忆」显色：集合非空时强调描边，清空后由上层还原。 */
  useEffect(() => {
    flashIdsRef.current = new Set(flashRegionIds ?? []);
    if (!mapReady) return;
    styleRegionLayers();
  }, [flashRegionIds, mapReady, styleRegionLayers]);

  // 仅观察工作区；React 提交新的地图矩形后再适配，避免用旧子容器尺寸计算。
  useEffect(() => {
    const wrap = containerRef.current?.parentElement;
    if (!wrap) return;
    const update = () =>
      setWallSize((previous) =>
        previous.width === wrap.clientWidth && previous.height === wrap.clientHeight
          ? previous
          : { width: wrap.clientWidth, height: wrap.clientHeight }
      );
    update();
    const observer = new ResizeObserver(update);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);
  /**
   * v2 App 适配：直接观察地图容器——容器的最终尺寸由样式帧决定（未样式化
   * 初始化时 Leaflet 量到的是中间态，如 390×606），窗口 resize 不覆盖这类
   * 变化；容器每变化一次就重适配一次，保证 Leaflet 内部尺寸收敛到真实容器。
   */
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (mapReady) viewportUpdateRef.current();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [mapReady]);
  useEffect(() => {
    if (!mapReady) return;
    viewportUpdateRef.current();
    scheduleLabels();
    // 子组件（记忆墙）的 effect 在本组件之前执行：它拿到的投影可能是
    // invalidateSize 之前的过期容器尺寸（App 版式布局链更长，实测复现）。
    // 帧落定并重适配后递增版本号，让墙用就绪后的投影重算图钉与连线。
    setViewSettledCount((count) => count + 1);
  }, [wallFrame, mapReady, scheduleLabels]);

  /**
   * 真实地貌栅格：本地地表色先出图，再尝试当前视野的 DEM 晕渲；两者都放在
   * 地区 SVG 下方的独立 pane。失败时只退回本地地表色，再失败则保留原行政图。
   * ponytail: 依赖浏览器 HTTP 缓存 + 会话内解码缓存，没有离线瓦片包；需要完全
   * 离线且仍要市县细节时再预生成/缓存 DEM。
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (mapStyle !== "terrain") {
      terrainRunRef.current += 1;
      terrainOverlayRef.current?.remove();
      terrainOverlayRef.current = null;
      containerRef.current?.parentElement?.removeAttribute("data-terrain-source");
      if (terrainUrlRef.current) {
        URL.revokeObjectURL(terrainUrlRef.current);
        terrainUrlRef.current = null;
      }
      queueMicrotask(() => setTerrainReady(false));
      terrainDatasetRef.current = null;
      return;
    }
    const controller = new AbortController();
    const run = ++terrainRunRef.current;
    let disposed = false;
    const removeTerrain = () => {
      terrainOverlayRef.current?.remove();
      terrainOverlayRef.current = null;
      containerRef.current?.parentElement?.removeAttribute("data-terrain-source");
      if (terrainUrlRef.current) {
        URL.revokeObjectURL(terrainUrlRef.current);
        terrainUrlRef.current = null;
      }
    };
    if (terrainDatasetRef.current !== dataset) {
      terrainDatasetRef.current = dataset;
      removeTerrain();
      queueMicrotask(() => setTerrainReady(false));
    }
    const applyTerrain = async (
      blob: Blob,
      bounds: import("leaflet").LatLngBounds,
      source: "cache" | "base" | "detail"
    ) => {
      if (disposed || run !== terrainRunRef.current || mapRef.current !== map) return;
      let leaflet: typeof import("leaflet");
      try {
        const leafletModule = await import("leaflet");
        leaflet = resolveLeafletApi(leafletModule);
      } catch {
        return;
      }
      if (disposed || run !== terrainRunRef.current || mapRef.current !== map) return;
      const paneName = "atlasTerrainPane";
      if (!map.getPane(paneName)) {
        const pane = map.createPane(paneName);
        pane.style.zIndex = "350";
        pane.style.pointerEvents = "none";
      }
      const url = URL.createObjectURL(blob);
      const overlay = leaflet.imageOverlay(url, bounds, {
        pane: paneName,
        interactive: false,
        opacity: 1,
        className: "atlas-terrain-image",
        alt: ""
      });
      overlay.addTo(map);
      removeTerrain();
      terrainOverlayRef.current = overlay;
      terrainUrlRef.current = url;
      const wrap = containerRef.current?.closest(".atlas-map-wrap");
      if (wrap) (wrap as HTMLElement).dataset.terrainSource = source;
      setTerrainReady(true);
    };
    const timer = window.setTimeout(async () => {
      if (disposed) return;
      try {
        const bounds = map.getBounds();
        const key = terrainCacheKey(map, dataset);
        const cached = await readTerrainCache(key);
        if (cached) {
          await applyTerrain(cached.blob, bounds, "cache");
          return;
        }
        // 先出本地地表色：DEM 瓦片慢时用户也能立刻看到地貌底色，而不是旧纸纹。
        const base = await renderTerrainImage({
          map,
          dataset,
          signal: controller.signal,
          dem: false
        });
        if (disposed || !base || controller.signal.aborted) return;
        await applyTerrain(base.blob, bounds, "base");
        // 全国层级直接使用本地地表色：它本身已有地形晕渲，DEM 瓦片网络
        // 会让这张图在首屏后还要等数秒，视觉收益却很小。
        if (map.getZoom() <= 5) {
          void writeTerrainCache(key, base.blob, false);
          return;
        }
        // 省/市层级再用真实高程替换为细化晕渲；失败时保留上面的本地底色。
        // 同一视野的重复最终渲染只跑一次；取消仍由本效果的 run 校验负责。
        const terrain = await shareTerrainRender(`${key}|detail`, () =>
          renderTerrainImage({ map, dataset })
        );
        if (disposed || !terrain || controller.signal.aborted) return;
        await applyTerrain(terrain.blob, bounds, "detail");
        // DEM 失败时只保留本次会话画面，不把“未细化”结果写进持久缓存；
        // 下次仍有机会在恢复网络后升级。
        if (terrain.shaded) void writeTerrainCache(key, terrain.blob, true);
      } catch {
        // 装饰性地貌失败不遮挡行政图与笔记功能。
      }
    }, 40);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      controller.abort();
      // 同一数据集的 resize 先保留旧地貌图；新图 ready 后由 applyTerrain 替换。
      // 数据集切换在本次 effect 开头清理，彻底卸载由 map 初始化 cleanup 清理。
    };
  }, [dataset, mapReady, wallFrame, mapStyle]);

  return (
    <div
      className={[
        "atlas-map-wrap",
        "is-memory-wall",
        mapStyle === "terrain" ? "is-terrain-map" : "is-paper-map",
        terrainReady ? "has-terrain" : "",
        motionReduced ? "is-calm" : "",
        nightMode ? "is-night" : "",
        appMode ? "is-app-variant" : "",
        appMode && appLandscape ? "is-app-landscape" : ""
      ]
        .filter(Boolean)
        .join(" ")}
      {...(appMode ? { "data-app-mode": appLandscape ? "landscape" : "portrait" } : {})}
    >
      {/*
        R2 稳定 DOM：同一次生命周期内只有一个舞台、一个地图容器和一个记忆墙
        实例——App/desktop 差异只用 class、CSS 与外围控件表达。跨断点切换时
        React 原位复用同一 .atlas-map 节点，Leaflet 与全部观察器持续指向当前
        节点（层级/选中/分页/阅读返回状态不丢）。桌面舞台是包一层 position:
        relative 的透明盒子，几何与原工作区一致。
      */}
      <div className="atlas-app-stage">
        <div
          ref={containerRef}
          className="atlas-map"
          style={
            wallSize.width > 0
              ? {
                  position: "absolute",
                  left: wallFrame.map.x,
                  top: wallFrame.map.y,
                  width: wallFrame.map.width,
                  height: wallFrame.map.height,
                  minHeight: 0
                }
              : undefined
          }
          role="region"
          aria-label={
            dataset.level === "city"
              ? "区县固定概览：选择区县查看笔记"
              : "行政区固定概览：选择地区后可进入下一级"
          }
        />
        <AtlasMemoryWall
          key={datasetIdentity}
          appMode={appMode}
          plan={appMode ? wallPlan : undefined}
          viewVersion={viewSettledCount}
          memoriesReady={memoriesReady}
          memoriesError={memoriesError}
          map={mapInstance}
          dataset={dataset}
          frame={wallFrame}
          regions={memoryRegions}
          page={wallPage}
          onPageChange={onWallPageChange ?? (() => {})}
          selectedRegionId={selectedRegionId}
          showCards={showMemoryCards}
          unassigned={unassignedPages}
          unassignedLabel={unassignedLabel}
          onSelectRegion={handleSelectWithSignal}
          onDrillRegion={onDrillRegion}
          onOpenPage={onOpenPage}
          onOpenStack={onOpenStack ?? (() => {})}
          onCoverPageIdsChange={appMode ? undefined : onCoverPageIdsChange}
          onDisplayedCoverIdsChange={handleWallDisplayedIds}
          onHoverRegions={handleHoverRegions}
          hoveredMapRegionId={hoveredMapRegionId}
        />
        {appMode ? (
          <div className="atlas-app-level-row">
            {selectedRegionId && dataset.level !== "city" && onDrillRegion ? (
              <button
                type="button"
                className="atlas-app-pill"
                onClick={() => onDrillRegion(selectedRegionId)}
              >
                <span>
                  进入
                  {dataset.regions.find((region) => region.regionId === selectedRegionId)
                    ?.name ?? "该地区"}
                </span>
                <ArrowRight size={14} aria-hidden="true" />
              </button>
            ) : (
              <span className="atlas-app-pill-caption">
                {dataset.level === "city" ? "城市概览 · 点选地点查看笔记" : "点选地区查看笔记"}
              </span>
            )}
          </div>
        ) : null}
      </div>
      {appMode ? (
        <AtlasAppPanel
          band={appBand}
          level={dataset.level}
          regions={memoryRegions}
          bandRegions={bandRegions}
          unassigned={unassignedPages}
          unassignedLabel={unassignedLabel}
          selectedRegionId={selectedRegionId}
          selectionSignal={appSelection}
          plan={wallPlan}
          memoriesReady={memoriesReady}
          memoriesError={memoriesError}
          onSelectRegion={handleSelectWithSignal}
          onDrillRegion={onDrillRegion}
          onOpenPage={onOpenPage}
          onPageChange={onWallPageChange}
          onVisibleNoteIdsChange={handlePanelNoteDemand}
        />
      ) : null}
      {harborMagnifier ? (
        <svg className="atlas-harbor-connector" aria-hidden="true">
          <line ref={harborConnectorRef} />
        </svg>
      ) : null}
      {harborMagnifier && wallFrame.harbor ? (
        <div
          className={`memory-wall-harbor${wallFrame.harbor.height < 160 ? " is-compact" : ""}`}
          style={{
            left: wallFrame.harbor.x,
            top: wallFrame.harbor.y,
            width: wallFrame.harbor.width,
            height: wallFrame.harbor.height
          }}
        >
          <HarborMagnifier
            data={harborMagnifier}
            selectedRegionId={selectedRegionId}
            onSelectRegion={onSelectRegion}
            onDrillRegion={onDrillRegion}
          />
        </div>
      ) : null}
      {failed ? (
        <p className="atlas-state-note" role="alert">
          地图引擎初始化失败，请重新打开地图。
        </p>
      ) : null}
    </div>
  );
}
