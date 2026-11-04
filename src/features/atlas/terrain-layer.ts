import type { BoundaryDataset, BoundaryGeometry } from "./boundary-contract";
import { buildHighResLandMask } from "./land-mask";

/**
 * 真实地貌底图：本地 Natural Earth 50m 地表色 + 按当前视野加载的 Mapzen/Amazon
 * 30m DEM 晕渲。支持先只渲染本地地表色（dem=false）快速首帧，再补 DEM 细化；
 * 渲染结果只保留行政区并集，由 Leaflet ImageOverlay 放在边界 SVG 之下；
 * GeoJSON、投影、命中区域和业务 ID 都不在这里改动。
 *
 * 外部 DEM 失败时仍保留本地地表色，不会把纸质行政区图变成空白。
 */

/** 与渲染缓存键共用，避免同一容器在缓存中生成两套像素尺寸。 */
export function terrainDprForSize(size: { x: number; y: number }) {
  return clamp(
    Math.min(window.devicePixelRatio || 1, 1.5, 2400 / size.x, 1800 / size.y),
    1,
    2
  );
}

export type TerrainRenderResult = {
  blob: Blob;
  /** false 表示只用了离线地表色，没有加载到高分辨率晕渲瓦片。 */
  shaded: boolean;
};

type TerrainRenderOptions = {
  map: import("leaflet").Map;
  dataset: BoundaryDataset;
  signal?: AbortSignal;
  /** false 时只生成本地地表色底图，作为 DEM 到达前的快速首帧。 */
  dem?: boolean;
};

type TileImage = ImageBitmap | HTMLImageElement;

const BASE_SRC = "/textures/ne1-china-relief.webp";
const BASE_WEST = 70;
const BASE_EAST = 140;
const BASE_SOUTH = 15;
const BASE_NORTH = 55;
const TILE_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

const TILE_CACHE = new Map<string, Promise<TileImage>>();
let baseImagePromise: Promise<HTMLImageElement | null> | null = null;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const mix = (from: number, to: number, amount: number) => from + (to - from) * amount;
const normX = (longitude: number) => (longitude + 180) / 360;
const normY = (latitude: number) => {
  const sin = Math.sin((latitude * Math.PI) / 180);
  return 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
};

function loadBaseImage() {
  if (baseImagePromise) return baseImagePromise;
  baseImagePromise = new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = BASE_SRC;
  });
  return baseImagePromise;
}

async function decodeTile(blob: Blob): Promise<TileImage> {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(blob);
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("DEM tile decode failed");
  }
}

function loadTile(z: number, x: number, y: number, signal?: AbortSignal) {
  const key = `${z}/${x}/${y}`;
  const cached = TILE_CACHE.get(key);
  if (cached) return cached;
  const job = (async () => {
    const response = await fetch(TILE_URL(z, x, y), {
      signal,
      mode: "cors",
      // 已看过的视野可以走浏览器 HTTP 缓存；本会话另有解码缓存。
      cache: "force-cache"
    });
    if (!response.ok) throw new Error(`DEM tile ${key} unavailable`);
    return decodeTile(await response.blob());
  })();
  TILE_CACHE.set(key, job);
  job.catch(() => TILE_CACHE.delete(key));
  return job;
}

function forEachRing(
  geometry: BoundaryGeometry,
  visit: (ring: GeoJSON.Position[]) => void
) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  for (const polygon of polygons) {
    for (const ring of polygon) visit(ring);
  }
}

