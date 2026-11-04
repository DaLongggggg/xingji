import { isAbortError, type BoundaryDataset, type BoundaryProvider } from "./boundary-contract";

export type StackLoadStatus = "ready" | "error" | "aborted";

export type StackLoadResult = {
  status: StackLoadStatus;
  stack: BoundaryDataset[];
  errorMessage?: string;
  /** 数据是否来自缓存（用于验证换源清缓存与重试绕过缓存）。 */
  fromCache: boolean;
  /** 命中的缓存键，便于测试断言 key 含 sourceVersion 与 regionId。 */
  cacheKey?: string;
};

export type BoundaryCache = Map<string, BoundaryDataset>;

/**
 * 缓存键 = 来源身份 + **派生身份**（019）+ 视图。
 * 派生算法或包变化时 derivedVersion 变化，旧几何不会被复用。
 */
export function providerIdentity(provider: BoundaryProvider): string {
  const derived = provider.derivedVersion ? `+${provider.derivedVersion}` : "";
  return `${provider.sourceId}@${provider.sourceVersion}${derived}`;
}

export function cacheKeyFor(provider: BoundaryProvider, kind: "national" | string): string {
  return `${providerIdentity(provider)}#${kind}`;
}

/**
 * 换源必须清缓存：sourceId/sourceVersion 变化时丢弃旧数据。
 * 返回是否发生了清除，便于测试与日志。
 */
export function prepareCacheForSource(
  cache: BoundaryCache,
  currentSourceKey: string,
  provider: BoundaryProvider
): { sourceKey: string; cleared: boolean } {
  const nextKey = providerIdentity(provider);
  if (currentSourceKey === nextKey) return { sourceKey: nextKey, cleared: false };
  cache.clear();
  return { sourceKey: nextKey, cleared: true };
}

/** 加载全国视图；retry=true 时绕过缓存。 */
export async function loadNationalIntoStack(options: {
  provider: BoundaryProvider | null;
  cache: BoundaryCache;
  retry?: boolean;
  signal?: AbortSignal;
}): Promise<StackLoadResult> {
  const { provider, cache, retry = false, signal } = options;
  if (!provider) return { status: "ready", stack: [], fromCache: false };
  const key = cacheKeyFor(provider, "national");
  if (!retry) {
    const cached = cache.get(key);
    if (cached) return { status: "ready", stack: [cached], fromCache: true, cacheKey: key };
  } else {
    // 重试不得复用可能已损坏的缓存。
    cache.delete(key);
  }
  try {
    const dataset = await provider.loadNational({ signal });
    cache.set(key, dataset);
    return { status: "ready", stack: [dataset], fromCache: false, cacheKey: key };
  } catch (error) {
    if (isAbortError(error)) return { status: "aborted", stack: [], fromCache: false };
    return {
      status: "error",
      stack: [],
      fromCache: false,
      errorMessage: error instanceof Error ? error.message : "边界数据加载失败。"
    };
  }
}

/** 在当前栈上下钻到某个省；失败时保留原栈，不改变已显示视图。 */
export async function loadProvinceIntoStack(options: {
  provider: BoundaryProvider | null;
  cache: BoundaryCache;
  currentStack: BoundaryDataset[];
  regionId: string;
  retry?: boolean;
  signal?: AbortSignal;
  /** 换源后是否为全新会话（true 时下钻结果作为新栈根）。 */
  freshSession?: boolean;
  city?: boolean;
}): Promise<StackLoadResult> {
  const {
    provider,
    cache,
    currentStack,
    regionId,
    retry = false,
    signal,
    freshSession = false,
    city = false
  } = options;
  if (!provider) return { status: "ready", stack: currentStack, fromCache: false };
  const key = cacheKeyFor(provider, city ? `city:${regionId}` : regionId);
  const root = freshSession
    ? []
    : city
      ? currentStack.filter((item) => item.level !== "city")
      : currentStack.slice(0, 1);
  if (!retry) {
    const cached = cache.get(key);
    if (cached) {
      return { status: "ready", stack: [...root, cached], fromCache: true, cacheKey: key };
    }
  } else {
    cache.delete(key);
  }
  try {
    if (city && !provider.loadCity) throw new Error("当前数据源不支持区县地图。");
    const dataset = await (city
      ? provider.loadCity!(regionId, { signal })
      : provider.loadProvince(regionId, { signal }));
    cache.set(key, dataset);
    return { status: "ready", stack: [...root, dataset], fromCache: false, cacheKey: key };
  } catch (error) {
    if (isAbortError(error)) return { status: "aborted", stack: currentStack, fromCache: false };
    return {
      status: "error",
      stack: currentStack,
      fromCache: false,
      errorMessage: error instanceof Error ? error.message : "城市边界加载失败。"
    };
  }
}

/** 返回全国：只保留栈根。 */
export function popToNational(stack: BoundaryDataset[]): BoundaryDataset[] {
  return stack.length > 1 ? [stack[0]] : stack;
}
