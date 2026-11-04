import { MAX_PHOTO_BATCH_SIZE, type NotebookPage, type NotebookPageBlock, type TripJournalMeta } from "./notebook-model";

/**
 * 容量契约（单次张数按 2026-10-09 用户要求调整）：
 * - 一次选择/导入批次最多 50 张图片；
 * - 一篇最多 100 个 photo 块（按出现次数计，同一资产插两次算两张）；
 * - 单张原图最多 50,000,000 字节；
 * - 一篇最大 500,000,000 字节（十进制）。
 *
 * 计量口径：正文与篇元数据按 UTF-8 字节 + 本篇引用的独立媒体资产实际字节
 * （含已持久化的缩略图等衍生资源），同一 assetId 篇内只计一次字节；
 * 不计外链远端未知大小、未引用孤儿媒体或记录箱副本。
 * 恰好等于上限允许；超过 1 字节即拒绝，不静默裁剪、不自动拆篇。
 */
export type PageCapacityLimits = {
  /** 单个批次（一次文件选择/导入）的张数上限。 */
  batchPhotos: number;
  /** 单篇 photo 块出现次数上限。 */
  photoBlocks: number;
  /** 单张原图字节上限。 */
  mediaBytes: number;
  /** 单篇总量字节上限。 */
  totalBytes: number;
};

export const PAGE_CAPACITY_LIMITS: PageCapacityLimits = {
  batchPhotos: MAX_PHOTO_BATCH_SIZE,
  photoBlocks: 100,
  mediaBytes: 50_000_000,
  totalBytes: 500_000_000
};

export type PageCapacityViolation =
  | { kind: "batch-photos"; limit: number; actual: number }
  | { kind: "photo-blocks"; limit: number; actual: number }
  | { kind: "single-media"; limit: number; mediaId: string; name: string; actual: number }
  | { kind: "page-total"; limit: number; actual: number };

export type PageCapacityMeasurement = {
  /** photo 块出现次数（同一资产插两次算两张）。 */
  photoBlockCount: number;
  /** 去重后的资产数，仅用于显示，不作为配额。 */
  uniqueAssetCount: number;
  /** 去重后的资产字节（不含衍生资源）。 */
  assetBytes: number;
  /** 正文与篇元数据的 UTF-8 字节。 */
  textBytes: number;
  /** 已计入的持久化衍生资源字节（如缩略图），属于本资产占用。 */
  derivedBytes: number;
  /** 计入配额的总量 = textBytes + assetBytes + derivedBytes。 */
  totalBytes: number;
  /** 引用了但既不在 assetSizes 也没有尺寸的资产（提交前必须解决）。 */
  unresolvedMediaIds: string[];
  /** 超限项；恰好等于上限不算违规。 */
  violations: PageCapacityViolation[];
};

export type PageCapacityInput = {
  page: Pick<NotebookPage, "title" | "blocks" | "source" | "capturedAt">;
  meta?: TripJournalMeta | null;
  /** 资产 ID → 原图实际字节。 */
  assetSizes: Record<string, number>;
  /**
   * 已持久化的衍生资源字节（例如缩略图），按资产 ID 关联。
   * 这些字节属于该资产的实际占用，**计入**配额而不是从配额里减掉。
   */
  derivedSizes?: Record<string, number>;
  limits?: PageCapacityLimits;
};

export type PageAsset = { assetId: string; name: string; size: number };

const encoder = new TextEncoder();

/** UTF-8 字节数：用于正文与元数据计量，不按字符数估算。 */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

export function listPhotoBlocks(page: {
  blocks: NotebookPageBlock[];
}): Extract<NotebookPageBlock, { type: "photo" }>[] {
  return page.blocks.filter(
    (block): block is Extract<NotebookPageBlock, { type: "photo" }> => block.type === "photo"
  );
}

/** 篇元数据的测量文本：地区目录版本与名称等元数据计入配额，不塞进 Markdown 正文。 */
function tripJournalMetaText(meta: TripJournalMeta | null | undefined): string {
  if (!meta) return "";
  const regions = meta.regions
    .map(
      (region) =>
        `${region.regionId}\u0001${region.parentRegionId ?? ""}\u0001${region.level}\u0001${region.name}\u0001${region.catalogVersion}`
    )
    .join("\u0002");
  return `${meta.tripDate ?? ""}\u0003${regions}`;
}

/**
 * 按“提交后的最终引用集”测量一篇的容量。
 *
 * 重复引用同一资产：张数按出现次数计，字节按 assetId 去重计一次。
 * 删除/替换只会缩小引用集，因此同一函数也用于“替换后是否合格”的判断。
 */
