"use client";

import { ChevronDown, History, Trash2 } from "lucide-react";
import { findRegion } from "@/features/regions/region-catalog";
import type { RegionAssociationSource } from "@/features/regions/region-sources";

/**
 * 关联详情每地区一行：名称、来源照片与移除。
 * 移除交给父层的当前篇地区命令，不清除共享照片或 GPS。
 */

export type RegionSourceView = {
  regionId: string;
  records: {
    source: RegionAssociationSource;
    /** false = 本次会话产生、尚未保存。 */
    persisted: boolean;
    /** 已加入本次撤销待办。 */
    pendingUndo: boolean;
  }[];
};

export function PageRegionSources({
  views,
  mediaNames,
  onRemoveRegion,
  disabled
}: {
  views: RegionSourceView[];
  mediaNames: Record<string, string>;
  onRemoveRegion: (regionId: string) => void;
  disabled?: boolean;
}) {
  if (views.length === 0) return null;
  return (
    <details className="nb-region-sources" data-testid="region-sources">
      <summary>
        <History size={16} aria-hidden /> 关联详情
        <ChevronDown size={16} aria-hidden />
      </summary>
      <ul>
        {views.map((view) => {
          const region = findRegion(view.regionId);
          return (
            <li key={view.regionId} className="nb-region-source-row">
                <strong title={region?.name ?? view.regionId}>{region?.name ?? view.regionId}</strong>
                <span className="nb-region-source-photo" title={view.records.flatMap(record => record.source.mediaIds).map(id => mediaNames[id] ?? id).join("、")}>
                  {[...new Set(view.records.flatMap(record => record.source.mediaIds))].map(id => mediaNames[id] ?? id.slice(0, 8)).join("、")}
                </span>
                <button type="button" className="nb-icon-button" aria-label={`移除地区 ${region?.name ?? view.regionId}`} title="取消地区关联" disabled={disabled} onClick={() => onRemoveRegion(view.regionId)}><Trash2 size={16} aria-hidden /></button>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
