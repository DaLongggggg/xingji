"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTimedNotice } from "@/lib/use-timed-notice";
import { MapPin, Trash2 } from "lucide-react";
import type { NotebookRegionRef } from "./notebook-model";
import {
  canonicalRegionId,
  findRegion,
  listCities,
  listProvinces,
  REGION_CATALOG
} from "@/features/regions/region-catalog";
import { resolveStoredRegion } from "@/features/regions/region-boundary-map";

export type PageRegionsEditorProps = {
  pageId: string;
  /** 已存地区（可能包含旧/未知 ID）。 */
  regions: NotebookRegionRef[];
  /** 当前档案 revision；打开编辑时冻结为保存基线。 */
  revision: number;
  busy?: boolean;
  /**
   * 保存由上层命令执行：传入编辑时冻结的 revision。
   * 期间其他实例提交过会明确冲突；返回错误信息则保留草稿。
   */
  onSave: (
    regionIds: string[],
    expectedRevision: number
  ) => Promise<{ ok: boolean; message?: string; revision?: number }>;
};

/**
 * 从已有关联推断打开时默认停留的省份（第一篇关联城市/省所属的省）。
 */
function initialProvinceId(regionIds: string[]): string {
  for (const regionId of regionIds) {
    const region = findRegion(regionId, REGION_CATALOG);
    if (region?.level === "city" && region.parentRegionId) return region.parentRegionId;
    if (region?.level === "province") return region.regionId;
  }
  return listProvinces(REGION_CATALOG)[0]?.regionId ?? "";
}

/**
 * 本轮调整：先选省、再进入该省城市列表的两级选择器。
 *
 * - 省份列表只负责“进入哪个省”，不再直接勾选；
 * - 保留“全省（省级关联）”，具体地市通过下拉添加；选完可用下拉框
 *   切换其他省，已选项统一在外层“已选地区”里展示与移除；
 * - 直辖市/港澳没有城市目录：进入后只有省级关联一项，不伪造市级目录。
 */