function buildMask(
  ctx: CanvasRenderingContext2D,
  dataset: BoundaryDataset,
  map: import("leaflet").Map,
  width: number,
  height: number,
  dpr: number
) {
  const mask = document.createElement("canvas");
  mask.width = width;
  mask.height = height;
  const maskCtx = mask.getContext("2d");
  if (!maskCtx) return false;
  const path = new Path2D();
  let hasPoint = false;
  for (const feature of dataset.features) {
    forEachRing(feature.geometry, (ring) => {
      if (ring.length < 3) return;
      let started = false;
      for (const position of ring) {
        const [lng, lat] = position;
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
        const point = map.latLngToContainerPoint([lat, lng]);
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
        const x = point.x * dpr;
        const y = point.y * dpr;
        if (!started) {
          path.moveTo(x, y);
          started = true;
          hasPoint = true;
        } else {
          path.lineTo(x, y);
        }
      }
      if (started) path.closePath();
    });
  }
  if (!hasPoint) return false;
  maskCtx.fillStyle = "#fff";
  maskCtx.fill(path, "evenodd");
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(mask, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  return true;
}

function decodeElevation(red: number, green: number, blue: number) {
  return red * 256 + green + blue / 256 - 32768;
}

type TileGrid = {
  z: number;
  x0: number;
  y0: number;
  width: number;
  height: number;
  worldSize: number;
  elevation: Float32Array;
};

async function buildTileGrid(
  map: import("leaflet").Map,
  normBounds: { x0: number; x1: number; y0: number; y1: number },
  signal?: AbortSignal
): Promise<TileGrid | null> {
  const width = Math.max(1, map.getSize().x);
  // 目标：让当前视野大致占 4–10 个瓦片宽。省市县放大后自动换更细一级，
  // 不用全国底图硬撑到市县。
  // DEM 只负责明暗；按约 0.75 个 CSS 像素对应一个 DEM 像素取样即可。
  // 全国层级由调用方直接使用本地地表色（本身含地形晕渲），不请求 DEM；
  // 省/市层级放大后会换更细一级，避免全国底图硬撑到市县。
  let z = clamp(
    Math.ceil(Math.log2((width * 0.75) / (256 * (normBounds.x1 - normBounds.x0)))),
    4,
    12
  );
  let range = tileRange(normBounds, z);
  while (z > 4 && range.width * range.height > 160) {
    z -= 1;
    range = tileRange(normBounds, z);
  }
  if (range.width * range.height > 160) return null;
  const worldSize = 2 ** z * 256;
  const jobs: Promise<TileImage>[] = [];
  const keys: { x: number; y: number }[] = [];
  for (let x = range.x0; x <= range.x1; x += 1) {
    for (let y = range.y0; y <= range.y1; y += 1) {
      keys.push({ x, y });
      jobs.push(loadTile(z, x, y, signal));
    }
  }
  let tiles: TileImage[];
  try {
    tiles = await Promise.all(jobs);
  } catch {
    return null;
  }
  if (signal?.aborted) return null;
  const mosaic = document.createElement("canvas");
  mosaic.width = range.width * 256;
  mosaic.height = range.height * 256;
  const mosaicCtx = mosaic.getContext("2d", { willReadFrequently: true });
  if (!mosaicCtx) return null;
  for (let index = 0; index < tiles.length; index += 1) {
    const tile = tiles[index];
    const key = keys[index];
    mosaicCtx.drawImage(
      tile,
      0,
      0,
      "naturalWidth" in tile ? tile.naturalWidth : tile.width,
      "naturalHeight" in tile ? tile.naturalHeight : tile.height,
      (key.x - range.x0) * 256,
      (key.y - range.y0) * 256,
      256,
      256
    );
  }
  const pixels = mosaicCtx.getImageData(0, 0, mosaic.width, mosaic.height).data;
  const elevation = new Float32Array(mosaic.width * mosaic.height);
  for (let index = 0, pointer = 0; index < elevation.length; index += 1, pointer += 4) {
    elevation[index] = decodeElevation(pixels[pointer], pixels[pointer + 1], pixels[pointer + 2]);
  }
  return {
    z,
    x0: range.x0,
    y0: range.y0,
    width: mosaic.width,
    height: mosaic.height,
    worldSize,
    elevation
  };
}

function tileRange(
  normBounds: { x0: number; x1: number; y0: number; y1: number },
  z: number
) {
  const tiles = 2 ** z;
  // 只取与当前视野相交的瓦片；边界由采样 clamp 处理，不再额外拉一圈。
  const x0 = clamp(Math.floor(normBounds.x0 * tiles), 0, tiles - 1);
  const x1 = clamp(Math.max(x0, Math.ceil(normBounds.x1 * tiles) - 1), 0, tiles - 1);
  const y0 = clamp(Math.floor(normBounds.y0 * tiles), 0, tiles - 1);
  const y1 = clamp(Math.max(y0, Math.ceil(normBounds.y1 * tiles) - 1), 0, tiles - 1);
  return { x0, x1, y0, y1, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/**
 * 地表颜色以 Natural Earth 的 landcover / water / snow 表现为准；这里只做
 * 统一的水彩化降饱和和暖纸色倾向，不按高程猜测水体或雪线。
 */
function harmonizeSurface(red: number, green: number, blue: number) {
  const average = (red + green + blue) / 3;
  const rr = mix(red, average, 0.12) * 0.985 + 5;
  const gg = mix(green, average, 0.1) * 0.985 + 5;
  const bb = mix(blue, average, 0.06) * 0.985 + 4;
  return [
    clamp(mix(rr, 241, 0.04), 0, 255),
    clamp(mix(gg, 232, 0.035), 0, 255),
    clamp(mix(bb, 211, 0.02), 0, 255)
  ] as const;
}

function gradeOnlyBase(data: Uint8ClampedArray) {
  for (let index = 0; index < data.length; index += 4) {
    if (!data[index + 3]) continue;
    const [red, green, blue] = harmonizeSurface(
      data[index],
      data[index + 1],
      data[index + 2]
    );
    data[index] = red;
    data[index + 1] = green;
    data[index + 2] = blue;
  }
}

const SEA_FALLBACK: readonly [number, number, number] = [146, 184, 200];
const LAND_FALLBACK: readonly [number, number, number] = [204, 211, 181];

/** Natural Earth 的浅海/水体是明显偏蓝的低饱和像素；不用高程猜测。 */
function isWaterLike(red: number, green: number, blue: number) {
  return blue > red + 8 && green > red + 10 && blue >= green;
}

/**
 * 50m 地表色在港澳等极小区域会把陆地画成海水。1:10m 陆地掩膜只负责
 * 修正海陆轮廓：土地上的水体色改用中性陆地色，海面上的陆地色改用海水色，
 * 海面不参与 DEM 晕渲；掩膜缺失时保持原链路。
 */
function applyHighResLandMask(
  data: Uint8ClampedArray,
  landMask: Uint8Array,
  width: number,
  height: number
) {
  const seaMask = new Uint8Array(width * height);
  for (let index = 0; index < landMask.length; index += 1) {
    const pointer = index * 4;
    if (!data[pointer + 3]) continue;
    const isLand = landMask[index] === 1;
    if (!isLand) {
      seaMask[index] = 1;
      // 细尺度下统一用一致的海水色，避免 50m 底图的海面碎片/错色；
      // 海面不参与 DEM 晕渲，海陆边界更干净。
      data[pointer] = SEA_FALLBACK[0];
      data[pointer + 1] = SEA_FALLBACK[1];
      data[pointer + 2] = SEA_FALLBACK[2];
    } else if (isWaterLike(data[pointer], data[pointer + 1], data[pointer + 2])) {
      data[pointer] = LAND_FALLBACK[0];
      data[pointer + 1] = LAND_FALLBACK[1];
      data[pointer + 2] = LAND_FALLBACK[2];
    }
  }
  return seaMask;
}

function colorizeTerrain(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  grid: TileGrid,
  normBounds: { x0: number; x1: number; y0: number; y1: number },
  latitude: number,
  zoom: number,
  dpr: number,
  seaMask?: Uint8Array
) {
  const metersPerPixel =
    (156543.03392 * Math.cos((latitude * Math.PI) / 180)) / (2 ** zoom * dpr);
  const sample = (x: number, y: number) => {
    const gx = normBounds.x0 + ((x + 0.5) / width) * (normBounds.x1 - normBounds.x0);
    const gy = normBounds.y0 + ((y + 0.5) / height) * (normBounds.y1 - normBounds.y0);
    const gridX = clamp(gx * grid.worldSize - grid.x0 * 256, 0, grid.width - 1);
    const gridY = clamp(gy * grid.worldSize - grid.y0 * 256, 0, grid.height - 1);
    const x0 = Math.floor(gridX);
    const y0 = Math.floor(gridY);
    const x1 = Math.min(grid.width - 1, x0 + 1);
    const y1 = Math.min(grid.height - 1, y0 + 1);
    const tx = gridX - x0;
    const ty = gridY - y0;
    const top = grid.elevation[y0 * grid.width + x0] * (1 - tx)
      + grid.elevation[y0 * grid.width + x1] * tx;
    const bottom = grid.elevation[y1 * grid.width + x0] * (1 - tx)
      + grid.elevation[y1 * grid.width + x1] * tx;
    return top * (1 - ty) + bottom * ty;
  };
  const azimuth = (315 * Math.PI) / 180;
  const altitude = Math.PI / 4;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const pointer = index * 4;
      if (!data[pointer + 3]) continue;
      if (seaMask?.[index]) continue;
      const elevation = sample(x, y);
      if (!Number.isFinite(elevation)) continue;
      const left = sample(Math.max(0, x - 1), y);
      const right = sample(Math.min(width - 1, x + 1), y);
      const top = sample(x, Math.max(0, y - 1));
      const bottom = sample(x, Math.min(height - 1, y + 1));
      const dzdx = (right - left) / (2 * Math.max(1, metersPerPixel));
      const dzdy = (bottom - top) / (2 * Math.max(1, metersPerPixel));
      const steepness = Math.hypot(dzdx, dzdy);
      const slope = Math.atan(steepness * 1.7);
      const aspect = Math.atan2(dzdy, -dzdx);
      const light =
        Math.cos(slope) * Math.cos(altitude) +
        Math.sin(slope) * Math.sin(altitude) * Math.cos(azimuth - aspect);
      const shade = clamp(0.84 + light * 0.24, 0.78, 1.12);
      const [red, green, blue] = harmonizeSurface(
        data[pointer],
        data[pointer + 1],
        data[pointer + 2]
      );
      const grain = ((x * 13 + y * 7 + x * y) % 7) - 3;
      data[pointer] = clamp(red * shade + grain, 0, 255);
      data[pointer + 1] = clamp(green * shade + grain, 0, 255);
      data[pointer + 2] = clamp(blue * shade + grain, 0, 255);
    }
  }
}

/**
 * 只为当前地图容器生成一张真实地貌栅格。返回 Blob，调用方负责 createObjectURL。
 * 失败时由调用方继续使用本地地表色或原行政区填充，不影响地图交互。
 */
export async function renderTerrainImage({
  map,
  dataset,
  signal,
  dem = true
}: TerrainRenderOptions): Promise<TerrainRenderResult | null> {
  if (typeof document === "undefined") return null;
  const size = map.getSize();
  if (!(size.x > 0) || !(size.y > 0)) return null;
  const dpr = terrainDprForSize(size);
  const width = Math.round(size.x * dpr);
  const height = Math.round(size.y * dpr);
  const bounds = map.getBounds();
  const northWest = bounds.getNorthWest();
  const southEast = bounds.getSouthEast();
  const normBounds = {
    x0: normX(northWest.lng),
    x1: normX(southEast.lng),
    y0: normY(northWest.lat),
    y1: normY(southEast.lat)
  };
  if (
    !Number.isFinite(normBounds.x0) ||
    !Number.isFinite(normBounds.x1) ||
    !Number.isFinite(normBounds.y0) ||
    !Number.isFinite(normBounds.y1) ||
    normBounds.x1 <= normBounds.x0 ||
    normBounds.y1 <= normBounds.y0
  ) {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const base = await loadBaseImage();
  if (!base || signal?.aborted) return null;
  const baseX0 = normX(BASE_WEST);
  const baseX1 = normX(BASE_EAST);
  const baseY0 = normY(BASE_NORTH);
  const baseY1 = normY(BASE_SOUTH);
  const sx = ((normBounds.x0 - baseX0) / (baseX1 - baseX0)) * base.naturalWidth;
  const sw = ((normBounds.x1 - normBounds.x0) / (baseX1 - baseX0)) * base.naturalWidth;
  const sy = ((normBounds.y0 - baseY0) / (baseY1 - baseY0)) * base.naturalHeight;
  const sh = ((normBounds.y1 - normBounds.y0) / (baseY1 - baseY0)) * base.naturalHeight;
  ctx.fillStyle = "#eee8da";
  ctx.fillRect(0, 0, width, height);
  if (sx + sw > 0 && sy + sh > 0 && sx < base.naturalWidth && sy < base.naturalHeight) {
    ctx.drawImage(
      base,
      clamp(sx, 0, base.naturalWidth),
      clamp(sy, 0, base.naturalHeight),
      Math.min(sw, base.naturalWidth - clamp(sx, 0, base.naturalWidth)),
      Math.min(sh, base.naturalHeight - clamp(sy, 0, base.naturalHeight)),
      0,
      0,
      width,
      height
    );
  }
  const imageData = ctx.getImageData(0, 0, width, height);
  let shaded = false;
  const [grid, landMask] = await Promise.all([
    dem ? buildTileGrid(map, normBounds, signal) : Promise.resolve(null),
    buildHighResLandMask(map, width, height, dpr, signal)
  ]);
  if (signal?.aborted) return null;
  const seaMask = landMask
    ? applyHighResLandMask(imageData.data, landMask, width, height)
    : undefined;
  if (grid && !signal?.aborted) {
    colorizeTerrain(
      imageData.data,
      width,
      height,
      grid,
      normBounds,
      map.getCenter().lat,
      map.getZoom(),
      dpr,
      seaMask
    );
    shaded = true;
  } else {
    gradeOnlyBase(imageData.data);
  }
  if (signal?.aborted) return null;
  ctx.putImageData(imageData, 0, 0);
  if (!buildMask(ctx, dataset, map, width, height, dpr)) return null;
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((value) => resolve(value), "image/webp", 0.9);
  });
  return blob ? { blob, shaded } : null;
}
