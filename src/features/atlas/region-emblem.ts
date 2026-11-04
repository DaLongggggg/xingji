import type { BoundaryLevel } from "./boundary-contract";
import { REGION_MOTIF_ART, type RegionMotif } from "./region-motif-art";
import type { RegionIdentity } from "./region-identity";

/**
 * 地图徽章的尺寸刻意小：全国层信息密度最高，只给一个可辨认的“地标印章”；
 * 越往省/县走，地图上地区数量变少，徽章才允许放大（24/30/32px）。
 */
export function regionEmblemSize(level: BoundaryLevel, compact: boolean): number {
  if (level === "national") return compact ? 17 : 24;
  if (level === "province") return compact ? 22 : 30;
  return compact ? 25 : 32;
}

/**
 * 生成 Leaflet divIcon 内容。图标本身不接收指针事件；地图点击仍落在
 * 下面的 Leaflet path 上。颜色由 CSS 变量交给样式层，不在 JS 里再拼主题。
 */
export function regionEmblemHtml(
  identity: RegionIdentity,
  options: { size: number; hasJournal: boolean }
): string {
  const art = REGION_MOTIF_ART[identity.motif as RegionMotif] ?? REGION_MOTIF_ART.mountain;
  const paper = options.hasJournal ? identity.palette.journal : identity.palette.paper;
  return `<span class="atlas-region-emblem__badge${options.hasJournal ? " is-journal" : ""}" style="--atlas-emblem-paper:${paper};--atlas-emblem-accent:${identity.palette.accent};--atlas-emblem-glyph:${identity.palette.glyph};">
    <svg class="atlas-region-emblem__glyph" viewBox="0 0 24 24" width="${options.size}" height="${options.size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${art}</svg>
  </span>`;
}
