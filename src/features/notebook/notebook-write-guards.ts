/**
 * 写入保护（人工保存与 AI 安全提交共用）。
 *
 * 职责：让两条写路径使用**同一套**校验，避免 AI 提交绕过人工保存已有的媒体与容量保护。
 * 这是提取，不是新框架：只有当前双方实际使用的两个校验函数及其直接依赖。
 *
 * 媒体可解析性依据**实际媒体存储记录**（且记录带有可用二进制载荷），
 * 不是只看 mediaId 或元数据是否存在。
 */
import { isBlobLike, type NotebookMedia, type NotebookPageBlock } from "./notebook-model";
import type { ArchiveCore } from "./notebook-repository";
import {
  formatCapacityViolation,
  listPhotoBlocks,
  measurePageCapacity,
  PAGE_CAPACITY_LIMITS
} from "./notebook-capacity";

/** 页面的图片块媒体 id（按块顺序）。 */
export function pagePhotoMediaIds(page: { blocks: readonly NotebookPageBlock[] }): string[] {
  return listPhotoBlocks(page as { blocks: NotebookPageBlock[] }).map((block) => block.mediaId);
}

/** 引用发生变化的页面：新增页只要带图片就算变化；已有页按图片引用序列比较。 */
export function changedPagesForMedia(current: ArchiveCore, next: ArchiveCore) {
  return next.pages.filter((page) => {
    const previous = current.pages.find((item) => item.id === page.id);
    if (!previous) return pagePhotoMediaIds(page).length > 0;
    return pagePhotoMediaIds(previous).join("\u0001") !== pagePhotoMediaIds(page).join("\u0001");
  });
}

/** 媒体记录是否带有可用二进制载荷（跨 realm 的 ArrayBuffer/Blob 都算）。 */
export function hasMediaPayload(record: unknown): boolean {
  if (!record || typeof record !== "object") return false;
  const candidate = record as { blob?: unknown; blobData?: unknown };
  const payload: unknown = candidate.blobData ?? candidate.blob;
  if (payload === undefined || payload === null) return false;
  if (isBlobLike(payload)) return payload.size > 0;
  const buffer = payload as { byteLength?: unknown };
  return typeof buffer.byteLength === "number" && buffer.byteLength > 0;
}

/**
 * 从**实际媒体存储记录**解析可用的媒体 id 集合。
 * 记录存在但没有二进制载荷（损坏/历史残留）一律不算可解析。
 */
export function resolvableMediaIds(records: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const id = (record as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0 && hasMediaPayload(record)) ids.add(id);
  }
  return ids;
}

/**
 * 写入边界校验：**本次提交中图片引用发生变化的页面**必须能解析到
 * 已存媒体、本次提交的媒体，或调用方声明允许保留的既有缺失引用。
 *
 * 只校验引用发生变化的页面：
 * - 仅移动归属（块未变）不会因其它页面既有的缺失媒体而被阻塞；
 * - 新增/修改的悬空引用一定被拒绝；
 * - `allowedMissingMediaIds` 只有在“确实来自该页原有数据”时才放行。
 *
 * 纯函数（同步）：可在 IndexedDB 事务内调用，不需要额外等待。
 */
/**
 * 目标页（`hardTargets`）：不做“历史缺失引用放行”，提交后的图片引用必须全部可解析。
 *
 * 为什么需要：AI 首期只替换文字、**保持图片引用不变**，因此这些页不会被
 * “引用序列变化”选中。但契约要求 AI 提交检查**实际目标页**的媒体可解析性，
 * 所以调用方要显式给出目标页 id，而不是依赖“变化页”推断。
 * 人工保存不传 `hardTargets`，保持“引用未变的既有缺失引用可继续保留”的原语义。
 */
function photoMediaIdsWithoutMissingPayload(
  page: { blocks: readonly NotebookPageBlock[] } | undefined
): string[] {
  return page === undefined ? [] : pagePhotoMediaIds(page);
}

export function assertChangedPagesMediaResolvableSync(input: {
  stored: ArchiveCore;
  next: ArchiveCore;
  pendingMedia: NotebookMedia[];
  /** 已存媒体中**真正可解析**的 id 集合（由实际存储记录得出）。 */
  storedResolvableIds: ReadonlySet<string>;
  allowedMissingMediaIds: string[];
  /** 必须整体可解析的目标页 id（AI 提交的冻结目标）；不传则只校验变化页。 */
  hardTargets?: readonly string[];
}): { checkedPageIds: string[] } {
  const changed = changedPagesForMedia(input.stored, input.next);
  const known = new Set([...input.storedResolvableIds, ...input.pendingMedia.map((item) => item.id)]);

  const hardTargetIds = new Set(input.hardTargets ?? []);
  const hardTargetMediaIds = [...hardTargetIds].flatMap((pageId) =>
    photoMediaIdsWithoutMissingPayload(input.next.pages.find((page) => page.id === pageId))
  );
  const hardDangling = hardTargetMediaIds.filter((mediaId) => !known.has(mediaId));

  // 放行依据必须来自该页面**原有数据**：原先就解析不到、且引用未变的媒体 id 才允许保留。
  const historicalMissing = new Set(
    changed.flatMap((page) => {
      const previous = input.stored.pages.find((item) => item.id === page.id);
      return previous ? pagePhotoMediaIds(previous) : [];
    })
  );
  const callerAllowed = new Set(input.allowedMissingMediaIds);
  const dangling = changed
    .filter((page) => !hardTargetIds.has(page.id))
    .flatMap((page) => pagePhotoMediaIds(page))
    .filter(
      (mediaId) =>
        !known.has(mediaId) && !(historicalMissing.has(mediaId) && callerAllowed.has(mediaId))
    );

  const allDangling = [...new Set([...hardDangling, ...dangling])];
  if (allDangling.length > 0) {
    throw new Error(
      `有 ${allDangling.length} 张图片引用无法解析，未保存；请修正或移除后再保存（${allDangling[0]}）。`
    );
  }
  return {
    checkedPageIds: [...new Set([...hardTargetIds, ...changed.map((page) => page.id)])]
  };
}

/**
 * 提交前容量校验（014-A）：按“提交后的最终引用集”计算。
 * 只校验本次引用发生变化、且引用数达到上限量级的页面，避免历史缺图误报；
 * 超限整次拒绝并保留草稿，不裁剪、不自动拆篇。
 *
 * 纯函数（同步）：可在 IndexedDB 事务内调用。
 */
export function assertCapacityForChange(
  current: ArchiveCore,
  next: ArchiveCore,
  pendingMedia: NotebookMedia[],
  assetSizes: Map<string, number>
): void {
  const sizes = new Map(assetSizes);
  pendingMedia.forEach((item) => sizes.set(item.id, item.size));
  const changed = next.pages.filter((page) => {
    const previous = current.pages.find((item) => item.id === page.id);
    if (!previous) return true;
    return (
      listPhotoBlocks(previous).length !== listPhotoBlocks(page).length ||
      previous.blocks !== page.blocks
    );
  });
  for (const page of changed) {
    const measurement = measurePageCapacity({
      page,
      assetSizes: Object.fromEntries(sizes),
      limits: PAGE_CAPACITY_LIMITS
    });
    if (measurement.violations.length > 0) {
      throw new Error(formatCapacityViolation(measurement.violations[0]));
    }
  }
}
