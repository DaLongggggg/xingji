"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, Loader2, MapPin } from "lucide-react";
import { findRegion, REGION_CATALOG } from "@/features/regions/region-catalog";
import {
  extractGpsCoordinates,
  isSupportedGpsDatum,
  type PhotoGpsCoordinate
} from "@/features/journal/exif-gps";
import {
  canonicalRegionIdSet,
  matchPhotoLocation,
  type PhotoLocationMatch,
  type RegionGeometryEntry
} from "@/features/regions/photo-location";
import { ATLAS_ENDPOINT } from "@/features/atlas/atlas-package-manifest";
import { wgs84ToGcj02 } from "@/features/regions/gcj02";
import type { NotebookMediaGps, NotebookPage } from "./notebook-model";
import type { NotebookRepository } from "./notebook-repository";

/**
 * 照片位置识别区（M1.5）：读取当前篇照片的 EXIF GPS，匹配行政区后给出
 * **按地区分组**的候选（每地区列出支持照片与精确/近似命中）；点击候选 =
 * 地区进草稿 + 向父层登记来源贡献（photo-confirm）。
 *
 * 边界（方案 §10bis + 夜间任务书）：
 * - 只读照片字节与既有边界数据包；确认只改草稿与待存来源，
 *   明确选择触发父层原命令保存（失败不宣称已落库）；
 * - 已在草稿中的地区不再作为候选/规则目标（不覆盖手动选择）；
 * - 无 GPS / 失败 / 不支持基准 / 未授权：说明结果，不阻塞任何操作；
 * - 位置 ≠ 到访：文案只用「识别到」。
 */

const MAX_PHOTOS_TO_SCAN = 10;


type BoundaryFeatureLite = { regionId: string; sourceRegionId: string; geometry: unknown };

/** 进程内边界几何缓存：省列表 + 按省城市（同一会话内反复识别不重复下载）。 */
const PROVINCE_GEOMETRIES: { entries: RegionGeometryEntry[]; loaded: boolean } = {
  entries: [],
  loaded: false
};
const CITY_GEOMETRIES_BY_PROVINCE = new Map<string, RegionGeometryEntry[]>();

const CATALOG_BY_SOURCE = new Map(
  REGION_CATALOG.regions.flatMap((region) => {
    const pairs: [string, string][] = [[region.sourceRegionId, region.regionId]];
    if (region.sourceFile && region.sourceFile !== region.sourceRegionId) {
      pairs.push([region.sourceFile, region.regionId]);
    }
    return pairs;
  })
);

/** 分片读取结果三分：ok / missing（404=分片序列结束，正常）/ unavailable（失败）。 */
type BoundaryFetchResult =
  | { status: "ok"; features: BoundaryFeatureLite[] }
  | { status: "missing" }
  | { status: "unavailable" };

async function fetchBoundaryDataset(resource: string): Promise<BoundaryFetchResult> {
  try {
    const response = await fetch(`${ATLAS_ENDPOINT}/${resource}`, {
      headers: { accept: "application/json" }
    });
    // 404 = 分片序列到此为止（各省分片数不同）：正常的结束信号，不是故障。
    if (response.status === 404) return { status: "missing" };
    if (!response.ok) return { status: "unavailable" };
    const body = (await response.json()) as {
      features?: {
        properties?: { xingjiSourceRegionId?: string; id?: string | number };
        geometry?: unknown;
      }[];
    };
    if (!body.features) return { status: "unavailable" };
    return {
      status: "ok",
      features: body.features
        .filter((feature) => Boolean(feature.geometry))
        .map((feature) => ({
          regionId: String(feature.properties?.xingjiSourceRegionId ?? feature.properties?.id ?? ""),
          sourceRegionId: String(
            feature.properties?.xingjiSourceRegionId ?? feature.properties?.id ?? ""
          ),
          geometry: feature.geometry
        }))
    };
  } catch {
    return { status: "unavailable" };
  }
}

/** 边界来源 ID → 应用 RegionId（与地图槽位同一映射约定：先到先得=手写条目优先）。 */
function appIdOfSource(sourceRegionId: string): string | null {
  return CATALOG_BY_SOURCE.get(sourceRegionId) ?? null;
}

async function loadProvinceEntries(): Promise<RegionGeometryEntry[]> {
  if (!PROVINCE_GEOMETRIES.loaded) {
    const result = await fetchBoundaryDataset("cn-provinces.json");
    if (result.status === "ok") {
      PROVINCE_GEOMETRIES.entries = result.features
        .map((feature) => ({
          regionId: appIdOfSource(feature.sourceRegionId) ?? feature.regionId,
          level: "province" as const,
          geometry: feature.geometry as RegionGeometryEntry["geometry"]
        }))
        // 只保留能映射到应用目录的省（港澳台等无城市目录的省级也可关联）。
        .filter((entry) => findRegion(entry.regionId) !== undefined);
      PROVINCE_GEOMETRIES.loaded = true;
    }
  }
  return PROVINCE_GEOMETRIES.entries;
}

