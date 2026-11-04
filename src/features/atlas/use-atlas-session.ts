"use client";

import { useCallback, useEffect, useState } from "react";
import { isAbortError, type BoundaryDataset, type BoundaryProvider } from "./boundary-contract";
import {
  cacheKeyFor,
  loadNationalIntoStack,
  loadProvinceIntoStack,
  popToNational,
  prepareCacheForSource,
  type BoundaryCache
} from "./boundary-stack";

/**
 * 地图浏览会话：不属于 React 组件，用普通对象持有缓存与请求状态。
 * 组件通过 useAtlasSession 订阅；渲染期不读取 ref。
 */
export type AtlasSession = ReturnType<typeof createAtlasSession>;

export function createAtlasSession() {
  const cache: BoundaryCache = new Map();
  let sourceKey = "";
  let requestSeq = 0;
  let abort: AbortController | null = null;
  let disposed = false;
  let listeners: (() => void)[] = [];

  const state = {
    stack: [] as BoundaryDataset[],
    status: "idle" as "idle" | "loading" | "ready" | "error",
    errorMessage: undefined as string | undefined,
    availableProvinces: new Set<string>(),
    /** 最近一次下钻目标：下钻失败时栈未变，重试必须用它而不是栈顶。 */
    lastDrillRegionId: null as string | null,
    lastDrillCity: false
  };

  function emit() {
    listeners.forEach((listener) => listener());
  }

  function beginRequest(): { seq: number; signal: AbortSignal } {
    abort?.abort();
    abort = new AbortController();
    requestSeq += 1;
    return { seq: requestSeq, signal: abort.signal };
  }

  // 过期请求（序号不匹配）或会话已卸载时，不得再写入状态。
  function isCurrent(seq: number): boolean {
    return !disposed && seq === requestSeq;
  }

  return {
    subscribe(listener: () => void) {
      // 重新挂载（含开发态 StrictMode 的 setup→cleanup→setup）后会话恢复可用：
      // 缓存与已加载几何保留，只把 disposed 标记复位，避免组件“永久卡在未就绪”。
      disposed = false;
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((item) => item !== listener);
      };
    },
    getState() {
      return state;
    },
    dispose() {
      disposed = true;
      abort?.abort();
      abort = null;
      listeners = [];
    },
    async loadNational(provider: BoundaryProvider | null, retry = false) {
      if (!provider) return;
      if (disposed) {
        // 卸载后又被重新挂载：同一实例“复活”，缓存命中即可立即 ready。
        disposed = false;
      }
      state.lastDrillRegionId = null;
      const prepared = prepareCacheForSource(cache, sourceKey, provider);
      sourceKey = prepared.sourceKey;
      const { seq, signal } = beginRequest();
      state.status = "loading";
      state.errorMessage = undefined;
      emit();
      const result = await loadNationalIntoStack({ provider, cache, retry, signal });
      if (!isCurrent(seq)) return;
      state.stack = result.stack;
      if (result.status === "error") {
        state.status = "error";
        state.errorMessage = result.errorMessage;
      } else if (result.status === "aborted") {
        state.status = "idle";
      } else {
        state.status = "ready";
      }
      emit();
    },
    async drillInto(
      provider: BoundaryProvider | null,
      regionId: string,
      retry = false,
      city = false,
      ownerSignal?: AbortSignal
    ) {
      if (!provider || disposed || ownerSignal?.aborted) return;
      state.lastDrillRegionId = regionId;
      state.lastDrillCity = city;
      // All paths, including cache hits, invalidate the previous request first.
      const { seq, signal } = beginRequest();
      // 取消只属于这一笔下钻；旧定位不能中断后来发起的普通导航。
      const cancel = () => {
        if (!isCurrent(seq)) return;
        requestSeq += 1;
        abort?.abort();
        state.lastDrillRegionId = null;
        state.status = state.stack.length ? "ready" : "idle";
        state.errorMessage = undefined;
        emit();
      };
      ownerSignal?.addEventListener("abort", cancel, { once: true });
      state.status = "loading";
      state.errorMessage = undefined;
      emit();
      try {
        const result = await loadProvinceIntoStack({
          provider,
          cache,
          currentStack: state.stack,
          regionId,
          retry,
          signal,
          city
        });
        if (!isCurrent(seq)) return;
        if (result.status === "error") {
          state.status = "error";
          state.errorMessage = result.errorMessage;
          emit();
          return;
        }
        if (result.status === "aborted") {
          state.status = "idle";
          emit();
          return;
        }
        state.stack = result.stack;
        state.availableProvinces = new Set(state.availableProvinces).add(regionId);
        state.status = "ready";
        emit();
      } finally {
        ownerSignal?.removeEventListener("abort", cancel);
      }
    },
    backToNational() {
      beginRequest();
      state.lastDrillRegionId = null;
      state.stack = popToNational(state.stack);
      state.status = state.stack.length > 0 ? "ready" : "idle";
      state.errorMessage = undefined;
      emit();
    },
    back() {
      beginRequest();
      state.lastDrillRegionId = null;
      state.stack = state.stack.length > 1 ? state.stack.slice(0, -1) : state.stack;
      state.status = state.stack.length ? "ready" : "idle";
      state.errorMessage = undefined;
      emit();
    },
    cacheKeys() {
      return [...cache.keys()];
    },
    cacheKeyFor
  };
}

/**
 * 订阅地图会话。provider 变化（含首次注入、换源）会自动加载全国；
 * 卸载或 provider 切换时中止在途请求，避免过期结果覆盖当前视图。
 */
export function useAtlasSession(provider: BoundaryProvider | null) {
  const [session] = useState(() => createAtlasSession());
  const [, forceRender] = useState(0);

  useEffect(() => {
    const unsubscribe = session.subscribe(() => forceRender((tick) => tick + 1));
    return () => {
      unsubscribe();
    };
  }, [session]);

  useEffect(() => {
    void session.loadNational(provider, false);
  }, [provider, session]);

  useEffect(() => {
    return () => session.dispose();
  }, [session]);

  const retry = useCallback((ownerSignal?: AbortSignal) => {
    const state = session.getState();
    const target = state.lastDrillRegionId;
    // 有下钻目标时重试该下钻（栈此时可能仍是全国，不能用栈顶判断）。
    if (target) {
      void session.drillInto(provider, target, true, state.lastDrillCity, ownerSignal);
      return;
    }
    void session.loadNational(provider, true);
  }, [provider, session]);

  return { session, state: session.getState(), retry };
}

export { isAbortError };
