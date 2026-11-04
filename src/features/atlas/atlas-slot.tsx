"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AtlasBreadcrumb, AtlasMemoryPreview } from "./atlas-overlays";
import type { AtlasDataScope } from "./atlas-contract";
import type { BoundaryProvider } from "./boundary-contract";
import { LeafletRegionAdapter } from "./leaflet-region-adapter";
import { DEFAULT_ATLAS_MAP_STYLE, type AtlasMapStyle } from "./map-style";
import { shortRegionName } from "./region-label-layout";
import { type MemoryNote, type MemoryRegion } from "./region-card-layout";
import { deriveCountyMemories } from "./memory-wall-regions";
import { useAtlasSession } from "./use-atlas-session";
import { createHttpAtlasProvider, loadAtlasManifest } from "./atlas-http-provider";
import { findRegion } from "@/features/regions/region-catalog";
import { PROVINCE_SELF_SOURCE_REGION_IDS } from "./atlas-package-manifest";

/** 一篇笔记的只读摘要（地区统计与预览共用，不包含媒体二进制）。 */
export type AtlasPageSummary = {
  pageId: string;
  title: string;
  capturedAt: string;
  notebookTitle: string;
};

/**
 * 014-C 地区统计视图：由 regions 聚合层提供，地图只渲染。
 * - ready=false 表示存储未就绪/读取失败 → 显示加载或错误态，**不显示 0**；
 * - mapping 是显式边界映射（来源 regionId → 应用 RegionId）；
 * - pagesByRegion 是去重后的篇（应用 RegionId）、只读。
 */
export type AtlasRegionCounts = {
  ready: boolean;
  errorMessage?: string;
  /**
   * 应用目录 → 边界来源的映射描述符（sourceId 用**当前数据集自报**的值）。
   * 不在这里固化供应商命名空间，换源也不会改变已存业务 ID。
   */
  boundarySource: { sourceId: string; sourceVersion: string };
  /** 应用 RegionId → 应用目录中的来源编号（用于按数据集 sourceId 组键）。 */
  sourceRegionIdByRegionId: Map<string, string>;
  pagesByRegion: Map<string, AtlasPageSummary[]>;
  /** 应用 RegionId → 去重篇数。 */
  pageCountByRegion: Map<string, number>;
  /** 省内“尚未细分城市”的篇（按省 RegionId 分组）。 */
  provinceOnlyByProvince: Map<string, AtlasPageSummary[]>;
  /** 逐篇只读展示资料；不复制照片字节或改变地区事实。 */
  notesById?: Map<string, MemoryNote>;
  unlocatedPages?: MemoryNote[];
};

export type AtlasSlotProps = {
  dataScope?: AtlasDataScope;

  /** 地区统计（缺省表示关联能力未接入，界面保持原口径）。 */
  regionCounts?: AtlasRegionCounts;

  /** 打开具体笔记（只读详情在首页内展示，不卸载记录输入）。 */
  onOpenPage?: (pageId: string) => void;
  /**
   * 显式定位请求（记忆地图 M1）：笔记侧「在地图中查看」发起。
   * token 变化即视为一次新请求；跨层级下钻由槽位内完成，不自动打开笔记。
   * 消费完成后经 onLocateConsumed 通知父层清除，重挂载不会重放旧请求。
   */
  locateRequest?: { regionId: string; token: number } | null;
  /** 定位请求已消费（完成或无法完成）；父层应清除请求状态。 */
  onLocateConsumed?: () => void;
  onCoverPageIdsChange?: (ids: string[]) => void;
  /** 用户选择的地图显示风格；默认地貌水彩。 */
  mapStyle?: AtlasMapStyle;
};

/**
 * 记录首页的地图槽位：浏览会话 + 展示面板 + Leaflet 适配器。
 * 不接触 capture/notebook 存储；地图切换与查看笔记本都不影响记录草稿、勾选或存入目标。
 * （本轮调整：开发态手动选择边界文件的备用入口已移除，Provider 只走本地数据包自动加载。）
 */