/**
 * 城市几何按省加载；**任何分片读取失败都返回 null 且不缓存**——
 * 失败被缓存会让本次会话永远只给省级候选（M1.5 复审 P2）。
 */
async function loadCityEntries(provinceAppId: string): Promise<RegionGeometryEntry[] | null> {
  const cached = CITY_GEOMETRIES_BY_PROVINCE.get(provinceAppId);
  if (cached) return cached;
  const province = findRegion(provinceAppId);
  if (!province) return null;
  const cities: RegionGeometryEntry[] = [];
  // 清单命名与数据包生成脚本一致：c-p-<来源编号>-<序>.json（序号连续，404 即止）。
  for (let index = 1; index <= 8; index += 1) {
    const result = await fetchBoundaryDataset(`c-p-${province.sourceRegionId}-${index}.json`);
    if (result.status === "missing") break;
    if (result.status === "unavailable") return null;
    cities.push(
      ...result.features
        .map((feature) => ({
          regionId: appIdOfSource(feature.sourceRegionId) ?? feature.regionId,
          level: "city" as const,
          geometry: feature.geometry as RegionGeometryEntry["geometry"]
        }))
        .filter((entry) => findRegion(entry.regionId) !== undefined)
    );
  }
  CITY_GEOMETRIES_BY_PROVINCE.set(provinceAppId, cities);
  return cities;
}

/** 单张照片的识别结果（分组展示与来源贡献共用）。 */
type PhotoOutcome =
  | { kind: "located"; matches: PhotoLocationMatch[] }
  | { kind: "no-gps" }
  | { kind: "unsupported-datum"; datum: string };