export function measurePageCapacity(input: PageCapacityInput): PageCapacityMeasurement {
  const limits = input.limits ?? PAGE_CAPACITY_LIMITS;
  const photos = listPhotoBlocks(input.page);
  const uniqueIds: string[] = [];
  const seen = new Set<string>();
  for (const block of photos) {
    if (!seen.has(block.mediaId)) {
      seen.add(block.mediaId);
      uniqueIds.push(block.mediaId);
    }
  }

  let assetBytes = 0;
  let derivedBytes = 0;
  const unresolvedMediaIds: string[] = [];
  for (const assetId of uniqueIds) {
    const raw = input.assetSizes[assetId];
    const size = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
    const derivedRaw = input.derivedSizes?.[assetId];
    if (size === undefined) {
      unresolvedMediaIds.push(assetId);
      continue;
    }
    assetBytes += size;
    if (typeof derivedRaw === "number" && Number.isFinite(derivedRaw) && derivedRaw >= 0) {
      derivedBytes += derivedRaw;
    }
  }

  const textBytes =
    utf8Bytes(input.page.title) +
    utf8Bytes(input.page.source.kind) +
    utf8Bytes(input.page.capturedAt) +
    input.page.blocks.reduce((total, block) => {
      if (block.type === "text") return total + utf8Bytes(block.text);
      if (block.type === "unsupported-image") return total + utf8Bytes(block.markdown);
      return total + utf8Bytes(block.caption) + utf8Bytes(block.mediaId);
    }, 0) +
    utf8Bytes(tripJournalMetaText(input.meta));

  const totalBytes = textBytes + assetBytes + derivedBytes;
  const violations: PageCapacityViolation[] = [];
  if (photos.length > limits.photoBlocks) {
    violations.push({ kind: "photo-blocks", limit: limits.photoBlocks, actual: photos.length });
  }
  if (totalBytes > limits.totalBytes) {
    violations.push({ kind: "page-total", limit: limits.totalBytes, actual: totalBytes });
  }

  return {
    photoBlockCount: photos.length,
    uniqueAssetCount: uniqueIds.length,
    assetBytes,
    textBytes,
    derivedBytes,
    totalBytes,
    unresolvedMediaIds,
    violations
  };
}

/** 单张原图检查：超过上限即拒绝该文件，不做静默压缩或转换。 */
export function checkSingleAssetSize(
  asset: { assetId: string; name: string; size: number },
  limits: PageCapacityLimits = PAGE_CAPACITY_LIMITS
): PageCapacityViolation | undefined {
  if (asset.size > limits.mediaBytes) {
    return {
      kind: "single-media",
      limit: limits.mediaBytes,
      mediaId: asset.assetId,
      name: asset.name,
      actual: asset.size
    };
  }
  return undefined;
}

/**
 * 批次检查：一次文件选择/导入的数量上限，超限时整批拒绝。
 * 不静默截取，因此只返回是否放行，不返回截断结果。
 */
export function checkBatchSize(
  batchSize: number,
  limits: PageCapacityLimits = PAGE_CAPACITY_LIMITS
): PageCapacityViolation | undefined {
  if (batchSize > limits.batchPhotos) {
    return { kind: "batch-photos", limit: limits.batchPhotos, actual: batchSize };
  }
  return undefined;
}

export function formatCapacityViolation(violation: PageCapacityViolation): string {
  switch (violation.kind) {
    case "batch-photos":
      return `添加失败：本次选择${violation.actual}张，单次上限${violation.limit}张！`;
    case "photo-blocks":
      return `一篇最多 ${violation.limit} 张图片，当前已有 ${violation.actual} 张，超出部分未保存。`;
    case "single-media":
      return `图片「${violation.name}」为 ${formatBytes(violation.actual)}，超过单张上限 ${formatBytes(violation.limit)}，未添加。`;
    case "page-total":
      return `本篇容量 ${formatBytes(violation.actual)} / ${formatBytes(violation.limit)}，已超过上限，本次未保存。`;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

/** 界面文案：图片 x/100、容量 y/500 MB。 */
export function formatCapacityCounters(measurement: PageCapacityMeasurement): string {
  return `图片 ${measurement.photoBlockCount}/${PAGE_CAPACITY_LIMITS.photoBlocks}、容量 ${formatBytes(
    measurement.totalBytes
  )}/${formatBytes(PAGE_CAPACITY_LIMITS.totalBytes)}`;
}
