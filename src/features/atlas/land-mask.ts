import type { Map as LeafletMap } from "leaflet";

/**
 * 高分辨率陆地掩膜。Natural Earth 10m land 是 1:10,000,000 矢量，
 * 不是 10 米地面分辨率；这里只用于市/县尺度的海陆修正，不替代 GeoJSON。
 * 数据按需加载，全国/省级视图继续使用 50m 地表色底图，避免额外网络。
 */

type LandRing = {
  points: [number, number][];
  west: number;
  east: number;
  south: number;
  north: number;
};

const LAND_MASK_MIN_ZOOM = 7.2;
const LAND_RINGS_SRC = "/data/ne10m-land-china.rings.json";
let ringsPromise: Promise<LandRing[] | null> | null = null;

function loadRings() {
  if (ringsPromise) return ringsPromise;
  ringsPromise = fetch(LAND_RINGS_SRC, { cache: "force-cache" })
    .then((response) => (response.ok ? response.json() : null))
    .then((raw) => {
      if (!Array.isArray(raw)) return null;
      return raw
        .filter((ring): ring is [number, number][] => Array.isArray(ring) && ring.length >= 3)
        .map((points) => {
          const lngs = points.map((point) => point[0]);
          const lats = points.map((point) => point[1]);
          return {
            points,
            west: Math.min(...lngs),
            east: Math.max(...lngs),
            south: Math.min(...lats),
            north: Math.max(...lats)
          };
        });
    })
    .catch(() => null);
  return ringsPromise;
}

export function shouldUseHighResLandMask(zoom: number) {
  return zoom >= LAND_MASK_MIN_ZOOM;
}

/**
 * 在 Leaflet 当前投影/视野里栅格化陆地掩膜。1 表示陆地，0 表示海洋。
 * 找不到数据或视野不需要细粒度海陆时返回 null，调用方保持原有降级路径。
 */
export async function buildHighResLandMask(
  map: LeafletMap,
  width: number,
  height: number,
  dpr: number,
  signal?: AbortSignal
): Promise<Uint8Array | null> {
  if (typeof document === "undefined" || !shouldUseHighResLandMask(map.getZoom())) return null;
  const rings = await loadRings();
  if (!rings || signal?.aborted) return null;
  const bounds = map.getBounds();
  const west = bounds.getWest() - 0.2;
  const east = bounds.getEast() + 0.2;
  const south = bounds.getSouth() - 0.2;
  const north = bounds.getNorth() + 0.2;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const path = new Path2D();
  let used = false;
  for (const ring of rings) {
    if (ring.east < west || ring.west > east || ring.north < south || ring.south > north) continue;
    let started = false;
    for (const [lng, lat] of ring.points) {
      const point = map.latLngToContainerPoint([lat, lng]);
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
      if (!started) {
        path.moveTo(point.x * dpr, point.y * dpr);
        started = true;
      } else {
        path.lineTo(point.x * dpr, point.y * dpr);
      }
    }
    if (started) {
      path.closePath();
      used = true;
    }
  }
  if (!used) return null;
  ctx.fillStyle = "#fff";
  ctx.fill(path, "evenodd");
  const data = ctx.getImageData(0, 0, width, height).data;
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < mask.length; index += 1) {
    mask[index] = data[index * 4 + 3] > 127 ? 1 : 0;
  }
  return mask;
}