export function PagePhotoLocation({
  page,
  repository,
  draftRegionIds,
  onAddRegion,
  disabled = false,
  actionSlot
}: {
  page: NotebookPage;
  repository: NotebookRepository;
  disabled?: boolean;
  /** 仅把识别入口放入标题工具栏，扫描与候选仍由本组件管理。 */
  actionSlot?: HTMLElement | null;
  /** 当前地区草稿（含手动已选）：已在草稿中的地区不再作为候选出现。 */
  draftRegionIds: string[];
  /**
   * 加入地区草稿；`contribution` 非空时父层登记来源记录
   * （kind 区分人工确认与规则产生；mediaIds = 贡献照片）。
   */
  onAddRegion: (
    regionId: string,
    contribution?: { kind: "photo-confirm" | "rule"; mediaIds: string[] }
  ) => void;
}) {
  const [state, setState] = useState<{
    kind: "idle" | "scanning" | "empty" | "error";
    reason?: string;
    message?: string;
  }>({ kind: "idle" });
  /** 匹配完成后的展示数据（regionId 去重后的匹配 + 每张照片的结果）。 */
  const [scanResult, setScanResult] = useState<{
    matches: PhotoLocationMatch[];
    photoOutcomes: { mediaId: string; name: string; outcome: PhotoOutcome }[];
    cityUnavailable: boolean;
  } | null>(null);

  const photoMediaIds = useMemo(
    () =>
      page.blocks
        .flatMap((block) => (block.type === "photo" ? [block.mediaId] : []))
        .slice(0, MAX_PHOTOS_TO_SCAN),
    [page]
  );

  const scanTokenRef = useRef(0);
  /** 当前页面 ID：确认/保存等异步结果只允许作用于发起时的页面。 */
  const pageIdRef = useRef(page.id);
  /** 最近一次扫描的地区贡献（确认时持久化原始坐标并登记来源）。 */
  const contributionsRef = useRef<
    Map<string, { mediaId: string; name: string; original: PhotoGpsCoordinate; basis: "inside" | "near" }[]>
  >(new Map());
  const [persistError, setPersistError] = useState<string | null>(null);

  useEffect(() => {
    pageIdRef.current = page.id;
    setState({ kind: "idle" });
    setScanResult(null);
    scanTokenRef.current += 1;
    contributionsRef.current = new Map();
    setPersistError(null);
  }, [page.id]);

  const scan = useCallback(async () => {
    const token = ++scanTokenRef.current;
    if (photoMediaIds.length === 0) {
      setScanResult(null);
      setState({ kind: "empty", reason: "这一篇还没有照片。" });
      return;
    }
    setState({ kind: "scanning" });
    setScanResult(null);
    try {
      const namesById = new Map(
        (await repository.loadMediaMetadata()).map((item) => [item.id, item.name] as const)
      );
      const located: {
        mediaId: string;
        name: string;
        original: PhotoGpsCoordinate;
      }[] = [];
      const photoOutcomes: { mediaId: string; name: string; outcome: PhotoOutcome }[] = [];
      const unsupportedDatums: string[] = [];
      const blobs = await repository.loadMediaBlobs(photoMediaIds);
      for (let index = 0; index < photoMediaIds.length; index += 1) {
        const mediaId = photoMediaIds[index];
        const name = namesById.get(mediaId) ?? "照片";
        const blob = blobs[index];
        if (!blob) {
          photoOutcomes.push({ mediaId, name, outcome: { kind: "no-gps" } });
          continue;
        }
        // PNG/WebP/HEIC 的元数据位置不同，交给统一读取器读取完整来源；不解码像素。
        const gps = await extractGpsCoordinates(blob);
        if (!gps) {
          photoOutcomes.push({ mediaId, name, outcome: { kind: "no-gps" } });
          continue;
        }
        // GPSMapDatum 可声明非 WGS-84 基准（CIPA 允许 TOKYO 等）：明确不支持
        // 的声明跳过匹配并说明；缺失声明按 WGS-84 工程假定（非已核实）。
        if (!isSupportedGpsDatum(gps.datum)) {
          unsupportedDatums.push(gps.datum ?? "");
          photoOutcomes.push({
            mediaId,
            name,
            outcome: { kind: "unsupported-datum", datum: gps.datum ?? "" }
          });
          continue;
        }
        photoOutcomes.push({ mediaId, name, outcome: { kind: "located", matches: [] } });
        // EXIF 是 WGS-84；边界数据推定 GCJ-02（上游谱系，未权威核对）——
        // 匹配前显式转换；转换只用于匹配，持久化保存原始坐标。
        located.push({ mediaId, name, original: gps });
      }
      if (token !== scanTokenRef.current) return;

      if (located.length === 0) {
        setState({
          kind: "empty",
          reason:
            unsupportedDatums.length > 0
              ? "照片坐标基准暂不支持。"
              : "照片没有可读取的拍摄位置。"
        });
        setScanResult({ matches: [], photoOutcomes, cityUnavailable: false });
        return;
      }
      const provinces = await loadProvinceEntries();
      if (token !== scanTokenRef.current) return;
      if (provinces.length === 0) {
        setState({ kind: "error", message: "地区边界数据不可用，暂不能按位置识别。" });
        return;
      }
      const all: PhotoLocationMatch[] = [];
      /** regionId → 贡献照片（含原始坐标与命中方式）。 */
      const contributions = new Map<
        string,
        { mediaId: string; name: string; original: PhotoGpsCoordinate; basis: "inside" | "near" }[]
      >();
      let cityUnavailable = false;
      for (const source of located) {
        const point = wgs84ToGcj02(source.original);
        const provincial = matchPhotoLocation(point, provinces, CITY_GEOMETRIES_BY_PROVINCE);
        const provinceId = provincial[0]?.regionId;
        if (provinceId && !CITY_GEOMETRIES_BY_PROVINCE.has(provinceId)) {
          const cities = await loadCityEntries(provinceId);
          if (cities) {
            CITY_GEOMETRIES_BY_PROVINCE.set(provinceId, cities);
          } else {
            // 读取失败不缓存：本次只给省级候选并明示原因，下次识别重试。
            cityUnavailable = true;
          }
        }
        const pointMatches = matchPhotoLocation(point, provinces, CITY_GEOMETRIES_BY_PROVINCE);
        for (const match of pointMatches) {
          const list = contributions.get(match.regionId) ?? [];
          if (!list.some((item) => item.mediaId === source.mediaId)) {
            list.push({ ...source, basis: match.basis });
          }
          contributions.set(match.regionId, list);
        }
        all.push(...pointMatches);
        // located 的 per-photo matches 回填（分组展示用）。
        const entry = photoOutcomes.find((item) => item.mediaId === source.mediaId);
        if (entry && entry.outcome.kind === "located") entry.outcome.matches = pointMatches;
        if (token !== scanTokenRef.current) return;
      }
      const seen = new Set<string>();
      const unique = all.filter((match) => {
        if (seen.has(match.regionId)) return false;
        seen.add(match.regionId);
        return true;
      });
      contributionsRef.current = contributions;
      setState({ kind: "idle" });
      setScanResult({ matches: unique, photoOutcomes, cityUnavailable });
      if (unique.length === 0 && located.length > 0) {
        setState({ kind: "empty", reason: "拍摄位置不在已收录的行政区范围内。" });
      }
    } catch (error) {
      if (token !== scanTokenRef.current) return;
      setState({
        kind: "error",
        message: error instanceof Error ? `位置识别失败：${error.message}` : "位置识别失败。"
      });
    }
  }, [photoMediaIds, repository]);

  /** 批量持久化一组照片的原始 WGS-84 坐标（确认/独立保存共用）。 */
  const persistGps = useCallback(
    async (sources: { mediaId: string; original: PhotoGpsCoordinate }[]): Promise<number> => {
      if (sources.length === 0) return 0;
      const confirmedAt = new Date().toISOString();
      const written = await repository.updateMediaGps(
        sources.map((source) => ({
          mediaId: source.mediaId,
          gps: {
            lat: source.original.lat,
            lng: source.original.lng,
            datum: "WGS-84",
            datumBasis: source.original.datum === null ? "presumed" : "declared",
            capturedFrom: "exif",
            confirmedAt
          } satisfies NotebookMediaGps
        }))
      );
      return written;
    },
    [repository]
  );

  /**
   * 确认候选 = 一次显式确认动作：地区草稿**同步**追加（切篇不串）；贡献照片
   * 原始坐标写入共享媒体记录；来源登记为 photo-confirm（由父层随保存落库）。
   * 位置保存失败不阻塞地区确认：分别提示。
   */
  const confirmCandidate = useCallback(
    async (regionId: string) => {
      const sources = contributionsRef.current.get(regionId) ?? [];
      onAddRegion(
        regionId,
        sources.length > 0
          ? { kind: "photo-confirm", mediaIds: sources.map((item) => item.mediaId) }
          : undefined
      );
      const clickedPageId = pageIdRef.current;
      if (sources.length === 0) return;
      try {
        await persistGps(sources);
        if (pageIdRef.current !== clickedPageId) return;
        setPersistError(null);
      } catch (error) {
        if (pageIdRef.current !== clickedPageId) return;
        setPersistError(error instanceof Error ? error.message : "照片位置保存失败。");
      }
    },
    [onAddRegion, persistGps]
  );

  /** 候选（按地区分组）：草稿已有的地区不出现（规范键比较，双 ID 归一）。 */
  const draftCanonical = canonicalRegionIdSet(draftRegionIds);
  const candidateGroups = (scanResult?.matches ?? [])
    .filter((match) => !draftCanonical.has(match.regionId))
    .map((match) => ({
      ...match,
      region: findRegion(match.regionId),
      photos: contributionsRef.current.get(match.regionId) ?? []
    }))
    .filter((group) => group.region !== undefined);
  const noGpsPhotos = (scanResult?.photoOutcomes ?? []).filter(
    (item) => item.outcome.kind === "no-gps"
  );
  const unsupportedPhotos = (scanResult?.photoOutcomes ?? []).filter(
    (item) => item.outcome.kind === "unsupported-datum"
  );

  const trigger = <button type="button" className="nb-icon-button"
    aria-label="从照片识别地区" title={state.kind === "scanning" ? "识别中…" : "从照片识别地区"}
    onClick={() => void scan()} disabled={disabled || state.kind === "scanning"}>
    {state.kind === "scanning" ? <Loader2 size={16} className="is-spinning" aria-hidden /> : <Camera size={16} aria-hidden />}
  </button>;

  return (
    <div className="nb-photo-location" data-testid="photo-location">
      {actionSlot ? createPortal(trigger, actionSlot) : trigger}
      {state.kind === "empty" ? <p className="notebook-readonly">{state.reason}</p> : null}
      {state.kind === "error" ? (
        <p className="notebook-error" role="alert">
          {state.message}
        </p>
      ) : null}

      {candidateGroups.length > 0 ? (
          <ul className="nb-photo-location-candidates" aria-label="照片位置识别候选">
            {candidateGroups.map((group) => (
              <li key={group.regionId} className="nb-photo-location-group">
                <button
                  type="button"
                  className="nb-photo-location-chip"
                  data-level={group.region!.level}
                  title={`关联${group.region!.name} · ${group.photos.map((photo) => photo.name).join("、")}`}
                  disabled={disabled}
                  onClick={() => void confirmCandidate(group.regionId)}
                >
                  <MapPin size={13} aria-hidden />
                  <span>{group.region!.name}</span>
                  {group.basis === "near" ? <small>近似</small> : null}
                </button>
              </li>
            ))}
          </ul>
      ) : null}

      {noGpsPhotos.length > 0 && state.kind !== "empty" ? (
        <p className="notebook-readonly">
          {noGpsPhotos.length} 张照片无位置信息。
        </p>
      ) : null}
      {unsupportedPhotos.length > 0 && state.kind !== "empty" ? (
        <p className="notebook-readonly">
          {unsupportedPhotos.length} 张照片的坐标基准暂不支持。
        </p>
      ) : null}

      {scanResult?.cityUnavailable ? (
        <p className="notebook-readonly" role="status">
          暂仅识别省份，可稍后重试。
        </p>
      ) : null}
      {persistError ? <p className="notebook-error" role="alert">{persistError}</p> : null}
    </div>
  );
}