function RegionStepPicker({
  draftIds,
  onToggle
}: {
  draftIds: string[];
  onToggle: (regionId: string) => void;
}) {
  const [step, setStep] = useState<"province" | "city">("province");
  const [cityProvinceId, setCityProvinceId] = useState(() => initialProvinceId(draftIds));
  const selectedIds = useMemo(() => new Set(draftIds.map(canonicalRegionId)), [draftIds]);

  const provinceCities = useMemo(
    () => listCities(cityProvinceId, REGION_CATALOG),
    [cityProvinceId]
  );
  const currentProvince = useMemo(
    () => findRegion(cityProvinceId, REGION_CATALOG),
    [cityProvinceId]
  );
  /** 各省已选数量（省级关联与该省城市合并计），在省份行上做标记。 */
  const selectedPerProvince = useMemo(() => {
    const counts = new Map<string, number>();
    for (const regionId of selectedIds) {
      const region = findRegion(regionId, REGION_CATALOG);
      if (!region) continue;
      const provinceId =
        region.level === "city" ? region.parentRegionId ?? "" : region.regionId;
      if (provinceId) counts.set(provinceId, (counts.get(provinceId) ?? 0) + 1);
    }
    return counts;
  }, [selectedIds]);

  const provinceSelect = (
    <label className="page-regions-province-select">
      <span>选择省份</span>
      <select aria-label="选择省份" title="选择省份" value={step === "city" ? cityProvinceId : ""} onChange={event => {
        setCityProvinceId(event.target.value);
        setStep(event.target.value ? "city" : "province");
      }}>
        <option value="">请选择省份</option>
        {listProvinces(REGION_CATALOG).map(province => {
          const count = selectedPerProvince.get(province.regionId) ?? 0;
          return <option key={province.regionId} value={province.regionId}>{province.name}{count ? `（已选 ${count}）` : ""}</option>;
        })}
      </select>
    </label>
  );
  return (
    <div className="page-regions-picker" data-testid={step === "province" ? "region-province-step" : "region-city-step"}>
      <div className="page-regions-column">
        <div className="page-regions-select-row">
          {provinceSelect}
          <label className="page-regions-province-select">
            <span>选择地市</span>
            <select aria-label="选择地市" title="选择地市" value="" disabled={step !== "city" || provinceCities.length === 0} onChange={event => {
              const id = event.target.value;
              if (id && !selectedIds.has(canonicalRegionId(id))) onToggle(id);
            }}>
              <option value="">请选择地市</option>
              {provinceCities.map(city => (
                <option key={city.regionId} value={city.regionId} disabled={selectedIds.has(canonicalRegionId(city.regionId))}>
                  {city.name}{selectedIds.has(canonicalRegionId(city.regionId)) ? "（已选）" : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        {step === "city" && currentProvince ? <ul className="page-regions-step-list">
          <li><label title={`关联${currentProvince.name}全省`}>
            <input type="checkbox" checked={selectedIds.has(cityProvinceId)}
              onChange={() => onToggle(cityProvinceId)} aria-label={`选择省份 ${currentProvince.name}`} />
            全省
          </label></li>
        </ul> : null}
      </div>
    </div>
  );
}

/**
 * 014-C 地区关联编辑器（独立篇）。
 *
 * - 省市多选（先选省再选市），已选项可逐项移除或清空；
 * - 未知/旧 ID 显示“地区待匹配”，只能显式移除，不会被名称猜测替换；
 * - 取消即丢弃草稿；保存失败保留草稿，不先显示成功；
 * - 只设置地区：不改正文、媒体、来源关联与其他元数据。
 */
export function PageRegionsEditor({
  pageId,
  regions,
  revision,
  busy,
  onSave
}: PageRegionsEditorProps) {
  const [open, setOpen] = useState(false);
  /**
   * 打开编辑时冻结的 revision：保存必须以它为基线。
   * 若打开期间其他实例已提交，会明确冲突并保留草稿，而不是用最新 revision 覆盖对方。
   */
  const [baselineRevision, setBaselineRevision] = useState(revision);
  const [draftIds, setDraftIds] = useState<string[]>(regions.map((ref) => ref.regionId));
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useTimedNotice();

  const unknownRefs = useMemo(
    () => regions.filter((ref) => resolveStoredRegion(ref, REGION_CATALOG).status === "unmatched"),
    [regions]
  );
  const draftWithinCatalog = draftIds.filter((id) => findRegion(id, REGION_CATALOG));

  function beginEdit() {
    setDraftIds(regions.map((ref) => ref.regionId));
    setBaselineRevision(revision);
    setError(undefined);
    setNotice(undefined);
    setOpen(true);
  }

  function cancel() {
    setDraftIds(regions.map((ref) => ref.regionId));
    setError(undefined);
    setOpen(false);
  }

  function toggle(regionId: string) {
    setDraftIds((current) =>
      current.includes(regionId) ? current.filter((id) => id !== regionId) : [...current, regionId]
    );
  }

  function removeUnknown(regionId: string) {
    setDraftIds((current) => current.filter((id) => id !== regionId));
  }

  async function save() {
    setError(undefined);
    const result = await onSave(draftIds, baselineRevision);
    if (!result.ok) {
      setError(result.message ?? "地区未保存，草稿已保留。");
      return;
    }
    setNotice("地区关联已保存；正文、图片与来源关联未改动。");
    setOpen(false);
  }

  const selectedLabels = draftIds.map((regionId) => {
    const region = findRegion(regionId, REGION_CATALOG);
    if (region) return { regionId, label: region.name, unknown: false };
    const stored = regions.find((ref) => ref.regionId === regionId);
    return {
      regionId,
      label: stored?.name ? `${stored.name}（地区待匹配）` : "地区待匹配",
      unknown: true
    };
  });

  return (
    <section className="page-regions" aria-label={`地区关联 ${pageId}`}>
      <div className="page-regions-summary">
        <MapPin size={15} aria-hidden="true" />
        {regions.length === 0 ? (
          <span className="page-regions-empty">未设置地区</span>
        ) : (
          <ul className="page-regions-chips">
            {regions.map((ref) => {
              const resolution = resolveStoredRegion(ref, REGION_CATALOG);
              const label =
                resolution.status === "resolved"
                  ? resolution.region.name
                  : `${ref.name || ref.regionId}（地区待匹配）`;
              return (
                <li
                  key={ref.regionId}
                  className={resolution.status === "resolved" ? "" : "is-unknown"}
                >
                  {label}
                </li>
              );
            })}
          </ul>
        )}
        <button type="button" className="secondary-button" disabled={busy} onClick={beginEdit}>
          {regions.length === 0 ? "关联地区" : "修改地区"}
        </button>
      </div>

      {open ? (
        <div className="page-regions-editor">
          {selectedLabels.length > 0 ? (
            <ul className="page-regions-selected" aria-label="已选地区">
              {selectedLabels.map((item) => (
                <li key={item.regionId}>
                  <span>
                    {item.label}
                    {item.unknown ? "（仅可移除）" : ""}
                  </span>
                  <button
                    type="button"
                    className="notebook-draft-remove"
                    aria-label={`移除地区 ${item.label}`}
                    onClick={() =>
                      item.unknown ? removeUnknown(item.regionId) : toggle(item.regionId)
                    }
                  >
                    <Trash2 size={14} /> 移除
                  </button>
                </li>
              ))}
              <li>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setDraftIds(unknownRefs.map((ref) => ref.regionId))}
                >
                  清空已知地区
                </button>
              </li>
            </ul>
          ) : (
            <p className="notebook-readonly">尚未选择地区。</p>
          )}

          <RegionStepPicker draftIds={draftIds} onToggle={toggle} />

          <div className="capture-actions">
            <button
              className="primary-button"
              type="button"
              disabled={busy}
              onClick={() => void save()}
            >
              保存地区
            </button>
            <button className="secondary-button" type="button" disabled={busy} onClick={cancel}>
              取消
            </button>
          </div>
          {error ? (
            <p className="notebook-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}

      {notice ? (
        <p className="global-notice" role="status">
          {notice}
        </p>
      ) : null}
      {draftWithinCatalog.length > 0 && !open ? (
        <p className="notebook-readonly">共 {draftWithinCatalog.length} 个地区关联。</p>
      ) : null}
    </section>
  );
}

/**
 * 地区选择：父层每次明确操作递增保存信号，按顺序提交最新草稿。
 */
export function PageRegionsSelect({
  pageId,
  regions,
  revision,
  busy,
  onSave,
  onSaved,
  onSavingChange,
  onRetry,
  saveSignal,
  /** 受控草稿（可选）：照片位置识别等外部入口追加候选时由父层同步。 */
  draftRegionIds,
  onDraftChange
}: PageRegionsEditorProps & {
  /** 保存成功后的轻提示。 */
  onSaved?: (savedCount: number) => void;
  onSavingChange?: (saving: boolean) => void;
  onRetry?: () => void;
  /** 选择或日期操作递增；变化即触发保存。 */
  saveSignal: number;
  /** 外部受控草稿：传入时以此为准（与内部草稿同步双向）。 */
  draftRegionIds?: string[];
  onDraftChange?: (next: string[]) => void;
}) {
  const baselineRevision = useRef(revision);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const [internalDraftIds, setInternalDraftIds] = useState<string[]>(
    regions.map((ref) => ref.regionId)
  );
  const draftIds = draftRegionIds ?? internalDraftIds;
  const setDraftIds = (next: string[] | ((current: string[]) => string[])) => {
    const value = typeof next === "function" ? (next as (c: string[]) => string[])(draftIds) : next;
    setInternalDraftIds(value);
    onDraftChange?.(value);
  };
  const [error, setError] = useState<string>();

  const selectedLabels = draftIds.map((regionId) => {
    const region = findRegion(regionId, REGION_CATALOG);
    if (region) return { regionId, label: region.name, unknown: false };
    const stored = regions.find((ref) => ref.regionId === regionId);
    return {
      regionId,
      label: stored?.name ? `${stored.name}（地区待匹配）` : "地区待匹配",
      unknown: true
    };
  });

  const saveSignalRef = useRef(saveSignal);
  useEffect(() => {
    if (saveSignal === saveSignalRef.current || busy || savingRef.current) return;
    saveSignalRef.current = saveSignal;
    const snapshot = [...draftIds];
    savingRef.current = true;
    setSaving(true);
    onSavingChange?.(true);
    void (async () => {
      setError(undefined);
      try {
        const result = await onSave(snapshot, baselineRevision.current);
        if (!mountedRef.current) return;
        if (!result.ok) {
          setError(result.message ?? "地区未保存，草稿已保留。");
          return;
        }
        baselineRevision.current = result.revision ?? baselineRevision.current;
        onSaved?.(snapshot.filter((id) => findRegion(id, REGION_CATALOG)).length);
      } catch (error) {
        if (mountedRef.current) setError(error instanceof Error ? error.message : "地区未保存，草稿已保留。");
      } finally {
        savingRef.current = false;
        if (mountedRef.current) {
          setSaving(false);
          onSavingChange?.(false);
        }
      }
    })();
    // 只由操作信号触发；写入结束后再处理期间到达的最新信号。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveSignal, busy, saving]);

  function toggle(regionId: string) {
    setDraftIds((current) =>
      current.includes(regionId) ? current.filter((id) => id !== regionId) : [...current, regionId]
    );
  }

  return (
    <div className="page-regions-select" aria-label={`地区关联选择 ${pageId}`}>
      {selectedLabels.length > 0 ? (
        <ul className="page-regions-selected" aria-label="已选地区">
          {selectedLabels.map((item) => (
            <li key={item.regionId}>
              <span>
                {item.label}
                {item.unknown ? "（仅可移除）" : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <fieldset className="page-regions-fields" disabled={busy || saving}>
        <RegionStepPicker draftIds={draftIds} onToggle={toggle} />
      </fieldset>
      {error ? (
        <div className="nb-region-save-error">
          <p className="notebook-error" role="alert">{error}</p>
          {onRetry ? <button type="button" className="secondary-button" disabled={busy || saving} onClick={onRetry}>重试</button> : null}
        </div>
      ) : null}
    </div>
  );
}