function AtlasSlotComponent({
  dataScope = "development-preview",
  regionCounts,
  onOpenPage,
  locateRequest,
  onLocateConsumed,
  onCoverPageIdsChange,
  mapStyle = DEFAULT_ATLAS_MAP_STYLE
}: AtlasSlotProps) {
  void dataScope;
  /**
   * 同源数据包 Provider：自动加载全国，点省才加载城市。
   * 生产是否可读由服务端的显式数据包配置决定。
   */
  const [autoProvider, setAutoProvider] = useState<BoundaryProvider | null>(null);
  const [autoError, setAutoError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const manifest = await loadAtlasManifest();
        if (cancelled) return;
        setAutoProvider(createHttpAtlasProvider(manifest));
        setAutoError(undefined);
      } catch (error) {
        if (cancelled) return;
        setAutoProvider(null);
        setAutoError(error instanceof Error ? error.message : "地图数据暂不可用。");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const { state, session, retry } = useAtlasSession(autoProvider);
  /** 选中的地区，统一为**应用 RegionId**（未映射的来源 ID 才会是来源值）。 */
  const [preview, setPreview] = useState<{ regionId: string; trigger: HTMLElement } | null>(null);
  const [viewStates, setViewStates] = useState<
    Record<string, { selected: string | null; page: number }>
  >({});
  /** 统计直接来自 props：父组件用稳定元素提交新 props，浏览会话不会被重建。 */
  const counts = regionCounts;
  const dataset = state.stack.length > 0 ? state.stack[state.stack.length - 1] : null;
  const viewKey = dataset
    ? `${dataset.sourceId}|${dataset.level}|${dataset.parentRegionId ?? ""}`
    : "";
  const viewKeyRef = useRef(viewKey);
  useEffect(() => {
    viewKeyRef.current = viewKey;
  }, [viewKey]);
  const selectedRegionId = viewStates[viewKey]?.selected ?? null;
  const wallPage = viewStates[viewKey]?.page ?? 0;
  const setSelectedRegionId = useCallback((selected: string | null) => {
    const key = viewKeyRef.current;
    setViewStates((previous) => ({
      ...previous,
      [key]: { page: previous[key]?.page ?? 0, selected }
    }));
  }, []);
  const setWallPage = useCallback(
    (page: number) => {
      setPreview(null);
      setViewStates((previous) => ({
        ...previous,
        [viewKey]: { selected: previous[viewKey]?.selected ?? null, page }
      }));
    },
    [viewKey]
  );
  const pagesForMemoryRegion = useCallback(
    (id: string): MemoryNote[] =>
      (counts?.pagesByRegion.get(id) ?? []).map(
        (page) => counts?.notesById?.get(page.pageId) ?? page
      ),
    [counts]
  );
  const countyMemories = useMemo(
    () =>
      dataset?.level === "city"
        ? deriveCountyMemories(dataset, pagesForMemoryRegion(dataset.parentRegionId ?? ""))
        : null,
    [dataset, pagesForMemoryRegion]
  );
  // 映射按**实际数据集的 sourceId** 组键：来源命名空间只用于连接几何，不进入业务身份。
  const mapping = new Map<string, string>();
  if (dataset && dataset.level !== "city" && counts?.ready) {
    for (const [regionId, sourceRegionId] of counts.sourceRegionIdByRegionId) {
      const key = `${dataset.sourceId}:${sourceRegionId}`;
      // 先到先得：目录顺序里手写条目（既有 ID）在生成条目之前，
      // 广东 21 市同时存在数字与拼音两套目录身份时，映射到既有 ID。
      if (!mapping.has(key)) mapping.set(key, regionId);
    }
  }

  /**
   * 边界来源 ID → 应用 RegionId。用函数声明（有提升），
   * 这样上面的稳定 holder 初始化也能安全引用它。
   */
  function appIdOf(boundaryRegionId: string): string | null {
    return dataset?.level === "city" ? boundaryRegionId : (mapping.get(boundaryRegionId) ?? null);
  }

  function boundaryIdOf(appRegionId: string): string | null {
    if (dataset?.level === "city") return appRegionId;
    for (const [key, value] of mapping) {
      if (value === appRegionId) return key;
    }
    return null;
  }

  /**
   * 适配器按**边界来源 ID** 查询填充；这里把应用侧去重篇数翻译成边界键。
   * 直接传 `pageCountByRegion`（应用 ID）会让显色永远查不到——
   * 有记录地区保持“暂无关联记录”底色（M1 复审 P1）。
   */
  const pageCountByBoundaryId = useMemo(() => {
    if (!counts?.ready) return undefined;
    const byBoundary = new Map<string, number>();
    if (countyMemories)
      return new Map(
        countyMemories.regions.map((region) => [region.regionId, region.pages.length])
      );
    for (const [boundaryId, appRegionId] of mapping) {
      const count = counts.pageCountByRegion.get(appRegionId);
      if (count !== undefined) byBoundary.set(boundaryId, count);
    }
    return byBoundary;
    // mapping 每次渲染重建但内容由 dataset/counts 决定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset, counts, countyMemories]);

  /**
   * 019：地图回调要读到最新映射/数据集/会话，但回调 identity 必须稳定
   * （identity 变化会重建矢量层）。用 ref 保存最新一份，提交后刷新字段。
   */
  const drillStateRef = useRef({
    appIdOf,
    dataset,
    provider: autoProvider,
    session,
    status: state.status
  });
  useEffect(() => {
    drillStateRef.current.appIdOf = appIdOf;
    drillStateRef.current.dataset = dataset;
    drillStateRef.current.provider = autoProvider;
    drillStateRef.current.session = session;
    drillStateRef.current.status = state.status;
  });

  /** 减少动态跟随系统设置，不再读取已退役的地图显示偏好。 */
  const [motionReduced, setMotionReduced] = useState(
    () =>
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setMotionReduced(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  /**
   * 原位记录预览（点击照片卡后展开）。跨层级切换时关闭：
   * 预览属于某个具体地区，不跟随下钻迁移。
   */
  const previewRegionId = preview?.regionId ?? null;
  const datasetIdentity = dataset
    ? `${dataset.sourceId}|${dataset.level}|${dataset.parentRegionId ?? ""}`
    : "";
  const lastDatasetIdentityRef = useRef(datasetIdentity);
  useEffect(() => {
    if (lastDatasetIdentityRef.current === datasetIdentity) return;
    lastDatasetIdentityRef.current = datasetIdentity;
    setPreview(null);
  }, [datasetIdentity]);

  /** 定位持有整条下钻链的取消权，实际到达后才消费。 */
  const pendingLocateRef = useRef<{
    regionId: string;
    provinceId: string | null;
    controller: AbortController;
  } | null>(null);
  const locateConsumedRef = useRef<(() => void) | null>(null);
  const cancelPendingLocate = useCallback(() => {
    const pending = pendingLocateRef.current;
    pendingLocateRef.current = null;
    pending?.controller.abort();
  }, []);
  const runPendingLocate = useCallback(() => {
    const pending = pendingLocateRef.current;
    if (!pending) return;
    const current = drillStateRef.current;
    // 会话同步置 loading；同一轮多个 effect 推进时不能重复发请求。
    const latest = current.session.getState();
    const top = latest.stack.at(-1);
    if (!current.provider || latest.status !== "ready" || !top) return;
    const atTargetProvince = top.level === "province" && top.parentRegionId === pending.provinceId;
    const arrived =
      (top.level === "city" && top.parentRegionId === pending.regionId) ||
      (atTargetProvince && pending.regionId === pending.provinceId);
    if (arrived) {
      pendingLocateRef.current = null;
      locateConsumedRef.current?.();
      return;
    }
    const isSelfProvince = PROVINCE_SELF_SOURCE_REGION_IDS.some(
      (item) => `xingji-cn:p-${item.sourceRegionId}` === pending.provinceId
    );
    void current.session.drillInto(
      current.provider,
      atTargetProvince ? pending.regionId : (pending.provinceId ?? pending.regionId),
      false,
      atTargetProvince || isSelfProvince,
      pending.controller.signal
    );
  }, []);
  /**
   * 一次性「新增记忆」显色：只有本次挂载期间数据更新**新增**了有记录地区
   * 才触发（初始加载不庆祝）；应用减弱动态时不播放。700ms 后自动还原。
   */
  const knownMemoryRegionsRef = useRef<Set<string> | null>(null);
  const [flashAppRegionIds, setFlashAppRegionIds] = useState<string[]>([]);
  useEffect(() => {
    if (!counts?.ready) return;
    const current = new Set<string>();
    for (const [regionId, count] of counts.pageCountByRegion) {
      if (count > 0) current.add(regionId);
    }
    const previous = knownMemoryRegionsRef.current;
    knownMemoryRegionsRef.current = current;
    if (!previous || motionReduced) return;
    const added = [...current].filter((regionId) => !previous.has(regionId));
    if (added.length === 0) {
      setFlashAppRegionIds([]);
      return;
    }
    setFlashAppRegionIds(added);
    const timer = setTimeout(() => setFlashAppRegionIds([]), 700);
    return () => clearTimeout(timer);
  }, [counts, motionReduced]);
  const flashBoundaryIds = useMemo(
    () =>
      flashAppRegionIds
        .map((regionId) => boundaryIdOf(regionId))
        .filter((regionId): regionId is string => regionId !== null),
    // boundaryIdOf 随当前数据集映射变化；显色只在挂载期数据更新时出现，取当前映射即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flashAppRegionIds, mapping]
  );

  useEffect(() => {
    locateConsumedRef.current = onLocateConsumed ?? null;
  }, [onLocateConsumed]);
  useEffect(() => {
    if (!locateRequest) return;
    const region = findRegion(locateRequest.regionId);
    if (!region) return;
    cancelPendingLocate();
    pendingLocateRef.current = {
      regionId: region.regionId,
      provinceId: region.level === "city" ? region.parentRegionId : region.regionId,
      controller: new AbortController()
    };
    const owner = pendingLocateRef.current.controller;
    // 位置请求来自外部导航；先结束本次提交，再更新对应层的展示选择。
    queueMicrotask(() => {
      if (owner.signal.aborted) return;
      setSelectedRegionId(region.regionId);
      setPreview(null);
    });
    runPendingLocate();
  }, [locateRequest, runPendingLocate, cancelPendingLocate, setSelectedRegionId]);
  useEffect(() => {
    // 下钻是异步的：会话状态每次收敛后再尝试推进未完成的定位。
    runPendingLocate();
  }, [state.status, state.stack, runPendingLocate]);

  const memoryRegions = useMemo<MemoryRegion[]>(() => {
    if (!dataset || !counts?.ready) return [];
    if (countyMemories) return countyMemories.regions;
    return dataset.regions.flatMap((region) => {
      const appId = mapping.get(region.regionId);
      return appId
        ? [{ regionId: region.regionId, name: region.name, pages: pagesForMemoryRegion(appId) }]
        : [];
    });
    // 来源映射由 dataset/counts 确定；不随选择或悬停重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset, counts, countyMemories, pagesForMemoryRegion]);
  const unassignedPages = useMemo(() => {
    if (countyMemories) return countyMemories.unassigned;
    if (dataset?.level === "province" && dataset.parentRegionId)
      return (counts?.provinceOnlyByProvince.get(dataset.parentRegionId) ?? []).map(
        (page) => counts?.notesById?.get(page.pageId) ?? page
      );
    return dataset?.level === "national" ? (counts?.unlocatedPages ?? []) : [];
  }, [dataset, counts, countyMemories]);
  const handleSelectMemoryCard = useCallback(
    (boundaryRegionId: string, trigger: HTMLElement) => {
      if (boundaryRegionId === "unassigned" || boundaryRegionId === "all") {
        setPreview({ regionId: boundaryRegionId, trigger });
        return;
      }
      const appRegionId = drillStateRef.current.appIdOf(boundaryRegionId);
      if (!appRegionId) return;
      setSelectedRegionId(appRegionId);
      setPreview({ regionId: appRegionId, trigger });
    },
    [setSelectedRegionId]
  );
  const handleClosePreview = useCallback(() => setPreview(null), []);
  const handlePreviewOpenPage = useCallback(
    (pageId: string) => {
      setPreview(null);
      onOpenPage?.(pageId);
    },
    [onOpenPage]
  );

  const selectedBoundaryId = selectedRegionId ? boundaryIdOf(selectedRegionId) : null;
  /**
   * 双击地区面下钻：全国→省、省内→市（区县）。县面双击不动作（019 规则不变）。
   * 用 ref 读取最新数据集/会话，回调引用稳定，避免矢量层重建。
   */
  const handleMapDrillRegion = useCallback(
    (boundaryRegionId: string) => {
      const current = drillStateRef.current;
      if (!current.dataset || current.dataset.level === "city" || current.status !== "ready")
        return;
      const appId = current.appIdOf(boundaryRegionId);
      if (!appId || !current.dataset.regions.some((region) => region.regionId === boundaryRegionId))
        return;
      cancelPendingLocate();
      setSelectedRegionId(appId);
      const selfProvince = PROVINCE_SELF_SOURCE_REGION_IDS.some(
        (item) => `xingji-cn:p-${item.sourceRegionId}` === appId
      );
      void current.session.drillInto(
        current.provider,
        appId,
        false,
        current.dataset.level === "province" || selfProvince
      );
    },
    [cancelPendingLocate, setSelectedRegionId]
  );

  /**
   * 地图点击：**只选择**。下钻只由双击或显式按钮触发，
   * 因此普通单击不会改变数据集，也不会打断用户正在看的细节。
   */
  const handleMapSelectRegion = useCallback(
    (boundaryRegionId: string) => {
      setSelectedRegionId(drillStateRef.current.appIdOf(boundaryRegionId) ?? boundaryRegionId);
    },
    [setSelectedRegionId]
  );

  /**
   * 019：逐级返回。省内→全国；区县→所属省（直辖市/港澳没有中间层，直接回全国）。
   * 延后一帧：Leaflet 缩放动画期间同步切数据集会让画布渲染器在已释放的上下文上重绘。
   */
  const handleBackRequest = useCallback(() => {
    cancelPendingLocate();
    requestAnimationFrame(() => {
      const current = drillStateRef.current;
      if (current.dataset?.level === "city") current.session.back();
      else current.session.backToNational();
    });
  }, [cancelPendingLocate]);

  /**
   * 面包屑点击返回（4.2）：恢复对应层级，不无限重置到全国。
   * items 结构 = [全国, 省, 市]：index 0 → 全国；index 1 → 从区县视图回到省。
   */
  const handleBreadcrumbLevel = useCallback(
    (levelIndex: number) => {
      cancelPendingLocate();
      requestAnimationFrame(() => {
        const current = drillStateRef.current;
        if (levelIndex <= 0) {
          current.session.backToNational();
          return;
        }
        if (current.dataset?.level === "city") current.session.back();
      });
    },
    [cancelPendingLocate]
  );

  /**
   * 016 悬停标签候选：全国视图=省名，省级视图=城市名。
   * regionId 用**边界来源 ID**，几何取自当前数据集。
   */
  const mapLabels = useMemo(
    () =>
      (dataset?.regions ?? []).map((region) => ({
        regionId: region.regionId,
        // 全国图上的长自治区名收成短名；省/市/县层保留完整名称，避免县级“市/区”歧义。
        name: dataset?.level === "national" ? shortRegionName(region.name) : region.name
      })),
    [dataset]
  );
  const highlightedSourceIds = dataset
    ? dataset.regions
        .filter((region) => {
          const appId = mapping?.get(region.regionId);
          return appId ? (counts?.pagesByRegion.get(appId)?.length ?? 0) > 0 : false;
        })
        .map((region) => region.regionId)
    : [];

  /**
   * 下钻后的返回路径：层级由浏览会话决定，不猜 zoom。
   * 全国不显示路径；未细分城市的记录仍通过底部完整列表访问。
   */
  const breadcrumbItems =
    state.stack.length > 1
      ? [
          "全国",
          ...state.stack
            .slice(1)
            .map((item) => findRegion(item.parentRegionId ?? "")?.name ?? "地区")
        ]
      : ["全国"];

  const allScopePages = [
    ...new Map(
      [...memoryRegions.flatMap((region) => region.pages), ...unassignedPages].map((page) => [
        page.pageId,
        page
      ])
    ).values()
  ];
  const previewPages =
    previewRegionId === "all"
      ? allScopePages
      : previewRegionId === "unassigned"
        ? unassignedPages
        : previewRegionId
          ? countyMemories
            ? (countyMemories.regions.find((region) => region.regionId === previewRegionId)
                ?.pages ?? [])
            : (counts?.pagesByRegion.get(previewRegionId) ?? [])
          : [];
  const unassignedLabel =
    dataset?.level === "national"
      ? "未定位笔记"
      : dataset?.level === "city"
        ? "尚未细分区县"
        : "尚未细分城市";
  const previewRegionName =
    previewRegionId === "all"
      ? "本视图全部笔记"
      : previewRegionId === "unassigned"
        ? unassignedLabel
        : dataset?.regions.find(
            (region) => (appIdOf(region.regionId) ?? region.regionId) === previewRegionId
          )?.name;

  const status = state.status === "idle" ? "unavailable" : state.status;

  /**
   * 本轮调整：开发态「备用：手动选择本地边界文件」入口与过时的
   * 「行政区地图尚未接入」提示已移除；地图独立轻提示保留真实状态说明
   * （生产未配置 / 自动加载失败 / 加载中 / 出错重试）。
   */
  const mapStatus = (
    <>
      {autoError ? (
        <p className="atlas-state-note" role="alert">
          {autoError}
        </p>
      ) : null}
      {status === "loading" ? <p className="atlas-state-note">正在准备地图…</p> : null}
      {status === "error" ? (
        <div className="atlas-state" role="alert">
          <p>{state.errorMessage ?? "地图加载失败。"}</p>
          <button
            type="button"
            className="secondary-button"
            onClick={() => retry(pendingLocateRef.current?.controller.signal)}
          >
            重试
          </button>
        </div>
      ) : null}
    </>
  );
  return (
    <div className="atlas-slot atlas-slot--map">
      <div className="atlas-map-header">
        {dataset && dataset.level !== "national" ? (
          <div className="atlas-map-context">
            <AtlasBreadcrumb
              items={breadcrumbItems}
              onLevelClick={handleBreadcrumbLevel}
            />
          </div>
        ) : null}
        <div className="atlas-map-status">
          {mapStatus}
        </div>
      </div>
      {dataset ? (
        <LeafletRegionAdapter
          dataset={dataset}
          // 适配器比较的是**边界数据集**里的 regionId，因此这里显式映射回来源 ID；
          // 未映射的边界（例如没有目录的城市）退回自身，保持“选中可见、篇数未知”。
          selectedRegionId={selectedBoundaryId ?? selectedRegionId}
          highlightedRegionIds={highlightedSourceIds}
          pageCountByRegionId={pageCountByBoundaryId}
          provinceRegionId={dataset.parentRegionId ? boundaryIdOf(dataset.parentRegionId) : null}
          labels={mapLabels}
          onSelectRegion={handleMapSelectRegion}
          onDrillRegion={handleMapDrillRegion}
          onBackRequest={handleBackRequest}
          memoryRegions={memoryRegions}
          memoriesReady={Boolean(counts?.ready)}
          memoriesError={counts?.errorMessage}
          wallPage={wallPage}
          onWallPageChange={setWallPage}
          unassignedPages={unassignedPages}
          unassignedLabel={unassignedLabel}
          onOpenPage={onOpenPage}
          onOpenStack={handleSelectMemoryCard}
          onCoverPageIdsChange={onCoverPageIdsChange}
          flashRegionIds={flashBoundaryIds}
          motionReduced={motionReduced}
          mapStyle={mapStyle}
        />
      ) : (
        <div className="atlas-map atlas-map--placeholder" aria-hidden="true" />
      )}

      {preview && previewPages.length > 0 && previewRegionName ? (
        <AtlasMemoryPreview
          key={preview.regionId}
          regionName={previewRegionName}
          pages={previewPages}
          trigger={preview.trigger}
          motionReduced={motionReduced}
          nightMode={false}
          onOpenPage={handlePreviewOpenPage}
          onClose={handleClosePreview}
        />
      ) : null}
    </div>
  );
}

/**
 * 016：AtlasSlot 自身 memo。
 * 父组件每次渲染都会重建 `atlasSlot` 元素；若每次都用新元素渲染，
 * 组件会被当作新树处理，浏览会话与在途边界加载都会丢。
 * memo 让 props 未变时直接跳过，同时篇数变化仍能作为新 props 提交。
 */
export const AtlasSlot = memo(AtlasSlotComponent);
