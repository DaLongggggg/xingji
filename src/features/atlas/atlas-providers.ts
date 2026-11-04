import {
  BoundaryError,
  createRegionId,
  isAbortError,
  type BoundaryDataset,
  type BoundaryLoadOptions,
  type BoundaryProvider
} from "./boundary-contract";
import { normalizeBoundaryJson } from "./boundary-validation";

/** 简易内容指纹（仅用于缓存键区分来源版本，不用于安全用途）。 */
export function fingerprintText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function throwIfAborted(options?: BoundaryLoadOptions): void {
  if (options?.signal?.aborted) {
    throw new BoundaryError("ABORTED", "请求已取消。");
  }
}

export type LocalBoundaryInput = {
  /** 全国边界 JSON 文本（可为空：尚未选择）。 */
  national?: string;
  /** 省级边界 JSON 文本，按来源省 ID（如 "44"）索引。 */
  provinces?: Record<string, string>;
};

/**
 * 内存 Provider：由调用方注入**已经校验过的本地 JSON 文本**。
 * 不发起任何网络请求，因此不依赖第三方热链；未来可替换为获批的静态文件 Provider。
 */
export function createLocalJsonBoundaryProvider(input: LocalBoundaryInput): BoundaryProvider {
  const nationalText = input.national?.trim() ? input.national : undefined;
  const provinceTexts = input.provinces ?? {};
  const sourceId = "local-json";
  const sourceVersion =
    fingerprintText(nationalText ?? "") +
    ":" +
    fingerprintText(
      Object.entries(provinceTexts)
        .sort()
        .map(([k, v]) => `${k}=${fingerprintText(v)}`)
        .join("|")
    );

  function nationalDataset(): BoundaryDataset {
    if (!nationalText) throw new BoundaryError("NO_DATA", "尚未选择全国边界文件。");
    return normalizeBoundaryJson(nationalText, { sourceId, sourceVersion, level: "national" });
  }

  return {
    sourceId,
    sourceVersion,
    async loadNational(options) {
      throwIfAborted(options);
      return nationalDataset();
    },
    async loadProvince(regionId, options) {
      throwIfAborted(options);
      const national = nationalDataset();
      const province = national.regions.find((region) => region.regionId === regionId);
      if (!province) throw new BoundaryError("UNKNOWN_REGION", `未知地区：${regionId}。`);
      const text = provinceTexts[province.sourceRegionId];
      if (!text || !text.trim()) {
        throw new BoundaryError(
          "NO_DATA",
          `尚未提供 ${province.name} 的城市地图数据。`
        );
      }
      // 子级数据存在且校验通过，才把该省标记为可下钻。
      return normalizeBoundaryJson(text, {
        sourceId,
        sourceVersion,
        level: "province",
        parentRegionId: province.regionId,
        parentSourceRegionId: province.sourceRegionId
      });
    }
  };
}

/** 测试/自有 fixture 用：直接给出已构造的数据集。 */
export function createMemoryBoundaryProvider(config: {
  sourceId?: string;
  sourceVersion?: string;
  national?: BoundaryDataset;
  provinces?: Record<string, BoundaryDataset>;
}): BoundaryProvider {
  const sourceId = config.sourceId ?? "memory";
  const sourceVersion = config.sourceVersion ?? "1";
  return {
    sourceId,
    sourceVersion,
    async loadNational(options) {
      throwIfAborted(options);
      if (!config.national) throw new BoundaryError("NO_DATA", "没有全国数据。");
      return config.national;
    },
    async loadProvince(regionId, options) {
      throwIfAborted(options);
      const dataset = config.provinces?.[regionId];
      if (!dataset) throw new BoundaryError("NO_DATA", `没有 ${regionId} 的城市数据。`);
      return dataset;
    }
  };
}

/**
 * 开发态验证入口：用文件选择读取 JSON 文本。
 * 只做文本读取与 JSON.parse（由校验层完成），**不执行文件内容**，也不写入任何存储。
 */
export function createFileBackedBoundaryInput(): {
  getProvider: () => BoundaryProvider | null;
  setNationalFile: (text: string | null) => void;
  setProvinceFile: (sourceRegionId: string, text: string | null) => void;
} {
  let national: string | undefined;
  let provinces: Record<string, string> = {};
  let cached: { provider: BoundaryProvider; version: string } | null = null;

  function current(): BoundaryProvider | null {
    if (!national) return null;
    const version =
      fingerprintText(national) +
      ":" +
      fingerprintText(
        Object.entries(provinces)
          .sort()
          .map(([k, v]) => `${k}=${fingerprintText(v)}`)
          .join("|")
      );
    // 换数据源必须重建 provider（进而清除缓存键）。
    if (!cached || cached.version !== version) {
      cached = {
        provider: createLocalJsonBoundaryProvider({ national, provinces }),
        version
      };
    }
    return cached.provider;
  }

  return {
    getProvider: () => current(),
    setNationalFile(text) {
      national = text ?? undefined;
      cached = null;
    },
    setProvinceFile(sourceRegionId, text) {
      if (text && text.trim()) {
        provinces = { ...provinces, [sourceRegionId]: text };
      } else {
        const next = { ...provinces };
        delete next[sourceRegionId];
        provinces = next;
      }
      cached = null;
    }
  };
}

export { isAbortError, createRegionId };
