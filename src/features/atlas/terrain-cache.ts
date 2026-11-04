import type { BoundaryDataset } from "./boundary-contract";
import { terrainDprForSize } from "./terrain-layer";

/** 渲染算法或底图更新时递增；旧键自然失配，持久缓存按容量淘汰。 */
export const TERRAIN_CACHE_VERSION = "terrain-v4";

type TerrainCacheRecord = {
  key: string;
  blob: Blob;
  shaded: boolean;
  lastUsed: number;
  bytes: number;
};

export type TerrainCacheHit = {
  blob: Blob;
  shaded: boolean;
};

const MEMORY_LIMIT = 8;
const PERSISTED_LIMIT = 12;
const PERSISTED_BYTES = 32 * 1024 * 1024;
const DB_NAME = "xingji-atlas-cache";
const STORE_NAME = "terrain-renders";
const memory = new Map<string, TerrainCacheRecord>();
const inflight = new Map<string, Promise<unknown>>();
let dbPromise: Promise<IDBDatabase | null> | null = null;

function hashRegions(dataset: BoundaryDataset) {
  let hash = 2166136261;
  for (const region of dataset.regions) {
    for (let index = 0; index < region.regionId.length; index += 1) {
      hash ^= region.regionId.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `${dataset.regions.length}-${hash >>> 0}`;
}

/**
 * 同一个地区、同一视野和同一像素尺寸才复用。行政区版本、底图版本、
 * 容器尺寸、zoom 或 dpr 变化都会自然 miss，不会拿旧图冒充新范围。
 */
export function terrainCacheKey(
  map: { getSize(): { x: number; y: number }; getZoom(): number; getBounds(): { getSouth(): number; getWest(): number; getNorth(): number; getEast(): number } },
  dataset: BoundaryDataset
) {
  const size = map.getSize();
  const bounds = map.getBounds();
  const round = (value: number) => Math.round(value * 1e5) / 1e5;
  const dpr = terrainDprForSize(size);
  return [
    TERRAIN_CACHE_VERSION,
    dataset.sourceId,
    dataset.sourceVersion,
    dataset.level,
    dataset.parentRegionId ?? "root",
    hashRegions(dataset),
    `${Math.round(size.x)}x${Math.round(size.y)}`,
    dpr.toFixed(2),
    map.getZoom().toFixed(2),
    `${round(bounds.getWest())},${round(bounds.getSouth())},${round(bounds.getEast())},${round(bounds.getNorth())}`
  ].join("|");
}

function remember(record: TerrainCacheRecord) {
  memory.delete(record.key);
  memory.set(record.key, record);
  while (memory.size > MEMORY_LIMIT) {
    const oldest = memory.keys().next().value;
    if (oldest) memory.delete(oldest);
  }
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === "undefined") {
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }
  dbPromise = new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  return dbPromise;
}

async function trimPersisted(db: IDBDatabase) {
  const transaction = db.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  const records = await requestResult(store.getAll() as IDBRequest<TerrainCacheRecord[]>);
  for (const record of records) {
    if (!record.key.startsWith(`${TERRAIN_CACHE_VERSION}|`)) store.delete(record.key);
  }
  const sorted = records
    .filter((record) => record.key.startsWith(`${TERRAIN_CACHE_VERSION}|`))
    .sort((a, b) => a.lastUsed - b.lastUsed);
  let total = sorted.reduce((sum, record) => sum + record.bytes, 0);
  while (sorted.length > PERSISTED_LIMIT || total > PERSISTED_BYTES) {
    const oldest = sorted.shift();
    if (!oldest) break;
    total -= oldest.bytes;
    store.delete(oldest.key);
  }
}

export async function readTerrainCache(key: string): Promise<TerrainCacheHit | null> {
  const cached = memory.get(key);
  if (cached) {
    cached.lastUsed = Date.now();
    return { blob: cached.blob, shaded: cached.shaded };
  }
  const db = await openDb();
  if (!db) return null;
  try {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const record = await requestResult(
      transaction.objectStore(STORE_NAME).get(key) as IDBRequest<TerrainCacheRecord | undefined>
    );
    if (!record || !record.blob?.size || !record.key.startsWith(`${TERRAIN_CACHE_VERSION}|`)) {
      return null;
    }
    record.lastUsed = Date.now();
    remember(record);
    return { blob: record.blob, shaded: record.shaded };
  } catch {
    return null;
  }
}

export async function writeTerrainCache(
  key: string,
  blob: Blob,
  shaded: boolean
): Promise<void> {
  if (!blob.size) return;
  const record: TerrainCacheRecord = {
    key,
    blob,
    shaded,
    lastUsed: Date.now(),
    bytes: blob.size
  };
  remember(record);
  const db = await openDb();
  if (!db) return;
  try {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    await requestResult(transaction.objectStore(STORE_NAME).put(record));
    await trimPersisted(db);
  } catch {
    // 持久缓存失败不影响当前地貌图。
  }
}

/**
 * 同一最终地貌渲染只跑一次；各调用方自己的取消仍由 adapter 的 run 校验负责。
 * 用 key 合并的是“生成任务”，不是把旧结果贴到新视野上。
 */
export function shareTerrainRender<T>(key: string, factory: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const task = factory().finally(() => {
    if (inflight.get(key) === task) inflight.delete(key);
  });
  inflight.set(key, task);
  return task;
}
