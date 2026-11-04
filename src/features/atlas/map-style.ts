export const ATLAS_MAP_STYLES = ["terrain", "paper"] as const;

export type AtlasMapStyle = (typeof ATLAS_MAP_STYLES)[number];

export const DEFAULT_ATLAS_MAP_STYLE: AtlasMapStyle = "terrain";

const STORAGE_KEY = "xingji.atlas-map-style";

export function isAtlasMapStyle(value: unknown): value is AtlasMapStyle {
  return value === "terrain" || value === "paper";
}

export function readAtlasMapStyle(): AtlasMapStyle {
  if (typeof window === "undefined") return DEFAULT_ATLAS_MAP_STYLE;
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return isAtlasMapStyle(saved) ? saved : DEFAULT_ATLAS_MAP_STYLE;
  } catch {
    return DEFAULT_ATLAS_MAP_STYLE;
  }
}

export function saveAtlasMapStyle(style: AtlasMapStyle): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, style);
  } catch {
    // 隐私模式/配额受限时只保留当前会话选择，不阻断地图使用。
  }
}
